import { useCallback, useEffect, useState } from 'react'
import type { ActionGroup, ActionItem, Meeting, RecordingInfo, Settings as SettingsT } from '@shared/types'
import { ActionsView } from './components/ActionsView'
import { NoteView } from './components/NoteView'
import { Settings } from './components/Settings'
import { Setup } from './components/Setup'
import { Sidebar } from './components/Sidebar'

export type View = { kind: 'note'; id: string } | { kind: 'settings' } | { kind: 'actions' } | { kind: 'empty' }

function initialView(): View {
  const hash = location.hash.slice(1)
  if (hash === 'settings') return { kind: 'settings' }
  if (hash === 'actions') return { kind: 'actions' }
  const m = /^meeting=(.+)$/.exec(hash)
  return m ? { kind: 'note', id: m[1] } : { kind: 'empty' }
}

export function App() {
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [recording, setRecording] = useState<RecordingInfo | null>(null)
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [view, setView] = useState<View>(initialView)
  const [actions, setActions] = useState<ActionGroup[]>([])

  const refresh = useCallback(() => void window.kasha.listMeetings().then(setMeetings), [])
  const refreshActions = useCallback(() => void window.kasha.listActions().then(setActions), [])

  useEffect(() => {
    void window.kasha.getSettings().then(setSettings)
    void window.kasha.currentRecording().then(setRecording)
    refresh()
    refreshActions()
    const offs = [
      window.kasha.onMeetingsChanged(refresh),
      window.kasha.onActionsChanged(refreshActions),
      window.kasha.onRecordingChanged((r) => {
        setRecording(r)
        if (r) setView({ kind: 'note', id: r.meetingId })
      }),
      window.kasha.onNavigate((v) =>
        setView(
          v.settings
            ? { kind: 'settings' }
            : v.actions
              ? { kind: 'actions' }
              : v.meetingId
                ? { kind: 'note', id: v.meetingId }
                : { kind: 'empty' }
        )
      ),
      window.kasha.onProgress((id, p) =>
        setProgress((cur) => {
          const next = { ...cur }
          if (p === null) delete next[id]
          else next[id] = p
          return next
        })
      )
    ]
    return () => offs.forEach((off) => off())
  }, [refresh, refreshActions])

  // Open the most recent note when nothing is selected.
  useEffect(() => {
    if (view.kind === 'empty' && meetings.length) setView({ kind: 'note', id: meetings[0].id })
    if (view.kind === 'note' && meetings.length && !meetings.some((m) => m.id === view.id)) {
      setView(meetings[0] ? { kind: 'note', id: meetings[0].id } : { kind: 'empty' })
    }
  }, [meetings, view])

  const updateSettings = async (patch: Partial<SettingsT>) => setSettings(await window.kasha.setSettings(patch))

  if (!settings) return null
  if (!settings.setupComplete) return <Setup settings={settings} onChange={updateSettings} />

  const newNote = async () => {
    const m = await window.kasha.createNote()
    setView({ kind: 'note', id: m.id })
  }

  const current = view.kind === 'note' ? meetings.find((m) => m.id === view.id) : undefined
  const openMine = actions.reduce((n, g) => n + g.items.filter((i) => i.mine && !i.done).length, 0)

  const toggleAction = (item: ActionItem, done: boolean) => {
    // Optimistic: tick immediately, then reload from the notes.
    setActions((gs) =>
      gs.map((g) =>
        g.meeting.id !== item.meetingId ? g : { ...g, items: g.items.map((i) => (i.index === item.index ? { ...i, done } : i)) }
      )
    )
    void window.kasha.setActionDone(item.meetingId, item.index, item.raw, done)
  }

  return (
    <div className="grid h-full grid-cols-[240px_1fr] max-[820px]:grid-cols-[200px_1fr]">
      <Sidebar
        meetings={meetings}
        view={view}
        settings={settings}
        openActions={openMine}
        onSelect={setView}
        onNewNote={newNote}
      />
      <main className="min-w-0 overflow-y-auto">
        {view.kind === 'settings' && <Settings settings={settings} onChange={updateSettings} />}
        {view.kind === 'actions' && (
          <ActionsView groups={actions} onToggle={toggleAction} onOpenMeeting={(id) => setView({ kind: 'note', id })} />
        )}
        {current && (
          <NoteView
            key={current.id}
            meeting={current}
            recording={recording}
            progress={progress[current.id]}
            settings={settings}
          />
        )}
        {view.kind !== 'settings' && view.kind !== 'actions' && !current && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <p>No notes yet. Kasha prompts you when a call starts, or you can start one now.</p>
            <button className="font-medium text-primary hover:underline" onClick={newNote}>
              New note
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
