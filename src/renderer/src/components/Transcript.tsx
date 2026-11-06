import { ArrowLeftRight, Check, ChevronDown, ChevronUp, Pencil, Play, Replace, Square, UserMinus, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { removeSpeaker, sameSpeaker, speakerTurns } from '@shared/speakers'
import { countMatches, findPattern } from '@shared/text'
import { speakerName, type Meeting, type SpeakerId, type TranscriptSegment } from '@shared/types'
import { clock, cn, hhmm } from '@/lib/utils'
import { CorrectWord, wordAtPoint, type WordAt } from './CorrectWord'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

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
  /** The recording is still on this PC, so lines can be played. */
  audio: boolean
  /** Keep audio is on in Settings. */
  keepAudio: boolean
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

const nameKey = (n: string) => n.trim().toLowerCase()

/**
 * Names to offer for a speaker, one click each: people Teams showed in the
 * call, then invitees (some only as an address), leaving out names other
 * speakers already have. With `merge`, those speakers come last, to join
 * this one's lines to theirs.
 */
function nameChoices(
  id: SpeakerId,
  meeting: Meeting,
  speakers: SpeakerId[],
  typed: string,
  merge: boolean
): Array<{ name: string; from: string; into?: SpeakerId }> {
  const used = new Set(
    Object.entries(meeting.speakers ?? {})
      .filter(([k, v]) => k !== id && v && !meeting.speakerGuesses?.[k as SpeakerId])
      .map(([, v]) => nameKey(v!))
  )
  const out: Array<{ name: string; from: string; into?: SpeakerId }> = []
  const seen = new Set<string>()
  const add = (name: string, from: string) => {
    const k = nameKey(name)
    if (!k || used.has(k) || seen.has(k)) return
    seen.add(k)
    out.push({ name, from })
  }
  for (const p of meeting.participants ?? []) add(p, 'In the call')
  for (const a of meeting.attendees ?? []) add(a, 'Invited')
  const t = nameKey(typed)
  const people = (t ? out.filter((c) => nameKey(c.name).includes(t)) : out).slice(0, 12)
  if (!merge) return people
  const here = speakers
    .filter((o) => o !== id && meeting.speakers?.[o]?.trim() && !meeting.speakerGuesses?.[o])
    .map((o) => ({ name: speakerName(o, meeting.speakers), from: 'Already here', into: o }))
    .filter((c) => !t || nameKey(c.name).includes(t))
  return [...people, ...here]
}

// ---------- Listening back ----------

/** Plays one line of the recording at a time, so a voice can be heard before it's named. */
interface LinePlayer {
  /** The recording is still on this PC. */
  canPlay: boolean
  /** Keep audio is on, so later recordings can be played too. */
  keepAudio: boolean
  /** The line playing now. */
  playing: TranscriptSegment | null
  toggle(seg: TranscriptSegment): void
}

function useLinePlayer(meetingId: string, canPlay: boolean, keepAudio: boolean, onGone: () => void): LinePlayer {
  const [playing, setPlaying] = useState<TranscriptSegment | null>(null)
  const current = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)
  const playingRef = useRef<TranscriptSegment | null>(null)
  // Bumped by every start and stop, so a clip that arrives late doesn't play over the next one.
  const token = useRef(0)
  const gone = useRef(onGone)
  gone.current = onGone

  const stop = useCallback(() => {
    token.current++
    const c = current.current
    current.current = null
    if (c) {
      c.audio.pause()
      URL.revokeObjectURL(c.url)
    }
    playingRef.current = null
    setPlaying(null)
  }, [])
  useEffect(() => stop, [stop, meetingId])

  const toggle = useCallback(
    (seg: TranscriptSegment) => {
      const again = playingRef.current === seg
      stop()
      if (again) return
      const mine = ++token.current
      playingRef.current = seg
      setPlaying(seg)
      void window.kasha
        .audioClip(meetingId, seg.speaker, seg.start, seg.end)
        .catch(() => null)
        .then((wav) => {
          if (mine !== token.current) return
          if (!wav) {
            stop()
            gone.current()
            return
          }
          const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
          const audio = new Audio(url)
          current.current = { audio, url }
          audio.onended = () => mine === token.current && stop()
          audio.play().catch(() => mine === token.current && stop())
        })
    },
    [meetingId, stop]
  )
  return { canPlay, keepAudio, playing, toggle }
}

