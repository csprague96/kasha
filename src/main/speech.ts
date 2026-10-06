import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { constants, cpus, setPriority } from 'node:os'
import type { Settings, SpeakerId, TranscriptSegment } from '@shared/types'
import { SAMPLE_RATE, wavHeader } from './recorder'
import { speechEngine, whisperPaths } from './setup'

/**
 * Speech models work best on short stretches of audio. Run over a whole track,
 * a reply can be stamped with the end of the question it answers and sort ahead
 * of it. Instead, speech is found first, packed into ~30 s chunks with short
 * silences between pieces, and every word is mapped back to the moment it was
 * said.
 *
 * Two engines share this path: Parakeet (the default, about four times faster)
 * and Whisper, kept for PCs where only the older model is installed.
 */

export interface Span {
  start: number // seconds
  end: number
}

/** A stretch of one track, placed `at` seconds into a chunk file. */
interface Piece extends Span {
  at: number
}

export interface Chunk {
  pieces: Piece[]
}

const WINDOW = 28 // seconds of audio per chunk; Whisper's limit is 30, and Parakeet's memory grows with length
const GAP = 0.6 // silence between pieces in a chunk
const PAD = 0.1 // audio kept either side of detected speech
const MERGE = 1.0 // pauses shorter than this stay inside one piece
const FILL = 22 // seconds of waiting speech that make a chunk worth running during a call

const NOISE_TEXT = /^\s*(\[[^\]]*\]|\([^)]*\)|♪+|\.+)\s*$/

const cores = cpus().length
/** During a call: a few threads, so the call itself stays smooth. */
export const LIVE_THREADS = Math.min(4, Math.max(2, Math.floor(cores / 4)))
/** After a call or on Retry, when nothing else is waiting on the CPU. */
export const BATCH_THREADS = Math.min(6, Math.max(2, Math.floor(cores / 2)))

// ---------- Processes ----------

let lock: Promise<unknown> = Promise.resolve()

/** One speech process at a time, so a live call and a backlog never stack CPU load. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn)
  lock = next.catch(() => undefined)
  return next
}

function run(exe: string, args: string[], keepStderr = false): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true })
    // Speech work always yields to whatever the user is doing.
    try {
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      /* not fatal */
    }
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err = keepStderr ? err + d.toString() : (err + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

const lastLine = (s: string) => s.trim().split('\n').pop() ?? ''

// ---------- Audio ----------

function readPcm(fd: number, start: number, end: number): Buffer {
  const from = Math.max(0, Math.round(start * SAMPLE_RATE)) * 2
  const len = Math.max(0, Math.round(end * SAMPLE_RATE) * 2 - from)
  const buf = Buffer.alloc(len)
  const n = readSync(fd, buf, 0, len, 44 + from)
  return buf.subarray(0, n - (n % 2))
}

function writeWav(file: string, pcm: Buffer): void {
  writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]))
}

/** Lays the chunk's pieces out at their `at` positions, with silence between them. */
function writeChunk(track: string, chunk: Chunk, out: string): void {
  const fd = openSync(track, 'r')
  try {
    const parts: Buffer[] = []
    let pos = 0 // samples written so far
    for (const p of chunk.pieces) {
      const at = Math.round(p.at * SAMPLE_RATE)
      if (at > pos) parts.push(Buffer.alloc((at - pos) * 2))
      const want = Math.round((p.end - p.start) * SAMPLE_RATE) * 2
      const pcm = readPcm(fd, p.start, p.end)
      // Pad a short read (end of the recording) so later pieces stay where the map expects.
      parts.push(pcm.length >= want ? pcm.subarray(0, want) : Buffer.concat([pcm, Buffer.alloc(want - pcm.length)]))
      pos = at + want / 2
    }
    writeWav(out, Buffer.concat(parts))
  } finally {
    closeSync(fd)
  }
}

// ---------- Speech detection ----------

/**
 * Speech in a track, from Silero voice activity detection. With `window`, only
 * that part of the track is checked (copied to `tmp` first), for use while the
 * track is still being recorded.
 */
