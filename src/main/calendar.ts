import type { CalendarMatch } from '@shared/types'
import { claudeExe } from './setup'
import { emptyDir, run } from './summarizer'

/**
 * Finds the call in the user's Outlook calendar, for its invite list. There's
 * no calendar access of Kasha's own: this asks Claude Code, which uses the
 * Microsoft 365 connector the user already has on their Claude account. Only
 * the time and the window title are sent; the reply is names only.
 *
 * Costs one short Haiku run (~10 s). Returns null when the connector isn't
 * there, nothing matches, or anything goes wrong.
 */

const TOOL = 'mcp__claude_ai_Microsoft_365__outlook_calendar_search'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    subject: { type: ['string', 'null'] },
    recurring: { type: 'boolean' },
    attendees: { type: 'array', items: { type: 'string' } }
  },
  required: ['found', 'subject', 'recurring', 'attendees']
}

const SYSTEM = `You find the meeting the user is in right now in their Outlook calendar, using the calendar search tool, and reply with JSON only:
{"found": boolean, "subject": string|null, "recurring": boolean, "attendees": string[]}
- attendees: display names of everyone invited, including the organizer, excluding the user. Names only, never email addresses.
- recurring: true if the event is an occurrence of a recurring series.
- If no event fits, found is false and attendees is empty.
- Don't use any other tool. Don't explain.`

const p2 = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const localTime = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`

function prompt(title: string, at: Date): string {
  const tomorrow = new Date(at.getTime() + 86_400_000)
  return [
    `Local time now: ${localDate(at)} ${localTime(at)} (${at.toLocaleDateString('en-GB', { weekday: 'long' })}).`,
    `The meeting app's window title: "${title.replace(/"/g, "'")}". It may be the meeting subject, the other person's name on a 1:1 call, or something generic like "Teams meeting".`,
    `Search with query "*", afterDateTime "${localDate(at)}T00:00:00", beforeDateTime "${localDate(tomorrow)}T00:00:00", order "oldest", limit 25. Fetch the next page if there is one.`,
    `Pick the event the user is in now: it starts no more than 15 minutes after ${localTime(at)} and ends after ${localTime(at)}, in the times the tool returns. If several fit, prefer the one whose subject matches the window title, then the one that started most recently. Ignore cancelled events.`
  ].join('\n')
}

export async function lookupMeeting(title: string, at = new Date()): Promise<CalendarMatch | null> {
  const exe = claudeExe()
  if (!exe) return null
  const args = [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    // Connector tools are found through ToolSearch; nothing else is available.
    '--tools', 'ToolSearch',
    '--allowedTools', TOOL,
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', SYSTEM
  ]
  if (!exe.endsWith('.cmd')) args.push('--json-schema', JSON.stringify(SCHEMA))
  try {
    const { stdout } = await run(exe, args, prompt(title, at), emptyDir('kasha-claude'), 90_000)
    const envelope = JSON.parse(stdout)
    if (envelope.is_error) return null
    const r = (envelope.structured_output ??
      JSON.parse(String(envelope.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, ''))) as {
      found: boolean
      subject: string | null
      recurring: boolean
      attendees: unknown[]
    }
    if (!r?.found) return null
    const attendees = (Array.isArray(r.attendees) ? r.attendees : [])
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.trim().slice(0, 80))
      .filter((a) => a && !a.includes('@'))
      .slice(0, 60)
    return { subject: r.subject?.trim().slice(0, 200) || null, recurring: !!r.recurring, attendees }
  } catch (e) {
    console.error('calendar:', (e as Error).message)
    return null
  }
}
