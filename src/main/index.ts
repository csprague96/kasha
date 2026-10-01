import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  protocol,
  session,
  shell,
  Tray,
  type WebContents
} from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DetectedMeeting, Meeting, RecordingInfo, Settings, ShareOptions } from '@shared/types'
import { listActions, ReminderScheduler, setActionDone } from './actions'
import { MeetingDetector } from './detector'
import { syncToObsidian } from './obsidian'
import { enqueue, type PipelineEvents } from './pipeline'
import { Recording, type Track } from './recorder'
import { takeScreenshot } from './screenshot'
import { copyToClipboard, emailDraft, saveMarkdown, savePdf } from './share'
import { downloadWhisper, setupStatus } from './setup'
import * as store from './store'
import { createBarWindow, createMainWindow, createToastWindow } from './windows'

// Dev and testing: keep data in a separate folder so real notes aren't touched.
if (process.env.KASHA_DATA_DIR) app.setPath('userData', process.env.KASHA_DATA_DIR)

// The UI is simple enough to render on the CPU. Skipping the GPU process saves ~50-100 MB.
app.disableHardwareAcceleration()
app.setAppUserModelId('com.sola.kasha')

if (!app.requestSingleInstanceLock()) app.quit()

protocol.registerSchemesAsPrivileged([
  { scheme: 'kasha-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// ---------- State ----------

let mainWin: BrowserWindow | null = null
let toastWin: BrowserWindow | null = null
let barWin: BrowserWindow | null = null
let tray: Tray | null = null

let detected: DetectedMeeting | null = null
const dismissed = new Set<string>() // apps the user said "Not now" to, until that call ends

interface ActiveRecording extends RecordingInfo {
  app: Meeting['app']
  rec: Recording
  stopping: boolean
}
let recording: ActiveRecording | null = null

const detector = new MeetingDetector(() => store.getSettings().detect)

const reminders = new ReminderScheduler(
  () => store.getSettings(),
  (lastShown) => store.setSettings({ reminders: { ...store.getSettings().reminders, lastShown } }),
  (text) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: 'Open actions', body: text, silent: true })
    n.on('click', () => showMain({ actions: true }))
    n.show()
  }
)

// ---------- Helpers ----------

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

function recordingInfo(): RecordingInfo | null {
  return recording ? { meetingId: recording.meetingId, title: recording.title, startedAt: recording.startedAt } : null
}

function elapsedLabel(): string {
  const s = recording ? Math.floor((Date.now() - recording.startedAt) / 1000) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`
}

type NavView = { meetingId?: string; settings?: boolean; actions?: boolean }

function showMain(view?: NavView): void {
  if (!mainWin || mainWin.isDestroyed()) {
    const hash = view?.settings ? '#settings' : view?.actions ? '#actions' : view?.meetingId ? `#meeting=${view.meetingId}` : ''
    mainWin = createMainWindow(hash)
    mainWin.on('closed', () => (mainWin = null))
    return
  }
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
  if (view) mainWin.webContents.send('navigate', view)
}

function isOwnWindow(wc: WebContents | null): boolean {
  return !!wc && BrowserWindow.getAllWindows().some((w) => w.webContents.id === wc.id)
}

function appendToNote(id: string, fragment: string): void {
  const cur = store.readNote(id).replace(/\s+$/, '')
  store.writeNote(id, cur ? `${cur}\n\n${fragment}\n` : `${fragment}\n`)
  broadcast('note-appended', id, fragment)
}

// ---------- Tray ----------

function trayIcon(): Electron.NativeImage {
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  const name = `tray-${recording ? 'rec' : 'idle'}-${dark ? 'dark' : 'light'}.png`
  return nativeImage.createFromPath(join(__dirname, '../../resources', name))
}

function refreshTray(): void {
  if (!tray) return
  tray.setImage(trayIcon())
  tray.setToolTip(recording ? `Kasha: recording ${recording.title}` : 'Kasha')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Kasha', click: () => showMain() },
      recording
        ? { label: 'Stop recording', click: () => stopRecording() }
        : { label: 'Start recording', click: () => void startRecording() },
      { label: 'Actions', click: () => showMain({ actions: true }) },
      { label: 'Settings', click: () => showMain({ settings: true }) },
      { type: 'separator' },
      { label: 'Quit Kasha', click: () => app.quit() }
    ])
  )
}

