import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioInfo } from '@shared/types'
import { log } from './log'
import * as store from './store'

/**
 * Recordings are deleted once the transcript is saved, unless Keep audio is
 * on. Even then they go after a week: recording laws differ by place, and a
 * transcript is what the notes need. To keep a recording, save a copy
 * somewhere else from the note.
 */
export const AUDIO_KEEP_DAYS = 7
const SWEEP_EVERY_MS = 6 * 3600_000

const audioDir = (id: string) => join(store.paths.meeting(id), 'audio')

/** When this recording was finished, as far as Kasha can tell. */
function recordedAt(id: string, dir: string): number {
  const m = store.getMeeting(id)
  const iso = m?.recordingEndedAt ?? m?.recordingStartedAt
  if (iso) return Date.parse(iso)
  try {
    return statSync(dir).mtimeMs
  } catch {
    return Date.now()
  }
}

export function audioInfo(id: string): AudioInfo | null {
  const dir = audioDir(id)
  if (!existsSync(dir)) return null
  let bytes = 0
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.wav')) bytes += statSync(join(dir, f)).size
  }
  if (!bytes) return null
  return { bytes, until: new Date(recordedAt(id, dir) + AUDIO_KEEP_DAYS * 86_400_000).toISOString() }
}

export function deleteAudio(id: string): void {
  rmSync(audioDir(id), { recursive: true, force: true })
}

const busy = (status: string) => status === 'recording' || status === 'transcribing' || status === 'separating' || status === 'summarizing'

/** Deletes recordings older than the keep period. Returns how many meetings lost theirs. */
export function sweepAudio(now = Date.now()): number {
  let removed = 0
  for (const m of store.listMeetings()) {
    if (busy(m.status)) continue
    const dir = audioDir(m.id)
    if (!existsSync(dir)) continue
    if (now - recordedAt(m.id, dir) < AUDIO_KEEP_DAYS * 86_400_000) continue
    deleteAudio(m.id)
    removed++
    if (m.status === 'failed') {
      store.updateMeeting(m.id, { status: 'ready', error: `The recording was deleted after ${AUDIO_KEEP_DAYS} days before it could be processed.` })
    }
  }
  if (removed) log('audio-expired', { meetings: removed })
  return removed
}

export function startAudioSweeper(onRemoved: () => void): void {
  const run = () => sweepAudio() && onRemoved()
  run()
  setInterval(run, SWEEP_EVERY_MS)
}

/** Copies the recording's tracks into `folder`, named after the meeting. Returns the files written. */
export function exportAudio(id: string, folder: string, stem: string): string[] {
  const dir = audioDir(id)
  if (!existsSync(dir)) return []
  mkdirSync(folder, { recursive: true })
  const out: string[] = []
  for (const [track, label] of [
    ['mic', 'you'],
    ['sys', 'others']
  ] as const) {
    const src = join(dir, `${track}.wav`)
    if (!existsSync(src)) continue
    const dest = join(folder, `${stem} (${label}).wav`)
    copyFileSync(src, dest)
    out.push(dest)
  }
  return out
}
