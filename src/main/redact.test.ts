import { describe, expect, it } from 'vitest'
import { redact, redactLines } from './redact'

// Published test card numbers only (Visa, Mastercard, Amex test PANs); no real data.
const VISA = '4111 1111 1111 1111'
const MC = '5555 5555 5555 4444'
const AMEX = '3782 822463 10005'

describe('redact: card numbers', () => {
  it.each([
    ['spaces', `My card is ${VISA}.`],
    ['dashes', 'It is 4111-1111-1111-1111 thanks'],
    ['no separators', 'number 4111111111111111 ok'],
    ['commas between groups', 'card 4111, 1111, 1111, 1111.'],
    ['periods between groups', 'card 4111. 1111. 1111. 1111. done'],
    ['dots', 'card 4111.1111.1111.1111'],
    ['ellipses', 'It is 4111... 1111... 1111... 1111.'],
    ['en and em dashes', 'it is 4111 – 1111 — 1111 – 1111'],
    ['and between groups', 'it is 4111 and 1111 and 1111 and 1111'],
    ['uh between groups', 'it is 4111 uh 1111 um 1111 1111'],
    ['double spaces', 'card 4111  1111  1111  1111'],
    ['Mastercard', `use ${MC}`],
    ['Amex 4-6-5', `amex ${AMEX}`],
    ['repeated group from speech-to-text', 'card 4111 1111 1111 1111 1111'],
    ['spoken digits', 'it is four one one one one one one one one one one one one one one one'],
    ['single digits', 'it is 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1'],
    ['pairs', 'it is 41 11 11 11 11 11 11 11'],
    ['spoken with double', 'four double one one, one one one one, one one one one, one one one one'],
    ['mixed words and digits', 'four one one one 1111 1111 1111'],
    ['odd grouping after a card word', 'the Visa is 41 111 111 111 11111']
  ])('%s', (_name, text) => {
    const out = redact(text)
    expect(out).toContain('[card number]')
    expect(out.replace(/\D/g, '')).not.toMatch(/\d{6,}/)
  })

  it.each([
    ['a phone number', 'call me at 555 123 4567'],
    ['two phone numbers', 'Contacts 555-123-4567, 555-987-6543'],
    ['a phone list over lines', 'Contacts\n555-123-4567\n555-987-6543'],
    ['an order number', 'order 12345 shipped'],
    ['a date', 'on 2026-10-08 at 10:30'],
    ['a US date range', 'Sprint 01/03/2026 - 01/16/2026'],
    ['an ISO date range', 'from 2026-10-08 - 2026-10-22'],
    ['money', 'it costs $1,200.50 a month'],
    ['several amounts', 'quotes were $1,200, $3,400 and $5,600'],
    ['five-digit tickets over lines', 'Ticket numbers\n1. 48213\n2. 48217\n3. 48220\n4. 48291'],
    ['ordinary number words', 'I have one question and two answers'],
    ['12 digits, too short for a card', 'ref 4111 1111 1111'],
    ['the word phone', 'someone phoned at one'],
    ['an image link with a timestamp', '![Image](attachments/image-1728405123456.png)'],
    ['a link with a long id', 'see [status](https://example.com/status/4111111111111111)'],
    ['a bare web address', 'https://example.com/tx/4111111111111111 failed']
  ])('leaves %s alone', (_name, text) => {
    expect(redact(text)).toBe(text)
  })

  it('reads a long run of digits in linear time', () => {
    const text = `${'1234567890'.repeat(500)}x`
    const t = performance.now()
    redact(text)
    expect(performance.now() - t).toBeLessThan(200)
  })
})

describe('redact: SSNs and security codes', () => {
  it.each([
    ['dashes', 'SSN 123-45-6789', '[SSN]'],
    ['spaces', 'it is 123 45 6789', '[SSN]'],
    ['dots', 'it is 123.45.6789', '[SSN]'],
    ['nine digits after a cue', 'my social is 123456789', '[SSN]'],
    ['CVV after a cue', 'the CVV is 123', '[security code]'],
    ['security code in words', 'security code four five six', '[security code]'],
    ['CVC four digits', 'cvc 1234', '[security code]']
  ])('%s', (_name, text, label) => {
    expect(redact(text)).toContain(label)
  })

  it.each([
    ['a number without a cue', 'we had 123 attendees'],
    ['a year after a CVV word', 'CVV checks started in 2025'],
    ['a count after a CVV word', 'CVV mismatches: 1200 declines last month']
  ])('leaves %s alone', (_name, text) => {
    expect(redact(text)).toBe(text)
  })
})

