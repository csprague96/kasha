import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { applyVocabulary } from '@shared/text'
import { GENERIC_TITLE, type Meeting } from '@shared/types'
import { takeLive } from './live'
import { syncToObsidian } from './obsidian'
import type { Track } from './recorder'
import { redact } from './redact'
import { speakersReady } from './setup'
import { separateSpeakers } from './speakers'
import { whisperPrompt } from './speech'
import * as store from './store'
import { carryChecks, speakerGuesses, splitNote, summarize, summaryMarkdown } from './summarizer'
import { finalize, transcribe } from './transcriber'


export interface PipelineEvents {
  changed(id: string): void
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

async function run(id: string, ev: PipelineEvents): Promise<void> {
  const set = (patch: Partial<Meeting>) => {
    const m = store.updateMeeting(id, patch)
    ev.changed(id)
    return m
  }
  const live = takeLive(id)
  try {
    let transcript = store.readTranscript(id)
    const tracks = audioTracks(id)

    if (transcript.length === 0 && tracks.length > 0) {
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

      // Tell the people on the computer's audio apart, and name voices known from past meetings.
      const sys = tracks.find((t) => t.track === 'sys')
      if (sys && store.getSettings().speakers.separate && speakersReady() && transcript.some((s) => s.speaker === 'others')) {
        set({ status: 'separating' })
        try {
          const r = await separateSpeakers(id, sys.file, transcript)
          transcript = r.transcript
          store.writeTranscript(id, transcript)
          const m = store.getMeeting(id)!
          set({ speakers: { ...r.names, ...m.speakers } })
        } catch (e) {
          // Not worth failing the meeting over: everyone stays "Others".
          console.error('speakers:', (e as Error).message)
        }
      }
    } else {
      live?.stop()
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
          attendees: meeting.attendees
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
      set({
        speakers: { ...meeting.speakers, ...names },
        speakerGuesses: { ...meeting.speakerGuesses, ...guesses },
        summaryEngine: s.engine,
        summaryOutdated: false,
        title: s.title && GENERIC_TITLE.test(meeting.title) ? s.title : meeting.title,
        tags: Array.from(new Set([...meeting.tags, ...s.tags]))
      })
    }

    meeting = set({ status: 'ready', error: undefined })
    const settings = store.getSettings()
    if (settings.obsidian.syncOnEnd && settings.obsidian.vault) {
      meeting = set({
        sync: syncToObsidian(meeting, store.readNote(id), transcript, settings.obsidian)
      })
    }
    if (!settings.keepAudio) rmSync(join(store.paths.meeting(id), 'audio'), { recursive: true, force: true })
    ev.done(meeting)
  } catch (e) {
    live?.stop()
    ev.progress(id, null)
    // Audio is kept on failure so Retry can pick up where this left off.
    set({ status: 'failed', error: (e as Error).message })
  }
}
