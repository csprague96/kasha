import { Check, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  APP_LABELS,
  normName,
  SPEECH_MODELS,
  type CalendarMatch,
  type SetupStatus,
  type Settings as SettingsT,
  type SpeechModelId,
  type VocabularyEntry,
  type VoiceProfile
} from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { UpdateControls } from './Updates'

interface Props {
  settings: SettingsT
  onChange: (patch: Partial<SettingsT>) => Promise<void>
}

export function useSetupStatus(): [SetupStatus | null, () => void] {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const refresh = () => void window.kasha.setupStatus().then(setStatus)
  useEffect(() => {
    refresh()
    return window.kasha.onSetupChanged(setStatus)
  }, [])
  return [status, refresh]
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/** A labelled control. `group` is for several controls (a list with buttons), where a <label> would click the first one. */
function Field({ label, hint, group, children }: { label: string; hint?: string; group?: boolean; children: ReactNode }) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className="flex flex-col gap-1.5" role={group ? 'group' : undefined} aria-label={group ? label : undefined}>
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </Tag>
  )
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <span>{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

function EngineStatus({ name, s, signIn }: { name: string; s: { installed: boolean; signedIn: boolean }; signIn: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted">{name}</span>
      <span className={cn(s.signedIn ? 'text-ok' : 'text-muted')}>
        {s.signedIn ? 'Signed in' : s.installed ? `Not signed in. In a terminal, ${signIn}.` : 'Not installed'}
      </span>
    </div>
  )
}

/** Text input that saves on blur instead of on every keystroke. */
function LazyInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<'input'>, 'value'>) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <Input
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

export function VaultPicker({ settings, onChange, vaults }: Props & { vaults: string[] }) {
  const choose = async () => {
    const dir = await window.kasha.pickFolder()
    if (dir) await onChange({ obsidian: { ...settings.obsidian, vault: dir } })
  }
  const options = Array.from(new Set([...vaults, settings.obsidian.vault].filter(Boolean)))
  return (
    <div className="flex flex-col gap-2">
      {options.map((v) => {
        const selected = v === settings.obsidian.vault
        return (
          <button
            key={v}
            onClick={() => void onChange({ obsidian: { ...settings.obsidian, vault: v } })}
            className={cn(
              'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left font-mono text-[13px]',
              selected ? 'border-primary bg-surface' : 'border-border bg-surface hover:bg-sidebar'
            )}
            aria-pressed={selected}
          >
            <span className="truncate">{v}</span>
            {selected && <Check className="size-4 shrink-0 text-primary" />}
          </button>
        )
      })}
      <div>
        <Button size="sm" onClick={choose}>
          {options.length ? 'Choose another folder' : 'Choose vault folder'}
        </Button>
      </div>
    </div>
  )
}

