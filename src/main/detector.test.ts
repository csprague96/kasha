import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingDetector } from './detector'

const ALL = { teams: true, slack: true, zoom: true, ringcentral: true, browser: true }

/** A detector fed a fake mic, polled by hand every 3 s. */
function detector(stillInCall: () => Promise<boolean | null> = async () => null) {
  let held = false
  const d = new MeetingDetector(
    () => ALL,
    stillInCall,
    async () => new Set(held ? (['teams'] as const) : []),
    async () => 'Weekly sync'
  )
  const events: string[] = []
  d.on('start', () => events.push('start'))
  d.on('end', (_app: string, how: string) => events.push(`end ${how}`))
  const poll = async (mic: boolean, times = 1) => {
    for (let i = 0; i < times; i++) {
      vi.advanceTimersByTime(3000)
      held = mic
      await (d as unknown as { poll(): Promise<void> }).poll()
    }
  }
  return { d, events, poll }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('when a Teams call ends', () => {
  it('ends a few seconds after leaving, when the window closes and the mic goes quiet', async () => {
    const { d, events, poll } = detector()
    await poll(true, 2)
    d.callWindow('teams', true)
    await poll(true, 10)
    d.callWindow('teams', false) // Leave
    await poll(false)
    expect(events).toEqual(['start'])
    await poll(false)
    expect(events).toEqual(['start', 'end window']) // ~6 s after leaving, not ~21 s
  })

  it('keeps recording while Teams lets go of the mic with the call still open', async () => {
    const stillInCall = vi.fn(async () => true)
    const { d, events, poll } = detector(stillInCall)
    await poll(true, 2)
    d.callWindow('teams', true)
    await poll(false, 40) // two minutes muted
    expect(events).toEqual(['start'])
    // A second opinion every ~20 s, in case the reader's last word is stale.
    expect(stillInCall).toHaveBeenCalledTimes(5)
  })

  it('ends when the window closes even though Teams keeps the mic, then detects the next call', async () => {
    const { d, events, poll } = detector()
    await poll(true, 2)
    d.callWindow('teams', true)
    await poll(true, 10)
    d.callWindow('teams', false)
    await poll(true, 4)
    expect(events).toEqual(['start'])
    await poll(true)
    expect(events).toEqual(['start', 'end window']) // 15 s after the window closed
    await poll(true, 2)
    expect(events).toEqual(['start', 'end window', 'start'])
  })

  it("doesn't end on a window that closes for a moment", async () => {
    const { d, events, poll } = detector()
    await poll(true, 2)
    d.callWindow('teams', true)
    await poll(true)
    d.callWindow('teams', false)
    vi.advanceTimersByTime(1000)
    d.callWindow('teams', true)
    await poll(false, 6)
    expect(events).toEqual(['start'])
  })

  it('falls back to ~20 s of quiet mic when the call window was never seen', async () => {
    const { d, events, poll } = detector()
    await poll(true, 2)
    d.callWindow('teams', false) // still on the pre-join screen
    await poll(false, 6)
    expect(events).toEqual(['start'])
    await poll(false)
    expect(events).toEqual(['start', 'end mic'])
  })

  it('falls back to the mic when the reader stops', async () => {
    const { d, events, poll } = detector()
    await poll(true, 2)
    d.callWindow('teams', true)
    d.callWindow('teams', null)
    await poll(false, 6)
    expect(events).toEqual(['start'])
    await poll(false)
    expect(events).toEqual(['start', 'end mic'])
  })

  it('takes the fresh check over a reader that still says the window is open', async () => {
    const { d, events, poll } = detector(async () => false)
    await poll(true, 2)
    d.callWindow('teams', true)
    await poll(false, 7)
    expect(events).toEqual(['start', 'end mic'])
  })
})
