import { useEffect, useRef, useState } from 'react'
import { Logo } from './Logo'

/** Cross-stitch mark, in the logo's blue with a gold center. */
function Stitch({ size = 20 }: { size?: number }) {
  const cells = [
    [16, 0], [8, 8], [16, 8], [24, 8], [0, 16], [8, 16], [24, 16], [32, 16], [8, 24], [16, 24], [24, 24], [16, 32]
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="stitch-blue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00C6FF" />
          <stop offset="1" stopColor="#0072FF" />
        </linearGradient>
        <linearGradient id="stitch-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE000" />
          <stop offset="1" stopColor="#FFA500" />
        </linearGradient>
      </defs>
      <g fill="url(#stitch-blue)">
        {cells.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="7" height="7" />
        ))}
      </g>
      <rect x="16" y="16" width="7" height="7" fill="url(#stitch-gold)" />
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
      <Logo animate={over} />
      <span
        lang={over ? 'uk' : undefined}
        style={{ display: 'inline-block', animation: over ? 'kasha-lift .9s .4s cubic-bezier(.34,1.56,.64,1) both' : 'none' }}
      >
        {over ? 'Каша' : 'Kasha'}
      </span>
      {/* Sits to the right of the name, where the sidebar has room. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-full z-10 ml-3 flex items-center gap-1.5 whitespace-nowrap transition-[opacity,transform] duration-200"
        style={{ opacity: pop ? 1 : 0, transform: pop ? 'translate(0, -50%)' : 'translate(-4px, -50%)' }}
      >
        <Stitch size={16} />
        <span lang="uk" className="kasha-gradient-text font-mono text-xs font-semibold">
          смачного
        </span>
      </div>
    </div>
  )
}
