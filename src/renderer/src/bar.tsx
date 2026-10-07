import { Camera, Pause, PenLine, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { LiveState, RecordingInfo } from '@shared/types'
import { cn, timer } from './lib/utils'
import './styles.css'

// ---------- Audio capture ----------

interface Capture {
  stop(): Promise<void>
}

/**
 * Captures the mic and the computer's audio output as two 16 kHz tracks in one
 * AudioContext, so both share a clock and their timestamps line up.
 */
async function startCapture(): Promise<Capture> {
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

function Bar() {
  const [info, setInfo] = useState<RecordingInfo | null>(null)
  const [now, setNow] = useState(Date.now())
  const [noting, setNoting] = useState(false)
  const [text, setText] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const [snipping, setSnipping] = useState(false)
  const [live, setLive] = useState<LiveState | null>(null)
  const capture = useRef<Promise<Capture> | null>(null)

  useEffect(() => {
    void window.bar.info().then(setInfo)
    void window.bar.live().then(setLive)
    const offLive = window.bar.onLiveState(setLive)
    capture.current = startCapture()
    const t = window.setInterval(() => setNow(Date.now()), 1000)
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
      offLive()
    }
  }, [])

  const showFlash = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash(null), 1500)
  }

  // Enter and Escape both just blur; blur saves unless the note was cancelled.
  const cancelled = useRef(false)
  const onNoteBlur = async () => {
    const v = text.trim()
    setNoting(false)
    setText('')
    if (cancelled.current || !v) {
      cancelled.current = false
      return
    }
    await window.bar.addNote(v)
    showFlash('Note added')
  }

  const screenshot = async () => {
    setSnipping(true)
    try {
      await window.bar.screenshot()
    } finally {
      setSnipping(false)
    }
  }

  if (!info) return null
  const pill = 'rounded-full border border-border px-2.5 py-1 font-medium [-webkit-app-region:no-drag]'
  const paused = live?.paused ?? null
  const pauseLabel =
    paused === 'user'
      ? 'Resume transcribing'
      : paused === 'memory'
        ? 'Transcribing is waiting for free memory. Select to transcribe now anyway (the PC may slow down). Recording carries on either way.'
        : 'Pause transcribing. Recording carries on; the transcript catches up later.'

  return (
    <div className="flex h-full items-center p-1">
      <div className="flex h-full w-full items-center gap-3 rounded-full border border-border bg-surface py-1.5 pr-2 pl-3.5 text-[13px] [-webkit-app-region:drag]">
        <span className="size-2 shrink-0 rounded-full bg-record" aria-hidden="true" />
        <span className="tabular shrink-0 font-mono text-xs font-medium">{timer(now - info.startedAt)}</span>

        {noting ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelled.current = true
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
            onBlur={() => void onNoteBlur()}
            placeholder="Type a note, press Enter"
            aria-label="Note"
            className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 placeholder:text-muted focus-visible:outline-offset-0 [-webkit-app-region:no-drag]"
          />
        ) : (
          <button
            onClick={() => window.bar.openMain()}
            title="Open note"
            className={cn('min-w-0 flex-1 truncate text-left [-webkit-app-region:no-drag]', flash && 'text-muted')}
          >
            {flash ?? info.title}
            {!flash && paused === 'user' && <span className="text-muted"> · transcribing paused</span>}
            {!flash && paused === 'memory' && <span className="text-muted"> · transcribing waits for memory</span>}
          </button>
        )}

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

        <button className={cn(pill, 'inline-flex items-center gap-1.5 hover:bg-sidebar')} onClick={() => setNoting(true)}>
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
        <button
          className={cn(pill, 'border-foreground bg-foreground text-surface hover:opacity-90')}
          onClick={() => window.bar.stop()}
        >
          Stop
        </button>
      </div>
    </div>
  )
}

document.body.style.background = 'transparent'
// No StrictMode here: its double-run effects would start audio capture twice.
createRoot(document.getElementById('root')!).render(<Bar />)
