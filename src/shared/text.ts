import type { VocabularyEntry } from './types'

export interface FindOptions {
  matchCase: boolean
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whole-word matcher for find and replace. Spaces in the search match any run
 * of whitespace. Returns null for an empty search.
 */
export function findPattern(find: string, opts: FindOptions): RegExp | null {
  const words = find.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const body = words.map(escape).join('\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, `g${opts.matchCase ? '' : 'i'}u`)
}

export function countMatches(text: string, re: RegExp | null): number {
  if (!re) return 0
  re.lastIndex = 0
  return text.match(re)?.length ?? 0
}

/** Replaces misheard forms with the right spelling, and fixes the casing of the term itself. */
export function applyVocabulary(text: string, vocabulary: VocabularyEntry[]): string {
  const rules = vocabulary
    .flatMap((v) => [v.term, ...v.heardAs].map((from) => ({ from, to: v.term })))
    .filter((r) => r.from.trim() && r.to.trim())
    // Longest first, so "Oleksandra Kovalkuk" is fixed before "Kovalkuk".
    .sort((a, b) => b.from.length - a.from.length)
  let out = text
  for (const r of rules) {
    const re = findPattern(r.from, { matchCase: false })
    const to = r.to.trim()
    if (re) out = out.replace(re, () => to)
  }
  return out
}
