import { Combine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { canCombine, sameCall, startOf } from '@shared/combine'
import type { Meeting, Settings } from '@shared/types'
import { hhmm } from '@/lib/utils'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** Notes recorded this close to this one are offered to combine with it. */
const NEARBY_MS = 12 * 3600_000

/** Errors thrown in the main process arrive wrapped in Electron's IPC prefix. */
const ipcMessage = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const minutes = (m: Meeting) =>
  m.recordingStartedAt && m.recordingEndedAt ? ` · ${Math.max(1, Math.round((Date.parse(m.recordingEndedAt) - Date.parse(m.recordingStartedAt)) / 60000))} min` : ''

/** Other notes this one could be combined with: finished, and recorded around the same time. Nearest first in time order. */
export function combineCandidates(meeting: Meeting, meetings: Meeting[]): Meeting[] {
  const at = startOf(meeting)
  return meetings
    .filter((m) => m.id !== meeting.id && canCombine(m) && Math.abs(startOf(m) - at) <= NEARBY_MS)
    .sort((a, b) => startOf(a) - startOf(b))
}

/**
 * Combines this note with others from the same call (it was cut off, or the
 * user left and came back), into one note with one transcript and one
 * summary. Notes that look like the same call are ticked to begin with.
 */
export function CombineNotes(props: {
  meeting: Meeting
  meetings: Meeting[]
  settings: Settings
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { meeting, meetings, settings, open } = props
  const candidates = combineCandidates(meeting, meetings)
  const [picked, setPicked] = useState<string[]>([])
  const [obsidian, setObsidian] = useState(settings.obsidian.onDelete !== 'kasha')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setPicked(candidates.filter((m) => sameCall(meeting, m)).map((m) => m.id))
    setObsidian(settings.obsidian.onDelete !== 'kasha')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!canCombine(meeting)) return null

  const chosen = [meeting, ...candidates.filter((m) => picked.includes(m.id))].sort((a, b) => startOf(a) - startOf(b))
  const [kept, ...going] = chosen
  const inVault = going.filter((m) => m.sync.path)

  const combine = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.kasha.combineNotes(
        chosen.map((m) => m.id),
        { obsidian: inVault.length > 0 && obsidian }
      )
      props.onOpenChange(false)
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Combine with another note" title="Combine with another note from the same call">
          <Combine className="text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="flex w-96 flex-col gap-3 p-3 text-[13px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancel.current?.focus()
        }}
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Combine notes from one call</p>
          <p className="text-muted">
            For a call that was cut off, or that you left and rejoined. You get one note with one transcript, and the summary is written again from the
            whole call.
          </p>
        </div>

        {candidates.length === 0 ? (
          <p className="text-muted">No other finished notes from around this time.</p>
        ) : (
          <ul className="-mx-1 flex max-h-64 flex-col overflow-y-auto">
            {candidates.map((m) => (
              <li key={m.id}>
                <label className="flex items-start gap-2.5 rounded-md px-1 py-1.5 hover:bg-foreground/5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                    checked={picked.includes(m.id)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, m.id] : cur.filter((id) => id !== m.id)))}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{m.title}</span>
                    <span className="tabular font-mono text-xs text-muted">
                      {hhmm(new Date(startOf(m)))}
                      {minutes(m)}
                      {startOf(m) < startOf(meeting) ? ' · before this one' : ' · after this one'}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {going.length > 0 && (
          <p className="text-muted">
            Kept as <span className="text-foreground">{kept.title}</span> from {hhmm(new Date(startOf(kept)))}.{' '}
            {going.length === 1 ? 'The other note is' : `The other ${going.length} notes are`} deleted once combined.
          </p>
        )}
        {inVault.length > 0 && (
          <label className="flex items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={obsidian} onChange={(e) => setObsidian(e.target.checked)} />
            <span className="flex flex-col">
              <span>Also remove {inVault.length === 1 ? 'its copy' : 'their copies'} from Obsidian</span>
              <span className="text-xs text-muted">To the Recycle Bin, with their screenshots. The combined note is synced as usual.</span>
            </span>
          </label>
        )}

        <div className="flex gap-2">
          <Button size="sm" disabled={busy || going.length === 0} onClick={() => void combine()}>
            {going.length ? `Combine ${chosen.length} notes` : 'Combine'}
          </Button>
          <Button ref={cancel} variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
        </div>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
