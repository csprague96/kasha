/**
 * PCI: card numbers must not be stored or sent anywhere, and neither should
 * SSNs or card security codes. Everything Kasha writes to disk goes through
 * here (store.ts), and text is redacted again where it leaves the app
 * (summary prompts, Obsidian, shared copies).
 *
 * Speech-to-text writes a read-out number in many shapes: "4111 1111 1111
 * 1111", "4111, 1111, 1111, 1111.", "4111... 1111...", "four one one one",
 * "double four", with an "and" or "uh" between groups, or split over several
 * lines when the reader pauses. Notes hold dates, phone numbers, amounts and
 * ticket numbers that must survive. So text is read once, left to right,
 * into runs of digit groups (no backtracking-prone patterns), and a run is a
 * card only if a stretch of whole groups:
 *  - has 13-19 digits, starts like a payment card (2-6) and passes Luhn, and
 *  - is shaped like a card read aloud (4-4-4-4…, 4-6-5, 4-6-4, digits one or
 *    two at a time, or one unbroken number), or comes just after a word like
 *    "card" or "Visa".
 * Link targets and web addresses are never touched.
 */

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

const WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9'
}
const REPEAT: Record<string, number> = { double: 2, triple: 3 }
/** Said between digit groups without ending the number. */
const FILLER = new Set(['and', 'uh', 'um', 'er', 'erm', 'ah'])
/** Characters allowed between groups (besides spaces), at most MAX_SEP of them. */
const SEP = new Set([',', '.', '-', '/', '–', '—', '…', ';', ':'])
const MAX_SEP = 4

const CARD_CUE = /\b(card|visa|master ?card|amex|american express|discover|credit|debit|cc|pan)\b/i
const SSN_CUE = /\b(social|ssn|social security)\b/i
const CVV_CUE = /\b(cvv2?|cvc2?|cv2|security code|card verification|three digits on the back|code on the back)\b/i
const COUNT_AFTER = /^\s*(%|percent|failures?|declines?|transactions?|times|merchants?|accounts?|people|users?|days?|years?)\b/i

interface Unit {
  digits: string
  start: number
  end: number
  /** Said digit by digit ("four", "double one", "4 1 1 1"): such units group together. */
  spoken: boolean
}

export interface Hit {
  start: number
  end: number
  label: string
}

/** Ranges never redacted: Markdown link and image targets, <autolinks>, web addresses, attachment paths. */
function protectedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const re of [/\]\([^)\n]*\)/g, /<[^>\s]+>/g, /\b[a-z][\w+.-]*:\/\/[^\s)]+/gi, /\battachments\/[^\s)]+/g]) {
    for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length])
  }
  return out
}

/** Splits text into runs of digit groups, in one pass. */
function runs(text: string): Unit[][] {
  const guard = protectedRanges(text)
  const hidden = (i: number) => guard.some(([a, b]) => i >= a && i < b)
  const out: Unit[][] = []
  let run: Unit[] = []
  let sepChars = 0 // separator characters since the last unit
  let fillers = 0 // filler words since the last unit
  let repeat: { n: number; start: number } | null = null
  const end = () => {
    if (run.length) out.push(run)
    run = []
    repeat = null
  }
  const add = (digits: string, start: number, stop: number, word = false) => {
    let spoken = word || digits.length === 1
    if (repeat) {
      digits = digits.repeat(repeat.n)
      start = repeat.start
      repeat = null
      spoken = true
    }
    run.push({ digits, start, end: stop, spoken })
    sepChars = 0
    fillers = 0
  }
  // Each alternative is a simple character class, so matching is linear.
  for (const m of text.matchAll(/(\d+)|([A-Za-z]+)|(\n)|([ \t ]+)|(.)/gsu)) {
    const [tok, num, word, newline, space] = m
    const at = m.index!
    if (hidden(at)) {
      end()
      continue
    }
    if (num !== undefined) {
      if (repeat && num.length !== 1) end()
      add(num, at, at + tok.length)
    } else if (word !== undefined) {
      const w = word.toLowerCase()
      if (w in WORDS) add(WORDS[w], at, at + tok.length, true)
      else if (w in REPEAT) {
        if (repeat) end()
        repeat = { n: REPEAT[w], start: at }
      } else if (run.length && !repeat && FILLER.has(w) && fillers === 0) fillers++
      else end()
    } else if (newline !== undefined) end()
    else if (space !== undefined) {
      /* spaces never end a run */
    } else if (SEP.has(tok) && run.length && !repeat && sepChars < MAX_SEP) sepChars++
    else end()
  }
  end()
  return out
}

/**
 * Grouping that looks like a card read aloud. Digits said one at a time
 * count as one group ("four one one one 1111…" reads as 4-4-…).
 */
function cardShaped(units: Unit[]): boolean {
  // One number, digits said one at a time, or read in pairs.
  if (units.length === 1 || units.every((u) => u.spoken || u.digits.length <= 2)) return true
  const lens: number[] = []
  units.forEach((u, i) => {
    if (u.spoken && i > 0 && units[i - 1].spoken) lens[lens.length - 1] += u.digits.length
    else lens.push(u.digits.length)
  })
  if (lens.length === 1) return true
  if (lens.slice(0, -1).every((n) => n === 4) && lens[lens.length - 1] <= 4) return true
  const shape = lens.join('-')
  return shape === '4-6-5' || shape === '4-6-4'
}

