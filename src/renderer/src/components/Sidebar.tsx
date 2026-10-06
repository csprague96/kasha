import { AlertCircle, ListChecks, Loader2, Plus, Search, Settings as SettingsIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Meeting, Settings } from '@shared/types'
import type { View } from '@/App'
import { cn, dayGroup, hhmm } from '@/lib/utils'
import { Button } from './ui/button'
import { Wordmark } from './Wordmark'

interface Props {
  meetings: Meeting[]
  view: View
  settings: Settings
  openActions: number
  onSelect: (v: View) => void
  onNewNote: () => void
}

function StatusIcon({ m }: { m: Meeting }) {
  if (m.status === 'recording') return <span className="size-2 shrink-0 rounded-full bg-record" aria-label="Recording" />
  if (m.status === 'transcribing' || m.status === 'separating' || m.status === 'summarizing')
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-label="Processing" />
  if (m.status === 'failed') return <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />
  return null
}

function SyncLine({ meetings, settings, onClick }: { meetings: Meeting[]; settings: Settings; onClick: () => void }) {
  let dot = 'bg-muted'
  let label = 'Obsidian not set up'
  if (settings.obsidian.vault) {
    const errored = meetings.find((m) => m.sync.state === 'error')
    const last = meetings
      .map((m) => m.sync.at)
      .filter(Boolean)
      .sort()
      .pop()
    if (errored) {
      dot = 'bg-destructive'
      label = 'Obsidian sync failed'
    } else if (last) {
      dot = 'bg-ok'
      label = `Obsidian synced ${hhmm(new Date(last))}`
    } else {
      dot = 'bg-ok'
      label = 'Obsidian connected'
    }
  }
  return (
    <button onClick={onClick} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-foreground/5">
      <span className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className="truncate">{label}</span>
    </button>
  )
}

export function Sidebar({ meetings, view, settings, openActions, onSelect, onNewNote }: Props) {
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? meetings.filter((m) => m.title.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q.replace(/^#/, ''))))
      : meetings
    const out: Array<{ label: string; items: Meeting[] }> = []
    for (const m of filtered) {
      const label = dayGroup(m.recordingStartedAt ?? m.createdAt)
      const g = out[out.length - 1]
      if (g?.label === label) g.items.push(m)
      else out.push({ label, items: [m] })
    }
    return out
  }, [meetings, query])

  return (
    <aside className="flex min-h-0 flex-col gap-4 border-r border-border bg-sidebar px-3 pt-4 pb-3">
      <Wordmark />
      <div className="flex flex-col gap-1">
        <Button variant="primary" onClick={onNewNote} className="justify-start">
          <Plus />
          New note
        </Button>
        <button
          onClick={() => onSelect({ kind: 'actions' })}
          aria-current={view.kind === 'actions' ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-md border px-2 py-[7px] text-left',
            view.kind === 'actions' ? 'border-border bg-surface' : 'border-transparent hover:bg-foreground/5'
          )}
        >
          <ListChecks className="size-4 text-muted" />
          <span className="flex-1">Actions</span>
          {openActions > 0 && (
            <span className="tabular rounded bg-foreground/5 px-1.5 text-xs text-muted" aria-label={`${openActions} open`}>
              {openActions}
            </span>
          )}
        </button>
      </div>
      <label className="relative block">
        <span className="sr-only">Search notes</span>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes"
          className="h-8 w-full rounded-md border border-border bg-surface pr-2 pl-8 text-[13px] placeholder:text-muted focus-visible:outline-offset-0"
        />
      </label>

      <nav className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {groups.length === 0 && query && (
          <p className="px-2 py-1 text-[13px] text-muted">
            No notes match "{query}".{' '}
            <button className="text-primary hover:underline" onClick={() => setQuery('')}>
              Clear search
            </button>
          </p>
        )}
        {groups.map((g, i) => (
          <div key={g.label} className="flex flex-col gap-0.5">
            <div className={cn('px-2 pb-1 text-xs text-muted', i === 0 ? 'pt-0' : 'pt-3')}>{g.label}</div>
            {g.items.map((m) => {
              const active = view.kind === 'note' && view.id === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => onSelect({ kind: 'note', id: m.id })}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-2 py-[7px] text-left',
                    active ? 'border-border bg-surface' : 'border-transparent hover:bg-foreground/5'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <StatusIcon m={m} />
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center justify-between gap-1">
        <SyncLine meetings={meetings} settings={settings} onClick={() => onSelect({ kind: 'settings' })} />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          title="Settings"
          onClick={() => onSelect({ kind: 'settings' })}
          className={cn(view.kind === 'settings' && 'bg-foreground/5')}
        >
          <SettingsIcon className="text-muted" />
        </Button>
      </div>
    </aside>
  )
}
