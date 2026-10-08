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
  /** People seen in the call (from the Teams window), not counting the note taker. Names only. */
  participants?: string[]
  /** Who was there, set by hand where the recording can't tell: by `attendanceKey(name)`. */
  attendance?: Record<string, Presence>
  /**
   * Speakers the summary named from the conversation (someone was addressed by
   * name and they answered, say). The name is in `speakers`; this marks it as a
   * guess until the user confirms it, and says why.
   */
  speakerGuesses?: Partial<Record<SpeakerId, { evidence: string }>>
  /** Who's who has been worked out (voices told apart, names offered), so it isn't done again. */
  separated?: boolean
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

/**
 * A speaker's name for notes and exports: a guess the user hasn't confirmed
 * yet keeps its question mark, so it isn't passed on as fact.
 */
export function shownName(id: SpeakerId, m: Pick<Meeting, 'speakers' | 'speakerGuesses'>): string {
  const name = speakerName(id, m.speakers)
  return m.speakerGuesses?.[id] && m.speakers?.[id]?.trim() ? `${name}?` : name
}

/** A name or term to spell right. Whisper gets it as a hint, and misheard forms are replaced. */
export interface VocabularyEntry {
  term: string
  heardAs: string[]
}

/** Which speech model transcribes. All run on this PC. */
export type SpeechModelId = 'parakeet' | 'parakeet-hq' | 'whisper-medium'

export interface SpeechModelInfo {
  id: SpeechModelId
  name: string
  tagline: string
  detail: string
  mb: number
}

export const SPEECH_MODELS: SpeechModelInfo[] = [
  {
    id: 'parakeet',
    name: 'Quick',
    tagline: 'Parakeet, 4-bit',
    detail: 'Notes are ready a couple of minutes after the call ends. Right for most meetings.',
    mb: 356
  },
  {
    id: 'parakeet-hq',
    name: 'Careful',
    tagline: 'Parakeet, 8-bit',
    detail: 'A little more accurate on quiet or accented speech. Somewhat slower, and uses about 850 MB of memory while it runs.',
    mb: 669
  },
  {
    id: 'whisper-medium',
    name: 'Thorough',
    tagline: 'Whisper medium',
    detail:
      'The most accurate on hard audio and jargon, and the only one that takes your Names and terms as spelling hints. Several times slower, so the transcript is ready a while after the call, and uses about 1 GB while it runs.',
    mb: 539
  }
]

export interface Settings {
  setupComplete: boolean
  launchAtLogin: boolean
  keepAudio: boolean
  /** Which speech model transcribes. Downloaded when chosen. */
  speechModel: SpeechModelId
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
    /** Read who's in a Teams call, and who's muted, from the Teams window (UI Automation) to name speakers. */
    fromTeams: boolean
  }
  vocabulary: VocabularyEntry[]
  tags: {
    /** Added to every note's tags in Obsidian, e.g. "meeting". */
    defaults: string[]
    /** Let the summary add one to three topic tags to each note. */
    fromSummary: boolean
  }
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
    /** Meeting titles never recorded and never asked about, whatever the mode. */
    never: string[]
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
    /**
     * What deleting a note in Kasha does to its Obsidian copy. ask: the delete
     * prompt asks each time. both: it goes too. kasha: it stays in the vault.
     */
    onDelete: 'ask' | 'both' | 'kasha'
  }
}

export const DEFAULT_SETTINGS: Settings = {
  setupComplete: false,
  launchAtLogin: true,
  keepAudio: false,
  speechModel: 'parakeet',
  summaryEngine: 'auto',
  myName: '',
  liveTranscription: true,
  speakers: { separate: true, recognize: true, fromTeams: true },
  vocabulary: [],
  tags: { defaults: [], fromSummary: true },
  reminders: { enabled: true, time: '09:00' },
  detect: { teams: true, slack: true, ringcentral: true, zoom: true, browser: false },
  recording: { mode: 'ask', meetings: [], declined: [], people: [], never: [], lookupAttendees: true, pauseWhenLowMemory: true },
  obsidian: {
    vault: '',
    folder: 'Meetings',
    fileName: '{date} {title}',
    syncOnEnd: true,
    includeTranscript: false,
    attachments: true,
    onDelete: 'ask'
  }
}

export interface SetupStatus {
  whisper: {
    ready: boolean
    downloading: boolean
    progress: number
    error?: string
    /** Which engine transcribes right now: the chosen model's, or the older Whisper small where only it is installed. */
    engine: 'parakeet' | 'whisper' | null
    /** The chosen model, when it is installed; null while it still has to be downloaded. */
    model: SpeechModelId | null
    /** Speech models already on this PC. */
    installed: SpeechModelId[]
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

/** Kasha's own updates, from the GitHub releases of the repo. */
export interface UpdateStatus {
  /**
   * dev: running from source, where updates are off. downloading: a newer
   * version is on its way. ready: downloaded, waiting for a restart.
   */
  state: 'dev' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  version: string | null
  message: string | null
  /** How much of the download is done, 0 to 100. */
  percent?: number
}

/** A tag and how many notes carry it. */
export interface TagCount {
  tag: string
  count: number
}

/** Tags are lowercase, with hyphens for spaces and no leading "#", as Obsidian likes them. */
export const normTag = (t: string): string =>
  t
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_/]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** The recording still on disk for a meeting, and when Kasha will delete it. */
export interface AudioInfo {
  bytes: number
  until: string // ISO
}

export interface AppInfo {
  version: string
  installed: boolean
}

export interface ReplaceOptions {
  matchCase: boolean
  notes: boolean // also replace in the note
  remember: boolean // add to Names and terms so future transcripts are fixed too
}
