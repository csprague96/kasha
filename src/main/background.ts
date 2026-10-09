import { freemem } from 'node:os'
import type { BackgroundState } from '@shared/types'
import { BATCH_THREADS, LIVE_THREADS } from './speech'

/** While a call is recorded, an earlier meeting is finished with this many threads: about half what the call's live transcript gets. */
export const BACKGROUND_THREADS = Math.max(1, Math.floor(LIVE_THREADS / 2))

// The same lines as live transcription (live.ts): below LOW free memory work
// waits, above HIGH it carries on, so it doesn't flap.
const LOW_MEMORY = 1024 ** 3
const HIGH_MEMORY = 1.4 * 1024 ** 3
const CHECK_MS = 10_000

/**
 * Finishing a meeting after its call (the rest of the transcript, telling
 * speakers apart, the summary) while the next call is being recorded. That
 * work yields to the call: the call's live transcript goes first, the
 * backlog runs on fewer threads at the lowest priority, and it waits while
 * memory is low. The user can pause it outright; a pause lasts until they
 * resume or the recording ends, so it can't be forgotten for good.
 */
class Background {
  private inCall = false
  private userPaused = false
  private lowMemory = false
  /** "Carry on anyway" while memory was low: memory isn't watched again until the recording ends. */
  private ignoreMemory = false
  private watchMemory: () => boolean = () => false
  private waiters: Array<() => void> = []
  private listeners: Array<(s: BackgroundState) => void> = []
  private timer: NodeJS.Timeout | null = null
  /** Free memory when the memory wait last started or ended, for the log. */
  freeMB = 0

  /** Whether to watch memory at all (Settings' "pause when memory is low"). */
  setMemoryWatch(fn: () => boolean): void {
    this.watchMemory = fn
  }

  /** A recording started or ended. The end lifts any pause: the call that needed the room is over. */
  setInCall(on: boolean): void {
    if (this.inCall === on) return
    this.inCall = on
    if (!on) {
      this.userPaused = false
      this.ignoreMemory = false
      this.lowMemory = false
    }
    this.checkMemory()
    this.changed()
  }

  /** Resuming while it waits for memory means "carry on anyway". */
  setPaused(paused: boolean): void {
    const override = !paused && this.lowMemory
    if (this.userPaused === paused && !override) return
    this.userPaused = paused
    if (override) {
      this.ignoreMemory = true
      this.lowMemory = false
    }
    this.changed()
  }

  state(): BackgroundState {
    return { paused: this.userPaused ? 'user' : this.lowMemory ? 'memory' : null, inCall: this.inCall }
  }

  paused(): boolean {
    return this.userPaused || this.lowMemory
  }

  /** Threads for background speech work right now. */
  threads(): number {
    return this.inCall ? BACKGROUND_THREADS : BATCH_THREADS
  }

  /** Background processes start at the lowest priority during a call, so they yield to it and to its live transcript. */
  lowest(): boolean {
    return this.inCall
  }

  /** Resolves once background work may run. */
  wait(): Promise<void> {
    this.checkMemory()
    if (!this.paused()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Called with every change (paused, resumed, a call started or ended). */
  onChange(fn: (s: BackgroundState) => void): () => void {
    this.listeners.push(fn)
    return () => (this.listeners = this.listeners.filter((l) => l !== fn))
  }

  private checkMemory(): void {
    const watch = this.inCall && this.watchMemory() && !this.ignoreMemory
    const free = watch ? freemem() : Infinity
    const low = watch && (this.lowMemory ? free < HIGH_MEMORY : free < LOW_MEMORY)
    // Memory is only looked at again while a call is on.
    if (this.inCall && !this.timer) this.timer = setInterval(() => this.checkMemory(), CHECK_MS)
    if (!this.inCall && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (low === this.lowMemory) return
    this.lowMemory = low
    this.freeMB = Math.round(freemem() / 1024 ** 2)
    this.changed()
  }

  private changed(): void {
    const s = this.state()
    for (const l of this.listeners) l(s)
    if (this.paused()) return
    const ready = this.waiters
    this.waiters = []
    for (const r of ready) r()
  }
}

export const background = new Background()
