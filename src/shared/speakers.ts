import type { SpeakerId, TranscriptSegment } from './types'

/** Where each of a speaker's turns starts: the first line of every run of lines they said. */
export function speakerTurns(segs: TranscriptSegment[], id: SpeakerId): number[] {
  const out: number[] = []
  segs.forEach((s, i) => {
    if (s.speaker === id && (i === 0 || segs[i - 1].speaker !== id)) out.push(i)
  })
  return out
}

/** Gives a speaker's lines to someone else, so that speaker is gone from the transcript. */
export function removeSpeaker(segs: TranscriptSegment[], id: SpeakerId, into: SpeakerId): TranscriptSegment[] {
  return segs.map((s) => (s.speaker === id ? { ...s, speaker: into } : s))
}

/**
 * Speakers an edit left with no lines. You is never one: the mic track is
 * always the user, whoever their lines were given to.
 */
export function goneSpeakers(before: TranscriptSegment[], after: TranscriptSegment[]): SpeakerId[] {
  if (!after.length) return []
  const left = new Set(after.map((s) => s.speaker))
  return [...new Set(before.map((s) => s.speaker))].filter((k) => k !== 'you' && !left.has(k))
}
