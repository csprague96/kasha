/**
 * PCI: card numbers must not be stored or sent anywhere, and neither should
 * SSNs or card security codes. Everything Kasha writes to disk goes through
 * here (store.ts), and text is redacted again where it leaves the app
 * (summary prompts, Obsidian, shared copies).
 *
 * Speech-to-text writes a read-out number in many shapes: "4111 1111 1111
 * 1111", "4111, 1111, 1111, 1111.", "4111... 1111...", "four one one one",
 * "double four", with "and", "uh" or "okay" between groups, or over several
 * lines when the reader pauses or the listener repeats each group. Notes hold
 * times, dates, amounts, versions and lists that must survive. So text is read
 * once, left to right, into runs of digit groups (nothing that can backtrack),
 * and:
 *  - a time, date, decimal, version or IP (digits joined by ":", "/" or ".")
 *    is one unit that can never be part of a card;
 *  - a card is a stretch of whole groups with 13-19 digits that starts like a
 *    real card (issuer ranges), passes Luhn, and is grouped the way cards are
 *    read out (4-4-4-4, 4-6-5, digit by digit, in pairs, one number), or
 *    comes right after a word like "card" or "Visa";
 *  - an SSN or security code is the first group(s) after "SSN"/"CVV" (or a
 *    question asking for one), not everything that follows;
 *  - digits repeating part of a card heard in the last minute (a read-back)
 *    are redacted too.
 * Link targets, web addresses and attachment names are never touched.
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

/** Starts like a card some network issues: Visa, Mastercard (incl. 2-series), Maestro, Amex, Diners, JCB, Discover, UnionPay, Mir. */
function issuer(d: string): boolean {
  const a = d.charCodeAt(0) - 48
  const b = d.charCodeAt(1) - 48
  if (a === 4 || a === 6) return true
  if (a === 5) return b <= 8
  if (a === 3) return b === 0 || b >= 4
  if (a === 2) {
    const n = Number(d.slice(0, 4))
    return (n >= 2221 && n <= 2720) || (n >= 2200 && n <= 2204)
  }
  return false
}

const WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9'
}
const REPEAT: Record<string, number> = { double: 2, triple: 3 }
/** Said between digit groups without ending the number (read-backs and backchannels too). */
const FILLER = new Set([
  'and', 'uh', 'um', 'er', 'erm', 'ah', 'then', 'okay', 'ok', 'yeah', 'yes', 'yep', 'so', 'next', 'right',
  'mm', 'hmm', 'mhm', 'huh', 'got', 'it', 'alright', 'sure'
])
const MAX_FILLERS = 3
/** Characters allowed between groups (besides spaces), at most MAX_SEP of them. */
const SEP = new Set([',', '.', '-', '/', '–', '—', '…', ';', ':', '?', '!'])
const MAX_SEP = 8
/** A single one of these between two numbers with no spaces makes one unit: 12:30, 9/12/25, 87.67, 10.0.3.8. */
const JOIN = new Set([':', '/', '.'])

const CARD_CUE = /\b(card|visa|master ?card|amex|american express|discover|credit|debit|pan)\b/gi
const SSN_CUE = /\b(ssn|social security|social)\b/gi
const CVV_CUE = /\b(cvv2?|cvc2?|cv2|security code|card verification( code| value)?|code on the back|three digits on the back)\b/gi
/** Words that may stand between a cue and its number ("card number is", "CVV on the back is"). */
const LINK = new Set(['number', 'no', 'num', 'is', 'was', 'its', 's', 'it', 'the', 'on', 'file', 'reads', 'my', 'your', 'card', 'account', 'back', 'code', 'that', 'of', 'please', 'again'])
const COUNT_AFTER = /^\s*(%|percent|failures?|declines?|transactions?|times|merchants?|accounts?|people|users?|days?|years?|passed|failed|yesterday|today)\b/i

type Cue = 'card' | 'ssn' | 'cvv'
const CUES: Array<[Cue, RegExp]> = [
  ['card', CARD_CUE],
  ['ssn', SSN_CUE],
  ['cvv', CVV_CUE]
]

interface Unit {
  digits: string
  start: number
  end: number
  /** Said digit by digit ("four", "double one", "4 1 1 1"): neighbouring ones group together. */
  spoken: boolean
  /** A time, date, decimal, version or IP: never part of a card. */
  compound: boolean
  /** A pause (punctuation or a filler word) before it. */
  pause: boolean
  /** Digits in the last part of a joined unit ("6789" in 123.45.6789). */
  tail: number
}

