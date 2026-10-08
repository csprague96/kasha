import { app } from 'electron'
import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A small event log at %APPDATA%\Kasha\kasha.log, for working out what happened
 * when something doesn't ("why didn't it ask to record?"). Events and counts
 * only: never meeting titles, names or transcript text. Kept under ~1 MB.
 */

const MAX = 1024 * 1024

type Value = string | number | boolean | null | undefined

export function log(event: string, data: Record<string, Value> = {}): void {
  try {
    const file = join(app.getPath('userData'), 'kasha.log')
    try {
      if (statSync(file).size > MAX) {
        rmSync(`${file}.old`, { force: true })
        renameSync(file, `${file}.old`)
      }
    } catch {
      /* no log yet */
    }
    // Paths can hold a Windows user name or a meeting title: never logged.
    const clean = (v: string) => v.replace(/[A-Za-z]:[\\/][^'"\n]*|\\\\[^'"\n]*/g, '<path>')
    const fields = Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(clean(v)) : v}`)
      .join(' ')
    appendFileSync(file, `${new Date().toISOString()} ${event}${fields ? ` ${fields}` : ''}\n`)
  } catch {
    /* logging never breaks the app */
  }
}
