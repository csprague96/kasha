import type {
  ActionGroup,
  DetectedMeeting,
  Meeting,
  RecordingInfo,
  SetupStatus,
  Settings,
  ShareOptions,
  TranscriptSegment
} from './types'

/** Surface exposed on `window.kasha` by the preload script. */
export interface KashaApi {
  // Meetings
  listMeetings(): Promise<Meeting[]>
  getMeeting(id: string): Promise<{ meeting: Meeting; note: string; transcript: TranscriptSegment[] } | null>
  createNote(): Promise<Meeting>
  updateMeeting(id: string, patch: Partial<Pick<Meeting, 'title' | 'tags'>>): Promise<Meeting>
  saveNote(id: string, markdown: string): Promise<void>
  saveImage(id: string, data: ArrayBuffer, ext: string): Promise<string> // returns relative path
  deleteMeeting(id: string): Promise<void>
  retry(id: string): Promise<void>
  syncNow(id: string): Promise<void>
  revealInObsidian(id: string): Promise<void>

  // Actions
  listActions(): Promise<ActionGroup[]>
  setActionDone(meetingId: string, index: number, raw: string, done: boolean): Promise<void>

  // Share
  shareCopy(id: string, opts: ShareOptions): Promise<void>
  shareEmail(id: string, opts: ShareOptions): Promise<void>
  sharePdf(id: string, opts: ShareOptions): Promise<boolean>
  shareMarkdown(id: string, opts: ShareOptions): Promise<boolean>

  // Recording
  startRecording(id?: string): Promise<void>
  stopRecording(): Promise<void>
  currentRecording(): Promise<RecordingInfo | null>

  // Settings + setup
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  setupStatus(): Promise<SetupStatus>
  downloadWhisper(): Promise<void>
  pickFolder(): Promise<string | null>

  // Window
  openMeeting(id: string): void

  // Events. Each returns an unsubscribe function.
  onMeetingsChanged(cb: () => void): () => void
  onNoteAppended(cb: (id: string, markdown: string) => void): () => void
  onSetupChanged(cb: (s: SetupStatus) => void): () => void
  onNavigate(cb: (view: { meetingId?: string; settings?: boolean; actions?: boolean }) => void): () => void
  onActionsChanged(cb: () => void): () => void
  onRecordingChanged(cb: (r: RecordingInfo | null) => void): () => void
  onProgress(cb: (id: string, p: number | null) => void): () => void
}

/** Toast window surface. */
export interface ToastApi {
  detected(): Promise<DetectedMeeting | null>
  accept(): void
  dismiss(): void
}

/** Recording bar surface. Audio capture lives in this window. */
export interface BarApi {
  info(): Promise<RecordingInfo | null>
  sendChunk(track: 'mic' | 'sys', pcm: ArrayBuffer): void
  captureStarted(tracks: { mic: boolean; sys: boolean }): void
  captureStopped(): void
  addNote(text: string): Promise<void>
  screenshot(): Promise<void>
  stop(): void
  openMain(): void
  onStopRequested(cb: () => void): () => void
}

declare global {
  interface Window {
    kasha: KashaApi
    toast: ToastApi
    bar: BarApi
  }
}
