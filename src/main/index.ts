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
import { countMatches, findPattern } from '@shared/text'
import {
  GENERIC_TITLE,
  isSpeakerId,
  normName,
  type CalendarMatch,
  type DetectedMeeting,
  type LiveState,
  type Meeting,
  type RecordingInfo,
  type ReplaceOptions,
  type Settings,
  type MeetingPatch,
  type ShareOptions,
  type SpeakerId,
  type ToastState,
  type TranscriptSegment
} from '@shared/types'
import { listActions, ReminderScheduler, setActionDone } from './actions'
import { lookupMeeting } from './calendar'
import { log } from './log'
import { MeetingDetector } from './detector'
import { getLive, startLive, takeLive, type LiveTranscriber } from './live'
import { syncToObsidian } from './obsidian'
import { cleanText, enqueue, type PipelineEvents } from './pipeline'
import { Recording, type Track } from './recorder'
import { takeScreenshot } from './screenshot'
import { copyToClipboard, emailDraft, saveMarkdown, savePdf } from './share'
import { redact } from './redact'
import { downloadSpeech, setupStatus, speechReady } from './setup'
import { syncVoices } from './speakers'
import { whisperPrompt } from './speech'
import * as store from './store'
import { splitNote } from './summarizer'
import * as voices from './voices'
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

let toast: ToastState | null = null
const dismissed = new Set<string>() // apps the user said "Not now" to, until that call ends
/** Calendar lookups started when a call was detected, by app, so recording can reuse them. */
const lookups = new Map<string, Promise<CalendarMatch | null>>()

