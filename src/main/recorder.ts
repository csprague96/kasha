import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const SAMPLE_RATE = 16000

/** Streams 16-bit mono PCM to a WAV file. Header sizes are patched on close. */
class WavWriter {
  private fd: number
  private bytes = 0

  constructor(readonly file: string) {
    this.fd = openSync(file, 'w')
    writeSync(this.fd, header(0))
  }

  write(pcm: Buffer): void {
    writeSync(this.fd, pcm)
    this.bytes += pcm.length
  }

  close(): number {
    writeSync(this.fd, header(this.bytes), 0, 44, 0)
    closeSync(this.fd)
    return this.bytes
  }
}

function header(dataBytes: number): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16) // PCM chunk size
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(SAMPLE_RATE, 24)
  b.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  b.writeUInt16LE(2, 32) // block align
  b.writeUInt16LE(16, 34) // bits per sample
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}

export type Track = 'mic' | 'sys'

/** One recording session: your mic and the computer's audio as separate tracks. */
export class Recording {
  private writers: Partial<Record<Track, WavWriter>> = {}
  readonly dir: string

  constructor(meetingDir: string) {
    this.dir = join(meetingDir, 'audio')
    mkdirSync(this.dir, { recursive: true })
  }

  write(track: Track, pcm: Buffer): void {
    let w = this.writers[track]
    if (!w) w = this.writers[track] = new WavWriter(join(this.dir, `${track}.wav`))
    w.write(pcm)
  }

  /** Closes files and returns the tracks that captured any audio. */
  close(): Array<{ track: Track; file: string }> {
    const out: Array<{ track: Track; file: string }> = []
    for (const track of ['sys', 'mic'] as Track[]) {
      const w = this.writers[track]
      if (w && w.close() > 0) out.push({ track, file: w.file })
    }
    this.writers = {}
    return out
  }
}
