import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SetupStatus } from '@shared/types'
import { paths } from './store'

// Everything is pinned by SHA-256 so a tampered or truncated file is rejected.
// whisper.cpp 1.9.4 Windows binaries: whisper-cli, parakeet-cli and the VAD tool.
const WHISPER_ZIP = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
  size: 8_573_270,
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
}
// NVIDIA Parakeet TDT 0.6B v3, 4-bit: about four times faster than Whisper
// small on the CPU, with word timings built in. Converted by the whisper.cpp team.
const PARAKEET = {
  name: 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
  url: 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
  size: 355_615_679,
  sha256: 'aa7fe2f5fb47d863ca23e8b1d490632d63a2599f515268b6d6bd656158dad45e'
}
// Whisper small.en, 5-bit. No longer downloaded; still used where it's already installed and Parakeet isn't.
const WHISPER_MODEL = {
  name: 'ggml-small.en-q5_1.bin',
  size: 190_098_681
}
// Silero voice activity detection: finds where speech starts and stops.
const VAD = {
  name: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  size: 885_098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
}
// Speaker separation: pyannote segmentation 3.0 (8-bit), packaged by sherpa-onnx.
const SEGMENTATION = {
  archive: 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  size: 6_958_444,
  sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
  inner: join('sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx'),
  name: 'pyannote-segmentation-3.0.int8.onnx',
  fileSize: 1_540_506
}
// Voice embeddings for telling speakers apart and recognising them later: 3D-Speaker CAM++, English.
const EMBEDDING = {
  name: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
  size: 29_596_978,
  sha256: '357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b'
}

export const whisperPaths = {
  model: () => join(paths.bin(), WHISPER_MODEL.name),
  parakeet: () => join(paths.bin(), PARAKEET.name),
  vad: () => join(paths.bin(), VAD.name),
  cli: () => findFile(paths.bin(), 'whisper-cli.exe'),
  parakeetCli: () => findFile(paths.bin(), 'parakeet-cli.exe'),
  // Ships in the same zip; finds where speech starts and stops.
  vadCli: () => findFile(paths.bin(), 'whisper-vad-speech-segments.exe')
}

export const speakerPaths = {
  segmentation: () => join(paths.bin(), SEGMENTATION.name),
  embedding: () => join(paths.bin(), EMBEDDING.name)
}

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name) return full
    if (entry.isDirectory()) {
      const hit = findFile(full, name)
      if (hit) return hit
    }
  }
  return null
}

let download: Pick<SetupStatus['whisper'], 'downloading' | 'progress' | 'error'> = { downloading: false, progress: 0 }

const hasFile = (file: string, size: number) => existsSync(file) && statSync(file).size === size

const toolsReady = () => !!whisperPaths.cli() && !!whisperPaths.parakeetCli() && !!whisperPaths.vadCli() && hasFile(whisperPaths.vad(), VAD.size)

/** Which speech model transcribes: Parakeet when installed, else an existing Whisper model. */
export function speechEngine(): 'parakeet' | 'whisper' | null {
  if (!toolsReady()) return null
  if (hasFile(whisperPaths.parakeet(), PARAKEET.size)) return 'parakeet'
  if (hasFile(whisperPaths.model(), WHISPER_MODEL.size)) return 'whisper'
  return null
}

export const speechReady = (): boolean => speechEngine() !== null

/** The speaker models are optional extras; without them everyone on the call is "Others". */
export function speakersReady(): boolean {
  return hasFile(speakerPaths.segmentation(), SEGMENTATION.fileSize) && hasFile(speakerPaths.embedding(), EMBEDDING.size)
}

/** What a download would fetch now: only the parts that are missing. */
function missing(): Array<{ url: string; size: number; sha256: string; dest: string }> {
  const dir = paths.bin()
  const out: Array<{ url: string; size: number; sha256: string; dest: string }> = []
  if (!whisperPaths.cli() || !whisperPaths.parakeetCli() || !whisperPaths.vadCli()) out.push({ ...WHISPER_ZIP, dest: join(dir, 'whisper-bin-x64.zip') })
  if (!hasFile(whisperPaths.vad(), VAD.size)) out.push({ ...VAD, dest: whisperPaths.vad() })
  if (!hasFile(whisperPaths.parakeet(), PARAKEET.size)) out.push({ ...PARAKEET, dest: whisperPaths.parakeet() })
  if (!hasFile(speakerPaths.segmentation(), SEGMENTATION.fileSize)) out.push({ ...SEGMENTATION, dest: join(dir, SEGMENTATION.archive) })
  if (!hasFile(speakerPaths.embedding(), EMBEDDING.size)) out.push({ ...EMBEDDING, dest: speakerPaths.embedding() })
  return out
}

export const downloadMb = (): number => Math.round(missing().reduce((t, f) => t + f.size, 0) / 1_000_000)

/**
 * Streams a URL to disk via Chromium's network stack (honours the system proxy)
 * and returns the SHA-256 of the file. Interrupted downloads resume from the
 * partial file, so a dropped connection doesn't restart the download.
 */
