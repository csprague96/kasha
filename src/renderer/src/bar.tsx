import { Camera, ChevronDown, ChevronUp, Image as ImageIcon, Minimize2, Pause, PenLine, Pin, Play } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { BarNote, BarView, LiveState, RecordingInfo } from '@shared/types'
import { Logo } from './components/Logo'
import { followTheme } from './lib/theme'
import { cn, timer } from './lib/utils'
import './styles.css'

// ---------- Audio capture ----------

interface Capture {
  stop(): Promise<void>
}

/** Dev-only (KASHA_FAKE_CAPTURE): silence on both tracks, to check the bar without recording anything. */
function fakeCapture(): Capture {
  const t = window.setInterval(() => {
    window.bar.sendChunk('mic', new Int16Array(8000).buffer)
    window.bar.sendChunk('sys', new Int16Array(8000).buffer)
  }, 500)
  window.bar.captureStarted({ mic: true, sys: true })
  return { stop: async () => window.clearInterval(t) }
}

/**
 * Captures the mic and the computer's audio output as two 16 kHz tracks in one
 * AudioContext, so both share a clock and their timestamps line up.
 */
async function startCapture(): Promise<Capture> {
  if (location.hash === '#fake-capture') return fakeCapture()
  const ctx = new AudioContext({ sampleRate: 16000 })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')

  const streams: MediaStream[] = []
  const nodes: AudioWorkletNode[] = []

  let stopping = false
  const attach = (stream: MediaStream, track: 'mic' | 'sys') => {
    streams.push(stream)
    // A track that ends by itself (a headset unplugged, Windows restarting audio)
    // would leave silence for the rest of the call: the main process restarts capture.
    for (const t of stream.getAudioTracks()) t.onended = () => !stopping && window.bar.captureLost(track)
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    })
    node.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) window.bar.sendChunk(track, e.data)
    }
    src.connect(node)
    node.connect(ctx.destination) // outputs silence; keeps the node scheduled
    nodes.push(node)
  }

  let mic = false
  let sys = false
  try {
    attach(
      await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      }),
      'mic'
    )
    mic = true
  } catch (e) {
    console.error('Mic capture failed', e)
  }
  try {
    // The main process answers this with a loopback capture of all system audio.
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    display.getVideoTracks().forEach((t) => t.stop())
    if (display.getAudioTracks().length) {
      attach(new MediaStream(display.getAudioTracks()), 'sys')
      sys = true
    }
  } catch (e) {
    console.error('System audio capture failed', e)
  }
  window.bar.captureStarted({ mic, sys })

  return {
    async stop() {
      stopping = true
      await Promise.all(
        nodes.map(
          (n) =>
            new Promise<void>((resolve) => {
              const prev = n.port.onmessage
              n.port.onmessage = (e) => {
                if (e.data === 'flushed') resolve()
                else prev?.call(n.port, e)
              }
              n.port.postMessage('flush')
              setTimeout(resolve, 500)
            })
        )
      )
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      await ctx.close()
    }
  }
}

// ---------- UI ----------

/** How far the pointer moves, pressed, before it's a drag and not a click. */
const DRAG_START = 4

/**
 * Moving the bar: press anywhere on it, its buttons too, and drag. The main
 * process moves the window (see BarLayout); a press that didn't move is a
 * plain click, and one that did isn't also a click on the button it started on.
 */
function useBarDrag() {
  const dragged = useRef(false)
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const { pointerId, screenX: sx, screenY: sy, clientX, clientY } = e
    let dragging = false
    dragged.current = false
    const move = (ev: PointerEvent) => {
      if (dragging || Math.hypot(ev.screenX - sx, ev.screenY - sy) < DRAG_START) return
      dragging = true
      dragged.current = true
      // Captured only now: captured from the press, the click would land on the bar, not the button pressed.
      el.setPointerCapture(pointerId)
      window.bar.dragStart(clientX, clientY)
    }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('lostpointercapture', end)
      if (dragging) window.bar.dragEnd()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('lostpointercapture', end)
  }
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!dragged.current) return
    dragged.current = false
    e.preventDefault()
    e.stopPropagation()
  }
  return { onPointerDown, onClickCapture }
}

/** The K with the red recording dot: the minimized bar, and the handle at the start of the full one. */
function RecordingMark({ beat, size }: { beat: number; size: 'logo' | 'handle' }) {
  return (
    <>
      <Logo size={size === 'logo' ? 17 : 15} beat={beat} />
      <span
        className={cn('absolute rounded-full bg-record ring-2 ring-surface', size === 'logo' ? 'top-0.5 right-0.5 size-2' : 'top-0 right-0 size-1.5')}
        aria-hidden="true"
      />
    </>
  )
}

/**
 * A picture pasted on its own: a snip, a copied image. Not one that comes with
 * text, as cells copied from Excel do; that pastes as text.
 */
