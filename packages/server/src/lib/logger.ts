import { appendFile, readdir, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

export type LogContext = Record<string, unknown>

export interface Logger {
  debug(msg: string, ctx?: LogContext): void
  info(msg: string, ctx?: LogContext): void
  warn(msg: string, ctx?: LogContext): void
  error(msg: string, ctx?: LogContext): void
  child(component: string): Logger
  flush(): Promise<void>
}

export interface LoggerOptions {
  logDir: string
  level?: LogLevel
  component?: string
  console?: boolean
  retentionDays?: number
}

// Pending writes tracked so flush() can await completion.
type PendingWrite = { done: Promise<void> }

// Shared mutable state between a parent logger and its children so flush() on
// any one of them drains writes from all of them (a child's write must be
// observable after awaiting the parent's flush).
interface LoggerCore {
  pending: PendingWrite[]
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDate(d: Date): string {
  // Local timezone — matches user-facing log expectations.
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function formatValue(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (typeof val === 'object') {
    // JSON-stringify objects/arrays so they render usefully, not as [object Object]
    return JSON.stringify(val)
  }
  const s = String(val)
  if (s === '') return '""'
  if (/\s|=|"|'/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return s
}

function formatCtx(ctx?: LogContext): string {
  if (!ctx) return ''
  const parts: string[] = []
  for (const [key, val] of Object.entries(ctx)) {
    if (key === 'err' && val instanceof Error) {
      // err is rendered as its message inline; the stack is appended separately
      parts.push(`err=${formatValue(val.message)}`)
    } else {
      parts.push(`${key}=${formatValue(val)}`)
    }
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

function extractStack(ctx?: LogContext): string | null {
  if (!ctx) return null
  const err = ctx.err
  if (err instanceof Error && err.stack) return err.stack
  return null
}

function createLoggerInternal(opts: LoggerOptions, core?: LoggerCore): Logger {
  const level = opts.level ?? 'INFO'
  const minLevel = LEVEL_ORDER[level]
  const component = opts.component ?? 'loom'
  const useConsole = opts.console ?? true
  const logDir = opts.logDir

  // Children reuse the parent's core; only the root logger runs retention cleanup.
  const state: LoggerCore = core ?? { pending: [] }
  // Note: cleanup is NOT auto-run on createLogger to avoid filesystem side
  // effects on module import. Call cleanupOldLogs() explicitly on startup.

  function shouldLog(lvl: LogLevel): boolean {
    return LEVEL_ORDER[lvl] >= minLevel
  }

  function write(lvl: LogLevel, msg: string, ctx?: LogContext): void {
    if (!shouldLog(lvl)) return
    const now = new Date()
    const dayKey = dateKey(now)
    const file = join(logDir, `loom-${dayKey}.log`)
    const ts = formatDate(now)
    const levelStr = lvl.padEnd(5, ' ')
    const ctxStr = formatCtx(ctx)
    const stack = extractStack(ctx)
    let line = `${ts} ${levelStr} ${component} - ${msg}${ctxStr}\n`
    if (stack) line += `  ${stack}\n`

    const done = (async () => {
      try {
        await appendFile(file, line, 'utf8')
      } catch {
        // Directory may not exist yet — create and retry once
        try {
          await mkdir(logDir, { recursive: true })
          await appendFile(file, line, 'utf8')
        } catch {
          /* give up silently */
        }
      }
    })()

    state.pending.push({ done })
    done.finally(() => {
      state.pending = state.pending.filter((p) => p.done !== done)
    })

    if (useConsole) {
      const stream = lvl === 'ERROR' || lvl === 'WARN' ? process.stderr : process.stdout
      stream.write(line)
    }
  }

  function child(comp: string): Logger {
    return createLoggerInternal(
      {
        logDir,
        level,
        component: `${component}.${comp}`,
        console: useConsole,
      },
      state,
    )
  }

  async function flush(): Promise<void> {
    // Snapshot then await all pending writes
    const snapshot = [...state.pending]
    await Promise.all(snapshot.map((p) => p.done))
  }

  return {
    debug: (msg, ctx) => write('DEBUG', msg, ctx),
    info: (msg, ctx) => write('INFO', msg, ctx),
    warn: (msg, ctx) => write('WARN', msg, ctx),
    error: (msg, ctx) => write('ERROR', msg, ctx),
    child,
    flush,
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return createLoggerInternal(opts)
}

// Clean up log files older than `days`. Exported so the server entry point
// can call it explicitly on startup instead of running on module import.
export async function cleanupOldLogs(dir: string, days: number): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // dir doesn't exist yet
  }
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffKey = dateKey(cutoff)
  for (const name of entries) {
    const m = name.match(/^loom-(\d{4}-\d{2}-\d{2})\.log$/)
    if (!m) continue
    if (m[1] <= cutoffKey) {
      await rm(join(dir, name)).catch(() => {})
    }
  }
}

// Singleton default logger
function resolveLogDir(): string {
  const envDir = process.env.LOOM_LOG_DIR
  if (envDir) return envDir
  // Default: <project root>/logs (project root = cwd when the server runs)
  return join(process.cwd(), 'logs')
}

function resolveLevel(): LogLevel {
  const envLevel = process.env.LOOM_LOG_LEVEL?.toUpperCase()
  if (envLevel && envLevel in LEVEL_ORDER) return envLevel as LogLevel
  return 'INFO'
}

export const logger: Logger = createLogger({
  logDir: resolveLogDir(),
  level: resolveLevel(),
})
