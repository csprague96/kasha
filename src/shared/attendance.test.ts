import { describe, expect, it } from 'vitest'
import { attendance, attendanceSummary } from './attendance'
import { shownName, type Meeting, type TranscriptSegment } from './types'

const seg = (speaker: TranscriptSegment['speaker'], start: number, end: number): TranscriptSegment => ({ speaker, start, end, text: 'x' })
const meeting = (patch: Partial<Meeting>): Meeting => ({
  id: 'x',
  title: 't',
  app: 'teams',
  createdAt: '',
  status: 'ready',
  tags: [],
  sync: { state: 'not-synced' },
  ...patch
})

describe('guessed names', () => {
  const m = meeting({ speakers: { s1: 'Ann A', s2: 'Bob B' }, speakerGuesses: { s1: { evidence: 'x' } } })

  it('keep their question mark in notes and exports', () => {
    expect(shownName('s1', m)).toBe('Ann A?')
    expect(shownName('s2', m)).toBe('Bob B')
    expect(shownName('s3', m)).toBe('Speaker 3')
  })

  it('are marked in the attendee list', () => {
    const sum = attendanceSummary(attendance(m, [seg('s1', 0, 10), seg('s2', 10, 20)], ''))
    expect(sum.present).toEqual(expect.arrayContaining(['Ann A?', 'Bob B']))
  })
})

describe('attendance', () => {
  it('counts people seen in the Teams call as present, spoken or not', () => {
    const m = meeting({ attendees: ['Ann A', 'Dee D'], participants: ['Ann A', 'Bob B', 'Eve E'], speakers: { s1: 'Bob B' } })
    const rows = attendance(m, [seg('s1', 0, 10)], 'Me')
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(by['Ann A']).toMatchObject({ invited: true, inCall: true, present: true })
    expect(by['Dee D']).toMatchObject({ invited: true, inCall: false, present: false })
    expect(by['Bob B']).toMatchObject({ invited: false, speaker: 's1', present: true })
    expect(by['Eve E']).toMatchObject({ inCall: true, present: true })
  })

  it('ties the note taker’s invite to You', () => {
    const rows = attendance(meeting({ attendees: ['Me Self', 'Ann A'] }), [seg('you', 0, 5)], 'Me Self')
    expect(rows.find((r) => r.name === 'Me Self')).toMatchObject({ speaker: 'you', present: true })
  })
})
