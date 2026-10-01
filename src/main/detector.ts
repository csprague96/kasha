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

/**
 * Emits:
 *  - 'start' (DetectedMeeting) when a meeting app has held the mic for a few seconds
 *  - 'end'   (app) when it has released the mic for ~20s
 */
export class MeetingDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private seen = new Map<DetectableApp, number>() // consecutive active polls
  private gone = new Map<DetectableApp, number>() // consecutive inactive polls
  private live = new Set<DetectableApp>()
  private busy = false

  constructor(private enabled: () => Record<DetectableApp, boolean>) {
    super()
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
      const active = await appsUsingMic()
      const enabled = this.enabled()
      for (const [app] of MATCHERS) {
        if (active.has(app) && enabled[app]) {
          this.gone.delete(app)
          const n = (this.seen.get(app) ?? 0) + 1
          this.seen.set(app, n)
          if (n === START_POLLS && !this.live.has(app)) {
            this.live.add(app)
            const title = await meetingTitle(app)
            this.emit('start', { app, title } satisfies DetectedMeeting)
          }
        } else {
          this.seen.delete(app)
          if (!this.live.has(app)) continue
          const n = (this.gone.get(app) ?? 0) + 1
          this.gone.set(app, n)
          if (n >= END_POLLS) {
            this.live.delete(app)
            this.gone.delete(app)
            this.emit('end', app)
          }
        }
      }
    } finally {
      this.busy = false
    }
  }
}
