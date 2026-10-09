import { utilityProcess } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { basename, join } from 'node:path'
import type { Meeting, SpeakerId, TranscriptSegment } from '@shared/types'
import { speakerPaths } from './setup'
import type { SpeakerCluster, SpeakerRequest, SpeakerResponse } from './speakers-worker'
import { background } from './background'
import { log } from './log'
import { BATCH_THREADS } from './speech'
import * as store from './store'
import * as voices from './voices'

/**
 * Tells the people on the computer's audio apart and, when a voice is known
 * from a past meeting, names them. Everything runs on this PC.
 */

/** At least this long, and longer for calls with a lot of talking (see runWorker). */
const TIMEOUT_MS = 30 * 60_000
/** Voices with less speech than this aren't reliable enough to name or learn. */
const MIN_SECONDS = 8

const embeddingsFile = (meetingId: string) => join(store.paths.meeting(meetingId), 'speakers.json')

/** A meeting's voiceprints (speakers.json), kept so naming a speaker can teach Kasha the voice. */
export interface SpeakerPrints {
  model: string
  voices: Partial<Record<SpeakerId, { v: number[]; capped?: boolean }>>
}

export function readEmbeddings(meetingId: string): SpeakerPrints {
  try {
    const raw = JSON.parse(readFileSync(embeddingsFile(meetingId), 'utf8')) as SpeakerPrints | Partial<Record<SpeakerId, number[]>>
    if (raw && typeof raw === 'object' && 'voices' in raw && typeof raw.model === 'string') return raw as SpeakerPrints
    // Before 0.2.3: { id: vector }, with no model recorded. The length tells CAM++ (512) from ERes2Net (192).
    const out: SpeakerPrints = { model: 'unknown', voices: {} }
    for (const [id, v] of Object.entries(raw as Record<string, number[]>)) {
      if (!Array.isArray(v)) continue
      out.voices[id as SpeakerId] = { v }
      if (out.model === 'unknown') out.model = v.length === 192 ? voiceModel() : 'old'
    }
    return out
  } catch {
    return { model: 'unknown', voices: {} }
  }
}

/** Thrown when separation was stopped by a pause: it starts again on resume. */
export class Stopped extends Error {
  constructor() {
    super('Stopped for a pause.')
  }
}

function runWorker(req: SpeakerRequest, signal?: AbortSignal): Promise<SpeakerResponse> {
  // About a second of work per second of speech on the slowest PCs seen, so a
  // long, talk-heavy call isn't cut off and left as one "Others".
  const speech = req.spans.reduce((t, s) => t + s.end - s.start, 0)
  const limit = Math.max(TIMEOUT_MS, speech * 1000 * (6 / Math.max(1, req.threads)))
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped())
    const child = utilityProcess.fork(join(__dirname, 'speakers-worker.js'), [], { serviceName: 'Kasha speakers', stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Telling speakers apart took too long.'))
    }, limit)
    // A call that starts meanwhile gets the CPU first: this drops to the lowest priority, and back after.
    const prioritize = () => {
      try {
        if (child.pid) setPriority(child.pid, background.lowest() ? constants.priority.PRIORITY_LOW : constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        /* not fatal */
      }
    }
    const offChange = background.onChange(prioritize)
    const onAbort = () => {
      child.kill()
      finish(() => reject(new Stopped()))
    }
    signal?.addEventListener('abort', onAbort)
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      offChange()
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    child.once('spawn', () => {
      prioritize()
      child.postMessage(req)
    })
    child.on('message', (res: SpeakerResponse) => finish(() => (res.error ? reject(new Error(res.error)) : resolve(res))))
    child.on('exit', (code) => finish(() => reject(new Error(`Speaker worker exited (${code}).`))))
  })
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * Gives each "Others" line to the cluster it overlaps most. Lines with no
 * overlap follow their neighbours. `clusterOf` says which cluster each
 * speaker id came from, for keeping the right voiceprint.
 */