describe('redactLines: numbers split across lines', () => {
  const line = (speaker: string, start: number, end: number, text: string) => ({ speaker, start, end, text })

  it('catches a card read in groups over several lines', () => {
    const out = redactLines([line('others', 0, 3, 'the card is 4111 1111'), line('others', 4, 6, '1111 1111.')])
    expect(out.map((l) => l.text).join(' ')).not.toMatch(/1111/)
    expect(out[0].text).toContain('[card number]')
  })

  it('catches it with ellipses at the line ends', () => {
    const out = redactLines([line('others', 0, 3, 'it is 4111 1111...'), line('others', 4, 6, '1111 1111.')])
    expect(out.map((l) => l.text).join(' ')).not.toMatch(/1111/)
  })

  it('catches a card split between two voices on the computer audio', () => {
    const out = redactLines([line('s1', 0, 3, 'Card is 4111 1111'), line('s2', 4, 6, '1111 1111.')])
    expect(out.map((l) => l.text).join(' ')).not.toMatch(/1111/)
  })

  it('catches a card split across lines with the note taker in between', () => {
    const out = redactLines([line('others', 0, 3, '4111 1111'), line('you', 3, 4, 'okay'), line('others', 4, 6, '1111 1111')])
    expect(out[2].text).toContain('[card number]')
    expect(out[1].text).toBe('okay')
  })

  it('catches a security code given in answer to someone else', () => {
    const out = redactLines([line('you', 0, 3, 'And the security code on the back?'), line('others', 4, 5, '456.')])
    expect(out[1].text).toBe('[security code].')
  })

  it('catches a security code after a cue on the line before', () => {
    const out = redactLines([line('others', 0, 2, 'The CVV is'), line('others', 2, 3, '456.')])
    expect(out[1].text).toBe('[security code].')
  })

  it('catches an SSN given in answer', () => {
    const out = redactLines([line('you', 0, 3, 'Can I get your social?'), line('others', 4, 7, '123456789')])
    expect(out[1].text).toBe('[SSN]')
  })

  it('does not join the note taker with the computer audio', () => {
    const out = redactLines([line('others', 0, 3, '4111 1111'), line('you', 4, 6, '1111 1111')])
    expect(out.map((l) => l.text)).toEqual(['4111 1111', '1111 1111'])
  })

  it('does not join lines far apart', () => {
    const out = redactLines([line('others', 0, 3, '4111 1111'), line('others', 30, 33, '1111 1111')])
    expect(out.map((l) => l.text)).toEqual(['4111 1111', '1111 1111'])
  })

  it('keeps other fields', () => {
    const [l] = redactLines([{ ...line('s1', 1, 2, `card ${VISA}`), extra: 7 }])
    expect(l).toMatchObject({ speaker: 's1', start: 1, end: 2, extra: 7 })
  })
})

// Cases from adversarial testing of the redaction (all synthetic or published test numbers).
describe('redact: card data next to other numbers', () => {
  it.each([
    ['SSN followed by a date of birth', 'SSN 123-45-6789, 01/02/1980', 'SSN [SSN], 01/02/1980'],
    ['SSN followed by a phone', 'social 123-45-6789, 555-123-4567', 'social [SSN], 555-123-4567'],
    ['CVV followed by an expiry', 'CVV 456, 12/28', 'CVV [security code], 12/28'],
    ['expiry then CVV', 'Expiration and CVV: 12/28, 456', 'Expiration and CVV: 12/28, [security code]'],
    ['CVV in words then more digits', 'the CVV is four five six, one two two eight', 'the CVV is [security code], one two two eight']
  ])('%s', (_name, text, want) => {
    expect(redact(text)).toBe(want)
  })

  it.each([
    ['then between groups', 'it is 4111 1111 then 1111 1111'],
    ['okay between groups', 'it is 4111 1111 okay 1111 1111'],
    ['um, uh between groups', 'it is 4111 1111, um, uh, 1111 1111'],
    ['Discover', 'it is 6011 1111 1111 1117'],
    ['Diners 4-6-4', 'it is 3056 930902 5904'],
    ['thin spaces', 'card 4111 1111 1111 1111']
  ])('catches a card with %s', (_name, text) => {
    expect(redact(text)).toContain('[card number]')
  })
})

