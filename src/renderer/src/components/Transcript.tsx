import { Check, Pencil, Replace, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { countMatches, findPattern } from '@shared/text'
import { speakerName, type Meeting, type SpeakerId, type TranscriptSegment } from '@shared/types'
import { clock, cn } from '@/lib/utils'
import { CorrectWord, wordAtPoint, type WordAt } from './CorrectWord'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './ui/popover'

interface Props {
  meeting: Meeting
  segments: TranscriptSegment[]
  note: string
  live: boolean // lines are still arriving
  liveEnabled: boolean
  /** Saves edited lines. Undefined while the transcript can't be changed. */
  onSave?: (segs: TranscriptSegment[]) => void
  /** The transcript and note changed on disk and should be reloaded. */
  onReplaced: () => void
}

function highlight(text: string, re: RegExp | null): ReactNode {
  if (!re) return text
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index))
    out.push(
      <mark key={m.index} className="rounded-sm bg-primary/15 text-foreground">
        {m[0]}
      </mark>
    )
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return out
}

// ---------- Speakers ----------

/**
 * Names to offer for a speaker, one click each: people Teams showed in the
 * call, then invitees (some only as an address), leaving out names other
 * speakers already have.
 */
function nameChoices(id: SpeakerId, meeting: Meeting, typed: string): Array<{ name: string; from: string }> {
  const key = (n: string) => n.trim().toLowerCase()
  const used = new Set(
    Object.entries(meeting.speakers ?? {})
      .filter(([k, v]) => k !== id && v && !meeting.speakerGuesses?.[k as SpeakerId])
      .map(([, v]) => key(v!))
  )
  const out: Array<{ name: string; from: string }> = []
  const seen = new Set<string>()
  const add = (name: string, from: string) => {
    const k = key(name)
    if (!k || used.has(k) || seen.has(k)) return
    seen.add(k)
    out.push({ name, from })
  }
  for (const p of meeting.participants ?? []) add(p, 'In the call')
  for (const a of meeting.attendees ?? []) add(a, 'Invited')
  const t = key(typed)
  return (t ? out.filter((c) => key(c.name).includes(t)) : out).slice(0, 12)
}

