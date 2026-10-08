import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { applyVocabulary } from '@shared/text'
import { GENERIC_TITLE, type Meeting, type SpeakerId, type TranscriptSegment } from '@shared/types'
import { takeLive } from './live'
import { log } from './log'
import { exportOptions, syncToObsidian } from './obsidian'
import type { Track } from './recorder'
import { redact } from './redact'
import { speakersReady } from './setup'
import { namesFromRoster, participants, readRoster, resolveAttendees, selfName } from './roster'
import { separateSpeakers, type SeparateResult } from './speakers'
import { whisperPrompt } from './speech'
import * as store from './store'
import { carryChecks, speakerGuesses, splitNote, summarize, summaryMarkdown } from './summarizer'
import { finalize, transcribe } from './transcriber'


export interface PipelineEvents {
  changed(id: string): void
  /** Settings changed here (the note taker's name, learned from Teams). */
  settingsChanged(): void
  progress(id: string, p: number | null): void
  done(m: Meeting): void
}

let queue: Promise<void> = Promise.resolve()

/** Processing runs one meeting at a time so back-to-back calls don't stack CPU load. */
export function enqueue(id: string, events: PipelineEvents): void {
  queue = queue.then(() => run(id, events)).catch(() => undefined)
}

/** Fixes names and terms from Settings, then removes card numbers and SSNs (PCI). */
export function cleanText(text: string): string {
  return redact(applyVocabulary(text, store.getSettings().vocabulary))
}

function audioTracks(id: string): Array<{ track: Track; file: string }> {
  const dir = join(store.paths.meeting(id), 'audio')
  return (['sys', 'mic'] as Track[])
    .map((track) => ({ track, file: join(dir, `${track}.wav`) }))
    .filter((t) => existsSync(t.file))
}

type Setter = (patch: Partial<Meeting>) => Meeting

/**
 * Works out who's who: who Teams showed in the call, the voices on the
 * computer's audio told apart, and names for them. Every name found here is a
 * guess ("Name?") the user confirms with one click; a voice is only learned
 * once they do. The order is: names the user gave, then Teams, then voices
 * that sound like someone named before (only people in the call or invited).
 */
async function identify(
  id: string,
  transcript: TranscriptSegment[],
  tracks: Array<{ track: Track; file: string }>,
  set: Setter,
  secs: () => number,
  onSettings: () => void
): Promise<TranscriptSegment[]> {
  let m = store.getMeeting(id)!
  const timeline = readRoster(id)

  // Who the Teams window showed (roster.ts).
  if (timeline.length && !m.participants?.length) {
    const self = selfName(timeline)
    // How the note taker is named, if they haven't said: Teams knows. Only a
    // full name, so a misread tile can't make a single word "you".
    if (self && self.trim().split(/ +/).length >= 2 && !store.getSettings().myName.trim()) {
      store.setSettings({ myName: self })
      onSettings()
      log('my-name-from-teams')
    }
    const myName = store.getSettings().myName
    const people = participants(timeline, myName)
    if (people.length) {
      // Invitees the calendar gave only as addresses get the names Teams showed.
      const invited = m.attendees ?? []
      const me = self ? { name: self, as: myName.trim() || self } : undefined
      m = set({ participants: people, ...(invited.length ? { attendees: resolveAttendees(invited, people, me) } : {}) })
    }
  }
  const people = m.participants ?? []

  // Tell the people on the computer's audio apart, unless that's done already.
  const sys = tracks.find((t) => t.track === 'sys')
  const split = transcript.some((s) => /^s\d+$/.test(s.speaker))
  let matches: SeparateResult['matches'] = {}
  if (sys && !split && !m.speakers?.others && store.getSettings().speakers.separate && speakersReady() && transcript.some((s) => s.speaker === 'others')) {
    set({ status: 'separating' })
    try {
      // The invite (less the note taker) says how many voices to look for;
      // Teams says how many people there were at most. Everyone invited or
      // seen is who a known voice may be.
      const invited = m.attendees ?? []
      const r = await separateSpeakers(id, sys.file, transcript, {
        expected: invited.length >= 2 ? Math.min(invited.length - 1, 8) : undefined,
        max: people.length || undefined,
        candidates: people.length || invited.length ? [...people, ...invited] : undefined
      })
      transcript = r.transcript
      matches = r.matches
      store.writeTranscript(id, transcript)
      const talk = new Map<string, number>()
      for (const s of transcript) if (s.speaker !== 'you') talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + s.end - s.start)
      log('speakers', {
        found: talk.size,
        substantial: [...talk.values()].filter((t) => t >= 20).length,
        inCall: people.length || undefined,
        capped: r.capped.length || undefined,
        matched: Object.keys(matches).length,
        secs: secs()
      })
    } catch (e) {
      // Not worth failing the meeting over: everyone stays "Others".
      console.error('speakers:', (e as Error).message)
      log('speakers-failed', { error: (e as Error).message.slice(0, 200) })
    }
  }

  // Names to confirm, from Teams first, then from known voices.
  m = store.getMeeting(id)!
  const fromTeams = timeline.length ? namesFromRoster(timeline, transcript, m.speakers, store.getSettings().myName) : { guesses: {}, guessNames: {} }
  const guessNames: NonNullable<Meeting['speakers']> = { ...fromTeams.guessNames }
  const guesses: NonNullable<Meeting['speakerGuesses']> = { ...fromTeams.guesses }
  for (const [sid, hit] of Object.entries(matches) as Array<[SpeakerId, { name: string; score: number }]>) {
    if (m.speakers?.[sid]?.trim() || guessNames[sid]) continue
    guessNames[sid] = hit.name
    guesses[sid] = { evidence: `Sounds like ${hit.name} from an earlier meeting (voice match ${hit.score.toFixed(2)}).` }
  }
  log('named', { fromTeams: Object.keys(fromTeams.guesses).length, fromVoices: Object.keys(guesses).length - Object.keys(fromTeams.guesses).length })
  set({ speakers: { ...guessNames, ...m.speakers }, speakerGuesses: { ...m.speakerGuesses, ...guesses }, separated: true })
  return transcript
}

