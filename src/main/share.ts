import { app, BrowserWindow, clipboard, ClipboardItem, dialog, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Marked } from 'marked'
import { attendance, attendanceSummary } from '@shared/attendance'
import { APP_LABELS, shownName, type Meeting, type ShareOptions, type TranscriptSegment } from '@shared/types'
import { exportFileName } from './obsidian'
import * as store from './store'

const p2 = (n: number) => String(n).padStart(2, '0')

function clock(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${p2(m)}:${p2(Math.floor(s % 60))}` : `${m}:${p2(Math.floor(s % 60))}`
}

function metaLine(m: Meeting): string {
  const d = new Date(m.recordingStartedAt ?? m.createdAt)
  const parts = [d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), `${p2(d.getHours())}:${p2(d.getMinutes())}`]
  if (m.app !== 'manual') parts.push(APP_LABELS[m.app])
  return parts.join(' · ')
}

/** The shareable note as Markdown. Image links stay relative (attachments/x.png). */
export function shareMarkdown(m: Meeting, note: string, transcript: TranscriptSegment[], opts: ShareOptions): string {
  const out = [`# ${m.title}`, '', metaLine(m), '']
  const who = attendanceSummary(attendance(m, transcript, store.getSettings().myName))
  if (who.present.length || who.absent.length) {
    const parts = []
    if (who.present.length) parts.push(`**Attendees:** ${who.present.join(', ')}`)
    if (who.absent.length) parts.push(`**Not heard:** ${who.absent.join(', ')}`)
    out.push(parts.join(' · '), '')
  }
  if (opts.summary) {
    // Readers get "due Tue 6 Oct"; the ISO date is only for Kasha's Actions view.
    const readable = note.replace(/\(due (\d{4})-(\d{2})-(\d{2})\)/g, (_m, y: string, mo: string, d: string) => {
      const date = new Date(Number(y), Number(mo) - 1, Number(d))
      return `(due ${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })})`
    })
    out.push(readable.trim(), '')
  }
  if (opts.transcript && transcript.length) {
    out.push('## Transcript', '')
    for (const t of transcript) out.push(`\`${clock(t.start)}\` **${shownName(t.speaker, m)}:** ${t.text}`, '')
  }
  return out.join('\n').trim() + '\n'
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Markdown to email-safe HTML: inline styles, images embedded, no raw HTML passed through. */
function toHtml(md: string, meetingId: string): string {
  const marked = new Marked({ gfm: true, async: false })
  marked.use({
    renderer: {
      html: ({ text }) => escapeHtml(text),
      codespan: ({ text }) => `<code style="font-family:Consolas,monospace;font-size:12px;color:#5F636A">${text}</code>`,
      image: ({ href, text }) => {
        const file = join(store.paths.meeting(meetingId), href)
        if (!href.startsWith('attachments/') || !existsSync(file)) return ''
        const mime = extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
        const data = readFileSync(file).toString('base64')
        return `<img src="data:${mime};base64,${data}" alt="${escapeHtml(text)}" style="max-width:520px;border:1px solid #E1DED8;border-radius:6px">`
      }
    }
  })
  // Checkboxes don't survive email; use plain ballot-box characters instead.
  const prepared = md.replace(/^(\s*[-*+]) \[ \] /gm, '$1 ☐ ').replace(/^(\s*[-*+]) \[[xX]\] /gm, '$1 ☑ ')
  // The ballot box replaces the bullet.
  return (marked.parse(prepared) as string).replace(/<li>([☐☑])/g, '<li style="list-style:none;margin-left:-1.1em">$1')
}

function htmlDocument(body: string, fonts = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
body{font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.6;color:#1B1D21;max-width:68ch}
h1{font-size:24px;font-weight:600;margin:0 0 4px}
h1+p{font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;color:#5F636A;margin:0 0 24px}
h2{font-size:15px;font-weight:600;margin:24px 0 8px}
ul{padding-left:20px}
li{margin:2px 0}
</style></head><body>${body}</body></html>`
}

// ---------- Copy and email ----------

export async function copyToClipboard(m: Meeting, opts: ShareOptions): Promise<void> {
  const md = shareMarkdown(m, store.readNote(m.id), store.readTranscript(m.id), opts)
  const html = `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#1B1D21">${toHtml(md, m.id)}</div>`
  await clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': md })])
}

/**
 * Copies the formatted note and opens a new email with the subject filled in.
 * New Outlook can't open pre-filled drafts from files, so the body is pasted.
 */
export async function emailDraft(m: Meeting, opts: ShareOptions): Promise<void> {
  await copyToClipboard(m, opts)
  await shell.openExternal(`mailto:?subject=${encodeURIComponent(m.title)}`)
}

// ---------- Files ----------

function defaultName(m: Meeting, ext: string): string {
  return exportFileName(m, '{date} {title}').replace(/\.md$/, ext)
}

/** Asks where to save. KASHA_TEST_SAVE_DIR skips the dialog for automated tests. */
async function askSavePath(m: Meeting, ext: string, filter: Electron.FileFilter, parent?: BrowserWindow): Promise<string | null> {
  if (process.env.KASHA_TEST_SAVE_DIR) return join(process.env.KASHA_TEST_SAVE_DIR, defaultName(m, ext))
  const save = { defaultPath: join(app.getPath('documents'), defaultName(m, ext)), filters: [filter] }
  const r = parent ? await dialog.showSaveDialog(parent, save) : await dialog.showSaveDialog(save)
  return r.canceled || !r.filePath ? null : r.filePath
}

/** IBM Plex for the PDF, read from the built renderer assets or node_modules in dev. */
function fontFaces(): string {
  const faces: Array<[string, string, number]> = [
    ['IBM Plex Sans', 'ibm-plex-sans-latin-400-normal', 400],
    ['IBM Plex Sans', 'ibm-plex-sans-latin-600-normal', 600],
    ['IBM Plex Mono', 'ibm-plex-mono-latin-400-normal', 400]
  ]
  const assets = join(__dirname, '../renderer/assets')
  const dev = join(app.getAppPath(), 'node_modules/@fontsource')
  return faces
    .map(([family, stem, weight]) => {
      let file: string | undefined
      if (existsSync(assets)) {
        const hit = readdirSync(assets).find((f) => f.startsWith(stem) && f.endsWith('.woff2'))
        if (hit) file = join(assets, hit)
      }
      const devFile = join(dev, family.toLowerCase().replace(/ /g, '-'), 'files', `${stem}.woff2`)
      if (!file && existsSync(devFile)) file = devFile
      if (!file) return ''
      const data = readFileSync(file).toString('base64')
      return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2')}`
    })
    .join('\n')
}

export async function savePdf(m: Meeting, opts: ShareOptions, parent?: BrowserWindow): Promise<boolean> {
  const filePath = await askSavePath(m, '.pdf', { name: 'PDF', extensions: ['pdf'] }, parent)
  if (!filePath) return false

  const md = shareMarkdown(m, store.readNote(m.id), store.readTranscript(m.id), opts)
  const tmp = join(tmpdir(), `kasha-print-${Date.now()}.html`)
  writeFileSync(tmp, htmlDocument(toHtml(md, m.id), fontFaces()))
  // Scripts off: the page is static and partly built from transcript text.
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await win.loadURL(pathToFileURL(tmp).toString())
    const pdf = await win.webContents.printToPDF({ pageSize: 'Letter', margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 } })
    writeFileSync(filePath, pdf)
  } finally {
    win.destroy()
    rmSync(tmp, { force: true })
  }
  if (!process.env.KASHA_TEST_SAVE_DIR) shell.showItemInFolder(filePath)
  return true
}

export async function saveMarkdown(m: Meeting, opts: ShareOptions, parent?: BrowserWindow): Promise<boolean> {
  const filePath = await askSavePath(m, '.md', { name: 'Markdown', extensions: ['md'] }, parent)
  if (!filePath) return false

  let md = shareMarkdown(m, store.readNote(m.id), store.readTranscript(m.id), opts)
  // Copy screenshots next to the file so the links keep working.
  const stem = basename(filePath, '.md')
  const folder = `${stem} attachments`
  md = md.replace(/!\[([^\]]*)\]\((attachments\/[^)\s]+)\)/g, (all, alt: string, rel: string) => {
    const src = join(store.paths.meeting(m.id), rel)
    if (!existsSync(src)) return ''
    const destDir = join(dirname(filePath), folder)
    mkdirSync(destDir, { recursive: true })
    copyFileSync(src, join(destDir, basename(rel)))
    return `![${alt}](<${folder}/${basename(rel)}>)`
  })
  writeFileSync(filePath, md)
  if (!process.env.KASHA_TEST_SAVE_DIR) shell.showItemInFolder(filePath)
  return true
}