// ---------- Recording ----------

async function startRecording(meetingId?: string, from?: DetectedMeeting): Promise<void> {
  if (recording) return
  let meeting = meetingId ? store.getMeeting(meetingId) : null
  if (!meeting) meeting = store.createMeeting({ title: from?.title ?? 'New note', app: from?.app ?? 'manual' })
  const startedAt = Date.now()
  meeting = store.updateMeeting(meeting.id, {
    status: 'recording',
    recordingStartedAt: new Date(startedAt).toISOString(),
    error: undefined
  })
  recording = {
    meetingId: meeting.id,
    title: meeting.title,
    startedAt,
    app: meeting.app,
    rec: new Recording(store.paths.meeting(meeting.id)),
    stopping: false
  }
  closeToast()
  barWin = createBarWindow()
  barWin.on('closed', () => (barWin = null))
  refreshTray()
  broadcast('recording-changed', recordingInfo())
  broadcast('meetings-changed')
}

/** Asks the bar to flush its last audio, then finalizes. Falls back after 3s. */
function stopRecording(): void {
  if (!recording || recording.stopping) return
  recording.stopping = true
  const current = recording
  if (barWin && !barWin.isDestroyed()) barWin.webContents.send('bar-stop')
  setTimeout(() => recording === current && finalizeRecording(), 3000)
}

const pipelineEvents: PipelineEvents = {
  changed: () => {
    broadcast('meetings-changed')
    broadcast('actions-changed')
  },
  progress: (id, p) => broadcast('progress', id, p),
  done: (m) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: 'Notes ready', body: m.title, silent: true })
    n.on('click', () => showMain({ meetingId: m.id }))
    n.show()
  }
}

function finalizeRecording(): void {
  if (!recording) return
  const { meetingId, rec } = recording
  recording = null
  const tracks = rec.close()
  store.updateMeeting(meetingId, {
    recordingEndedAt: new Date().toISOString(),
    status: tracks.length ? 'transcribing' : 'ready',
    error: tracks.length ? undefined : 'No audio was captured.'
  })
  if (barWin && !barWin.isDestroyed()) barWin.destroy()
  barWin = null
  refreshTray()
  broadcast('recording-changed', null)
  broadcast('meetings-changed')
  if (tracks.length) enqueue(meetingId, pipelineEvents)
}

// ---------- Meeting detection ----------

function closeToast(): void {
  if (toastWin && !toastWin.isDestroyed()) toastWin.destroy()
  toastWin = null
  detected = null
}

detector.on('start', (m: DetectedMeeting) => {
  if (recording || dismissed.has(m.app) || !store.getSettings().setupComplete) return
  detected = m
  if (toastWin && !toastWin.isDestroyed()) toastWin.destroy()
  toastWin = createToastWindow()
  toastWin.on('closed', () => (toastWin = null))
  setTimeout(() => {
    if (detected === m) closeToast()
  }, 90_000)
})

detector.on('end', (appName: string) => {
  dismissed.delete(appName)
  if (detected?.app === appName) closeToast()
  // The call ended: stop the recording it started.
  if (recording && recording.app === appName) stopRecording()
})

// ---------- IPC ----------

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isOwnWindow(e.sender)) throw new Error('Unknown sender')
    return fn(...args)
  })
}

