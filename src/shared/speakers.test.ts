import { describe, expect, it } from 'vitest'
import { goneSpeakers, removeSpeaker, sameSpeaker, speakerTurns } from './speakers'
import type { TranscriptSegment } from './types'

const seg = (speaker: TranscriptSegment['speaker'], start: number): TranscriptSegment => ({ speaker, start, end: start + 1, text: 'x' })

describe('speakerTurns', () => {
  it('finds the first line of each run', () => {
    const segs = [seg('s1', 0), seg('s1', 1), seg('you', 2), seg('s1', 3), seg('s2', 4), seg('s1', 5), seg('s1', 6)]
    expect(speakerTurns(segs, 's1')).toEqual([0, 3, 5])
    expect(speakerTurns(segs, 's2')).toEqual([4])
    expect(speakerTurns(segs, 's3')).toEqual([])
  })
})

describe('removeSpeaker', () => {
  it('gives every line to the chosen speaker and leaves the rest alone', () => {
    const segs = [seg('s1', 0), seg('s3', 1), seg('you', 2), seg('s3', 3)]
    expect(removeSpeaker(segs, 's3', 's1').map((s) => s.speaker)).toEqual(['s1', 's1', 'you', 's1'])
    expect(segs[1].speaker).toBe('s3')
  })
})

describe('goneSpeakers', () => {
  it('lists speakers an edit left with no lines', () => {
    const before = [seg('you', 0), seg('s1', 1), seg('s2', 2), seg('s3', 3)]
    const after = [seg('you', 0), seg('s1', 1), seg('s1', 2), seg('s3', 3)]
    expect(goneSpeakers(before, after)).toEqual(['s2'])
  })
  it('never counts You', () => {
    expect(goneSpeakers([seg('you', 0), seg('s1', 1)], [seg('s1', 0), seg('s1', 1)])).toEqual([])
  })
  it('ignores an empty transcript', () => {
    expect(goneSpeakers([seg('s1', 0)], [])).toEqual([])
  })
})

describe('sameSpeaker', () => {
  const m = { speakers: { s1: 'Pat Lee', s2: 'Sam Roe', s3: 'Pat Lee' }, speakerGuesses: { s2: { evidence: '' } } }
  const all: TranscriptSegment['speaker'][] = ['you', 's1', 's2', 's3', 's4']

  it('finds the speaker who already has the name, whatever the case and spacing', () => {
    expect(sameSpeaker('s4', m, all, '  pat   LEE ')).toBe('s1')
    expect(sameSpeaker('s1', m, all, 'Pat Lee')).toBe('s3')
  })
  it('matches the names Kasha shows for speakers nobody named', () => {
    expect(sameSpeaker('s4', m, all, 'You')).toBe('you')
    expect(sameSpeaker('s1', m, all, 'speaker 4')).toBe('s4')
  })
  it('ignores guesses, the speaker itself and blank names', () => {
    expect(sameSpeaker('s4', m, all, 'Sam Roe')).toBeUndefined()
    expect(sameSpeaker('s4', m, all, 'Speaker 4')).toBeUndefined()
    expect(sameSpeaker('s4', m, all, '  ')).toBeUndefined()
  })
})
