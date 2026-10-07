import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { normName, type Meeting, type SpeakerId, type TranscriptSegment } from '@shared/types'
import { log } from './log'
import * as store from './store'

/**
 * Who's in a Teams call, read from the meeting window the way a screen reader
 * reads it (UI Automation). Teams labels every video tile with the person's
 * name, and with "Muted" or "Unmuted" where it shows that, so no captions or
 * bots are needed. Kasha keeps a timeline of who was there and who was muted,
 * and after the call matches it against the voices it told apart: a one-to-one
 * call names the other voice outright, and in a group call a voice that only
 * talked while one person was unmuted is offered that name.
 *
 * The reader is a small C# program, compiled on first use by the C# compiler
 * that ships with Windows (.NET Framework), so there's no SDK to install and
 * nothing extra to download. It runs only while a Teams call is recorded, at
 * low priority, and reads every 2 seconds. Names stay on this PC.
 */

export interface RosterPerson {
  name: string
  /** null when the tile doesn't say. */
  muted: boolean | null
  /** The note taker's own tile. */
  self: boolean
  /** Only if Teams ever labels it; null when it doesn't say. */
  speaking: boolean | null
}

export interface RosterSnapshot {
  /** Seconds from the start of the recording. */
  t: number
  /** Everyone on screen then. Empty when the meeting window wasn't found. */
  people: RosterPerson[]
}

const EVERY_MS = 2000

