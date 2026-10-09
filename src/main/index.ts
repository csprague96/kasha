import {
  app,
  BrowserWindow,
  crashReporter,
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
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { basename, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { countMatches, findPattern } from '@shared/text'
import {
  GENERIC_TITLE,
  isSpeakerId,
  normName,
  normTag,
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
import { listActions, ReminderScheduler, removeAction, setActionDone } from './actions'
import { audioInfo, deleteAudio, exportAudio, startAudioSweeper } from './audio'
import { lookupMeeting } from './calendar'
import { log } from './log'
import { MeetingDetector } from './detector'
import { getLive, startLive, takeLive, type LiveTranscriber } from './live'
import { exportFileName, exportOptions, syncToObsidian, vaultFiles } from './obsidian'
import { background } from './background'
import { cleanText, enqueue, processing, type PipelineEvents } from './pipeline'
import { Recording, repairWav, SAMPLE_RATE, type Track } from './recorder'
import { addressFits, rosterDone, teamsCallOpen, TeamsRoster } from './roster'
import { takeScreenshot } from './screenshot'
import { copyToClipboard, emailDraft, saveMarkdown, savePdf } from './share'
import { redact } from './redact'
import { downloadSpeech, setupStatus, speakersReady, speechReady } from './setup'
import { forgetMeetingVoices, syncVoices } from './speakers'
import { whisperPrompt } from './speech'
import * as store from './store'
import { splitNote } from './summarizer'
import { Updater } from './updater'
import * as voices from './voices'
import { appIcon, createBarWindow, createMainWindow, createToastWindow } from './windows'

// Dev and testing: keep data in a separate folder so real notes aren't touched.
if (process.env.KASHA_DATA_DIR) app.setPath('userData', process.env.KASHA_DATA_DIR)

// Crash dumps stay on this PC (%APPDATA%\Kasha\Crashpad); nothing is sent anywhere.
crashReporter.start({ uploadToServer: false })

/** Error text for the log, without file paths (they can hold meeting titles). */
const scrub = (e: unknown) => String((e as Error)?.message ?? e).replace(/(?<![A-Za-z])[A-Za-z]:[\\/].*$|\\\\.*$/s, '<path>').slice(0, 200)
process.on('uncaughtException', (e) => log('error', { where: 'main', error: scrub(e) }))
process.on('unhandledRejection', (e) => log('error', { where: 'promise', error: scrub(e) }))

// The UI is simple enough to render on the CPU. Skipping the GPU process saves ~50-100 MB.
app.disableHardwareAcceleration()
app.setAppUserModelId('com.sola.kasha')

// Kasha is already running (the first copy is shown instead; see second-instance).
// Exit now: app.quit() let this copy's startup run anyway, which marked the
// running recording failed and processed its meetings a second time.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
  process.exit(0)
}

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
  /** When capture was restarted, to give up if it keeps happening. */
  restarts: number[]
  /** Reads who's in the Teams call, for naming speakers. */
  roster: TeamsRoster | null
  /** When audio last arrived from the bar, to notice capture that stopped silently. */
  lastAudio: number
  /** The bar couldn't open the mic or the computer's audio: nothing to watch for. */
  noCapture?: boolean
}
let recording: ActiveRecording | null = null

/**
 * Recordings cut off by a crash or by quitting, by app. If the same call is
 * still going when Kasha is back, recording it carries on in the same note
 * instead of starting a second one. After a crash that happens without asking.
 */
const interrupted = new Map<string, { id: string; at: number; crashed: boolean }>()
const RESUME_WITHIN_MS = 15 * 60_000

/** The interrupted note for this call, if it's recent and has the same title. */
function resumable(from: DetectedMeeting): { id: string; crashed: boolean } | null {
  const cut = interrupted.get(from.app)
  if (!cut || Date.now() - cut.at > RESUME_WITHIN_MS) return null
  const prev = store.getMeeting(cut.id)
  return prev?.status === 'failed' && normName(prev.detectedTitle ?? prev.title) === normName(from.title) ? cut : null
}

const detector = new MeetingDetector(
  () => store.getSettings().detect,
  async (app) => {
    if (app !== 'teams') return null
    const open = await teamsCallOpen()
    log('mic-released', { app, callOpen: open ?? 'unknown' })
    return open
  }
)

/** A recording or processing in progress: an update must wait for it. */
const busy = () =>
  !!recording || store.listMeetings().some((m) => m.status === 'transcribing' || m.status === 'separating' || m.status === 'summarizing')

const updater = new Updater((status) => {
  broadcast('update-status', status)
  refreshTray()
}, busy)

const reminders = new ReminderScheduler(
  () => store.getSettings(),
  (lastShown) => store.setSettings({ reminders: { ...store.getSettings().reminders, lastShown } }),
  (text) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: 'Open actions', body: text, silent: true, icon: appIcon() })
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
  // The calendar often lists people only by address, so an address that fits the name counts too.
  return r.people.some((p) => mentions(title, p) || !!match?.attendees.some((a) => mentions(a, p) || addressFits(a, p)))
}

