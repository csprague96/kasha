import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BarApi, KashaApi, ToastApi } from '@shared/api'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const kasha: KashaApi = {
  listMeetings: () => invoke('meetings:list'),
  getMeeting: (id) => invoke('meetings:get', id),
  saveAudio: (id) => invoke('meetings:saveAudio', id),
  deleteAudio: (id) => invoke('meetings:deleteAudio', id),
  createNote: () => invoke('meetings:create'),
  updateMeeting: (id, patch) => invoke('meetings:update', id, patch),
  saveNote: (id, md) => invoke('meetings:saveNote', id, md),
  saveImage: (id, data, ext) => invoke('meetings:saveImage', id, data, ext),
  saveTranscript: (id, segments) => invoke('meetings:saveTranscript', id, segments),
  replaceText: (id, find, replace, opts) => invoke('meetings:replace', id, find, replace, opts),
  resummarize: (id) => invoke('meetings:resummarize', id),
  deleteMeeting: (id) => invoke('meetings:delete', id),
  retry: (id) => invoke('meetings:retry', id),
  syncNow: (id) => invoke('meetings:sync', id),
  revealInObsidian: (id) => invoke('meetings:reveal', id),

  listActions: () => invoke('actions:list'),
  setActionDone: (id, index, raw, done) => invoke('actions:setDone', id, index, raw, done),
  removeAction: (id, index, raw) => invoke('actions:remove', id, index, raw),

  shareCopy: (id, opts) => invoke('share:copy', id, opts),
  shareEmail: (id, opts) => invoke('share:email', id, opts),
  sharePdf: (id, opts) => invoke('share:pdf', id, opts),
  shareMarkdown: (id, opts) => invoke('share:markdown', id, opts),

  startRecording: (id) => invoke('rec:start', id),
  stopRecording: () => invoke('rec:stop'),
  currentRecording: () => invoke('rec:current'),

  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  setupStatus: () => invoke('setup:status'),
  downloadWhisper: () => invoke('setup:downloadWhisper'),
  pickFolder: () => invoke('setup:pickFolder'),
  checkCalendar: () => invoke('calendar:check'),

  listVoices: () => invoke('voices:list'),
  removeVoice: (name) => invoke('voices:remove', name),

  appInfo: () => invoke('app:info'),
  updateStatus: () => invoke('update:status'),
  checkForUpdates: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),

  openMeeting: (id) => ipcRenderer.send('win:openMeeting', id),

  onMeetingsChanged: (cb) => on('meetings-changed', cb),
  onNoteAppended: (cb) => on('note-appended', cb),
  onSetupChanged: (cb) => on('setup-changed', cb),
  onNavigate: (cb) => on('navigate', cb),
  onActionsChanged: (cb) => on('actions-changed', cb),
  onRecordingChanged: (cb) => on('recording-changed', cb),
  onProgress: (cb) => on('progress', cb),
  onTranscriptLive: (cb) => on('transcript-live', cb),
  onSettingsChanged: (cb) => on('settings-changed', cb),
  onUpdateStatus: (cb) => on('update-status', cb)
}

const toast: ToastApi = {
  state: () => invoke('toast:state'),
  accept: () => ipcRenderer.send('toast:accept'),
  dismiss: () => ipcRenderer.send('toast:dismiss'),
  never: () => ipcRenderer.send('toast:never')
}

const bar: BarApi = {
  info: () => invoke('bar:info'),
  live: () => invoke('bar:live'),
  setPaused: (paused) => ipcRenderer.send('bar:setPaused', paused),
  onLiveState: (cb) => on('live-state', cb),
  sendChunk: (track, pcm) => ipcRenderer.send('bar:chunk', track, pcm),
  captureStarted: (tracks) => ipcRenderer.send('bar:captureStarted', tracks),
  captureStopped: () => ipcRenderer.send('bar:captureStopped'),
  addNote: (text) => invoke('bar:addNote', text),
  screenshot: () => invoke('bar:screenshot'),
  stop: () => ipcRenderer.send('bar:stop'),
  openMain: () => ipcRenderer.send('bar:openMain'),
  onStopRequested: (cb) => on('bar-stop', cb)
}

contextBridge.exposeInMainWorld('kasha', kasha)
contextBridge.exposeInMainWorld('toast', toast)
contextBridge.exposeInMainWorld('bar', bar)