const SOURCE = String.raw`
using System; using System.Collections.Generic; using System.Diagnostics; using System.Linq;
using System.Runtime.InteropServices; using System.Text; using System.Text.RegularExpressions;
using System.Threading; using System.Windows.Automation;

static class KashaTeams {
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);

  class Person { public string Name; public int Muted = -1; public bool Self; public int Speaking = -1; }

  static readonly RegexOptions I = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
  static readonly Regex TileWord = new Regex(@"^(video is (on|off)|camera is (on|off)|(mic(rophone)? (is )?)?(un)?muted|context menu is available|has context menu)$", I);
  static readonly Regex MutedWord = new Regex(@"^(mic(rophone)? (is )?)?muted$|^mic(rophone)? (is )?off$", I);
  static readonly Regex UnmutedWord = new Regex(@"^(mic(rophone)? (is )?)?unmuted$|^mic(rophone)? (is )?on$", I);
  static readonly Regex SpeakingWord = new Regex(@"^(is )?(speaking|talking)$", I);
  static readonly Regex NotPerson = new Regex(@"^(video|camera|mic|microphone|muted|unmuted|context menu|more options|chat|people|share|leave)\b", I);

  static Person Parse(string label) {
    if (string.IsNullOrEmpty(label) || label.Length > 300) return null;
    var parts = label.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
    if (parts.Count < 2 || !parts.Skip(1).Any(p => TileWord.IsMatch(p))) return null;
    var who = parts[0];
    var self = false;
    // The self view reads "myself video, <name>, Unmuted, ...".
    if (who.EndsWith(" video", StringComparison.OrdinalIgnoreCase) && parts.Count > 2) {
      self = who.StartsWith("myself", StringComparison.OrdinalIgnoreCase);
      who = parts[1];
    }
    if (Regex.IsMatch(who, @"\((you|me)\)\s*$", I)) { self = true; who = Regex.Replace(who, @"\s*\((you|me)\)\s*$", "", I); }
    if (who.Length == 0 || who.Length > 80 || !who.Any(char.IsLetter) || NotPerson.IsMatch(who)) return null;
    var p0 = new Person { Name = who, Self = self };
    foreach (var p in parts) {
      if (MutedWord.IsMatch(p)) p0.Muted = 1;
      else if (UnmutedWord.IsMatch(p)) p0.Muted = 0;
      if (SpeakingWord.IsMatch(p)) p0.Speaking = 1;
      else if (Regex.IsMatch(p, @"^not (speaking|talking)$", I)) p0.Speaking = 0;
    }
    return p0;
  }

  static CacheRequest Cache() {
    var cr = new CacheRequest();
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.TreeScope = TreeScope.Element | TreeScope.Descendants;
    cr.AutomationElementMode = AutomationElementMode.None;
    return cr;
  }

  // Reads one window: the people on its tiles, and whether it has a Leave button (it's a call).
  static Dictionary<string, Person> Read(IntPtr hwnd, out bool call) {
    var people = new Dictionary<string, Person>(StringComparer.OrdinalIgnoreCase);
    // The window is found live; its tree is then fetched in one cached call.
    var live = AutomationElement.FromHandle(hwnd);
    AutomationElement root;
    using (Cache().Activate()) root = live.FindFirst(TreeScope.Element, Condition.TrueCondition);
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    call = false;
    int seen = 0;
    while (stack.Count > 0 && seen++ < 20000) {
      var e = stack.Pop();
      var name = e.Cached.Name;
      if (e.Cached.ControlType == ControlType.Button && name != null && name.StartsWith("Leave", StringComparison.OrdinalIgnoreCase)) call = true;
      var p = Parse(name);
      if (p != null) {
        Person had;
        if (people.TryGetValue(p.Name, out had)) {
          if (had.Muted < 0) had.Muted = p.Muted;
          if (had.Speaking < 0) had.Speaking = p.Speaking;
          had.Self |= p.Self;
        } else people[p.Name] = p;
      }
      foreach (AutomationElement c in e.CachedChildren) stack.Push(c);
    }
    return people;
  }

  // The Teams window with a call in it; the one showing the most people if there are several.
  static IntPtr Find() {
    var best = IntPtr.Zero; int most = -1;
    foreach (var proc in Process.GetProcessesByName("ms-teams")) {
      AutomationElementCollection wins;
      try { wins = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, proc.Id)); }
      catch { continue; }
      foreach (AutomationElement w in wins) {
        try {
          var h = new IntPtr(w.Current.NativeWindowHandle);
          bool call; var n = Read(h, out call).Count;
          if (call && n > most) { most = n; best = h; }
        } catch { }
      }
    }
    return best;
  }

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (var ch in s) {
      if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
      else if (ch < ' ') b.AppendFormat("\\u{0:x4}", (int)ch);
      else b.Append(ch);
    }
    return b.Append('"').ToString();
  }

  static string Line(Dictionary<string, Person> people) {
    var items = people.Values.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).Select(p =>
      "{\"name\":" + Json(p.Name) + ",\"muted\":" + (p.Muted < 0 ? "null" : p.Muted == 1 ? "true" : "false") +
      ",\"self\":" + (p.Self ? "true" : "false") + ",\"speaking\":" + (p.Speaking < 0 ? "null" : p.Speaking == 1 ? "true" : "false") + "}");
    return "{\"people\":[" + string.Join(",", items) + "]}";
  }

  static void Main(string[] args) {
    int every = args.Length > 0 ? int.Parse(args[0]) : 2000;
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    // Kasha closes stdin when it's done (or goes away): stop then.
    new Thread(() => { try { while (Console.In.Read() >= 0) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
    Console.OutputEncoding = new UTF8Encoding(false);
    var hwnd = IntPtr.Zero;
    string last = null;
    var found = DateTime.MinValue;
    while (true) {
      string line;
      try {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || (DateTime.UtcNow - found).TotalSeconds > 30) { hwnd = Find(); found = DateTime.UtcNow; }
        bool call = false;
        var people = hwnd == IntPtr.Zero ? null : Read(hwnd, out call);
        if (!call) { hwnd = IntPtr.Zero; people = null; }
        line = people == null ? "{\"people\":[]}" : Line(people);
      } catch (Exception e) {
        hwnd = IntPtr.Zero;
        line = "{\"error\":" + Json(e.GetType().Name) + "}";
      }
      if (line != last) { Console.Out.WriteLine(line); Console.Out.Flush(); last = line; }
      Thread.Sleep(every);
    }
  }
}
`

const hash = createHash('sha256').update(SOURCE).digest('hex').slice(0, 10)
const binDir = () => join(store.paths.root(), 'bin')
const exePath = () => join(binDir(), `kasha-teams-${hash}.exe`)

