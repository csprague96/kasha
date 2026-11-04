import { ArrowUp, Check, Copy, Loader2, NotebookPen, Plus, Search, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AskAnswer, Meeting, RelatedNote, Settings } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

interface Props {
  meeting: Meeting
  settings: Settings
}

interface Turn {
  question: string
  answer?: AskAnswer
  error?: string
}

/** What was found and asked for each note, kept while Kasha runs so switching tabs or notes loses nothing. */
interface AskState {
  related: RelatedNote[] | null
  /** Keys of the notes that go with the question. */
  picked: string[]
  turns: Turn[]
}

const EMPTY: AskState = { related: null, picked: [], turns: [] }
const saved = new Map<string, AskState>()
const listeners = new Set<() => void>()

/** Changes a note's Ask state. An answer that arrives after the user moved on still lands in its thread. */
function update(id: string, fn: (s: AskState) => AskState): void {
  saved.set(id, fn(saved.get(id) ?? EMPTY))
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** How many related notes are ticked to start with. */
const PICKED_FIRST = 5

const ENGINE = { claude: 'Claude Code', codex: 'Codex' } as const

const STARTERS = ['What’s the history of this topic?', 'What was decided, across these notes?', 'What’s still open, and who has it?']

function shortDate(d: string | null): string {
  if (!d) return ''
  const date = new Date(`${d}T12:00:00`)
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

/** An answer's text: paragraphs and "- " lists, with [[Title]] citations that open the note. */
function AnswerText({ text, sources }: { text: string; sources: RelatedNote[] }) {
  const cite = (s: string, key: number): ReactNode => {
    const parts = s.split(/\[\[([^\]]+)\]\]/g)
    return parts.map((p, i) => {
      if (i % 2 === 0) return <Fragment key={`${key}-${i}`}>{p}</Fragment>
      const note = sources.find((n) => n.title.toLowerCase() === p.trim().toLowerCase())
      if (!note) {
        return (
          <span key={`${key}-${i}`} className="rounded bg-foreground/5 px-1 text-[13px] text-muted">
            {p}
          </span>
        )
      }
      return (
        <button
          key={`${key}-${i}`}
          onClick={() => void window.kasha.openNote(note.key)}
          title={note.meetingId ? 'Open this note in Kasha' : 'Open this note in Obsidian'}
          className="rounded bg-primary/10 px-1 text-[13px] text-primary hover:underline"
        >
          {p}
        </button>
      )
    })
  }
  // Runs of "- " lines are lists, other runs paragraphs, so "In date order:" and its list each come out right.
  const blocks: Array<{ list: boolean; lines: string[] }> = []
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      blocks.push({ list: false, lines: [] })
      continue
    }
    const list = /^\s*[-*] /.test(line)
    const last = blocks[blocks.length - 1]
    if (last && last.list === list && last.lines.length) last.lines.push(list ? line.replace(/^\s*[-*] /, '') : line)
    else blocks.push({ list, lines: [list ? line.replace(/^\s*[-*] /, '') : line] })
  }
  return (
    <div className="flex flex-col gap-2.5 text-[15px] leading-relaxed">
      {blocks
        .filter((b) => b.lines.length)
        .map((b, i) =>
          b.list ? (
            <ul key={i} className="-mt-1 flex list-disc flex-col gap-1 pl-5">
              {b.lines.map((l, j) => (
                <li key={j}>{cite(l, j)}</li>
              ))}
            </ul>
          ) : (
            <p key={i} className="whitespace-pre-line">
              {cite(b.lines.join('\n'), i)}
            </p>
          )
        )}
    </div>
  )
}

