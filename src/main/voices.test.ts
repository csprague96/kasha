import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'kasha-voices-'))
vi.mock('./store', () => ({ paths: { root: () => root } }))
const voices = await import('./voices')

const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs)
  return xs.map((x) => x / n)
}
const M = 'eres2net'
const A = unit(1, 0, 0, 0)
const B = unit(0, 1, 0, 0)

beforeEach(() => {
  voices.clear()
  voices.enroll('Person A', { meetingId: 'm1', speaker: 's1', v: A, model: M })
  voices.enroll('Person B', { meetingId: 'm1', speaker: 's2', v: B, model: M })
  voices.enroll('Person C', { meetingId: 'm2', speaker: 's1', v: unit(0, 0, 1, 0), model: 'campplus' })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('matchAll', () => {
  it('gives a person to the best-scoring voice only', () => {
    const r = voices.matchAll({ s1: unit(1, 0.2, 0, 0), s2: unit(0.9, 0.1, 0, 0) }, M)
    expect(Object.values(r).filter((x) => x?.name === 'Person A')).toHaveLength(1)
    expect(r.s2?.name).toBe('Person A')
  })

  it('needs a lead over the next person', () => {
    expect(voices.matchAll({ s1: unit(1, 1, 0, 0) }, M)).toEqual({})
  })

  it('never compares voiceprints from another model', () => {
    expect(voices.matchAll({ s1: unit(0, 0, 1, 0) }, M)).toEqual({})
  })

  it('only considers the candidates, matched loosely', () => {
    expect(voices.matchAll({ s1: unit(1, 0.1, 0, 0) }, M, ['Person B (External)'])).toEqual({})
    expect(voices.matchAll({ s1: unit(1, 0.1, 0, 0) }, M, ['person a'])['s1']?.name).toBe('Person A')
  })
})

describe('forgetting', () => {
  it('deleting a meeting forgets what was learned from it', () => {
    voices.unenrollMeeting('m1')
    expect(voices.list().map((v) => v.name)).toEqual(['Person C'])
  })

  it('forget all', () => {
    voices.clear()
    expect(voices.list()).toEqual([])
  })
})
