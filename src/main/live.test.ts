import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '@shared/types'

// Speech detection and transcription are faked; chunking (addSpeech, takeChunk) is real.
const detect = vi.fn()
const transcribe = vi.fn()
vi.mock('./speech', async (importOriginal) => {
  const real = await importOriginal<typeof import('./speech')>()
  return { ...real, detectSpeech: (...a: unknown[]) => detect(...a), transcribeChunk: (...a: unknown[]) => transcribe(...a) }
})
vi.mock('./log', () => ({ log: () => undefined }))
const { LiveTranscriber } = await import('./live')

const line = (text: string): TranscriptSegment => ({ start: 1, end: 4, speaker: 'others', text })
const make = () => {
  const live = new LiveTranscriber('C:/nowhere', '', () => undefined, () => false, () => undefined)
  live.wrote('sys', 16000 * 2 * 10) // ten seconds of audio
  return live
}

beforeEach(() => {
  detect.mockReset().mockResolvedValue([{ start: 1, end: 4 }])
  transcribe.mockReset()
})

describe('LiveTranscriber.finish', () => {
  it('retries a chunk that fails once', async () => {
    transcribe.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce([line('hello')])
    const out = await make().finish(() => undefined, 2)
    expect(out?.map((s) => s.text)).toEqual(['hello'])
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('tries a chunk that kept failing once more at the end', async () => {
    transcribe.mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValueOnce([line('late')])
    const out = await make().finish(() => undefined, 2)
    expect(out?.map((s) => s.text)).toEqual(['late'])
  })

  it('stops live work after three chunks fail in a row', async () => {
    detect.mockResolvedValue([{ start: 0.5, end: 25 }, { start: 26, end: 50 }, { start: 51, end: 75 }, { start: 76, end: 99 }])
    transcribe.mockRejectedValue(new Error('broken'))
    const live = new LiveTranscriber('C:/nowhere', '', () => undefined, () => false, () => undefined)
    live.wrote('sys', 16000 * 2 * 100)
    expect(await live.finish(() => undefined, 2)).toBeNull()
    // Two tries each for the first three chunks, then nothing more.
    expect(transcribe.mock.calls.length).toBe(6)
  })

  it('falls back to transcribing from scratch only when a chunk never works', async () => {
    transcribe.mockRejectedValue(new Error('broken'))
    expect(await make().finish(() => undefined, 2)).toBeNull()
  })

  it('finishes with the threads it is given', async () => {
    transcribe.mockResolvedValue([line('x')])
    await make().finish(() => undefined, 6)
    expect(transcribe.mock.calls[0][3]).toMatchObject({ threads: 6 })
  })

  it('after the call, waits on a pause and runs as background work', async () => {
    transcribe.mockResolvedValue([line('x')])
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const hold = { wait: vi.fn(() => gate), lowest: () => true }
    let threads = 2
    const done = make().finish(() => undefined, () => threads, hold)
    await new Promise((r) => setTimeout(r, 0))
    expect(transcribe).not.toHaveBeenCalled()
    threads = 1
    release()
    expect((await done)?.map((s) => s.text)).toEqual(['x'])
    expect(hold.wait).toHaveBeenCalled()
    expect(transcribe.mock.calls[0][3]).toMatchObject({ threads: 1, background: true, lowest: true })
  })

  it('a speech-detection failure at the end means transcribing from scratch', async () => {
    detect.mockRejectedValue(new Error('vad'))
    expect(await make().finish(() => undefined, 2)).toBeNull()
  })
})
