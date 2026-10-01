/** Logo 2b: two text lines over a bowl. Lines take the current color. */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="12" y="5" width="40" height="8" rx="4" fill="currentColor" />
      <rect x="12" y="19" width="28" height="8" rx="4" fill="currentColor" />
      <path d="M6 34 H58 A26 26 0 0 1 6 34 Z" fill="var(--record)" />
    </svg>
  )
}
