import { app, BrowserWindow, nativeImage, screen, shell } from 'electron'
import { join } from 'node:path'

const preload = join(__dirname, '../preload/index.js')

/**
 * The K mark for title bars, Alt-Tab and the taskbar. The installed app ships
 * it as a loose .ico next to the executable (build.extraResources); from
 * source it's read from build/. Without this, Windows falls back to the
 * Electron logo.
 */
export function appIcon(): Electron.NativeImage {
  const file = app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build', 'icon.ico')
  return nativeImage.createFromPath(file)
}

function load(win: BrowserWindow, page: 'index' | 'toast' | 'bar', hash = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}/${page}.html${hash}`)
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`), { hash: hash.replace(/^#/, '') })
}

const base = () => ({
  show: false,
  autoHideMenuBar: true,
  icon: appIcon(),
  webPreferences: { preload, sandbox: true, contextIsolation: true, spellcheck: true }
})

function lockNavigation(win: BrowserWindow): void {
  // External links open in the default browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'file:')) e.preventDefault()
  })
}

export function createMainWindow(hash = ''): BrowserWindow {
  const win = new BrowserWindow({
    ...base(),
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'Kasha',
    backgroundColor: '#F6F5F2'
  })
  lockNavigation(win)
  win.once('ready-to-show', () => win.show())
  load(win, 'index', hash)
  return win
}

/** "Meeting detected" prompt, top-right. Shown without taking focus from the call. */
export function createToastWindow(height = 156): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 360
  const win = new BrowserWindow({
    ...base(),
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    transparent: true,
    hasShadow: false
  })
  lockNavigation(win)
  win.setAlwaysOnTop(true, 'floating')
  win.once('ready-to-show', () => win.showInactive())
  load(win, 'toast')
  return win
}

/** Floating recording bar. Also hosts audio capture for the session. */
export function createBarWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 600
  const height = 56
  const b = base()
  const win = new BrowserWindow({
    ...b,
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 12,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    webPreferences: { ...b.webPreferences, backgroundThrottling: false }
  })
  lockNavigation(win)
  win.setAlwaysOnTop(true, 'floating')
  win.once('ready-to-show', () => win.showInactive())
  load(win, 'bar')
  return win
}
