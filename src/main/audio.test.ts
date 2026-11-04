import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SAMPLE_RATE, wavHeader } from './recorder'

const root = mkdtempSync(join(tmpdir(), 'kasha-audio-'))
vi.mock('./store', () => ({ paths: { meeting: (id: string) => join(root, id) } }))
vi.mock('./log', () => ({ log: () => undefined }))
const { audioClip, CLIP_MAX_SECONDS } = await import('./audio')

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A track whose every sample is the second it's in, so a clip shows where it was cut from. */
function track(id: string, name: string, seconds: number): void {
  const pcm = Buffer.alloc(seconds * SAMPLE_RATE * 2)
  for (let i = 0; i < seconds * SAMPLE_RATE; i++) pcm.writeInt16LE(Math.floor(i / SAMPLE_RATE), i * 2)
  mkdirSync(join(root, id, 'audio'), { recursive: true })
  writeFileSync(join(root, id, 'audio', `${name}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]))
}

const seconds = (wav: Buffer) => (wav.length - 44) / 2 / SAMPLE_RATE
const firstSecond = (wav: Buffer) => wav.readInt16LE(44)
const lastSecond = (wav: Buffer) => wav.readInt16LE(wav.length - 2)

describe('audioClip', () => {
  track('m1', 'sys', 60)

  it('cuts the line from its track, with a little either side, as a playable WAV', () => {
    const wav = audioClip('m1', 'sys', 10, 12)!
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44)
    expect(firstSecond(wav)).toBe(9)
    expect(lastSecond(wav)).toBe(12)
    expect(seconds(wav)).toBeCloseTo(2.45, 2)
  })

  it('stops at the end of the recording and at the longest clip', () => {
    expect(lastSecond(audioClip('m1', 'sys', 58, 70)!)).toBe(59)
    expect(seconds(audioClip('m1', 'sys', 0, 59)!)).toBeLessThanOrEqual(CLIP_MAX_SECONDS)
  })

  it('is null once the recording is gone, or past its end', () => {
    expect(audioClip('m1', 'mic', 1, 2)).toBeNull()
    expect(audioClip('m2', 'sys', 1, 2)).toBeNull()
    expect(audioClip('m1', 'sys', 80, 82)).toBeNull()
  })
})