export interface Hit {
  start: number
  end: number
  label: string
  /** For a card: its digits, to catch it being read back. */
  digits?: string
}

/** Ranges never redacted, sorted: Markdown link and image targets, <autolinks>, web addresses, attachment paths. */
function protectedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const re of [/\]\([^)\n]*\)/g, /<[^>\s]+>/g, /\b[a-z][\w+.-]*:\/\/[^\s)]+/gi, /\battachments\/[^\s)]+/g]) {
    for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** Splits text into runs of digit groups, in one pass. */
function runs(text: string): Unit[][] {
  const guard = protectedRanges(text)
  let g = 0
  // Tokens arrive in order, so one pointer walks the protected ranges.
  const hidden = (i: number) => {
    while (g < guard.length && guard[g][1] <= i) g++
    return g < guard.length && guard[g][0] <= i
  }
  const out: Unit[][] = []
  let run: Unit[] = []
  let sepChars = 0 // separator characters since the last unit
  let fillers = 0 // filler words since the last unit
  let spaced = false // whitespace since the last unit
  let lastSep: { ch: string; at: number } | null = null
  let repeat: { n: number; start: number } | null = null
  const end = () => {
    if (run.length) out.push(run)
    run = []
    repeat = null
    sepChars = 0
    fillers = 0
    spaced = false
    lastSep = null
  }
  const add = (digits: string, start: number, stop: number, word = false) => {
    const pause = sepChars > 0 || fillers > 0
    // A lone numeral is a digit said on its own only without punctuation: "5, 4, 3" is a list.
    let spoken = word || (digits.length === 1 && !pause)
    if (repeat) {
      digits = digits.repeat(repeat.n)
      start = repeat.start
      repeat = null
      spoken = true
    }
    run.push({ digits, start, end: stop, spoken, compound: false, pause, tail: digits.length })
    sepChars = 0
    fillers = 0
    spaced = false
    lastSep = null
  }
  // Each alternative is a simple character class, so matching is linear.
  for (const m of text.matchAll(/(\d+)|([A-Za-z]+)|(\n)|([\t\p{Zs}​⁠]+)|(.)/gsu)) {
    const [tok, num, word, newline, space] = m
    const at = m.index!
    if (hidden(at)) {
      end()
      continue
    }
    if (num !== undefined) {
      const prev = run[run.length - 1]
      const sep = lastSep as { ch: string; at: number } | null
      // 12:30, 9/12/25, 87.67, 10.0.3.8 are one unit; 4111.1111.1111.1111 is a card read with periods.
      if (
        prev &&
        sep &&
        !repeat &&
        !spaced &&
        !prev.spoken &&
        sepChars === 1 &&
        sep.at === prev.end &&
        sep.at + 1 === at &&
        JOIN.has(sep.ch) &&
        !(sep.ch === '.' && prev.tail >= 4 && num.length >= 4)
      ) {
        prev.digits += num
        prev.end = at + num.length
        prev.compound = true
        prev.tail = num.length
        sepChars = 0
        lastSep = null
        continue
      }
      if (repeat && num.length !== 1) end()
      add(num, at, at + tok.length)
    } else if (word !== undefined) {
      const w = word.toLowerCase()
      if (w in WORDS) add(WORDS[w], at, at + tok.length, true)
      else if (w in REPEAT) {
        if (repeat) end()
        repeat = { n: REPEAT[w], start: at }
      } else if (run.length && !repeat && FILLER.has(w) && fillers < MAX_FILLERS) {
        fillers++
        spaced = true
      } else end()
    } else if (newline !== undefined) end()
    else if (space !== undefined) spaced = true
    else if (SEP.has(tok) && run.length && !repeat && sepChars < MAX_SEP) {
      sepChars++
      lastSep = { ch: tok, at }
    } else end()
  }
  end()
  return out
}

/**
 * Grouping that looks like a card read aloud. Digits said one at a time
 * count as one group ("four one one one 1111…" reads as 4-4-…).
 */
function cardShaped(units: Unit[]): boolean {
  if (units.some((u) => u.compound)) return false
  // One number, digits said one at a time, or read in pairs with only spaces between
  // ("38, 30, 29, 12…" with commas is a list of counts).
  if (units.length === 1 || units.every((u, k) => u.spoken || (u.digits.length <= 2 && (k === 0 || !u.pause)))) return true
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

/**
 * Whether a cue ends `before`: its last match is followed by no digits and at
 * most a few words (linking words only, unless `loose`, for the end of a
 * question someone asked).
 */
function cueEnds(before: string, re: RegExp, loose = false): boolean {
  let last: RegExpExecArray | null = null
  re.lastIndex = 0
  for (let m = re.exec(before); m; m = re.exec(before)) last = m
  if (!last) return false
  const tail = before.slice(last.index + last[0].length)
  if (/\d/.test(tail)) return false
  const words = tail.toLowerCase().match(/[a-z']+/g) ?? []
  if (words.length > 4) return false
  return loose || words.every((w) => LINK.has(w.replace(/'/g, '')))
}

export interface FindOptions {
  /** Cues asked for just before this text (a question on an earlier line): they count for its first words. */
  asked?: Set<Cue>
}

/** Card numbers, SSNs and security codes in a text, as character ranges. */
export function find(text: string, opts: FindOptions = {}): Hit[] {
  const hits: Hit[] = []
  for (const run of runs(text)) {
    const start = run[0].start
    const before = text.slice(Math.max(0, start - 80), start)
    // A question just before counts if only the answer's first few words come first.
    const lead = text.slice(0, start)
    const askedHere = (c: Cue) => !!opts.asked?.has(c) && !/\d/.test(lead) && (lead.match(/[a-z']+/gi) ?? []).length <= 4
    const cue = (c: Cue) => askedHere(c) || cueEnds(before, CUES.find(([k]) => k === c)![1])

    // Card: a stretch of whole groups (speech-to-text repeats or adds a group, so not necessarily all of them).
    let card: string | null = null
    for (let i = 0; i < run.length && !card; i++) {
      if (run[i].compound) continue
      let digits = ''
      for (let j = i; j < run.length; j++) {
        if (run[j].compound) break
        digits += run[j].digits
        if (digits.length > 19) break
        if (digits.length >= 13 && issuer(digits) && luhn(digits) && (cardShaped(run.slice(i, j + 1)) || (i === 0 && cue('card')))) {
          card = digits
          break
        }
      }
    }
    if (card) {
      // The whole run goes: what follows a card in one breath (an expiry, a CVV) is card data too.
      hits.push({ start, end: run[run.length - 1].end, label: '[card number]', digits: card })
      continue
    }
    hits.push(...ssnOrCode(text, run, cue))
  }
  return hits
}

/** SSNs and security codes in a run: the groups right after the cue, or a 3-2-4 SSN anywhere. */
function ssnOrCode(text: string, run: Unit[], cue: (c: Cue) => boolean): Hit[] {
  const hits: Hit[] = []
  const take = (from: number, to: number, label: string) => hits.push({ start: run[from].start, end: run[to].end, label })
  // 123-45-6789 / 123 45 6789 / 123.45.6789 anywhere in the run.
  for (let i = 0; i < run.length; i++) {
    const u = run[i]
    if (u.compound && /^\d{3}\.\d{2}\.\d{4}$/.test(text.slice(u.start, u.end))) take(i, i, '[SSN]')
    else if (
      i + 2 < run.length &&
      [run[i], run[i + 1], run[i + 2]].every((x) => !x.compound && !x.spoken) &&
      u.digits.length === 3 &&
      run[i + 1].digits.length === 2 &&
      run[i + 2].digits.length === 4
    ) {
      take(i, i + 2, '[SSN]')
      i += 2
    }
  }
  if (hits.length) return hits
  // After "SSN": the first groups from the start of the run that make 9 digits.
  if (cue('ssn')) {
    let n = 0
    for (let j = 0; j < run.length && !run[j].compound; j++) {
      n += run[j].digits.length
      if (n === 9) {
        take(0, j, '[SSN]')
        return hits
      }
      if (n > 9) break
    }
  }
  // After "CVV": skip an expiry (12/28), then the first group of 3-4 digits
  // (digits said one by one count as a group until a pause).
  if (cue('cvv')) {
    let i = 0
    while (i < run.length && run[i].compound) i++
    if (i < run.length) {
      let j = i
      let digits = run[i].digits
      if (run[i].spoken) {
        while (j + 1 < run.length && run[j + 1].spoken && !run[j + 1].pause) digits += run[++j].digits
      }
      if (digits.length === 3 || digits.length === 4) {
        const year = digits.length === 4 && /^(19|20)\d\d$/.test(digits)
        if (!year && !COUNT_AFTER.test(text.slice(run[j].end, run[j].end + 20))) take(i, j, '[security code]')
      }
    }
  }
  return hits
}

/** Replaces the hits in one forward pass. */
function apply(text: string, hits: Hit[]): string {
  if (!hits.length) return text
  const sorted = [...hits].sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const h of sorted) {
    if (h.start < at) continue // overlaps one already replaced
    out += text.slice(at, h.start) + h.label
    at = h.end
  }
  return out + text.slice(at)
}

const MAYBE = /[0-9]|zero|oh|one|two|three|four|five|six|seven|eight|nine/i

/** Redacts one piece of text: a line, a note, a summary. */
export function redact(text: string): string {
  if (!text || !MAYBE.test(text)) return text
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
/** Digits repeating part of a card heard this recently are a read-back. */
const ECHO_GAP = 60

/**
 * Redacts each line, then lines together:
 *  - the computer's audio as one stretch (all "Others" voices come from one
 *    track, and short digit pieces are often given to the wrong voice) and the
 *    note taker's mic as another, joining lines within 10 s, so a number read
 *    in groups with pauses, or repeated back group by group, is caught;
 *  - each line after a question asking for a card, SSN or security code in
 *    the 15 s before it, whoever asked;
 *  - digits repeating part of a card heard in the last minute (a read-back).
 * Lines were redacted one by one first, so these passes only add.
 */
export function redactLines<T extends Line>(lines: T[]): T[] {
  const out = lines.map((l) => ({ ...l }))
  const cards: Array<{ digits: string; at: number }> = []
  const note = (hits: Hit[], at: number) => hits.forEach((h) => h.digits && cards.push({ digits: h.digits, at }))
  for (const l of out) {
    if (!MAYBE.test(l.text)) continue
    const hits = find(l.text)
    note(hits, l.start)
    l.text = apply(l.text, hits)
  }
  const order = out.map((_, i) => i).sort((a, b) => out[a].start - out[b].start)
  for (const mine of [true, false]) {
    let group: number[] = []
    const flush = () => {
      if (group.length > 1) note(redactJoined(out, group), out[group[0]].start)
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
  // Answers to a question someone asked: "And the security code?" / "456."
  order.forEach((i, k) => {
    const line = out[i]
    if (!MAYBE.test(line.text)) return
    const asked = new Set<Cue>()
    for (let p = k - 1; p >= 0 && out[order[p]].end >= line.start - CUE_GAP; p--) {
      const q = out[order[p]].text
      for (const [c, re] of CUES) if (cueEnds(q, re, true)) asked.add(c)
      if (/\d/.test(q)) break // a number came in between: the question was answered
    }
    if (!asked.size) return
    const hits = find(line.text, { asked })
    note(hits, line.start)
    line.text = apply(line.text, hits)
  })
  // Read-backs: a group of 4+ digits that is part of a card heard in the last minute.
  if (cards.length) {
    for (const i of order) {
      const line = out[i]
      if (!/\d/.test(line.text)) continue
      const recent = cards.filter((c) => c.at <= line.start + JOIN_GAP && line.start - c.at <= ECHO_GAP)
      if (!recent.length) continue
      const hits: Hit[] = []
      for (const run of runs(line.text)) {
        const digits = run.map((u) => u.digits).join('')
        if (digits.length >= 4 && !run.some((u) => u.compound) && recent.some((c) => c.digits.includes(digits))) {
          hits.push({ start: run[0].start, end: run[run.length - 1].end, label: '[card number]' })
        }
      }
      line.text = apply(line.text, hits)
    }
  }
  return out
}

/** Finds numbers that only show when lines are read together, and redacts each line's part. */
function redactJoined(lines: Line[], group: number[]): Hit[] {
  let joined = ''
  const at: number[] = []
  for (const i of group) {
    if (joined) joined += ' '
    at.push(joined.length)
    joined += lines[i].text
  }
  const hits = find(joined)
  if (!hits.length) return hits
  group.forEach((i, k) => {
    const from = at[k]
    const to = from + lines[i].text.length
    const local = hits
      .filter((h) => h.start < to && h.end > from)
      .map((h) => ({ start: Math.max(0, h.start - from), end: Math.min(lines[i].text.length, h.end - from), label: h.label }))
    if (local.length) lines[i].text = apply(lines[i].text, local)
  })
  return hits
}
