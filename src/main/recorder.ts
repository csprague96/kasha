import { closeSync, existsSync, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const SAMPLE_RATE = 16000
const BYTES_PER_SEC = SAMPLE_RATE * 2
// The header is rewritten this often, so a crash leaves a file that still says how long it is.
const PATCH_EVERY = 10 * BYTES_PER_SEC

/** Streams 16-bit mono PCM to a WAV file. Header sizes are patched as it goes and on close. */
class WavWriter {
  private fd: number
  private bytes = 0
  private patched = 0

  /** With `append`, carries on an existing file (after a crash or a capture restart). */
  constructor(
    readonly file: string,
    append = false
  ) {
    if (append && existsSync(file)) {
      this.fd = openSync(file, 'r+')
      const size = fstatSync(this.fd).size
      this.bytes = Math.max(0, size - 44)
      this.bytes -= this.bytes % 2
      this.patch()
    } else {
      this.fd = openSync(file, 'w')
      writeSync(this.fd, wavHeader(0))
    }
  }

  get length(): number {
    return this.bytes
  }

  write(pcm: Buffer): void {
    writeSync(this.fd, pcm, 0, pcm.length, 44 + this.bytes)
    this.bytes += pcm.length
    if (this.bytes - this.patched >= PATCH_EVERY) this.patch()
  }

  private patch(): void {
    writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0)
    this.patched = this.bytes
  }

  close(): number {
    this.patch()
    closeSync(this.fd)
    return this.bytes
  }
}

export function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16) // PCM chunk size
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(SAMPLE_RATE, 24)
  b.writeUInt32LE(BYTES_PER_SEC, 28) // byte rate
  b.writeUInt16LE(2, 32) // block align
  b.writeUInt16LE(16, 34) // bits per sample
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}

/** Sets a WAV's sizes from its length on disk, for a file left open by a crash. */
export function repairWav(file: string): void {
  if (!existsSync(file)) return
  new WavWriter(file, true).close()
}

export type Track = 'mic' | 'sys'
const TRACKS: Track[] = ['sys', 'mic']

/** One recording session: your mic and the computer's audio as separate tracks. */
export class Recording {
  private writers: Partial<Record<Track, WavWriter>> = {}
  readonly dir: string

  /** With `resume`, carries on the tracks already in the folder instead of starting over. */
  constructor(meetingDir: string, resume = false) {
    this.dir = join(meetingDir, 'audio')
    mkdirSync(this.dir, { recursive: true })
    if (resume) {
      for (const track of TRACKS) {
        const file = join(this.dir, `${track}.wav`)
        if (existsSync(file)) this.writers[track] = new WavWriter(file, true)
      }
    }
  }

  write(track: Track, pcm: Buffer): void {
    let w = this.writers[track]
    if (!w) w = this.writers[track] = new WavWriter(join(this.dir, `${track}.wav`))
    w.write(pcm)
  }

  /** Bytes in each track so far. */
  lengths(): Partial<Record<Track, number>> {
    const out: Partial<Record<Track, number>> = {}
    for (const track of TRACKS) if (this.writers[track]) out[track] = this.writers[track]!.length
    return out
  }

  /**
   * Fills the tracks with silence up to `seconds` in, after capture was cut
   * off (a crash, or the capture window restarting). Lines stay at the time
   * they were said and the two tracks stay in step. Gaps under 2 s are left:
   * capture always starts a moment after the clock does. Returns the bytes
   * added to each track.
   */
  padTo(seconds: number): Partial<Record<Track, number>> {
    const want = Math.floor(seconds * SAMPLE_RATE) * 2
    const added: Partial<Record<Track, number>> = {}
    for (const track of TRACKS) {
      const w = this.writers[track]
      if (!w || want - w.length < 2 * BYTES_PER_SEC) continue
      const gap = want - w.length
      const block = Buffer.alloc(Math.min(gap, 60 * BYTES_PER_SEC))
      for (let left = gap; left > 0; left -= block.length) w.write(left >= block.length ? block : block.subarray(0, left))
      added[track] = gap
    }
    return added
  }

  /** Closes files and returns the tracks that captured any audio. */
  close(): Array<{ track: Track; file: string }> {
    const out: Array<{ track: Track; file: string }> = []
    for (const track of TRACKS) {
      const w = this.writers[track]
      if (w && w.close() > 0) out.push({ track, file: w.file })
    }
    this.writers = {}
    return out
  }
}
