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

/** How long the K chews before "Каша" comes back out. Matches the keyframes in styles.css. */
const FULL_MS = 2600

/**
 * Hover the name and the K eats it: "Kasha" slides into the K's jaws,
 * "смачного" (enjoy your meal) follows it in, and "Каша" comes back out.
 * Kasha is porridge.
 */
export function Wordmark() {
  const [over, setOver] = useState(false)
  const [fed, setFed] = useState(false) // the K has finished chewing
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const enter = () => {
    window.clearTimeout(timer.current)
    setOver(true)
    setFed(false)
    timer.current = window.setTimeout(() => setFed(true), FULL_MS)
  }
  const leave = () => {
    window.clearTimeout(timer.current)
    setOver(false)
    setFed(false)
  }

  return (
    <div className="flex w-max cursor-default items-center gap-2 px-2 text-base font-semibold" onMouseEnter={enter} onMouseLeave={leave}>
      <Logo animate={over && !fed} />
      {/* The name's own width holds the space; what shows slides over it, clipped at the K's mouth. */}
      <span className="relative inline-block" style={{ clipPath: 'inset(-8px -200px -8px 0)' }} aria-label="Kasha">
        <span className="invisible">Kasha</span>
        {!over && <span className="absolute inset-0">Kasha</span>}
        {over && !fed && (
          <>
            <span className="absolute inset-0" style={{ animation: 'kasha-eaten 1.3s cubic-bezier(.4,0,.8,.4) both' }}>
              Kasha
            </span>
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 flex items-center gap-1.5 whitespace-nowrap"
              style={{ animation: 'kasha-eaten-next 1.5s .9s cubic-bezier(.4,0,.8,.4) both' }}
            >
              <Stitch size={14} />
              <span lang="uk" className="kasha-gradient-text font-mono text-xs font-semibold">
                смачного
              </span>
            </span>
          </>
        )}
        {over && fed && (
          <span lang="uk" className="absolute inset-0" style={{ animation: 'kasha-burp .6s cubic-bezier(.34,1.56,.64,1) both' }}>
            Каша
          </span>
        )}
      </span>
    </div>
  )
}
