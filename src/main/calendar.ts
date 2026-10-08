import { normName, type CalendarMatch } from '@shared/types'
import { claudeExe } from './setup'
import { log } from './log'
import { emptyDir, run } from './summarizer'

/**
 * Finds the call in the user's Outlook calendar, for its invite list. There's
 * no calendar access of Kasha's own: this asks Claude Code, which uses the
 * Microsoft 365 connector the user already has on their Claude account. Only
 * the time is sent. Claude lists the events around now, and Kasha picks the
 * one in progress itself, which is more reliable than asking the model to.
 *
 * Costs one short Haiku run (~20 s). Returns null when the connector isn't
 * there, nothing matches, or anything goes wrong.
 */

const TOOL = 'mcp__claude_ai_Microsoft_365__outlook_calendar_search'

export interface CalendarEvent {
  subject: string | null
  start: string
  end: string
  timeZone: string | null
  recurring: boolean
  cancelled: boolean
  /** Older replies were plain strings. */
  attendees: Array<Attendee | string>
}

interface Attendee {
  name: string | null
  email: string | null
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: ['string', 'null'] },
          start: { type: 'string' },
          end: { type: 'string' },
          timeZone: { type: ['string', 'null'] },
          recurring: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          attendees: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: ['string', 'null'] }, email: { type: ['string', 'null'] } },
              required: ['name', 'email']
            }
          }
        },
        required: ['subject', 'start', 'end', 'timeZone', 'recurring', 'cancelled', 'attendees']
      }
    }
  },
  required: ['events']
}

const READ = 'mcp__claude_ai_Microsoft_365__read_resource'

const SYSTEM = `You look up events in the user's Outlook calendar and reply with JSON only:
{"events": [{"subject": string|null, "start": string, "end": string, "timeZone": string|null, "recurring": boolean, "cancelled": boolean, "attendees": [{"name": string|null, "email": string|null}]}]}
Steps:
1. Search with the calendar search tool, using exactly the arguments given. The calendar tools can take a few seconds to connect: if ToolSearch doesn't find them, search for them again. Only ever call tools for real; never write a tool call out as text, and never answer without having searched.
2. For each event the user gives a time window for, read its full details with read_resource on the event's URI. Search results don't list everyone invited; the full details do.
3. Reply with those events only.
Fields:
- start and end: the dateTime values exactly as the tools return them; timeZone: the timeZone given with them.
- recurring: true if the event is an occurrence of a recurring series. cancelled: true if it's cancelled.
- attendees: everyone invited, including the organizer, from the full details. name: the person's display name exactly as the details give it (null if there is none); email: their address.
Find tools with ToolSearch. Use only the calendar search and read_resource tools. Never look people up. Don't explain.`

const p2 = (n: number) => String(n).padStart(2, '0')
const wall = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`
const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`

function prompt(at: Date): string {
  const from = new Date(at.getTime() - 4 * 3600_000)
  const to = new Date(at.getTime() + 4 * 3600_000)
  const soon = new Date(at.getTime() + 15 * 60_000)
  return [
    `Search arguments: query "*", afterDateTime "${wall(from)}", beforeDateTime "${wall(to)}", order "oldest", limit 25.`,
    `Time window: events that start at or before ${wall(soon).slice(0, 16)} and end after ${wall(new Date(at.getTime() - 30 * 60_000)).slice(0, 16)} (local wall-clock, ${hm(at)} now; meetings run over), and aren't cancelled. Read the full details of those and list them.`
  ].join('\n')
}

/** The tool gives wall-clock times in the mailbox's zone, or UTC. The mailbox is taken to be in this PC's zone. */
function parseTime(s: string, zone: string | null): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (!m) return NaN
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s)
  if (zone && /^(utc|gmt|coordinated universal time)$/i.test(zone.trim())) return Date.UTC(y, mo - 1, d, h, mi)
  return new Date(y, mo - 1, d, h, mi).getTime()
}

/**
 * The event the user is in at `at`: started (or starts within 15 minutes) and
 * not yet over. Prefers the one whose subject matches the window title, then
 * the one that started most recently.
 */
