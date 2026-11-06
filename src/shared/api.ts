import type {
  ActionGroup,
  AppInfo,
  AskAnswer,
  AskTurn,
  AudioInfo,
  BackgroundState,
  BarNote,
  BarView,
  CalendarMatch,
  LiveState,
  Meeting,
  MeetingPatch,
  RecordingInfo,
  RelatedNote,
  ReplaceOptions,
  SetupStatus,
  Settings,
  ShareOptions,
  SpeakerId,
  TagCount,
  ToastState,
  TranscriptSegment,
  UpdateStatus,
  VoiceProfile
} from './types'

/** Surface exposed on `window.kasha` by the preload script. */
export interface KashaApi {
  // Meetings
  listMeetings(): Promise<Meeting[]>
  getMeeting(id: string): Promise<{ meeting: Meeting; note: string; transcript: TranscriptSegment[]; audio: AudioInfo | null } | null>
  /** Copies the recording to a folder the user picks. False if they cancelled. */
  saveAudio(id: string): Promise<boolean>
  deleteAudio(id: string): Promise<void>
  /** The recording of one line, as a short WAV: the mic for You, the computer's audio for anyone else. Null once the recording is gone. */
  audioClip(id: string, speaker: SpeakerId, start: number, end: number): Promise<Uint8Array<ArrayBuffer> | null>
  createNote(): Promise<Meeting>
  updateMeeting(id: string, patch: MeetingPatch): Promise<Meeting>
  saveNote(id: string, markdown: string): Promise<void>
  saveImage(id: string, data: ArrayBuffer, ext: string): Promise<string> // returns relative path
  saveTranscript(id: string, segments: TranscriptSegment[]): Promise<void>
  /** Whole-word find and replace in the transcript, and optionally the note. Returns how many were replaced. */
  replaceText(id: string, find: string, replace: string, opts: ReplaceOptions): Promise<{ transcript: number; notes: number }>
  /** Adds a correction to Names and terms: `heard` is replaced by `term` in future transcripts. */
  rememberTerm(heard: string, term: string): Promise<void>
  /** Rewrites the summary from the current transcript and speaker names. */
  resummarize(id: string): Promise<void>
  /**
   * With `obsidian`, the synced note and its screenshots go to the Recycle Bin
   * too. `remember` saves the choice as Settings' `obsidian.onDelete`.
   */
  deleteMeeting(id: string, opts?: { obsidian?: boolean; remember?: boolean }): Promise<void>
  /**
   * Combines notes from one call (cut off, or left and rejoined) into the
   * earliest of them, then writes one summary for the whole call. The others
   * are deleted; with `obsidian`, their Obsidian copies go to the Recycle Bin.
   */
  combineNotes(ids: string[], opts?: { obsidian?: boolean }): Promise<Meeting>
  retry(id: string): Promise<void>
  syncNow(id: string): Promise<void>
  revealInObsidian(id: string): Promise<void>

  // Ask about a call, with related notes from Obsidian
  /** Notes in the vault (or in Kasha) on the same topic as this call, best first. */
  relatedNotes(id: string): Promise<RelatedNote[]>
  /** Notes whose title or tags match what was typed, to add one by hand. */
  findNotes(id: string, query: string): Promise<RelatedNote[]>
  /** Answers a question from this call and the chosen notes (by key), carrying on from `history`. */
  ask(id: string, question: string, notes: string[], history: AskTurn[]): Promise<AskAnswer>
  /** Opens a related note: in Kasha if it came from Kasha, otherwise in Obsidian. */
  openNote(key: string): Promise<void>
  /** Adds markdown to the end of the note (an answer worth keeping). */
  appendToNote(id: string, markdown: string): Promise<void>

  // Actions
  listActions(): Promise<ActionGroup[]>
  setActionDone(meetingId: string, index: number, raw: string, done: boolean): Promise<void>
  /** Removes the task line from the note (it wasn't really an action). */
  removeAction(meetingId: string, index: number, raw: string): Promise<void>

