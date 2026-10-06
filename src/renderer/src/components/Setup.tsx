import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Settings as SettingsT } from '@shared/types'
import { cn } from '@/lib/utils'
import { Logo } from './Logo'
import { useSetupStatus, VaultPicker } from './Settings'
import { Button } from './ui/button'

interface Props {
  settings: SettingsT
  onChange: (patch: Partial<SettingsT>) => Promise<void>
}

function Row({ done, title, description, children }: { done: boolean; title: string; description: string; children?: ReactNode }) {
  return (
    <div className="flex gap-4 border-t border-border py-5 first:border-t-0">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
          done ? 'border-ok bg-ok text-surface' : 'border-border'
        )}
        aria-hidden="true"
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-[13px] text-muted">{description}</div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Setup({ settings, onChange }: Props) {
  const [status, refresh] = useSetupStatus()
  if (!status) return null
  const w = status.whisper

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-[560px] flex-col gap-6">
        <div className="flex items-center gap-3">
          <Logo size={32} />
          <h1 className="text-xl font-semibold">Set up Kasha</h1>
        </div>
        <p className="text-muted">
          Kasha records calls on this PC, transcribes them locally and writes the notes to Obsidian. It never joins the call.
        </p>

        <div className="rounded-lg border border-border bg-surface px-5">
          <Row
            done={w.ready && w.speakers}
            title="Speech models"
            description="Transcribes on this PC and tells the people on the call apart. Audio never leaves it."
          >
            {!(w.ready && w.speakers) && !w.downloading && (
              <div className="flex items-center gap-3">
                <Button variant="primary" size="sm" onClick={() => void window.kasha.downloadWhisper()}>
                  Download ({w.downloadMb} MB)
                </Button>
                {w.error && <span className="text-[13px] text-destructive">{w.error}</span>}
              </div>
            )}
            {w.downloading && (
              <div className="flex items-center gap-3" role="status">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                  <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${w.progress * 100}%` }} />
                </div>
                <span className="tabular w-10 text-right font-mono text-xs text-muted">{Math.round(w.progress * 100)}%</span>
              </div>
            )}
          </Row>

          <Row
            done={status.claude.signedIn || status.codex.signedIn}
            title="Summaries"
            description="Written from the transcript by Claude Code or Codex, using your existing sign-in. No API key needed."
          >
            {status.claude.signedIn || status.codex.signedIn ? (
              <span className="text-[13px] text-muted">
                Using {status.claude.signedIn ? 'Claude Code' : 'Codex'}. You can change this in Settings.
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
                <span>
                  {status.claude.installed
                    ? 'Open a terminal, run claude and sign in.'
                    : status.codex.installed
                      ? 'Open a terminal and run codex login.'
                      : 'Install Claude Code or Codex, then sign in. Without either you still get transcripts.'}
                </span>
                <Button size="sm" onClick={refresh}>
                  Check again
                </Button>
              </div>
            )}
          </Row>

          <Row
            done={!!settings.obsidian.vault}
            title="Obsidian vault"
            description={`Notes are saved to ${settings.obsidian.folder}/ in this vault. Optional; you can set it later.`}
          >
            <VaultPicker settings={settings} onChange={onChange} vaults={status.vaults} />
          </Row>
        </div>

        <div className="flex items-center justify-between gap-4">
          <p className="text-[13px] text-muted">Tell people on the call when you're transcribing.</p>
          <Button variant="primary" disabled={!w.ready} onClick={() => void onChange({ setupComplete: true })}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
