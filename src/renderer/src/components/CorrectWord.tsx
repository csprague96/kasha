import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'

export interface WordAt {
  word: string
  x: number
  y: number
}

/**
 * The word under the pointer, for a right-click. Expands from the caret
 * position to the surrounding letters, digits, apostrophes and hyphens.
 */
export function wordAtPoint(x: number, y: number, within?: HTMLElement): string | null {
  const range = document.caretRangeFromPoint(x, y)
  const node = range?.startContainer
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return null
  if (within && !within.contains(node)) return null
  const text = node.textContent ?? ''
  const isWord = (c: string) => /[\p{L}\p{N}'’-]/u.test(c)
  let a = range.startOffset
  let b = a
  while (a > 0 && isWord(text[a - 1])) a--
  while (b < text.length && isWord(text[b])) b++
  const word = text.slice(a, b).replace(/^['’-]+|['’-]+$/g, '')
  return /[\p{L}\p{N}]/u.test(word) ? word : null
}

/**
 * Right-click on a word: type how it should be spelled, and it's replaced
 * throughout the transcript and note. With "future meetings" on, the pair
 * goes into Names and terms so the next transcript gets it right.
 */
export function CorrectWord({
  meetingId,
  at,
  canReplace,
  onClose,
  onDone
}: {
  meetingId: string
  at: WordAt
  canReplace: boolean
  onClose: () => void
  onDone: (result: string) => void
}) {
  const [value, setValue] = useState(at.word)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const to = value.trim()
  const changed = !!to && to !== at.word
  const run = async () => {
    if (!changed || !canReplace) return
    setBusy(true)
    try {
      const r = await window.kasha.replaceText(meetingId, at.word, to, { matchCase: false, notes: true, remember })
      const n = r.transcript + r.notes
      onDone(`Replaced ${n} ${n === 1 ? 'place' : 'places'}.${remember ? ` Future transcripts will say “${to}”.` : ''}`)
    } finally {
      setBusy(false)
    }
  }

  // Keep the box on screen.
  const width = 300
  const left = Math.min(at.x, window.innerWidth - width - 12)
  const top = Math.min(at.y + 4, window.innerHeight - 150)
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Correct “${at.word}”`}
      style={{ position: 'fixed', left, top, width }}
      className="z-50 flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3 text-[13px] shadow-[0_2px_8px_rgba(0,0,0,0.12)]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">Heard as</span>
        <span className="truncate font-medium">{at.word}</span>
      </div>
      <Input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void run()}
        aria-label="Correct spelling"
        placeholder="Correct spelling"
        className="h-8"
        disabled={!canReplace}
      />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" className="size-3.5 accent-[var(--primary)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Fix in future meetings too
      </label>
      {canReplace ? (
        <Button size="sm" variant="primary" disabled={!changed || busy} onClick={() => void run()}>
          Replace everywhere in this note
        </Button>
      ) : (
        <span className="text-xs text-muted">You can correct words once the transcript is finished.</span>
      )}
    </div>
  )
}
