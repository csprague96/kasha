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
const { anchorOf, BAR_HEIGHT, BAR_WIDTH, barBounds, BarLayout, LOGO_SIZE, NOTES_HEIGHT } = await import('./bar')
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

  const minimized = () => {
    const win = new FakeWindow()
    const layout = new BarLayout(win as unknown as BrowserWindow, true, null, () => undefined)
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

  it('shrinks to wherever the user dragged the bar', () => {
    const { win, layout } = minimized()
    layout.set({ expanded: true })
    win.bounds = { ...win.bounds, x: 100, y: 300 }
    win.emit('moved')
    layout.set({ expanded: false })
    expect(win.bounds).toEqual({ x: 100 + BAR_WIDTH / 2 - LOGO_SIZE / 2, y: 300, width: LOGO_SIZE, height: LOGO_SIZE })
  })
})
