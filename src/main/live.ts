import { freemem } from 'node:os'
import { join } from 'node:path'
import type { LiveState, TranscriptSegment } from '@shared/types'
import { SAMPLE_RATE, type Track } from './recorder'
import { addSpeech, detectSpeech, LIVE_THREADS, takeChunk, transcribeChunk, type Span } from './speech'
import { speakerOf } from './transcriber'

const TICK_MS = 10_000
const MIN_NEW = 6 // seconds of new audio before looking for speech again
const SETTLE = 1.0 // speech this close to the live edge may still be going
const MAX_OPEN = 25 // a run of speech still going after this long is cut anyway
const MAX_WAIT = 90_000 // ms; speech waits at most this long for a chunk to fill
// The speech model peaks at ~550 MB. Below LOW free memory, chunks wait; they
// start again above HIGH, so it doesn't flap on and off.
const LOW_MEMORY = 1.5 * 1024 ** 3
const HIGH_MEMORY = 2 * 1024 ** 3

interface TrackState {
  file: string
  seconds: number // recorded so far
  checked: number // speech before this point has been found
  queue: Span[] // speech waiting to be transcribed
  waitingSince: number | null
}

/**
 * Transcribes a recording while it happens. Every few seconds it finds the
 * speech recorded since last time, and once about 20 seconds of it has built
 * up, transcribes that chunk at low priority. The work is spread over the
 * call, so the transcript is ready when it ends.
 */
export class LiveTranscriber {
  private tracks: Partial<Record<Track, TrackState>> = {}
  private segments: TranscriptSegment[] = []
  private chunks = 0
  private finished = 0
  private work: Promise<void> = Promise.resolve()
  private checking: Promise<void> | null = null
  private failed: Error | null = null
  private timer: NodeJS.Timeout
  private onProgress: ((p: number) => void) | null = null
  private userPaused = false
  private lowMemory = false
  private finishing = false
  private resumed: (() => void) | null = null

  constructor(
    private dir: string,
    private prompt: string,
    private onSegments: (segs: TranscriptSegment[]) => void,
    private watchMemory: () => boolean,
    private onState: (s: LiveState) => void
  ) {
    this.timer = setInterval(() => {
      this.checkMemory()
      void this.check(false)
    }, TICK_MS)
  }

  state(): LiveState {
    return { available: true, paused: this.userPaused ? 'user' : this.lowMemory ? 'memory' : null }
  }

  /**
   * Pausing stops new transcription work; the recording carries on. A chunk
   * already running is allowed to finish (a few seconds). Everything held back
   * is transcribed on resume, or when the call ends.
   */
  setPaused(paused: boolean): void {
    if (this.userPaused === paused) return
    this.userPaused = paused
    this.changed()
  }

  private paused(): boolean {
    return !this.finishing && (this.userPaused || this.lowMemory)
  }

  private checkMemory(): void {
    const free = freemem()
    const low = this.watchMemory() && (this.lowMemory ? free < HIGH_MEMORY : free < LOW_MEMORY)
    if (low === this.lowMemory) return
    this.lowMemory = low
    this.changed()
  }

  private changed(): void {
    this.onState(this.state())
    if (!this.paused()) {
      this.resumed?.()
      this.resumed = null
    }
  }

  /** Resolves once transcription isn't paused. */
  private whenRunning(): Promise<void> {
    if (!this.paused()) return Promise.resolve()
    return new Promise((resolve) => {
      const prev = this.resumed
      this.resumed = () => {
        prev?.()
        resolve()
      }
    })
  }

  /** Called for every block of audio the recorder writes. */
  wrote(track: Track, bytes: number): void {
    const t = (this.tracks[track] ??= { file: join(this.dir, `${track}.wav`), seconds: 0, checked: 0, queue: [], waitingSince: null })
    t.seconds += bytes / 2 / SAMPLE_RATE
  }

