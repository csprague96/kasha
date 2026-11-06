import { GENERIC_TITLE, normName, type Meeting, type SpeakerId, type TranscriptSegment } from './types'

/**
 * Combining notes: a call cut off, or left and rejoined, ends up as two or
 * more notes. Combined, they're one note with one transcript and one summary,
 * kept in the earliest. Each later part's lines follow on from the end of the
 * part before: from its recording, not the clock, so the time between them
 * isn't stored as silence.
 */

/** One note ending and the next starting this close together, with the same title, looks like one call. */
export const REJOIN_GAP_MS = 30 * 60_000

export const startOf = (m: Meeting) => Date.parse(m.recordingStartedAt ?? m.createdAt)
const endOf = (m: Meeting) => (m.recordingEndedAt ? Date.parse(m.recordingEndedAt) : startOf(m))

/** Only finished notes are combined: nothing is still writing to them. */
export const canCombine = (m: Meeting) => m.status === 'ready'

/** Whether two notes look like parts of one call: the same title, and the second started soon after the first ended. */
export function sameCall(a: Meeting, b: Meeting): boolean {
  if (a.id === b.id || !canCombine(a) || !canCombine(b)) return false
  if (a.notSameCall?.includes(b.id) || b.notSameCall?.includes(a.id)) return false
  // "Teams meeting" says nothing about which call it was.
  const titles = (m: Meeting) => [m.title, m.detectedTitle].filter((t): t is string => !!t?.trim() && !GENERIC_TITLE.test(t.trim())).map(normName)
  const theirs = titles(b)
  if (!titles(a).some((t) => theirs.includes(t))) return false
  const [first, second] = startOf(a) <= startOf(b) ? [a, b] : [b, a]
  const gap = startOf(second) - endOf(first)
  return gap > -60_000 && gap <= REJOIN_GAP_MS
}

type Who = Pick<Meeting, 'speakers' | 'speakerGuesses'>

/** A name the user gave or confirmed. Guesses don't count: two guesses alike aren't proof of one person. */
const confirmed = (m: Who, id: SpeakerId) => (m.speakerGuesses?.[id] ? '' : (m.speakers?.[id]?.trim() ?? ''))

export interface Joined {
  transcript: TranscriptSegment[]
  speakers: NonNullable<Meeting['speakers']>
  speakerGuesses: NonNullable<Meeting['speakerGuesses']>
  /** The later part's speakers, by the ids they have in the combined note. */
  ids: Partial<Record<SpeakerId, SpeakerId>>
}

/**
 * The later part's lines after the earlier part's, `offset` seconds in. You
 * stays You. Someone named the same in both (by the user, not guessed) is one
 * speaker; everyone else in the later part gets a new number, since Speaker 1
 * there needn't be Speaker 1 here.
 */
export function joinTranscripts(
  a: Who & { transcript: TranscriptSegment[] },
  b: Who & { transcript: TranscriptSegment[] },
  offset: number
): Joined {
  const theirs: SpeakerId[] = []
  for (const id of [...b.transcript.map((s) => s.speaker), ...(Object.keys(b.speakers ?? {}) as SpeakerId[])]) if (!theirs.includes(id)) theirs.push(id)
  const ours = new Set<SpeakerId>([...a.transcript.map((s) => s.speaker), ...(Object.keys(a.speakers ?? {}) as SpeakerId[])])
  let next = 1 + Math.max(0, ...[...ours].map((id) => Number(/^s(\d+)$/.exec(id)?.[1] ?? 0)))

  const speakers = { ...a.speakers }
  const speakerGuesses = { ...a.speakerGuesses }
  const ids: Joined['ids'] = {}
  for (const id of theirs) {
    if (id === 'you') {
      ids.you = 'you'
      continue
    }
    const name = normName(confirmed(b, id))
    const same = name ? [...ours].find((o) => o !== 'you' && normName(confirmed(a, o)) === name) : undefined
    if (same) {
      ids[id] = same
      continue
    }
    // Others, never told apart or named in either part, stays Others.
    if (id === 'others' && !b.speakers?.others?.trim() && !a.speakers?.others?.trim()) {
      ids.others = 'others'
      continue
    }
    // Ids stop at s99: past that, they're Others (a call that big has bigger problems).
    const to: SpeakerId = next <= 99 ? `s${next++}` : 'others'
    ids[id] = to
    if (to === 'others') continue
    const given = b.speakers?.[id]
    if (given) speakers[to] = given
    const guess = b.speakerGuesses?.[id]
    if (guess) speakerGuesses[to] = guess
  }

  const later = b.transcript.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset, speaker: ids[s.speaker] ?? s.speaker }))
  return { transcript: [...a.transcript, ...later], speakers, speakerGuesses, ids }
}

/**
 * The combined note: both summaries (until it's written again from the whole
 * call; a ticked action in either stays ticked), then the user's own notes,
 * the later part's under a line saying when it began.
 */
export function joinNotes(a: { generated: string; user: string }, b: { generated: string; user: string }, rejoined: string): string {
  const generated = [a.generated.trim(), b.generated.trim()].filter(Boolean).join('\n\n')
  const later = b.user.trim() ? `### Rejoined at ${rejoined}\n\n${b.user.trim()}` : ''
  const user = [a.user.trim(), later].filter(Boolean).join('\n\n')
  if (!generated) return user ? `${user}\n` : ''
  return `${generated}\n${user ? `\n## Your notes\n\n${user}\n` : ''}`
}