function pastedPicture(data: DataTransfer): File | null {
  if (data.getData('text/plain').trim()) return null
  return Array.from(data.files).find((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type)) ?? null
}

/**
 * Quick notes, in a drawer that slides out of the bar. Each one goes into the
 * meeting's note with the time into the call; the ones added here so far
 * (screenshots and pasted pictures too) are listed above the box.
 */
function NotesDrawer(props: {
  notes: BarNote[]
  draft: string
  onDraft: (v: string) => void
  onAdd: () => void
  onPicture: (file: File) => void
  onHide: () => void
  up: boolean
  closing: boolean
  onClosed: () => void
}) {
  const { notes, draft, up, closing } = props
  const list = useRef<HTMLOListElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])
  // The newest note in view. (Braces: scrollTo returns a promise, which isn't a cleanup.)
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [notes.length])
  const motion = closing ? (up ? 'bar-drawer-out-up' : 'bar-drawer-out') : up ? 'bar-drawer-in-up' : 'bar-drawer-in'
  return (
    <section
      aria-label="Quick notes"
      onAnimationEnd={() => closing && props.onClosed()}
      className={cn('flex min-h-0 flex-1 flex-col gap-2 rounded-2xl border border-border bg-surface p-3 text-[13px]', motion)}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs text-muted">Notes go into the meeting's note with the time</h2>
        <button
          onClick={props.onHide}
          title="Hide notes (Esc)"
          aria-label="Hide notes"
          className="rounded p-0.5 text-muted hover:bg-sidebar hover:text-foreground"
        >
          {up ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
      </div>
      <ol ref={list} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {notes.length === 0 ? (
          <li className="text-muted">Nothing yet. Type below and press Enter, or paste a picture.</li>
        ) : (
          notes.map((n, i) => (
            <li key={i} className="flex gap-2 leading-5">
              <span className="tabular shrink-0 font-mono text-xs leading-5 text-muted">{n.at}</span>
              {n.image ? (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
                  <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  {n.text} added
                </span>
              ) : (
                <span className="min-w-0 break-words whitespace-pre-wrap">{n.text}</span>
              )}
            </li>
          ))
        )}
      </ol>
      <textarea
        ref={box}
        value={draft}
        rows={2}
        onChange={(e) => props.onDraft(e.target.value)}
        onPaste={(e) => {
          const file = pastedPicture(e.clipboardData)
          if (!file) return
          e.preventDefault()
          props.onPicture(file)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            props.onAdd()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onHide()
          }
        }}
        placeholder="Type a note, press Enter"
        aria-label="New note"
        className="w-full shrink-0 resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 leading-5 placeholder:text-muted focus-visible:outline-offset-0"
      />
    </section>
  )
}