function registerIpc(): void {
  handle('meetings:list', () => store.listMeetings())
  handle('meetings:get', (id: string) => {
    const meeting = store.getMeeting(id)
    return meeting ? { meeting, note: store.readNote(id), transcript: store.readTranscript(id) } : null
  })
  handle('meetings:create', () => {
    const m = store.createMeeting({ title: 'New note', app: 'manual' })
    broadcast('meetings-changed')
    return m
  })
  handle('meetings:update', (id: string, patch: Partial<Pick<Meeting, 'title' | 'tags'>>) => {
    const clean: Partial<Meeting> = {}
    if (typeof patch.title === 'string') clean.title = patch.title.trim().slice(0, 200) || 'Untitled'
    if (Array.isArray(patch.tags)) clean.tags = patch.tags.map(String).slice(0, 20)
    const m = store.updateMeeting(id, clean)
    if (recording?.meetingId === id && clean.title) {
      recording.title = clean.title
      broadcast('recording-changed', recordingInfo())
    }
    broadcast('meetings-changed')
    return m
  })
  handle('meetings:saveNote', (id: string, md: string) => {
    store.writeNote(id, String(md))
    broadcast('actions-changed')
  })
  handle('meetings:saveImage', (id: string, data: ArrayBuffer, ext: string) => {
    const safeExt = /^(png|jpe?g|gif|webp)$/i.test(ext) ? ext.toLowerCase() : 'png'
    const name = `image-${Date.now()}.${safeExt}`
    writeFileSync(join(store.paths.meeting(id), 'attachments', name), Buffer.from(data))
    return `attachments/${name}`
  })
  handle('meetings:delete', (id: string) => {
    if (recording?.meetingId === id) return
    store.deleteMeeting(id)
    broadcast('meetings-changed')
  })
  handle('meetings:retry', (id: string) => enqueue(id, pipelineEvents))
  handle('meetings:sync', (id: string) => {
    const m = store.getMeeting(id)
    if (!m) return
    const sync = syncToObsidian(m, store.readNote(id), store.readTranscript(id), store.getSettings().obsidian, true)
    store.updateMeeting(id, { sync })
    broadcast('meetings-changed')
  })
  handle('meetings:reveal', (id: string) => {
    const m = store.getMeeting(id)
    const vault = store.getSettings().obsidian.vault
    if (!m?.sync.path || !vault) return
    const rel = m.sync.path.slice(vault.length + 1).replace(/\\/g, '/')
    const vaultName = vault.split(/[\\/]/).pop() ?? ''
    void shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(rel)}`)
  })

  handle('actions:list', () => listActions())
  handle('actions:setDone', (id: string, index: number, raw: string, done: boolean) => {
    setActionDone(id, Number(index), String(raw), !!done)
    broadcast('actions-changed')
  })

  const shareTarget = (id: string) => {
    const m = store.getMeeting(id)
    if (!m) throw new Error('Note not found')
    return m
  }
  const cleanOpts = (o: ShareOptions): ShareOptions => ({ summary: !!o?.summary, transcript: !!o?.transcript })
  handle('share:copy', (id: string, o: ShareOptions) => copyToClipboard(shareTarget(id), cleanOpts(o)))
  handle('share:email', (id: string, o: ShareOptions) => emailDraft(shareTarget(id), cleanOpts(o)))
  handle('share:pdf', (id: string, o: ShareOptions) => savePdf(shareTarget(id), cleanOpts(o), mainWin ?? undefined))
  handle('share:markdown', (id: string, o: ShareOptions) => saveMarkdown(shareTarget(id), cleanOpts(o), mainWin ?? undefined))

  handle('rec:start', (id?: string) => startRecording(id))
  handle('rec:stop', () => stopRecording())
  handle('rec:current', () => recordingInfo())

  handle('settings:get', () => store.getSettings())
  handle('settings:set', (patch: Partial<Settings>) => {
    const s = store.setSettings(patch)
    applyLoginItem()
    return s
  })
  handle('setup:status', () => setupStatus())
  handle('setup:downloadWhisper', () =>
    downloadWhisper(async () => broadcast('setup-changed', await setupStatus()))
  )
  handle('setup:pickFolder', async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const r = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.on('win:openMeeting', (e, id: string) => isOwnWindow(e.sender) && showMain({ meetingId: id }))

  // Toast
  handle('toast:detected', () => detected)
  ipcMain.on('toast:accept', () => {
    const d = detected
    closeToast()
    if (d) void startRecording(undefined, d)
  })
  ipcMain.on('toast:dismiss', () => {
    if (detected) dismissed.add(detected.app)
    closeToast()
  })

  // Recording bar
  handle('bar:info', () => recordingInfo())
  ipcMain.on('bar:chunk', (e, track: Track, pcm: ArrayBuffer) => {
    if (!recording || e.sender.id !== barWin?.webContents.id) return
    if (track !== 'mic' && track !== 'sys') return
    recording.rec.write(track, Buffer.from(pcm))
  })
  ipcMain.on('bar:captureStarted', (_e, tracks: { mic: boolean; sys: boolean }) => {
    if (recording && !tracks.mic && !tracks.sys) {
      store.updateMeeting(recording.meetingId, { error: 'Kasha could not access the microphone or system audio.' })
    }
  })
  ipcMain.on('bar:captureStopped', () => finalizeRecording())
  handle('bar:addNote', (text: string) => {
    if (!recording || !text.trim()) return
    appendToNote(recording.meetingId, `\`${elapsedLabel()}\` ${text.trim()}`)
  })
  handle('bar:screenshot', async () => {
    if (!recording) return
    const id = recording.meetingId
    const stamp = elapsedLabel()
    barWin?.hide()
    let png: Buffer | null = null
    try {
      // Bring the bar back once the snip overlay has frozen the screen.
      png = await takeScreenshot(() => setTimeout(() => barWin?.showInactive(), 1500))
    } finally {
      barWin?.showInactive()
    }
    if (!png) return
    let name = `${stamp.replace(/:/g, '-')}.png`
    for (let i = 2; existsSync(join(store.paths.meeting(id), 'attachments', name)); i++) {
      name = `${stamp.replace(/:/g, '-')}-${i}.png`
    }
    writeFileSync(join(store.paths.meeting(id), 'attachments', name), png)
    appendToNote(id, `\`${stamp}\`\n\n![Screenshot ${stamp}](attachments/${name})`)
  })
  ipcMain.on('bar:stop', () => stopRecording())
  ipcMain.on('bar:openMain', () => recording && showMain({ meetingId: recording.meetingId }))
}