function SpeakerChip({ id, meeting }: { id: SpeakerId; meeting: Meeting }) {
  const [editing, setEditing] = useState(false)
  const name = speakerName(id, meeting.speakers)
  const given = meeting.speakers?.[id]?.trim() ?? ''
  const [value, setValue] = useState(given)
  const [active, setActive] = useState(-1) // highlighted choice, for the keyboard
  const listId = useId()
  // One save per edit: Enter or a click closes the box, and a blur after that mustn't save again.
  const saved = useRef(false)
  useEffect(() => setValue(given), [given])
  useEffect(() => {
    if (editing) saved.current = false
  }, [editing])

  /**
   * Saves a name. A guess is only confirmed (and its voice learned) by an
   * explicit choice: picking the guessed name in the list, or the ✓ button.
   * Leaving the box, or Enter, with the name unchanged is just a cancel.
   */
  const save = (v: string, picked = false) => {
    if (saved.current) return
    saved.current = true
    setEditing(false)
    setActive(-1)
    if (meeting.speakerGuesses?.[id] && v && v === given) {
      if (picked) void window.kasha.updateMeeting(meeting.id, { confirmSpeaker: id })
      return
    }
    const next = { ...meeting.speakers }
    // Clearing the name, or typing the default, goes back to "Speaker 2".
    if (v && v !== speakerName(id)) next[id] = v
    else delete next[id]
    if ((next[id] ?? '') !== (meeting.speakers?.[id] ?? '')) void window.kasha.updateMeeting(meeting.id, { speakers: next })
  }
  const commit = () => save(value.trim())

  if (editing) {
    const choices = nameChoices(id, meeting, value === given ? '' : value)
    const optionId = (i: number) => `${listId}-${i}`
    return (
      <Popover open>
        <PopoverAnchor asChild>
          <input
            autoFocus
            role="combobox"
            aria-expanded={choices.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 && active < choices.length ? optionId(active) : undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setActive(-1)
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && choices.length) {
                e.preventDefault()
                setActive((i) => (i + 1) % choices.length)
              } else if (e.key === 'ArrowUp' && choices.length) {
                e.preventDefault()
                setActive((i) => (i <= 0 ? choices.length - 1 : i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (active >= 0 && active < choices.length) save(choices[active].name, true)
                else commit()
              } else if (e.key === 'Escape') {
                setValue(given)
                setActive(-1)
                setEditing(false)
              }
            }}
            aria-label={`Name for ${name}`}
            placeholder={`Name for ${speakerName(id)}`}
            className="h-7 w-48 rounded-md border border-primary bg-surface px-2 text-[13px] focus-visible:outline-offset-0"
          />
        </PopoverAnchor>
        {choices.length > 0 && (
          <PopoverContent align="start" className="w-64 p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
            <ul id={listId} role="listbox" aria-label="Choose a name">
              {choices.map((c, i) => (
                <li
                  key={c.name}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  // Keeps the typing box from saving first, on blur.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => save(c.name, true)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex w-full cursor-default items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                    i === active && 'bg-sidebar'
                  )}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted">{c.from}</span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        )}
      </Popover>
    )
  }
  const guess = meeting.speakerGuesses?.[id]
  if (guess) {
    // A guess (from Teams, a known voice or the conversation): a question until the user says yes or no.
    const clear = () => {
      const next = { ...meeting.speakers }
      delete next[id]
      void window.kasha.updateMeeting(meeting.id, { speakers: next })
    }
    return (
      <span className="inline-flex h-7 items-center rounded-md border border-dashed border-border bg-surface text-[13px]">
        <button
          onClick={() => setEditing(true)}
          title={`${guess.evidence || 'A guess.'} Select to pick someone else.`}
          className="inline-flex h-full items-center gap-1 rounded-l-md px-2 hover:bg-sidebar"
        >
          {name}
          <span className="text-muted">?</span>
        </button>
        <button
          onClick={() => void window.kasha.updateMeeting(meeting.id, { confirmSpeaker: id })}
          aria-label={`Yes, this is ${name}`}
          title={`Yes, this is ${name}`}
          className="inline-flex h-full items-center border-l border-border px-1.5 hover:bg-sidebar"
        >
          <Check className="size-3.5 text-ok" />
        </button>
        <button
          onClick={clear}
          aria-label={`Not ${name}`}
          title={`Not ${name}`}
          className="inline-flex h-full items-center rounded-r-md border-l border-border px-1.5 hover:bg-sidebar"
        >
          <X className="size-3.5 text-muted" />
        </button>
      </span>
    )
  }
  return (
    <button
      onClick={() => setEditing(true)}
      title="Rename everywhere in this transcript"
      className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[13px] hover:bg-sidebar"
    >
      {name}
      <Pencil className="size-3 text-muted opacity-60 group-hover:opacity-100" />
    </button>
  )
}

/** Moves one line to a different speaker, or to someone new. */
function SpeakerPicker({
  seg,
  meeting,
  speakers,
  show,
  onPick
}: {
  seg: TranscriptSegment
  meeting: Meeting
  speakers: SpeakerId[]
  show: boolean
  onPick?: (id: SpeakerId) => void
}) {
  const [open, setOpen] = useState(false)
  const guessed = !!meeting.speakerGuesses?.[seg.speaker]
  const label = (
    <span className={cn('block truncate', seg.speaker === 'you' ? 'font-medium' : 'text-muted')} title={speakerName(seg.speaker, meeting.speakers)}>
      {speakerName(seg.speaker, meeting.speakers)}
      {guessed && '?'}
    </span>
  )
  // Continuation lines hide the name until hovered, so turns are easy to scan.
  const visibility = show ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
  if (!onPick) return <span className={cn('self-start pt-[1px] text-[13px]', visibility)}>{label}</span>
  const next = Math.max(0, ...speakers.map((s) => (s.startsWith('s') ? Number(s.slice(1)) : 0))) + 1
  const pick = (id: SpeakerId) => {
    setOpen(false)
    if (id !== seg.speaker) onPick(id)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn('min-w-0 self-start rounded pt-[1px] text-left text-[13px] hover:underline', visibility)}
        title="Change who said this"
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48">
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted">Who said this?</p>
        {speakers.map((id) => (
          <button
            key={id}
            onClick={() => pick(id)}
            className={cn('flex w-full rounded-md px-2 py-1.5 text-left hover:bg-foreground/5', id === seg.speaker && 'font-medium')}
          >
            {speakerName(id, meeting.speakers)}
          </button>
        ))}
        {next < 100 && (
          <button onClick={() => pick(`s${next}`)} className="flex w-full rounded-md px-2 py-1.5 text-left text-muted hover:bg-foreground/5">
            Someone else
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---------- Lines ----------

function LineText({
  text,
  re,
  onSave,
  onCorrect
}: {
  text: string
  re: RegExp | null
  onSave?: (text: string) => void
  /** Right-click on a word: offer to correct its spelling everywhere. */
  onCorrect: (at: WordAt) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  useEffect(() => setValue(text), [text])

  if (!editing || !onSave) {
    return (
      <span
        className={cn('text-[15px]', onSave && 'cursor-text rounded hover:bg-foreground/[0.04]')}
        onClick={() => onSave && setEditing(true)}
        onContextMenu={(e) => {
          const word = wordAtPoint(e.clientX, e.clientY, e.currentTarget)
          if (!word) return
          e.preventDefault()
          onCorrect({ word, x: e.clientX, y: e.clientY })
        }}
        title={onSave ? 'Select to edit. Right-click a word to correct it everywhere.' : undefined}
      >
        {highlight(text, re)}
      </span>
    )
  }
  const commit = () => {
    setEditing(false)
    const v = value.replace(/\s+/g, ' ').trim()
    if (v && v !== text) onSave(v)
    else setValue(text)
  }
  return (
    <textarea
      autoFocus
      rows={1}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          setValue(text)
          setEditing(false)
        }
      }}
      aria-label="Edit line"
      className="-mx-1 -my-0.5 block w-full resize-none rounded-md bg-surface px-1 py-0.5 text-[15px] leading-relaxed outline-2 outline-primary [field-sizing:content]"
    />
  )
}

// ---------- Corrections ----------

/**
 * A single changed word or short phrase between two versions of a line, so
 * the fix can be offered for future meetings. Null when more changed.
 */
export function wordChange(before: string, after: string): { from: string; to: string } | null {
  const a = before.split(/\s+/).filter(Boolean)
  const b = after.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  const from = a.slice(i, a.length - j)
  const to = b.slice(i, b.length - j)
  if (!from.length || !to.length || from.length > 3 || to.length > 3) return null
  const strip = (w: string[]) => w.join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  const f = strip(from)
  const t = strip(to)
  if (!f || !t || f.toLowerCase() === t.toLowerCase()) return null
  return { from: f, to: t }
}

/** After an edit changed one word: offer to remember the fix. */
function RememberFix({ change, onClose }: { change: { from: string; to: string }; onClose: () => void }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(onClose, done ? 2500 : 15_000)
    return () => window.clearTimeout(t)
  }, [done, onClose])
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-foreground/5 px-3 py-1.5 text-[13px]" role="status">
      {done ? (
        <span className="text-muted">Added to Names and terms. Future transcripts will say “{change.to}”.</span>
      ) : (
        <>
          <span className="text-muted">
            Fix “{change.from}” to “{change.to}” in future meetings too?
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-primary"
            onClick={() => {
              setDone(true)
              void window.kasha.rememberTerm(change.from, change.to)
            }}
          >
            Yes, remember it
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={onClose}>
            No
          </Button>
        </>
      )}
    </div>
  )
}

// ---------- Find and replace ----------

function FindReplace({
  meeting,
  find,
  setFind,
  matchCase,
  setMatchCase,
  inTranscript,
  inNotes,
  canReplace,
  onClose,
  onReplaced
}: {
  meeting: Meeting
  find: string
  setFind: (v: string) => void
  matchCase: boolean
  setMatchCase: (v: boolean) => void
  inTranscript: number
  inNotes: number
  canReplace: boolean
  onClose: () => void
  onReplaced: () => void
}) {
  const [replace, setReplace] = useState('')
  const [notes, setNotes] = useState(true)
  const [remember, setRemember] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)
  useEffect(() => findRef.current?.focus(), [])

  const total = inTranscript + (notes ? inNotes : 0)
  const run = async () => {
    const r = await window.kasha.replaceText(meeting.id, find, replace, { matchCase, notes, remember })
    const parts = [`${r.transcript} in the transcript`]
    if (notes) parts.push(`${r.notes} in notes`)
    setResult(`Replaced ${parts.join(' and ')}.${remember ? ' Future transcripts will use it too.' : ''}`)
    setFind('')
    onReplaced()
  }
  const counts = find.trim()
    ? [`${inTranscript} in transcript`, inNotes ? `${inNotes} in notes` : ''].filter(Boolean).join(', ')
    : ''

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={findRef}
          value={find}
          onChange={(e) => {
            setFind(e.target.value)
            setResult(null)
          }}
          placeholder="Find"
          aria-label="Find"
          className="h-8 w-48"
        />
        <Input
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canReplace && total > 0 && replace.trim() && void run()}
          placeholder="Replace with"
          aria-label="Replace with"
          disabled={!canReplace}
          className="h-8 w-48"
        />
        <Button size="sm" variant="primary" disabled={!canReplace || !total || !replace.trim()} onClick={() => void run()}>
          Replace all
        </Button>
        <span className="tabular text-xs text-muted" role="status">
          {result ?? counts}
        </span>
        <Button variant="ghost" size="icon" className="ml-auto" aria-label="Close find and replace" onClick={onClose}>
          <X className="text-muted" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
          Match case
        </label>
        <label className="flex items-center gap-2 has-[:disabled]:opacity-50">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={notes} disabled={!canReplace} onChange={(e) => setNotes(e.target.checked)} />
          Also in notes
        </label>
        <label className="flex items-center gap-2 has-[:disabled]:opacity-50" title="Adds it to Names and terms in Settings">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={remember} disabled={!canReplace} onChange={(e) => setRemember(e.target.checked)} />
          Fix in future meetings too
        </label>
      </div>
      {!canReplace && <p className="text-xs text-muted">You can replace text once the transcript is finished.</p>}
    </div>
  )
}

