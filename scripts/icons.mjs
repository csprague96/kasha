// Generates the app icon and tray icons from the K mark (see src/renderer/src/components/Logo.tsx).
// Run with: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const pill = (x, y, w, h) => {
  const r = w / 2
  return `M${x},${y + r}a${r},${r} 0 0 1 ${w},0V${y + h - r}a${r},${r} 0 0 1 ${-w},0Z`
}
const BLUE = ['#00C6FF', '#0072FF']
const GOLD = ['#FFE000', '#FFA500']
const FOLD = ['#33D2FF', '#33D2FF']
const PARTS = [
  [BLUE, pill(184, 508, 100, 273)],
  [GOLD, pill(317, 391, 114, 478)],
  [BLUE, 'M463,800V346a104,104 0 0 1 208,0V800Z'],
  [GOLD, pill(463, 800, 191, 214)],
  [GOLD, 'M722,685L995,862C1045,895 1048,960 1000,1010C960,1048 900,1045 865,1018L555,775C600,740 660,712 722,685Z'],
  [FOLD, 'M463,730C470,650 530,580 595,535C580,570 590,590 610,610C645,645 690,665 722,685C660,712 600,735 555,775C500,815 463,860 463,900Z'],
  [BLUE, 'M595,535L671,475L920,290C975,245 1045,255 1085,300C1115,340 1110,420 1055,458C960,527 840,610 722,685C690,662 645,640 610,610C590,590 580,570 595,535Z']
]

// Full-color mark, or a flat silhouette in `mono`.
const mark = (mono) => {
  const defs = mono
    ? ''
    : `<defs>${PARTS.map(([[a, b]], i) => `<linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`).join('')}</defs>`
  return defs + PARTS.map(([, d], i) => `<path d="${d}" fill="${mono ?? `url(#g${i})`}"/>`).join('')
}
// Square viewBox centered on the mark (which spans 184..1110 x 241..1048).
const VIEW = '137 135 1020 1020'

// App icon: color mark on a white tile so it reads on light and dark taskbars.
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="512" height="512">
  <rect width="1024" height="1024" rx="224" fill="#FFFFFF"/>
  <svg x="112" y="112" width="800" height="800" viewBox="${VIEW}">${mark()}</svg>
</svg>`

// Tray: monochrome while idle, full color while recording.
const traySvg = (fg, rec) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}">${mark(rec ? undefined : fg)}</svg>`

mkdirSync('resources', { recursive: true })
mkdirSync('build', { recursive: true })

const app = (size) => sharp(Buffer.from(appSvg)).resize(size, size).png().toBuffer()
writeFileSync('resources/icon.png', await app(512))
writeFileSync('build/icon.ico', await pngToIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(app))))

for (const [theme, fg] of [
  ['light', '#1B1D21'],
  ['dark', '#ECEAE6']
]) {
  for (const rec of [false, true]) {
    const name = `tray-${rec ? 'rec' : 'idle'}-${theme}`
    const svg = Buffer.from(traySvg(fg, rec))
    await sharp(svg, { density: 300 }).resize(16, 16).png().toFile(`resources/${name}.png`)
    await sharp(svg, { density: 300 }).resize(32, 32).png().toFile(`resources/${name}@2x.png`)
  }
}
console.log('Icons written to resources/ and build/')
