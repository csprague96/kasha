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
    ['double spaces', 'card 4111  1111  1111  1111'],
    ['Mastercard', `use ${MC}`],
    ['Amex 4-6-5', `amex ${AMEX}`],
    ['repeated group from speech-to-text', 'card 4111 1111 1111 1111 1111'],
    ['spoken digits', 'it is four one one one one one one one one one one one one one one one'],
    ['spoken with double', 'four double one one, one one one one, one one one one, one one one one'],
    ['mixed words and digits', 'four one one one 1111 1111 1111']
  ])('%s', (_name, text) => {
    const out = redact(text)
    expect(out).toContain('[card number]')
    expect(out.replace(/\D/g, '')).not.toMatch(/\d{6,}/)
  })

  it.each([
    ['a phone number', 'call me at 555 123 4567'],
    ['an order number', 'order 12345 shipped'],
    ['a date', 'on 2026-10-08 at 10:30'],
    ['money', 'it costs $1,200.50 a month'],
    ['ordinary number words', 'I have one question and two answers'],
    ['12 digits, too short for a card', 'ref 4111 1111 1111'],
    ['the word phone', 'someone phoned at one']
  ])('leaves %s alone', (_name, text) => {
    expect(redact(text)).toBe(text)
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

  it('leaves a 3-digit number without a cue alone', () => {
    expect(redact('we had 123 attendees')).toBe('we had 123 attendees')
  })
})

describe('redactLines: numbers split across lines', () => {
  const line = (speaker: string, start: number, end: number, text: string) => ({ speaker, start, end, text })

  it('catches a card read in groups over several lines', () => {
    const out = redactLines([line('others', 0, 3, 'the card is 4111 1111'), line('others', 4, 6, '1111 1111.')])
    expect(out.map((l) => l.text).join(' ')).not.toMatch(/1111/)
    expect(out[0].text).toContain('[card number]')
  })

  it('catches a card split across lines with another speaker in between', () => {
    const out = redactLines([line('others', 0, 3, '4111 1111'), line('you', 3, 4, 'okay'), line('others', 4, 6, '1111 1111')])
    expect(out[2].text).toContain('[card number]')
    expect(out[1].text).toBe('okay')
  })

  it('does not join different speakers', () => {
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
