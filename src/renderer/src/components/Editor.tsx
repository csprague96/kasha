import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import { fromEditorMarkdown, toEditorMarkdown } from '@/lib/utils'
import { wordAtPoint, type WordAt } from './CorrectWord'

interface Props {
  meetingId: string
  markdown: string
  /** Bumped when the note was replaced on disk (e.g. summary added) and must reload. */
  version: number
  editable: boolean
  /** Right-click on a word: offer to correct its spelling in the note and transcript. */
  onCorrect?: (at: WordAt) => void
}

const SAVE_DELAY = 400

async function insertImageFile(editor: TiptapEditor, meetingId: string, file: File, pos?: number): Promise<void> {
  const ext = file.type.split('/')[1] ?? 'png'
  const rel = await window.kasha.saveImage(meetingId, await file.arrayBuffer(), ext)
  const node = { type: 'image', attrs: { src: `kasha-file://${meetingId}/${rel}`, alt: 'Image' } }
  if (pos === undefined) editor.chain().focus().insertContent(node).run()
  else editor.chain().focus().insertContentAt(pos, node).run()
}

export function Editor({ meetingId, markdown, version, editable, onCorrect }: Props) {
  const saveTimer = useRef<number | undefined>(undefined)
  const editorRef = useRef<TiptapEditor | null>(null)
  const correctRef = useRef(onCorrect)
  correctRef.current = onCorrect

  const flush = () => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) void window.kasha.saveNote(meetingId, fromEditorMarkdown(meetingId, ed.getMarkdown()))
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ allowBase64: false }),
      Placeholder.configure({ placeholder: 'Write notes. The summary is added above them after the call.' }),
      Markdown
    ],
    content: toEditorMarkdown(meetingId, markdown),
    contentType: 'markdown',
    editable,
    editorProps: {
      attributes: { class: 'focus:outline-none', 'aria-label': 'Notes' },
      handleDOMEvents: {
        contextmenu: (view, event) => {
          const word = correctRef.current && wordAtPoint(event.clientX, event.clientY, view.dom)
          if (!word) return false
          event.preventDefault()
          correctRef.current?.({ word, x: event.clientX, y: event.clientY })
          return true
        }
      },
      handlePaste: (_view, event) => {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'))
        if (!file || !editorRef.current) return false
        void insertImageFile(editorRef.current, meetingId, file)
        return true
      },
      handleDrop: (view, event) => {
        const file = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
        if (!file || !editorRef.current) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertImageFile(editorRef.current, meetingId, file, pos)
        return true
      }
    },
    onUpdate: () => {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(flush, SAVE_DELAY)
    }
  })
  editorRef.current = editor

  // Save anything pending when switching notes or closing the window.
  useEffect(() => {
    const onUnload = () => saveTimer.current !== undefined && flush()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      onUnload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId])

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  // Reload when the note was rewritten by the pipeline.
  useEffect(() => {
    if (!editor || version === 0) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    editor.commands.setContent(toEditorMarkdown(meetingId, markdown), { contentType: 'markdown', emitUpdate: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // Notes and screenshots added from the recording bar land at the end.
  useEffect(
    () =>
      window.kasha.onNoteAppended((id, fragment) => {
        if (id !== meetingId || !editor) return
        editor.commands.insertContentAt(editor.state.doc.content.size, toEditorMarkdown(meetingId, fragment), {
          contentType: 'markdown'
        })
      }),
    [editor, meetingId]
  )

  return <EditorContent editor={editor} className="note-editor" />
}
