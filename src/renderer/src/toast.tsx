import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_LABELS, type DetectedMeeting } from '@shared/types'
import { Button } from './components/ui/button'
import './styles.css'

function Toast() {
  const [m, setM] = useState<DetectedMeeting | null>(null)

  useEffect(() => {
    void window.toast.detected().then(setM)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.toast.dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!m) return null
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
    </div>
  )
}

document.body.style.background = 'transparent'
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Toast />
  </StrictMode>
)
