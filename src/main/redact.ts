/**
 * PCI: card numbers must not be stored or sent anywhere, and neither should
 * SSNs or card security codes. Everything Kasha writes to disk goes through
 * here (store.ts), and text is redacted again where it leaves the app
 * (summary prompts, Obsidian, shared copies).
 *
 * Speech-to-text writes read-out numbers in many shapes: "4111 1111 1111
 * 1111", "4111, 1111, 1111, 1111.", "4111.1111…", or as words ("four one one
 * one", "double four"), and a number read in groups with pauses lands on
 * several lines. So digits are found as runs of digit groups and number words
 * with light punctuation between them, and lines are also checked together.
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

/**
 * Speech-to-text often adds or repeats a group ("4111 1111 1111 1111 1111"),
 * so a run counts if any 13-19 digit stretch in it passes Luhn. With
 * `strict`, the stretch must also start like a payment card (2-6), for runs
 * joined across lines, where unrelated numbers are more likely.
 */
function containsCard(digits: string, strict = false): boolean {
  for (let len = 13; len <= Math.min(19, digits.length); len++) {
    for (let i = 0; i + len <= digits.length; i++) {
      if (strict && !/[2-6]/.test(digits[i])) continue
      if (luhn(digits.slice(i, i + len))) return true
    }
  }
  return false
}

const WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9'
}
const WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)'
// One unit of a read-out number: digits, a number word, or "double/triple" one of them.
const UNIT = `(?:(?:double|triple)\\s+(?:\\d|${WORD})|\\d+|${WORD})`
// Between units: spaces, commas, periods, dashes or slashes, a few at most.
const GAP = '[\\s,.\\-/]{0,3}'
const RUN = new RegExp(`(?<![\\p{L}\\d])${UNIT}(?:${GAP}${UNIT})*(?![\\p{L}\\d])`, 'giu')

/** The digits a run stands for: words become digits, "double four" becomes 44. */
function digitsOf(run: string): string {
  return run
    .toLowerCase()
    .replace(new RegExp(`(double|triple)\\s+(\\d|${WORD})`, 'g'), (_m, n: string, d: string) => (WORDS[d] ?? d).repeat(n === 'double' ? 2 : 3))
    .replace(new RegExp(WORD, 'g'), (w) => WORDS[w])
    .replace(/\D/g, '')
}

/** A run of number words alone is only a number if it has several words ("one" in a sentence isn't). */
const wordy = (run: string) => !/\d/.test(run)

interface Hit {
  start: number
  end: number
  label: string
}

const SSN_CUE = /\b(social|ssn|social security( number)?)\b[^\n]{0,30}$/i
const CVV_CUE = /\b(cvv2?|cvc|cv2|security code|card verification( code| value)?)\b[^\n]{0,20}$/i

/** Card numbers, SSNs and security codes in a text, as character ranges. */
function find(text: string, strict = false): Hit[] {
  const hits: Hit[] = []
  for (const m of text.matchAll(RUN)) {
    const run = m[0]
    const start = m.index!
    const digits = digitsOf(run)
    if (wordy(run) && digits.length < 3) continue
    const before = text.slice(Math.max(0, start - 40), start)
    if (digits.length >= 13 && containsCard(digits, strict)) hits.push({ start, end: start + run.length, label: '[card number]' })
    // 123-45-6789 with any separator, or nine digits right after "social"/"SSN".
    else if (/^\d{3}\D{1,3}\d{2}\D{1,3}\d{4}$/.test(run.trim()) || (digits.length === 9 && SSN_CUE.test(before)))
      hits.push({ start, end: start + run.length, label: '[SSN]' })
    else if ((digits.length === 3 || digits.length === 4) && CVV_CUE.test(before)) hits.push({ start, end: start + run.length, label: '[security code]' })
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
  if (!text || !/\d|zero|oh|one|two|three|four|five|six|seven|eight|nine/i.test(text)) return text
  return apply(text, find(text))
}

interface Line {
  start: number
  end: number
  speaker: string
  text: string
}

/** Lines of one speaker this close together are read as one stretch. */
const JOIN_GAP = 10

/**
 * Redacts each line, then the lines of each speaker together: a number read
 * in groups with pauses ("4111 1111…", "…1111 1111") is split across lines,
 * and no single line holds enough digits to tell it's a card.
 */
export function redactLines<T extends Line>(lines: T[]): T[] {
  const out = lines.map((l) => ({ ...l, text: redact(l.text) }))
  const bySpeaker = new Map<string, number[]>()
  out.forEach((l, i) => bySpeaker.set(l.speaker, [...(bySpeaker.get(l.speaker) ?? []), i]))
  for (const idx of bySpeaker.values()) {
    // Stretches of this speaker's lines with short gaps between them.
    let group: number[] = []
    const flush = () => {
      if (group.length > 1) redactGroup(out, group)
      group = []
    }
    for (const i of idx) {
      const prev = group.length ? out[group[group.length - 1]] : null
      if (prev && out[i].start - prev.end > JOIN_GAP) flush()
      group.push(i)
    }
    flush()
  }
  return out
}

function redactGroup(lines: Line[], group: number[]): void {
  // Join the lines with a space, remembering where each one starts.
  let joined = ''
  const at: number[] = []
  for (const i of group) {
    if (joined) joined += ' '
    at.push(joined.length)
    joined += lines[i].text
  }
  const hits = find(joined, true).filter((h) => {
    // Only hits that cross a line boundary: the rest were handled line by line.
    const first = at.findLastIndex((s) => s <= h.start)
    const last = at.findLastIndex((s) => s < h.end)
    return first !== last
  })
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
