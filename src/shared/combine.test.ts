import { describe, expect, it } from 'vitest'
import { joinNotes, joinTranscripts, sameCall } from './combine'
import type { Meeting } from './types'

const meeting = (id: string, from: string, to: string, more: Partial<Meeting> = {}): Meeting => ({
  id,
  title: 'Partner sync',
  app: 'teams',
  createdAt: from,
  recordingStartedAt: from,
  recordingEndedAt: to,
  status: 'ready',
  tags: [],
  sync: { state: 'not-synced' },
  ...more
})

describe('sameCall', () => {
  const first = meeting('a', '2026-11-05T14:00:00Z', '2026-11-05T14:20:00Z')

  it('takes the same title, rejoined soon after, as one call', () => {
    expect(sameCall(first, meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z'))).toBe(true)
    expect(sameCall(meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z'), first)).toBe(true)
  })

  it('not a different title, a long gap, a generic title, or a note still being finished', () => {
    expect(sameCall(first, meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z', { title: 'Standup' }))).toBe(false)
    expect(sameCall(first, meeting('b', '2026-11-05T15:30:00Z', '2026-11-05T15:50:00Z'))).toBe(false)
    const generic = { title: 'Teams meeting' }
    expect(sameCall({ ...first, ...generic }, meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z', generic))).toBe(false)
    expect(sameCall(first, meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z', { status: 'summarizing' }))).toBe(false)
  })

  it('matches on the title Teams showed when one was renamed', () => {
    const renamed = meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z', { title: 'Pricing follow-up', detectedTitle: 'Partner Sync' })
    expect(sameCall(first, renamed)).toBe(true)
  })

  it('not once the user said they are different calls', () => {
    expect(sameCall({ ...first, notSameCall: ['b'] }, meeting('b', '2026-11-05T14:23:00Z', '2026-11-05T14:50:00Z'))).toBe(false)
  })
})

describe('joinTranscripts', () => {
  it('puts the later lines after the earlier ones, with new numbers for its speakers', () => {
    const a = {
      transcript: [
        { start: 0, end: 2, speaker: 'you' as const, text: 'Hi' },
        { start: 3, end: 5, speaker: 's1' as const, text: 'Hello' }
      ],
      speakers: { s1: 'Dana Smith' }
    }
    const b = {
      transcript: [
        { start: 1, end: 2, speaker: 's1' as const, text: 'Back' },
        { start: 2, end: 4, speaker: 's2' as const, text: 'Me too' },
        { start: 4, end: 6, speaker: 'you' as const, text: 'Great' }
      ],
      speakers: { s2: 'Dana Smith', s1: 'Lee?' },
      speakerGuesses: { s1: { evidence: 'Asked by name' } }
    }
    const r = joinTranscripts(a, b, 600)
    expect(r.ids).toEqual({ s1: 's2', s2: 's1', you: 'you' })
    expect(r.transcript.slice(2)).toEqual([
      { start: 601, end: 602, speaker: 's2', text: 'Back' },
      { start: 602, end: 604, speaker: 's1', text: 'Me too' },
      { start: 604, end: 606, speaker: 'you', text: 'Great' }
    ])
    expect(r.speakers).toEqual({ s1: 'Dana Smith', s2: 'Lee?' })
    expect(r.speakerGuesses).toEqual({ s2: { evidence: 'Asked by name' } })
  })

  it('never takes two guesses alike as one person', () => {
    const a = { transcript: [{ start: 0, end: 1, speaker: 's1' as const, text: 'x' }], speakers: { s1: 'Dana' }, speakerGuesses: { s1: { evidence: '' } } }
    const b = { transcript: [{ start: 0, end: 1, speaker: 's1' as const, text: 'y' }], speakers: { s1: 'Dana' } }
    expect(joinTranscripts(a, b, 10).ids.s1).toBe('s2')
  })

  it('keeps Others as Others when neither part told voices apart', () => {
    const a = { transcript: [{ start: 0, end: 1, speaker: 'others' as const, text: 'x' }] }
    const b = { transcript: [{ start: 0, end: 1, speaker: 'others' as const, text: 'y' }] }
    expect(joinTranscripts(a, b, 10).ids.others).toBe('others')
  })
})

describe('joinNotes', () => {
  it('keeps both summaries and both sets of notes, the later under when it began', () => {
    const out = joinNotes(
      { generated: '## Summary\n\nFirst.', user: 'Mine 1' },
      { generated: '## Summary\n\nSecond.\n\n## Actions\n\n- [x] Done', user: 'Mine 2' },
      '14:23'
    )
    expect(out).toBe('## Summary\n\nFirst.\n\n## Summary\n\nSecond.\n\n## Actions\n\n- [x] Done\n\n## Your notes\n\nMine 1\n\n### Rejoined at 14:23\n\nMine 2\n')
  })

  it('without summaries, is just the notes', () => {
    expect(joinNotes({ generated: '', user: 'Mine 1' }, { generated: '', user: '' }, '14:23')).toBe('Mine 1\n')
  })
})
