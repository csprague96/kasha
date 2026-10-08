import { normName, speakerName, type Meeting, type SpeakerId, type TranscriptSegment } from './types'

/**
 * Who was at a meeting, worked out from the invite list and who was heard on
 * the recording. "Not heard" is as far as a recording can tell: someone who
 * listened without speaking looks the same as someone who never joined, so
 * the user can mark people by hand.
 */

export interface AttendeeRow {
  name: string
  /** On the invite list (from Outlook, or added by hand). */
  invited: boolean
  /** The transcript speaker this person was heard as, if any. */
  speaker?: SpeakerId
  /** The speaker's name was guessed from the conversation and not confirmed yet. */
  guessed: boolean
  seconds: number // time spent talking
  /** Seen in the call in the Teams window, spoken or not. */
  inCall: boolean
  lines: number
  present: boolean
  /** The user set present or absent by hand. */
  manual: boolean
}

/** Key for by-hand marks: the same person however their name is capitalised or spaced. */
export const attendanceKey = (name: string): string => normName(name)

const firstName = (name: string) => normName(name).split(' ')[0]

export function attendance(m: Meeting, transcript: TranscriptSegment[], myName: string): AttendeeRow[] {
  const talk = new Map<SpeakerId, { seconds: number; lines: number }>()
  for (const s of transcript) {
    const t = talk.get(s.speaker) ?? { seconds: 0, lines: 0 }
    t.seconds += Math.max(0, s.end - s.start)
    t.lines++
    talk.set(s.speaker, t)
  }
  const speakers = [...talk.keys()]
  const nameFor = (id: SpeakerId) => (id === 'you' ? m.speakers?.you?.trim() || myName.trim() || 'You' : speakerName(id, m.speakers))
  const marks = m.attendance ?? {}
  const invited = m.attendees ?? []
  const inCall = new Set((m.participants ?? []).map(normName))
  const used = new Set<SpeakerId>()

  const matchSpeaker = (name: string): SpeakerId | undefined => {
    const key = normName(name)
    let hit = speakers.find((id) => !used.has(id) && normName(nameFor(id)) === key)
    if (!hit) {
      // A speaker named just "Sam" is the invitee "Sam Lee", as long as only one Sam was invited.
      hit = speakers.find((id) => {
        if (used.has(id) || id === 'others') return false
        const n = normName(nameFor(id))
        return n !== '' && !n.includes(' ') && n === firstName(name) && invited.filter((a) => firstName(a) === n).length === 1
      })
    }
    return hit
  }

  const rows: AttendeeRow[] = []
  for (const name of invited) {
    const speaker = matchSpeaker(name)
    if (speaker) used.add(speaker)
    const t = (speaker && talk.get(speaker)) || { seconds: 0, lines: 0 }
    const mark = marks[attendanceKey(name)]
    rows.push({
      name,
      invited: true,
      speaker,
      guessed: !!(speaker && m.speakerGuesses?.[speaker]),
      ...t,
      inCall: inCall.has(normName(name)),
      present: mark ? mark === 'present' : !!speaker || inCall.has(normName(name)),
      manual: !!mark
    })
  }
  // Heard but not on the list: named people, unnamed speakers, and "Others" when speakers weren't told apart.
  const extra: AttendeeRow[] = []
  for (const speaker of speakers) {
    if (used.has(speaker)) continue
    const name = nameFor(speaker)
    const mark = marks[attendanceKey(name)]
    extra.push({
      name,
      invited: false,
      speaker,
      guessed: !!m.speakerGuesses?.[speaker],
      ...talk.get(speaker)!,
      inCall: inCall.has(normName(name)),
      present: mark ? mark === 'present' : true,
      manual: !!mark
    })
  }
  // In the call but neither invited nor heard: they listened.
  const listed = new Set([...rows, ...extra].map((r) => normName(r.name)))
  for (const name of m.participants ?? []) {
    if (listed.has(normName(name))) continue
    listed.add(normName(name))
    const mark = marks[attendanceKey(name)]
    extra.push({ name, invited: false, guessed: false, seconds: 0, lines: 0, inCall: true, present: mark ? mark === 'present' : true, manual: !!mark })
  }
  extra.sort((a, b) => Number(b.speaker === 'you') - Number(a.speaker === 'you') || b.seconds - a.seconds)
  return [...rows, ...extra]
}

/** Names for exports: who was there and who was invited but not heard. The note taker is left out unless named. */
export function attendanceSummary(rows: AttendeeRow[]): { present: string[]; absent: string[] } {
  const named = rows.filter((r) => r.name !== 'You' && !/^(Others|Speaker \d+)$/.test(r.name))
  // A guessed name the user hasn't confirmed keeps its question mark.
  const label = (r: AttendeeRow) => (r.guessed ? `${r.name}?` : r.name)
  return {
    present: named.filter((r) => r.present).map(label),
    absent: named.filter((r) => !r.present).map((r) => r.name)
  }
}