/** The title a recurring-meeting rule would use: the window title, or the calendar subject when that's generic. */
function ruleTitle(title: string, match?: CalendarMatch | null): string | null {
  if (!GENERIC_TITLE.test(title)) return title
  return match?.subject && !GENERIC_TITLE.test(match.subject) ? match.subject : null
}

/**
 * A meeting with the same title was recorded on an earlier day. Notes from
 * earlier today don't count: after a restart mid-call, the same call has a
 * note already, and that once made a one-off meeting look like a series.
 */
function seenBefore(title: string): boolean {
  if (GENERIC_TITLE.test(title)) return false
  const today = new Date().setHours(0, 0, 0, 0)
  return store
    .listMeetings()
    .some((m) => Date.parse(m.recordingStartedAt ?? m.createdAt) < today && normName(m.detectedTitle ?? m.title) === normName(title))
}

/** Whether to offer "always record this one": not already a rule, and not turned down before. */
function worthOffering(title: string | null): title is string {
  if (!title) return false
  const r = ruleSettings()
  return !listHas(r.meetings, title) && !listHas(r.declined, title) && !listHas(r.never, title)
}

/** The call is one the user never records: no prompt, no rule, in every mode. */
function neverRecords(title: string, match?: CalendarMatch | null): boolean {
  const r = ruleSettings()
  return [title, match?.subject ?? ''].some((t) => t && !GENERIC_TITLE.test(t) && listHas(r.never, t))
}

function addToRule(key: 'meetings' | 'declined' | 'never', title: string): void {
  const r = ruleSettings()
  if (listHas(r[key], title)) return
  broadcast('settings-changed', store.setSettings({ recording: { ...r, [key]: [...r[key], title] } }))
}

function liveState(): LiveState {
  return recording?.live?.state() ?? { available: false, paused: null }
}

function setLivePaused(paused: boolean): void {
  recording?.live?.setPaused(paused)
  // The bar's pause holds back everything, an earlier note being finished
  // included. "Transcribe now" while memory is low is for this call only:
  // the earlier note keeps waiting for memory.
  if (paused || background.state().paused === 'user') background.setPaused(paused)
}

const backgroundState = () => ({ ...background.state(), meetingId: processing() })

