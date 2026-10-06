import { useId } from 'react'

/** Rounded vertical bar with semicircular ends. */
const pill = (x: number, y: number, w: number, h: number): string => {
  const r = w / 2
  return `M${x},${y + r}a${r},${r} 0 0 1 ${w},0V${y + h - r}a${r},${r} 0 0 1 ${-w},0Z`
}

type Stops = readonly [string, string]
const BLUE: Stops = ['#00C6FF', '#0072FF']
const GOLD: Stops = ['#FFE000', '#FFA500']
const FOLD: Stops = ['#33D2FF', '#33D2FF']
const FOLD_GOLD: Stops = ['#FFE45C', '#FFE45C']

type Part = { k: string; base: Stops; swap: Stops; d: string; anim: string; delay: number; origin: string }

// The viewBox starts at (160, 220); CSS transform origins are measured from there.
const VIEW = { x: 160, y: 220 }
/** Where the K's arms meet: the hinge the jaws turn on. */
const HINGE = `${722 - VIEW.x}px ${685 - VIEW.y}px`

/** Sound bars, the K stem, and the two arms of the K, in paint order. */
const PARTS: Part[] = [
  { k: 'pS', base: BLUE, swap: GOLD, anim: 'kasha-pump .9s 0s', delay: 0.1, origin: 'bottom', d: pill(184, 508, 100, 273) },
  { k: 'pY', base: GOLD, swap: BLUE, anim: 'kasha-pump .9s .07s', delay: 0.17, origin: 'bottom', d: pill(317, 391, 114, 478) },
  { k: 'pT', base: BLUE, swap: GOLD, anim: 'kasha-pump .9s .14s', delay: 0.24, origin: 'bottom', d: 'M463,800V346a104,104 0 0 1 208,0V800Z' },
  { k: 'pB', base: GOLD, swap: BLUE, anim: 'kasha-pump .9s .14s', delay: 0.24, origin: 'bottom', d: pill(463, 800, 191, 214) },
  {
    k: 'aL', base: GOLD, swap: BLUE, anim: 'kasha-chomp-lower .55s 0s 5', delay: 1.2, origin: HINGE,
    d: 'M722,685L995,862C1045,895 1048,960 1000,1010C960,1048 900,1045 865,1018L555,775C600,740 660,712 722,685Z'
  },
  {
    k: 'fo', base: FOLD, swap: FOLD_GOLD, anim: 'none', delay: 1.2, origin: HINGE,
    d: 'M463,730C470,650 530,580 595,535C580,570 590,590 610,610C645,645 690,665 722,685C660,712 600,735 555,775C500,815 463,860 463,900Z'
  },
  {
    k: 'aU', base: BLUE, swap: GOLD, anim: 'kasha-chomp-upper .55s 0s 5', delay: 1.2, origin: HINGE,
    d: 'M595,535L671,475L920,290C975,245 1045,255 1085,300C1115,340 1110,420 1055,458C960,527 840,610 722,685C690,662 645,640 610,610C590,590 580,570 595,535Z'
  }
]

const EASE = 'cubic-bezier(.34,1.56,.64,1)'

/**
 * The K mark. With `animate` on, the bars pump from the bottom and the K's
 * arms open and close like jaws: the wordmark feeds it the name. Colours
 * swap between blue and gold as it goes.
 */
export function Logo({ size = 22, animate = false, className }: { size?: number; animate?: boolean; className?: string }) {
  const uid = useId().replace(/:/g, '')
  return (
    <svg
      height={size}
      width={(size * 970) / 840}
      viewBox={`${VIEW.x} ${VIEW.y} 970 840`}
      className={className}
      style={{ overflow: 'visible' }}
      aria-hidden="true"
    >
      <defs>
        {PARTS.map((p) => {
          const [a, b] = animate ? p.swap : p.base
          const transition = `stop-color 0.4s ${p.delay}s`
          return (
            <linearGradient key={p.k} id={`${uid}${p.k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: a, transition }} />
              <stop offset="1" style={{ stopColor: b, transition }} />
            </linearGradient>
          )
        })}
      </defs>
      {PARTS.map((p) => (
        <path
          key={p.k}
          d={p.d}
          fill={`url(#${uid}${p.k})`}
          className="kasha-logo-part"
          style={{
            transformBox: p.origin === 'bottom' ? 'fill-box' : 'view-box',
            transformOrigin: p.origin,
            animation: animate && p.anim !== 'none' ? `${p.anim} ${EASE} both` : 'none'
          }}
        />
      ))}
    </svg>
  )
}
