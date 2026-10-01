import { useEffect, useRef, useState } from 'react'
import { Logo } from './Logo'

/** Cross-stitch mark from the brand sheet. */
function Stitch({ size = 20 }: { size?: number }) {
  const cells = [
    [16, 0], [8, 8], [16, 8], [24, 8], [0, 16], [8, 16], [24, 16], [32, 16], [8, 24], [16, 24], [24, 24], [16, 32]
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="text-primary">
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="7" height="7" fill="currentColor" />
      ))}
      <rect x="16" y="16" width="7" height="7" fill="var(--record)" />
    </svg>
  )
}

/**
 * Hovering the name reads it in Cyrillic, and a small "enjoy your meal"
 * appears for a moment. Kasha is porridge.
 */
export function Wordmark() {
  const [over, setOver] = useState(false)
  const [pop, setPop] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const enter = () => {
    window.clearTimeout(timer.current)
    setOver(true)
    setPop(true)
    timer.current = window.setTimeout(() => setPop(false), 2200)
  }

  return (
    <div
      className="relative flex w-max cursor-default items-center gap-2 px-2 text-base font-semibold"
      onMouseEnter={enter}
      onMouseLeave={() => setOver(false)}
    >
      <Logo className="text-primary" />
      <span lang={over ? 'uk' : undefined}>{over ? 'Каша' : 'Kasha'}</span>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-full left-2 z-10 mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 transition-[opacity,transform] duration-200"
        style={{ opacity: pop ? 1 : 0, transform: pop ? 'translateY(0)' : 'translateY(-4px)' }}
      >
        <Stitch />
        <span lang="uk" className="font-mono text-xs font-medium">
          смачного
        </span>
      </div>
    </div>
  )
}
