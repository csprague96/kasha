import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { ActionGroup, ActionItem, Meeting, Settings } from '@shared/types'
import * as store from './store'

const TASK = /^(\s*[-*+] \[)( |x|X)(\] )(.*)$/
const OWNER = /^([A-Z][\w.'’-]*(?: [A-Z][\w.'’-]*){0,3}): (.+)$/
const DUE_ISO = /\s*\(due (\d{4}-\d{2}-\d{2})\)\s*$/
const DUE_WORDS =
  /\s*\(((?:[^()]*\b(?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow|tonight|week|month|eod|eow|eom|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}(?:st|nd|rd|th)?)\b[^()]*))\)\s*$/i

interface TaskLine {
  line: number
  done: boolean
  raw: string
}

function taskLines(md: string): TaskLine[] {
  const out: TaskLine[] = []
  let fenced = false
  md.split('\n').forEach((text, line) => {
    if (/^\s*```/.test(text)) fenced = !fenced
    if (fenced) return
    const m = TASK.exec(text)
    if (m) out.push({ line, done: m[2] !== ' ', raw: m[4].trim() })
  })
  return out
}

function isMine(owner: string | null, myName: string): boolean {
  if (!owner) return true // written by the note taker or unassigned
  const o = owner.trim().toLowerCase()
  if (o === 'me' || o === 'you') return true
  const name = myName.trim().toLowerCase()
  return !!name && (o === name || o === name.split(/\s+/)[0])
}

export function parseAction(meetingId: string, index: number, t: TaskLine, myName: string): ActionItem {
  let text = t.raw
  let owner: string | null = null
  let due: string | null = null
  let dueText: string | null = null
  const iso = DUE_ISO.exec(text)
  if (iso) {
    due = iso[1]
    text = text.slice(0, iso.index)
  } else {
    const words = DUE_WORDS.exec(text)
    if (words) {
      dueText = words[1].trim()
      text = text.slice(0, words.index)
    }
  }
  const o = OWNER.exec(text)
  if (o) {
    owner = o[1]
    text = o[2]
  }
  return { meetingId, index, text: text.trim(), raw: t.raw, owner, mine: isMine(owner, myName), due, dueText, done: t.done }
}

function setCheckbox(md: string, index: number, raw: string, done: boolean): string | null {
  const lines = md.split('\n')
  const tasks = taskLines(md)
  const hit = tasks[index]?.raw === raw ? tasks[index] : tasks.find((t) => t.raw === raw)
  if (!hit) return null
  lines[hit.line] = lines[hit.line].replace(TASK, (_all, a, _b, c, d) => `${a}${done ? 'x' : ' '}${c}${d}`)
  return lines.join('\n')
}

/**
 * If the synced Obsidian copy was edited since Kasha last looked, adopt the
 * checkbox states from it so ticking a task in Obsidian counts in Kasha too.
 */
function mergeFromObsidian(m: Meeting): void {
  const path = m.sync.path
  if (!path || !existsSync(path)) return
  const mtime = statSync(path).mtimeMs
  const seen = Math.max(m.sync.mtimeMs ?? 0, m.sync.mergedMtimeMs ?? 0)
  if (mtime <= seen + 1000) return
  const theirs = new Map(taskLines(readFileSync(path, 'utf8')).map((t) => [t.raw, t.done]))
  let note = store.readNote(m.id)
  let changed = false
  taskLines(note).forEach((t, i) => {
    const done = theirs.get(t.raw)
    if (done !== undefined && done !== t.done) {
      note = setCheckbox(note, i, t.raw, done) ?? note
      changed = true
    }
  })
  if (changed) store.writeNote(m.id, note)
  store.updateMeeting(m.id, { sync: { ...m.sync, mergedMtimeMs: mtime } })
}

export function listActions(): ActionGroup[] {
  const { myName } = store.getSettings()
  const groups: ActionGroup[] = []
  for (const m of store.listMeetings()) {
    if (m.status === 'recording') continue
    mergeFromObsidian(m)
    const items = taskLines(store.readNote(m.id)).map((t, i) => parseAction(m.id, i, t, myName))
    if (items.length) {
      groups.push({
        meeting: { id: m.id, title: m.title, createdAt: m.createdAt, recordingStartedAt: m.recordingStartedAt },
        items
      })
    }
  }
  return groups
}

/** Ticks or unticks one action in the note, and in the Obsidian copy if there is one. */
export function setActionDone(meetingId: string, index: number, raw: string, done: boolean): void {
  const next = setCheckbox(store.readNote(meetingId), index, raw, done)
  if (next === null) return
  store.writeNote(meetingId, next)

  const m = store.getMeeting(meetingId)
  const path = m?.sync.path
  if (!m || !path || !existsSync(path)) return
  // Patch just that line so edits made in Obsidian are kept.
  const before = statSync(path).mtimeMs
  const patched = setCheckbox(readFileSync(path, 'utf8'), index, raw, done)
  if (patched === null) return
  writeFileSync(path, patched)
  const after = statSync(path).mtimeMs
  const untouched = !m.sync.mtimeMs || before <= m.sync.mtimeMs + 1000
  store.updateMeeting(meetingId, {
    sync: untouched ? { ...m.sync, mtimeMs: after } : { ...m.sync, mergedMtimeMs: after }
  })
}

/** Drops one task line from the note, and from the Obsidian copy if there is one. */
function removeLine(md: string, index: number, raw: string): string | null {
  const lines = md.split('\n')
  const tasks = taskLines(md)
  const hit = tasks[index]?.raw === raw ? tasks[index] : tasks.find((t) => t.raw === raw)
  if (!hit) return null
  lines.splice(hit.line, 1)
  return lines.join('\n')
}

export function removeAction(meetingId: string, index: number, raw: string): void {
  const next = removeLine(store.readNote(meetingId), index, raw)
  if (next === null) return
  store.writeNote(meetingId, next)

  const m = store.getMeeting(meetingId)
  const path = m?.sync.path
  if (!m || !path || !existsSync(path)) return
  const before = statSync(path).mtimeMs
  const patched = removeLine(readFileSync(path, 'utf8'), index, raw)
  if (patched === null) return
  writeFileSync(path, patched)
  const after = statSync(path).mtimeMs
  const untouched = !m.sync.mtimeMs || before <= m.sync.mtimeMs + 1000
  store.updateMeeting(meetingId, {
    sync: untouched ? { ...m.sync, mtimeMs: after } : { ...m.sync, mergedMtimeMs: after }
  })
}

// ---------- Daily reminder ----------

function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function reminderText(groups: ActionGroup[]): string | null {
  const mine = groups.flatMap((g) => g.items).filter((a) => a.mine && !a.done)
  if (!mine.length) return null
  const t = today()
  const dueToday = mine.filter((a) => a.due === t).length
  const overdue = mine.filter((a) => a.due && a.due < t).length
  const parts = [`${mine.length} open`]
  if (dueToday) parts.push(`${dueToday} due today`)
  if (overdue) parts.push(`${overdue} overdue`)
  return parts.join(', ')
}

/**
 * Fires once per weekday at the chosen time. If the PC was asleep or Kasha
 * started late, it fires at the next check instead of being skipped.
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private settings: () => Settings,
    private save: (lastShown: string) => void,
    private notify: (text: string) => void
  ) {}

  start(): void {
    this.schedule(60_000)
  }

  /** Call on resume/unlock: catches a reminder missed while asleep. */
  check(): void {
    const s = this.settings().reminders
    const now = new Date()
    const [h, m] = s.time.split(':').map(Number)
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 9, m || 0)
    const weekday = now.getDay() !== 0 && now.getDay() !== 6
    if (s.enabled && weekday && now >= due && s.lastShown !== today(now)) {
      const text = reminderText(listActions())
      this.save(today(now))
      if (text) this.notify(text)
    }
    this.schedule()
  }

  private schedule(delay?: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (delay === undefined) {
      const [h, m] = this.settings().reminders.time.split(':').map(Number)
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 9, m || 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      // Re-check at least hourly so clock or settings changes are picked up.
      delay = Math.min(next.getTime() - now.getTime() + 1000, 3_600_000)
    }
    this.timer = setTimeout(() => this.check(), delay)
  }
}