function applyLoginItem(): void {
  // Only the installed app registers itself; dev builds would register electron.exe.
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: store.getSettings().launchAtLogin, args: ['--hidden'] })
}

// ---------- Lifecycle ----------

app.on('second-instance', () => showMain())

// Kasha lives in the tray. Closing windows frees their memory but keeps it running.
app.on('window-all-closed', () => undefined)

app.on('before-quit', () => {
  detector.stop()
  if (recording) {
    // Close files cleanly so the audio can still be processed next time.
    const { meetingId, rec } = recording
    rec.close()
    store.updateMeeting(meetingId, { status: 'failed', error: 'Kasha quit during recording. Select Retry to process the audio.', recordingEndedAt: new Date().toISOString() })
    recording = null
  }
})

app.whenReady().then(() => {
  const meetingsRoot = store.paths.meetings()
  protocol.handle('kasha-file', (req) => {
    const url = new URL(req.url)
    const file = normalize(join(meetingsRoot, url.hostname, decodeURIComponent(url.pathname)))
    if (!file.startsWith(resolve(meetingsRoot) + sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  // System audio: getDisplayMedia in the bar resolves to a loopback capture of all output.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, callback) => {
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' })
      })
    },
    { useSystemPicker: false }
  )
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(isOwnWindow(wc) && (permission === 'media' || permission === 'display-capture' || permission === 'clipboard-sanitized-write'))
  )

  // Recover meetings left mid-pipeline by a crash or restart.
  for (const m of store.listMeetings()) {
    if (m.status === 'recording') {
      store.updateMeeting(m.id, { status: 'failed', error: 'Recording was interrupted. Select Retry to process the audio.' })
    } else if (m.status === 'transcribing' || m.status === 'summarizing') {
      enqueue(m.id, pipelineEvents)
    }
  }

  registerIpc()
  applyLoginItem()
  tray = new Tray(trayIcon())
  tray.on('click', () => showMain())
  refreshTray()
  nativeTheme.on('updated', refreshTray)
  if (!process.env.KASHA_NO_DETECT) detector.start()
  reminders.start()
  powerMonitor.on('resume', () => reminders.check())
  powerMonitor.on('unlock-screen', () => reminders.check())

  const hidden = process.argv.includes('--hidden')
  if (!store.getSettings().setupComplete || !hidden) showMain()
})