/** Plays or stops a line, beside its words in the naming box. */
function PlayLine({ seg, player }: { seg: TranscriptSegment; player: LinePlayer }) {
  const on = player.playing === seg
  return (
    <button
      onClick={() => player.toggle(seg)}
      aria-label={on ? 'Stop' : `Play what they said at ${clock(seg.start)}`}
      title={on ? 'Stop' : 'Hear them say it'}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border hover:bg-sidebar',
        on && 'border-primary text-primary'
      )}
    >
      {on ? <Square className="size-2.5 fill-current" /> : <Play className="ml-px size-3 fill-current" />}
    </button>
  )
}

interface NameProps {
  id: SpeakerId
  meeting: Meeting
  speakers: SpeakerId[]
  /** How many lines they said. */
  lines: number
  /**
   * Gives all their lines to someone else: they were added by mistake, or
   * they're the same person as `into`. Undefined when they can't go.
   */
  onGive?: (into: SpeakerId, same: boolean) => void
  /** Something they said, to tell who they are when their lines aren't in view. */
  quote?: TranscriptSegment
  /** Gives just the quoted line to someone else. Opened from a line, while the transcript can change. */
  onMoveLine?: (to: SpeakerId) => void
  player: LinePlayer
}

/**
 * Names a speaker everywhere in the transcript: type a name, or pick one from
 * Teams or the invite. Opens from the chip at the top or from the name on any
 * of their lines, which it quotes and can play. Giving them the name of
 * another speaker joins the two, for one person split in two. It can also
 * move just the quoted line, or remove a speaker added by mistake once the
 * user says who said their lines.
 */
function NameSpeaker({
  children,
  ...props
}: NameProps & {
  /** The button that opens it. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {/* Mounted only while open, so every opening starts from the current name. */}
      {open && <NameForm {...props} onClose={() => setOpen(false)} />}
    </Popover>
  )
}

