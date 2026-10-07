import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Meeting, Settings } from '@shared/types'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** Errors thrown in the main process arrive wrapped in Electron's IPC prefix. */
const ipcMessage = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The trash button and its confirmation. A note that was synced to Obsidian asks
 * whether the vault copy goes too, unless that was remembered in Settings.
 */
export function DeleteNote({ meeting, settings }: { meeting: Meeting; settings: Settings }) {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  const file = meeting.sync.path?.split(/[\\/]/).pop()
  const choice = file ? settings.obsidian.onDelete : 'kasha'

  const del = async (obsidian: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await window.kasha.deleteMeeting(meeting.id, { obsidian, remember: choice === 'ask' && remember })
    } catch (err) {
      setError(ipcMessage(err))
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        setError(null)
        setRemember(false)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Delete note" title="Delete note">
          <Trash2 className="text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="flex w-80 flex-col gap-3 p-3 text-[13px]"
        // Focus Cancel, not a delete button, so a stray Enter deletes nothing.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancel.current?.focus()
        }}
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Delete this note?</p>
          {choice === 'ask' && (
            <p className="text-muted">
              It’s also in Obsidian as <span className="font-mono text-xs break-words text-foreground">{file}</span>.
              {meeting.sync.state === 'edited-in-obsidian' && ' It was changed there since Kasha last wrote it.'} Deleted Obsidian files go to the Recycle Bin, with the screenshots Kasha saved for them.
            </p>
          )}
          {choice === 'both' && <p className="text-muted">The Obsidian copy goes to the Recycle Bin too. Change this in Settings, under Obsidian.</p>}
          {choice === 'kasha' && file && <p className="text-muted">The Obsidian copy stays in your vault. Change this in Settings, under Obsidian.</p>}
        </div>

        {choice === 'ask' ? (
          <>
            <label className="flex items-start gap-2.5">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span className="flex flex-col">
                <span>Remember this decision</span>
                <span className="text-xs text-muted">Kasha won’t ask again. You can change it in Settings, under Obsidian.</span>
              </span>
            </label>
            <div className="flex flex-col gap-1.5">
              <Button variant="destructive" size="sm" className="justify-start bg-destructive/10" disabled={busy} onClick={() => void del(true)}>
                Delete from Kasha and Obsidian
              </Button>
              <Button size="sm" className="justify-start" disabled={busy} onClick={() => void del(false)}>
                Delete from Kasha only
              </Button>
              <Button ref={cancel} variant="ghost" size="sm" className="justify-start" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" className="bg-destructive/10" disabled={busy} onClick={() => void del(choice === 'both')}>
              Delete
            </Button>
            <Button ref={cancel} variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        )}

        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