export async function detectSpeech(track: string, window?: Span & { tmp: string }): Promise<Span[]> {
  const exe = whisperPaths.vadCli()
  if (!exe) throw new Error('Speech model is not installed.')
  let input = track
  let offset = 0
  if (window) {
    const fd = openSync(track, 'r')
    try {
      writeWav(window.tmp, readPcm(fd, window.start, window.end))
    } finally {
      closeSync(fd)
    }
    input = window.tmp
    offset = window.start
  }
  try {
    const { code, out, err } = await exclusive(() => run(exe, ['-vm', whisperPaths.vad(), '-f', input, '-np', '-t', '2']))
    if (code !== 0) throw new Error(`Speech detection failed (exit ${code}). ${lastLine(err)}`)
    // Times are printed in centiseconds.
    return Array.from(out.matchAll(/start = ([\d.]+), end = ([\d.]+)/g), (m) => ({
      start: offset + Number(m[1]) / 100,
      end: offset + Number(m[2]) / 100
    }))
  } finally {
    if (window) rmSync(window.tmp, { force: true })
  }
}

/** Adds detected speech to a queue, joining stretches split by short pauses. */
export function addSpeech(queue: Span[], regions: Span[]): void {
  const max = WINDOW - 2 * PAD
  for (const r of regions) {
    const last = queue[queue.length - 1]
    if (last && r.start - last.end < MERGE && r.end - last.start <= max) {
      last.end = Math.max(last.end, r.end)
      continue
    }
    // Rare: a single run of speech longer than a window is cut into window-sized parts.
    for (let s = r.start; s < r.end; s += max) queue.push({ start: s, end: Math.min(r.end, s + max) })
  }
}

/**
 * Takes speech off the front of the queue that fits in one chunk. During a call
 * it waits until enough has built up, since a short chunk costs as much CPU as a
 * full one; `force` takes whatever is there.
 */
export function takeChunk(queue: Span[], force: boolean): Chunk | null {
  if (!queue.length) return null
  if (!force && queue.reduce((t, s) => t + s.end - s.start, 0) < FILL) return null
  const pieces: Piece[] = []
  let length = 0
  while (queue.length) {
    const start = Math.max(0, queue[0].start - PAD)
    const end = queue[0].end + PAD
    const gap = pieces.length ? GAP : 0
    if (pieces.length && length + gap + end - start > WINDOW) break
    pieces.push({ start, end, at: length + gap })
    length += gap + end - start
    queue.shift()
  }
  return { pieces }
}

// ---------- Transcription ----------

/** A piece of a word with the chunk time it was said at. Word starts begin with a space. */
interface Token {
  text: string
  t: number // seconds into the chunk
  end?: number // when known; else a little after `t`
}

/** Whisper's tokens for one of its segments. Parakeet gives one stream of tokens. */
interface TokenGroup {
  tokens: Token[]
  text?: string // the whole text, when tokens may split multi-byte characters
}

