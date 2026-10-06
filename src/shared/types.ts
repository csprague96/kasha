export type MeetingApp = 'teams' | 'slack' | 'ringcentral' | 'zoom' | 'browser' | 'manual'

export const APP_LABELS: Record<MeetingApp, string> = {
  teams: 'Teams',
  slack: 'Slack',
  ringcentral: 'RingCentral',
  zoom: 'Zoom',
  browser: 'Browser',
  manual: 'Manual'
}

/** Titles Kasha gives a call when the app's window doesn't name it. These never count as recurring. */
export const GENERIC_TITLE = /^(new note|teams meeting|slack huddle|zoom meeting|ringcentral call|browser call)$/i

/** Compares meeting titles and people's names: case, spacing and Teams' "(External)" don't matter. */
export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\((external|guest)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export type MeetingStatus =
  | 'draft' // note exists, never recorded
  | 'recording'
  | 'transcribing'
  | 'separating' // telling the speakers on the call apart
  | 'summarizing'
  | 'ready'
  | 'failed'

export type SyncState = 'synced' | 'not-synced' | 'edited-in-obsidian' | 'error'

export type Presence = 'present' | 'absent'

export interface Meeting {
  id: string
  title: string
  app: MeetingApp
  createdAt: string // ISO
  recordingStartedAt?: string
  recordingEndedAt?: string
  status: MeetingStatus
  error?: string
  summaryEngine?: 'claude' | 'codex' // which engine wrote the summary
  /** Names given to transcript speakers, by speaker id. */
  speakers?: Partial<Record<SpeakerId, string>>
  /** The title the meeting app showed when Kasha detected the call. Used to spot recurring meetings. */
  detectedTitle?: string
  /** People invited, from the Outlook calendar when that lookup is on, or added by hand. Names only. */
  attendees?: string[]
  /** Who was there, set by hand where the recording can't tell: by `attendanceKey(name)`. */
  attendance?: Record<string, Presence>
  /**
   * Speakers the summary named from the conversation (someone was addressed by
   * name and they answered, say). The name is in `speakers`; this marks it as a
   * guess until the user confirms it, and says why.
   */
  speakerGuesses?: Partial<Record<SpeakerId, { evidence: string }>>
  /** Speakers were renamed or the transcript changed after the summary was written. */
  summaryOutdated?: boolean
  tags: string[]
  sync: {
    state: SyncState
    path?: string // absolute path of the exported .md
    at?: string
    mtimeMs?: number
    mergedMtimeMs?: number // last Obsidian edit whose checkbox states were adopted
    error?: string
  }
}

/**
 * "you" is the mic track. "others" is the computer's audio. s1, s2… are
 * people on the computer's audio once they've been told apart.
 */
export type SpeakerId = 'you' | 'others' | `s${number}`

export interface TranscriptSegment {
  start: number // seconds from recording start
  end: number
  speaker: SpeakerId
  text: string
}

export function isSpeakerId(s: unknown): s is SpeakerId {
  return typeof s === 'string' && /^(you|others|s[1-9]\d?)$/.test(s)
}

/** Display name for a speaker: the name the user gave, or You / Others / Speaker 2. */
export function speakerName(id: SpeakerId, names?: Meeting['speakers']): string {
  const given = names?.[id]?.trim()
  if (given) return given
  if (id === 'you') return 'You'
  if (id === 'others') return 'Others'
  return `Speaker ${id.slice(1)}`
}

/** A name or term to spell right. Whisper gets it as a hint, and misheard forms are replaced. */
export interface VocabularyEntry {
  term: string
  heardAs: string[]
}

export interface Settings {
  setupComplete: boolean
  launchAtLogin: boolean
  keepAudio: boolean
  /** Which CLI writes summaries. Automatic prefers Claude Code, then Codex. */
  summaryEngine: 'auto' | 'claude' | 'codex'
  /** How the note taker is named in meetings, so their actions count as "mine". */
  myName: string
  /** Transcribe in small pieces during the call instead of all at once afterwards. */
  liveTranscription: boolean
  speakers: {
    /** Split "Others" into Speaker 1, Speaker 2… from the computer's audio after the call. */
    separate: boolean
    /** Name speakers whose voice was named in a past meeting. Voices are stored on this PC only. */
    recognize: boolean
  }
  vocabulary: VocabularyEntry[]
  reminders: {
    enabled: boolean
    time: string // HH:MM, weekdays
    lastShown?: string // YYYY-MM-DD
  }
  detect: Record<Exclude<MeetingApp, 'manual'>, boolean>
  recording: {
    /**
     * ask: prompt for each call, except ones the rules below always record.
     * always: record every detected call without asking.
     * rules: record only what the rules match, and stay quiet otherwise.
     */
    mode: 'ask' | 'always' | 'rules'
    /** Meeting titles that are always recorded. */
    meetings: string[]
    /** Recurring titles the user chose "Just this once" for, so Kasha stops offering. */
    declined: string[]
    /** People whose calls are always recorded: matched against the call's title and invite list. */
    people: string[]
    /** Find the call in Outlook through Claude Code's Microsoft 365 connector, for attendee names. */
    lookupAttendees: boolean
    /** Hold off transcribing during a call while the PC is short of memory. Nothing is lost. */
    pauseWhenLowMemory: boolean
  }
  obsidian: {
    vault: string // absolute path, '' when not set
    folder: string
    fileName: string // supports {date} {time} {title}
    syncOnEnd: boolean
    includeTranscript: boolean
    attachments: boolean
  }
}

export const DEFAULT_SETTINGS: Settings = {
  setupComplete: false,
  launchAtLogin: true,
  keepAudio: false,
  summaryEngine: 'auto',
  myName: '',
  liveTranscription: true,
  speakers: { separate: true, recognize: true },
  vocabulary: [],
  reminders: { enabled: true, time: '09:00' },
  detect: { teams: true, slack: true, ringcentral: true, zoom: true, browser: false },
  recording: { mode: 'ask', meetings: [], declined: [], people: [], lookupAttendees: true, pauseWhenLowMemory: true },
  obsidian: {
    vault: '',
    folder: 'Meetings',
    fileName: '{date} {title}',
    syncOnEnd: true,
    includeTranscript: false,
    attachments: true
  }
}

export interface SetupStatus {
  whisper: {
    ready: boolean
    downloading: boolean
    progress: number
    error?: string
    /** Which model transcribes. Parakeet is the current one; Whisper where only the older model is installed. */
    engine: 'parakeet' | 'whisper' | null
    /** The speaker models are installed. */
    speakers: boolean
    /** Size of what a download would fetch now. */
    downloadMb: number
  }
  claude: { installed: boolean; signedIn: boolean }
  codex: { installed: boolean; signedIn: boolean }
  vaults: string[] // detected Obsidian vault paths
}

/** A person whose voice Kasha has learned from named speakers in past meetings. */
export interface VoiceProfile {
  name: string
  meetings: number // how many meetings taught this voice
  updatedAt: string // ISO
}

export interface DetectedMeeting {
  app: Exclude<MeetingApp, 'manual'>
  title: string
}

/** What the corner prompt shows: a call to record, or an offer to always record a recurring one. */
export type ToastState =
  | { kind: 'detected'; meeting: DetectedMeeting }
  | { kind: 'recurring'; title: string }

/** The calendar event Kasha matched a call to. */
export interface CalendarMatch {
  subject: string | null
  recurring: boolean
  attendees: string[]
}

/** Live transcription during a call. Paused work is done later; no audio is lost. */
export interface LiveState {
  available: boolean // live transcription is running for this call
  paused: 'user' | 'memory' | null
}

export interface RecordingInfo {
  meetingId: string
  title: string
  startedAt: number // epoch ms
}

/** A task line (`- [ ]`) in a meeting note. The note is the source of truth. */
export interface ActionItem {
  meetingId: string
  index: number // position among the note's task lines
  text: string // task text without owner or due date
  raw: string // full line text after the checkbox, used to find the line again
  owner: string | null
  mine: boolean
  due: string | null // YYYY-MM-DD
  dueText: string | null // as stated, when no date could be resolved
  done: boolean
}

export interface ActionGroup {
  meeting: Pick<Meeting, 'id' | 'title' | 'createdAt' | 'recordingStartedAt'>
  items: ActionItem[]
}

/** What the renderer may change on a meeting. */
export type MeetingPatch = Partial<Pick<Meeting, 'title' | 'tags' | 'speakers' | 'attendees'>> & {
  /** Accepts the guessed name for this speaker. */
  confirmSpeaker?: SpeakerId
  /** By-hand attendance marks to merge in; null clears one. */
  attendance?: Record<string, Presence | null>
}

export interface ShareOptions {
  summary: boolean // summary and notes
  transcript: boolean
}

export interface ReplaceOptions {
  matchCase: boolean
  notes: boolean // also replace in the note
  remember: boolean // add to Names and terms so future transcripts are fixed too
}