// ---------- Transcript ----------

function useStickToBottom(dep: unknown, active: boolean) {
  const end = useRef<HTMLDivElement>(null)
  const wasAtBottom = useRef(true)
  // Measure before the new lines render, then follow along only if the user was at the end.
  const container = () => {
    let el = end.current?.parentElement ?? null
    while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement
    return el
  }
  useLayoutEffect(() => {
    if (!active) return
    const el = container()
    if (el && wasAtBottom.current) el.scrollTop = el.scrollHeight
  }, [dep, active])
  useEffect(() => {
    const el = container()
    if (!el || !active) return
    const onScroll = () => (wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [active])
  return end
}

export function Transcript({ meeting, segments, note, live, liveEnabled, onSave, onReplaced }: Props) {
  const [finding, setFinding] = useState(false)
  const [find, setFind] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [correct, setCorrect] = useState<WordAt | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [change, setChange] = useState<{ from: string; to: string } | null>(null)
  const end = useStickToBottom(segments.length, live)

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(t)
  }, [notice])

  const re = useMemo(() => (finding ? findPattern(find, { matchCase }) : null), [finding, find, matchCase])
  const inTranscript = useMemo(() => segments.reduce((n, s) => n + countMatches(s.text, re), 0), [segments, re])
  const inNotes = useMemo(() => countMatches(note, re), [note, re])

  const speakers = useMemo(() => {
    const seen: SpeakerId[] = []
    for (const s of segments) if (!seen.includes(s.speaker)) seen.push(s.speaker)
    // You first, then everyone else in the order they spoke.
    return seen.sort((a, b) => Number(b === 'you') - Number(a === 'you'))
  }, [segments])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'h')) {
        e.preventDefault()
        setFinding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!segments.length) {
    const msg =
      meeting.status === 'recording'
        ? liveEnabled
          ? 'Listening. Lines appear here about a minute after they’re said.'
          : 'Recording. The transcript is created on this PC when the call ends.'
        : meeting.status === 'transcribing' || meeting.status === 'separating'
          ? 'Transcribing on this PC.'
          : meeting.status === 'draft'
            ? 'No recording for this note.'
            : 'No speech was detected in the recording.'
    return <p className="text-muted">{msg}</p>
  }

  const edit = (i: number, patch: Partial<TranscriptSegment>) => {
    if (patch.text !== undefined) setChange(wordChange(segments[i].text, patch.text))
    onSave?.(segments.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  return (
    <div className="flex max-w-[80ch] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs text-muted">Speakers</span>
        {speakers.map((id) => (
          <SpeakerChip key={id} id={id} meeting={meeting} />
        ))}
        {!finding && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setFinding(true)} title="Find and replace (Ctrl+H)">
            <Replace />
            Find and replace
          </Button>
        )}
      </div>

      {change && <RememberFix change={change} onClose={() => setChange(null)} />}
      {notice && (
        <p className="-mt-2 text-[13px] text-muted" role="status">
          {notice}
        </p>
      )}
      {correct && (
        <CorrectWord
          meetingId={meeting.id}
          at={correct}
          canReplace={!!onSave}
          onClose={() => setCorrect(null)}
          onDone={(text) => {
            setCorrect(null)
            setNotice(text)
            onReplaced()
          }}
        />
      )}

      {live && (
        <p className="-mt-2 inline-flex items-center gap-2 text-[13px] text-muted">
          <span className="size-2 animate-pulse rounded-full bg-record" aria-hidden="true" />
          Live. Lines appear about a minute after they’re said.
        </p>
      )}

      {finding && (
        <FindReplace
          meeting={meeting}
          find={find}
          setFind={setFind}
          matchCase={matchCase}
          setMatchCase={setMatchCase}
          inTranscript={inTranscript}
          inNotes={inNotes}
          canReplace={!!onSave}
          onClose={() => {
            setFinding(false)
            setFind('')
          }}
          onReplaced={onReplaced}
        />
      )}

      <ol className="flex flex-col gap-3">
        {segments.map((s, i) => {
          const turn = i === 0 || segments[i - 1].speaker !== s.speaker
          return (
            <li key={`${s.start}-${i}`} className={cn('group grid grid-cols-[52px_112px_1fr] gap-2 leading-relaxed', turn && i > 0 && 'mt-2')}>
              <span className="tabular pt-[3px] font-mono text-xs text-muted">{clock(s.start)}</span>
              <SpeakerPicker
                seg={s}
                meeting={meeting}
                speakers={speakers}
                show={turn}
                onPick={onSave && ((speaker) => edit(i, { speaker }))}
              />
              <LineText text={s.text} re={re} onSave={onSave && ((text) => edit(i, { text }))} onCorrect={setCorrect} />
            </li>
          )
        })}
      </ol>
      <div ref={end} />
    </div>
  )
}