const SENTENCE_END = /[.?!]["')\]]*$/

/**
 * Maps tokens back from chunk time to recording time and groups them into
 * lines: a new line at each sentence end and wherever the audio jumps to
 * another piece of the track.
 */
export function toLines(groups: TokenGroup[], chunk: Chunk, speaker: SpeakerId): TranscriptSegment[] {
  const { pieces } = chunk
  const pieceAt = (t: number) => {
    let k = 0
    for (let i = 1; i < pieces.length; i++) if (t >= pieces[i].at - GAP / 2) k = i
    return k
  }
  const real = (k: number, t: number) => pieces[k].start + Math.min(Math.max(0, t - pieces[k].at), pieces[k].end - pieces[k].start)

  const out: TranscriptSegment[] = []
  for (const group of groups) {
    const lines: Array<{ k: number; start: number; end: number; text: string; closed: boolean }> = []
    for (const tok of group.tokens) {
      const k = pieceAt(tok.t)
      let line = lines[lines.length - 1]
      // Part of a word, or punctuation, stays with the word before it.
      const attached = !!line && (!/^\s/.test(tok.text) || !/[\p{L}\p{N}]/u.test(tok.text))
      if (!line || (!attached && (k !== line.k || line.closed))) {
        line = { k, start: real(k, tok.t), end: real(k, tok.t), text: '', closed: false }
        lines.push(line)
      }
      line.text += tok.text
      line.end = Math.max(line.end, real(line.k, tok.end ?? tok.t + 0.3))
      line.closed = SENTENCE_END.test(tok.text)
    }
    if (lines.length === 1 && group.text) lines[0].text = group.text
    for (const l of lines) {
      // Whisper sometimes writes turns as dialogue: "- Sounds good."
      const text = l.text.trim().replace(/^-\s+/, '')
      if (text && !NOISE_TEXT.test(text)) out.push({ start: l.start, end: l.end, speaker, text })
    }
  }
  return out
}

interface WhisperToken {
  text: string
  offsets: { from: number; to: number } // ms
  t_dtw?: number // centiseconds, -1 when missing
}

interface WhisperJson {
  transcription: Array<{ text: string; tokens?: WhisperToken[] }>
}

function whisperGroups(json: WhisperJson): TokenGroup[] {
  return json.transcription.map((seg) => ({
    text: seg.text,
    tokens: (seg.tokens ?? [])
      .filter((tok) => !/^\[_|^<\|/.test(tok.text)) // timestamp and control tokens
      .map((tok) => ({
        text: tok.text,
        t: tok.t_dtw !== undefined && tok.t_dtw >= 0 ? tok.t_dtw / 100 : (tok.offsets.from + tok.offsets.to) / 2000
      }))
  }))
}

/**
 * parakeet-cli prints each token with its timing to stderr, in centiseconds:
 *   [ 0] id= 4285 frame=  0 ... t0=   0 t1=  16 word_start=true "▁Go"
 * The low line (▁) marks a word start, like Whisper's leading space.
 */
export function parakeetGroups(stderr: string): TokenGroup[] {
  const tokens: Token[] = []
  for (const m of stderr.matchAll(/t0=\s*(\d+)\s+t1=\s*(\d+)\s+word_start=(?:true|false)\s+"(.*)"/g)) {
    tokens.push({ text: m[3].replace(/▁/g, ' '), t: Number(m[1]) / 100, end: Number(m[2]) / 100 })
  }
  return [{ tokens }]
}

export interface WhisperOptions {
  prompt: string
  threads: number
}

/** Transcribes one chunk of a track. `tmp` is a path prefix for the chunk's working files. */
export async function transcribeChunk(
  track: string,
  chunk: Chunk,
  speaker: SpeakerId,
  opts: WhisperOptions,
  tmp: string
): Promise<TranscriptSegment[]> {
  const engine = speechEngine()
  if (!engine) throw new Error('Speech model is not installed.')
  const wav = `${tmp}.wav`
  writeChunk(track, chunk, wav)
  try {
    if (engine === 'parakeet') {
      const cli = whisperPaths.parakeetCli()!
      const args = ['-m', whisperPaths.parakeet(), '-f', wav, '-t', String(opts.threads), '-ps', '-np']
      const { code, err } = await exclusive(() => run(cli, args, true))
      if (code !== 0) throw new Error(`Transcription failed (exit ${code}). ${lastLine(err)}`)
      return toLines(parakeetGroups(err), chunk, speaker)
    }
    const cli = whisperPaths.cli()!
    const args = [
      '-m', whisperPaths.model(),
      '-f', wav,
      '-l', 'en',
      '-t', String(opts.threads),
      // Greedy decoding: the same words as beam search in testing, for less CPU.
      '-bs', '1', '-bo', '1',
      // Word timings from attention alignment (preset for the small.en model),
      // so each word maps back to the piece it was said in. Whisper's own word
      // times drift by a few words. Alignment needs flash attention off, which
      // costs about a third more CPU, but without it lines split mid-sentence.
      '--dtw', 'small.en', '-nfa',
      '-ojf', '-of', tmp,
      '-np'
    ]
    if (opts.prompt) args.push('--prompt', opts.prompt)
    const { code, err } = await exclusive(() => run(cli, args))
    if (code !== 0) throw new Error(`Transcription failed (exit ${code}). ${lastLine(err)}`)
    return toLines(whisperGroups(JSON.parse(readFileSync(`${tmp}.json`, 'utf8')) as WhisperJson), chunk, speaker)
  } finally {
    rmSync(wav, { force: true })
    rmSync(`${tmp}.json`, { force: true })
  }
}

/**
 * Spelling hints for Whisper: the user's name and their names and terms list.
 * A punctuated sentence also keeps Whisper from dropping punctuation. Parakeet
 * takes no hints; the list still fixes misheard forms afterwards.
 */
export function whisperPrompt(s: Pick<Settings, 'myName' | 'vocabulary'>): string {
  const terms = Array.from(new Set([s.myName, ...s.vocabulary.map((v) => v.term)].map((t) => t.trim()).filter(Boolean)))
  let list = ''
  for (const t of terms) {
    const next = list ? `${list}, ${t}` : t
    if (next.length > 400) break // Whisper takes about 220 tokens of prompt
    list = next
  }
  return list ? `Meeting notes. Names and terms: ${list}.` : 'Meeting notes.'
}
