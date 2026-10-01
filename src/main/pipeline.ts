import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Meeting } from '@shared/types'
import { syncToObsidian } from './obsidian'
import type { Track } from './recorder'
import { redact } from './redact'
import * as store from './store'
import { summarize, summaryMarkdown } from './summarizer'
import { transcribe } from './transcriber'

const GENERIC_TITLE = /^(new note|teams meeting|slack huddle|zoom meeting|ringcentral call|browser call)$/i

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
  try {
    let transcript = store.readTranscript(id)
    const tracks = audioTracks(id)

    if (transcript.length === 0 && tracks.length > 0) {
      set({ status: 'transcribing', error: undefined })
      ev.progress(id, 0)
      transcript = (await transcribe(tracks, (p) => ev.progress(id, p))).map((s) => ({ ...s, text: redact(s.text) }))
      store.writeTranscript(id, transcript)
      ev.progress(id, null)
    }

    let meeting = store.getMeeting(id)!
    if (transcript.length > 0) {
      set({ status: 'summarizing', error: undefined })
      const notes = store.readNote(id)
      const s = await summarize(
        {
          title: meeting.title,
          meetingDate: new Date(meeting.recordingStartedAt ?? meeting.createdAt),
          myName: store.getSettings().myName
        },
        notes,
        transcript
      )
      // Re-read: the user may have typed while Claude was working.
      const latest = store.readNote(id).trim()
      const mine = latest ? `## Your notes\n\n${latest}\n` : ''
      store.writeNote(id, `${summaryMarkdown(s, latest)}\n${mine}`)
      meeting = store.getMeeting(id)!
      set({
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
    ev.progress(id, null)
    // Audio is kept on failure so Retry can pick up where this left off.
    set({ status: 'failed', error: (e as Error).message })
  }
}