  /** Lines transcribed so far, in time order. */
  current(): TranscriptSegment[] {
    return [...this.segments].sort((a, b) => a.start - b.start)
  }

  /**
   * Transcribes what's left after the recording stops and waits for it. Returns
   * null if anything failed, so the caller can transcribe the files from scratch.
   */
  async finish(onProgress: (p: number) => void): Promise<TranscriptSegment[] | null> {
    clearInterval(this.timer)
    // After the call, held-back work runs regardless.
    this.finishing = true
    this.changed()
    this.onProgress = onProgress
    await this.checking
    await this.check(true)
    onProgress(this.chunks ? this.finished / this.chunks : 0)
    await this.work
    return this.failed ? null : this.current()
  }

  stop(): void {
    clearInterval(this.timer)
    this.failed ??= new Error('Stopped')
    this.finishing = true
    this.changed()
  }

  private check(final: boolean): Promise<void> {
    if (this.checking || this.failed) return this.checking ?? Promise.resolve()
    if (!final && this.paused()) return Promise.resolve()
    this.checking = this.findSpeech(final)
      .catch((e) => void (this.failed = e as Error))
      .finally(() => (this.checking = null))
    return this.checking
  }

  private async findSpeech(final: boolean): Promise<void> {
    for (const track of ['sys', 'mic'] as Track[]) {
      const t = this.tracks[track]
      if (!t) continue
      const end = t.seconds
      if (end - t.checked >= (final ? 0.3 : MIN_NEW)) {
        const regions = await detectSpeech(t.file, { start: t.checked, end, tmp: join(this.dir, `vad-${track}.wav`) })
        const edge = final ? end : end - SETTLE
        const open = regions.find((r) => r.end > edge)
        if (open && edge - open.start < MAX_OPEN) {
          // Still talking: look at this stretch again next time, from where it began.
          const done = regions.filter((r) => r.end <= edge)
          addSpeech(t.queue, done)
          t.checked = Math.max(t.checked, done.length ? done[done.length - 1].end : 0, open.start - 0.2)
        } else {
          addSpeech(t.queue, regions.map((r) => ({ start: r.start, end: Math.min(r.end, edge) })).filter((r) => r.end > r.start))
          t.checked = edge
        }
      }
      if (t.queue.length) t.waitingSince ??= Date.now()
      const force = final || (t.waitingSince !== null && Date.now() - t.waitingSince > MAX_WAIT)
      let took = false
      for (let c = takeChunk(t.queue, force); c; c = takeChunk(t.queue, force)) {
        took = true
        const n = this.chunks++
        const chunk = c
        this.work = this.work.then(async () => {
          await this.whenRunning()
          if (this.failed) return
          try {
            const segs = await transcribeChunk(t.file, chunk, speakerOf(track), { prompt: this.prompt, threads: LIVE_THREADS }, join(this.dir, `live-${n}`))
            this.segments.push(...segs)
            if (segs.length) this.onSegments(segs)
          } catch (e) {
            this.failed = e as Error
          } finally {
            this.finished++
            this.onProgress?.(this.finished / this.chunks)
          }
        })
      }
      // Whatever is left over starts its own wait.
      t.waitingSince = !t.queue.length ? null : took ? Date.now() : t.waitingSince
    }
  }
}

const sessions = new Map<string, LiveTranscriber>()

export function startLive(
  meetingId: string,
  dir: string,
  prompt: string,
  onSegments: (segs: TranscriptSegment[]) => void,
  watchMemory: () => boolean,
  onState: (s: LiveState) => void
): LiveTranscriber {
  const live = new LiveTranscriber(dir, prompt, onSegments, watchMemory, onState)
  sessions.set(meetingId, live)
  return live
}

export const getLive = (meetingId: string) => sessions.get(meetingId)

/** Hands the session to the pipeline, which finishes it. */
export function takeLive(meetingId: string): LiveTranscriber | undefined {
  const live = sessions.get(meetingId)
  sessions.delete(meetingId)
  return live
}
