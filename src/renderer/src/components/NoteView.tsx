import { ExternalLink, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Meeting, RecordingInfo, Settings, TranscriptSegment } from '@shared/types'
import { cn, hhmm, meetingMeta, timer } from '@/lib/utils'
import { Editor } from './Editor'
import { SharePopover } from './SharePopover'
import { Transcript } from './Transcript'
import { Button } from './ui/button'

interface Props {
  meeting: Meeting
  recording: RecordingInfo | null
  progress?: number
  settings: Settings
}

type Tab = 'notes' | 'transcript'

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

function Title({ meeting }: { meeting: Meeting }) {
  const [value, setValue] = useState(meeting.title)
  useEffect(() => setValue(meeting.title), [meeting.title])
  const commit = () => {
    const v = value.trim()
    if (v && v !== meeting.title) void window.kasha.updateMeeting(meeting.id, { title: v })
    else setValue(meeting.title)
  }
  return (
    // A textarea so long titles wrap instead of being cut off; Enter still commits.
    <textarea
      rows={1}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          setValue(meeting.title)
          e.currentTarget.blur()
        }
      }}
      aria-label="Title"
      className="block w-full min-w-0 resize-none overflow-hidden rounded-md bg-transparent text-[26px] leading-tight font-semibold tracking-[-0.01em] outline-none [field-sizing:content] focus-visible:outline-offset-4"
    />
  )
}

function Actions({ meeting, recording, progress, settings, hasTranscript }: Props & { hasTranscript: boolean }) {
  const now = useNow(!!recording)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isThis = recording?.meetingId === meeting.id

  if (isThis) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-2.5">
          <span className="size-2 rounded-full bg-record" />
          <span className="tabular font-mono text-xs font-medium">{timer(now - recording.startedAt)}</span>
        </div>
        <Button onClick={() => void window.kasha.stopRecording()}>Stop</Button>
      </div>
    )
  }

  if (meeting.status === 'transcribing' || meeting.status === 'separating' || meeting.status === 'summarizing') {
    const label =
      meeting.status === 'transcribing'
        ? `Transcribing${progress !== undefined ? ` ${Math.round(progress * 100)}%` : ''}`
        : meeting.status === 'separating'
          ? 'Telling speakers apart'
          : 'Writing summary'
    return (
      <div className="flex h-9 items-center gap-2 text-[13px] text-muted" role="status">
        <Loader2 className="size-4 animate-spin" />
        <span className="tabular">{label}</span>
      </div>
    )
  }

  if (confirmDelete) {
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted">Delete this note?</span>
        <Button variant="destructive" size="sm" onClick={() => void window.kasha.deleteMeeting(meeting.id)}>
          Delete
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
          Cancel
        </Button>
      </div>
    )
  }

  const canSync = !!settings.obsidian.vault && meeting.status !== 'draft'
  return (
    <div className="flex items-center gap-1">
      {meeting.status === 'draft' && !recording && (
        <Button onClick={() => void window.kasha.startRecording(meeting.id)}>
          <span className="size-2 rounded-full bg-record" />
          Record
        </Button>
      )}
      {meeting.status === 'failed' && (
        <Button onClick={() => void window.kasha.retry(meeting.id)}>
          <RefreshCw />
          Retry
        </Button>
      )}
      {canSync && meeting.sync.state === 'synced' && (
        <Button variant="ghost" size="sm" onClick={() => void window.kasha.revealInObsidian(meeting.id)}>
          <ExternalLink />
          Open in Obsidian
        </Button>
      )}
      {canSync && meeting.sync.state !== 'synced' && (
        <Button size="sm" onClick={() => void window.kasha.syncNow(meeting.id)}>
          Sync to Obsidian
        </Button>
      )}
      <SharePopover meeting={meeting} hasTranscript={hasTranscript} />
      <Button variant="ghost" size="icon" aria-label="Delete note" title="Delete note" onClick={() => setConfirmDelete(true)}>
        <Trash2 className="text-muted" />
      </Button>
    </div>
  )
}

function Notice({ meeting }: { meeting: Meeting }) {
  if (meeting.status === 'ready' && meeting.summaryOutdated)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-foreground/5 px-3 py-2 text-[13px] text-muted">
        <span>Speaker names or the transcript changed after the summary was written.</span>
        <Button size="sm" onClick={() => void window.kasha.resummarize(meeting.id)} title="Rewrites Summary, Decisions and Actions. Your notes are kept.">
          Update summary
        </Button>
      </div>
    )
  if (meeting.status === 'failed' && meeting.error)
    return <p className="rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{meeting.error}</p>
  if (meeting.error) return <p className="rounded-md bg-foreground/5 px-3 py-2 text-[13px] text-muted">{meeting.error}</p>
  if (meeting.sync.state === 'edited-in-obsidian')
    return (
      <p className="rounded-md bg-foreground/5 px-3 py-2 text-[13px] text-muted">
        This note was edited in Obsidian, so Kasha didn't overwrite it. Select Sync to Obsidian to replace it with this version.
      </p>
    )
  if (meeting.sync.state === 'error')
    return <p className="rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{meeting.sync.error}</p>
  return null
}

