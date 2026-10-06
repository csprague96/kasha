import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_LABELS, GENERIC_TITLE, type ToastState } from '@shared/types'
import { Button } from './components/ui/button'
import './styles.css'

function Toast() {
  const [t, setT] = useState<ToastState | null>(null)

  useEffect(() => {
    void window.toast.state().then(setT)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.toast.dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!t) return null
  if (t.kind === 'recurring') {
    return (
      <div className="flex h-full flex-col gap-3.5 rounded-[10px] border border-border bg-surface p-4">
        <span className="font-semibold">Record this meeting every time?</span>
        <div className="min-w-0">
          <div className="truncate">{t.title}</div>
          <div className="mt-1 text-xs text-muted">It recurs. Kasha can start recording it without asking.</div>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => window.toast.accept()}>
            Always record
          </Button>
          <Button onClick={() => window.toast.dismiss()}>Just this once</Button>
        </div>
      </div>
    )
  }
  const m = t.meeting
  return (
    <div className="flex h-full flex-col gap-3.5 rounded-[10px] border border-border bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="size-2 rounded-full bg-record" />
        <span className="font-semibold">Meeting detected</span>
      </div>
      <div className="min-w-0">
        <div className="truncate">{m.title}</div>
        <div className="mt-1 font-mono text-xs text-muted">{APP_LABELS[m.app]}</div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => window.toast.accept()} autoFocus>
          Start transcribing
        </Button>
        <Button onClick={() => window.toast.dismiss()}>Not now</Button>
      </div>
      {!GENERIC_TITLE.test(m.title) && (
        <button
          onClick={() => window.toast.never()}
          className="-mt-1.5 self-start text-xs text-muted hover:text-foreground hover:underline"
          title="Kasha won’t record or ask about a meeting with this title again. Change it in Settings."
        >
          Never record this meeting
        </button>
      )}
    </div>
  )
}

document.body.style.background = 'transparent'
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toast />
  </StrictMode>
)