function Bar() {
  const [info, setInfo] = useState<RecordingInfo | null>(null)
  const [now, setNow] = useState(Date.now())
  const [snipping, setSnipping] = useState(false)
  const [live, setLive] = useState<LiveState | null>(null)
  const [view, setView] = useState<BarView | null>(null)
  const [notes, setNotes] = useState<BarNote[]>([])
  const [draft, setDraft] = useState('')
  const [closing, setClosing] = useState(false)
  const capture = useRef<Promise<Capture> | null>(null)
  const drag = useBarDrag()

  useEffect(() => {
    void window.bar.info().then(setInfo)
    void window.bar.live().then(setLive)
    void window.bar.view().then(setView)
    void window.bar.notes().then(setNotes)
    const offs = [window.bar.onLiveState(setLive), window.bar.onView(setView)]
    capture.current = startCapture()
    // Twice a second: the timer, and the minimized logo's sound bars.
    const t = window.setInterval(() => setNow(Date.now()), 500)
    const off = window.bar.onStopRequested(async () => {
      try {
        await (await capture.current)?.stop()
      } finally {
        window.bar.captureStopped()
      }
    })
    return () => {
      window.clearInterval(t)
      off()
      offs.forEach((o) => o())
    }
  }, [])

  const addNote = async () => {
    const v = draft.trim()
    if (!v) return
    setDraft('')
    setNotes(await window.bar.addNote(v))
  }

  const addPicture = async (file: File) => {
    setNotes(await window.bar.addImage(await file.arrayBuffer(), file.type))
  }

  // The drawer slides away first; the window shrinks once it's gone.
  const closed = useRef<number | undefined>(undefined)
  const hideNotes = () => {
    if (closing) return
    setClosing(true)
    closed.current = window.setTimeout(finishHiding, 300) // in case the animation doesn't run
  }
  const finishHiding = () => {
    window.clearTimeout(closed.current)
    setClosing(false)
    void window.bar.setView({ notes: false })
  }

  const screenshot = async () => {
    setSnipping(true)
    try {
      setNotes(await window.bar.screenshot())
    } finally {
      setSnipping(false)
    }
  }

  const stop = async () => {
    // A note still in the box goes in before the recording ends.
    if (draft.trim()) await addNote()
    window.bar.stop()
  }

  if (!info || !view) return null
  const elapsed = timer(now - info.startedAt)
  const paused = live?.paused ?? null

  if (view.minimized && !view.expanded && !view.notes) {
    const label = `Recording, ${elapsed}${paused ? ', transcribing paused' : ''}. Point at it to open the bar, or drag it somewhere else.`
    return (
      <div className="flex h-full items-center justify-center p-1">
        <button
          {...drag}
          onClick={() => void window.bar.setView({ expanded: true })}
          title={label}
          aria-label={label}
          className="bar-pop relative flex size-10 cursor-grab touch-none items-center justify-center rounded-full border border-border bg-surface active:cursor-grabbing"
        >
          <RecordingMark size="logo" beat={Math.floor(now / 500)} />
        </button>
      </div>
    )
  }

  const pill = 'rounded-full border border-border px-2.5 py-1 font-medium'
  const pauseLabel =
    paused === 'user'
      ? 'Resume transcribing'
      : paused === 'memory'
        ? 'Transcribing is waiting for free memory. Select to transcribe now anyway (the PC may slow down). Recording carries on either way.'
        : 'Pause transcribing, and finishing any earlier note. Recording carries on; transcripts catch up later.'
  const sizeLabel = view.minimized ? 'Keep the bar open' : 'Minimize to the logo. Point at the logo to open the bar again.'

  return (
    <div className={cn('flex h-full flex-col gap-1.5 p-1', view.up && 'flex-col-reverse')}>
      <div
        {...drag}
        className={cn(
          'flex h-12 w-full shrink-0 touch-none items-center gap-3 rounded-full border border-border bg-surface py-1.5 pr-1.5 pl-1.5 text-[13px] select-none',
          view.minimized && 'bar-pop'
        )}
      >
        <span
          title="Drag to move the bar. Drop it by a screen edge to keep it there."
          className="relative flex size-9 shrink-0 cursor-grab items-center justify-center rounded-full border border-border active:cursor-grabbing"
        >
          <RecordingMark size="handle" beat={Math.floor(now / 500)} />
        </span>
        <span className="tabular -ml-1 shrink-0 font-mono text-xs font-medium">{elapsed}</span>

        <button onClick={() => window.bar.openMain()} title="Open note" className="min-w-0 flex-1 truncate text-left">
          {info.title}
          {paused === 'user' && <span className="text-muted"> · transcribing paused</span>}
          {paused === 'memory' && <span className="text-muted"> · transcribing waits for memory</span>}
        </button>

        {live?.available && (
          <button
            className={cn(pill, 'inline-flex items-center px-1.5 hover:bg-sidebar', paused && 'border-foreground')}
            onClick={() => window.bar.setPaused(!paused)}
            title={pauseLabel}
            aria-label={pauseLabel}
            aria-pressed={!!paused}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
        )}

        <button
          className={cn(pill, 'inline-flex items-center gap-1.5 hover:bg-sidebar', view.notes && 'border-foreground bg-sidebar')}
          onClick={() => (view.notes ? hideNotes() : void window.bar.setView({ notes: true }))}
          aria-expanded={view.notes}
          title={view.notes ? 'Hide notes' : 'Quick notes, added to the note with the time'}
        >
          <PenLine className="size-3.5" />
          Note
        </button>
        <button
          className={cn(pill, 'inline-flex items-center gap-1.5 hover:bg-sidebar disabled:opacity-50')}
          onClick={() => void screenshot()}
          disabled={snipping}
        >
          <Camera className="size-3.5" />
          Screenshot
        </button>
        <button className={cn(pill, 'border-foreground bg-foreground text-surface hover:opacity-90')} onClick={() => void stop()}>
          Stop
        </button>
        <button
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sidebar hover:text-foreground"
          onClick={() => void window.bar.setView({ minimized: !view.minimized })}
          title={sizeLabel}
          aria-label={sizeLabel}
        >
          {view.minimized ? <Pin className="size-3.5" /> : <Minimize2 className="size-3.5" />}
        </button>
      </div>

      {view.notes && (
        <NotesDrawer
          notes={notes}
          draft={draft}
          onDraft={setDraft}
          onAdd={() => void addNote()}
          onPicture={(f) => void addPicture(f)}
          onHide={hideNotes}
          up={view.up}
          closing={closing}
          onClosed={finishHiding}
        />
      )}
    </div>
  )
}

document.body.style.background = 'transparent'
followTheme()
// No StrictMode here: its double-run effects would start audio capture twice.
createRoot(document.getElementById('root')!).render(<Bar />)
