import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** YYYY-MM-DD in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: y === new Date().getFullYear() ? undefined : 'numeric' })
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * A small month calendar for jumping to a day's notes. Days with notes are
 * marked; picking one filters the list to that day.
 */
export function DayPicker({ days, selected, onSelect }: { days: Map<string, number>; selected: string | null; onSelect: (day: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const today = new Date()
  const start = selected ? new Date(Number(selected.slice(0, 4)), Number(selected.slice(5, 7)) - 1, 1) : new Date(today.getFullYear(), today.getMonth(), 1)
  const [month, setMonth] = useState(start)

  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7 // Monday first
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: Array<Date | null> = [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))]
  while (cells.length % 7) cells.push(null)
  const todayKey = dayKey(today)
  const inMonth = (delta: number) => new Date(month.getFullYear(), month.getMonth() + delta, 1)
  const monthHasNotes = (d: Date) => [...days.keys()].some((k) => k.startsWith(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`))

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setMonth(start)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Go to a day" title="Go to a day" className={cn('size-8 shrink-0', selected && 'bg-foreground/5')}>
          <CalendarDays className="text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Previous month" onClick={() => setMonth(inMonth(-1))}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-[13px] font-medium">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Next month" onClick={() => setMonth(inMonth(1))} disabled={!monthHasNotes(inMonth(1)) && inMonth(1) > today}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="pb-1 text-[11px] text-muted">
              {w}
            </span>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={i} />
            const key = dayKey(d)
            const n = days.get(key) ?? 0
            const active = key === selected
            return (
              <button
                key={i}
                onClick={() => {
                  onSelect(active ? null : key)
                  setOpen(false)
                }}
                disabled={!n && !active}
                aria-label={`${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${n ? `, ${n} ${n === 1 ? 'note' : 'notes'}` : ''}`}
                aria-pressed={active}
                className={cn(
                  'relative mx-auto flex size-8 flex-col items-center justify-center rounded-md text-[13px] tabular',
                  active ? 'bg-primary text-primary-foreground' : n ? 'hover:bg-foreground/5' : 'text-muted/50',
                  key === todayKey && !active && 'font-semibold text-primary'
                )}
              >
                {d.getDate()}
                {n > 0 && <span className={cn('absolute bottom-1 size-1 rounded-full', active ? 'bg-primary-foreground' : 'bg-primary')} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
        {selected && (
          <button
            onClick={() => {
              onSelect(null)
              setOpen(false)
            }}
            className="mt-2 w-full rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-foreground/5"
          >
            Show every day
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
