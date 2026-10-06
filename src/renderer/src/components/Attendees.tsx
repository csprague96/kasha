import { Check, Minus, RotateCcw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { attendance, attendanceKey, type AttendeeRow } from '@shared/attendance'
import type { Meeting, Presence, Settings, TranscriptSegment } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'

interface Props {
  meeting: Meeting
  segments: TranscriptSegment[]
  settings: Settings
  onShowTranscript: () => void
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  return `${Math.round(seconds / 60)} min`
}

function Row({ row, meeting, onShowTranscript }: { row: AttendeeRow; meeting: Meeting; onShowTranscript: () => void }) {
  const mark = (v: Presence | null) => void window.kasha.updateMeeting(meeting.id, { attendance: { [attendanceKey(row.name)]: v } })
  const unnamed = /^(Others|Speaker \d+)$/.test(row.name)
  const status = row.manual
    ? row.present
      ? 'Marked present'
      : 'Marked absent'
    : row.speaker
      ? row.guessed
        ? 'Spoke · name guessed'
        : 'Spoke'
      : 'Not heard'
  return (
    <li className="group grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn('size-2 shrink-0 rounded-full', row.present ? 'bg-ok' : 'bg-border')}
          aria-hidden="true"
        />
        <span className={cn('truncate', !row.present && 'text-muted')}>{row.name}</span>
        {unnamed && (
          <button onClick={onShowTranscript} className="shrink-0 text-xs text-muted underline-offset-2 hover:underline">
            Name in Transcript
          </button>
        )}
      </div>
      <span className={cn('text-xs', row.present ? 'text-muted' : 'text-muted/80')}>{status}</span>
      <span className="tabular w-14 text-right font-mono text-xs text-muted">{row.speaker ? minutes(row.seconds) : ''}</span>
      <span className="flex w-16 justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        {row.manual ? (
          <Button variant="ghost" size="icon" aria-label={`Clear mark for ${row.name}`} title="Back to what the recording says" onClick={() => mark(null)}>
            <RotateCcw className="size-3.5 text-muted" />
          </Button>
        ) : row.present ? (
          <Button variant="ghost" size="icon" aria-label={`Mark ${row.name} absent`} title="Mark absent" onClick={() => mark('absent')}>
            <Minus className="size-3.5 text-muted" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" aria-label={`Mark ${row.name} present`} title="Was there, just didn't speak" onClick={() => mark('present')}>
            <Check className="size-3.5 text-ok" />
          </Button>
        )}
        {row.invited && !row.speaker && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${row.name} from the list`}
            title="Remove from the list"
            onClick={() => void window.kasha.updateMeeting(meeting.id, { attendees: (meeting.attendees ?? []).filter((a) => a !== row.name) })}
          >
            <X className="size-3.5 text-muted" />
          </Button>
        )}
      </span>
    </li>
  )
}

/** Who was at the meeting: the invite list against who was heard, with by-hand corrections. */
export function Attendees({ meeting, segments, settings, onShowTranscript }: Props) {
  const rows = useMemo(() => attendance(meeting, segments, settings.myName), [meeting, segments, settings.myName])
  const [draft, setDraft] = useState('')

  const add = () => {
    const name = draft.trim().slice(0, 80)
    setDraft('')
    if (!name) return
    const list = meeting.attendees ?? []
    if (list.some((a) => attendanceKey(a) === attendanceKey(name))) return
    void window.kasha.updateMeeting(meeting.id, { attendees: [...list, name] })
  }

  const invited = rows.filter((r) => r.invited)
  const present = rows.filter((r) => r.present).length
  const notHeard = invited.filter((r) => !r.present).length
  const busy = meeting.status === 'recording' || meeting.status === 'transcribing' || meeting.status === 'separating'

  return (
    <div className="flex max-w-[80ch] flex-col gap-5">
      {rows.length > 0 && (
        <p className="tabular text-[13px] text-muted">
          {invited.length ? `${invited.length} on the list · ` : ''}
          {present} present{notHeard ? ` · ${notHeard} not heard` : ''}
        </p>
      )}

      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rows.map((r) => (
            <Row key={`${r.name}-${r.speaker ?? ''}`} row={r} meeting={meeting} onShowTranscript={onShowTranscript} />
          ))}
        </ul>
      ) : (
        <p className="text-muted">
          {busy
            ? 'People appear here once the recording has been transcribed.'
            : meeting.status === 'draft'
              ? 'No recording for this note. Add people below to keep a list anyway.'
              : 'Nobody was heard on this recording. Add people below if you know who was there.'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add a person"
          aria-label="Add a person to the list"
          className="max-w-xs"
        />
        <Button size="sm" onClick={add} disabled={!draft.trim()}>
          Add
        </Button>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted">
        {!meeting.attendees?.length && !settings.recording.lookupAttendees && (
          <p>Kasha can fill this list from the meeting's Outlook invite: turn on the attendee lookup in Settings.</p>
        )}
        <p>
          Not heard means the person didn't speak on the recording. Someone who listened without speaking looks the same, so mark them
          present by hand. Unnamed speakers are named in the Transcript tab.
        </p>
      </div>
    </div>
  )
}