interface ActiveRecording extends RecordingInfo {
  app: Meeting['app']
  rec: Recording
  live: LiveTranscriber | null
  stopping: boolean
  /** The user said yes to the prompt (not started by a rule or by hand). */
  accepted: boolean
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

const hasSummary = (id: string) => splitNote(store.readNote(id)).generated !== ''

/** Adds a correction to Names and terms, so future transcripts get it right. */
function rememberTerm(heard: string, term: string): void {
  const t = term.trim()
  const h = heard.trim()
  if (!t || !h) return
  const vocab = store.getSettings().vocabulary
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const entry = vocab.find((v) => same(v.term, t))
  const next = entry
    ? vocab.map((v) => (v === entry && !same(h, t) && !v.heardAs.some((x) => same(x, h)) ? { ...v, heardAs: [...v.heardAs, h] } : v))
    : [...vocab, { term: t, heardAs: same(h, t) ? [] : [h] }]
  broadcast('settings-changed', store.setSettings({ vocabulary: next }))
}

function appendToNote(id: string, fragment: string): void {
  const cur = store.readNote(id).replace(/\s+$/, '')
  store.writeNote(id, cur ? `${cur}\n\n${fragment}\n` : `${fragment}\n`)
  broadcast('note-appended', id, fragment)
}

// ---------- Recording rules ----------

const ruleSettings = () => store.getSettings().recording
const listHas = (list: string[], v: string) => list.some((x) => normName(x) === normName(v))
const wordsOf = (s: string) => new Set(normName(s).split(/[^\p{L}\p{N}'-]+/u).filter(Boolean))

/** Every word of the person's name is in the text, so "Sam Lee" matches "Lee, Sam" and "Huddle with Sam Lee". */
function mentions(text: string, person: string): boolean {
  const have = wordsOf(text)
  const want = [...wordsOf(person)]
  return want.length > 0 && want.every((w) => have.has(w))
}

/** The call is one the user always records: by its title, or a person in its title or invite list. */
function alwaysRecords(title: string, match?: CalendarMatch | null): boolean {
  const r = ruleSettings()
  const titles = [title, match?.subject ?? ''].filter((t) => t && !GENERIC_TITLE.test(t))
  if (titles.some((t) => listHas(r.meetings, t))) return true
  return r.people.some((p) => mentions(title, p) || !!match?.attendees.some((a) => mentions(a, p)))
}

/** The title a recurring-meeting rule would use: the window title, or the calendar subject when that's generic. */
function ruleTitle(title: string, match?: CalendarMatch | null): string | null {
  if (!GENERIC_TITLE.test(title)) return title
  return match?.subject && !GENERIC_TITLE.test(match.subject) ? match.subject : null
}

/** A past meeting had the same title. Call before creating this one's note. */
function seenBefore(title: string): boolean {
  if (GENERIC_TITLE.test(title)) return false
  return store.listMeetings().some((m) => normName(m.detectedTitle ?? m.title) === normName(title))
}

/** Whether to offer "always record this one": not already a rule, and not turned down before. */
function worthOffering(title: string | null): title is string {
  if (!title) return false
  const r = ruleSettings()
  return !listHas(r.meetings, title) && !listHas(r.declined, title)
}

function addToRule(key: 'meetings' | 'declined', title: string): void {
  const r = ruleSettings()
  if (listHas(r[key], title)) return
  broadcast('settings-changed', store.setSettings({ recording: { ...r, [key]: [...r[key], title] } }))
}

function liveState(): LiveState {
  return recording?.live?.state() ?? { available: false, paused: null }
}

function setLivePaused(paused: boolean): void {
  recording?.live?.setPaused(paused)
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
      ...(recording?.live
        ? [
            liveState().paused === 'user'
              ? { label: 'Resume transcribing', click: () => setLivePaused(false) }
              : { label: 'Pause transcribing', click: () => setLivePaused(true) }
          ]
        : []),
      { label: 'Actions', click: () => showMain({ actions: true }) },
      { label: 'Settings', click: () => showMain({ settings: true }) },
      { type: 'separator' },
      { label: 'Quit Kasha', click: () => app.quit() }
    ])
  )
}

// ---------- Recording ----------

interface StartOptions {
  /** Started by a rule or by the "always" setting, without asking. */
  auto?: boolean
  /** The user said yes to the prompt. */
  accepted?: boolean
}

async function startRecording(meetingId?: string, from?: DetectedMeeting, opts: StartOptions = {}): Promise<void> {
  if (recording) return
  let meeting = meetingId ? store.getMeeting(meetingId) : null
  if (!meeting) {
    meeting = store.createMeeting({ title: from?.title ?? 'New note', app: from?.app ?? 'manual' })
    if (from) meeting = store.updateMeeting(meeting.id, { detectedTitle: from.title })
  }
  const startedAt = Date.now()
  meeting = store.updateMeeting(meeting.id, {
    status: 'recording',
    recordingStartedAt: new Date(startedAt).toISOString(),
    error: undefined
  })
  const rec = new Recording(store.paths.meeting(meeting.id))
  const settings = store.getSettings()
  const id = meeting.id
  const live =
    settings.liveTranscription && speechReady()
      ? startLive(
          id,
          rec.dir,
          whisperPrompt(settings),
          (segs) => broadcast('transcript-live', id, segs.map((s) => ({ ...s, text: cleanText(s.text) }))),
          () => store.getSettings().recording.pauseWhenLowMemory,
          (state) => {
            if (recording?.meetingId !== id) return
            log('transcribing', { paused: state.paused ?? 'no' })
            broadcast('live-state', state)
            refreshTray()
          }
        )
      : null
  recording = { meetingId: id, title: meeting.title, startedAt, app: meeting.app, rec, live, stopping: false, accepted: !!opts.accepted }
  log('recording-started', { app: meeting.app, how: opts.auto ? 'auto' : opts.accepted ? 'prompt' : 'manual', live: !!live })
  closeToast()
  if (opts.auto && Notification.isSupported()) {
    const n = new Notification({ title: 'Recording', body: `${meeting.title}. Kasha started automatically. Stop it from the bar.`, silent: true })
    n.on('click', () => showMain({ meetingId: id }))
    n.show()
  }
  // Who was invited: for naming speakers and the summary.
  const calendar = (from && lookups.get(from.app)) ?? (settings.recording.lookupAttendees ? lookupMeeting(meeting.title) : null)
  if (from) lookups.delete(from.app)
  if (calendar) void calendar.then((match) => onCalendar(id, match))
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
  const { meetingId, rec, startedAt } = recording
  recording = null
  const tracks = rec.close()
  log('recording-stopped', { tracks: tracks.join('+') || 'none', minutes: Math.round((Date.now() - startedAt) / 60_000) })
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
  // The pipeline finishes the live transcript, if there is one.
  if (tracks.length) enqueue(meetingId, pipelineEvents)
  else takeLive(meetingId)?.stop()
}

// ---------- Meeting detection ----------

/** Stores the invite list and, for a generic window title, the calendar subject. */
function onCalendar(id: string, match: CalendarMatch | null): void {
  log('attendees', { found: !!match, people: match?.attendees.length, recurring: match?.recurring })
  const cur = store.getMeeting(id)
  if (!match || !cur) return
  const patch: Partial<Meeting> = { attendees: match.attendees }
  if (match.subject && GENERIC_TITLE.test(cur.title)) patch.title = match.subject.slice(0, 200)
  store.updateMeeting(id, patch)
  broadcast('meetings-changed')
  if (recording?.meetingId !== id) return
  if (patch.title) {
    recording.title = patch.title
    broadcast('recording-changed', recordingInfo())
    refreshTray()
  }
  // A recurring series the user said yes to: offer to always record it.
  const title = ruleTitle(cur.detectedTitle ?? cur.title, match)
  if (recording.accepted && match.recurring && !toast && worthOffering(title)) showToast({ kind: 'recurring', title })
}

function closeToast(): void {
  if (toastWin && !toastWin.isDestroyed()) toastWin.destroy()
  toastWin = null
  toast = null
}

/**
 * The call prompt stays until it's answered or the call ends: Teams' pre-join
 * screen takes the mic a minute or two before the meeting, and a prompt that
 * timed out there was gone by the time the user joined. Other prompts close
 * after 30 s.
 */
function showToast(state: ToastState): void {
  closeToast()
  toast = state
  toastWin = createToastWindow()
  toastWin.on('closed', () => (toastWin = null))
  log('prompt-shown', { kind: state.kind })
  if (state.kind === 'detected') return
  setTimeout(() => {
    if (toast !== state) return
    log('prompt-expired', { kind: state.kind })
    closeToast()
  }, 30_000)
}

detector.on('start', (m: DetectedMeeting) => void onDetected(m))

async function onDetected(m: DetectedMeeting): Promise<void> {
  const settings = store.getSettings()
  const r = settings.recording
  log('call-detected', { app: m.app, mode: r.mode, recording: !!recording, dismissed: dismissed.has(m.app), setup: settings.setupComplete })
  if (recording || dismissed.has(m.app) || !settings.setupComplete) return
  // Started now so the invite list is ready by the time it's needed.
  const calendar = r.lookupAttendees ? lookupMeeting(m.title) : Promise.resolve(null)
  lookups.set(m.app, calendar)
  if (r.mode === 'always' || alwaysRecords(m.title)) return startRecording(undefined, m, { auto: true })
  if (r.mode === 'ask') showToast({ kind: 'detected', meeting: m })
  // Someone on the always-record list may be in the invite.
  const match = await calendar
  if (recording || dismissed.has(m.app) || !detector.isLive(m.app)) return
  if (alwaysRecords(m.title, match)) await startRecording(undefined, m, { auto: true })
}

detector.on('end', (appName: string) => {
  log('call-ended', { app: appName, prompt: toast?.kind === 'detected' && toast.meeting.app === appName, recording: recording?.app === appName })
  dismissed.delete(appName)
  lookups.delete(appName)
  if (toast?.kind === 'detected' && toast.meeting.app === appName) closeToast()
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
    if (!meeting) return null
    const live = getLive(id)
    const transcript = live ? live.current().map((s) => ({ ...s, text: cleanText(s.text) })) : store.readTranscript(id)
    return { meeting, note: store.readNote(id), transcript }
  })
  handle('meetings:create', () => {
    const m = store.createMeeting({ title: 'New note', app: 'manual' })
    broadcast('meetings-changed')
    return m
  })
  handle('meetings:update', (id: string, patch: MeetingPatch) => {
    const before = store.getMeeting(id)
    const clean: Partial<Meeting> = {}
    if (typeof patch.title === 'string') clean.title = patch.title.trim().slice(0, 200) || 'Untitled'
    if (Array.isArray(patch.tags)) clean.tags = patch.tags.map(String).slice(0, 20)
    if (patch.speakers && typeof patch.speakers === 'object') {
      const names: NonNullable<Meeting['speakers']> = {}
      for (const [k, v] of Object.entries(patch.speakers)) {
        if (isSpeakerId(k) && typeof v === 'string' && v.trim()) names[k] = v.trim().slice(0, 60)
      }
      clean.speakers = names
      // The summary still uses the old names until it's rewritten.
      if (hasSummary(id)) clean.summaryOutdated = true
      // Naming a speaker teaches Kasha their voice for next time.
      syncVoices(id, before?.speakers, names)
      // A guess the user renamed or cleared is theirs now.
      const guesses = { ...before?.speakerGuesses }
      for (const k of Object.keys(guesses) as SpeakerId[]) if (names[k] !== before?.speakers?.[k]) delete guesses[k]
      clean.speakerGuesses = guesses
    }
    if (Array.isArray(patch.attendees)) {
      const names = patch.attendees.filter((a): a is string => typeof a === 'string').map((a) => a.trim().slice(0, 80)).filter(Boolean)
      clean.attendees = Array.from(new Set(names)).slice(0, 100)
    }
    if (patch.attendance && typeof patch.attendance === 'object') {
      const marks = { ...before?.attendance }
      for (const [k, v] of Object.entries(patch.attendance)) {
        const key = normName(String(k)).slice(0, 80)
        if (!key) continue
        if (v === 'present' || v === 'absent') marks[key] = v
        else delete marks[key]
      }
      clean.attendance = marks
    }
    const confirm = patch.confirmSpeaker
    if (isSpeakerId(confirm) && before?.speakerGuesses?.[confirm] && before.speakers?.[confirm]) {
      const { [confirm]: _, ...rest } = before.speakerGuesses
      clean.speakerGuesses = rest
      // Now it's confirmed, the voice is learned like any name the user gave.
      syncVoices(id, { ...before.speakers, [confirm]: undefined }, before.speakers)
    }
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
  handle('meetings:saveTranscript', (id: string, segs: TranscriptSegment[]) => {
    const m = store.getMeeting(id)
    if (!m || m.status === 'recording' || m.status === 'transcribing' || m.status === 'separating') throw new Error('The transcript is still being written.')
    if (!Array.isArray(segs)) return
    const before = store.readTranscript(id)
    const next = segs
      .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && isSpeakerId(s.speaker) && typeof s.text === 'string')
      .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: redact(s.text.slice(0, 5000)) }))
    store.writeTranscript(id, next)
    const moved = next.length !== before.length || next.some((s, i) => s.speaker !== before[i].speaker)
    if (moved && hasSummary(id)) store.updateMeeting(id, { summaryOutdated: true })
    broadcast('meetings-changed')
  })
  handle('meetings:replace', (id: string, find: string, replacement: string, o: ReplaceOptions) => {
    const m = store.getMeeting(id)
    if (!m || m.status === 'recording' || m.status === 'transcribing' || m.status === 'separating') throw new Error('The transcript is still being written.')
    const re = findPattern(String(find), { matchCase: !!o?.matchCase })
    if (!re) return { transcript: 0, notes: 0 }
    const to = redact(String(replacement))
    let inTranscript = 0
    const transcript = store.readTranscript(id).map((s) => {
      const n = countMatches(s.text, re)
      inTranscript += n
      return n ? { ...s, text: s.text.replace(re, () => to) } : s
    })
    if (inTranscript) store.writeTranscript(id, transcript)
    let inNotes = 0
    if (o?.notes) {
      const note = store.readNote(id)
      inNotes = countMatches(note, re)
      if (inNotes) store.writeNote(id, note.replace(re, () => to))
    } else if (inTranscript && hasSummary(id)) {
      store.updateMeeting(id, { summaryOutdated: true })
    }
    if (o?.remember) rememberTerm(String(find), to)
    broadcast('meetings-changed')
    if (inNotes) broadcast('actions-changed')
    return { transcript: inTranscript, notes: inNotes }
  })
  handle('meetings:resummarize', (id: string) => {
    const m = store.getMeeting(id)
    if (!m || (m.status !== 'ready' && m.status !== 'failed') || !store.readTranscript(id).length) return
    enqueue(id, pipelineEvents)
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
    downloadSpeech(async () => broadcast('setup-changed', await setupStatus()))
  )

  handle('voices:list', () => voices.list())
  handle('voices:remove', (name: string) => voices.remove(String(name)))
  handle('setup:pickFolder', async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const r = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.on('win:openMeeting', (e, id: string) => isOwnWindow(e.sender) && showMain({ meetingId: id }))

  // Toast. In the recurring prompt, accept is "Always record" and dismiss is "Just this once".
  handle('toast:state', () => toast)
  ipcMain.on('toast:accept', async (e) => {
    if (!isOwnWindow(e.sender)) return
    const t = toast
    log('prompt-accepted', { kind: t?.kind })
    closeToast()
    if (t?.kind === 'recurring') return addToRule('meetings', t.title)
    if (t?.kind !== 'detected') return
    const d = t.meeting
    const recurring = seenBefore(d.title)
    await startRecording(undefined, d, { accepted: true })
    if (recurring && worthOffering(d.title)) showToast({ kind: 'recurring', title: d.title })
  })
  ipcMain.on('toast:dismiss', (e) => {
    if (!isOwnWindow(e.sender)) return
    const t = toast
    log('prompt-dismissed', { kind: t?.kind })
    closeToast()
    if (t?.kind === 'detected') dismissed.add(t.meeting.app)
    if (t?.kind === 'recurring') addToRule('declined', t.title)
  })

  handle('calendar:check', () => lookupMeeting('Teams meeting'))

  // Recording bar
  handle('bar:info', () => recordingInfo())
  handle('bar:live', () => liveState())
  ipcMain.on('bar:setPaused', (e, paused: boolean) => {
    if (e.sender.id === barWin?.webContents.id) setLivePaused(!!paused)
  })
  ipcMain.on('bar:chunk', (e, track: Track, pcm: ArrayBuffer) => {
    if (!recording || e.sender.id !== barWin?.webContents.id) return
    if (track !== 'mic' && track !== 'sys') return
    const buf = Buffer.from(pcm)
    recording.rec.write(track, buf)
    recording.live?.wrote(track, buf.length)
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
    takeLive(meetingId)?.stop()
    store.updateMeeting(meetingId, { status: 'failed', error: 'Kasha quit during recording. Select Retry to process the audio.', recordingEndedAt: new Date().toISOString() })
    recording = null
  }
})

app.whenReady().then(() => {
  log('app-started', { version: app.getVersion(), installed: app.isPackaged, detect: !process.env.KASHA_NO_DETECT })
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
    } else if (m.status === 'transcribing' || m.status === 'separating' || m.status === 'summarizing') {
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
