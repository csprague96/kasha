/**
 * PCI: card numbers must not be stored or sent anywhere. Transcripts are
 * redacted before they are written to disk or passed to Claude.
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

// A run of 13+ digits, optionally grouped by spaces or dashes.
const DIGIT_RUN = /\b\d(?:[ -]?\d){12,}\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g

/**
 * Speech-to-text often adds or repeats a group ("4111 1111 1111 1111 1111"),
 * so the whole run is redacted if any 13–19 digit stretch in it passes Luhn.
 */
function containsCard(digits: string): boolean {
  for (let len = 13; len <= Math.min(19, digits.length); len++) {
    for (let i = 0; i + len <= digits.length; i++) {
      if (luhn(digits.slice(i, i + len))) return true
    }
  }
  return false
}

export function redact(text: string): string {
  return text
    .replace(DIGIT_RUN, (m) => (containsCard(m.replace(/\D/g, '')) ? '[card number]' : m))
    .replace(SSN, '[SSN]')
}
