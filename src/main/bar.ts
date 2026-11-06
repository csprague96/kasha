import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { BarPlace, BarView } from '@shared/types'

// Window sizes, with 4 px around what's drawn.
export const BAR_WIDTH = 600
export const BAR_HEIGHT = 56
export const LOGO_SIZE = 48
export const NOTES_HEIGHT = 232
/** Dragged this close to a screen edge (or past it), the bar snaps to it. */
export const SNAP = 32
/** A snapped window's gap from the edge, so the bar drawn inside sits 8 px off it. */
export const EDGE_GAP = 4

const TICK_MS = 100
const OPEN_TICKS = 2 // the pointer rests on the logo ~0.2 s before it opens, so passing over it doesn't
const CLOSE_TICKS = 8 // and is away from the bar ~0.8 s before it shrinks back
const DRAG_MS = 16 // while dragged, the bar follows the pointer about once a frame
const DRAG_MAX_MS = 60_000 // a drag whose end never arrived (the page went away) lets go by itself

/** Where the bar sits. See BarPlace. */
export type Anchor = BarPlace

type Sized = Pick<BarView, 'minimized' | 'expanded' | 'notes'>

const isSmall = (view: Sized) => view.minimized && !view.expanded && !view.notes

/** The window for a view, kept on the screen. The drawer opens upwards when there's no room under the bar. */
export function barBounds(at: Anchor, view: Sized, area: Rectangle): { bounds: Rectangle; up: boolean } {
  const small = isSmall(view)
  const width = small ? LOGO_SIZE : BAR_WIDTH
  const row = small ? LOGO_SIZE : BAR_HEIGHT
  const height = row + (view.notes ? NOTES_HEIGHT : 0)
  const fit = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(v, hi)))
  const right = area.x + area.width - width - EDGE_GAP
  const bottom = area.y + area.height - row - EDGE_GAP
  const left = at.side === 'left' ? area.x + EDGE_GAP : at.side === 'right' ? right : fit(at.x - width / 2, area.x, area.x + area.width - width)
  const top = at.edge === 'top' ? area.y + EDGE_GAP : at.edge === 'bottom' ? bottom : fit(at.y, area.y, area.y + area.height - row)
  const up = view.notes && top + height > area.y + area.height
  return {
    bounds: { x: left, y: up ? top - NOTES_HEIGHT : top, width, height },
    up
  }
}

/** The top middle of the bar row in a window laid out for `up`. */
export function anchorOf(bounds: Rectangle, up: boolean): Anchor {
  return { x: Math.round(bounds.x + bounds.width / 2), y: up ? bounds.y + NOTES_HEIGHT : bounds.y }
}

/** A place read back from settings.json, or null if it isn't one. */
export function placeFrom(v: unknown): Anchor | null {
  const p = v as Partial<Anchor> | null
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  const out: Anchor = { x: Math.round(p.x!), y: Math.round(p.y!) }
  if (p.side === 'left' || p.side === 'right') out.side = p.side
  if (p.edge === 'top' || p.edge === 'bottom') out.edge = p.edge
  return out
}

/** Where the pointer has dragged the bar, snapped to any screen edge the bar, at its size now, is near. */
export function snapped(at: { x: number; y: number }, view: Sized, area: Rectangle): Anchor {
  const small = isSmall(view)
  const width = small ? LOGO_SIZE : BAR_WIDTH
  const row = small ? LOGO_SIZE : BAR_HEIGHT
  const out: Anchor = { x: Math.round(at.x), y: Math.round(at.y) }
  const left = at.x - width / 2
  if (left - area.x <= SNAP) out.side = 'left'
  else if (area.x + area.width - (left + width) <= SNAP) out.side = 'right'
  if (at.y - area.y <= SNAP) out.edge = 'top'
  else if (area.y + area.height - (at.y + row) <= SNAP) out.edge = 'bottom'
  return out
}