function Tags({ meeting }: { meeting: Meeting }) {
  const [draft, setDraft] = useState('')
  const save = (tags: string[]) => void window.kasha.updateMeeting(meeting.id, { tags })
  const add = () => {
    const t = draft.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')
    if (t && !meeting.tags.includes(t)) save([...meeting.tags, t])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {meeting.tags.map((t) => (
        <span key={t} className="group inline-flex items-center gap-1 rounded bg-tag py-[3px] pr-1 pl-2 text-xs text-tag-foreground">
          #{t}
          <button
            aria-label={`Remove tag ${t}`}
            onClick={() => save(meeting.tags.filter((x) => x !== t))}
            className="rounded opacity-60 hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
        onBlur={add}
        placeholder="Add tag"
        aria-label="Add tag"
        className="h-6 w-24 rounded bg-transparent px-1 text-xs placeholder:text-muted focus-visible:outline-offset-0"
      />
    </div>
  )
}

export function NoteView(props: Props) {
  const { meeting } = props
  const [tab, setTab] = useState<Tab>('notes')
  const [data, setData] = useState<{ note: string; transcript: TranscriptSegment[]; version: number } | null>(null)
  const prevStatus = useRef(meeting.status)

  useEffect(() => {
    void window.kasha.getMeeting(meeting.id).then((r) => r && setData({ note: r.note, transcript: r.transcript, version: 0 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id])

  // Reload the note and transcript after they were rewritten on disk.
  const reload = () =>
    void window.kasha.getMeeting(meeting.id).then(
      (r) => r && setData((cur) => ({ note: r.note, transcript: r.transcript, version: (cur?.version ?? 0) + 1 }))
    )

  // When processing finishes the note and transcript on disk change.
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = meeting.status
    if (was !== meeting.status && (was === 'transcribing' || was === 'separating' || was === 'summarizing')) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.status, meeting.id])

  // Lines from live transcription arrive while the call is going.
  useEffect(
    () =>
      window.kasha.onTranscriptLive((id, segs) => {
        if (id !== meeting.id) return
        setData((cur) => cur && { ...cur, transcript: [...cur.transcript, ...segs].sort((a, b) => a.start - b.start) })
      }),
    [meeting.id]
  )

  const writing = meeting.status === 'recording' || meeting.status === 'transcribing' || meeting.status === 'separating'
  const saveTranscript = (segs: TranscriptSegment[]) => {
    setData((cur) => cur && { ...cur, transcript: segs })
    void window.kasha.saveTranscript(meeting.id, segs)
  }

  const processing = meeting.status === 'summarizing'
  const syncedAt = meeting.sync.state === 'synced' && meeting.sync.at ? ` · Synced ${hhmm(new Date(meeting.sync.at))}` : ''

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-start justify-between gap-4 px-10 pt-6 max-[820px]:px-6">
        <div className="min-w-0 flex-1">
          <Title meeting={meeting} />
          <div className="tabular mt-1.5 font-mono text-xs text-muted">
            {meetingMeta(meeting)}
            {syncedAt}
          </div>
        </div>
        <Actions {...props} hasTranscript={!!data?.transcript.length} />
      </header>

      <div role="tablist" className="mt-5 flex gap-6 border-b border-border px-10 max-[820px]:px-6">
        {(['notes', 'transcript'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 pb-2.5 font-medium transition-colors duration-150',
              tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground'
            )}
          >
            {t === 'notes' ? 'Notes' : 'Transcript'}
          </button>
        ))}
      </div>

      <div className="flex flex-1 flex-col gap-6 px-10 py-6 max-[820px]:px-6">
        <Notice meeting={meeting} />
        {/* The editor stays mounted on the Transcript tab, so it never shows an older copy of the note. */}
        {data && (
          <div className={cn('flex flex-col gap-6', tab !== 'notes' && 'hidden')}>
            <Editor meetingId={meeting.id} markdown={data.note} version={data.version} editable={!processing} />
            <Tags meeting={meeting} />
          </div>
        )}
        {data && tab === 'transcript' && (
          <Transcript
            meeting={meeting}
            segments={data.transcript}
            note={data.note}
            live={meeting.status === 'recording'}
            liveEnabled={props.settings.liveTranscription}
            onSave={writing ? undefined : saveTranscript}
            onReplaced={reload}
          />
        )}
      </div>
    </div>
  )
}