/** Card numbers, SSNs and security codes in a text, as character ranges. */
export function find(text: string): Hit[] {
  const hits: Hit[] = []
  for (const run of runs(text)) {
    const start = run[0].start
    const stop = run[run.length - 1].end
    const before = text.slice(Math.max(0, start - 80), start)
    const groups = run.map((u) => u.digits)
    const all = groups.join('')
    const wordsOnly = !/\d/.test(text.slice(start, stop))
    // Card: a stretch of whole groups (speech-to-text repeats or adds a group, so not necessarily all of them).
    let card = false
    for (let i = 0; i < groups.length && !card; i++) {
      if (!/[2-6]/.test(groups[i][0])) continue
      let digits = ''
      for (let j = i; j < groups.length; j++) {
        digits += groups[j]
        if (digits.length > 19) break
        if (digits.length >= 13 && luhn(digits) && (cardShaped(run.slice(i, j + 1)) || CARD_CUE.test(before))) {
          card = true
          break
        }
      }
    }
    if (card) {
      hits.push({ start, end: stop, label: '[card number]' })
      continue
    }
    if (wordsOnly && all.length < 3) continue // "one", "two" in a sentence
    const ssnShape = groups.length === 3 && groups[0].length === 3 && groups[1].length === 2 && groups[2].length === 4
    if (all.length === 9 && (ssnShape || SSN_CUE.test(before))) {
      hits.push({ start, end: stop, label: '[SSN]' })
      continue
    }
    if ((all.length === 3 || all.length === 4) && CVV_CUE.test(before.slice(-40))) {
      const year = all.length === 4 && /^(19|20)\d\d$/.test(all)
      if (!year && !COUNT_AFTER.test(text.slice(stop, stop + 20))) hits.push({ start, end: stop, label: '[security code]' })
    }
  }
  return hits
}

function apply(text: string, hits: Hit[]): string {
  let out = text
  for (const h of [...hits].sort((a, b) => b.start - a.start)) out = out.slice(0, h.start) + h.label + out.slice(h.end)
  return out
}

/** Redacts one piece of text: a line, a note, a summary. */
export function redact(text: string): string {
  if (!text || !/[0-9]|zero|oh|one|two|three|four|five|six|seven|eight|nine/i.test(text)) return text
  return apply(text, find(text))
}

interface Line {
  start: number
  end: number
  speaker: string
  text: string
}

/** Lines this close together are read as one stretch. */
const JOIN_GAP = 10
/** A question this recent ("and the security code?") counts for the answer, whoever asked. */
const CUE_GAP = 15

/**
 * Redacts each line, then lines together:
 *  - the computer's audio as one stretch (all "Others" voices come from one
 *    track, and short digit pieces are often given to the wrong voice), and
 *    the note taker's mic as another, joining lines within 10 s, so a number
 *    read in groups with pauses is caught;
 *  - each line with the 15 s before it, from anyone, so "the CVV?" asked by
 *    one person covers "456" said by another.
 * Lines were redacted one by one first, so these passes only add.
 */
export function redactLines<T extends Line>(lines: T[]): T[] {
  const out = lines.map((l) => ({ ...l, text: redact(l.text) }))
  const order = out.map((_, i) => i).sort((a, b) => out[a].start - out[b].start)
  for (const mine of [true, false]) {
    let group: number[] = []
    const flush = () => {
      if (group.length > 1) redactJoined(out, group)
      group = []
    }
    for (const i of order) {
      if ((out[i].speaker === 'you') !== mine) continue
      const prev = group.length ? out[group[group.length - 1]] : null
      if (prev && out[i].start - prev.end > JOIN_GAP) flush()
      group.push(i)
    }
    flush()
  }
  // Answers to a question someone else asked.
  order.forEach((i, k) => {
    const line = out[i]
    if (!/[0-9]|zero|oh|one|two|three|four|five|six|seven|eight|nine/i.test(line.text)) return
    let context = ''
    for (let p = k - 1; p >= 0 && out[order[p]].end >= line.start - CUE_GAP && context.length < 120; p--) context = `${out[order[p]].text} ${context}`
    if (!context) return
    const from = context.length
    const hits = find(context + line.text)
      .filter((h) => h.end > from && h.label !== '[card number]')
      .map((h) => ({ ...h, start: Math.max(0, h.start - from), end: h.end - from }))
    if (hits.length) line.text = apply(line.text, hits)
  })
  return out
}

/** Finds numbers that only show when lines are read together, and redacts each line's part. */
function redactJoined(lines: Line[], group: number[]): void {
  let joined = ''
  const at: number[] = []
  for (const i of group) {
    if (joined) joined += ' '
    at.push(joined.length)
    joined += lines[i].text
  }
  const hits = find(joined)
  if (!hits.length) return
  group.forEach((i, k) => {
    const from = at[k]
    const to = from + lines[i].text.length
    const local = hits
      .filter((h) => h.start < to && h.end > from)
      .map((h) => ({ start: Math.max(0, h.start - from), end: Math.min(lines[i].text.length, h.end - from), label: h.label }))
    if (local.length) lines[i].text = apply(lines[i].text, local)
  })
}
