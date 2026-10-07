import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { speakerName, type Meeting, type Settings, type SpeakerId, type TranscriptSegment } from '@shared/types'
import { claudeExe, codexExe } from './setup'

export interface Summary {
  title: string | null
  summary: string
  decisions: string[]
  actions: Array<{ owner: string | null; task: string; due: string | null; dueDate: string | null }>
  tags: string[]
  /** Names for "Speaker N" labels, worked out from the conversation. */
  speakers: Array<{ label: string; name: string; evidence: string }>
}

// additionalProperties: false is required by Codex's structured output and harmless for Claude.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: ['string', 'null'] },
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: ['string', 'null'] },
          task: { type: 'string' },
          due: { type: ['string', 'null'] },
          dueDate: { type: ['string', 'null'] }
        },
        required: ['owner', 'task', 'due', 'dueDate']
      }
    },
    tags: { type: 'array', items: { type: 'string' } },
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, name: { type: 'string' }, evidence: { type: 'string' } },
        required: ['label', 'name', 'evidence']
      }
    }
  },
  required: ['title', 'summary', 'decisions', 'actions', 'tags', 'speakers']
}

const SYSTEM = `You write meeting notes from a transcript. Output JSON only, matching this shape:
{"title": string|null, "summary": string, "decisions": string[], "actions": [{"owner": string|null, "task": string, "due": string|null, "dueDate": string|null}], "tags": string[], "speakers": [{"label": string, "name": string, "evidence": string}]}

Rules:
- Each transcript line starts with who spoke. "You" is the note taker. Other labels are people on the call: their name when known, "Speaker 1", "Speaker 2" and so on for different people whose names aren't known, or "Others" for anyone else. Use names wherever they are known, from the labels or from the conversation.
- summary: 2 to 4 plain sentences on what was discussed and where it landed.
- decisions: things that were agreed. Empty array if none.
- actions: concrete follow-ups. owner is the person who took it on (by name when known), "Me" for the note taker, or null if unclear. due is as stated ("Tuesday", "end of month") or null. dueDate is that deadline as YYYY-MM-DD, worked out from the meeting date, or null if there is no clear date.
- If the note taker's name is given, anything assigned to that name is owned by "Me".
- speakers: for a label like "Speaker 2" (never "You" or "Others"), the person's name, but only when the conversation shows it. For example: someone asks "Did you check that last week, Andy?" and Speaker 2 is the one who answers; a speaker introduces themselves; or someone thanks or replies to a speaker by name. Prefer a name from "Invited", spelled as it is there. evidence: the cue in a few words with its time, like "[12:03] asked 'Did you check that, Andy?' and Speaker 2 answered". Leave a speaker out when the cues are weak or point different ways. Two labels may get the same name only if they're clearly the same person. Use names given here in the summary and actions too.
- "Invited" lists who the calendar invite went to; not all of them may have joined. Use it to spell names right, and to name a "Speaker" only when the conversation makes clear who it is.
- tags: 1 to 3 short lowercase topic tags, no "#", hyphens instead of spaces.
- title: a short specific title (under 60 characters) only if the current title is generic like "Teams meeting" or "New note"; otherwise null.
- The note taker's own notes are the most important signal for what mattered. Don't repeat checkboxes from their notes as actions.
- Never include card numbers, bank account numbers, SSNs or passwords. Refer to them generically.
- Be concise. No filler, no praise, no speculation beyond the transcript.`

function clock(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export interface SummaryContext {
  title: string
  meetingDate: Date
  myName: string
  speakers?: Meeting['speakers']
  attendees?: string[]
  /** Seen in the call itself (the Teams window), besides the note taker. */
  participants?: string[]
}

function buildPrompt(ctx: SummaryContext, notes: string, transcript: TranscriptSegment[]): string {
  // The note taker stays "You" even when named, so the rules above still apply.
  const label = (t: TranscriptSegment) => (t.speaker === 'you' ? 'You' : speakerName(t.speaker, ctx.speakers))
  const lines = transcript.map((t) => `[${clock(t.start)}] ${label(t)}: ${t.text}`)
  const d = ctx.meetingDate
  const date = `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return [
    `Current title: ${ctx.title}`,
    `Meeting date: ${date}`,
    `Note taker's name: ${ctx.myName.trim() || '(not given)'}`,
    `Invited: ${ctx.attendees?.length ? ctx.attendees.join(', ') : '(not known)'}`,
    ...(ctx.participants?.length ? [`In the call: ${ctx.participants.join(', ')}`] : []),
    '',
    "Note taker's notes:",
    notes.trim() || '(none)',
    '',
    'Transcript:',
    lines.join('\n') || '(empty)'
  ].join('\n')
}

export type Engine = 'claude' | 'codex'