async function run(id: string, ev: PipelineEvents): Promise<void> {
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const set = (patch: Partial<Meeting>) => {
    const m = store.updateMeeting(id, patch)
    ev.changed(id)
    return m
  }
  const live = takeLive(id)
  const wasStatus = store.getMeeting(id)?.status
  try {
    let transcript = store.readTranscript(id)
    const tracks = audioTracks(id)
    const fresh = transcript.length === 0 && tracks.length > 0

    if (fresh) {
      set({ status: 'transcribing', error: undefined })
      ev.progress(id, 0)
      const progress = (p: number) => ev.progress(id, p)
      // Live transcription usually has everything but the last few seconds done.
      // If it failed, the recorded files are transcribed from the start.
      const fromLive = live ? await live.finish(progress) : null
      const segs = fromLive
        ? finalize(tracks, fromLive)
        : await transcribe(tracks, whisperPrompt(store.getSettings()), progress)
      transcript = segs.map((s) => ({ ...s, text: cleanText(s.text) }))
      store.writeTranscript(id, transcript)
      ev.progress(id, null)
      log('transcribed', { lines: transcript.length, fromLive: !!fromLive, secs: secs() })
    } else {
      live?.stop()
    }

    // Who's who, once per meeting: after transcribing, or when a crash or
    // quit stopped it part way (the meeting was left 'separating'), or on
    // Retry after a failure. Not on "Update summary": that would bring back
    // guesses the user turned down.
    const cur = store.getMeeting(id)
    // Notes processed before this step existed: already split or named, so not again.
    const before = !fresh && (transcript.some((s) => /^s\d+$/.test(s.speaker)) || Object.keys(cur?.speakers ?? {}).length > 0)
    if (transcript.length && !cur?.separated && !before && (fresh || wasStatus === 'separating' || wasStatus === 'failed')) {
      transcript = await identify(id, transcript, tracks, set, secs, () => ev.settingsChanged())
    }

    let meeting = store.getMeeting(id)!
    if (transcript.length > 0) {
      set({ status: 'summarizing', error: undefined })
      // Only the user's own notes: a summary Kasha wrote earlier is rewritten, not summarized.
      const s = await summarize(
        {
          title: meeting.title,
          meetingDate: new Date(meeting.recordingStartedAt ?? meeting.createdAt),
          myName: store.getSettings().myName,
          speakers: meeting.speakers,
          guessed: Object.keys(meeting.speakerGuesses ?? {}) as SpeakerId[],
          attendees: meeting.attendees,
          participants: meeting.participants
        },
        splitNote(store.readNote(id)).user,
        transcript,
        store.getSettings().summaryEngine
      )
      // Re-read: the user may have typed while Claude was working.
      const current = splitNote(store.readNote(id))
      const latest = current.user.trim()
      const mine = latest ? `## Your notes\n\n${latest}\n` : ''
      store.writeNote(id, `${carryChecks(current.generated, summaryMarkdown(s, latest))}\n${mine}`)
      meeting = store.getMeeting(id)!
      // Names worked out from the conversation are shown as guesses until confirmed.
      // They aren't learned as voices until then.
      const { names, guesses } = speakerGuesses(s, transcript, meeting.speakers)
      // The summary may give only a first name. When exactly one person in the
      // call or invite has it, offer their full name (Kasha's own list, not the model's).
      const known = [...(meeting.participants ?? []), ...(meeting.attendees ?? [])].filter((n) => !n.includes('@'))
      for (const [sid, n] of Object.entries(names) as Array<[SpeakerId, string]>) {
        if (!n || /\s/.test(n.trim())) continue
        const first = n.trim().toLowerCase()
        const full = [...new Set(known.filter((k) => k.trim().toLowerCase().split(/\s+/)[0] === first))]
        if (full.length === 1) names[sid] = full[0]
      }
      log('summarized', { engine: s.engine, guessedNames: Object.keys(guesses).length, secs: secs() })
      set({
        speakers: { ...meeting.speakers, ...names },
        speakerGuesses: { ...meeting.speakerGuesses, ...guesses },
        summaryEngine: s.engine,
        summaryOutdated: false,
        title: s.title && GENERIC_TITLE.test(meeting.title) ? s.title : meeting.title,
        tags: Array.from(new Set([...meeting.tags, ...(store.getSettings().tags.fromSummary ? s.tags : [])]))
      })
    }

    meeting = set({ status: 'ready', error: undefined })
    const settings = store.getSettings()
    if (settings.obsidian.syncOnEnd && settings.obsidian.vault) {
      meeting = set({
        sync: syncToObsidian(meeting, store.readNote(id), transcript, exportOptions(settings))
      })
    }
    if (!settings.keepAudio) rmSync(join(store.paths.meeting(id), 'audio'), { recursive: true, force: true })
    ev.done(meeting)
  } catch (e) {
    live?.stop()
    ev.progress(id, null)
    log('processing-failed', { error: (e as Error).message.slice(0, 200), secs: secs() })
    // Audio is kept on failure so Retry can pick up where this left off.
    set({ status: 'failed', error: (e as Error).message })
  }
}