const splitList = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** Names and product terms the speech model should spell right. */
function Vocabulary({ entries, onChange }: { entries: VocabularyEntry[]; onChange: (v: VocabularyEntry[]) => void }) {
  const [term, setTerm] = useState('')
  const [heard, setHeard] = useState('')
  const add = () => {
    const t = term.trim()
    if (!t) return
    const existing = entries.find((e) => e.term.toLowerCase() === t.toLowerCase())
    const extra = splitList(heard)
    onChange(
      existing
        ? entries.map((e) => (e === existing ? { ...e, heardAs: Array.from(new Set([...e.heardAs, ...extra])) } : e))
        : [...entries, { term: t, heardAs: extra }]
    )
    setTerm('')
    setHeard('')
  }
  const update = (i: number, patch: Partial<VocabularyEntry>) => onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)))

  return (
    <div className="flex flex-col gap-3">
      {entries.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
          {entries.map((e, i) => (
            <div key={`${e.term}-${i}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 px-2 py-1.5">
              <LazyInput
                aria-label="Name or term"
                className="h-8 border-transparent bg-transparent px-1.5 font-medium hover:border-border"
                value={e.term}
                onCommit={(v) => (v.trim() ? update(i, { term: v.trim() }) : onChange(entries.filter((_, j) => j !== i)))}
              />
              <LazyInput
                aria-label={`Often heard as, for ${e.term}`}
                placeholder="Often heard as"
                className="h-8 border-transparent bg-transparent px-1.5 text-[13px] hover:border-border"
                value={e.heardAs.join(', ')}
                onCommit={(v) => update(i, { heardAs: splitList(v) })}
              />
              <Button variant="ghost" size="icon" aria-label={`Remove ${e.term}`} onClick={() => onChange(entries.filter((_, j) => j !== i))}>
                <X className="text-muted" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <Input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Name or term, e.g. RCVR" aria-label="New name or term" />
        <Input value={heard} onChange={(e) => setHeard(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Often heard as, e.g. Recover" aria-label="Often heard as" />
        <Button onClick={add} disabled={!term.trim()}>
          Add
        </Button>
      </div>
    </div>
  )
}

/** A list of meeting titles or names, with remove buttons and an add box. */
function NameList({ items, onChange, placeholder, label }: { items: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string }) {
  const [v, setV] = useState('')
  const add = () => {
    const t = v.trim()
    if (!t) return
    if (!items.some((x) => normName(x) === normName(t))) onChange([...items, t])
    setV('')
  }
  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
          {items.map((x) => (
            <li key={x} className="flex items-center justify-between gap-3 px-3 py-1 text-[13px]">
              <span className="truncate">{x}</span>
              <Button variant="ghost" size="icon" aria-label={`Remove ${x}`} onClick={() => onChange(items.filter((y) => y !== x))}>
                <X className="size-3.5 text-muted" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {placeholder && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={placeholder} aria-label={label} />
          <Button onClick={add} disabled={!v.trim()}>
            Add
          </Button>
        </div>
      )}
    </div>
  )
}

const MODES: Array<{ value: SettingsT['recording']['mode']; label: string; hint: string }> = [
  { value: 'ask', label: 'Ask each time', hint: 'A prompt in the corner when a call starts. Meetings and people below are recorded without asking.' },
  { value: 'always', label: 'Record every call', hint: 'No prompt. The recording bar shows while Kasha records, and Stop ends it.' },
  { value: 'rules', label: 'Only the meetings and people below', hint: 'No prompt for anything else. Start other recordings yourself.' }
]

/** Runs the Outlook lookup once, so the user can see whether it works for them. */
function CalendarCheck() {
  const [state, setState] = useState<'idle' | 'checking' | { match: CalendarMatch | null }>('idle')
  const check = async () => {
    setState('checking')
    setState({ match: await window.kasha.checkCalendar() })
  }
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <Button size="sm" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' ? 'Checking…' : 'Check now'}
      </Button>
      {typeof state === 'object' && (
        <span className="text-muted" role="status">
          {state.match
            ? `Found ${state.match.subject ? `“${state.match.subject}”` : 'a meeting'} with ${state.match.attendees.length} ${state.match.attendees.length === 1 ? 'person' : 'people'} invited.`
            : 'No meeting found right now. Try during a meeting. If it never works, turn on the Microsoft 365 connector in Claude.'}
        </span>
      )}
    </div>
  )
}

/** People whose voices Kasha has learned. Removing one forgets the voice; the notes keep their names. */
function Voices() {
  const [voices, setVoices] = useState<VoiceProfile[] | null>(null)
  const refresh = () => void window.kasha.listVoices().then(setVoices)
  useEffect(() => {
    refresh()
    return window.kasha.onMeetingsChanged(refresh)
  }, [])
  if (!voices) return null
  if (!voices.length) return <p className="text-[13px] text-muted">No voices learned yet. Name a speaker in a transcript and Kasha will recognise them next time.</p>
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
      {voices.map((v) => (
        <li key={v.name} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13px]">
          <span className="truncate">{v.name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted">
            {v.meetings} {v.meetings === 1 ? 'meeting' : 'meetings'}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Forget ${v.name}'s voice`}
            title="Forget this voice"
            onClick={() => void window.kasha.removeVoice(v.name).then(refresh)}
          >
            <X className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  )
}

function preview(s: SettingsT): string {
  return [
    '---',
    'title: Roadmap review',
    'date: 2026-10-01',
    'time: "10:02"',
    'app: Teams',
    'duration: 42m',
    'tags: [roadmap, q4]',
    'source: kasha',
    '---',
    '## Summary',
    'Agreed to ship the import tool in Q4…',
    s.obsidian.includeTranscript ? '\n> [!quote]- Transcript' : ''
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** The three speech models, with what each trades off. Choosing one that isn't installed downloads it. */
function ModelPicker({
  settings,
  status,
  onChange,
  refresh
}: Props & { status: SetupStatus | null; refresh: () => void }) {
  const choose = async (id: SpeechModelId) => {
    await onChange({ speechModel: id })
    refresh()
    if (!status?.whisper.installed.includes(id)) void window.kasha.downloadWhisper()
  }
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Speech model">
      {SPEECH_MODELS.map((m) => {
        const selected = settings.speechModel === m.id
        const installed = !!status?.whisper.installed.includes(m.id)
        const downloading = selected && !!status?.whisper.downloading
        return (
          <label
            key={m.id}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
              selected ? 'border-primary bg-surface' : 'border-border bg-surface hover:bg-sidebar'
            )}
          >
            <input
              type="radio"
              name="speech-model"
              className="mt-1 accent-[var(--color-primary)]"
              checked={selected}
              onChange={() => void choose(m.id)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline justify-between gap-3">
                <span>
                  <span className="font-medium">{m.name}</span>
                  <span className="text-muted"> · {m.tagline}</span>
                </span>
                <span className="tabular shrink-0 text-xs text-muted">
                  {downloading
                    ? `Downloading ${Math.round((status?.whisper.progress ?? 0) * 100)}%`
                    : installed
                      ? 'Installed'
                      : selected && status?.whisper.error
                        ? 'Download failed'
                        : `${m.mb} MB download`}
                </span>
              </span>
              <span className="text-xs text-muted">{m.detail}</span>
              {selected && !installed && !downloading && status && (
                <span className="pt-1">
                  <Button size="sm" onClick={() => void window.kasha.downloadWhisper()}>
                    {status.whisper.error ? 'Try the download again' : `Download (${status.whisper.downloadMb} MB)`}
                  </Button>
                  {status.whisper.error && <span className="ml-2 text-xs text-destructive">{status.whisper.error}</span>}
                </span>
              )}
            </span>
          </label>
        )
      })}
      {status?.whisper.model === null && status.whisper.engine && !status.whisper.downloading && (
        <p className="text-xs text-muted">
          Until the download finishes, Kasha keeps transcribing with the {status.whisper.engine === 'parakeet' ? 'Parakeet' : 'Whisper'} model it has.
        </p>
      )}
    </div>
  )
}

export function Settings({ settings, onChange }: Props) {
  const [status, refreshStatus] = useSetupStatus()
  const ob = settings.obsidian
  const setOb = (patch: Partial<SettingsT['obsidian']>) => onChange({ obsidian: { ...ob, ...patch } })
  const rec = settings.recording
  const setRec = (patch: Partial<SettingsT['recording']>) => onChange({ recording: { ...rec, ...patch } })

  return (
    <div className="flex max-w-[620px] flex-col gap-10 px-10 py-8 max-[820px]:px-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Section title="Obsidian">
        <Field label="Vault">
          <VaultPicker settings={settings} onChange={onChange} vaults={status?.vaults ?? []} />
        </Field>
        <Field label="Folder">
          <LazyInput className="font-mono text-[13px]" value={ob.folder} onCommit={(v) => setOb({ folder: v.trim() })} />
        </Field>
        <Field label="File name" hint="Use {date}, {time} and {title}.">
          <LazyInput className="font-mono text-[13px]" value={ob.fileName} onCommit={(v) => setOb({ fileName: v.trim() || '{date} {title}' })} />
        </Field>
        <div className="flex flex-col gap-3">
          <Toggle label="Sync when a meeting ends" checked={ob.syncOnEnd} onChange={(v) => setOb({ syncOnEnd: v })} />
          <Toggle label="Include full transcript" checked={ob.includeTranscript} onChange={(v) => setOb({ includeTranscript: v })} />
          <Toggle label="Save screenshots to attachments/" checked={ob.attachments} onChange={(v) => setOb({ attachments: v })} />
        </div>
        <Field label="Preview">
          <pre className="m-0 rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">
            {preview(settings)}
          </pre>
        </Field>
      </Section>

      <Section title="Recording">
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="When a call starts">
          <span className="text-xs text-muted">When a call starts</span>
          {MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="record-mode"
                className="mt-1 accent-[var(--color-primary)]"
                checked={rec.mode === m.value}
                onChange={() => void setRec({ mode: m.value })}
              />
              <span className="flex flex-col">
                <span>{m.label}</span>
                <span className="text-xs text-muted">{m.hint}</span>
              </span>
            </label>
          ))}
          {rec.mode !== 'ask' && (
            <p className="text-xs text-muted">Recording without asking: check your team’s rules on letting people know a call is recorded.</p>
          )}
        </div>
        <Field group label="Always record these meetings" hint="Matched on the meeting’s title. When you record a recurring meeting, Kasha offers to add it here.">
          <NameList items={rec.meetings} onChange={(meetings) => void setRec({ meetings })} placeholder="Meeting title, e.g. Weekly product sync" label="New meeting title" />
        </Field>
        {rec.declined.length > 0 && (
          <Field group label="Kasha won’t offer to always record" hint="You chose “Just this once” for these. Remove one to be asked again.">
            <NameList items={rec.declined} onChange={(declined) => void setRec({ declined })} label="Meeting title not to offer" />
          </Field>
        )}
        <Field
          group
          label="Always record calls with"
          hint={
            rec.lookupAttendees
              ? 'Matched on the call’s title (1:1 calls and huddles show the other person’s name) and on the Outlook invite list.'
              : 'Matched on the call’s title, which shows the other person’s name on 1:1 calls and huddles. Turn on the Outlook lookup below to match group meetings too.'
          }
        >
          <NameList items={rec.people} onChange={(people) => void setRec({ people })} placeholder="First and last name" label="New person" />
        </Field>
        <Toggle
          label="Look up who’s invited in Outlook"
          hint="Asks Claude Code to find the call in your calendar through your Claude account’s Microsoft 365 connector. Names help label speakers and the summary. Takes about 10 seconds per call."
          checked={rec.lookupAttendees}
          onChange={(v) => void setRec({ lookupAttendees: v })}
        />
        {rec.lookupAttendees && <CalendarCheck />}
      </Section>

      <Section title="Meeting detection">
        <p className="-mt-2 text-[13px] text-muted">Kasha notices a call when one of these apps starts using your microphone.</p>
        <div className="flex flex-col gap-3">
          {(Object.keys(settings.detect) as Array<keyof SettingsT['detect']>).map((app) => (
            <Toggle
              key={app}
              label={APP_LABELS[app]}
              hint={app === 'browser' ? 'Edge, Chrome or Firefox calls, such as Teams on the web' : undefined}
              checked={settings.detect[app]}
              onChange={(v) => onChange({ detect: { ...settings.detect, [app]: v } })}
            />
          ))}
        </div>
      </Section>

      <Section title="Transcription">
        <Field group label="Speech model" hint="All of them run on this PC, so audio never leaves it. Changing the model downloads it once.">
          <ModelPicker settings={settings} status={status} onChange={onChange} refresh={refreshStatus} />
        </Field>
        {status && !status.whisper.speakers && !status.whisper.downloading && (
          <div className="flex items-center justify-between gap-4 text-[13px]">
            <span className="text-muted">The speaker models aren’t installed, so everyone on the call stays “Others”.</span>
            <Button size="sm" onClick={() => void window.kasha.downloadWhisper()}>
              Download ({status.whisper.downloadMb} MB)
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span>Summaries</span>
              <span className="text-xs text-muted">Written using your own sign-in. Only the transcript text is sent.</span>
            </div>
            <select
              aria-label="Summary engine"
              value={settings.summaryEngine}
              onChange={(e) => void onChange({ summaryEngine: e.target.value as SettingsT['summaryEngine'] })}
              className="h-9 rounded-md border border-border bg-surface px-2 text-sm focus-visible:outline-offset-0"
            >
              <option value="auto">Automatic</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          {status && (
            <div className="flex flex-col gap-1 text-[13px]">
              <EngineStatus name="Claude Code" s={status.claude} signIn="run claude" />
              <EngineStatus name="Codex" s={status.codex} signIn="run codex login" />
            </div>
          )}
          {settings.summaryEngine === 'auto' && (
            <span className="text-xs text-muted">Automatic uses Claude Code when signed in, otherwise Codex.</span>
          )}
        </div>
        <Toggle
          label="Transcribe during the call"
          hint="Spreads the work across the call at low priority, so notes are ready soon after it ends. Turn off to transcribe after the call instead."
          checked={settings.liveTranscription}
          onChange={(v) => onChange({ liveTranscription: v })}
        />
        {settings.liveTranscription && (
          <Toggle
            label="Wait when memory is low"
            hint="Holds off transcribing during the call while the PC has under 1.5 GB free. Nothing is lost: it catches up once memory frees or the call ends. You can also pause it from the recording bar."
            checked={rec.pauseWhenLowMemory}
            onChange={(v) => void setRec({ pauseWhenLowMemory: v })}
          />
        )}
        <Toggle
          label="Keep audio after transcribing"
          hint="Off by default. Audio is deleted once the transcript is saved."
          checked={settings.keepAudio}
          onChange={(v) => onChange({ keepAudio: v })}
        />
      </Section>

      <Section title="Speakers">
        <Toggle
          label="Tell speakers apart"
          hint="After a call, the people on the computer's audio become Speaker 1, Speaker 2 and so on. Rename them at the top of the transcript."
          checked={settings.speakers.separate}
          onChange={(v) => onChange({ speakers: { ...settings.speakers, separate: v } })}
        />
        <Toggle
          label="Recognise people from past meetings"
          hint="When you name a speaker, Kasha remembers the voice and uses the name next time. Voices stay on this PC."
          checked={settings.speakers.recognize}
          onChange={(v) => onChange({ speakers: { ...settings.speakers, recognize: v } })}
        />
        {settings.speakers.recognize && <Voices />}
      </Section>

      <Section title="Names and terms">
        <p className="-mt-2 text-[13px] text-muted">
          People’s names and product terms the speech model should spell right. Kasha passes them to it as hints, and replaces
          what it often hears instead, wherever it appears as a whole word.
        </p>
        <Vocabulary entries={settings.vocabulary} onChange={(vocabulary) => void onChange({ vocabulary })} />
      </Section>

      <Section title="Actions">
        <Field label="Your name" hint="Actions assigned to this name in a meeting count as yours.">
          <LazyInput value={settings.myName} placeholder="First and last name" onCommit={(v) => onChange({ myName: v.trim() })} />
        </Field>
        <Toggle
          label="Daily reminder"
          hint="A notification on weekdays when you have open actions."
          checked={settings.reminders.enabled}
          onChange={(v) => onChange({ reminders: { ...settings.reminders, enabled: v } })}
        />
        {settings.reminders.enabled && (
          <Field label="Reminder time">
            <Input
              type="time"
              className="w-32 font-mono text-[13px]"
              value={settings.reminders.time}
              onChange={(e) => e.target.value && onChange({ reminders: { ...settings.reminders, time: e.target.value } })}
            />
          </Field>
        )}
      </Section>

      <Section title="General">
        <Toggle
          label="Start Kasha when you sign in"
          checked={settings.launchAtLogin}
          onChange={(v) => onChange({ launchAtLogin: v })}
        />
        <UpdateControls />
      </Section>
    </div>
  )
}
