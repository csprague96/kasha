import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { BarView } from '@shared/types'

// Window sizes, with 4 px around what's drawn.
export const BAR_WIDTH = 600
export const BAR_HEIGHT = 56
export const LOGO_SIZE = 48
export const NOTES_HEIGHT = 232

const TICK_MS = 100
const OPEN_TICKS = 2 // the pointer rests on the logo ~0.2 s before it opens, so passing over it doesn't
const CLOSE_TICKS = 8 // and is away from the bar ~0.8 s before it shrinks back

/** Where the bar sits: the middle of its top edge. It shrinks to and opens from this point. */
export interface Anchor {
  x: number
  y: number
}

/** The window for a view, kept on the screen. The drawer opens upwards when there's no room under the bar. */
export function barBounds(at: Anchor, view: Pick<BarView, 'minimized' | 'expanded' | 'notes'>, area: Rectangle): { bounds: Rectangle; up: boolean } {
  const small = view.minimized && !view.expanded && !view.notes
  const width = small ? LOGO_SIZE : BAR_WIDTH
  const row = small ? LOGO_SIZE : BAR_HEIGHT
  const height = row + (view.notes ? NOTES_HEIGHT : 0)
  const fit = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(v, hi)))
  const top = fit(at.y, area.y, area.y + area.height - row)
  const up = view.notes && top + height > area.y + area.height
  return {
    bounds: { x: fit(at.x - width / 2, area.x, area.x + area.width - width), y: up ? top - NOTES_HEIGHT : top, width, height },
    up
  }
}

/** The top middle of the bar row in a window laid out for `up`. */
export function anchorOf(bounds: Rectangle, up: boolean): Anchor {
  return { x: Math.round(bounds.x + bounds.width / 2), y: up ? bounds.y + NOTES_HEIGHT : bounds.y }
}

/**
 * Sizes the recording bar's window for how it's showing: the full bar, the
 * logo it shrinks to, and the notes drawer. The window is only ever as big as
 * what's drawn, so it never blocks clicks to what's under it. A minimized bar
 * opens while the pointer rests on it and shrinks back once it leaves, unless
 * the drawer is out. Watching the pointer is done here because the bar is
 * mostly a drag area, which the page doesn't get mouse events for.
 */
export class BarLayout {
  private view: BarView
  private at: Anchor
  private placed: Rectangle | null = null
  private watch: NodeJS.Timeout | null = null
  private over = 0 // checks in a row with the pointer on the bar; negative while away

  constructor(
    private readonly win: BrowserWindow,
    minimized: boolean,
    at: Anchor | null,
    private readonly onChange: (view: BarView) => void
  ) {
    const area = screen.getPrimaryDisplay().workArea
    this.at = at ?? { x: Math.round(area.x + area.width / 2), y: area.y + 12 }
    this.view = { minimized, expanded: false, notes: false, up: false }
    // Dragged by the user: it stays where they put it, at every size.
    win.on('moved', () => {
      const b = win.getBounds()
      if (this.placed && b.x === this.placed.x && b.y === this.placed.y) return
      this.at = anchorOf(b, this.view.up)
      this.placed = b
    })
    win.on('closed', () => this.unwatch())
    this.apply(false)
  }

  get(): BarView {
    return this.view
  }

  anchor(): Anchor {
    return this.at
  }

  set(patch: Partial<Pick<BarView, 'minimized' | 'notes' | 'expanded'>>): BarView {
    const next = { ...this.view, ...patch }
    if (!next.minimized || patch.minimized) next.expanded = false
    // Opened by a click: it has a moment before shrinking back, as if just pointed at.
    if (patch.expanded) this.over = 0
    this.view = next
    this.apply(true)
    return this.view
  }

  private apply(notify: boolean): void {
    if (this.win.isDestroyed()) return
    const area = screen.getDisplayNearestPoint(this.at).workArea
    const { bounds, up } = barBounds(this.at, this.view, area)
    this.view = { ...this.view, up }
    this.placed = bounds
    this.win.setBounds(bounds)
    if (this.view.minimized) this.startWatching()
    else this.unwatch()
    if (notify) this.onChange(this.view)
  }

  private startWatching(): void {
    if (this.watch) return
    this.over = 0
    this.watch = setInterval(() => {
      if (this.win.isDestroyed() || !this.win.isVisible()) return
      const p = screen.getCursorScreenPoint()
      const b = this.win.getBounds()
      const on = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      this.over = on ? Math.max(1, this.over + 1) : Math.min(-1, this.over - 1)
      if (!this.view.expanded && this.over >= OPEN_TICKS) this.set({ expanded: true })
      else if (this.view.expanded && !this.view.notes && this.over <= -CLOSE_TICKS) this.set({ expanded: false })
    }, TICK_MS)
  }

  private unwatch(): void {
    if (this.watch) clearInterval(this.watch)
    this.watch = null
  }
}
