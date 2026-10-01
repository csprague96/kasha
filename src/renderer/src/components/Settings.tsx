import { Check } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { APP_LABELS, type SetupStatus, type Settings as SettingsT } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
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

export function Settings({ settings, onChange }: Props) {
  const [status] = useSetupStatus()
  const ob = settings.obsidian
  const setOb = (patch: Partial<SettingsT['obsidian']>) => onChange({ obsidian: { ...ob, ...patch } })

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

      <Section title="Meeting detection">
        <p className="-mt-2 text-[13px] text-muted">Kasha asks to transcribe when one of these apps starts using your microphone.</p>
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
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <span>Speech model</span>
            <span className="text-xs text-muted">Whisper small, English. Runs on this PC.</span>
          </div>
          {status?.whisper.ready ? (
            <span className="text-[13px] text-ok">Installed</span>
          ) : status?.whisper.downloading ? (
            <span className="tabular text-[13px] text-muted">Downloading {Math.round(status.whisper.progress * 100)}%</span>
          ) : (
            <Button size="sm" onClick={() => void window.kasha.downloadWhisper()}>
              Download (200 MB)
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <span>Summaries</span>
            <span className="text-xs text-muted">Written by Claude Code using your sign-in. Only the transcript text is sent.</span>
          </div>
          <span className={cn('text-[13px]', status?.claude.signedIn ? 'text-ok' : 'text-muted')}>
            {!status ? '' : status.claude.signedIn ? 'Signed in' : status.claude.installed ? 'Not signed in' : 'Not installed'}
          </span>
        </div>
        <Toggle
          label="Keep audio after transcribing"
          hint="Off by default. Audio is deleted once the transcript is saved."
          checked={settings.keepAudio}
          onChange={(v) => onChange({ keepAudio: v })}
        />
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
      </Section>
    </div>
  )
}
