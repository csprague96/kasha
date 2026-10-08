import { describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '@shared/types'

vi.mock('./store', () => ({ paths: { root: () => '.', meeting: (id: string) => id } }))
vi.mock('./log', () => ({ log: () => undefined }))
const { addressFits, namesFromRoster, participants, resolveAttendees } = await import('./roster')

const P = (name: string, muted: boolean | null, self = false) => ({ name, muted, self, speaking: null })
const seg = (speaker: TranscriptSegment['speaker'], start: number, end: number): TranscriptSegment => ({ speaker, start, end, text: 'x' })
const every2 = (to: number, people: () => ReturnType<typeof P>[]) => Array.from({ length: to / 2 }, (_, i) => ({ t: i * 2, people: people() }))

describe('namesFromRoster', () => {
  it('offers the other person in a 1:1 call as a guess, never a certain name', () => {
    const n = namesFromRoster([{ t: 0, people: [P('Me Self', false, true), P('Remote One', null)] }], [seg('you', 0, 3), seg('others', 4, 20)], {})
    expect(n.guessNames).toEqual({ others: 'Remote One' })
    expect(n.guesses.others?.evidence).toMatch(/only other person/)
  })

  it('warns when a 1:1 call has more than one voice', () => {
    const n = namesFromRoster([{ t: 0, people: [P('Remote One', null)] }], [seg('s1', 4, 20), seg('s2', 30, 50)], {})
    expect(n.guesses.s1?.evidence).toMatch(/2 voices/)
  })

  it('guesses the only unmuted person in a group call', () => {
    const tl = every2(60, () => [P('Ann A', false), P('Bob B', true), P('Me', false, true)])
    expect(namesFromRoster(tl, [seg('s1', 5, 30)], {}).guessNames).toEqual({ s1: 'Ann A' })
  })

  it('does not guess by elimination when someone in the call was not on screen', () => {
    const tl = every2(60, () => [P('Ann A', false), P('Bob B', true), P('Me', false, true)])
    tl.push({ t: 1, people: [P('Ann A', false), P('Bob B', true), P('Cy C', true), P('Me', false, true)] })
    tl.sort((a, b) => a.t - b.t)
    expect(namesFromRoster(tl, [seg('s1', 5, 30), seg('s2', 31, 55)], {}).guessNames).toEqual({})
  })

  it('leaves named speakers alone', () => {
    const n = namesFromRoster([{ t: 0, people: [P('Remote One', null)] }], [seg('others', 4, 20)], { others: 'Someone' })
    expect(n.guessNames).toEqual({})
  })
})

describe('people and addresses', () => {
  it('participants leave out the note taker', () => {
    expect(participants([{ t: 0, people: [P('Me', false, true), P('Ann A', null)] }])).toEqual(['Ann A'])
  })

  it('maps the note taker’s own address to them, and others’ to Teams names', () => {
    expect(resolveAttendees(['mself@co.com', 'aa@co.com', 'zz@co.com'], ['Ann A'], { name: 'Me Self', as: 'Me Self' })).toEqual(['Me Self', 'Ann A', 'zz@co.com'])
  })

  it('keeps an address that fits two people', () => {
    expect(resolveAttendees(['jb@co.com'], ['Jo Blake', 'Joe Bloggs'])).toEqual(['jb@co.com'])
  })

  it('addressFits only takes addresses that spell the whole name (for recording rules)', () => {
    expect(addressFits('sam.lee@co.com', 'Sam Lee')).toBe(true)
    expect(addressFits('samlee@co.com', 'Sam Lee')).toBe(true)
    expect(addressFits('slee@co.com', 'Sam Lee')).toBe(false)
    expect(addressFits('sam.long@co.com', 'Sam Lee')).toBe(false)
    expect(addressFits('Sam Lee', 'Sam Lee')).toBe(false)
  })

  it('an address that fits someone in the call isn’t taken as the note taker', () => {
    expect(resolveAttendees(['slee@co.com'], ['Sara Lee'], { name: 'Sam Lee', as: 'Sam Lee' })).toEqual(['Sara Lee'])
  })
})