async function fetchTo(url: string, dest: string, onBytes: (n: number) => void): Promise<string> {
  const tmp = `${dest}.part`
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const have = existsSync(tmp) ? statSync(tmp).size : 0
    if (attempt === 0 && have) onBytes(have)
    try {
      const res = await net.fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} })
      if (!res.body || (res.status !== 200 && res.status !== 206)) throw new Error(`Download failed (${res.status})`)
      const resumed = res.status === 206
      if (!resumed && have) onBytes(-have) // server ignored the range; start over
      const out = createWriteStream(tmp, { flags: resumed ? 'a' : 'w' })
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          onBytes(value.byteLength)
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()))
      }
      renameSync(tmp, dest)
      return await sha256File(dest)
    } catch (e) {
      lastErr = e as Error
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  throw new Error(`Download kept failing (${lastErr?.message}). Check your connection and try again.`)
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/** Windows 10+ ships a bsdtar that reads zip and tar.bz2. Full path: Git's tar is often first on PATH and can't. */
function extract(archive: string, dir: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise<void>((resolve, reject) =>
    execFile(tar, ['-xf', archive, '-C', dir], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  )
}

/** Downloads whatever is missing: the speech tools, the Parakeet model and the speaker models. */
export async function downloadSpeech(onChange: () => void): Promise<void> {
  if (download.downloading) return
  download = { downloading: true, progress: 0 }
  onChange()
  const files = missing()
  const total = files.reduce((t, f) => t + f.size, 0)
  let got = 0
  let lastTick = 0
  const tick = (n: number) => {
    got += n
    const now = Date.now()
    if (now - lastTick > 250) {
      lastTick = now
      download.progress = total ? Math.min(0.99, got / total) : 1
      onChange()
    }
  }
  try {
    const dir = paths.bin()
    mkdirSync(dir, { recursive: true })
    for (const f of files) {
      if ((await fetchTo(f.url, f.dest, tick)) !== f.sha256) {
        rmSync(f.dest, { force: true })
        throw new Error('A download did not match the expected file. Try again.')
      }
      if (f.dest.endsWith('.zip')) {
        await extract(f.dest, dir)
        rmSync(f.dest, { force: true })
        if (!whisperPaths.cli() || !whisperPaths.parakeetCli()) throw new Error('The speech tools were not found in the download.')
      } else if (f.dest.endsWith('.tar.bz2')) {
        await extract(f.dest, dir)
        rmSync(f.dest, { force: true })
        const inner = join(dir, SEGMENTATION.inner)
        if (!hasFile(inner, SEGMENTATION.fileSize)) throw new Error('The speaker model was not found in the download.')
        renameSync(inner, speakerPaths.segmentation())
        rmSync(join(dir, SEGMENTATION.inner.split(/[\\/]/)[0]), { recursive: true, force: true })
      }
    }
    download = { downloading: false, progress: 1 }
  } catch (e) {
    download = { downloading: false, progress: 0, error: (e as Error).message }
  }
  onChange()
}

// ---------- Claude Code ----------

/** Resolves the Claude Code executable. Returns null when it isn't installed. */
export function claudeExe(): string | null {
  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    ...pathDirs.map((d) => join(d, 'claude.exe')),
    join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
    ...pathDirs.map((d) => join(d, 'claude.cmd'))
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

export function claudeSignedIn(): Promise<boolean> {
  const exe = claudeExe()
  if (!exe) return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile(
      exe,
      ['auth', 'status', '--json'],
      { windowsHide: true, timeout: 15000, shell: exe.endsWith('.cmd') },
      (_err, stdout) => {
        try {
          resolve(JSON.parse(stdout).loggedIn === true)
        } catch {
          resolve(false)
        }
      }
    )
  )
}

// ---------- Obsidian ----------

/** Reads the vault list Obsidian keeps in %APPDATA%\obsidian\obsidian.json. */
export function detectVaults(): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('appData'), 'obsidian', 'obsidian.json'), 'utf8'))
    const vaults = Object.values(raw.vaults ?? {}) as Array<{ path: string; ts?: number }>
    return vaults
      .filter((v) => v.path && existsSync(v.path))
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .map((v) => v.path)
  } catch {
    return []
  }
}

// ---------- Codex ----------

const CODEX_VENDOR = ['@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe']

/**
 * Resolves the Codex executable. npm installs a .cmd shim; the native codex.exe
 * behind it is preferred because cmd.exe quoting is fragile.
 */
export function codexExe(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(';').filter(Boolean), join(process.env.APPDATA ?? '', 'npm')]
  for (const d of dirs) {
    if (existsSync(join(d, 'codex.exe'))) return join(d, 'codex.exe')
  }
  for (const d of dirs) {
    if (!existsSync(join(d, 'codex.cmd'))) continue
    const native = [
      join(d, 'node_modules', '@openai', 'codex', 'node_modules', ...CODEX_VENDOR),
      join(d, 'node_modules', ...CODEX_VENDOR)
    ].find((p) => existsSync(p))
    return native ?? join(d, 'codex.cmd')
  }
  return null
}

export function codexSignedIn(): Promise<boolean> {
  const exe = codexExe()
  if (!exe) return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile(
      exe,
      ['login', 'status'],
      { windowsHide: true, timeout: 15000, shell: exe.endsWith('.cmd') },
      (err, stdout, stderr) => resolve(!err && /logged in/i.test(`${stdout}${stderr}`))
    )
  )
}

export async function setupStatus(): Promise<SetupStatus> {
  const exe = claudeExe()
  const codex = codexExe()
  return {
    whisper: {
      ...download,
      ready: !download.downloading && speechReady(),
      engine: speechEngine(),
      speakers: speakersReady(),
      downloadMb: downloadMb()
    },
    claude: { installed: !!exe, signedIn: exe ? await claudeSignedIn() : false },
    codex: { installed: !!codex, signedIn: codex ? await codexSignedIn() : false },
    vaults: detectVaults()
  }
}
