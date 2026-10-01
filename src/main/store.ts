import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Meeting, type Settings, type TranscriptSegment } from '@shared/types'

export const paths = {
  root: () => app.getPath('userData'),
  settings: () => join(app.getPath('userData'), 'settings.json'),
  meetings: () => join(app.getPath('userData'), 'meetings'),
  meeting: (id: string) => join(app.getPath('userData'), 'meetings', id),
  bin: () => join(app.getPath('userData'), 'whisper')
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

// ---------- Settings ----------

let settingsCache: Settings | null = null

export function getSettings(): Settings {
  if (!settingsCache) {
    const saved = readJson<Partial<Settings>>(paths.settings(), {})
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...saved,
      reminders: { ...DEFAULT_SETTINGS.reminders, ...saved.reminders },
      detect: { ...DEFAULT_SETTINGS.detect, ...saved.detect },
      obsidian: { ...DEFAULT_SETTINGS.obsidian, ...saved.obsidian }
    }
  }
  return settingsCache
}

export function setSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings()
  settingsCache = {
    ...cur,
    ...patch,
    reminders: { ...cur.reminders, ...patch.reminders },
    detect: { ...cur.detect, ...patch.detect },
    obsidian: { ...cur.obsidian, ...patch.obsidian }
  }
  mkdirSync(paths.root(), { recursive: true })
  writeAtomic(paths.settings(), JSON.stringify(settingsCache, null, 2))
  return settingsCache
}

// ---------- Meetings ----------

export function listMeetings(): Meeting[] {
  const dir = paths.meetings()
  if (!existsSync(dir)) return []
  const out: Meeting[] = []
  for (const id of readdirSync(dir)) {
    const m = readJson<Meeting | null>(join(dir, id, 'meta.json'), null)
    if (m) out.push(m)
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getMeeting(id: string): Meeting | null {
  return readJson<Meeting | null>(join(paths.meeting(id), 'meta.json'), null)
}

export function createMeeting(init: Pick<Meeting, 'title' | 'app'>): Meeting {
  const now = new Date()
  // Sortable, readable folder names: 2026-10-01-1002-ab12cd
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  const id = `${stamp}-${randomUUID().slice(0, 6)}`
  const meeting: Meeting = {
    id,
    title: init.title,
    app: init.app,
    createdAt: now.toISOString(),
    status: 'draft',
    tags: [],
    sync: { state: 'not-synced' }
  }
  mkdirSync(join(paths.meeting(id), 'attachments'), { recursive: true })
  saveMeeting(meeting)
  writeFileSync(join(paths.meeting(id), 'note.md'), '')
  return meeting
}

export function saveMeeting(m: Meeting): Meeting {
  writeAtomic(join(paths.meeting(m.id), 'meta.json'), JSON.stringify(m, null, 2))
  return m
}

export function updateMeeting(id: string, patch: Partial<Meeting>): Meeting {
  const cur = getMeeting(id)
  if (!cur) throw new Error(`Meeting ${id} not found`)
  return saveMeeting({ ...cur, ...patch })
}

export function readNote(id: string): string {
  try {
    return readFileSync(join(paths.meeting(id), 'note.md'), 'utf8')
  } catch {
    return ''
  }
}

export function writeNote(id: string, markdown: string): void {
  writeAtomic(join(paths.meeting(id), 'note.md'), markdown)
}

export function readTranscript(id: string): TranscriptSegment[] {
  return readJson<TranscriptSegment[]>(join(paths.meeting(id), 'transcript.json'), [])
}

export function writeTranscript(id: string, segs: TranscriptSegment[]): void {
  writeAtomic(join(paths.meeting(id), 'transcript.json'), JSON.stringify(segs, null, 1))
}

export function deleteMeeting(id: string): void {
  rmSync(paths.meeting(id), { recursive: true, force: true })
}