function NameForm({ id, meeting, speakers, lines, onGive, quote, onMoveLine, player, onClose }: NameProps & { onClose: () => void }) {
  const name = speakerName(id, meeting.speakers)
  const given = meeting.speakers?.[id]?.trim() ?? ''
  const [value, setValue] = useState(given)
  const [active, setActive] = useState(-1) // highlighted choice, for the keyboard
  // Naming them, saying who said their lines (remove), or who said just this line (move).
  const [mode, setMode] = useState<'name' | 'remove' | 'move'>('name')
  const listId = useId()
  // One save per opening: Enter, a pick or a click elsewhere ends it, and nothing after that may save again.
  const done = useRef(false)

  /**
   * Saves a name. A guess is only confirmed (and its voice learned) by an
   * explicit choice: picking the guessed name in the list, or the ✓ button.
   * Closing it, or Enter, with the name unchanged is just a cancel. The name
   * of another speaker joins the two, but only on Enter or a pick: a click
   * elsewhere can't undo a speaker.
   */
  const save = (v: string, how: 'picked' | 'entered' | 'left') => {
    if (done.current) return
    done.current = true
    if (meeting.speakerGuesses?.[id] && v && v === given) {
      if (how === 'picked') void window.kasha.updateMeeting(meeting.id, { confirmSpeaker: id })
      return
    }
    const same = onGive && how !== 'left' ? sameSpeaker(id, meeting, speakers, v) : undefined
    if (same && (how === 'picked' || nameKey(v) !== nameKey(name))) return onGive!(same, true)
    const next = { ...meeting.speakers }
    // Clearing the name, or typing the default, goes back to "Speaker 2".
    if (v && v !== speakerName(id)) next[id] = v
    else delete next[id]
    if ((next[id] ?? '') !== (meeting.speakers?.[id] ?? '')) void window.kasha.updateMeeting(meeting.id, { speakers: next })
  }
  const close = (v: string, how: 'picked' | 'entered') => {
    save(v, how)
    onClose()
  }
  const give = (fn: () => void) => {
    done.current = true
    onClose()
    fn()
  }

  const others = speakers.filter((s) => s !== id)
  const choices = nameChoices(id, meeting, speakers, value === given ? '' : value, !!onGive)
  const optionId = (i: number) => `${listId}-${i}`
  const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-sidebar focus-visible:bg-sidebar focus-visible:outline-none'
  // Typed (or highlighted) the name of another speaker: Enter joins them.
  const joins = onGive
    ? active >= 0 && active < choices.length
      ? choices[active].into
      : nameKey(value) !== nameKey(name)
        ? sameSpeaker(id, meeting, speakers, value)
        : undefined
    : undefined
  const next = Math.max(0, ...speakers.map((s) => (s.startsWith('s') ? Number(s.slice(1)) : 0))) + 1
  // A lone line goes with Remove; moving it would be the same thing.
  const canMove = !!onMoveLine && !!quote && lines > 1

  if (mode !== 'name') {
    const moving = mode === 'move' && onMoveLine
    const pick = (o: SpeakerId) => give(() => (moving ? onMoveLine(o) : onGive?.(o, false)))
    return (
      <PopoverContent align="start" className="w-64" onEscapeKeyDown={() => (done.current = true)}>
        <p className="px-2 pt-1 text-[13px] font-medium">{moving ? 'Just this line' : `Remove ${name}`}</p>
        <p className="px-2 pt-0.5 pb-1.5 text-xs text-muted">
          {moving ? `Who said it? ${name}’s other lines stay theirs.` : lines === 1 ? 'Who said their line?' : `Who said their ${lines} lines?`}
        </p>
        {others.map((o, i) => (
          <button key={o} autoFocus={i === 0} onClick={() => pick(o)} className={row}>
            {speakerName(o, meeting.speakers)}
          </button>
        ))}
        {moving && next < 100 && (
          <button autoFocus={!others.length} onClick={() => pick(`s${next}`)} className={cn(row, 'text-muted')}>
            Someone new
          </button>
        )}
        <div className="my-1 border-t border-border" />
        <button onClick={() => setMode('name')} className={cn(row, 'text-muted')}>
          Back
        </button>
      </PopoverContent>
    )
  }

  return (
    <PopoverContent
      align="start"
      className="w-72"
      // Escape leaves the name as it was.
      onEscapeKeyDown={() => (done.current = true)}
      // A click elsewhere keeps what was typed, like leaving a text box. Popover closes itself.
      onInteractOutside={() => save(value.trim(), 'left')}
    >
      {quote && (
        <div className="flex items-start gap-2 px-2 pt-1 pb-2">
          {player.canPlay && <PlayLine seg={quote} player={player} />}
          <p className={cn('line-clamp-3 text-xs text-muted', player.canPlay && 'pt-1')} title={quote.text}>
            <span className="tabular mr-1.5 font-mono">{clock(quote.start)}</span>“{quote.text}”
          </p>
        </div>
      )}
      {quote && !player.canPlay && !player.keepAudio && (
        <p className="px-2 pb-2 text-xs text-muted">To hear voices before you name them, turn on Keep audio in Settings, under Transcription.</p>
      )}
      <input
        autoFocus
        role="combobox"
        aria-expanded={choices.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 && active < choices.length ? optionId(active) : undefined}
        aria-describedby={`${listId}-what`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setActive(-1)
        }}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && choices.length) {
            e.preventDefault()
            setActive((i) => (i + 1) % choices.length)
          } else if (e.key === 'ArrowUp' && choices.length) {
            e.preventDefault()
            setActive((i) => (i <= 0 ? choices.length - 1 : i - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (active >= 0 && active < choices.length) close(choices[active].name, 'picked')
            else close(value.trim(), 'entered')
          }
        }}
        aria-label={`Name for ${name}`}
        placeholder={`Name for ${speakerName(id)}`}
        className="h-8 w-full rounded-md border border-primary bg-background px-2 text-[13px] focus-visible:outline-offset-0"
      />
      {/* What Enter does: every one of their lines gets the name, or they join someone already here. */}
      <p id={`${listId}-what`} className="px-2 pt-1.5 text-xs text-muted" role="status">
        {joins
          ? `Joins ${name} to ${speakerName(joins, meeting.speakers)}: ${lines === 1 ? 'their line becomes' : `all ${lines} lines become`} ${speakerName(joins, meeting.speakers)}’s.`
          : lines === 1
            ? 'Names their one line.'
            : `Names all ${lines} of their lines.`}
      </p>
      {choices.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Choose a name" className="mt-1 max-h-64 overflow-y-auto">
          {choices.map((c, i) => (
            <li
              key={c.into ?? c.name}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // Keeps focus in the typing box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => close(c.name, 'picked')}
              onMouseEnter={() => setActive(i)}
              title={c.into ? `The same person: ${name}’s lines join ${c.name}’s` : undefined}
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
      )}
      {(canMove || (onGive && others.length > 0)) && <div className="my-1 border-t border-border" />}
      {canMove && (
        <button onClick={() => setMode('move')} className={cn(row, 'text-muted hover:text-foreground')}>
          <ArrowLeftRight className="size-3.5" />
          Only this line is someone else
        </button>
      )}
      {onGive && others.length > 0 && (
        <button
          onClick={() => setMode('remove')}
          title="For a speaker added by mistake: say who said their lines"
          className={cn(row, 'text-muted hover:text-foreground')}
        >
          <UserMinus className="size-3.5" />
          Remove {name}
        </button>
      )}
    </PopoverContent>
  )
}

