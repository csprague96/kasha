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

  it('falls back to transcribing from scratch only when a chunk never works', async () => {
    transcribe.mockRejectedValue(new Error('broken'))
    expect(await make().finish(() => undefined, 2)).toBeNull()
  })

  it('finishes with the threads it is given', async () => {
    transcribe.mockResolvedValue([line('x')])
    await make().finish(() => undefined, 6)
    expect(transcribe.mock.calls[0][3]).toMatchObject({ threads: 6 })
  })

  it('a speech-detection failure at the end means transcribing from scratch', async () => {
    detect.mockRejectedValue(new Error('vad'))
    expect(await make().finish(() => undefined, 2)).toBeNull()
  })
})
