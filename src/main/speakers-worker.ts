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
  /**
   * How many other people the invite says were there, when known. Similar
   * voices on call audio can look like one person; when fewer voices than this
   * are found, voices are split more finely. Too many speakers is easier to
   * fix (give two the same name) than too few.
   */
  expected?: number
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
/*
 * pyannote (through sherpa-onnx) finds where speech turns start and stop, but
 * its own grouping of turns into people contradicted the voiceprints on real
 * Teams audio: turns it called different people were 0.7-0.9 alike, and turns
 * it called one person 0.0-0.3. So turns are cut into short windows, each gets
 * its own voiceprint (ERes2Net; see setup.ts), and Kasha groups those. On a
 * real call, window pairs fell into two bands, about 0.0-0.2 (different
 * people) and 0.4-0.7 (same person), with the valley at 0.2-0.3.
 */
const CLUSTER_THRESHOLD = 0.5 // pyannote's grouping; only its turn boundaries are used
const WINDOW = 2.5 // seconds of speech per voiceprint; long turns can hide a change of speaker
const MIN_WINDOW = 1.0 // shorter turns are too short for a voiceprint; they follow the nearest window
const CUT = 0.3 // windows grouped while their average similarity is at least this
// With an expected head count, a stricter cut is tried when fewer voices than
// that appear. Beyond 0.45 the voiceprints shatter into fragments.
const CUTS = [CUT, 0.4]
const SUBSTANTIAL = 20 // seconds of speech for a group to count as a person
const SAME = 0.7 // groups this alike are one person even when more are expected
const MERGE = 0.4 // clusters at least this similar are the same person; split pieces of one voice rejoin here
const TINY = 4 // clusters with less speech than this join their nearest voice…
const TINY_MATCH = 0.3 // …if it sounds at least this alike. Otherwise they're someone who said little.
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

/**
 * Average-linkage grouping of voiceprints: repeatedly joins the two groups
 * whose members are most alike on average, while that's at least CUT.
 * Returns a group index per input.
 */
function groupVoices(vectors: number[][], cut = CUT): number[] {
  const n = vectors.length
  const sim: number[][] = vectors.map((a) => vectors.map((b) => cosine(a, b)))
  const size = new Array<number>(n).fill(1)
  const alive = new Array<boolean>(n).fill(true)
  const owner = vectors.map((_, i) => i)
  for (;;) {
    let bi = -1
    let bj = -1
    let best = cut
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue
      for (let j = i + 1; j < n; j++) if (alive[j] && sim[i][j] >= best) [bi, bj, best] = [i, j, sim[i][j]]
    }
    if (bi < 0) break
    // Lance-Williams update: the new group's average similarity to every other group.
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue
      const v = (sim[bi][k] * size[bi] + sim[bj][k] * size[bj]) / (size[bi] + size[bj])
      sim[bi][k] = v
      sim[k][bi] = v
    }
    size[bi] += size[bj]
    alive[bj] = false
    for (let k = 0; k < n; k++) if (owner[k] === bj) owner[k] = bi
  }
  return owner
}

/** How many groups have enough speech to be a person. */
function people(seconds: number[]): number {
  return seconds.filter((s) => s >= SUBSTANTIAL).length
}

/**
 * Groups windows, trying stricter cuts when fewer voices than expected come
 * out. Without an expected count, just the normal cut.
 */
function groupWithHint(vectors: number[][], lengths: number[], expected?: number): number[] {
  let group: number[] = []
  for (const cut of expected ? CUTS : [CUT]) {
    group = groupVoices(vectors, cut)
    const seconds = new Map<number, number>()
    group.forEach((g, i) => seconds.set(g, (seconds.get(g) ?? 0) + lengths[i]))
    if (!expected || people([...seconds.values()]) >= expected) break
  }
  return group
}

/**
 * Merges clusters that are the same voice, then folds tiny ones into their
 * nearest. With an expected head count, alike clusters stop merging once
 * there are that many people, unless they're near-identical.
 */
function consolidate(clusters: SpeakerCluster[], expected?: number): SpeakerCluster[] {
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
        const enough = !!expected && people(list.map((c) => c.seconds)) <= expected
        if (score >= (enough ? SAME : MERGE) && (!best || score > best.score)) best = { i, j, score }
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
    const kept: SpeakerCluster[] = []
    for (const small of list.filter((c) => c.seconds < TINY)) {
      let k = 0
      for (let i = 1; i < big.length; i++) if (cosine(small.embedding, big[i].embedding) > cosine(small.embedding, big[k].embedding)) k = i
      if (cosine(small.embedding, big[k].embedding) >= TINY_MATCH) big[k] = join(big[k], small)
      else kept.push(small)
    }
    list = [...big, ...kept]
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

    // Turns are found block by block, but voices are grouped over the whole
    // call at once: grouping per block and joining blocks afterwards merged two
    // similar voices that each block had told apart.
    type Span = { start: number; end: number }
    const windows: Array<{ segs: Span[]; seconds: number; v: number[] }> = []
    const short: Span[][] = []
    for (const pieces of layout(spans)) {
      const audio = audioFor(fd, pieces)
      const found: Span[] = diarizer.process(audio)
      // Cut turns into windows and take a voiceprint of each.
      for (const f of found) {
        const len = f.end - f.start
        if (len < MIN_WINDOW) {
          const segs = toRecordingTime(pieces, f.start, f.end)
          if (segs.length) short.push(segs)
          continue
        }
        const count = Math.max(1, Math.round(len / WINDOW))
        const w = len / count
        for (let k = 0; k < count; k++) {
          const start = f.start + k * w
          const segs = toRecordingTime(pieces, start, start + w)
          if (!segs.length) continue
          const stream = extractor.createStream()
          stream.acceptWaveform({ sampleRate: RATE, samples: audio.slice(Math.round(start * RATE), Math.round((start + w) * RATE)) })
          stream.inputFinished()
          windows.push({ segs, seconds: w, v: Array.from(extractor.compute(stream, false) as Float32Array) })
        }
      }
    }
    if (!windows.length) return []
    const group = groupWithHint(windows.map((w) => w.v), windows.map((w) => w.seconds), req.expected)
    // Turns too short for a voiceprint go with the nearest window in time.
    const nearest = (segs: Span[]) => {
      const s = { start: segs[0].start, end: segs[segs.length - 1].end }
      let k = 0
      let gap = Infinity
      windows.forEach((w, i) => {
        const ws = w.segs[0].start
        const we = w.segs[w.segs.length - 1].end
        const d = we < s.start ? s.start - we : ws > s.end ? ws - s.end : 0
        if (d < gap) [gap, k] = [d, i]
      })
      return group[k]
    }
    const byId = new Map<number, Span[]>()
    const add = (id: number, segs: Span[]) => {
      const list = byId.get(id) ?? []
      list.push(...segs)
      byId.set(id, list)
    }
    windows.forEach((w, i) => add(group[i], w.segs))
    for (const segs of short) add(nearest(segs), segs)
    const clusters: SpeakerCluster[] = []
    for (const segments of byId.values()) {
      segments.sort((a, b) => a.start - b.start)
      const seconds = segments.reduce((t, s) => t + s.end - s.start, 0)
      if (seconds < 0.5) continue
      clusters.push({ segments, seconds, embedding: embeddingOf(segments) })
    }
    return consolidate(clusters, req.expected)
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
