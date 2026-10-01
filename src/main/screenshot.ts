import { clipboard, desktopCapturer, screen, shell } from 'electron'
import { createHash } from 'node:crypto'

async function clipboardPng(): Promise<Buffer | null> {
  try {
    if (!(await clipboard.has('image/png'))) return null
    for (const item of await clipboard.read()) {
      if (item.types.includes('image/png')) {
        const blob = (await item.getType('image/png')) as Blob
        return Buffer.from(await blob.arrayBuffer())
      }
    }
  } catch {
    /* clipboard busy or unreadable */
  }
  return null
}

const hash = (b: Buffer | null) => (b ? createHash('sha1').update(b).digest('hex') : '')

async function captureFullScreen(): Promise<Buffer | null> {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor }
  })
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0]
  return src && !src.thumbnail.isEmpty() ? src.thumbnail.toPNG() : null
}

/**
 * Opens the Windows snipping overlay so the user picks a region, then picks
 * the result up from the clipboard. Falls back to the full screen if the
 * overlay can't open. Resolves null if the user cancels.
 */
export async function takeScreenshot(onOverlayOpen: () => void): Promise<Buffer | null> {
  const before = hash(await clipboardPng())
  try {
    await shell.openExternal('ms-screenclip:')
  } catch {
    return captureFullScreen()
  }
  onOverlayOpen()
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    const png = await clipboardPng()
    if (png && hash(png) !== before) return png
  }
  return null
}
