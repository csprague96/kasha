import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { constants, cpus, setPriority } from 'node:os'
import type { TranscriptSegment } from '@shared/types'
import { SAMPLE_RATE, type Track } from './recorder'
import { whisperPaths } from './setup'

interface WhisperJson {
  transcription: Array<{ offsets: { from: number; to: number }; text: string }>
}

const SILENCE_RMS = 120 // int16 RMS; below this a segment is near-silent
const NOISE_TEXT = /^\s*(\[[^\]]*\]|\([^)]*\)|♪+|\.+)\s*$/
const SILENCE_HALLUCINATIONS = /^\s*(thank you\.?|thanks for watching[.!]?|you\.?|bye\.?)\s*$/i

/** Runs whisper-cli on one 16 kHz WAV file. Progress is reported 0..1. */
function runWhisper(wav: string, onProgress: (p: number) => void): Promise<WhisperJson> {
  const cli = whisperPaths.cli()
  if (!cli) return Promise.reject(new Error('Speech model is not installed.'))
  const outBase = wav.replace(/\.wav$/, '')
  const threads = Math.max(2, Math.floor(cpus().length / 2))
  return new Promise((resolve, reject) => {
    const child = spawn(
      cli,
      [
        '-m', whisperPaths.model(),
        '-f', wav,
        '-l', 'en',
        '-t', String(threads),
        '-oj', '-of', outBase,
        '-np', '-pp',
        // Skip silence. Each track is quiet while the other side talks.
        '--vad', '-vm', whisperPaths.vad()
      ],
      { windowsHide: true }
    )
    // Keep the machine responsive: transcription yields to everything else.
    try {
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      /* not fatal */
    }
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr = (stderr + s).slice(-4000)
      const m = /progress\s*=\s*(\d+)%/.exec(s)
      if (m) onProgress(Number(m[1]) / 100)
    })
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Transcription failed (exit ${code}). ${stderr.trim().split('\n').pop() ?? ''}`))
      try {
        const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as WhisperJson
        rmSync(`${outBase}.json`, { force: true })
        resolve(json)
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** RMS of the int16 samples between two times, read straight from the WAV. */
function segmentRms(fd: number, start: number, end: number): number {
  const from = 44 + Math.floor(start * SAMPLE_RATE) * 2
  const len = Math.min(Math.max(0, Math.floor((end - start) * SAMPLE_RATE) * 2), SAMPLE_RATE * 2 * 30)
  if (len === 0) return 0
  const buf = Buffer.alloc(len)
  const n = readSync(fd, buf, 0, len, from)
  let sum = 0
  const count = Math.floor(n / 2)
  for (let i = 0; i < count; i++) {
    const v = buf.readInt16LE(i * 2)
    sum += v * v
  }
  return count ? Math.sqrt(sum / count) : 0
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w.length > 2))
}

function similarity(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / Math.min(A.size, B.size)
}

/**
 * When someone uses speakers instead of a headset, the mic also picks up the
 * other side. Drop "You" lines that duplicate a simultaneous "Others" line.
 */
function removeEcho(segs: TranscriptSegment[]): TranscriptSegment[] {
  const others = segs.filter((s) => s.speaker === 'others')
  return segs.filter(
    (s) =>
      s.speaker === 'others' ||
      !others.some((o) => o.start < s.end + 1.5 && o.end > s.start - 1.5 && similarity(o.text, s.text) >= 0.6)
  )
}

export async function transcribe(
  tracks: Array<{ track: Track; file: string }>,
  onProgress: (p: number) => void
): Promise<TranscriptSegment[]> {
  const all: TranscriptSegment[] = []
  // Run tracks one after another rather than in parallel to cap CPU and memory.
  for (let i = 0; i < tracks.length; i++) {
    const { track, file } = tracks[i]
    const json = await runWhisper(file, (p) => onProgress((i + p) / tracks.length))
    const fd = openSync(file, 'r')
    try {
      for (const seg of json.transcription) {
        const text = seg.text.trim()
        const start = seg.offsets.from / 1000
        const end = seg.offsets.to / 1000
        if (!text || NOISE_TEXT.test(text)) continue
        const rms = segmentRms(fd, start, end)
        if (rms < SILENCE_RMS && (SILENCE_HALLUCINATIONS.test(text) || rms < SILENCE_RMS / 3)) continue
        all.push({ start, end, speaker: track === 'mic' ? 'you' : 'others', text })
      }
    } finally {
      closeSync(fd)
    }
  }
  return removeEcho(all.sort((a, b) => a.start - b.start))
}
