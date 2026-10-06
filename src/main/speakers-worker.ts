/**
 * Tells speakers apart on one audio track. Runs in its own process (Electron
 * utilityProcess, or plain Node for tests) so the ~300 MB the models need is
 * freed as soon as it exits.
 *
 * Input: a WAV file, the stretches of it that contain speech, and model paths.
 * Only the speech is analysed, laid end to end with short silences between,
 * so a long call costs what its talking does, not its length. Long calls are
 * analysed in blocks; clusters are then merged across blocks by voice.
 *
 * Output: one cluster per distinct voice, with its stretches in recording
 * time and a voice embedding for recognising the person later.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

export interface SpeakerRequest {
  wav: string
  spans: Array<{ start: number; end: number }> // seconds; where speech is
  segmentationModel: string
  embeddingModel: string
  threads: number
}

export interface SpeakerCluster {
  segments: Array<{ start: number; end: number }>
  seconds: number
  embedding: number[]
}

export interface SpeakerResponse {
  clusters?: SpeakerCluster[]
  error?: string
}

const RATE = 16000
const PAD = 0.25 // audio kept either side of a speech span
const GAP = 0.5 // silence between spans in the analysed audio
const BLOCK = 15 * 60 // seconds of speech analysed at once
const CLUSTER_THRESHOLD = 0.9 // pyannote clustering: higher = fewer speakers; tuned on samples
const MERGE = 0.7 // clusters at least this similar are the same person
const TINY = 4 // clusters with less speech than this join their nearest voice
const EMBED_SECONDS = 60 // audio per cluster used for its embedding

interface Piece {
  start: number // recording time
  end: number
  at: number // position in the analysed audio
}

function readSamples(fd: number, start: number, end: number): Float32Array {
  const from = Math.max(0, Math.round(start * RATE))
  const count = Math.max(0, Math.round(end * RATE) - from)
  const buf = Buffer.alloc(count * 2)
  const n = readSync(fd, buf, 0, buf.length, 44 + from * 2)
  const out = new Float32Array(Math.floor(n / 2))
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/** Joins overlapping or nearly touching spans, padded a little, within the file. */
function mergeSpans(spans: SpeakerRequest['spans'], length: number): Array<{ start: number; end: number }> {
  const sorted = spans
    .map((s) => ({ start: Math.max(0, s.start - PAD), end: Math.min(length, s.end + PAD) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + GAP) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Splits spans into blocks of at most BLOCK seconds of speech, each laid out with gaps. */
function layout(spans: Array<{ start: number; end: number }>): Piece[][] {
  const blocks: Piece[][] = []
  let block: Piece[] = []
  let at = 0
  for (const s of spans) {
    const len = s.end - s.start
    if (block.length && at + len > BLOCK) {
      blocks.push(block)
      block = []
      at = 0
    }
    block.push({ ...s, at })
    at += len + GAP
  }
  if (block.length) blocks.push(block)
  return blocks
}

function audioFor(fd: number, pieces: Piece[]): Float32Array {
  const last = pieces[pieces.length - 1]
  const out = new Float32Array(Math.round((last.at + last.end - last.start) * RATE))
  for (const p of pieces) out.set(readSamples(fd, p.start, p.end).subarray(0, out.length - Math.round(p.at * RATE)), Math.round(p.at * RATE))
  return out
}

/** Maps a stretch of analysed audio back to recording time, split where it crosses pieces. */
function toRecordingTime(pieces: Piece[], start: number, end: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const p of pieces) {
    const len = p.end - p.start
    const s = Math.max(start, p.at)
    const e = Math.min(end, p.at + len)
    if (e - s > 0.05) out.push({ start: p.start + (s - p.at), end: p.start + (e - p.at) })
  }
  return out
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

function average(a: ArrayLike<number>, wa: number, b: ArrayLike<number>, wb: number): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] * wa + b[i] * wb) / (wa + wb)
  return out
}