/** An answer, with keeping it in the note and copying it. */
function TurnView({ meeting, turn }: { meeting: Meeting; turn: Turn }) {
  const [done, setDone] = useState<'added' | 'copied' | null>(null)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 2500)
    return () => window.clearTimeout(t)
  }, [done])
  const a = turn.answer
  // Citations go in as italics: the note editor would escape [[links]]. "This call" is the note itself.
  const forNote = a
    ? `**Asked:** ${turn.question}\n\n${a.answer.replace(/\[\[This call\]\]/gi, '*this call*').replace(/\[\[([^\]]+)\]\]/g, '*$1*')}`
    : ''
  return (
    <li className="flex scroll-mt-4 flex-col gap-3">
      <p className="self-end rounded-lg bg-foreground/5 px-3 py-2 text-[15px] whitespace-pre-line">{turn.question}</p>
      {turn.error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{turn.error}</p>}
      {!a && !turn.error && <Thinking />}
      {a && (
        <>
          <AnswerText text={a.answer} sources={a.sources} />
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                void window.kasha.appendToNote(meeting.id, forNote)
                setDone('added')
              }}
              title="Adds the question and answer to the end of the note"
            >
              {done === 'added' ? <Check /> : <NotebookPen />}
              {done === 'added' ? 'Added to notes' : 'Add to notes'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => {
                void navigator.clipboard.writeText(a.answer)
                setDone('copied')
              }}
            >
              {done === 'copied' ? <Check /> : <Copy />}
              {done === 'copied' ? 'Copied' : 'Copy'}
            </Button>
            <span className="ml-1">
              {ENGINE[a.engine]}
              {a.sources.length ? ` · from this call and ${a.sources.length === 1 ? '1 note' : `${a.sources.length} notes`}` : ' · from this call'}
            </span>
          </div>
        </>
      )}
    </li>
  )
}

/** Waiting for an answer, which takes from a few seconds to a minute. */
function Thinking() {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <p className="inline-flex items-center gap-2 text-[13px] text-muted" role="status">
      <Loader2 className="size-4 animate-spin" />
      <span className="tabular">Reading the notes… {secs >= 5 ? `${secs} s` : ''}</span>
    </p>
  )
}