const ENGINE_NAME: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Signed-out and expired sessions: worth trying the other engine instead of retrying. */
const AUTH_ERROR = /not logged in|not signed in|sign in again|log out and sign in|invalid_refresh_token|unauthorized|\b401\b|please run .*login/i
const TRANSIENT = /refresh|overloaded|rate limit|timeout|timed out|ECONNRESET|stream disconnected|529|503/i

class AuthError extends Error {}

/** Runs from an empty folder so no project instructions or settings get pulled in. */
export function emptyDir(name: string): string {
  const dir = join(tmpdir(), name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Quotes args for cmd.exe when an npm .cmd shim has to be run through the shell. */
function shellQuote(args: string[]): string[] {
  return args.map((a) => (a === '' ? '""' : `"${a.replace(/"/g, '\\"')}"`))
}

export function run(exe: string, args: string[], input: string, cwd: string, timeout = 5 * 60_000): Promise<{ stdout: string; stderr: string }> {
  const isCmd = exe.endsWith('.cmd')
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      isCmd ? shellQuote(args) : args,
      { cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, shell: isCmd },
      (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return reject(err)
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
    child.stdin?.end(input)
  })
}

async function runClaude(prompt: string): Promise<Summary> {
  const exe = claudeExe()
  if (!exe) throw new AuthError('Claude Code is not installed.')
  const args = [
    '-p',
    '--model', 'sonnet',
    '--output-format', 'json',
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', SYSTEM
  ]
  // JSON on a cmd.exe command line gets mangled; the prompt alone is enough there.
  if (!exe.endsWith('.cmd')) args.push('--json-schema', JSON.stringify(SCHEMA))
  const { stdout } = await run(exe, args, prompt, emptyDir('kasha-claude'))
  const envelope = JSON.parse(stdout)
  if (envelope.is_error) {
    const msg = String(envelope.result ?? 'Claude returned an error.')
    // A token refresh clash with another running Claude Code process is transient, not signed out.
    if (AUTH_ERROR.test(msg) && !/another claude code process/i.test(msg)) throw new AuthError(msg)
    throw new Error(msg)
  }
  if (envelope.structured_output) return envelope.structured_output as Summary
  return JSON.parse(String(envelope.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '')) as Summary
}

async function runCodex(prompt: string): Promise<Summary> {
  const exe = codexExe()
  if (!exe) throw new AuthError('Codex is not installed.')
  const dir = emptyDir('kasha-codex')
  const schemaFile = join(dir, 'schema.json')
  const outFile = join(dir, `out-${Date.now()}.json`)
  writeFileSync(schemaFile, JSON.stringify(SCHEMA))
  // Codex is an agent: its shell tool is switched off and it runs read-only, so it
  // only writes the summary. It has no system prompt flag, so the rules lead the prompt.
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--disable', 'shell_tool',
    '-c', 'mcp_servers={}',
    '-c', 'model_reasoning_effort="low"',
    '--color', 'never',
    '--cd', dir,
    '--output-schema', schemaFile,
    '--output-last-message', outFile,
    '-'
  ]
  try {
    const input = `${SYSTEM}\n- Do not run commands or use tools. Reply with the JSON only.\n\n${prompt}`
    const { stderr } = await run(exe, args, input, dir)
    const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : ''
    if (!text) {
      const last = stderr.trim().split('\n').filter(Boolean).pop() ?? 'Codex returned no summary.'
      if (AUTH_ERROR.test(stderr)) throw new AuthError(last)
      throw new Error(last)
    }
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Summary
  } finally {
    rmSync(outFile, { force: true })
  }
}

const RUNNERS: Record<Engine, (prompt: string) => Promise<Summary>> = { claude: runClaude, codex: runCodex }

/** Engines to try, in order. Automatic prefers Claude Code and falls back to Codex. */
function engineOrder(choice: Settings['summaryEngine']): Engine[] {
  if (choice === 'claude') return ['claude']
  if (choice === 'codex') return ['codex']
  return (['claude', 'codex'] as Engine[]).filter((e) => (e === 'claude' ? claudeExe() : codexExe()))
}

async function withRetries(engine: Engine, prompt: string): Promise<Summary> {
  let lastErr: Error = new Error('Summary failed.')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await RUNNERS[engine](prompt)
    } catch (e) {
      lastErr = e as Error
      if (lastErr instanceof AuthError || !TRANSIENT.test(lastErr.message)) break
      await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)))
    }
  }
  throw lastErr
}