/** Merges clusters that are the same voice, then folds tiny ones into their nearest. */
function consolidate(clusters: SpeakerCluster[]): SpeakerCluster[] {
  const join = (into: SpeakerCluster, from: SpeakerCluster): SpeakerCluster => ({
    segments: [...into.segments, ...from.segments].sort((x, y) => x.start - y.start),
    seconds: into.seconds + from.seconds,
    embedding: average(into.embedding, into.seconds, from.embedding, from.seconds)
  })
  let list = clusters.slice()
  for (;;) {
    let best: { i: number; j: number; score: number } | null = null
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const score = cosine(list[i].embedding, list[j].embedding)
        if (score >= MERGE && (!best || score > best.score)) best = { i, j, score }
      }
    }
    if (!best) break
    const merged = join(list[best.i], list[best.j])
    list = list.filter((_, k) => k !== best!.i && k !== best!.j)
    list.push(merged)
  }
  // Tiny clusters are usually a few words of someone already found.
  const big = list.filter((c) => c.seconds >= TINY)
  if (big.length && big.length < list.length) {
    for (const small of list.filter((c) => c.seconds < TINY)) {
      let k = 0
      for (let i = 1; i < big.length; i++) if (cosine(small.embedding, big[i].embedding) > cosine(small.embedding, big[k].embedding)) k = i
      big[k] = join(big[k], small)
    }
    list = big
  }
  return list.sort((a, b) => a.segments[0].start - b.segments[0].start)
}

export function separate(req: SpeakerRequest): SpeakerCluster[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node')
  const length = (statSync(req.wav).size - 44) / 2 / RATE
  const spans = mergeSpans(req.spans, length)
  if (!spans.length) return []

  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: req.segmentationModel }, numThreads: req.threads },
    embedding: { model: req.embeddingModel, numThreads: req.threads },
    clustering: { numClusters: -1, threshold: CLUSTER_THRESHOLD },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: req.embeddingModel, numThreads: req.threads })

  const fd = openSync(req.wav, 'r')
  try {
    const embeddingOf = (segments: Array<{ start: number; end: number }>): number[] => {
      // Spread the sample across the cluster so one odd stretch doesn't dominate.
      const total = segments.reduce((t, s) => t + s.end - s.start, 0)
      const stride = Math.max(1, Math.round(total / EMBED_SECONDS))
      const parts: Float32Array[] = []
      let budget = EMBED_SECONDS
      for (let i = 0; i < segments.length && budget > 0; i += stride) {
        const s = segments[i]
        const take = Math.min(s.end - s.start, budget)
        parts.push(readSamples(fd, s.start, s.start + take))
        budget -= take
      }
      const all = new Float32Array(parts.reduce((t, p) => t + p.length, 0))
      let o = 0
      for (const p of parts) {
        all.set(p, o)
        o += p.length
      }
      const stream = extractor.createStream()
      stream.acceptWaveform({ sampleRate: RATE, samples: all })
      stream.inputFinished()
      // External buffers aren't allowed under Electron.
      return Array.from(extractor.compute(stream, false) as Float32Array)
    }

    const clusters: SpeakerCluster[] = []
    for (const pieces of layout(spans)) {
      const found: Array<{ start: number; end: number; speaker: number }> = diarizer.process(audioFor(fd, pieces))
      const byId = new Map<number, Array<{ start: number; end: number }>>()
      for (const f of found) {
        const list = byId.get(f.speaker) ?? []
        list.push(...toRecordingTime(pieces, f.start, f.end))
        byId.set(f.speaker, list)
      }
      for (const segments of byId.values()) {
        if (!segments.length) continue
        const seconds = segments.reduce((t, s) => t + s.end - s.start, 0)
        if (seconds < 0.5) continue
        clusters.push({ segments, seconds, embedding: embeddingOf(segments) })
      }
    }
    return consolidate(clusters)
  } finally {
    closeSync(fd)
  }
}

// ---------- Entry points ----------

function respond(res: SpeakerResponse): void {
  if (process.parentPort) process.parentPort.postMessage(res)
  else process.stdout.write(JSON.stringify(res))
}

function handle(req: SpeakerRequest): void {
  try {
    respond({ clusters: separate(req) })
  } catch (e) {
    respond({ error: (e as Error).message })
  }
  setTimeout(() => process.exit(0), 50)
}

if (process.parentPort) {
  process.parentPort.once('message', (e: { data: SpeakerRequest }) => handle(e.data))
} else if (process.argv[2]) {
  // Standalone, for tests: node speakers-worker.js request.json
  handle(JSON.parse(readFileSync(process.argv[2], 'utf8')) as SpeakerRequest)
}
