import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { attendance, attendanceSummary } from '@shared/attendance'
import { APP_LABELS, speakerName, type Meeting, type Settings, type TranscriptSegment } from '@shared/types'
import { paths } from './store'

/** The Obsidian settings plus the standing tags every note gets. */
export type ExportOptions = Settings['obsidian'] & { defaultTags?: string[] }

export const exportOptions = (s: Settings): ExportOptions => ({ ...s.obsidian, defaultTags: s.tags.defaults })

const p2 = (n: number) => String(n).padStart(2, '0')

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled'
}

function clock(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`
}

function yamlString(s: string): string {
  return /^[\w .,-]+$/.test(s) ? s : JSON.stringify(s)
}

export function exportFileName(m: Meeting, template: string): string {
  const d = new Date(m.recordingStartedAt ?? m.createdAt)
  const name = template
    .replace(/\{date\}/g, `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
    .replace(/\{time\}/g, `${p2(d.getHours())}${p2(d.getMinutes())}`)
    .replace(/\{title\}/g, m.title)
  return `${safeName(name)}.md`
}

export function buildMarkdown(
  m: Meeting,
  note: string,
  transcript: TranscriptSegment[],
  opts: ExportOptions,
  imageName: (rel: string) => string | null
): string {
  const d = new Date(m.recordingStartedAt ?? m.createdAt)
  const fm: string[] = [
    '---',
    `title: ${yamlString(m.title)}`,
    `date: ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    `time: "${p2(d.getHours())}:${p2(d.getMinutes())}"`
  ]
  if (m.app !== 'manual') fm.push(`app: ${APP_LABELS[m.app]}`)
  if (m.recordingStartedAt && m.recordingEndedAt) {
    const mins = Math.round((Date.parse(m.recordingEndedAt) - Date.parse(m.recordingStartedAt)) / 60000)
    fm.push(`duration: ${mins}m`)
  }
  const who = attendanceSummary(attendance(m, transcript, ''))
  if (who.present.length) fm.push(`attendees: [${who.present.map(yamlString).join(', ')}]`)
  if (who.absent.length) fm.push(`not_heard: [${who.absent.map(yamlString).join(', ')}]`)
  // The standing tags from Settings go first, then the note's own.
  const tags = Array.from(new Set([...(opts.defaultTags ?? []), ...m.tags]))
  fm.push(`tags: [${tags.map(yamlString).join(', ')}]`, 'source: kasha', '---', '')

  // Local image links become Obsidian embeds, or are dropped if attachments are off.
  const body = note.replace(/!\[[^\]]*\]\((attachments\/[^)\s]+)\)/g, (_all, rel: string) => {
    const name = imageName(rel)
    return name ? `![[${name}]]` : ''
  })

  const out = fm.join('\n') + body.trim() + '\n'
  if (!opts.includeTranscript || transcript.length === 0) return out
  const lines = transcript.map((t) => `> \`${clock(t.start)}\` **${speakerName(t.speaker, m.speakers)}:** ${t.text}`)
  return `${out}\n> [!quote]- Transcript\n${lines.join('\n>\n')}\n`
}

export type SyncResult = Meeting['sync']

/**
 * Writes the note into the vault. Kasha owns the file it created, but if the
 * file was edited in Obsidian since the last sync it is left alone unless forced.
 */
export function syncToObsidian(
  m: Meeting,
  note: string,
  transcript: TranscriptSegment[],
  opts: ExportOptions,
  force = false
): SyncResult {
  if (!opts.vault) return { state: 'not-synced' }
  if (!existsSync(opts.vault)) return { state: 'error', error: 'Vault folder not found. Check Settings.' }

  const folder = join(opts.vault, opts.folder)
  const target = join(folder, exportFileName(m, opts.fileName))
  const prev = m.sync.path

  if (!force && prev && existsSync(prev) && m.sync.mtimeMs && statSync(prev).mtimeMs > m.sync.mtimeMs + 1000) {
    return { ...m.sync, state: 'edited-in-obsidian' }
  }

  mkdirSync(folder, { recursive: true })
  const attachDir = join(folder, 'attachments')
  const stem = basename(target, '.md')
  const imageName = (rel: string): string | null => {
    if (!opts.attachments) return null
    const src = join(paths.meeting(m.id), rel)
    if (!existsSync(src)) return null
    const name = `${stem} ${basename(rel, extname(rel))}${extname(rel)}`
    mkdirSync(attachDir, { recursive: true })
    copyFileSync(src, join(attachDir, name))
    return name
  }

  const md = buildMarkdown(m, note, transcript, opts, imageName)
  // Title changed since last sync: move the old file instead of leaving a duplicate.
  if (prev && prev !== target && existsSync(prev) && !existsSync(target)) renameSync(prev, target)
  const tmp = `${target}.kasha-tmp`
  writeFileSync(tmp, md)
  renameSync(tmp, target)
  return { state: 'synced', path: target, at: new Date().toISOString(), mtimeMs: statSync(target).mtimeMs }
}

/**
 * The files Kasha wrote to the vault for a note: the .md and the screenshots it
 * copied into attachments/ beside it. Only ones still there. The .md comes
 * last, so a delete that fails partway can be tried again.
 */
export function vaultFiles(m: Meeting, note: string): string[] {
  const file = m.sync.path
  if (!file || extname(file).toLowerCase() !== '.md' || !existsSync(file)) return []
  const stem = basename(file, '.md')
  const attachDir = join(dirname(file), 'attachments')
  const images = Array.from(note.matchAll(/!\[[^\]]*\]\((attachments\/[^)\s]+)\)/g), ([, rel]) =>
    join(attachDir, `${stem} ${basename(rel, extname(rel))}${extname(rel)}`)
  )
  return [...new Set(images.filter((f) => existsSync(f))), file]
}
