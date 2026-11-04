import { normName, normTag, type RelatedNote } from '@shared/types'

/**
 * Finding notes on the same topic as a call, on this PC and without a model:
 * shared tags, similar titles, the same people, links between them, and the
 * call's most telling words turning up. Only titles, tags, names and word
 * counts are kept per note, never its text, so a big vault stays cheap.
 */

/** A note as read for ranking: from its front matter, or from Kasha's own record of a meeting. */
export interface ParsedNote {
  title: string
  date: string | null
  tags: string[]
  people: string[]
  links: string[]
  body: string
}

/** What ranking needs from a note. */
export interface NoteProfile {
  key: string
  title: string
  date: string | null
  tags: Set<string>
  /** normName'd */
  people: Set<string>
  /** Link targets, lowercased. */
  links: Set<string>
  /** How often each of the call's candidate words is in it. */
  hits: Map<string, number>
  meetingId?: string
}

/** The call the question is about. */
export interface CallProfile {
  title: string
  /** Its own tags, without the standing ones every note gets. */
  tags: string[]
  /** Who was invited, in the call or named, as written. */
  people: string[]
  /** Its notes and transcript. */
  text: string
  links: string[]
}

// Common words of four letters or more that say nothing about a topic, and words every meeting note has.
const STOP = new Set(
  `about above actually after again against agenda alright also although always among another anyone anything anyway around asked
  away back basically because been before being below between both bring call called calls came can't cannot come coming could
  couldn't decided decisions didn't does doesn't doing done don't down during each either else enough even ever every everyone
  everything exactly fine first from gets getting give given going gonna good gotta great guys hadn't happen happened hasn't have
  haven't having hear heard hello here hey he's hi how's i'll i'm i've into isn't it'll it's just keep kind know last later least
  less let's like likely little long look looking looks lot lots made make makes making many maybe mean means meeting meetings
  might mine more most much must myself need needs never next nice nobody none nothing notes okay once only other others ours
  over part people perfect pretty probably quick quite rather really right said same saying says seem seems sense should shouldn't
  show since some someone something sometimes soon sorry sort speaker still stuff such summary super sure take taken taking talk
  talked talking tell than thank thanks that that's their theirs them then there there's these they they'll they're they've thing
  things think thinking this those though thought through time times today together tomorrow took totally transcript true trying
  under until upon used using very wait wanna want wanted wants wasn't week weeks well we'll went we're were weren't we've what
  what's whatever when where whether which while who's whole whose will with within without won't wonder work works would
  wouldn't yeah year years yesterday you'd you'll your you're yours yourself you've`.split(/\s+/)
)

/**
 * Lowercase words of four letters or more, stop words left out. A plural
 * "s" is dropped, so "disputes" and "dispute" are one word ("status",
 * "analysis" and "process" keep theirs).
 */