background.setMemoryWatch(() => store.getSettings().recording.pauseWhenLowMemory)
background.onChange((s) => {
  log('background', { paused: s.paused ?? 'no', inCall: s.inCall, busy: !!processing(), freeMB: s.paused === 'memory' ? background.freeMB : undefined })
  broadcast('background-state', backgroundState())
  refreshTray()
})

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
              : liveState().paused === 'memory'
                ? { label: 'Transcribe now (memory is low)', click: () => setLivePaused(false) }
                : { label: 'Pause transcribing', click: () => setLivePaused(true) }
          ]
        : []),
      // Finishing an earlier note, when the bar's pause doesn't already cover it.
      ...(processing() && !recording?.live
        ? [
            background.state().paused === 'user'
              ? { label: 'Resume finishing notes', click: () => background.setPaused(false) }
              : background.state().paused === 'memory'
                ? { label: 'Finish notes now (memory is low)', click: () => background.setPaused(false) }
                : { label: 'Pause finishing notes', click: () => background.setPaused(true) }
          ]
        : []),
      { label: 'Actions', click: () => showMain({ actions: true }) },
      { label: 'Settings', click: () => showMain({ settings: true }) },
      { type: 'separator' },
      ...(updater.current().state === 'ready'
        ? [{ label: `Restart to update to ${updater.current().version}`, click: () => void updater.restart() }]
        : []),
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
  /** Carrying on a recording a crash cut off, in the same call: the gap is filled with silence. */
  resume?: boolean
}

async function startRecording(meetingId?: string, from?: DetectedMeeting, opts: StartOptions = {}): Promise<void> {
  if (recording) return
  let resume = !!opts.resume
  const cut = !meetingId && from ? resumable(from) : null
  if (cut && from) {
    meetingId = cut.id
    resume = true
    interrupted.delete(from.app)
  }
  let meeting = meetingId ? store.getMeeting(meetingId) : null
  if (!meeting) {
    meeting = store.createMeeting({ title: from?.title ?? 'New note', app: from?.app ?? 'manual' })
    if (from) meeting = store.updateMeeting(meeting.id, { detectedTitle: from.title })
  }
  // A recording cut off by a crash carries on in the same files, never over them.
  const leftover = meeting.status === 'failed' && !!audioInfo(meeting.id) && !store.readTranscript(meeting.id).length
  const rec = new Recording(store.paths.meeting(meeting.id), resume || leftover)
  const had = Math.max(0, ...Object.values(rec.lengths())) / 2 / SAMPLE_RATE
  // The clock carries on from the first part, so note timestamps match the audio.
  const startedAt = resume && meeting.recordingStartedAt ? Date.parse(meeting.recordingStartedAt) : Date.now() - had * 1000
  if (resume) rec.padTo((Date.now() - startedAt) / 1000)
  if (resume || leftover) rec.realign()
  meeting = store.updateMeeting(meeting.id, {
    status: 'recording',
    recordingStartedAt: new Date(startedAt).toISOString(),
    recordingEndedAt: undefined,
    error: undefined
  })
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
            log('transcribing', { paused: state.paused ?? 'no', freeMB: getLive(id)?.freeMB })
            broadcast('live-state', state)
            refreshTray()
          }
        )
      : null
  // Live transcription starts again from the top of what's already recorded.
  for (const [track, bytes] of Object.entries(rec.lengths())) live?.wrote(track as Track, bytes)
  // A Teams call (detected, or recorded by hand while one is on): read who's in it.
  const roster = settings.speakers.fromTeams && (meeting.app === 'teams' || detector.isLive('teams')) ? new TeamsRoster(startedAt, id) : null
  void roster?.start()
  recording = { meetingId: id, title: meeting.title, startedAt, app: meeting.app, rec, live, stopping: false, accepted: !!opts.accepted, restarts: [], roster, lastAudio: Date.now() }
  // An earlier note still being finished makes room for this call.
  background.setInCall(true)
  log('recording-started', { app: meeting.app, how: resume ? 'resume' : opts.auto ? 'auto' : opts.accepted ? 'prompt' : 'manual', live: !!live, model: settings.speechModel, carriedOnMin: had ? Math.round(had / 60) : undefined })
  closeToast()
  if ((opts.auto || resume) && Notification.isSupported()) {
    const body = resume
      ? `${meeting.title}. Kasha restarted and carried on recording into the same note.`
      : `${meeting.title}. Kasha started automatically. Stop it from the bar.`
    const n = new Notification({ title: 'Recording', body, silent: true })
    n.on('click', () => showMain({ meetingId: id }))
    n.show()
  }
  // Who was invited: for naming speakers and the summary.
  const known = resume && meeting.attendees?.length
  const calendar = (from && lookups.get(from.app)) ?? (settings.recording.lookupAttendees && !known ? lookupMeeting(meeting.title) : null)
  if (from) lookups.delete(from.app)
  if (calendar) void calendar.then((match) => onCalendar(id, match))
  openBar()
  startMemoryLog()
  watchAudio()
  refreshTray()
  broadcast('recording-changed', recordingInfo())
  broadcast('meetings-changed')
}

