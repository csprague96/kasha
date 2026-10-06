import { X } from 'lucide-react'
import { useState } from 'react'
import type { ActionGroup, ActionItem } from '@shared/types'
import { cn } from '@/lib/utils'
import { Switch } from './ui/switch'

interface Props {
  groups: ActionGroup[]
  onOpenMeeting: (id: string) => void
  onToggle: (item: ActionItem, done: boolean) => void
  /** Takes the line out of the note: it wasn't really an action. */
  onRemove: (item: ActionItem) => void
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function Due({ item }: { item: ActionItem }) {
  if (item.done) return null
  if (item.due) {
    const t = todayIso()
    if (item.due === t) return <span className="text-primary">Due today</span>
    if (item.due < t) return <span className="text-destructive">Overdue · {shortDate(item.due)}</span>
    return <span className="text-muted">Due {shortDate(item.due)}</span>
  }
  return item.dueText ? <span className="text-muted">{item.dueText}</span> : null
}

function Row({ item, onToggle, onRemove }: { item: ActionItem; onToggle: Props['onToggle']; onRemove: Props['onRemove'] }) {
  return (
    <li className="group -mx-2 flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-foreground/[0.03]">
      <input
        type="checkbox"
        checked={item.done}
        onChange={(e) => onToggle(item, e.target.checked)}
        aria-label={item.text}
        className="mt-[3px] size-4 shrink-0 accent-[var(--primary)]"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={cn('leading-relaxed', item.done && 'text-muted line-through', !item.mine && !item.done && 'text-foreground/80')}>
          {item.text}
        </span>
        <span className="tabular flex gap-3 text-xs">
          {!item.mine && item.owner && <span className="text-muted">{item.owner}</span>}
          <Due item={item} />
        </span>
      </div>
      <button
        onClick={() => onRemove(item)}
        aria-label={`Not an action: remove “${item.text}”`}
        title="Not an action. Removes the line from the note."
        className="mt-[2px] shrink-0 rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </li>
  )
}

/**
 * Open actions from every meeting, grouped by meeting. Your own come first;
 * everyone else's sit underneath so you can follow up on them.
 */
export function ActionsView({ groups, onOpenMeeting, onToggle, onRemove }: Props) {
  const [showDone, setShowDone] = useState(false)

  const visible = groups
    .map((g) => {
      const items = showDone ? g.items : g.items.filter((i) => !i.done)
      return { ...g, mine: items.filter((i) => i.mine), others: items.filter((i) => !i.mine) }
    })
    .filter((g) => g.mine.length || g.others.length)

  return (
    <div className="flex max-w-[760px] flex-col gap-8 px-10 py-8 max-[820px]:px-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Actions</h1>
        <label className="flex items-center gap-2.5 text-[13px] text-muted">
          Show completed
          <Switch checked={showDone} onCheckedChange={setShowDone} aria-label="Show completed" />
        </label>
      </div>

      {visible.length === 0 && (
        <p className="text-muted">
          {showDone ? 'No actions yet.' : 'No open actions.'} Actions from meeting summaries and checkboxes in your notes appear here.
        </p>
      )}

      {visible.map((g) => (
        <section key={g.meeting.id} className="flex flex-col gap-1">
          <button
            onClick={() => onOpenMeeting(g.meeting.id)}
            className="flex items-baseline justify-between gap-4 rounded-md text-left hover:text-primary"
          >
            <h2 className="truncate text-base font-semibold">{g.meeting.title}</h2>
            <span className="tabular shrink-0 font-mono text-xs text-muted">
              {new Date(g.meeting.recordingStartedAt ?? g.meeting.createdAt).toLocaleDateString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short'
              })}
            </span>
          </button>
          {g.mine.length > 0 && (
            <ul className="flex flex-col">
              {g.mine.map((i) => (
                <Row key={`${i.index}-${i.raw}`} item={i} onToggle={onToggle} onRemove={onRemove} />
              ))}
            </ul>
          )}
          {g.others.length > 0 && (
            <>
              <div className="pt-2 text-xs text-muted">Others</div>
              <ul className="flex flex-col">
                {g.others.map((i) => (
                  <Row key={`${i.index}-${i.raw}`} item={i} onToggle={onToggle} onRemove={onRemove} />
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  )
}