export function words(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/\p{L}[\p{L}\p{N}'’-]{3,}/gu)) {
    const w = m[0].replace(/’/g, "'").replace(/'s$/, '').replace(/['-]+$/, '')
    if (w.length >= 4 && !STOP.has(w)) out.push(w.length > 4 ? w.replace(/([^siu'])s$/, '$1') : w)
  }
  return out
}

const unquote = (v: string): string => {
  const t = v.trim()
  if (/^".*"$/.test(t)) {
    try {
      return String(JSON.parse(t))
    } catch {
      return t.slice(1, -1)
    }
  }
  return /^'.*'$/.test(t) ? t.slice(1, -1) : t
}

/** Reads a note's front matter, #tags and [[links]]. The title falls back to the file name. */
export function parseNote(text: string, fileName: string): ParsedNote {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  const head = fm?.[1] ?? ''
  const body = fm ? text.slice(fm[0].length) : text
  const line = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(head)
  const scalar = (name: string): string | null => {
    const m = line(name)
    return m && m[1].trim() ? unquote(m[1]) : null
  }
  const list = (name: string): string[] => {
    const m = line(name)
    if (!m) return []
    const v = m[1].trim()
    if (!v) {
      // A YAML block list: "tags:" then "  - one" lines.
      const block = /^(?:\r?\n[ \t]*-[ \t]*.*)+/.exec(head.slice(m.index + m[0].length))
      return block ? block[0].split(/\r?\n/).map((l) => unquote(l.replace(/^[ \t]*-[ \t]*/, ''))).filter(Boolean) : []
    }
    return (v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v).split(',').map(unquote).filter(Boolean)
  }
  const name = fileName.replace(/\.md$/i, '')
  const date = scalar('date')?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? name.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null
  const inline = Array.from(body.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu), (m) => m[1])
  const tags = [...list('tags'), ...list('tag'), ...inline].map(normTag).filter(Boolean)
  const links = Array.from(body.matchAll(/\[\[([^\]|#^]+)/g), (m) => m[1].trim().split('/').pop()!.replace(/\.md$/i, ''))
  return {
    title: scalar('title') ?? name,
    date,
    tags: [...new Set(tags)],
    people: [...list('attendees'), ...list('people')],
    links,
    body
  }
}

/** The call's words, most frequent first: the ones a related note may share. */
export function candidates(call: CallProfile, max = 300): Map<string, number> {
  const tf = new Map<string, number>()
  for (const w of words(`${call.title} ${call.title} ${call.text}`)) tf.set(w, (tf.get(w) ?? 0) + 1)
  return new Map([...tf].sort((a, b) => b[1] - a[1]).slice(0, max))
}

/** Keeps what ranking needs from a note: its tags, people, links and how often the call's words appear. */
export function profileNote(key: string, note: ParsedNote, cands: Map<string, number>, meetingId?: string): NoteProfile {
  const hits = new Map<string, number>()
  for (const w of words(`${note.title} ${note.body}`)) if (cands.has(w)) hits.set(w, (hits.get(w) ?? 0) + 1)
  return {
    key,
    title: note.title,
    date: note.date,
    tags: new Set(note.tags.map(normTag).filter(Boolean)),
    people: new Set(note.people.map(normName).filter(Boolean)),
    links: new Set(note.links.map((l) => l.toLowerCase())),
    hits,
    meetingId
  }
}

const TAG = 3 // per shared tag
const TITLE = 2 // per shared title word that isn't in every title
const PERSON = 1.5 // per person in both, up to three
const LINK = 3 // one links to the other
const WORD = 1.5 // per telling word of the call's it mentions twice or more (less for a common one)
const WORDS = 6 // at most, from words
const KEYWORDS = 20
const ENOUGH = 2

/**
 * The notes most likely on the same topic, best first, each with why.
 * `generic` tags (on every note, like "meeting") and the note taker (`me`,
 * at every meeting) say nothing about the topic and don't count.
 */
export function rank(
  call: CallProfile,
  cands: Map<string, number>,
  notes: NoteProfile[],
  opts: { generic?: string[]; me?: string; limit?: number } = {}
): RelatedNote[] {
  const n = notes.length
  if (!n) return []
  const idf = (df: number) => Math.log((n + 1) / (df + 1))
  const me = normName(opts.me ?? '')

  // Tags on most notes are as generic as the standing ones.
  const tagDf = new Map<string, number>()
  for (const note of notes) for (const t of note.tags) tagDf.set(t, (tagDf.get(t) ?? 0) + 1)
  const generic = new Set((opts.generic ?? []).map(normTag))
  const tags = call.tags.map(normTag).filter((t) => t && !generic.has(t) && !(n >= 10 && (tagDf.get(t) ?? 0) / n > 0.3))

  // Title words in a third of all titles ("weekly", "sync") don't count either.
  const titleDf = new Map<string, number>()
  const titleWords = new Map(notes.map((note) => [note, new Set(words(note.title))]))
  for (const ws of titleWords.values()) for (const w of ws) titleDf.set(w, (titleDf.get(w) ?? 0) + 1)
  const callTitle = [...new Set(words(call.title))].filter((w) => !(n >= 10 && (titleDf.get(w) ?? 0) / n > 0.35))

  const people = new Map(call.people.map((p) => [normName(p), p.trim()] as const).filter(([k]) => k && k !== me && !k.includes('@')))
  const links = new Set(call.links.map((l) => l.toLowerCase()))
  const title = call.title.trim().toLowerCase()

  // The call's telling words: frequent in it, in few other notes, but in at least one.
  const df = new Map<string, number>()
  for (const note of notes) for (const w of note.hits.keys()) df.set(w, (df.get(w) ?? 0) + 1)
  const keywords = [...cands]
    .filter(([w]) => (df.get(w) ?? 0) >= 1 && (n < 10 || (df.get(w) ?? 0) / n <= 0.25))
    .map(([w, tf]) => ({ w, weight: tf * idf(df.get(w) ?? 0), idf: idf(df.get(w) ?? 0) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, KEYWORDS)
  // A word in just one other note counts in full; one in more notes, less.
  const rarest = idf(1)
  const rarity = (k: { idf: number }) => (rarest > 0 ? k.idf / rarest : 1)

  const scored: Array<RelatedNote & { score: number }> = []
  for (const note of notes) {
    let score = 0
    const why: string[] = []
    const sharedTags = tags.filter((t) => note.tags.has(t))
    score += TAG * sharedTags.length
    why.push(...sharedTags.slice(0, 2).map((t) => `#${t}`))

    const sharedTitle = callTitle.filter((w) => titleWords.get(note)!.has(w))
    score += TITLE * sharedTitle.length
    if (sharedTitle.length) why.push('Similar title')

    const sharedPeople = [...people].filter(([k]) => note.people.has(k))
    score += PERSON * Math.min(3, sharedPeople.length)
    if (sharedPeople.length === 1) why.push(`${sharedPeople[0][1]} was there`)
    else if (sharedPeople.length > 1) why.push(`${sharedPeople.length} of the same people`)

    if ((title && note.links.has(title)) || links.has(note.title.toLowerCase())) {
      score += LINK
      why.push('Linked')
    }

    const found = keywords.filter((k) => note.hits.has(k.w))
    score += Math.min(WORDS, found.reduce((t, k) => t + WORD * rarity(k) * Math.min(1, note.hits.get(k.w)! / 2), 0))
    if (found.length >= 2) why.push(`Mentions ${found.slice(0, 2).map((k) => k.w).join(', ')}`)

    if (score >= ENOUGH) {
      scored.push({ key: note.key, title: note.title, date: note.date, why: why.slice(0, 3), meetingId: note.meetingId, score })
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, opts.limit ?? 8)
    .map(({ score: _, ...r }) => r)
}

/** Notes whose title has every word typed, newest first. */
export function matchTitles<T extends { title: string; date: string | null }>(notes: T[], query: string, limit = 8): T[] {
  const want = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!want.length) return []
  return notes
    .filter((n) => {
      const t = n.title.toLowerCase()
      return want.every((w) => t.includes(w))
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, limit)
}
