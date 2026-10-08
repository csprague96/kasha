import { closeSync, openSync, readSync } from 'node:fs'
import type { TranscriptSegment } from '@shared/types'
import { SAMPLE_RATE, type Track } from './recorder'
import { addSpeech, BATCH_THREADS, detectSpeech, takeChunk, transcribeChunk, type Chunk, type Span } from './speech'

const SILENCE_RMS = 120 // int16 RMS; below this a segment is near-silent
const SILENCE_HALLUCINATIONS = /^\s*(thank you\.?|thanks for watching[.!]?|you\.?|bye\.?)\s*$/i

export const speakerOf = (track: Track) => (track === 'mic' ? 'you' : 'others')

/** RMS of the int16 samples between two times, read straight from the WAV. */
function segmentRms(fd: number, start: number, end: number): number {
  const from = 44 + Math.floor(start * SAMPLE_RATE) * 2
  const len = Math.min(Math.max(0, Math.floor((end - start) * SAMPLE_RATE) * 2), SAMPLE_RATE * 2 * 30)
  if (len === 0) return 0
  const buf = Buffer.alloc(len)
  const n = readSync(fd, buf, 0, len, from)
  let sum = 0
  const count = Math.floor(n / 2)
  for (let i = 0; i < count; i++) {
    const v = buf.readInt16LE(i * 2)
    sum += v * v
  }
  return count ? Math.sqrt(sum / count) : 0
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w.length > 2))
}

function similarity(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / Math.min(A.size, B.size)
}

/**
 * When someone uses speakers instead of a headset, the mic also picks up the
 * other side. Drop "You" lines that duplicate a simultaneous "Others" line.
 */
function removeEcho(segs: TranscriptSegment[]): TranscriptSegment[] {
  const others = segs.filter((s) => s.speaker !== 'you')
  return segs.filter(
    (s) =>
      s.speaker !== 'you' ||
      !others.some((o) => o.start < s.end + 1.5 && o.end > s.start - 1.5 && similarity(o.text, s.text) >= 0.6)
  )
}

/** Drops lines Whisper invented over near-silence, removes echo, and sorts by time. */
export function finalize(tracks: Array<{ track: Track; file: string }>, segs: TranscriptSegment[]): TranscriptSegment[] {
  const kept: TranscriptSegment[] = []
  for (const { track, file } of tracks) {
    const fd = openSync(file, 'r')
    try {
      for (const s of segs.filter((x) => x.speaker === speakerOf(track))) {
        const rms = segmentRms(fd, s.start, s.end)
        if (rms < SILENCE_RMS && (SILENCE_HALLUCINATIONS.test(s.text) || rms < SILENCE_RMS / 3)) continue
        kept.push(s)
      }
    } finally {
      closeSync(fd)
    }
  }
  return removeEcho(kept.sort((a, b) => a.start - b.start))
}

/** Transcribes finished recordings in one go: used after a call when live transcription was off, and on Retry. */
export async function transcribe(
  tracks: Array<{ track: Track; file: string }>,
  prompt: string,
  onProgress: (p: number) => void,
  threads = BATCH_THREADS
): Promise<TranscriptSegment[]> {
  const jobs: Array<{ track: Track; file: string; chunk: Chunk }> = []
  for (const t of tracks) {
    const queue: Span[] = []
    addSpeech(queue, await detectSpeech(t.file))
    for (let c = takeChunk(queue, true); c; c = takeChunk(queue, true)) jobs.push({ ...t, chunk: c })
  }
  const segs: TranscriptSegment[] = []
  // Tracks run one chunk at a time rather than in parallel to cap CPU and memory.
  for (let i = 0; i < jobs.length; i++) {
    const { track, file, chunk } = jobs[i]
    const tmp = file.replace(/\.wav$/, `-chunk${i}`)
    segs.push(...(await transcribeChunk(file, chunk, speakerOf(track), { prompt, threads }, tmp)))
    onProgress((i + 1) / jobs.length)
  }
  return finalize(tracks, segs)
}
