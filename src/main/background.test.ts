import { beforeEach, describe, expect, it, vi } from 'vitest'

const free = vi.fn(() => 8 * 1024 ** 3)
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  return { ...real, freemem: () => free() }
})
vi.mock('./log', () => ({ log: () => undefined }))
const { exclusive } = await import('./speech')

// A fresh controller per test: it's a module-level singleton.
async function fresh() {
  vi.resetModules()
  return (await import('./background')).background
}

const settled = async (p: Promise<unknown>) => {
  let done = false
  void p.then(() => (done = true))
  await new Promise((r) => setTimeout(r, 0))
  return done
}

beforeEach(() => free.mockReturnValue(8 * 1024 ** 3))

describe('speech queue', () => {
  it('runs the call being recorded before an earlier meeting waiting its turn', async () => {
    const order: string[] = []
    let release!: () => void
    const first = exclusive(() => new Promise<void>((r) => (release = r)), true)
    const queued = [
      exclusive(async () => void order.push('backlog 1'), true),
      exclusive(async () => void order.push('backlog 2'), true),
      exclusive(async () => void order.push('live'))
    ]
    await new Promise((r) => setTimeout(r, 0)) // the first job has started
    release()
    await Promise.all([first, ...queued])
    expect(order).toEqual(['live', 'backlog 1', 'backlog 2'])
  })

  it('runs one process at a time, and carries on after one fails', async () => {
    let running = 0
    let most = 0
    const job = (fail = false, background = false) =>
      exclusive(async () => {
        most = Math.max(most, ++running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        if (fail) throw new Error('x')
      }, background)
    const results = await Promise.allSettled([job(), job(true), job(), job(false, true)])
    expect(most).toBe(1)
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
  })
})

describe('background work', () => {
  it('waits while paused and goes on when resumed', async () => {
    const bg = await fresh()
    bg.setPaused(true)
    const w = bg.wait()
    expect(await settled(w)).toBe(false)
    bg.setPaused(false)
    expect(await settled(w)).toBe(true)
  })

  it('uses fewer threads and the lowest priority only during a call', async () => {
    const bg = await fresh()
    const { BATCH_THREADS } = await import('./speech')
    expect(bg.threads()).toBe(BATCH_THREADS)
    expect(bg.lowest()).toBe(false)
    bg.setInCall(true)
    expect(bg.threads()).toBeLessThan(BATCH_THREADS)
    expect(bg.lowest()).toBe(true)
    bg.setInCall(false)
  })

  it('lifts a pause when the recording ends', async () => {
    const bg = await fresh()
    bg.setInCall(true)
    bg.setPaused(true)
    const w = bg.wait()
    bg.setInCall(false)
    expect(await settled(w)).toBe(true)
    expect(bg.state()).toEqual({ paused: null, inCall: false })
  })

  it('waits for memory during a call only, and "carry on" overrides it', async () => {
    const bg = await fresh()
    bg.setMemoryWatch(() => true)
    free.mockReturnValue(0.5 * 1024 ** 3)
    expect(await settled(bg.wait())).toBe(true) // no call: memory isn't watched
    bg.setInCall(true)
    expect(bg.state().paused).toBe('memory')
    const w = bg.wait()
    expect(await settled(w)).toBe(false)
    bg.setPaused(false)
    expect(await settled(w)).toBe(true)
    expect(await settled(bg.wait())).toBe(true)
    bg.setInCall(false)
  })

  it("doesn't watch memory when the setting is off", async () => {
    const bg = await fresh()
    bg.setMemoryWatch(() => false)
    free.mockReturnValue(0.1 * 1024 ** 3)
    bg.setInCall(true)
    expect(await settled(bg.wait())).toBe(true)
    bg.setInCall(false)
  })

  it('tells listeners about each change', async () => {
    const bg = await fresh()
    const seen: Array<string | null> = []
    const off = bg.onChange((s) => seen.push(s.paused))
    bg.setPaused(true)
    bg.setPaused(true)
    bg.setPaused(false)
    off()
    bg.setPaused(true)
    expect(seen).toEqual(['user', null])
  })
})
