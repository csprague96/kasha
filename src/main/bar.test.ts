import { EventEmitter } from 'node:events'
import type { BrowserWindow, Rectangle } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const area = { x: 0, y: 0, width: 1920, height: 1040 }
const pointer = { x: 0, y: 0 }
vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: () => ({ workArea: area }),
    getDisplayNearestPoint: () => ({ workArea: area }),
    getCursorScreenPoint: () => ({ ...pointer })
  }
}))
const { anchorOf, BAR_HEIGHT, BAR_WIDTH, barBounds, BarLayout, EDGE_GAP, LOGO_SIZE, NOTES_HEIGHT, placeFrom, snapped } = await import('./bar')
const full = { minimized: false, expanded: false, notes: false }

describe('barBounds', () => {
  it('centres the bar on its spot, and the logo on the same spot', () => {
    const at = { x: 960, y: 12 }
    expect(barBounds(at, full, area).bounds).toEqual({ x: 660, y: 12, width: BAR_WIDTH, height: BAR_HEIGHT })
    expect(barBounds(at, { ...full, minimized: true }, area).bounds).toEqual({ x: 936, y: 12, width: LOGO_SIZE, height: LOGO_SIZE })
  })

  it('opens a logo by the screen edge onto the screen, and shrinks back to where it was', () => {
    const at = { x: 1890, y: 500 }
    const open = barBounds(at, { minimized: true, expanded: true, notes: false }, area).bounds
    expect(open.x + open.width).toBe(1920)
    expect(barBounds(at, { minimized: true, expanded: false, notes: false }, area).bounds.x).toBe(1866)
  })

  it('drops the drawer below the bar, or above it when the bar is near the bottom', () => {
    const top = barBounds({ x: 960, y: 12 }, { ...full, notes: true }, area)
    expect(top.up).toBe(false)
    expect(top.bounds).toMatchObject({ y: 12, height: BAR_HEIGHT + NOTES_HEIGHT })

    const low = barBounds({ x: 960, y: 900 }, { ...full, notes: true }, area)
    expect(low.up).toBe(true)
    expect(low.bounds.y).toBe(900 - NOTES_HEIGHT) // the bar itself doesn't move
    expect(anchorOf(low.bounds, true)).toEqual({ x: 960, y: 900 })
  })

  it('keeps a bar left off-screen (a monitor unplugged) on the screen', () => {
    const b = barBounds({ x: 4000, y: 2000 }, full, area).bounds
    expect(b).toEqual({ x: 1920 - BAR_WIDTH, y: 1040 - BAR_HEIGHT, width: BAR_WIDTH, height: BAR_HEIGHT })
  })

  it('holds a bar snapped to the right flush with it, as the logo and opened up', () => {
    const at = { x: 1700, y: 400, side: 'right' as const }
    const logo = barBounds(at, { ...full, minimized: true }, area).bounds
    const open = barBounds(at, { minimized: true, expanded: true, notes: false }, area).bounds
    expect(logo.x + logo.width).toBe(1920 - EDGE_GAP)
    expect(open.x + open.width).toBe(1920 - EDGE_GAP)
    expect(open.y).toBe(400)
  })

  it('holds a bar snapped to the bottom on it, with the drawer above', () => {
    const r = barBounds({ x: 960, y: 0, edge: 'bottom' }, { ...full, notes: true }, area)
    expect(r.up).toBe(true)
    expect(r.bounds.y + NOTES_HEIGHT + BAR_HEIGHT).toBe(1040 - EDGE_GAP)
  })
})

describe('snapped', () => {
  it('snaps to an edge the bar is dragged near or past, and not otherwise', () => {
    expect(snapped({ x: 960, y: 300 }, full, area)).toEqual({ x: 960, y: 300 })
    expect(snapped({ x: 1920 - BAR_WIDTH / 2 - 20, y: 300 }, full, area)).toMatchObject({ side: 'right' })
    expect(snapped({ x: BAR_WIDTH / 2 - 50, y: 300 }, full, area)).toMatchObject({ side: 'left' })
    expect(snapped({ x: 960, y: 10 }, full, area)).toMatchObject({ edge: 'top' })
    expect(snapped({ x: 960, y: 1040 - BAR_HEIGHT - 10 }, full, area)).toMatchObject({ edge: 'bottom' })
  })

  it('measures the logo by its own size', () => {
    const logo = { ...full, minimized: true }
    expect(snapped({ x: 1920 - 40, y: 300 }, logo, area).side).toBe('right')
    expect(snapped({ x: 1920 - 40, y: 300 }, full, area).side).toBe('right') // the full bar is past the edge
    expect(snapped({ x: 1920 - 100, y: 300 }, logo, area).side).toBeUndefined()
  })
})

describe('placeFrom', () => {
  it('reads back a saved place and nothing else', () => {
    expect(placeFrom({ x: 10.4, y: 20, side: 'right', edge: 'sideways' })).toEqual({ x: 10, y: 20, side: 'right' })
    expect(placeFrom({ x: '10', y: 20 })).toBeNull()
    expect(placeFrom(null)).toBeNull()
  })
})

class FakeWindow extends EventEmitter {
  bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 }
  isDestroyed = () => false
  isVisible = () => true
  getBounds = () => ({ ...this.bounds })
  setBounds = (b: Rectangle) => void (this.bounds = { ...b })
}