/** A speaker at the top: the name shows where they spoke, the pencil names them. */
function SpeakerChip({
  shown,
  onShow,
  ...props
}: NameProps & {
  /** Their lines are highlighted below. */
  shown: boolean
  onShow: () => void
}) {
  const { id, meeting } = props
  const name = speakerName(id, meeting.speakers)
  // A guess (from Teams, a known voice or the conversation): a question until the user says yes or no.
  const guess = meeting.speakerGuesses?.[id]
  const part = 'inline-flex h-full items-center hover:bg-sidebar'
  const clear = () => {
    const next = { ...meeting.speakers }
    delete next[id]
    void window.kasha.updateMeeting(meeting.id, { speakers: next })
  }
  const where = shown ? `Show the next time ${name} spoke` : `Show where ${name} spoke`
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center rounded-md border bg-surface text-[13px]',
        guess && 'border-dashed',
        shown ? 'border-primary' : 'border-border'
      )}
    >
      <button
        onClick={onShow}
        aria-pressed={shown}
        title={guess ? `${guess.evidence || 'A guess.'} ${where}.` : where}
        className={cn(part, 'rounded-l-md pr-1 pl-2', shown && 'bg-primary/10 hover:bg-primary/15')}
      >
        {name}
        {guess && <span className="text-muted">?</span>}
      </button>
      <NameSpeaker {...props}>
        <button
          aria-label={`Rename ${name}`}
          title={guess ? 'Pick someone else' : 'Rename everywhere in this transcript'}
          className={cn(part, 'px-1.5 data-[state=open]:bg-sidebar', !guess && 'rounded-r-md')}
        >
          <Pencil className="size-3 text-muted" />
        </button>
      </NameSpeaker>
      {guess && (
        <>
          <button
            onClick={() => void window.kasha.updateMeeting(meeting.id, { confirmSpeaker: id })}
            aria-label={`Yes, this is ${name}`}
            title={`Yes, this is ${name}`}
            className={cn(part, 'border-l border-border px-1.5')}
          >
            <Check className="size-3.5 text-ok" />
          </button>
          <button
            onClick={clear}
            aria-label={`Not ${name}`}
            title={`Not ${name}`}
            className={cn(part, 'rounded-r-md border-l border-border px-1.5')}
          >
            <X className="size-3.5 text-muted" />
          </button>
        </>
      )}
    </span>
  )
}

/**
 * Who said a line, beside it. Selecting the name names them everywhere, with
 * this line quoted (and playable) to tell who it is; the box can also give
 * just this line to someone else.
 */