let compiling: Promise<string | null> | null = null

/** The reader, compiled the first time it's needed (a few seconds), or null where that isn't possible. */
function helper(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (existsSync(exePath())) return Promise.resolve(exePath())
  compiling ??= new Promise<string | null>((resolve) => {
    const fw = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
    const csc = join(fw, 'csc.exe')
    if (!existsSync(csc)) {
      log('teams-names-unavailable', { reason: 'no-csc' })
      return resolve(null)
    }
    mkdirSync(binDir(), { recursive: true })
    // Older versions of the reader go.
    for (const f of readdirSync(binDir())) if (/^kasha-teams-.*\.(exe|cs)$/.test(f)) rmSync(join(binDir(), f), { force: true })
    const src = join(binDir(), `kasha-teams-${hash}.cs`)
    writeFileSync(src, SOURCE)
    const wpf = join(fw, 'WPF')
    const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((d) => `/r:${join(wpf, d)}`)
    execFile(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${exePath()}`, ...refs, src], { windowsHide: true, timeout: 60_000 }, (err, stdout) => {
      rmSync(src, { force: true })
      if (err || !existsSync(exePath())) {
        log('teams-names-unavailable', { reason: 'compile', error: String(stdout || err?.message).trim().split('\n').pop()?.slice(0, 200) })
        compiling = null
        return resolve(null)
      }
      resolve(exePath())
    })
  })
  return compiling
}

/** Watches the Teams window for the length of one recording. */
export class TeamsRoster {
  private child: ChildProcess | null = null
  private timeline: RosterSnapshot[] = []
  private stopped = false

  constructor(private readonly startedAt: number) {}

  async start(): Promise<void> {
    const exe = await helper()
    if (!exe || this.stopped) return
    const child = spawn(exe, [String(EVERY_MS)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    child.on('error', (e) => log('teams-names-failed', { error: e.message.slice(0, 200) }))
    child.stdin?.on('error', () => undefined)
    let errors = 0
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { people?: RosterPerson[]; error?: string }
        if (msg.error) {
          if (errors++ < 3) log('teams-names-error', { error: msg.error })
          return
        }
        if (!Array.isArray(msg.people)) return
        this.timeline.push({ t: (Date.now() - this.startedAt) / 1000, people: msg.people })
      } catch {
        /* a partial line */
      }
    })
  }

  /** Stops reading and returns what was seen. */
  stop(): RosterSnapshot[] {
    this.stopped = true
    if (this.child) {
      this.child.stdin?.end()
      this.child.kill()
      this.child = null
    }
    return this.timeline
  }
}

const rosterFile = (meetingId: string) => join(store.paths.meeting(meetingId), 'roster.json')

export function readRoster(meetingId: string): RosterSnapshot[] {
  try {
    const t = JSON.parse(readFileSync(rosterFile(meetingId), 'utf8')) as RosterSnapshot[]
    return Array.isArray(t) ? t : []
  } catch {
    return []
  }
}

/** Adds to the meeting's timeline (a recording carried on after a crash has two parts). */
export function saveRoster(meetingId: string, timeline: RosterSnapshot[]): void {
  if (!timeline.length) return
  const all = [...readRoster(meetingId), ...timeline].sort((a, b) => a.t - b.t)
  writeFileSync(rosterFile(meetingId), JSON.stringify(all))
  const people = new Set(all.flatMap((s) => s.people.map((p) => normName(p.name))))
  log('teams-names', { snapshots: all.length, people: people.size })
}

// ---------- Naming voices ----------

/** Everyone seen in the call except the note taker, first-seen spelling. */
export function participants(timeline: RosterSnapshot[], myName = ''): string[] {
  const self = new Set(timeline.flatMap((s) => s.people.filter((p) => p.self).map((p) => normName(p.name))))
  if (myName.trim()) self.add(normName(myName))
  const seen = new Map<string, string>()
  for (const s of timeline) for (const p of s.people) if (!self.has(normName(p.name)) && !seen.has(normName(p.name))) seen.set(normName(p.name), p.name)
  return [...seen.values()]
}

const LEAD = 2.5 // people unmute a moment before they talk, and Teams is read every 2 s
const LAG = 1.5

/** The snapshots that describe time `x`: the one in effect a little before, and any close after. */
function around(timeline: RosterSnapshot[], x: number): RosterSnapshot[] {
  const out: RosterSnapshot[] = []
  let before: RosterSnapshot | null = null
  for (const s of timeline) {
    if (s.t <= x - LEAD) before = s
    else if (s.t <= x + LAG) out.push(s)
    else break
  }
  return before ? [before, ...out] : out
}

/** Points in time to check across a speaker's lines: every half second, at most 2000. */
function samples(segs: TranscriptSegment[]): number[] {
  const all: number[] = []
  for (const s of segs) for (let x = s.start + 0.25; x < s.end; x += 0.5) all.push(x)
  if (all.length <= 2000) return all
  const step = all.length / 2000
  return Array.from({ length: 2000 }, (_, i) => all[Math.floor(i * step)])
}

export interface RosterNames {
  /** Certain: the call had one other person. */
  names: NonNullable<Meeting['speakers']>
  /** Likely, for the user to confirm. */
  guesses: NonNullable<Meeting['speakerGuesses']>
  guessNames: NonNullable<Meeting['speakers']>
}

/**
 * Names the voices on the computer's audio from the Teams timeline. Speakers
 * that already have a name (given by the user, or a known voice) are left alone.
 */
export function namesFromRoster(timeline: RosterSnapshot[], transcript: TranscriptSegment[], known: Meeting['speakers'], myName = ''): RosterNames {
  const out: RosterNames = { names: {}, guesses: {}, guessNames: {} }
  const remote = participants(timeline, myName)
  const ids = [...new Set(transcript.map((s) => s.speaker))].filter((id): id is SpeakerId => id !== 'you' && !known?.[id]?.trim())
  if (!remote.length || !ids.length) return out
  const taken = new Set(Object.values(known ?? {}).map((n) => normName(n ?? '')))

  // One other person in the whole call: every other voice is theirs.
  if (remote.length === 1) {
    if (!taken.has(normName(remote[0]))) for (const id of ids) out.names[id] = remote[0]
    return out
  }

  const hasSpeaking = timeline.some((s) => s.people.some((p) => p.speaking === true))
  for (const id of ids) {
    const xs = samples(transcript.filter((s) => s.speaker === id))
    if (xs.length < 6) continue // under 3 s of speech
    const fit = new Map<string, number>() // share of the time they could have been talking
    const spoke = new Map<string, number>() // share of the time Teams said they were
    for (const x of xs) {
      const near = around(timeline, x)
      for (const name of remote) {
        const k = normName(name)
        const states = near.map((s) => s.people.find((p) => normName(p.name) === k)).filter((p): p is RosterPerson => !!p)
        if (states.some((p) => p.muted !== true)) fit.set(k, (fit.get(k) ?? 0) + 1)
        if (states.some((p) => p.speaking === true)) spoke.set(k, (spoke.get(k) ?? 0) + 1)
      }
    }
    const ranked = (m: Map<string, number>) =>
      remote.map((name) => ({ name, share: (m.get(normName(name)) ?? 0) / xs.length })).sort((a, b) => b.share - a.share)
    let pick: { name: string; evidence: string } | null = null
    if (hasSpeaking) {
      const [a, b] = ranked(spoke)
      if (a.share >= 0.5 && a.share >= 2 * (b?.share ?? 0)) {
        pick = { name: a.name, evidence: `Teams showed ${a.name} talking during ${Math.round(a.share * 100)}% of this voice's lines.` }
      }
    }
    if (!pick) {
      const fits = ranked(fit).filter((c) => c.share >= 0.9)
      if (fits.length === 1) pick = { name: fits[0].name, evidence: `${fits[0].name} was the only person unmuted in Teams while this voice talked.` }
    }
    if (pick && !taken.has(normName(pick.name))) {
      out.guessNames[id] = pick.name
      out.guesses[id] = { evidence: pick.evidence }
    }
  }
  return out
}