export function pickEvent(events: CalendarEvent[], title: string, at: Date): CalendarEvent | null {
  const now = at.getTime()
  const live = events.filter((e) => {
    const start = parseTime(e.start, e.timeZone)
    const end = parseTime(e.end, e.timeZone)
    return !e.cancelled && start <= now + 15 * 60_000 && end > now
  })
  const sameTitle = live.filter((e) => e.subject && normName(e.subject) === normName(title))
  // A meeting already under way beats one about to start: for an ad-hoc call,
  // the next meeting's invite list would be the wrong people.
  const started = live.filter((e) => parseTime(e.start, e.timeZone) <= now)
  const pool = sameTitle.length ? sameTitle : started.length ? started : live
  const current = pool.sort((a, b) => parseTime(b.start, b.timeZone) - parseTime(a.start, a.timeZone))[0]
  if (current) return current
  // Nothing scheduled now: meetings run over, so take one that ended in the last half hour.
  const overran = events.filter((e) => {
    const end = parseTime(e.end, e.timeZone)
    return !e.cancelled && end <= now && end > now - 30 * 60_000
  })
  return overran.sort((a, b) => parseTime(b.end, b.timeZone) - parseTime(a.end, a.timeZone))[0] ?? null
}

/**
 * A person's name from how the invite lists them: an address like
 * "sam.lee@…" becomes "Sam Lee". An address that doesn't spell a name
 * ("slee@…") is kept as it is, lower-cased; after a Teams call it's swapped
 * for the matching name from the meeting window (see roster.ts).
 */
export function nameOf(entry: string): string {
  const named = entry.replace(/\s*<[^>]*>\s*$/, '').trim()
  if (named && !named.includes('@')) return named
  const local = named.split('@')[0]
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]{2,}$/i.test(p))
  if (parts.length < 2 || parts.length > 3) return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(named) ? named.toLowerCase() : ''
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ')
}

/** Events around `at` in the user's calendar, or null if Claude Code or the connector can't be reached. */
export async function fetchEvents(at = new Date()): Promise<CalendarEvent[] | null> {
  const exe = claudeExe()
  if (!exe) return null
  const args = [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    // Connector tools are found through ToolSearch; nothing else is available.
    '--tools', 'ToolSearch',
    '--allowedTools', TOOL, READ,
    // claude.ai connectors only load with the user's settings. Running in an
    // empty folder keeps any project settings out.
    '--setting-sources', 'user,project,local',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', SYSTEM
  ]
  if (!exe.endsWith('.cmd')) args.push('--json-schema', JSON.stringify(SCHEMA))
  // Each run is a fresh Claude Code, whose claude.ai connectors connect a few
  // seconds after it starts. A model that answers before then never really
  // searched: it writes tool calls out as text and returns nothing. A real
  // lookup takes at least three turns (find the tool, search, read), so a
  // shorter one is tried again.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await run(exe, args, prompt(at), emptyDir('kasha-claude'), 120_000)
      const envelope = JSON.parse(stdout)
      if (envelope.is_error) return null
      if (typeof envelope.num_turns === 'number' && envelope.num_turns < 3) {
        log('calendar-retry', { attempt, turns: envelope.num_turns })
        await new Promise((r) => setTimeout(r, 4000))
        continue
      }
      const r = (envelope.structured_output ??
        JSON.parse(String(envelope.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, ''))) as { events?: CalendarEvent[] }
      return Array.isArray(r?.events) ? r.events : []
    } catch (e) {
      console.error('calendar:', (e as Error).message)
      log('calendar-failed', { error: (e as Error).message.slice(0, 200) })
      return null
    }
  }
  return null
}

/**
 * The display name; else one worked out from the address. Addresses like
 * cbalino@ give no name, which is why the display name is asked for: with
 * addresses alone every attendee was dropped.
 */
function attendeeName(a: Attendee | string | null): string {
  if (typeof a === 'string') return nameOf(a.trim())
  if (!a || typeof a !== 'object') return ''
  const name = typeof a.name === 'string' ? a.name.trim() : ''
  if (name && !name.includes('@')) return name
  return nameOf((typeof a.email === 'string' ? a.email : name).trim())
}

export async function lookupMeeting(title: string, at = new Date()): Promise<CalendarMatch | null> {
  const t0 = Date.now()
  const events = await fetchEvents(at)
  const event = events && pickEvent(events, title, at)
  log('calendar', { events: events?.length ?? 'error', matched: !!event, secs: Math.round((Date.now() - t0) / 1000) })
  if (!event) return null
  const attendees = Array.from(
    new Set(
      (Array.isArray(event.attendees) ? event.attendees : [])
        .map(attendeeName)
        .map((a) => a.slice(0, 80))
        .filter(Boolean)
    )
  ).slice(0, 60)
  return { subject: event.subject?.trim().slice(0, 200) || null, recurring: !!event.recurring, attendees }
}