function LineSpeaker({ seg, show, ...props }: NameProps & { seg: TranscriptSegment; show: boolean }) {
  const name = speakerName(seg.speaker, props.meeting.speakers)
  const guessed = !!props.meeting.speakerGuesses?.[seg.speaker]
  // Continuation lines hide the name until hovered, so turns are easy to scan.
  const visibility = show ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'
  return (
    <NameSpeaker {...props} quote={seg}>
      <button
        className={cn('min-w-0 self-start rounded pt-[1px] text-left text-[13px] hover:underline', visibility)}
        title={`${name}${guessed ? '?' : ''}: select to name them everywhere, or to change who said this line`}
      >
        <span className={cn('block truncate', seg.speaker === 'you' ? 'font-medium' : 'text-muted')}>
          {name}
          {guessed && '?'}
        </span>
      </button>
    </NameSpeaker>
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

export function Transcript({ meeting, segments, note, live, liveEnabled, onSave, onReplaced, audio, keepAudio }: Props) {
  const [finding, setFinding] = useState(false)
  const [find, setFind] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [correct, setCorrect] = useState<WordAt | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [change, setChange] = useState<{ from: string; to: string } | null>(null)
  // A speaker whose lines are highlighted, and which of their turns is in view.
  const [shown, setShown] = useState<{ id: SpeakerId; turn: number } | null>(null)
  const [stuck, setStuck] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const end = useStickToBottom(segments.length, live)
  const player = useLinePlayer(meeting.id, audio && !live, keepAudio, () => setNotice('The recording isn’t on this PC any more, so lines can’t be played.'))

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
  // How many lines each speaker said, and their longest: the likeliest to tell who they are.
  const [lineCount, longest] = useMemo(() => {
    const n: Partial<Record<SpeakerId, number>> = {}
    const long: Partial<Record<SpeakerId, TranscriptSegment>> = {}
    for (const s of segments) {
      n[s.speaker] = (n[s.speaker] ?? 0) + 1
      if (s.text.length > (long[s.speaker]?.text.length ?? -1)) long[s.speaker] = s
    }
    return [n, long]
  }, [segments])

  const shownId = shown?.id
  const turns = useMemo(() => (shownId ? speakerTurns(segments, shownId) : []), [segments, shownId])
  const turn = shown && turns.length ? Math.min(shown.turn, turns.length - 1) : -1
  // The lines of the turn in view.
  const from = turn >= 0 ? turns[turn] : -1
  let to = from
  while (from >= 0 && to + 1 < segments.length && segments[to + 1].speaker === shownId) to++

  // Their last line went to someone else.
  useEffect(() => {
    if (shownId && !turns.length) setShown(null)
  }, [shownId, turns.length])

  // Brings the turn into view when the user asks for it. Edits that shift the lines don't move the page.
  useEffect(() => {
    if (!shown || from < 0) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    list.current?.querySelector(`[data-line="${from}"]`)?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])

  // The speakers bar stays at the top while the lines scroll: a rule under it once they pass beneath.
  const top = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])

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

  // Click a name: their first turn. Again: the next one.
  const show = (id: SpeakerId) => setShown(shownId === id && turns.length ? { id, turn: (turn + 1) % turns.length } : { id, turn: 0 })
  const step = (by: number) => {
    if (shownId && turns.length) setShown({ id: shownId, turn: (turn + by + turns.length) % turns.length })
  }

  // You is the mic, always the user. And someone has to be left to take the lines.
  const giving = (id: SpeakerId) =>
    onSave && id !== 'you' && speakers.length > 1
      ? (into: SpeakerId, same: boolean) => {
          const n = lineCount[id] ?? 0
          const name = speakerName(id, meeting.speakers)
          const whose = into === 'you' ? 'yours' : `${speakerName(into, meeting.speakers)}’s`
          const theirs = n === 1 ? 'their line is' : `their ${n} lines are`
          onSave(removeSpeaker(segments, id, into))
          setNotice(same ? `${name} was the same person: ${theirs} now ${whose}.` : `Removed ${name}. ${n === 1 ? 'Their line is' : `Their ${n} lines are`} now ${whose}.`)
        }
      : undefined

  const shownName = shownId ? speakerName(shownId, meeting.speakers) : ''
  // What the shown speaker said in the turn in view, or else anyone's longest line.
  let inView: TranscriptSegment | undefined
  for (let i = from; i >= 0 && i <= to; i++) if (!inView || segments[i].text.length > inView.text.length) inView = segments[i]
  const quote = (id: SpeakerId) => (id === 'you' ? undefined : id === shownId && inView ? inView : longest[id])
  const nameProps = (id: SpeakerId) => ({ id, meeting, speakers, lines: lineCount[id] ?? 0, onGive: giving(id), player })

  return (
    <div className="relative flex max-w-[80ch] flex-col gap-5">
      <div ref={top} className="absolute -top-2 h-px w-px" aria-hidden="true" />
      <div
        className={cn(
          'sticky top-0 z-10 -mx-2 -my-2 flex flex-col gap-2 bg-background px-2 py-2 transition-shadow duration-150',
          stuck && 'shadow-[0_1px_0_var(--border)]'
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-muted">Speakers</span>
          {speakers.map((id) => (
            <SpeakerChip key={id} {...nameProps(id)} quote={quote(id)} shown={shownId === id} onShow={() => show(id)} />
          ))}
          {!finding && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setFinding(true)} title="Find and replace (Ctrl+H)">
              <Replace />
              Find and replace
            </Button>
          )}
        </div>

        {shownId && turn >= 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
            {turns.length > 1 && (
              <>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => step(-1)} aria-label={`Previous time ${shownName} spoke`} title="Previous">
                  <ChevronUp />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => step(1)} aria-label={`Next time ${shownName} spoke`} title="Next">
                  <ChevronDown />
                </Button>
              </>
            )}
            <span className="tabular mx-1" role="status">
              {turns.length > 1 ? `${turn + 1} of ${turns.length} times ${shownName} spoke` : `${shownName} spoke once`}
            </span>
            <NameSpeaker {...nameProps(shownId)} quote={quote(shownId)}>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-primary [&_svg]:size-3.5">
                <Pencil />
                {shownId === 'you' || meeting.speakers?.[shownId]?.trim() ? 'Rename' : 'Name them'}
              </Button>
            </NameSpeaker>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setShown(null)}>
              Done
            </Button>
          </div>
        )}

        {change && <RememberFix change={change} onClose={() => setChange(null)} />}
        {notice && (
          <p className="text-[13px] text-muted" role="status">
            {notice}
          </p>
        )}
      </div>

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

      <ol ref={list} className="flex flex-col gap-3">
        {segments.map((s, i) => {
          const turnStart = i === 0 || segments[i - 1].speaker !== s.speaker
          const turnEnd = i === segments.length - 1 || segments[i + 1].speaker !== s.speaker
          const mine = shownId === s.speaker
          const name = speakerName(s.speaker, meeting.speakers)
          const playing = player.playing === s
          // Notes combined from one call: where each later part begins.
          const part = meeting.parts?.find((p) => p.at <= s.start && (i === 0 || p.at > segments[i - 1].start))
          return (
            <Fragment key={`${s.start}-${i}`}>
              {part && (
                <li role="separator" className="my-1 flex items-center gap-3 text-xs text-muted">
                  <span className="h-px flex-1 bg-border" />
                  Rejoined at {hhmm(new Date(part.startedAt))}
                  <span className="h-px flex-1 bg-border" />
                </li>
              )}
              <li
                data-line={i}
                // The padding lets a highlighted turn read as one block; the margins take it back out of the spacing.
                className={cn(
                  'group -mx-2 -mb-1.5 grid grid-cols-[64px_112px_1fr] gap-2 px-2 py-1.5 leading-relaxed transition-colors duration-200',
                  turnStart && i > 0 ? 'mt-0.5' : '-mt-1.5',
                  mine && (i >= from && i <= to ? 'bg-primary/10' : 'bg-primary/[0.04]'),
                  mine && turnStart && 'rounded-t-md',
                  mine && turnEnd && 'rounded-b-md'
                )}
              >
                {player.canPlay ? (
                  // The time plays the line, to hear who said it.
                  <button
                    onClick={() => player.toggle(s)}
                    aria-label={playing ? 'Stop' : `Play ${name} at ${clock(s.start)}`}
                    title={playing ? 'Stop' : 'Play this line'}
                    className={cn(
                      'tabular inline-flex items-center gap-1 self-start rounded pt-[3px] text-left font-mono text-xs hover:text-primary hover:underline',
                      playing ? 'text-primary' : 'text-muted'
                    )}
                  >
                    {clock(s.start)}
                    {playing ? (
                      <Square className="size-2 shrink-0 fill-current" />
                    ) : (
                      <Play className="size-2.5 shrink-0 fill-current opacity-0 group-hover:opacity-100" />
                    )}
                  </button>
                ) : (
                  <span className="tabular pt-[3px] font-mono text-xs text-muted">{clock(s.start)}</span>
                )}
                <div className="flex min-w-0 items-start">
                  <LineSpeaker
                    {...nameProps(s.speaker)}
                    seg={s}
                    show={turnStart}
                    onMoveLine={onSave && ((speaker) => speaker !== s.speaker && edit(i, { speaker }))}
                  />
                </div>
                <LineText text={s.text} re={re} onSave={onSave && ((text) => edit(i, { text }))} onCorrect={setCorrect} />
              </li>
            </Fragment>
          )
        })}
      </ol>
      <div ref={end} />
    </div>
  )
}
