import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppInfo, UpdateStatus } from '@shared/types'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void window.kasha.appInfo().then(setInfo), [])
  return info
}

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void window.kasha.updateStatus().then(setStatus)
    return window.kasha.onUpdateStatus(setStatus)
  }, [])
  return status
}

/** Bottom of the sidebar: the version, and the update when one is on its way or ready. */
export function VersionLine({ onOpenSettings }: { onOpenSettings: () => void }) {
  const info = useAppInfo()
  const update = useUpdateStatus()
  if (!info) return null
  if (update?.state === 'ready') {
    return (
      <button
        onClick={() => void window.kasha.installUpdate()}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-primary hover:bg-foreground/5"
        title={`Kasha ${update.version} is downloaded. Restart to finish updating.`}
      >
        <span className="truncate">Restart to update to {update.version}</span>
      </button>
    )
  }
  const downloading = update?.state === 'downloading'
  return (
    <button
      onClick={onOpenSettings}
      className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-foreground/5"
      title={downloading ? `Downloading Kasha ${update.version}` : 'Version. Updates are in Settings.'}
    >
      {downloading && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
      <span className="tabular truncate">
        {downloading ? `Downloading ${update.version}${update.percent ? ` · ${update.percent}%` : ''}` : `Kasha ${info.version}`}
      </span>
    </button>
  )
}

/** Settings: where the app stands on updates, and a way to check now. */
export function UpdateControls() {
  const info = useAppInfo()
  const update = useUpdateStatus()
  const [checking, setChecking] = useState(false)
  if (!info || !update) return null
  const check = async () => {
    setChecking(true)
    try {
      await window.kasha.checkForUpdates()
    } finally {
      setChecking(false)
    }
  }
  const text =
    update.state === 'dev'
      ? update.message
      : update.state === 'checking' || checking
        ? 'Checking…'
        : update.state === 'downloading'
          ? `Downloading Kasha ${update.version}${update.percent ? ` (${update.percent}%)` : ''}. It installs when you restart.`
          : update.state === 'ready'
            ? `Kasha ${update.version} is downloaded.${update.message ? ` ${update.message}` : ''}`
            : (update.message ?? 'Kasha checks for updates a few times a day and downloads them in the background.')
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="flex items-center justify-between gap-4">
        <span>
          Kasha {info.version}
          {!info.installed && <span className="text-muted"> · from source</span>}
        </span>
        {update.state === 'ready' ? (
          <Button size="sm" variant="primary" onClick={() => void window.kasha.installUpdate()}>
            Restart to update
          </Button>
        ) : (
          <Button size="sm" onClick={() => void check()} disabled={!info.installed || checking || update.state === 'downloading'}>
            Check for updates
          </Button>
        )}
      </div>
      <p className={cn('text-xs', update.state === 'error' ? 'text-destructive' : 'text-muted')} role="status">
        {text}
      </p>
    </div>
  )
}