/** Adds a note the search didn't offer, by its title. */
function AddNote({ meeting, onAdd }: { meeting: Meeting; onAdd: (n: RelatedNote) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<RelatedNote[]>([])
  useEffect(() => {
    if (!q.trim()) {
      setFound([])
      return
    }
    const t = window.setTimeout(() => void window.kasha.findNotes(meeting.id, q).then(setFound), 250)
    return () => window.clearTimeout(t)
  }, [q, meeting.id])
  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="h-7 px-2 text-primary" onClick={() => setOpen(true)}>
        <Plus />
        Add a note
      </Button>
    )
  }
  return (
    <div className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-primary bg-background px-2">
        <Search className="size-3.5 shrink-0 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Note title"
          aria-label="Find a note by title"
          className="w-48 bg-transparent text-[13px] outline-none"
        />
        <button onClick={() => setOpen(false)} aria-label="Close" className="rounded text-muted hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      {found.length > 0 && (
        <ul className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-border bg-surface p-1 shadow-md">
          {found.map((n) => (
            <li key={n.key}>
              <button
                onClick={() => {
                  onAdd(n)
                  setQ('')
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-[13px] hover:bg-sidebar"
              >
                <span className="truncate">{n.title}</span>
                <span className="shrink-0 text-xs text-muted">{shortDate(n.date)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim() && !found.length && <p className="absolute right-0 mt-1 text-xs text-muted">No note with that in its title.</p>}
    </div>
  )
}

/**
 * Ask about a call. Kasha looks through the Obsidian vault (or its own notes)
 * for ones on the same topic and lists them, with why; the ticked ones go to
 * Claude Code with the call, so an answer can pull them together.
 */
export function Ask({ meeting, settings }: Props) {
  const id = meeting.id
  const state = useSyncExternalStore(subscribe, () => saved.get(id) ?? EMPTY)
  const [draft, setDraft] = useState('')
  const busy = state.turns.some((t) => !t.answer && !t.error)
  const thread = useRef<HTMLOListElement>(null)

  // Looks for related notes the first time the tab opens for this note.
  useEffect(() => {
    if (saved.get(id)?.related) return
    void window.kasha
      .relatedNotes(id)
      .catch(() => [])
      .then((related) => update(id, (s) => (s.related ? s : { ...s, related, picked: related.slice(0, PICKED_FIRST).map((n) => n.key) })))
  }, [id])

  const toggle = (key: string) => update(id, (s) => ({ ...s, picked: s.picked.includes(key) ? s.picked.filter((k) => k !== key) : [...s.picked, key] }))
  const add = (n: RelatedNote) =>
    update(id, (s) => ({
      ...s,
      related: s.related?.some((r) => r.key === n.key) ? s.related : [...(s.related ?? []), { ...n, why: ['Added by you'] }],
      picked: s.picked.includes(n.key) ? s.picked : [...s.picked, n.key]
    }))

  const send = (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    setDraft('')
    const history = state.turns.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer!.answer }))
    const index = state.turns.length
    const settle = (patch: Partial<Turn>) => update(id, (s) => ({ ...s, turns: s.turns.map((t, i) => (i === index ? { ...t, ...patch } : t)) }))
    update(id, (s) => ({ ...s, turns: [...s.turns, { question }] }))
    window.kasha
      .ask(meeting.id, question, state.picked, history)
      .then((answer) => settle({ answer }))
      .catch((e: Error) => settle({ error: String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
  }

  // A new question, and its answer when it comes, are read from the top.
  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    thread.current?.lastElementChild?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
  }, [state.turns.length, busy])

  const related = state.related
  const vault = !!settings.obsidian.vault
  return (
    <div className="flex max-w-[80ch] flex-col gap-6">
      <section className="flex flex-col gap-2" aria-label="Notes that go with your question">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] text-muted">
            {related === null
              ? vault
                ? 'Looking through your Obsidian vault for notes on the same topic…'
                : 'Looking through your Kasha notes for ones on the same topic…'
              : related.length
                ? `Related notes · the ticked ones go with your question, along with this call`
                : vault
                  ? 'No related notes found in your vault. Add one by its title, or ask about this call alone.'
                  : 'No related Kasha notes found. Add one by its title, or ask about this call alone.'}
          </h2>
          <AddNote meeting={meeting} onAdd={add} />
        </div>
        {related === null && <Loader2 className="size-4 animate-spin text-muted" aria-hidden="true" />}
        {!!related?.length && (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
            {related.map((n) => {
              const on = state.picked.includes(n.key)
              return (
                <li key={n.key} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                    checked={on}
                    onChange={() => toggle(n.key)}
                    aria-label={`Include ${n.title}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <button
                      onClick={() => void window.kasha.openNote(n.key)}
                      title={n.meetingId ? 'Open in Kasha' : 'Open in Obsidian'}
                      className={cn('truncate text-left hover:underline', !on && 'text-muted')}
                    >
                      {n.title}
                    </button>
                    {n.why.length > 0 && <span className="truncate text-xs text-muted">{n.why.join(' · ')}</span>}
                  </div>
                  <span className="tabular shrink-0 pt-px text-xs text-muted">{shortDate(n.date)}</span>
                </li>
              )
            })}
          </ul>
        )}
        {!vault && related !== null && (
          <p className="text-xs text-muted">Choose your Obsidian vault in Settings to search all of your notes, not just Kasha’s.</p>
        )}
      </section>

      {state.turns.length > 0 && (
        <ol ref={thread} className="flex flex-col gap-8">
          {state.turns.map((t, i) => (
            <TurnView key={i} meeting={meeting} turn={t} />
          ))}
        </ol>
      )}

      <div className="sticky bottom-0 -mx-2 bg-background px-2 pt-2 pb-6">
        {!state.turns.length && (
          <div className="mb-2 flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <Button key={s} size="sm" disabled={related === null} onClick={() => send(s)}>
                {s}
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-border bg-surface p-2 focus-within:border-primary">
          <textarea
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(draft)
              }
            }}
            placeholder={state.turns.length ? 'Ask a follow-up' : 'Ask about this call and the ticked notes'}
            aria-label="Question"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1 text-[15px] outline-none [field-sizing:content]"
          />
          <Button variant="primary" size="icon" disabled={!draft.trim() || busy || related === null} onClick={() => send(draft)} aria-label="Ask">
            <ArrowUp />
          </Button>
        </div>
        <p className="mt-1.5 px-1 text-xs text-muted">
          Sent to {settings.summaryEngine === 'codex' ? 'Codex' : settings.summaryEngine === 'claude' ? 'Claude Code' : 'Claude Code (or Codex)'} with your own sign-in: this call
          and the ticked notes, with card numbers and SSNs taken out. Answers aren’t saved unless you add them to the note.
        </p>
      </div>
    </div>
  )
}