describe('redact: ordinary notes stay intact', () => {
  it.each([
    ['meeting times', 'Meetings at 17:45, 14:45, 11:00, 16:15, 9:30, 16:15, 14:30'],
    ['short dates', 'Outages on 9/12/25, 9/19/25, 10/3/25 and 10/7/25'],
    ['due dates', 'Due 3/11, 1/26, 5/21, 3/24, 7/23, 9/28'],
    ['two-digit counts', 'Declines by day: 95, 59, 51, 79, 65, 20, 21, 98'],
    ['small counts', 'Per hour: 38, 30, 29, 12, 5, 44, 39, 46, 0, 27, 41, 12'],
    ['IP addresses', 'Allow 10.0.3.8, 10.0.5.89, 10.0.1.6, 10.0.8.26'],
    ['versions', 'Releases 3.1.2, 3.1.3, 3.2.0, 3.2.1, 3.3.0'],
    ['amounts with cents', 'Refunds 87.67, 47.86, 27.71, 79.19'],
    ['time ranges', 'Blocks 14:00-10:30, 15:30-16:00, 13:30-8:30'],
    ['dates after Visa', 'Visa mandates effective 2026-10-08, 2026-11-12 and 2026-12-01'],
    ['dates after Card', 'Card brand releases 04/17/2026, 10/16/2026, 04/16/2027'],
    ['amounts after Card', 'Card sales 5,538.17, 2,009.51, 2,245.72'],
    ['phones after Card', 'Card services 555-554-3374 and 555-323-2958'],
    ['BINs after Visa', 'Visa BINs 444801, 403349, 489549'],
    ['a list of years', 'targets for 2023, 2024, 2025, 2026'],
    ['CVV metrics', 'CVV failures were 120 yesterday'],
    ['a ticket after a CVV word', 'CVV issue, ticket 1430 is open']
  ])('leaves %s alone', (_name, text) => {
    expect(redact(text)).toBe(text)
  })
})

describe('redactLines: questions, read-backs and repeats', () => {
  const line = (speaker: string, start: number, end: number, text: string) => ({ speaker, start, end, text })
  const digitsLeft = (ls: Array<{ text: string }>) => ls.map((l) => l.text).join(' ').replace(/\D/g, '')

  it('expiry and code asked together', () => {
    const out = redactLines([line('you', 0, 3, 'And the expiration date and the security code?'), line('others', 4, 7, '12/28, and 456.')])
    expect(out[1].text).toBe('12/28, and [security code].')
  })

  it('code and ZIP asked together', () => {
    const out = redactLines([line('you', 0, 3, 'Security code and billing zip?'), line('others', 4, 7, '456, 90210.')])
    expect(out[1].text).toBe('[security code], 90210.')
  })

  it('a card answer after "card number?", even with thousands commas', () => {
    const out = redactLines([line('you', 0, 3, 'Can I get the card number please?'), line('others', 4, 9, 'Sure, it is 4,111,111,111,111,111.')])
    expect(out[1].text).toContain('[card number]')
  })

  it('the note taker repeating each group back', () => {
    const out = redactLines([
      line('others', 0, 2, '4111'),
      line('you', 2, 3, 'Okay, 4111.'),
      line('others', 3, 5, '1111'),
      line('you', 5, 6, 'Got it, 1111.'),
      line('others', 6, 8, '1111'),
      line('you', 8, 9, 'Mm-hmm, 1111.'),
      line('others', 9, 11, '1111'),
      line('you', 11, 12, 'Okay, 1111.')
    ])
    expect(digitsLeft(out)).toBe('')
  })

  it('a read-back of a card heard a moment ago', () => {
    const out = redactLines([
      line('others', 0, 4, 'It is 4111 1111 1111 1111.'),
      line('you', 5, 10, 'Let me read that back, 4111, 1111, 1111, and the last four 1111.')
    ])
    expect(digitsLeft(out)).toBe('')
  })

  it('two remote voices repeating each other on one track', () => {
    const out = redactLines([
      line('s1', 0, 1, '4111'),
      line('s2', 1, 2, 'Okay, 4111.'),
      line('s1', 2, 3, '1111'),
      line('s2', 3, 4, 'Yep, 1111.'),
      line('s1', 4, 5, '1111'),
      line('s2', 5, 6, '1111.'),
      line('s1', 6, 7, '1111'),
      line('s2', 7, 8, 'Got it, 1111.')
    ])
    expect(digitsLeft(out)).toBe('')
  })

  it('handles 5,000 lines quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => line(i % 2 ? 'you' : 'others', i * 3, i * 3 + 2, `Item ${i}, see https://example.com/t/${i} at 10:${String(i % 60).padStart(2, '0')}`))
    const t = performance.now()
    redactLines(many)
    expect(performance.now() - t).toBeLessThan(1500)
  })
})
