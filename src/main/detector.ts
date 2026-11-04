import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { DetectedMeeting, MeetingApp } from '@shared/types'

type DetectableApp = Exclude<MeetingApp, 'manual'>

/**
 * Windows records which apps are using the microphone under
 * CapabilityAccessManager\ConsentStore\microphone. A LastUsedTimeStop of 0
 * means the app has the mic open right now. That's a reliable "in a call"
 * signal for Teams, Slack huddles, Zoom and RingCentral without joining anything.
 */
const CONSENT_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

const POLL_MS = 3000
const START_POLLS = 2 // ~6s of mic use before we prompt, so device tests don't trigger it
const END_POLLS = 7 // ~20s of mic released before a call counts as over
// With a reader on the call's window (Teams' Leave button), the window closing ends the call:
const QUICK_END_POLLS = 2 // ~6s of mic released, once the window has closed
const WINDOW_SETTLE_MS = 3000 // closed this long, so a redraw in Teams doesn't count
const WINDOW_GONE_MS = 15_000 // closed this long while the app still holds the mic

const MATCHERS: Array<[DetectableApp, RegExp]> = [
  ['teams', /MSTeams_|[\\#](ms-)?teams\.exe$/i],
  ['slack', /[\\#]slack\.exe$/i],
  ['zoom', /[\\#]zoom\.exe$/i],
  ['ringcentral', /ringcentral/i],
  ['browser', /[\\#](msedge|chrome|firefox|brave)\.exe$/i]
]

const PROCESS_NAMES: Record<DetectableApp, string[]> = {
  teams: ['ms-teams', 'Teams'],
  slack: ['slack'],
  zoom: ['Zoom'],
  ringcentral: ['RingCentral', 'RingCentral Video', 'RingCentralVideo'],
  browser: ['msedge', 'chrome', 'firefox', 'brave']
}

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) =>
      resolve(stdout ?? '')
    )
  })
}

/** Returns the set of meeting apps that currently hold the microphone. */
export async function appsUsingMic(): Promise<Set<DetectableApp>> {
  const out = await run('reg.exe', ['query', CONSENT_KEY, '/s'])
  const active = new Set<DetectableApp>()
  let key = ''
  let stop: string | null = null
  const flush = () => {
    if (key && stop === '0x0') {
      const name = key.slice(CONSENT_KEY.length + 1)
      const hit = MATCHERS.find(([, re]) => re.test(name))
      if (hit) active.add(hit[0])
    }
  }
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith('HKEY_')) {
      flush()
      key = line.replace(/^HKEY_CURRENT_USER/, 'HKCU')
      stop = null
    } else {
      const m = /^\s+LastUsedTimeStop\s+REG_QWORD\s+(\S+)/.exec(line)
      if (m) stop = m[1].toLowerCase()
    }
  }
  flush()
  return active
}

// Lists titles of all visible top-level windows owned by the given processes.
// MainWindowTitle alone misses Teams' separate meeting window.
const TITLES_PS = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class KW {
  delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static List<string> Titles(HashSet<uint> pids) {
    var r = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p) && IsWindowVisible(h)) { var s = new StringBuilder(512); GetWindowText(h, s, 512); if (s.Length > 0) r.Add(s.ToString()); }
      return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$ids = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-Process -Name __NAMES__ | ForEach-Object { [void]$ids.Add([uint32]$_.Id) }
[KW]::Titles($ids) | ForEach-Object { $_ }
`

const NAV_TITLES = /^(chat|calendar|activity|teams|calls|onedrive|apps|copilot|communities|settings|files|people|search|notifications|microsoft teams)\b/i

function cleanTitle(app: DetectableApp, titles: string[]): string {
  const fallback: Record<DetectableApp, string> = {
    teams: 'Teams meeting',
    slack: 'Slack huddle',
    zoom: 'Zoom meeting',
    ringcentral: 'RingCentral call',
    browser: 'Browser call'
  }
  let pick: string | undefined
  switch (app) {
    case 'teams':
      pick = titles
        .map((t) => t.replace(/\s*\|\s*Microsoft Teams.*$/i, '').replace(/^Meeting compact view\s*\|\s*/i, '').trim())
        .find((t) => t && !NAV_TITLES.test(t))
      break
    case 'slack': {
      const huddle = titles.find((t) => /huddle/i.test(t))
      pick = huddle?.replace(/\s*-\s*Slack$/i, '').trim()
      break
    }
    case 'zoom':
      pick = titles.find((t) => t && !/^zoom( workplace| meeting)?$/i.test(t.trim()))
      break
    case 'ringcentral':
      pick = titles.find((t) => t && !/^ringcentral( video)?$/i.test(t.trim()))
      break
    case 'browser':
      pick = titles
        .map((t) => t.replace(/\s*[-–—]\s*(Google Chrome|Microsoft​? Edge|Mozilla Firefox|Brave).*$/i, '').trim())
        .find((t) => /meet|teams|zoom|huddle|call|ringcentral/i.test(t))
      break
  }
  return pick && pick.length <= 120 ? pick : fallback[app]
}

export async function meetingTitle(app: DetectableApp): Promise<string> {
  const names = PROCESS_NAMES[app].map((n) => `'${n}'`).join(',')
  const out = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', TITLES_PS.replace('__NAMES__', names)],
    8000
  )
  return cleanTitle(app, out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
}

/** What a reader watching a call's window last said about it. */
interface CallWindow {
  open: boolean
  /** When it opened or closed. */
  since: number
  /** It was open at some point in this call. */
  seen: boolean
}

/**
 * Emits:
 *  - 'start' (DetectedMeeting) when a meeting app has held the mic for a few seconds
 *  - 'end'   (app, how) when the call is over:
 *    - 'window': a reader on the call's window (`callWindow`) saw it close and
 *      the mic went quiet, a few seconds after leaving. If the app keeps the mic
 *      (straight into the next call, or a mic Windows never marks released),
 *      15 s after the window closed. A window out of sight isn't closed:
 *      counting one on another desktop as closed ended calls 15 s after the
 *      user switched desktops, and then prompted again.
 *    - 'mic': otherwise, the mic released for ~20s and `stillInCall` doesn't
 *      say the call is still open. Teams can let go of the mic for a minute or
 *      more mid-call; ending on that alone cut a recording off at 27 minutes
 *      and then prompted again every time Teams took the mic back.
 */
export class MeetingDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private seen = new Map<DetectableApp, number>() // consecutive active polls
  private gone = new Map<DetectableApp, number>() // consecutive inactive polls
  private live = new Set<DetectableApp>()
  private windows = new Map<DetectableApp, CallWindow>()
  private busy = false

  constructor(
    private enabled: () => Record<DetectableApp, boolean>,
    private stillInCall: (app: DetectableApp) => Promise<boolean | null> = async () => null,
    // Swapped out in tests.
    private micApps: () => Promise<Set<DetectableApp>> = appsUsingMic,
    private title: (app: DetectableApp) => Promise<string> = meetingTitle
  ) {
    super()
  }

  /**
   * What a reader watching the app's call window sees: open, closed, 'away'
   * when it's out of sight (on another desktop, or minimized), or null when it
   * stopped. A window only counts when it closes if it was seen open. Out of
   * sight, the window can't be read, so that isn't it closing: the mic decides.
   */
  callWindow(app: DetectableApp, open: boolean | 'away' | null): void {
    const cur = this.windows.get(app)
    if (open === null) return void this.windows.delete(app)
    const isOpen = open !== false
    const seen = open === true || !!cur?.seen
    if (cur?.open !== isOpen) this.windows.set(app, { open: isOpen, since: Date.now(), seen })
    else cur.seen = seen
  }

  start(): void {
    if (this.timer || process.platform !== 'win32') return
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  isLive(app: DetectableApp): boolean {
    return this.live.has(app)
  }

  private async poll(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const active = await this.micApps()
      const enabled = this.enabled()
      for (const [app] of MATCHERS) {
        const w = this.windows.get(app)
        // How long this call's window has been closed, once it was seen open.
        const closed = this.live.has(app) && w?.seen && !w.open ? Date.now() - w.since : null
        if (active.has(app) && enabled[app]) {
          this.gone.delete(app)
          // The app kept the mic after the call's window closed. Counting starts
          // again, so a call joined straight after is detected as a new one.
          if (closed !== null && closed >= WINDOW_GONE_MS) {
            this.end(app, 'window')
            continue
          }
          const n = (this.seen.get(app) ?? 0) + 1
          this.seen.set(app, n)
          if (n === START_POLLS && !this.live.has(app)) {
            this.live.add(app)
            const title = await this.title(app)
            this.emit('start', { app, title } satisfies DetectedMeeting)
          }
        } else {
          this.seen.delete(app)
          if (!this.live.has(app)) continue
          const n = (this.gone.get(app) ?? 0) + 1
          this.gone.set(app, n)
          if (closed !== null) {
            if (n >= QUICK_END_POLLS && closed >= WINDOW_SETTLE_MS) this.end(app, 'window')
            continue
          }
          if (n >= END_POLLS) {
            // The mic is quiet but the call is still open: look again in ~20 s.
            if ((await this.stillInCall(app)) === true) {
              this.gone.set(app, 0)
              continue
            }
            this.end(app, 'mic')
          }
        }
      }
    } finally {
      this.busy = false
    }
  }

  private end(app: DetectableApp, how: 'mic' | 'window'): void {
    this.live.delete(app)
    this.gone.delete(app)
    this.seen.delete(app)
    this.windows.delete(app)
    this.emit('end', app, how)
  }
}