describe('BarLayout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.assign(pointer, { x: 0, y: 500 })
  })
  afterEach(() => vi.useRealTimers())

  const minimized = (onPlaced = (_at: unknown) => undefined) => {
    const win = new FakeWindow()
    const layout = new BarLayout(win as unknown as BrowserWindow, true, null, () => undefined, onPlaced)
    return { win, layout }
  }

  it('opens while the pointer rests on the logo, and shrinks back to it once the pointer leaves', () => {
    const { win } = minimized()
    expect(win.bounds).toEqual({ x: 936, y: 12, width: LOGO_SIZE, height: LOGO_SIZE })
    Object.assign(pointer, { x: 950, y: 30 })
    vi.advanceTimersByTime(100)
    expect(win.bounds.width).toBe(LOGO_SIZE) // just passing over
    vi.advanceTimersByTime(100)
    expect(win.bounds).toEqual({ x: 660, y: 12, width: BAR_WIDTH, height: BAR_HEIGHT })
    Object.assign(pointer, { x: 600, y: 500 })
    vi.advanceTimersByTime(700)
    expect(win.bounds.width).toBe(BAR_WIDTH)
    vi.advanceTimersByTime(200)
    expect(win.bounds).toEqual({ x: 936, y: 12, width: LOGO_SIZE, height: LOGO_SIZE })
  })

  it('stays open while the notes drawer is out', () => {
    const { win, layout } = minimized()
    layout.set({ expanded: true })
    layout.set({ notes: true })
    vi.advanceTimersByTime(5000)
    expect(win.bounds.height).toBe(BAR_HEIGHT + NOTES_HEIGHT)
    layout.set({ notes: false })
    vi.advanceTimersByTime(1000)
    expect(win.bounds.width).toBe(LOGO_SIZE)
  })

  it('opened by a click, gives the pointer a moment before shrinking back', () => {
    const { win, layout } = minimized()
    vi.advanceTimersByTime(3000) // the pointer has been away a while
    layout.set({ expanded: true })
    vi.advanceTimersByTime(300)
    expect(win.bounds.width).toBe(BAR_WIDTH)
  })

  it('follows the pointer while dragged, by the point it was picked up at, and remembers where it was dropped', () => {
    const placed: unknown[] = []
    const { win, layout } = minimized((at) => void placed.push(at))
    layout.set({ expanded: true })
    Object.assign(pointer, { x: 700, y: 30 }) // on the bar, 40 px in from its left end
    layout.startDrag({ x: 40, y: 18 })
    Object.assign(pointer, { x: 400, y: 330 })
    vi.advanceTimersByTime(16)
    expect(win.bounds).toMatchObject({ x: 360, y: 312, width: BAR_WIDTH })
    Object.assign(pointer, { x: 140, y: 288 })
    vi.advanceTimersByTime(16)
    layout.dropDrag()
    expect(win.bounds).toMatchObject({ x: 100, y: 270 })
    expect(placed).toEqual([{ x: 100 + BAR_WIDTH / 2, y: 270 }])
    layout.set({ expanded: false })
    expect(win.bounds).toEqual({ x: 100 + BAR_WIDTH / 2 - LOGO_SIZE / 2, y: 270, width: LOGO_SIZE, height: LOGO_SIZE })
  })

  it('stays the same size while dragged, though the pointer is away from where the bar was', () => {
    const { win, layout } = minimized()
    layout.set({ expanded: true })
    Object.assign(pointer, { x: 700, y: 30 })
    layout.startDrag({ x: 40, y: 18 })
    Object.assign(pointer, { x: 1200, y: 600 })
    vi.advanceTimersByTime(3000)
    expect(win.bounds.width).toBe(BAR_WIDTH)
    layout.dropDrag()
    expect(win.bounds).toMatchObject({ x: 1160, y: 582 })
  })

  it('snaps to the right edge as it is dragged there, and stays there as the logo', () => {
    const { win, layout } = minimized()
    Object.assign(pointer, { x: 960, y: 36 }) // the middle of the logo
    layout.startDrag({ x: 24, y: 24 })
    Object.assign(pointer, { x: 1900, y: 500 })
    vi.advanceTimersByTime(16)
    layout.dropDrag()
    expect(win.bounds).toEqual({ x: 1920 - EDGE_GAP - LOGO_SIZE, y: 476, width: LOGO_SIZE, height: LOGO_SIZE })
    expect(layout.anchor().side).toBe('right')
  })

  it('a logo just dropped stays small until the pointer has left it', () => {
    const { win, layout } = minimized()
    Object.assign(pointer, { x: 960, y: 36 })
    layout.startDrag({ x: 24, y: 24 })
    Object.assign(pointer, { x: 500, y: 536 })
    vi.advanceTimersByTime(16)
    layout.dropDrag()
    vi.advanceTimersByTime(1000)
    expect(win.bounds.width).toBe(LOGO_SIZE)
    Object.assign(pointer, { x: 100, y: 100 })
    vi.advanceTimersByTime(200)
    Object.assign(pointer, { x: 500, y: 536 })
    vi.advanceTimersByTime(300)
    expect(win.bounds.width).toBe(BAR_WIDTH)
  })
})
