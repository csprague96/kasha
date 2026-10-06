import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { log } from './log'

const { autoUpdater } = electronUpdater

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 3600_000

/**
 * Keeps installed copies up to date from the GitHub releases of csprague96/kasha
 * (see package.json > build.publish; the Release workflow publishes one for
 * every version bump that lands on main). Updates download in the background
 * and install when the user chooses Restart, or on the next quit. Kasha never
 * restarts on its own, and never while it's recording.
 */
export class Updater {
  private status: UpdateStatus = { state: 'idle', version: null, message: null }
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly onStatus: (s: UpdateStatus) => void,
    private readonly busy: () => boolean
  ) {}

  current(): UpdateStatus {
    return this.status
  }

  private set(s: UpdateStatus): void {
    this.status = s
    this.onStatus(s)
  }

  start(): void {
    if (!app.isPackaged) {
      // Dev-only: KASHA_FAKE_UPDATE="downloading 0.3.0" (or ready) shows that state, for checking the UI.
      const [state, version] = (process.env.KASHA_FAKE_UPDATE ?? '').split(' ')
      if ((state === 'downloading' || state === 'ready') && version) {
        this.set({ state, version, message: null, ...(state === 'downloading' ? { percent: 42 } : {}) })
      } else {
        this.set({ state: 'dev', version: null, message: 'Updates are off when running from source.' })
      }
      return
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', version: null, message: null }))
    autoUpdater.on('update-available', (info) => {
      log('update-available', { version: info.version })
      this.set({ state: 'downloading', version: info.version, message: null, percent: 0 })
    })
    autoUpdater.on('update-not-available', () => this.set({ state: 'idle', version: null, message: 'Kasha is up to date.' }))
    autoUpdater.on('download-progress', (p) =>
      this.set({ state: 'downloading', version: this.status.version, message: null, percent: Math.floor(p.percent) })
    )
    autoUpdater.on('update-downloaded', (e) => {
      log('update-downloaded', { version: e.version })
      this.set({ state: 'ready', version: e.version, message: null })
    })
    autoUpdater.on('error', (err) => {
      const text = String(err?.message ?? err)
      // Before the first release is published there is nothing to update to.
      if (/no published versions|unable to find latest version|404/i.test(text)) {
        this.set({ state: 'idle', version: null, message: 'Kasha is up to date.' })
        return
      }
      log('update-failed', { error: text.slice(0, 200) })
      if (this.status.state === 'ready') return
      this.set({ state: 'error', version: null, message: 'Kasha couldn’t check for updates. It will try again later.' })
    })
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.status
    if (this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    await autoUpdater.checkForUpdates().catch(() => undefined)
    return this.status
  }

  /** Installs the downloaded update and restarts. Refused while a call is being recorded or processed. */
  restart(): boolean {
    if (this.status.state !== 'ready') return false
    if (this.busy()) {
      this.set({ ...this.status, message: 'Kasha will update once the current recording has been processed.' })
      return false
    }
    log('update-install', { version: this.status.version })
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
