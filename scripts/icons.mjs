// Generates the app icon and tray icons from logo 2b.
// Run with: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const ORANGE = '#fc814a'
const BLUE = '#064789'

const mark = (lines, bowl) => `
  <rect x="12" y="5" width="40" height="8" rx="4" fill="${lines}"/>
  <rect x="12" y="19" width="28" height="8" rx="4" fill="${lines}"/>
  <path d="M6 34 H58 A26 26 0 0 1 6 34 Z" fill="${bowl}"/>`

// App icon: logo on a warm paper tile so it reads on light and dark taskbars.
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <rect width="64" height="64" rx="14" fill="#F6F5F2"/>
  <g transform="translate(9 9) scale(0.72)">${mark(BLUE, ORANGE)}</g>
</svg>`

// Tray: monochrome while idle, orange bowl while recording.
const traySvg = (fg, rec) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${mark(fg, rec ? ORANGE : fg)}</svg>`

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