/** The bar hosts audio capture, so opening it starts capturing. */
function openBar(): void {
  const win = createBarWindow()
  barWin = win
  win.on('closed', () => barWin === win && (barWin = null))
}

/**
 * Capture stopped while recording: the bar's renderer crashed, or a device
 * went away (a headset unplugged, Windows' audio service restarted). A fresh
 * bar captures again into the same files, after silence for the gap. Limited,
 * so a fault that keeps happening can't spin.
 */
function restartCapture(reason: string): void {
  if (!recording || recording.stopping) return
  const now = Date.now()
  recording.restarts = recording.restarts.filter((t) => now - t < 10 * 60_000)
  if (recording.restarts.length >= 5) {
    log('capture-gave-up', { reason })
    // Said out loud: a recording that just stops looks like it's still going.
    if (Notification.isSupported()) {
      const id = recording.meetingId
      const n = new Notification({ title: 'Recording stopped', body: 'Audio capture kept stopping, so Kasha stopped recording. What was recorded is kept.', silent: false })
      n.on('click', () => showMain({ meetingId: id }))
      n.show()
    }
    return finalizeRecording()
  }
  recording.restarts.push(now)
  const added = recording.rec.padTo((now - recording.startedAt) / 1000)
  // The new bar's audio starts a moment later still: line it up when it arrives.
  recording.rec.realign()
  recording.noCapture = false
  for (const [track, bytes] of Object.entries(added)) recording.live?.wrote(track as Track, bytes)
  log('capture-restarted', { reason, gapSecs: Math.round(Math.max(0, ...Object.values(added)) / 2 / SAMPLE_RATE) })
  const old = barWin
  barWin = null
  if (old && !old.isDestroyed()) old.destroy()
  openBar()
}

/** While recording, memory use every 5 minutes, so a slow PC or a crash can be traced. Counts only. */
let memoryTimer: NodeJS.Timeout | null = null
function startMemoryLog(): void {
  if (memoryTimer) return
  const sample = () => {
    if (!recording) {
      if (memoryTimer) clearInterval(memoryTimer)
      memoryTimer = null
      return
    }
    const kasha = app.getAppMetrics().reduce((t, p) => t + p.memory.workingSetSize, 0) / 1024
    log('memory', {
      minutes: Math.round((Date.now() - recording.startedAt) / 60_000),
      freeMB: Math.round(freemem() / 1024 ** 2),
      kashaMB: Math.round(kasha),
      mainMB: Math.round(process.memoryUsage().rss / 1024 ** 2),
      transcribing: recording.live?.state().paused ?? 'yes'
    })
  }
  memoryTimer = setInterval(sample, 5 * 60_000)
}

/**
 * The bar sends audio (silence included) every half second while capture
 * runs. None for 15 s means capture stopped without saying so.
 */
