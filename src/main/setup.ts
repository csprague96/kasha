import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SetupStatus } from '@shared/types'
import { paths } from './store'

// Everything is pinned by SHA-256 so a tampered or truncated file is rejected.
// b5130 is the most recent whisper.cpp release that ships Windows binaries.
const WHISPER_ZIP = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
  size: 8_573_270,
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
}
// small.en, 5-bit quantized: same transcript quality as the full model in testing,
// a third of the download and ~300 MB less RAM while transcribing.
const MODEL = {
  name: 'ggml-small.en-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
  size: 190_098_681,
  sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30'
}
// Silero voice activity detection: Whisper skips silence, roughly halving transcription time.
const VAD = {
  name: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  size: 885_098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
}

export const DOWNLOAD_MB = Math.round((WHISPER_ZIP.size + MODEL.size + VAD.size) / 1_000_000)

export const whisperPaths = {
  model: () => join(paths.bin(), MODEL.name),
  vad: () => join(paths.bin(), VAD.name),
  cli: () => findFile(paths.bin(), 'whisper-cli.exe')
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

let download: SetupStatus['whisper'] = { ready: false, downloading: false, progress: 0 }

const hasFile = (file: string, size: number) => existsSync(file) && statSync(file).size === size

export function whisperReady(): boolean {
  return !!whisperPaths.cli() && hasFile(whisperPaths.model(), MODEL.size) && hasFile(whisperPaths.vad(), VAD.size)
}

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

export async function downloadWhisper(onChange: () => void): Promise<void> {
  if (download.downloading) return
  download = { ready: false, downloading: true, progress: 0 }
  onChange()
  const total = WHISPER_ZIP.size + MODEL.size + VAD.size
  let got = 0
  let lastTick = 0
  const tick = (n: number) => {
    got += n
    const now = Date.now()
    if (now - lastTick > 250) {
      lastTick = now
      download.progress = Math.min(0.99, got / total)
      onChange()
    }
  }
  const fetchVerified = async (f: { url: string; sha256: string }, dest: string) => {
    if ((await fetchTo(f.url, dest, tick)) !== f.sha256) {
      rmSync(dest, { force: true })
      throw new Error('A download did not match the expected file. Try again.')
    }
  }
  try {
    const dir = paths.bin()
    mkdirSync(dir, { recursive: true })

    if (!whisperPaths.cli()) {
      const zip = join(dir, 'whisper-bin-x64.zip')
      await fetchVerified(WHISPER_ZIP, zip)
      // Windows 10+ ships a bsdtar that handles zip archives. Use the full path:
      // Git's GNU tar is often first on PATH and can't read zips or C:\ paths.
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      await new Promise<void>((resolve, reject) =>
        execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
      )
      rmSync(zip, { force: true })
      if (!whisperPaths.cli()) throw new Error('whisper-cli.exe was not found in the download.')
    } else {
      got += WHISPER_ZIP.size
    }

    for (const [f, dest] of [
      [VAD, whisperPaths.vad()],
      [MODEL, whisperPaths.model()]
    ] as const) {
      if (hasFile(dest, f.size)) got += f.size
      else await fetchVerified(f, dest)
    }
    download = { ready: true, downloading: false, progress: 1 }
  } catch (e) {
    download = { ready: false, downloading: false, progress: 0, error: (e as Error).message }
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

export async function setupStatus(): Promise<SetupStatus> {
  const exe = claudeExe()
  return {
    whisper: download.downloading ? download : { ...download, ready: whisperReady() },
    claude: { installed: !!exe, signedIn: exe ? await claudeSignedIn() : false },
    vaults: detectVaults()
  }
}