export async function summarize(
  ctx: SummaryContext,
  notes: string,
  transcript: TranscriptSegment[],
  choice: Settings['summaryEngine'] = 'auto'
): Promise<Summary & { engine: Engine }> {
  const order = engineOrder(choice)
  if (!order.length) {
    throw new Error('No summary engine found. Install Claude Code or Codex and sign in, then select Retry.')
  }
  const prompt = buildPrompt(ctx, notes, transcript)
  let lastErr: Error | null = null
  for (const engine of order) {
    try {
      const s = await withRetries(engine, prompt)
      return {
        engine,
        title: s.title?.trim() || null,
        summary: s.summary?.trim() ?? '',
        decisions: s.decisions ?? [],
        actions: (s.actions ?? []).map((a) => ({
          ...a,
          dueDate: a.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate) ? a.dueDate : null
        })),
        tags: (s.tags ?? []).map((t) => t.toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).slice(0, 3),
        speakers: Array.isArray(s.speakers) ? s.speakers : []
      }
    } catch (e) {
      lastErr = e as Error
      // Only a sign-in problem moves on to the next engine; other errors are reported as is.
      if (!(lastErr instanceof AuthError)) break
    }
  }
  if (lastErr instanceof AuthError) {
    const names = order.map((e) => ENGINE_NAME[e]).join(' or ')
    const how = order.map((e) => (e === 'claude' ? '"claude"' : '"codex login"')).join(' or ')
    throw new Error(`${names} needs you to sign in. Run ${how} in a terminal, then select Retry.`)
  }
  throw lastErr ?? new Error('Summary failed.')
}

const normalize = (t: string) =>
  t
    .toLowerCase()
    .replace(/^me:\s*/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Markdown for the top of the note. The user's own notes follow under "Your notes".
 * Actions the user already wrote as checkboxes are left out so they don't appear twice.
 */
/**
 * Turns the summary's speaker names into guesses for this meeting: only for
 * "Speaker N" labels that are still unnamed, so a name the user gave always wins.
 */
export function speakerGuesses(
  s: Pick<Summary, 'speakers'>,
  transcript: TranscriptSegment[],
  known: Meeting['speakers']
): { names: NonNullable<Meeting['speakers']>; guesses: NonNullable<Meeting['speakerGuesses']> } {
  const byLabel = new Map<string, SpeakerId>()
  for (const t of transcript) {
    if (/^s\d+$/.test(t.speaker) && !known?.[t.speaker]?.trim()) byLabel.set(speakerName(t.speaker).toLowerCase(), t.speaker)
  }
  const names: NonNullable<Meeting['speakers']> = {}
  const guesses: NonNullable<Meeting['speakerGuesses']> = {}
  for (const g of Array.isArray(s.speakers) ? s.speakers : []) {
    const id = byLabel.get(String(g?.label ?? '').trim().toLowerCase())
    const name = String(g?.name ?? '').trim().slice(0, 60)
    if (!id || !name || /^(you|me|others|speaker \d+|unknown)$/i.test(name)) continue
    names[id] = name
    guesses[id] = { evidence: String(g.evidence ?? '').trim().slice(0, 300) }
  }
  return { names, guesses }
}

export function summaryMarkdown(s: Summary, userNotes = ''): string {
  const existing = new Set(
    Array.from(userNotes.matchAll(/^\s*[-*+] \[[ xX]\] (.+)$/gm), (m) => normalize(m[1]))
  )
  s = { ...s, actions: s.actions.filter((a) => !existing.has(normalize(a.task))) }
  const out: string[] = ['## Summary', '', s.summary, '']
  if (s.decisions.length) out.push('## Decisions', '', ...s.decisions.map((d) => `- ${d}`), '')
  if (s.actions.length) {
    out.push('## Actions', '')
    for (const a of s.actions) {
      const owner = a.owner ? `${a.owner}: ` : ''
      // An ISO date keeps the deadline machine-readable for the Actions view.
      const due = a.dueDate ? ` (due ${a.dueDate})` : a.due ? ` (${a.due})` : ''
      out.push(`- [ ] ${owner}${a.task}${due}`)
    }
    out.push('')
  }
  return out.join('\n')
}

const GENERATED = /^## (Summary|Decisions|Actions)\s*$/

/**
 * Splits a note into the sections Kasha wrote (Summary, Decisions, Actions at
 * the top) and the user's own notes, so the summary can be rewritten without
 * touching what they wrote.
 */
export function splitNote(note: string): { generated: string; user: string } {
  const lines = note.replace(/\r\n/g, '\n').split('\n')
  if (!/^## Summary\s*$/.test(lines[0] ?? '')) return { generated: '', user: note }
  let i = 1
  while (i < lines.length && !(/^#{1,6} /.test(lines[i]) && !GENERATED.test(lines[i]))) i++
  return {
    generated: lines.slice(0, i).join('\n'),
    user: lines.slice(i).join('\n').replace(/^## Your notes\s*\n+/, '')
  }
}

/** Keeps actions ticked when a rewritten summary lists them again. */
export function carryChecks(oldGenerated: string, markdown: string): string {
  const done = new Set(Array.from(oldGenerated.matchAll(/^\s*[-*+] \[[xX]\] (.+)$/gm), (m) => normalize(m[1])))
  if (!done.size) return markdown
  return markdown.replace(/^(\s*[-*+]) \[ \] (.+)$/gm, (line, bullet: string, text: string) =>
    done.has(normalize(text)) ? `${bullet} [x] ${text}` : line
  )
}
