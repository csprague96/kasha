import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { APP_LABELS, type Meeting } from '@shared/types'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** 00:42:18 */
export function timer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`
}

/** 4:05 or 1:04:05 */
export function clock(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${p2(m)}:${p2(s % 60)}` : `${m}:${p2(s % 60)}`
}

export function hhmm(d: Date): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Sidebar group label: Today, Yesterday, Monday, 12 Sep */
export function dayGroup(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

/** Thu 1 Oct · 10:02 · Teams · 42 min */
export function meetingMeta(m: Meeting): string {
  const d = new Date(m.recordingStartedAt ?? m.createdAt)
  const parts = [d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), hhmm(d)]
  if (m.app !== 'manual') parts.push(APP_LABELS[m.app])
  if (m.recordingStartedAt && m.recordingEndedAt) {
    const mins = Math.max(1, Math.round((Date.parse(m.recordingEndedAt) - Date.parse(m.recordingStartedAt)) / 60000))
    parts.push(`${mins} min`)
  }
  return parts.join(' · ')
}

/** Markdown stores `attachments/x.png`; the editor needs a URL it can load. */
export function toEditorMarkdown(id: string, md: string): string {
  return md.replace(/\]\(attachments\//g, `](kasha-file://${id}/attachments/`)
}

export function fromEditorMarkdown(id: string, md: string): string {
  return md.split(`kasha-file://${id}/attachments/`).join('attachments/')
}