let audioWatch: NodeJS.Timeout | null = null
function watchAudio(): void {
  if (audioWatch) return
  audioWatch = setInterval(() => {
    if (!recording) {
      if (audioWatch) clearInterval(audioWatch)
      audioWatch = null
      return
    }
    if (!recording.stopping && !recording.noCapture && Date.now() - recording.lastAudio > 15_000) {
      recording.lastAudio = Date.now()
      restartCapture('no-audio')
    }
  }, 5_000)
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
  settingsChanged: () => broadcast('settings-changed', store.getSettings()),
  changed: () => {
    broadcast('meetings-changed')
    broadcast('actions-changed')
    // Which note is being finished moves on with the queue; the tray's
    // "Pause finishing notes" comes and goes with it.
    broadcast('background-state', backgroundState())
    refreshTray()
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
  const { meetingId, rec, startedAt, roster, live } = recording
  recording = null
  // The call is over: earlier notes carry on at full speed, and a pause is lifted.
  background.setInCall(false)
  // How far live transcription is behind: what's left to do after the call.
  const behind = live?.pending()
  const tracks = rec.close()
  if (roster) {
    roster.stop()
    rosterDone(meetingId)
  }
  log('recording-stopped', { tracks: tracks.map((t) => t.track).join('+') || 'none', minutes: Math.round((Date.now() - startedAt) / 60_000), chunksLeft: behind })
  store.updateMeeting(meetingId, {
    recordingEndedAt: new Date().toISOString(),
    status: tracks.length ? 'transcribing' : 'ready',
    // Keep a more specific reason (the mic or system audio couldn't be opened).
    error: tracks.length ? undefined : (store.getMeeting(meetingId)?.error ?? 'No audio was captured.')
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
  if (!cur) return
  if (!match) {
    // Not in the calendar: a title seen on an earlier day is the only sign of a series.
    const title = cur.detectedTitle ?? cur.title
    if (recording?.meetingId === id && recording.accepted && !toast && seenBefore(title) && worthOffering(title)) showToast({ kind: 'recurring', title })
    return
  }
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
  // A recurring series the user said yes to: offer to always record it. The
  // calendar knows whether it's a series, so its answer wins over the title.
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
  // The call prompt has a third, smaller choice: never record this meeting.
  toastWin = createToastWindow(state.kind === 'detected' && !GENERIC_TITLE.test(state.meeting.title) ? 184 : 156)
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
  // Kasha crashed during this call: carry on recording it without asking again.
  const cut = resumable(m)
  if (cut?.crashed) {
    log('call-resumed', { app: m.app, gapSecs: Math.round((Date.now() - interrupted.get(m.app)!.at) / 1000) })
    return startRecording(undefined, m)
  }
  if (neverRecords(m.title)) return log('call-skipped', { app: m.app })
  // Started now so the invite list is ready by the time it's needed.
  const calendar = r.lookupAttendees ? lookupMeeting(m.title) : Promise.resolve(null)
  lookups.set(m.app, calendar)
  if (r.mode === 'always' || alwaysRecords(m.title)) return startRecording(undefined, m, { auto: true })
  if (r.mode === 'ask') showToast({ kind: 'detected', meeting: m })
  // Someone on the always-record list may be in the invite.
  const match = await calendar
  if (recording || dismissed.has(m.app) || !detector.isLive(m.app)) return
  // A generic window title can hide a meeting on the never list; the calendar subject gives it away.
  if (neverRecords(m.title, match)) {
    log('call-skipped', { app: m.app, prompt: toast?.kind === 'detected' })
    if (toast?.kind === 'detected' && toast.meeting.app === m.app) closeToast()
    return
  }
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
    return { meeting, note: store.readNote(id), transcript, audio: meeting.status === 'recording' ? null : audioInfo(id) }
  })
  handle('meetings:saveAudio', async (id: string) => {
    const m = store.getMeeting(id)
    if (!m || !audioInfo(id)) return false
    const opts: Electron.OpenDialogOptions = { title: 'Save the recording to', properties: ['openDirectory', 'createDirectory'] }
    const r = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return false
    const files = exportAudio(id, r.filePaths[0], exportFileName(m, '{date} {title}').replace(/\.md$/, ''))
    log('audio-saved', { tracks: files.length })
    if (files[0]) shell.showItemInFolder(files[0])
    return files.length > 0
  })
  handle('meetings:deleteAudio', (id: string) => {
    const m = store.getMeeting(id)
    if (!m || m.status === 'recording' || m.status === 'transcribing' || m.status === 'separating') return
    deleteAudio(id)
    broadcast('meetings-changed')
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
    if (Array.isArray(patch.tags)) clean.tags = Array.from(new Set(patch.tags.map((t) => normTag(String(t))).filter(Boolean))).slice(0, 20)
    if (patch.speakers && typeof patch.speakers === 'object') {
      const names: NonNullable<Meeting['speakers']> = {}
      for (const [k, v] of Object.entries(patch.speakers)) {
        if (!isSpeakerId(k) || typeof v !== 'string' || !v.trim()) continue
        // A name the user didn't touch stays exactly as it was: trimming a long
        // guess would look like a rename, and a rename learns the voice.
        names[k] = v === before?.speakers?.[k] ? v : v.trim().slice(0, 60)
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
      // The summary called them "Speaker N (possibly …)".
      if (hasSummary(id)) clean.summaryOutdated = true
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
    // Not a bare 13-digit number: that can pass the card check and get redacted out of the note.
    const name = `image-${Date.now().toString(36)}.${safeExt}`
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
  handle('vocab:remember', (heard: string, term: string) => rememberTerm(String(heard).slice(0, 80), String(term).slice(0, 80)))
  handle('meetings:resummarize', (id: string) => {
    const m = store.getMeeting(id)
    if (!m || (m.status !== 'ready' && m.status !== 'failed') || !store.readTranscript(id).length) return
    enqueue(id, pipelineEvents)
  })
  handle('meetings:delete', async (id: string, opts?: { obsidian?: boolean; remember?: boolean }) => {
    if (recording?.meetingId === id) return
    const m = store.getMeeting(id)
    // Obsidian first, to the Recycle Bin: if that fails the note stays in Kasha and can be tried again.
    if (m && opts?.obsidian) {
      for (const file of vaultFiles(m, store.readNote(id))) {
        try {
          await shell.trashItem(file)
        } catch (err) {
          log('obsidian-delete-failed', { error: (err as NodeJS.ErrnoException).code ?? 'unknown' })
          throw new Error(`Couldn't remove ${basename(file)} from Obsidian. Is it open in another app?`)
        }
      }
    }
    // Voices learned from this meeting go with it (they're biometric-like data).
    forgetMeetingVoices(id)
    store.deleteMeeting(id)
    broadcast('meetings-changed')
    if (opts?.remember) {
      const ob = store.getSettings().obsidian
      broadcast('settings-changed', store.setSettings({ obsidian: { ...ob, onDelete: opts.obsidian ? 'both' : 'kasha' } }))
    }
  })
  handle('meetings:retry', (id: string) => enqueue(id, pipelineEvents))
  handle('meetings:sync', (id: string) => {
    const m = store.getMeeting(id)
    if (!m) return
    const sync = syncToObsidian(m, store.readNote(id), store.readTranscript(id), exportOptions(store.getSettings()), true)
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
  handle('actions:remove', (id: string, index: number, raw: string) => {
    removeAction(id, Number(index), String(raw))
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
  handle('background:state', () => backgroundState())
  handle('background:setPaused', (paused: boolean) => background.setPaused(!!paused))

  handle('settings:get', () => store.getSettings())
  handle('settings:set', (patch: Partial<Settings>) => {
    const was = store.getSettings().speakers.recognize
    const s = store.setSettings(patch)
    if (was && !s.speakers.recognize) forgetMeetingPrints()
    applyLoginItem()
    return s
  })
  handle('setup:status', () => setupStatus())
  handle('setup:downloadWhisper', () =>
    downloadSpeech(async () => broadcast('setup-changed', await setupStatus()))
  )

  handle('tags:list', () => {
    const counts = new Map<string, number>()
    for (const m of store.listMeetings()) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag))
  })
  // Renaming or removing a tag touches every note that has it. Synced notes
  // are written to Obsidian again, unless they were edited there.
  const retag = (fn: (tags: string[]) => string[]) => {
    const settings = store.getSettings()
    for (const m of store.listMeetings()) {
      const tags = Array.from(new Set(fn(m.tags)))
      if (tags.length === m.tags.length && tags.every((t, i) => t === m.tags[i])) continue
      let next = store.updateMeeting(m.id, { tags })
      if (next.sync.state === 'synced' && settings.obsidian.vault) {
        next = store.updateMeeting(m.id, { sync: syncToObsidian(next, store.readNote(m.id), store.readTranscript(m.id), exportOptions(settings)) })
      }
    }
    broadcast('meetings-changed')
  }
  handle('tags:rename', (from: string, to: string) => {
    const target = normTag(String(to))
    if (!target || target === from) return
    retag((tags) => tags.map((t) => (t === from ? target : t)))
  })
  handle('tags:remove', (tag: string) => retag((tags) => tags.filter((t) => t !== tag)))

  handle('voices:list', () => voices.list())
  handle('voices:remove', (name: string) => voices.remove(String(name)))
  // Every learned voice, and every meeting's voiceprints.
  handle('voices:forgetAll', () => {
    voices.clear()
    forgetMeetingPrints()
    log('voices-forgotten')
  })
  handle('setup:pickFolder', async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const r = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })

  handle('app:info', () => ({ version: app.getVersion(), installed: app.isPackaged }))
  handle('update:status', () => updater.current())
  handle('update:check', () => updater.check())
  handle('update:install', () => updater.restart())

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
    // With the calendar on, the offer waits for it (see onCalendar).
    const lookup = lookups.has(d.app)
    await startRecording(undefined, d, { accepted: true })
    if (!lookup && seenBefore(d.title) && worthOffering(d.title)) showToast({ kind: 'recurring', title: d.title })
  })
  ipcMain.on('toast:dismiss', (e) => {
    if (!isOwnWindow(e.sender)) return
    const t = toast
    log('prompt-dismissed', { kind: t?.kind })
    closeToast()
    if (t?.kind === 'detected') dismissed.add(t.meeting.app)
    if (t?.kind === 'recurring') addToRule('declined', t.title)
  })
  ipcMain.on('toast:never', (e) => {
    if (!isOwnWindow(e.sender)) return
    const t = toast
    log('prompt-never', { kind: t?.kind })
    closeToast()
    if (t?.kind !== 'detected') return
    dismissed.add(t.meeting.app)
    if (!GENERIC_TITLE.test(t.meeting.title)) addToRule('never', t.meeting.title)
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
    // A track's first audio is lined up with the recording's clock: capture
    // starts a moment after it, and the computer's audio later than the mic
    // (0.6-4.9 s measured), which put "Others" lines early against "You" and
    // the Teams timeline.
    const lead = recording.rec.lead(track, (Date.now() - recording.startedAt) / 1000 - buf.length / 2 / SAMPLE_RATE)
    if (lead) recording.live?.wrote(track, lead)
    recording.rec.write(track, buf)
    recording.live?.wrote(track, buf.length)
    recording.lastAudio = Date.now()
  })
  ipcMain.on('bar:captureStarted', (_e, tracks: { mic: boolean; sys: boolean }) => {
    if (recording && !tracks.mic && !tracks.sys) {
      recording.noCapture = true
      store.updateMeeting(recording.meetingId, { error: 'Kasha could not access the microphone or system audio.' })
    }
  })
  ipcMain.on('bar:captureStopped', () => finalizeRecording())
  // Capture lost a track mid-call (see restartCapture).
  ipcMain.on('bar:captureLost', (e, track: string) => {
    if (e.sender.id === barWin?.webContents.id) restartCapture(`${track === 'mic' ? 'mic' : 'sys'}-ended`)
  })
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

/** Deletes every meeting's voiceprints (speakers.json). Learned voices (voices.json) stay unless the user forgets them. */
function forgetMeetingPrints(): void {
  let failed = 0
  for (const m of store.listMeetings()) {
    try {
      rmSync(join(store.paths.meeting(m.id), 'speakers.json'), { force: true })
    } catch {
      failed++
    }
  }
  if (failed) log('voiceprints-not-deleted', { meetings: failed })
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

// A crashed window is logged; the bar is replaced so recording carries on.
app.on('render-process-gone', (_e, wc, d) => {
  const which = wc.id === barWin?.webContents.id ? 'bar' : wc.id === mainWin?.webContents.id ? 'main' : 'other'
  log('window-crashed', { window: which, reason: d.reason, exitCode: d.exitCode })
  if (which === 'bar') restartCapture('bar-crashed')
  else if (which === 'main' && mainWin && !mainWin.isDestroyed()) mainWin.reload()
})
app.on('child-process-gone', (_e, d) => {
  log('process-gone', { type: d.type, name: d.name ?? d.serviceName, reason: d.reason, exitCode: d.exitCode })
  // Windows' audio capture runs in Chromium's audio service: when it dies, capture has to start again.
  if (d.type === 'Utility' && d.reason !== 'clean-exit' && /audio/i.test(`${d.name ?? ''} ${d.serviceName ?? ''}`)) restartCapture('audio-service')
})

app.on('before-quit', () => {
  log('app-quit', { recording: !!recording })
  detector.stop()
  updater.stop()
  if (recording) {
    // Close files cleanly so the audio can still be processed next time.
    const { meetingId, rec, roster } = recording
    rec.close()
    roster?.stop()
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
      // Kasha crashed mid-recording. The files are fixed up so Retry (or carrying on) can read them.
      const files = (['mic', 'sys'] as Track[]).map((t) => join(store.paths.meeting(m.id), 'audio', `${t}.wav`)).filter((f) => existsSync(f))
      files.forEach(repairWav)
      const at = Math.max(0, ...files.map((f) => statSync(f).mtimeMs))
      if (m.app !== 'manual' && at) interrupted.set(m.app, { id: m.id, at, crashed: true })
      log('recording-interrupted', { app: m.app, minutesAgo: at ? Math.round((Date.now() - at) / 60_000) : undefined })
      store.updateMeeting(m.id, { status: 'failed', error: 'Recording was interrupted. Select Retry to process the audio.' })
    } else if (m.status === 'failed' && m.app !== 'manual' && m.error?.startsWith('Kasha quit during recording') && m.recordingEndedAt) {
      // Quit mid-call: if the call is still on and the user records it again, it goes in this note.
      interrupted.set(m.app, { id: m.id, at: Date.parse(m.recordingEndedAt), crashed: false })
    } else if (m.status === 'transcribing' || m.status === 'separating' || m.status === 'summarizing') {
      enqueue(m.id, pipelineEvents)
    }
  }

  registerIpc()
  // Voices learned from notes deleted before deleting took them along, and
  // voiceprints left behind with recognition off.
  voices.prune(new Set(store.listMeetings().map((m) => m.id)))
  if (!store.getSettings().speakers.recognize) forgetMeetingPrints()
  applyLoginItem()
  updater.start()
  startAudioSweeper(() => broadcast('meetings-changed'))
  // An update changed the voice model: fetch the new one (small) so speakers are still told apart.
  if (store.getSettings().setupComplete && speechReady() && !speakersReady()) {
    log('speaker-models-missing', { downloading: true })
    void downloadSpeech(async () => broadcast('setup-changed', await setupStatus()))
  }
  tray = new Tray(trayIcon())
  tray.on('click', () => showMain())
  refreshTray()
  nativeTheme.on('updated', refreshTray)
  if (!process.env.KASHA_NO_DETECT) detector.start()
  reminders.start()
  powerMonitor.on('resume', () => reminders.check())
  // A sleeping PC drops the call too: end the recording rather than pad hours of silence on waking.
  powerMonitor.on('suspend', () => {
    if (!recording) return
    log('recording-stopped-for-sleep')
    stopRecording()
  })
  powerMonitor.on('unlock-screen', () => reminders.check())

  const hidden = process.argv.includes('--hidden')
  if (!store.getSettings().setupComplete || !hidden) showMain()
})
