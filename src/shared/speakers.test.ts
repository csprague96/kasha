import { describe, expect, it } from 'vitest'
import { goneSpeakers, removeSpeaker, speakerTurns } from './speakers'
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