  // Share
  shareCopy(id: string, opts: ShareOptions): Promise<void>
  shareEmail(id: string, opts: ShareOptions): Promise<void>
  sharePdf(id: string, opts: ShareOptions): Promise<boolean>
  shareMarkdown(id: string, opts: ShareOptions): Promise<boolean>

  // Recording
  startRecording(id?: string): Promise<void>
  stopRecording(): Promise<void>
  currentRecording(): Promise<RecordingInfo | null>
  /** Finishing earlier meetings: whether it's paused or slowed for a call. */
  backgroundState(): Promise<BackgroundState>
  /** Pauses or resumes finishing earlier meetings. Resuming while memory is low carries on anyway. */
  setBackgroundPaused(paused: boolean): Promise<void>

  // Settings + setup
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  setupStatus(): Promise<SetupStatus>
  /** Downloads whatever speech and speaker models are missing. */
  downloadWhisper(): Promise<void>
  pickFolder(): Promise<string | null>
  /** Looks for the meeting happening now in Outlook, to check the calendar lookup works. */
  checkCalendar(): Promise<CalendarMatch | null>

  // Tags across all notes
  listTags(): Promise<TagCount[]>
  /** Renames a tag in every note (merging into `to` where it already exists) and re-syncs those notes. */
  renameTag(from: string, to: string): Promise<void>
  removeTag(tag: string): Promise<void>

  // Voices learned from named speakers
  listVoices(): Promise<VoiceProfile[]>
  removeVoice(name: string): Promise<void>
  /** Forgets every learned voice and every meeting's voiceprints. */
  forgetAllVoices(): Promise<void>

  // The app itself
  appInfo(): Promise<AppInfo>
  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  /** Installs a downloaded update and restarts. False when Kasha is busy with a recording. */
  installUpdate(): Promise<boolean>

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
  onBackgroundState(cb: (s: BackgroundState) => void): () => void
  /** New lines from live transcription during a call. */
  onTranscriptLive(cb: (id: string, segments: TranscriptSegment[]) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}

/** Toast window surface. */
export interface ToastApi {
  state(): Promise<ToastState | null>
  /** "Start transcribing", or "Always record" for a recurring meeting. */
  accept(): void
  /** "Not now", or "Just this once". */
  dismiss(): void
  /** "Never record this meeting": adds the title to the never list. */
  never(): void
}

/** Recording bar surface. Audio capture lives in this window. */
export interface BarApi {
  info(): Promise<RecordingInfo | null>
  live(): Promise<LiveState>
  /** Pauses or resumes transcribing during the call, and finishing an earlier note. Recording carries on. */
  setPaused(paused: boolean): void
  onLiveState(cb: (s: LiveState) => void): () => void
  sendChunk(track: 'mic' | 'sys', pcm: ArrayBuffer): void
  captureStarted(tracks: { mic: boolean; sys: boolean }): void
  captureStopped(): void
  /** A track stopped on its own mid-call (device unplugged, audio service restarted). */
  captureLost(track: 'mic' | 'sys'): void
  /** Adds a quick note to the meeting's note; returns the ones typed in the bar so far. */
  addNote(text: string): Promise<BarNote[]>
  /** Adds a pasted picture (PNG, JPEG, GIF or WebP) to the meeting's note; returns the bar's notes so far. */
  addImage(data: ArrayBuffer, type: string): Promise<BarNote[]>
  notes(): Promise<BarNote[]>
  /** Resolves once the snip is added (or cancelled), with the bar's notes so far. */
  screenshot(): Promise<BarNote[]>
  stop(): void
  openMain(): void
  onStopRequested(cb: () => void): () => void
  view(): Promise<BarView>
  /** Minimize, open the notes drawer, or open up the minimized bar. The window is resized to fit. */
  setView(patch: Partial<Pick<BarView, 'minimized' | 'notes' | 'expanded'>>): Promise<BarView>
  onView(cb: (v: BarView) => void): () => void
  /** The pointer, pressed at (x, y) in the bar's window, started dragging: the bar follows it until dragEnd. */
  dragStart(x: number, y: number): void
  dragEnd(): void
}

declare global {
  interface Window {
    kasha: KashaApi
    toast: ToastApi
    bar: BarApi
  }
}
