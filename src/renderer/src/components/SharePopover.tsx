import { Copy, FileDown, FileText, Mail, Share2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Meeting, ShareOptions } from '@shared/types'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

type Kind = 'copy' | 'email' | 'pdf' | 'markdown'

const DONE: Record<Kind, string> = {
  copy: 'Copied',
  email: 'Copied. Paste into the email.',
  pdf: 'Saved',
  markdown: 'Saved'
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 px-2 py-1.5 has-[:disabled]:opacity-50">
      <input
        type="checkbox"
        className="size-4 accent-[var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

function Item({ icon, children, onClick, disabled }: { icon: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5 disabled:opacity-50 [&_svg]:size-4 [&_svg]:text-muted"
    >
      {icon}
      {children}
    </button>
  )
}

export function SharePopover({ meeting, hasTranscript }: { meeting: Meeting; hasTranscript: boolean }) {
  // Summary only by default, so full transcripts aren't forwarded by accident.
  const [opts, setOpts] = useState<ShareOptions>({ summary: true, transcript: false })
  const [status, setStatus] = useState<{ kind: Kind; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (kind: Kind) => {
    setBusy(true)
    setStatus(null)
    try {
      const fn = {
        copy: window.kasha.shareCopy,
        email: window.kasha.shareEmail,
        pdf: window.kasha.sharePdf,
        markdown: window.kasha.shareMarkdown
      }[kind]
      const result = await fn(meeting.id, opts)
      if (result !== false) setStatus({ kind, text: DONE[kind] })
    } catch {
      setStatus({ kind, text: 'That didn’t work. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const nothing = !opts.summary && !(opts.transcript && hasTranscript)

  return (
    <Popover onOpenChange={(open) => !open && setStatus(null)}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <Share2 />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="px-2 pt-1.5 pb-0.5 text-xs text-muted">Include</div>
        <Check label="Summary and notes" checked={opts.summary} onChange={(v) => setOpts((o) => ({ ...o, summary: v }))} />
        <Check
          label="Transcript"
          checked={opts.transcript && hasTranscript}
          disabled={!hasTranscript}
          onChange={(v) => setOpts((o) => ({ ...o, transcript: v }))}
        />
        <div className="my-1 border-t border-border" />
        <Item icon={<Copy />} onClick={() => void run('copy')} disabled={busy || nothing}>
          Copy
        </Item>
        <Item icon={<Mail />} onClick={() => void run('email')} disabled={busy || nothing}>
          Email
        </Item>
        <Item icon={<FileText />} onClick={() => void run('pdf')} disabled={busy || nothing}>
          Save as PDF
        </Item>
        <Item icon={<FileDown />} onClick={() => void run('markdown')} disabled={busy || nothing}>
          Save as Markdown
        </Item>
        {status && (
          <p role="status" className="px-2 pt-1 pb-1.5 text-xs text-muted">
            {status.text}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
