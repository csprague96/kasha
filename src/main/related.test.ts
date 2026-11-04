import { describe, expect, it } from 'vitest'
import { candidates, matchTitles, parseNote, profileNote, rank, words, type CallProfile } from './related'

describe('parseNote', () => {
  it('reads Kasha front matter: title, date, tags and attendees', () => {
    const p = parseNote(
      ['---', 'title: "Billing: Q4 sync"', 'date: 2026-10-30', 'time: "10:00"', 'attendees: [Pat Lee, "Sam Roe"]', 'tags: [meeting, billing]', 'source: kasha', '---', '## Summary', 'Talked about #chargebacks.'].join('\n'),
      '2026-10-30 Billing Q4 sync.md'
    )
    expect(p.title).toBe('Billing: Q4 sync')
    expect(p.date).toBe('2026-10-30')
    expect(p.people).toEqual(['Pat Lee', 'Sam Roe'])
    expect(p.tags).toEqual(['meeting', 'billing', 'chargebacks'])
    expect(p.body.startsWith('## Summary')).toBe(true)
  })

  it('reads YAML block lists and falls back to the file name', () => {
    const p = parseNote(['---', 'tags:', '  - Project X', '  - "ops"', '---', 'See [[Pricing plan|the plan]] and [[Folder/Roadmap#Q1]].'].join('\r\n'), '2026-09-01 Ops review.md')
    expect(p.title).toBe('2026-09-01 Ops review')
    expect(p.date).toBe('2026-09-01')
    expect(p.tags).toEqual(['project-x', 'ops'])
    expect(p.links).toEqual(['Pricing plan', 'Roadmap'])
  })

  it('takes a note without front matter as it is, and headings aren’t tags', () => {
    const p = parseNote('# Heading\nSome text #idea and C# here', 'Ideas.md')
    expect(p.title).toBe('Ideas')
    expect(p.date).toBeNull()
    expect(p.tags).toEqual(['idea'])
  })
})

describe('words', () => {
  it('keeps telling words and drops short and common ones', () => {
    expect(words("We'll talk about the chargeback dispute flow, Pat's idea, okay")).toEqual(['chargeback', 'dispute', 'flow', 'idea'])
  })
  it('folds plurals, but not words that only end in s', () => {
    expect(words('Disputes chargebacks status analysis process')).toEqual(['dispute', 'chargeback', 'status', 'analysis', 'process'])
  })
})

describe('rank', () => {
  const call: CallProfile = {
    title: 'Billing sync',
    tags: ['billing', 'meeting'],
    people: ['Pat Lee', 'Me Myself', 'someone@example.com'],
    text: 'Chargeback disputes are up. The chargeback portal needs a refund export. Reconciliation is late again.',
    links: []
  }
  const cands = candidates(call)
  const note = (key: string, text: string, meetingId?: string) => profileNote(key, parseNote(text, `${key}.md`), cands, meetingId)

  const notes = [
    note('2026-10-23 Billing sync', '---\ntags: [meeting, billing]\nattendees: [Pat Lee, Me Myself]\n---\nChargeback numbers and the refund export.', 'm1'),
    note('Chargeback process', 'How a chargeback dispute goes, step by step. Reconciliation after.'),
    note('2026-10-20 Team lunch', '---\ntags: [meeting]\nattendees: [Me Myself]\n---\nPizza place picked.'),
    note('Hiring plan', 'Two roles open. Interviews next month.')
  ]

  it('puts the notes on the same topic first, says why, and leaves the rest out', () => {
    const r = rank(call, cands, notes, { generic: ['meeting'], me: 'Me Myself' })
    expect(r.map((n) => n.key)).toEqual(['2026-10-23 Billing sync', 'Chargeback process'])
    expect(r[0].why).toContain('#billing')
    expect(r[0].why).toContain('Similar title')
    expect(r[0].why).toContain('Pat Lee was there')
    expect(r[0].meetingId).toBe('m1')
    expect(r[1].why.some((w) => w.startsWith('Mentions'))).toBe(true)
  })

  it('doesn’t count the standing tags or the note taker', () => {
    const r = rank({ ...call, title: 'Lunch', tags: ['meeting'], people: ['Me Myself'], text: 'Nothing in common here at all' }, cands, notes, {
      generic: ['meeting'],
      me: 'Me Myself'
    })
    expect(r.find((n) => n.key === '2026-10-20 Team lunch')?.why ?? []).not.toContain('Me Myself was there')
    expect(r.some((n) => n.why.includes('#meeting'))).toBe(false)
  })

  it('counts a link either way', () => {
    const linked = note('Q4 goals', 'Background for [[Billing sync]].')
    const r = rank(call, cands, [linked], {})
    expect(r[0]?.why).toContain('Linked')
  })
})

describe('matchTitles', () => {
  it('needs every word typed, newest first', () => {
    const all = [
      { title: '2026-10-01 Billing sync', date: '2026-10-01' },
      { title: '2026-10-08 Billing sync', date: '2026-10-08' },
      { title: 'Billing FAQ', date: null }
    ]
    expect(matchTitles(all, 'billing sync').map((n) => n.date)).toEqual(['2026-10-08', '2026-10-01'])
    expect(matchTitles(all, '  ')).toEqual([])
  })
})
