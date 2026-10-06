import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpeakerId, VoiceProfile } from '@shared/types'
import { paths } from './store'

/**
 * Voices of people from past meetings, so they can be named automatically
 * next time. A voice is a few 512-number embeddings, one per meeting the
 * person was named in. Stored on this PC only, in voices.json.
 */

interface VoiceSample {
  meetingId: string
  speaker: SpeakerId
  v: number[]
  at: string // ISO
}

interface Voice {
  name: string
  samples: VoiceSample[]
}

/** Cosine similarity at or above this counts as the same person. */
export const MATCH = 0.7
const MAX_SAMPLES = 10

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

/** The best-matching known person for a voice, if anyone is close enough. */
export function match(v: ArrayLike<number>): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null
  for (const voice of load()) {
    for (const s of voice.samples) {
      const score = cosine(v, s.v)
      if (score >= MATCH && (!best || score > best.score)) best = { name: voice.name, score }
    }
  }
  return best
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
  const voices = load()
    .map((voice) => ({ ...voice, samples: voice.samples.filter((s) => !(s.meetingId === meetingId && s.speaker === speaker)) }))
    .filter((x) => x.samples.length)
  save(voices)
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
