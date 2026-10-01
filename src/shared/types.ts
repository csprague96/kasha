export type MeetingApp = 'teams' | 'slack' | 'ringcentral' | 'zoom' | 'browser' | 'manual'

export const APP_LABELS: Record<MeetingApp, string> = {
  teams: 'Teams',
  slack: 'Slack',
  ringcentral: 'RingCentral',
  zoom: 'Zoom',
  browser: 'Browser',
  manual: 'Manual'
}

export type MeetingStatus =
  | 'draft' // note exists, never recorded
  | 'recording'
  | 'transcribing'
  | 'summarizing'
  | 'ready'
  | 'failed'

export type SyncState = 'synced' | 'not-synced' | 'edited-in-obsidian' | 'error'

export interface Meeting {
  id: string
  title: string
  app: MeetingApp
  createdAt: string // ISO
  recordingStartedAt?: string
  recordingEndedAt?: string
  status: MeetingStatus
  error?: string
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

export interface TranscriptSegment {
  start: number // seconds from recording start
  end: number
  speaker: 'you' | 'others'
  text: string
}

export interface Settings {
  setupComplete: boolean
  launchAtLogin: boolean
  keepAudio: boolean
  /** How the note taker is named in meetings, so their actions count as "mine". */
  myName: string
  reminders: {
    enabled: boolean
    time: string // HH:MM, weekdays
    lastShown?: string // YYYY-MM-DD
  }
  detect: Record<Exclude<MeetingApp, 'manual'>, boolean>
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
  myName: '',
  reminders: { enabled: true, time: '09:00' },
  detect: { teams: true, slack: true, ringcentral: true, zoom: true, browser: false },
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
  whisper: { ready: boolean; downloading: boolean; progress: number; error?: string }
  claude: { installed: boolean; signedIn: boolean }
  vaults: string[] // detected Obsidian vault paths
}

export interface DetectedMeeting {
  app: Exclude<MeetingApp, 'manual'>
  title: string
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

export interface ShareOptions {
  summary: boolean // summary and notes
  transcript: boolean
}
