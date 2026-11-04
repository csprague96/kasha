import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { shownName, type AskAnswer, type AskTurn, type Meeting, type RelatedNote, type Settings, type SpeakerId, type TranscriptSegment } from '@shared/types'
import { log } from './log'
import { redact, redactLines } from './redact'
import { candidates, matchTitles, parseNote, profileNote, rank, type CallProfile, type NoteProfile, type ParsedNote } from './related'
import * as store from './store'
import { answer, splitNote } from './summarizer'

/**
 * Questions about a call, answered from the call and from related notes in
 * the Obsidian vault (or in Kasha, when there's no vault). Kasha finds the
 * related notes itself (related.ts) and shows them before anything is sent,
 * so the user sees and chooses what goes to Claude Code or Codex. The engine
 * gets no tools: only the text of the call and of the notes picked.
 */

const MAX_FILES = 5000 // a vault bigger than this is searched in part
const MAX_BYTES = 512 * 1024 // longer files (exports, logs) aren't notes worth reading
const PER_NOTE = 8000 // characters of each related note sent
const NOTES_TOTAL = 60_000
const MAX_NOTES = 10
const TRANSCRIPT_MAX = 100_000
const HISTORY = 4 // earlier questions carried into a follow-up

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dateOf = (m: Meeting) => ymd(new Date(m.recordingStartedAt ?? m.createdAt))

function vaultOf(s: Settings): string {
  return s.obsidian.vault && existsSync(s.obsidian.vault) ? resolve(s.obsidian.vault) : ''
}

/** A path from the renderer, inside the vault and a Markdown file, or null. */
function inVault(vault: string, rel: string): string | null {
  if (!vault || !/\.md$/i.test(rel)) return null
  const file = resolve(vault, rel)
  return file.startsWith(vault + sep) ? file : null
}

let listed: { vault: string; at: number; files: string[] } | null = null

/**
 * Markdown files in the vault, relative to it with forward slashes. Hidden
 * folders (.obsidian, .trash, .git) are skipped. Kept for half a minute, for
 * searching by title as the user types.
 */
async function listVault(vault: string): Promise<string[]> {
  if (listed && listed.vault === vault && Date.now() - listed.at < 30_000) return listed.files
  const files: string[] = []
  const dirs = ['']
  while (dirs.length && files.length < MAX_FILES) {
    const rel = dirs.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(join(vault, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) dirs.push(r)
      else if (e.isFile() && /\.md$/i.test(e.name) && files.length < MAX_FILES) files.push(r)
    }
  }
  listed = { vault, at: Date.now(), files }
  return files
}

