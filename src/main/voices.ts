import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpeakerId, VoiceProfile } from '@shared/types'
import { paths } from './store'

/**
 * Voices of people from past meetings, so they can be offered as names next
 * time. A voice is a few voiceprints, one per meeting the person was named or
 * confirmed in. Stored on this PC only, in voices.json. Voiceprints are
 * biometric-like: they're only learned when the user names or confirms a
 * speaker, and they go when the meeting they came from is deleted.
 */

interface VoiceSample {
  meetingId: string
  speaker: SpeakerId
  v: number[]
  at: string // ISO
  /** The voiceprint model that made it. Samples from another model are never compared. */
  model?: string
}

interface Voice {
  name: string
  samples: VoiceSample[]
}

/**
 * A person's score at or above this counts as the same person. With the
 * ERes2Net voiceprints, different people score under 0.35 and the same person
 * about 0.75 within one call; across calls the mic and room differ, hence the
 * margin. Voiceprints from another model are never compared.
 */
export const MATCH = 0.6
/** The best person must beat the next by this much, or it's too close to call. */
export const LEAD = 0.1
const MAX_SAMPLES = 10
/** A person's score is the mean of their best few samples, so one odd sample can't decide it. */
const TOP = 3

const file = () => join(paths.root(), 'voices.json')

function load(): Voice[] {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { voices?: Voice[] }
    return Array.isArray(raw.voices) ? raw.voices : []
  } catch {
    return []
  }
}

function save(voices: Voice[]): void {
  mkdirSync(paths.root(), { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify({ voices }))
  renameSync(tmp, file())
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** "Sam" and "Sam Lee", or "Sam Lee (External)" and "sam lee": typed names and Teams names differ. */
export function looselySame(a: string, b: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/\((external|guest|unverified)\)/g, ' ')
      .split(/[^\p{L}\p{N}'-]+/u)
      .filter(Boolean)
  const A = words(a)
  const B = words(b)
  if (!A.length || !B.length) return false
  const [short, long] = A.length <= B.length ? [A, B] : [B, A]
  return short.every((w) => long.includes(w))
}

/** Same model: by tag when the sample has one, else by vector length (the old CAM++ prints are 512 long). */
const sameModel = (s: VoiceSample, model: string, length: number) => (s.model ? s.model === model : s.v.length === length)

/** How alike a voice is to each known person: the mean of their best TOP samples, best person first. */
function scores(v: ArrayLike<number>, model: string, people: Voice[]): Array<{ name: string; score: number }> {
  const out: Array<{ name: string; score: number }> = []
  for (const voice of people) {
    const s = voice.samples
      .filter((x) => sameModel(x, model, v.length))
      .map((x) => cosine(v, x.v))
      .sort((a, b) => b - a)
      .slice(0, TOP)
    if (s.length) out.push({ name: voice.name, score: s.reduce((t, x) => t + x, 0) / s.length })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * Which known person each voice in a meeting is, if any. A voice needs a
 * score of MATCH and a LEAD over its next-best person. Names are given best
 * score first, so two voices can't take the same person, and a better match
 * isn't lost to whichever speaker came first. With `candidates` (the people
 * in the call or invited), only those people are considered.
 */
export function matchAll(
  prints: Partial<Record<SpeakerId, number[]>>,
  model: string,
  candidates?: string[]
): Partial<Record<SpeakerId, { name: string; score: number }>> {
  let people = load()
  if (candidates?.length) people = people.filter((p) => candidates.some((c) => looselySame(p.name, c)))
  const options: Array<{ id: SpeakerId; name: string; score: number }> = []
  for (const [id, v] of Object.entries(prints) as Array<[SpeakerId, number[]]>) {
    const [best, next] = scores(v, model, people)
    if (best && best.score >= MATCH && best.score - (next?.score ?? 0) >= LEAD) options.push({ id, ...best })
  }
  const out: Partial<Record<SpeakerId, { name: string; score: number }>> = {}
  const taken = new Set<string>()
  for (const o of options.sort((a, b) => b.score - a.score)) {
    if (out[o.id] || taken.has(o.name.toLowerCase())) continue
    out[o.id] = { name: o.name, score: o.score }
    taken.add(o.name.toLowerCase())
  }
  return out
}

/** Remembers that this speaker in this meeting is `name`. Moves the sample if it was filed under someone else. */
export function enroll(name: string, sample: Omit<VoiceSample, 'at'>): void {
  const n = name.trim()
  if (!n || !sample.v.length) return
  const voices = load().map((voice) => ({
    ...voice,
    samples: voice.samples.filter((s) => !(s.meetingId === sample.meetingId && s.speaker === sample.speaker))
  }))
  let voice = voices.find((x) => same(x.name, n))
  if (!voice) {
    voice = { name: n, samples: [] }
    voices.push(voice)
  }
  voice.samples.push({ ...sample, at: new Date().toISOString() })
  if (voice.samples.length > MAX_SAMPLES) voice.samples.splice(0, voice.samples.length - MAX_SAMPLES)
  save(voices.filter((x) => x.samples.length))
}

/** Forgets what was learned from this speaker in this meeting. */
export function unenroll(meetingId: string, speaker: SpeakerId): void {
  if (!existsSync(file())) return
  const voices = load()
    .map((voice) => ({ ...voice, samples: voice.samples.filter((s) => !(s.meetingId === meetingId && s.speaker === speaker)) }))
    .filter((x) => x.samples.length)
  save(voices)
}

/** Forgets everything learned from a meeting, when it's deleted. */
export function unenrollMeeting(meetingId: string): void {
  if (!existsSync(file())) return
  const before = load()
  const after = before
    .map((voice) => ({ ...voice, samples: voice.samples.filter((s) => s.meetingId !== meetingId) }))
    .filter((x) => x.samples.length)
  const count = (vs: Voice[]) => vs.reduce((t, v) => t + v.samples.length, 0)
  if (count(after) !== count(before)) save(after)
}

/** Forgets samples from meetings that no longer exist. */
export function prune(meetingIds: Set<string>): void {
  if (!existsSync(file())) return
  const before = load()
  const after = before.map((voice) => ({ ...voice, samples: voice.samples.filter((s) => meetingIds.has(s.meetingId)) })).filter((x) => x.samples.length)
  const count = (vs: Voice[]) => vs.reduce((t, v) => t + v.samples.length, 0)
  if (count(after) !== count(before)) save(after)
}

/** Forgets every learned voice. */
export function clear(): void {
  if (existsSync(file())) save([])
}

export function list(): VoiceProfile[] {
  return load()
    .map((v) => ({
      name: v.name,
      meetings: v.samples.length,
      updatedAt: v.samples.reduce((m, s) => (s.at > m ? s.at : m), '')
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function remove(name: string): void {
  save(load().filter((v) => !same(v.name, name)))
}

export function hasAny(): boolean {
  return existsSync(file()) && load().length > 0
}