export function assignLines(
  transcript: TranscriptSegment[],
  clusters: SpeakerCluster[]
): { transcript: TranscriptSegment[]; ids: SpeakerId[]; clusterOf: Map<SpeakerId, number> } {
  if (clusters.length < 2) {
    return { transcript, ids: clusters.length ? ['others'] : [], clusterOf: new Map(clusters.length ? [['others', 0]] : []) }
  }
  const idOf = new Map<number, SpeakerId>()
  const ids: SpeakerId[] = []
  let last: number | null = null
  let prev: TranscriptSegment | null = null
  const out = transcript.map((seg) => {
    if (seg.speaker !== 'others') {
      // A reply from the note taker in between: what follows isn't a continuation.
      if (seg.speaker === 'you') prev = null
      return seg
    }
    // The rest of an unfinished sentence ("…you know" / "in a moment.") stays
    // with whoever started it. These pieces are often too short to tell a
    // voice by, so overlap alone can hand them to someone else.
    const continues =
      prev !== null && last !== null && seg.start - prev.end < 3 && /^[a-z]/.test(seg.text.trim()) && !/[.?!…]["')\]]*$/.test(prev.text.trim())
    prev = seg
    let k = -1
    let best = 0
    clusters.forEach((c, i) => {
      const o = c.segments.reduce((t, s) => t + overlap(seg, s), 0)
      if (o > best) {
        best = o
        k = i
      }
    })
    if (k < 0) {
      // No overlap: the nearest stretch within 2 s, else whoever spoke last.
      let gap = 2
      clusters.forEach((c, i) => {
        for (const s of c.segments) {
          const d = s.end < seg.start ? seg.start - s.end : s.start > seg.end ? s.start - seg.end : 0
          if (d < gap) {
            gap = d
            k = i
          }
        }
      })
      if (k < 0) k = last ?? clusters.reduce((m, c, i, arr) => (c.seconds > arr[m].seconds ? i : m), 0)
    }
    if (continues) k = last!
    last = k
    let id = idOf.get(k)
    if (!id) {
      id = `s${ids.length + 1}`
      idOf.set(k, id)
      ids.push(id)
    }
    return { ...seg, speaker: id }
  })
  return { transcript: out, ids, clusterOf: new Map([...idOf].map(([k, id]) => [id, k])) }
}

export interface SeparateResult {
  transcript: TranscriptSegment[]
  /** Voices that sound like someone named in a past meeting: offered as guesses, by speaker id. */
  matches: Partial<Record<SpeakerId, { name: string; score: number }>>
  /** Voices joined only to fit the Teams head count (they may be two people). */
  capped: SpeakerId[]
}

/** The voiceprint model in use, recorded with every voiceprint so prints from different models are never compared. */
export const voiceModel = () => basename(speakerPaths.embedding()).replace(/\.onnx$/i, '')

/**
 * Splits "Others" into s1, s2… using the system-audio track and finds voices
 * heard in past meetings. With recognition on, each voice's voiceprint is
 * kept beside the transcript (speakers.json), so naming a speaker later can
 * teach Kasha the voice; with it off, nothing is kept.
 *
 * `expected` (from the invite) makes grouping finer when too few voices come
 * out; `max` (people seen in the Teams call) joins extra voices that sound
 * alike. `candidates` limits recognition to the people in the call or invited.
 */
export async function separateSpeakers(
  meetingId: string,
  sysWav: string,
  transcript: TranscriptSegment[],
  opts: { expected?: number; max?: number; candidates?: string[]; threads?: number; signal?: AbortSignal } = {}
): Promise<SeparateResult> {
  const spans = transcript.filter((s) => s.speaker === 'others').map((s) => ({ start: s.start, end: s.end }))
  if (!spans.length) return { transcript, matches: {}, capped: [] }
  const threads = opts.threads ?? BATCH_THREADS
  const res = await runWorker({
    wav: sysWav,
    spans,
    segmentationModel: speakerPaths.segmentation(),
    embeddingModel: speakerPaths.embedding(),
    threads,
    expected: opts.expected,
    max: opts.max
  }, opts.signal)
  const clusters = res.clusters ?? []
  // Numbers only: where the time went, to keep separation cheap.
  if (res.timings) log('speakers-timings', { threads, ...Object.fromEntries(Object.entries(res.timings).map(([k, v]) => [k, Math.round(v)])) })
  const assigned = assignLines(transcript, clusters)
  const seconds = (id: SpeakerId) => assigned.transcript.filter((s) => s.speaker === id).reduce((t, s) => t + s.end - s.start, 0)
  const prints: SpeakerPrints['voices'] = {}
  const capped: SpeakerId[] = []
  for (const [id, k] of assigned.clusterOf) {
    const c = clusters[k]
    if (!c) continue
    if (c.capped) capped.push(id)
    // Too little speech to tell a voice by, to name or to learn.
    if (seconds(id) >= MIN_SECONDS) prints[id] = { v: c.embedding, ...(c.capped ? { capped: true } : {}) }
  }

  const settings = store.getSettings()
  if (!settings.speakers.recognize) return { transcript: assigned.transcript, matches: {}, capped }
  const model = voiceModel()
  writeFileSync(embeddingsFile(meetingId), JSON.stringify({ model, voices: prints } satisfies SpeakerPrints))
  // A mixed voice (capped) could match either person, so it's never matched.
  const usable = Object.fromEntries(Object.entries(prints).filter(([, p]) => p && !p.capped).map(([id, p]) => [id, p!.v]))
  const matches = voices.matchAll(usable, model, opts.candidates)
  return { transcript: assigned.transcript, matches, capped }
}

/**
 * After the user names, renames or confirms speakers: learn the voices given
 * a name, and forget what a removed or changed name taught. Voices joined
 * only to fit the head count, and voiceprints from another model, are never
 * learned. Forgetting works even with recognition off.
 */
export function syncVoices(meetingId: string, before: Meeting['speakers'], after: Meeting['speakers']): void {
  if (!existsSync(embeddingsFile(meetingId))) return
  const { model, voices: prints } = readEmbeddings(meetingId)
  const learn = store.getSettings().speakers.recognize && model === voiceModel()
  for (const [id, p] of Object.entries(prints) as Array<[SpeakerId, { v: number[]; capped?: boolean }]>) {
    if (id === 'you' || !p) continue
    const was = before?.[id]?.trim() ?? ''
    const now = after?.[id]?.trim() ?? ''
    if (now === was) continue
    if (now && learn && !p.capped) voices.enroll(now, { meetingId, speaker: id, v: p.v, model })
    else if (was) voices.unenroll(meetingId, id)
  }
}

/**
 * Speakers left with no lines (removed, or every line given to someone
 * else): what their voice taught is forgotten, and their voiceprint goes, so
 * a speaker added later under the same number doesn't inherit it.
 */
export function forgetSpeakers(meetingId: string, ids: SpeakerId[]): void {
  for (const id of ids) voices.unenroll(meetingId, id)
  if (!existsSync(embeddingsFile(meetingId))) return
  const prints = readEmbeddings(meetingId)
  if (!ids.some((id) => prints.voices[id])) return
  for (const id of ids) delete prints.voices[id]
  writeFileSync(embeddingsFile(meetingId), JSON.stringify(prints))
}

/** Forgets a meeting's voiceprints and whatever was learned from them. */
export function forgetMeetingVoices(meetingId: string): void {
  voices.unenrollMeeting(meetingId)
  rmSync(embeddingsFile(meetingId), { force: true })
}