async function readVaultNote(file: string): Promise<string | null> {
  try {
    if ((await stat(file)).size > MAX_BYTES) return null
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Names the user gave speakers (not guesses), besides who was invited and in the call. */
function peopleOf(m: Meeting): string[] {
  const named = Object.entries(m.speakers ?? {})
    .filter(([k, v]) => k !== 'you' && v?.trim() && !m.speakerGuesses?.[k as SpeakerId])
    .map(([, v]) => v!)
  return [...(m.attendees ?? []), ...(m.participants ?? []), ...named]
}

const linksIn = (text: string) => Array.from(text.matchAll(/\[\[([^\]|#^]+)/g), (x) => x[1].trim())

/** A Kasha note as ranking reads it: what it says, and the words of its transcript. */
function kashaNote(m: Meeting): ParsedNote {
  const note = store.readNote(m.id)
  const said = store.readTranscript(m.id).map((s) => s.text).join(' ')
  return { title: m.title, date: dateOf(m), tags: m.tags, people: peopleOf(m), links: linksIn(note), body: `${note}\n${said}` }
}

interface Source {
  key: string
  title: string
  date: string | null
  meetingId?: string
  read(): Promise<ParsedNote | null>
}

/**
 * Every note that could be related: the vault's Markdown files, and Kasha
 * notes that aren't in the vault. The call's own copy in the vault is left out.
 */
async function sources(current: Meeting, s: Settings): Promise<Source[]> {
  const vault = vaultOf(s)
  const meetings = store.listMeetings().filter((m) => m.id !== current.id)
  const key = (p: string) => resolve(p).toLowerCase()
  const own = current.sync.path ? key(current.sync.path) : ''
  const synced = new Map<string, Meeting>()
  if (vault) {
    for (const m of meetings) if (m.sync.path && key(m.sync.path).startsWith(vault.toLowerCase() + sep)) synced.set(key(m.sync.path), m)
  }
  const out: Source[] = []
  if (vault) {
    for (const rel of await listVault(vault)) {
      const file = join(vault, rel)
      if (key(file) === own) continue
      const name = basename(rel)
      out.push({
        key: rel,
        title: name.replace(/\.md$/i, ''),
        date: name.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
        meetingId: synced.get(key(file))?.id,
        read: async () => {
          const text = await readVaultNote(file)
          return text === null ? null : parseNote(text, name)
        }
      })
    }
  }
  const inVaultNow = new Set(out.map((o) => o.meetingId).filter(Boolean))
  for (const m of meetings) {
    if (inVaultNow.has(m.id) || m.status === 'draft') continue
    out.push({ key: `kasha:${m.id}`, title: m.title, date: dateOf(m), meetingId: m.id, read: async () => kashaNote(m) })
  }
  return out
}

function callProfile(m: Meeting, transcript: TranscriptSegment[], s: Settings): CallProfile {
  const note = store.readNote(m.id)
  return {
    title: m.title,
    tags: m.tags.filter((t) => !s.tags.defaults.includes(t)),
    people: peopleOf(m),
    text: `${note}\n${transcript.map((t) => t.text).join(' ')}`,
    links: linksIn(note)
  }
}

/** Related notes for a call, best first, with why each came up. */
export async function relatedNotes(m: Meeting, transcript: TranscriptSegment[]): Promise<RelatedNote[]> {
  const t0 = Date.now()
  const s = store.getSettings()
  const call = callProfile(m, transcript, s)
  const cands = candidates(call)
  const all = await sources(m, s)
  const profiles: NoteProfile[] = []
  // A few files at a time: quick on a big vault, without holding many in memory.
  for (let i = 0; i < all.length; i += 16) {
    const batch = await Promise.all(all.slice(i, i + 16).map((src) => src.read().catch(() => null)))
    batch.forEach((note, j) => note && profiles.push(profileNote(all[i + j].key, note, cands, all[i + j].meetingId)))
  }
  const found = rank(call, cands, profiles, { generic: s.tags.defaults, me: s.myName })
  log('related-notes', { vault: !!vaultOf(s), notes: profiles.length, found: found.length, ms: Date.now() - t0 })
  return found
}

/** Notes whose title has every word typed, to add one the search didn't offer. */
export async function findNotes(m: Meeting, query: string): Promise<RelatedNote[]> {
  const q = query.trim().slice(0, 100)
  if (!q) return []
  return matchTitles(await sources(m, store.getSettings()), q).map(({ key, title, date, meetingId }) => ({ key, title, date, meetingId, why: [] }))
}

/** Where a related note opens: in Kasha when it came from there, otherwise in Obsidian. */
export function noteTarget(key: string): { meetingId: string } | { url: string } | null {
  const s = store.getSettings()
  if (key.startsWith('kasha:')) {
    const id = key.slice(6)
    try {
      return store.getMeeting(id) ? { meetingId: id } : null
    } catch {
      return null
    }
  }
  const vault = vaultOf(s)
  const file = inVault(vault, key)
  if (!file || !existsSync(file)) return null
  const from = store.listMeetings().find((m) => m.sync.path && resolve(m.sync.path).toLowerCase() === file.toLowerCase())
  if (from) return { meetingId: from.id }
  const name = vault.split(/[\\/]/).pop() ?? ''
  return { url: `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(key)}` }
}

/** Cuts text to `max` characters, saying so. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}\n[…]`
}

/** A related note's text for the question: its notes, without front matter or the transcript Kasha exports. */
async function readForAsk(key: string, s: Settings): Promise<{ note: RelatedNote; text: string } | null> {
  if (key.startsWith('kasha:')) {
    let m: Meeting | null = null
    try {
      m = store.getMeeting(key.slice(6))
    } catch {
      return null
    }
    if (!m) return null
    const note = store.readNote(m.id).trim()
    // A note with nothing written in it still has what was said.
    const body = note || store.readTranscript(m.id).map((t) => `${shownName(t.speaker, m)}: ${t.text}`).join('\n')
    const head = [m.tags.length ? `Tags: ${m.tags.map((t) => `#${t}`).join(' ')}` : '', peopleOf(m).length ? `People: ${[...new Set(peopleOf(m))].join(', ')}` : '']
    return { note: { key, title: m.title, date: dateOf(m), why: [], meetingId: m.id }, text: [...head.filter(Boolean), body].join('\n') }
  }
  const vault = vaultOf(s)
  const file = inVault(vault, key)
  if (!file) return null
  const text = await readVaultNote(file)
  if (text === null) return null
  const p = parseNote(text, basename(file))
  const cut = p.body.search(/^> \[!quote\]-? Transcript\s*$/m)
  const body = cut > 0 ? p.body.slice(0, cut) : p.body
  const target = noteTarget(key)
  const head = [p.tags.length ? `Tags: ${p.tags.map((t) => `#${t}`).join(' ')}` : '', p.people.length ? `People: ${p.people.join(', ')}` : '']
  return {
    note: { key, title: p.title, date: p.date, why: [], meetingId: target && 'meetingId' in target ? target.meetingId : undefined },
    text: [...head.filter(Boolean), body.trim()].join('\n')
  }
}

const ASK_SYSTEM = `You answer the note taker's questions about a meeting, from its notes and transcript and, when given, related notes from their own notes vault. Write plain text.

Rules:
- Use only what's in the material given. If it doesn't say, say so in a sentence, and what would tell them.
- When the question is about a topic over time, pull the notes together: what happened when, what changed, what was decided and what's still open. Go in date order when that helps.
- Say where each point comes from, with the note's title in double square brackets exactly as given, like [[2026-10-30 Billing sync]]. For the meeting itself use [[This call]], with the time from the transcript when it helps, like [[This call]] 12:40.
- "You" in the transcript is the note taker. A name ending in "?" is a guess: don't state it as fact.
- Answer first, then the detail behind it. Short paragraphs, and lines starting with "- " for lists. No headings, tables or bold. No filler.
- Never include card numbers, bank account numbers, SSNs or passwords. Refer to them generically.`

function clock(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(Math.floor(s % 60))}` : `${m}:${pad(Math.floor(s % 60))}`
}

/** The transcript as lines, the middle left out of a very long one. */
function transcriptText(m: Meeting, transcript: TranscriptSegment[]): string {
  const lines = redactLines(transcript).map((t) => `[${clock(t.start)}] ${shownName(t.speaker, m)}: ${t.text}`)
  let total = lines.reduce((n, l) => n + l.length + 1, 0)
  if (total <= TRANSCRIPT_MAX) return lines.join('\n')
  const head: string[] = []
  const tail: string[] = []
  let i = 0
  let j = lines.length - 1
  total = 0
  while (i <= j && total < TRANSCRIPT_MAX) {
    head.push(lines[i])
    total += lines[i++].length + 1
    if (i > j) break
    tail.unshift(lines[j])
    total += lines[j--].length + 1
  }
  return [...head, `[… ${j - i + 1} lines left out …]`, ...tail].join('\n')
}

/** Answers a question from the call and the notes picked (by key), carrying on from `history`. */
export async function askAbout(m: Meeting, transcript: TranscriptSegment[], question: string, keys: string[], history: AskTurn[]): Promise<AskAnswer> {
  const s = store.getSettings()
  const q = question.trim().slice(0, 2000)
  if (!q) throw new Error('Type a question first.')
  const picked: Array<{ note: RelatedNote; text: string }> = []
  let budget = NOTES_TOTAL
  for (const key of [...new Set(keys)].slice(0, MAX_NOTES)) {
    if (budget < 500) break
    const r = await readForAsk(key, s)
    if (!r) continue
    const text = clip(redact(r.text), Math.min(PER_NOTE, budget))
    budget -= text.length
    picked.push({ note: r.note, text })
  }
  // Notes with one title (a weekly meeting) get their date too, so each citation points at one of them.
  const titles = new Map<string, number>()
  for (const p of picked) titles.set(p.note.title.toLowerCase(), (titles.get(p.note.title.toLowerCase()) ?? 0) + 1)
  for (const p of picked) if (titles.get(p.note.title.toLowerCase())! > 1 && p.note.date) p.note = { ...p.note, title: `${p.note.title} (${p.note.date})` }
  const { generated, user } = splitNote(store.readNote(m.id))
  const prompt = [
    `Today: ${ymd(new Date())}`,
    '',
    `# This call: ${m.title}, ${dateOf(m)}`,
    `Invited: ${m.attendees?.length ? m.attendees.join(', ') : '(not known)'}`,
    ...(m.participants?.length ? [`In the call: ${m.participants.join(', ')}`] : []),
    ...(m.tags.length ? [`Tags: ${m.tags.map((t) => `#${t}`).join(' ')}`] : []),
    '',
    '## Notes',
    redact(`${generated}\n${user}`).trim() || '(none)',
    '',
    '## Transcript',
    transcriptText(m, transcript) || '(none yet)',
    ...(picked.length ? ['', '# Related notes', ...picked.flatMap((p) => ['', `## [[${p.note.title}]]${p.note.date ? `, ${p.note.date}` : ''}`, p.text])] : []),
    ...(history.length
      ? ['', '# Earlier in this conversation', ...history.slice(-HISTORY).flatMap((h) => [`Q: ${redact(h.question).slice(0, 2000)}`, `A: ${clip(redact(h.answer), 3000)}`, ''])]
      : []),
    '',
    '# Question',
    q
  ].join('\n')
  const t0 = Date.now()
  const { text, engine } = await answer(ASK_SYSTEM, prompt, s.summaryEngine)
  log('asked', { notes: picked.length, followUp: history.length > 0, engine, secs: Math.round((Date.now() - t0) / 1000) })
  return { answer: redact(text), engine, sources: picked.map((p) => p.note) }
}
