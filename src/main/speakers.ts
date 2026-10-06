import { utilityProcess } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import type { Meeting, SpeakerId, TranscriptSegment } from '@shared/types'
import { speakerPaths } from './setup'
import type { SpeakerCluster, SpeakerRequest, SpeakerResponse } from './speakers-worker'
import { BATCH_THREADS } from './speech'
import * as store from './store'
import * as voices from './voices'

/**
 * Tells the people on the computer's audio apart and, when a voice is known
 * from a past meeting, names them. Everything runs on this PC.
 */

const TIMEOUT_MS = 30 * 60_000
/** Voices with less speech than this aren't reliable enough to name or learn. */
const MIN_SECONDS = 8

const embeddingsFile = (meetingId: string) => join(store.paths.meeting(meetingId), 'speakers.json')

/** Voice embeddings for this meeting's speakers, kept so renaming one teaches Kasha the voice. */
export function readEmbeddings(meetingId: string): Partial<Record<SpeakerId, number[]>> {
  try {
    return JSON.parse(readFileSync(embeddingsFile(meetingId), 'utf8')) as Partial<Record<SpeakerId, number[]>>
  } catch {
    return {}
  }
}

function runWorker(req: SpeakerRequest): Promise<SpeakerCluster[]> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'speakers-worker.js'), [], { serviceName: 'Kasha speakers', stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Telling speakers apart took too long.'))
    }, TIMEOUT_MS)
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    child.once('spawn', () => {
      try {
        if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        /* not fatal */
      }
      child.postMessage(req)
    })
    child.on('message', (res: SpeakerResponse) => finish(() => (res.error ? reject(new Error(res.error)) : resolve(res.clusters ?? []))))
    child.on('exit', (code) => finish(() => reject(new Error(`Speaker worker exited (${code}).`))))
  })
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/** Gives each "Others" line to the cluster it overlaps most. Lines with no overlap follow their neighbours. */
export function assignLines(transcript: TranscriptSegment[], clusters: SpeakerCluster[]): { transcript: TranscriptSegment[]; ids: SpeakerId[] } {
  if (clusters.length < 2) return { transcript, ids: clusters.length ? ['others'] : [] }
  const idOf = new Map<number, SpeakerId>()
  const ids: SpeakerId[] = []
  let last: number | null = null
  let prev: TranscriptSegment | null = null
  const out = transcript.map((seg) => {
    if (seg.speaker !== 'others') return seg
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
  return { transcript: out, ids }
}

export interface SeparateResult {
  transcript: TranscriptSegment[]
  /** Names recognised from past meetings, by speaker id. */
  names: Partial<Record<SpeakerId, string>>
}

/**
 * Splits "Others" into s1, s2… using the system-audio track, saves each voice's
 * embedding beside the transcript, and names voices heard in past meetings.
 */
export async function separateSpeakers(meetingId: string, sysWav: string, transcript: TranscriptSegment[], attendees: string[] = []): Promise<SeparateResult> {
  const models = speakerPaths
  const spans = transcript.filter((s) => s.speaker === 'others').map((s) => ({ start: s.start, end: s.end }))
  if (!spans.length) return { transcript, names: {} }
  const clusters = await runWorker({
    wav: sysWav,
    spans,
    segmentationModel: models.segmentation(),
    embeddingModel: models.embedding(),
    threads: BATCH_THREADS,
    // The invite list includes the note taker, who is on the mic track.
    expected: attendees.length >= 2 ? Math.min(attendees.length - 1, 8) : undefined
  })
  const assigned = assignLines(transcript, clusters)

  // Which cluster became which id: in order of first appearance, the same way assignLines numbers them.
  const embeddings: Partial<Record<SpeakerId, number[]>> = {}
  const names: SeparateResult['names'] = {}
  if (clusters.length === 1) {
    embeddings.others = clusters[0].embedding
  } else if (clusters.length > 1) {
    const firstLine = (id: SpeakerId) => assigned.transcript.find((s) => s.speaker === id)
    for (const id of assigned.ids) {
      const line = firstLine(id)
      if (!line) continue
      let k = 0
      let best = -1
      clusters.forEach((c, i) => {
        const o = c.segments.reduce((t, s) => t + overlap(line, s), 0)
        if (o > best) {
          best = o
          k = i
        }
      })
      embeddings[id] = clusters[k].embedding
    }
  }
  const seconds = (id: SpeakerId) => assigned.transcript.filter((s) => s.speaker === id).reduce((t, s) => t + s.end - s.start, 0)
  for (const id of Object.keys(embeddings) as SpeakerId[]) {
    if (seconds(id) < MIN_SECONDS) delete embeddings[id]
  }
  writeFileSync(embeddingsFile(meetingId), JSON.stringify(embeddings))

  if (store.getSettings().speakers.recognize) {
    const taken = new Set<string>()
    for (const [id, v] of Object.entries(embeddings) as Array<[SpeakerId, number[]]>) {
      const hit = voices.match(v)
      if (hit && !taken.has(hit.name.toLowerCase())) {
        names[id] = hit.name
        taken.add(hit.name.toLowerCase())
      }
    }
  }
  return { transcript: assigned.transcript, names }
}

/**
 * After the user renames speakers: learn voices that were given a name, and
 * forget what a removed or changed name taught.
 */
export function syncVoices(meetingId: string, before: Meeting['speakers'], after: Meeting['speakers']): void {
  if (!store.getSettings().speakers.recognize || !existsSync(embeddingsFile(meetingId))) return
  const embeddings = readEmbeddings(meetingId)
  for (const [id, v] of Object.entries(embeddings) as Array<[SpeakerId, number[]]>) {
    if (id === 'you') continue
    const was = before?.[id]?.trim() ?? ''
    const now = after?.[id]?.trim() ?? ''
    if (now && now !== was) voices.enroll(now, { meetingId, speaker: id, v })
    else if (!now && was) voices.unenroll(meetingId, id)
  }
}
