import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Recording, repairWav, SAMPLE_RATE } from './recorder'

const dirs: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'kasha-rec-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const header = (file: string) => {
  const b = readFileSync(file)
  return { riff: b.readUInt32LE(4), data: b.readUInt32LE(40), body: b.length - 44 }
}
const second = SAMPLE_RATE * 2

describe('Recording', () => {
  it('lines a track up with the clock only before its first audio', () => {
    const r = new Recording(fresh())
    expect(r.lead('sys', 2.5)).toBe(2.5 * second)
    r.write('sys', Buffer.alloc(second, 1))
    expect(r.lead('sys', 9)).toBe(0) // already started
    expect(r.lead('mic', 0.01)).toBe(0) // too small to matter
    expect(r.lengths()).toEqual({ sys: 3.5 * second })
  })

  it('lines tracks up again after capture restarts', () => {
    const r = new Recording(fresh())
    r.write('mic', Buffer.alloc(5 * second, 1))
    r.realign()
    expect(r.lead('mic', 8)).toBe(3 * second) // up to the clock, from where it was
    expect(r.lead('mic', 9)).toBe(0) // once only
    expect(r.lead('sys', 8)).toBe(8 * second) // a track that never had audio
  })

  it('keeps the WAV header right while recording, and after a crash', () => {
    const d = fresh()
    const r = new Recording(d)
    r.write('mic', Buffer.alloc(12 * second, 1))
    const file = join(d, 'audio', 'mic.wav')
    expect(header(file).data).toBe(12 * second) // patched every 10 s, no close needed
    r.write('mic', Buffer.alloc(second, 1))
    repairWav(file) // as after a crash
    expect(header(file)).toEqual({ riff: 13 * second + 36, data: 13 * second, body: 13 * second })
    r.close()
  })

  it('carries on a cut-off recording and fills the gap with silence', () => {
    const d = fresh()
    const a = new Recording(d)
    a.write('mic', Buffer.alloc(3 * second, 1))
    a.write('sys', Buffer.alloc(1 * second, 1))
    a.close()
    const b = new Recording(d, true)
    expect(b.lengths()).toEqual({ mic: 3 * second, sys: 1 * second })
    expect(b.padTo(10)).toEqual({ mic: 7 * second, sys: 9 * second })
    expect(b.padTo(11)).toEqual({}) // gaps under 2 s are left
    b.close()
    expect(header(join(d, 'audio', 'sys.wav')).data).toBe(10 * second)
  })
})
