import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { joinNotes, joinTranscripts, startOf } from '@shared/combine'
import { GENERIC_TITLE, normName, type Meeting } from '@shared/types'
import { audioInfo } from './audio'
import { SAMPLE_RATE, WavWriter, type Track } from './recorder'
import { moveMeetingVoices } from './speakers'
import * as store from './store'
import { splitNote } from './summarizer'

const CHUNK = 1 << 20

const wavSeconds = (file: string) => (existsSync(file) ? Math.max(0, statSync(file).size - 44) / 2 / SAMPLE_RATE : 0)

/** How long the earlier part runs: its recording, or the clock if the recording is gone. */
function lengthOf(m: Meeting, lastEnd: number): number {
  const dir = join(store.paths.meeting(m.id), 'audio')
  const audio = Math.max(wavSeconds(join(dir, 'mic.wav')), wavSeconds(join(dir, 'sys.wav')))
  const clock = m.recordingStartedAt && m.recordingEndedAt ? (Date.parse(m.recordingEndedAt) - Date.parse(m.recordingStartedAt)) / 1000 : 0
  return Math.ceil(Math.max(lastEnd, audio || clock))
}

/**
 * The later part's recording after the earlier one's, each track padded with
 * silence to `offset` first so the lines still play the right audio. When the
 * earlier recording is gone (deleted after its transcript), the later one is
 * dropped too: its lines can't be lined up with nothing before them.
 */
function joinAudio(into: string, from: string, offset: number): void {
  const src = join(store.paths.meeting(from), 'audio')
  if (!existsSync(src)) return
  if (!audioInfo(into)) return
  const dest = join(store.paths.meeting(into), 'audio')
  for (const track of ['mic', 'sys'] as Track[]) {
    const file = join(src, `${track}.wav`)
    if (!existsSync(file)) continue
    const out = new WavWriter(join(dest, `${track}.wav`), true)
    try {
      const want = Math.round(offset * SAMPLE_RATE) * 2
      const silence = Buffer.alloc(CHUNK)
      while (out.length < want) out.write(silence.subarray(0, Math.min(CHUNK, want - out.length)))
      const fd = openSync(file, 'r')
      try {
        const size = fstatSync(fd).size
        const buf = Buffer.alloc(CHUNK)
        for (let at = 44; at < size; ) {
          const n = readSync(fd, buf, 0, Math.min(CHUNK, size - at), at)
          if (n <= 0) break
          out.write(buf.subarray(0, n - (n % 2)))
          at += n
        }
      } finally {
        closeSync(fd)
      }
    } finally {
      out.close()
    }
  }
}

/** Copies the later part's screenshots and pictures in beside the note, renamed where a name is taken. Returns its note with links to them. */
function moveAttachments(into: string, from: string, note: string): string {
  const src = join(store.paths.meeting(from), 'attachments')
  if (!existsSync(src)) return note
  const dest = join(store.paths.meeting(into), 'attachments')
  mkdirSync(dest, { recursive: true })
  const renamed = new Map<string, string>()
  for (const file of readdirSync(src)) {
    const ext = extname(file)
    const base = file.slice(0, file.length - ext.length)
    let name = file
    for (let i = 2; existsSync(join(dest, name)); i++) name = `${base}-${i}${ext}`
    copyFileSync(join(src, file), join(dest, name))
    if (name !== file) renamed.set(file, name)
  }
  return note.replace(/(\]\(attachments\/)([^)\s]+)\)/g, (all, link: string, file: string) => (renamed.has(file) ? `${link}${renamed.get(file)})` : all))
}

const union = (a?: string[], b?: string[]) => {
  const out = [...(a ?? [])]
  for (const n of b ?? []) if (!out.some((o) => normName(o) === normName(n))) out.push(n)
  return out.length ? out : undefined
}

const clockTime = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Adds one later part to the note kept. The later part itself is left for the caller to delete. */
function joinInto(into: string, part: Meeting): void {
  const a = store.getMeeting(into)!
  const before = store.readTranscript(into)
  const offset = lengthOf(a, before.reduce((t, s) => Math.max(t, s.end), 0))
  const joined = joinTranscripts({ ...a, transcript: before }, { ...part, transcript: store.readTranscript(part.id) }, offset)

  joinAudio(into, part.id, offset)
  const theirs = moveAttachments(into, part.id, store.readNote(part.id))
  const startedAt = part.recordingStartedAt ?? part.createdAt
  store.writeNote(into, joinNotes(splitNote(store.readNote(into)), splitNote(theirs), clockTime(startedAt)))
  store.writeTranscript(into, joined.transcript)
  moveMeetingVoices(part.id, into, joined.ids)

  store.updateMeeting(into, {
    title: GENERIC_TITLE.test(a.title) && !GENERIC_TITLE.test(part.title) ? part.title : a.title,
    recordingEndedAt: part.recordingEndedAt ?? a.recordingEndedAt,
    speakers: joined.speakers,
    speakerGuesses: joined.speakerGuesses,
    attendees: union(a.attendees, part.attendees),
    participants: union(a.participants, part.participants),
    attendance: a.attendance || part.attendance ? { ...part.attendance, ...a.attendance } : undefined,
    tags: Array.from(new Set([...a.tags, ...part.tags])),
    parts: [...(a.parts ?? []), { at: offset, startedAt }, ...(part.parts ?? []).map((p) => ({ ...p, at: p.at + offset }))],
    notSameCall: a.notSameCall?.filter((id) => id !== part.id)
  })
}

/**
 * Combines finished notes into the earliest of them, in the order they were
 * recorded, then deletes the others. Returns the note kept. The summary is
 * still the parts' own until it's written again (the caller queues that).
 */
export function combineNotes(parts: Meeting[]): Meeting {
  const [into, ...rest] = [...parts].sort((x, y) => startOf(x) - startOf(y))
  for (const part of rest) {
    joinInto(into.id, part)
    store.deleteMeeting(part.id)
  }
  return store.getMeeting(into.id)!
}
