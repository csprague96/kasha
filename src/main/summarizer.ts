import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptSegment } from '@shared/types'
import { claudeExe } from './setup'

export interface Summary {
  title: string | null
  summary: string
  decisions: string[]
  actions: Array<{ owner: string | null; task: string; due: string | null; dueDate: string | null }>
  tags: string[]
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          owner: { type: ['string', 'null'] },
          task: { type: 'string' },
          due: { type: ['string', 'null'] },
          dueDate: { type: ['string', 'null'] }
        },
        required: ['owner', 'task', 'due', 'dueDate']
      }
    },
    tags: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'summary', 'decisions', 'actions', 'tags']
}

const SYSTEM = `You write meeting notes from a transcript. Output JSON only, matching this shape:
{"title": string|null, "summary": string, "decisions": string[], "actions": [{"owner": string|null, "task": string, "due": string|null, "dueDate": string|null}], "tags": string[]}

Rules:
- "You" in the transcript is the note taker. "Others" is everyone else on the call; use real names only when someone is named in the conversation.
- summary: 2 to 4 plain sentences on what was discussed and where it landed.
- decisions: things that were agreed. Empty array if none.
- actions: concrete follow-ups. owner is a name, "Me" for the note taker, or null if unclear. due is as stated ("Tuesday", "end of month") or null. dueDate is that deadline as YYYY-MM-DD, worked out from the meeting date, or null if there is no clear date.
- If the note taker's name is given, anything assigned to that name is owned by "Me".
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
}

function buildPrompt(ctx: SummaryContext, notes: string, transcript: TranscriptSegment[]): string {
  const lines = transcript.map((t) => `[${clock(t.start)}] ${t.speaker === 'you' ? 'You' : 'Others'}: ${t.text}`)
  const d = ctx.meetingDate
  const date = `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return [
    `Current title: ${ctx.title}`,
    `Meeting date: ${date}`,
    `Note taker's name: ${ctx.myName.trim() || '(not given)'}`,
    '',
    "Note taker's notes:",
    notes.trim() || '(none)',
    '',
    'Transcript:',
    lines.join('\n') || '(empty)'
  ].join('\n')
}

function runClaude(exe: string, prompt: string): Promise<string> {
  // Run from an empty folder so no project CLAUDE.md or settings get pulled in.
  const cwd = join(tmpdir(), 'kasha-claude')
  mkdirSync(cwd, { recursive: true })
  const isCmd = exe.endsWith('.cmd')
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
  if (!isCmd) args.push('--json-schema', JSON.stringify(SCHEMA))
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      isCmd ? args.map((a) => (a === '' ? '""' : `"${a.replace(/"/g, '\\"')}"`)) : args,
      { cwd, windowsHide: true, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, shell: isCmd },
      (err, stdout) => {
        if (err && !stdout) return reject(err)
        resolve(stdout)
      }
    )
    child.stdin?.end(prompt)
  })
}

function parse(stdout: string): Summary {
  const envelope = JSON.parse(stdout)
  if (envelope.is_error) throw new Error(String(envelope.result ?? 'Claude returned an error.'))
  if (envelope.structured_output) return envelope.structured_output as Summary
  const text = String(envelope.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '')
  return JSON.parse(text) as Summary
}

const TRANSIENT = /refresh|overloaded|rate limit|timeout|ECONNRESET|529|503/i

export async function summarize(ctx: SummaryContext, notes: string, transcript: TranscriptSegment[]): Promise<Summary> {
  const exe = claudeExe()
  if (!exe) throw new Error('Claude Code is not installed. Install it, then select Retry.')
  const prompt = buildPrompt(ctx, notes, transcript)
  let lastErr: Error = new Error('Summary failed.')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const s = parse(await runClaude(exe, prompt))
      return {
        title: s.title?.trim() || null,
        summary: s.summary?.trim() ?? '',
        decisions: s.decisions ?? [],
        actions: (s.actions ?? []).map((a) => ({
          ...a,
          dueDate: a.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate) ? a.dueDate : null
        })),
        tags: (s.tags ?? []).map((t) => t.toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).slice(0, 3)
      }
    } catch (e) {
      lastErr = e as Error
      if (!TRANSIENT.test(lastErr.message)) break
      await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)))
    }
  }
  if (/not logged in|login|auth/i.test(lastErr.message) && !/refresh/i.test(lastErr.message)) {
    throw new Error('Claude Code is not signed in. Run "claude" in a terminal to sign in, then select Retry.')
  }
  throw lastErr
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