/**
 * Sizes the recording bar's window for how it's showing: the full bar, the
 * logo it shrinks to, and the notes drawer. The window is only ever as big as
 * what's drawn, so it never blocks clicks to what's under it. A minimized bar
 * opens while the pointer rests on it and shrinks back once it leaves, unless
 * the drawer is out.
 *
 * Dragging is done here too, not by Windows: a window dragged by Windows
 * (a drag region) can move as an outline only, and goes where it's dropped
 * as it was sized when the drag began, so a bar that shrank or opened in
 * between landed somewhere else. Here the bar follows the pointer, at
 * whatever size it is, and snaps to screen edges as it goes.
 */
export class BarLayout {
  private view: BarView
  private at: Anchor
  private placed: Rectangle | null = null
  private watch: NodeJS.Timeout | null = null
  private over = 0 // checks in a row with the pointer on the bar; negative while away
  /** Just dropped with the pointer on it: a minimized bar doesn't open until the pointer has left. */
  private rest = false
  private drag: { dx: number; dy: number; timer: NodeJS.Timeout; until: number } | null = null

  constructor(
    private readonly win: BrowserWindow,
    minimized: boolean,
    at: Anchor | null,
    private readonly onChange: (view: BarView) => void,
    /** The user dropped the bar somewhere: remembered for the next one. */
    private readonly onPlaced: (at: Anchor) => void = () => undefined
  ) {
    const area = screen.getPrimaryDisplay().workArea
    this.at = at ?? { x: Math.round(area.x + area.width / 2), y: area.y + 12 }
    this.view = { minimized, expanded: false, notes: false, up: false }
    win.on('closed', () => {
      this.unwatch()
      this.stopDrag()
    })
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

  /** The pointer went down at `press` (in the window) and has started to move: the bar follows it until dropDrag. */
  startDrag(press: { x: number; y: number }): void {
    if (this.drag || this.win.isDestroyed()) return
    const b = this.win.getBounds()
    // Held by the same point of the bar all the way, wherever the edges snap it.
    const from = anchorOf(b, this.view.up)
    this.drag = {
      dx: Math.round(b.x + press.x - from.x),
      dy: Math.round(b.y + press.y - from.y),
      timer: setInterval(() => this.follow(), DRAG_MS),
      until: Date.now() + DRAG_MAX_MS
    }
  }

  dropDrag(): void {
    if (!this.drag) return
    this.follow()
    this.stopDrag()
    this.rest = true
    this.onPlaced(this.at)
  }

  private follow(): void {
    if (!this.drag || this.win.isDestroyed()) return
    if (Date.now() > this.drag.until) return this.dropDrag()
    const p = screen.getCursorScreenPoint()
    const raw = { x: p.x - this.drag.dx, y: p.y - this.drag.dy }
    this.at = snapped(raw, this.view, screen.getDisplayNearestPoint(raw).workArea)
    this.apply(false)
  }

  private stopDrag(): void {
    if (this.drag) clearInterval(this.drag.timer)
    this.drag = null
  }

  private apply(notify: boolean): void {
    if (this.win.isDestroyed()) return
    const area = screen.getDisplayNearestPoint(this.at).workArea
    const { bounds, up } = barBounds(this.at, this.view, area)
    this.view = { ...this.view, up }
    const same = this.placed && bounds.x === this.placed.x && bounds.y === this.placed.y && bounds.width === this.placed.width && bounds.height === this.placed.height
    this.placed = bounds
    if (!same) this.win.setBounds(bounds)
    if (this.view.minimized) this.startWatching()
    else this.unwatch()
    if (notify) this.onChange(this.view)
  }

  private startWatching(): void {
    if (this.watch) return
    this.over = 0
    this.watch = setInterval(() => {
      if (this.win.isDestroyed() || !this.win.isVisible() || this.drag) return
      const p = screen.getCursorScreenPoint()
      const b = this.win.getBounds()
      const on = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      if (!on) this.rest = false
      this.over = on ? Math.max(1, this.over + 1) : Math.min(-1, this.over - 1)
      if (!this.view.expanded && !this.rest && this.over >= OPEN_TICKS) this.set({ expanded: true })
      else if (this.view.expanded && !this.view.notes && this.over <= -CLOSE_TICKS) this.set({ expanded: false })
    }, TICK_MS)
  }

  private unwatch(): void {
    if (this.watch) clearInterval(this.watch)
    this.watch = null
  }
}
