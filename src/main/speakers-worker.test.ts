import { describe, expect, it } from 'vitest'
import { consolidate, type SpeakerCluster } from './speakers-worker'

const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs)
  return xs.map((x) => x / n)
}
const cluster = (embedding: number[], seconds: number, start: number): SpeakerCluster => ({
  segments: [{ start, end: start + seconds }],
  seconds,
  embedding
})
const sizes = (cs: SpeakerCluster[]) => cs.map((c) => `${Math.round(c.seconds)}${c.capped ? 'c' : ''}`).sort()

// Four people, two of them 0.32 alike: the closest real pair measured on a Teams call.
const P1 = unit(1, 0, 0, 0)
const P2 = unit(0.32, 0.947, 0, 0)
const P3 = unit(0, 0, 1, 0)
const P4 = unit(0, 0, 0.3, 0.954)

describe('consolidate: the Teams head-count cap', () => {
  it('never merges different-sounding people to fit a short head count', () => {
    const out = consolidate([cluster(P1, 200, 0), cluster(P2, 300, 10), cluster(P3, 250, 20), cluster(P4, 260, 30)], 3)
    expect(out).toHaveLength(4)
    expect(out.some((c) => c.capped)).toBe(false)
  })

  it('joins a substantial pair that sounds alike, and marks it', () => {
    const out = consolidate([cluster(P1, 200, 0), cluster(unit(0.37, 0.929, 0, 0), 100, 10), cluster(P3, 250, 20)], 2)
    expect(sizes(out)).toEqual(['250', '300c'])
  })

  it('a small voice neither counts toward the cap nor is merged to fit it', () => {
    const out = consolidate([cluster(P1, 200, 0), cluster(P3, 250, 20), cluster(unit(0, 0, 0, 1), 12, 40)], 2)
    expect(sizes(out)).toEqual(['12', '200', '250'])
  })

  it('folds crumbs under 2.5 s into the nearest voice', () => {
    const out = consolidate([cluster(P1, 200, 0), cluster(P3, 250, 20), cluster(unit(0, 0, 0, 1), 1.5, 40)])
    expect(out).toHaveLength(2)
  })

  it('merges pieces of one voice without a cap', () => {
    const out = consolidate([cluster(P1, 200, 0), cluster(unit(1, 0.3, 0, 0), 100, 10)])
    expect(out).toHaveLength(1)
    expect(out[0].capped).toBeFalsy()
  })
})
