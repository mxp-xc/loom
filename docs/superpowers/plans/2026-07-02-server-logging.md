# Server 层日志系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Loom server 层引入持久化、按天轮转(保留 7 天)的人类可读日志系统,覆盖所有关键流程和错误(含未捕获异常与完整调用栈)。

**Architecture:** 新增零依赖的 logger 模块(`lib/logger.ts`),双写控制台与文件,按天轮转 `loom-YYYY-MM-DD.log`,启动时清理 7 天前文件。替换 Hono 内置 logger 为自定义请求中间件;在 `routes.ts` 各 handler 关键流程和 catch 块接入日志;在 `index.ts` 注册 `uncaughtException`/`unhandledRejection` 全局兜底;在 `deps.ts` 将现有 `ProjectionDeps.logger` 接口桥接到新 logger。

**Tech Stack:** TypeScript, Node.js fs/promises, Hono, vitest

**Spec:** [docs/superpowers/specs/2026-07-02-server-logging-design.md](../specs/2026-07-02-server-logging-design.md)

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/server/src/lib/logger.ts` | 核心 logger 模块:格式化、双写、按天轮转、清理旧文件、child logger | Create |
| `packages/server/src/lib/logger.test.ts` | logger 单元测试 | Create |
| `packages/server/src/index.ts` | 服务入口:注册全局异常处理 | Modify |
| `packages/server/src/api/server.ts` | Hono app:移除 hono/logger,加自定义请求日志中间件 | Modify |
| `packages/server/src/api/routes.ts` | 路由:各 handler 关键流程 INFO、catch 块 ERROR | Modify |
| `packages/server/src/api/deps.ts` | 依赖工厂:logger 桥接 | Modify |
| `.gitignore` | 忽略 logs 目录 | Modify |

---

### Task 1: 创建 logger 核心模块

**Files:**
- Create: `packages/server/src/lib/logger.ts`
- Test: `packages/server/src/lib/logger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/lib/logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLogger } from './logger.js'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('logger', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-log-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('format', () => {
    it('writes a line with timestamp level component message key=val', async () => {
      const log = createLogger({ logDir: dir, level: 'DEBUG', console: false })
      log.info('hello world', { foo: 'bar', count: 3 })
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      // 2026-07-02 10:00:00 INFO  loom - hello world foo=bar count=3
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO  loom - hello world foo=bar count=3\n$/)
    })

    it('left-pads level to 5 chars', async () => {
      const log = createLogger({ logDir: dir, level: 'DEBUG', console: false })
      log.warn('test')
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).toMatch(/WARN /) // 4 chars + 1 space = 5
    })

    it('quotes values containing spaces', async () => {
      const log = createLogger({ logDir: dir, level: 'DEBUG', console: false })
      log.info('msg', { path: '/some path/with spaces' })
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).toMatch(/path="\/some path\/with spaces"/)
    })
  })

  describe('error stack', () => {
    it('appends error stack on ctx.err being an Error', async () => {
      const log = createLogger({ logDir: dir, level: 'ERROR', console: false })
      const err = new Error('boom')
      log.error('operation failed', { err })
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).toContain('operation failed')
      expect(content).toContain('Error: boom')
      expect(content).toMatch(/\n {2}Error: boom\n/)
    })
  })

  describe('level filtering', () => {
    it('filters out levels below configured level', async () => {
      const log = createLogger({ logDir: dir, level: 'WARN', console: false })
      log.debug('debug msg')
      log.info('info msg')
      log.warn('warn msg')
      log.error('error msg')
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).not.toContain('debug msg')
      expect(content).not.toContain('info msg')
      expect(content).toContain('warn msg')
      expect(content).toContain('error msg')
    })
  })

  describe('child logger', () => {
    it('uses dotted component name from child', async () => {
      const log = createLogger({ logDir: dir, level: 'DEBUG', console: false })
      const child = log.child('api')
      child.info('request done')
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).toMatch(/loom\.api - request done/)
    })
  })

  describe('rotation', () => {
    it('writes to loom-YYYY-MM-DD.log', async () => {
      const log = createLogger({ logDir: dir, level: 'INFO', console: false })
      log.info('test')
      await log.flush()
      const files = await readdir(dir)
      const today = new Date().toISOString().slice(0, 10)
      expect(files).toContain(`loom-${today}.log`)
    })

    it('rotates to a new file when date changes', async () => {
      const fixedDate = new Date('2026-01-15T10:00:00')
      vi.useFakeTimers({ now: fixedDate })
      const log = createLogger({ logDir: dir, level: 'INFO', console: false })
      log.info('day one')
      await log.flush()
      // Advance to next day
      vi.setSystemTime(new Date('2026-01-16T10:00:00'))
      log.info('day two')
      await log.flush()
      vi.useRealTimers()
      const files = await readdir(dir)
      expect(files).toContain('loom-2026-01-15.log')
      expect(files).toContain('loom-2026-01-16.log')
      const f1 = await readFile(join(dir, 'loom-2026-01-15.log'), 'utf8')
      const f2 = await readFile(join(dir, 'loom-2026-01-16.log'), 'utf8')
      expect(f1).toContain('day one')
      expect(f2).toContain('day two')
    })
  })

  describe('cleanup', () => {
    it('deletes log files older than 7 days on init', async () => {
      // Create an old log file (10 days ago)
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)
      const oldName = `loom-${oldDate.toISOString().slice(0, 10)}.log`
      await writeFile(join(dir, oldName), 'old content\n')

      // Create a recent one (3 days ago, should be kept)
      const recentDate = new Date()
      recentDate.setDate(recentDate.getDate() - 3)
      const recentName = `loom-${recentDate.toISOString().slice(0, 10)}.log`
      await writeFile(join(dir, recentName), 'recent content\n')

      createLogger({ logDir: dir, level: 'INFO', console: false })
      // cleanup is asynchronous on init; give it a tick
      await new Promise((r) => setTimeout(r, 50))

      const files = await readdir(dir)
      expect(files).not.toContain(oldName)
      expect(files).toContain(recentName)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @loom/server test -- --run logger`
Expected: FAIL — `createLogger` not found / module does not exist

- [ ] **Step 3: Implement the logger module**

Create `packages/server/src/lib/logger.ts`:

```typescript
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
type PendingWrite = { file: string; line: string; done: Promise<void> }

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatValue(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  const s = String(val)
  if (s === '') return '""'
  if (/\s|=|"|'/.test(s)) return `"${s.replace(/"/g, '\\"')}"`
  return s
}

function formatCtx(ctx?: LogContext): string {
  if (!ctx) return ''
  const parts: string[] = []
  for (const [key, val] of Object.entries(ctx)) {
    if (key === 'err' && val instanceof Error) {
      // err is rendered as the error message inline; the stack is appended separately
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

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? 'INFO'
  const minLevel = LEVEL_ORDER[level]
  const component = opts.component ?? 'loom'
  const useConsole = opts.console ?? true
  const retentionDays = opts.retentionDays ?? 7
  const logDir = opts.logDir

  const pending: PendingWrite[] = []

  // Fire-and-forget cleanup of old logs on init
  cleanupOldLogs(logDir, retentionDays).catch(() => {
    /* best-effort */
  })

  async function cleanupOldLogs(dir: string, days: number): Promise<void> {
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
      if (m[1] < cutoffKey) {
        await rm(join(dir, name)).catch(() => {})
      }
    }
  }

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

    pending.push({ file, line, done })
    done.finally(() => {
      const idx = pending.findIndex((p) => p.done === done)
      if (idx >= 0) pending.splice(idx, 1)
    })

    if (useConsole) {
      const stream = lvl === 'ERROR' || lvl === 'WARN' ? process.stderr : process.stdout
      stream.write(line)
    }
  }

  function child(comp: string): Logger {
    return createLogger({
      logDir,
      level,
      component: `${component}.${comp}`,
      console: useConsole,
      retentionDays,
    })
  }

  async function flush(): Promise<void> {
    // Snapshot then await all pending writes
    const snapshot = [...pending]
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @loom/server test -- --run logger`
Expected: PASS — all 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/logger.ts packages/server/src/lib/logger.test.ts
git commit -m "feat: add logger module with daily rotation and 7-day retention"
```

---

### Task 2: 注册全局未捕获异常处理

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Rewrite index.ts with global exception handlers**

Replace the entire content of `packages/server/src/index.ts` with:

```typescript
import { startApiServer } from './api/server.js'
import { logger } from './lib/logger.js'

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { err: reason })
  process.exit(1)
})

startApiServer().catch((err) => {
  logger.error('failed to start Loom API server', { err })
  process.exit(1)
})
```

- [ ] **Step 2: Verify the server still boots**

Run: `pnpm --filter @loom/server dev` then Ctrl+C after seeing the startup line.
Expected: `server started` appears in the log file; no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat: register global uncaughtException and unhandledRejection handlers"
```

---

### Task 3: 替换 Hono 请求日志中间件

**Files:**
- Modify: `packages/server/src/api/server.ts`

- [ ] **Step 1: Replace hono/logger with custom request logging middleware**

Replace the entire content of `packages/server/src/api/server.ts` with:

```typescript
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { registerRoutes } from './routes.js'
import { logger } from '../lib/logger.js'

const requestLogger = logger.child('api')

export function createApp(): Hono {
  const app = new Hono()

  // Custom request logging — replaces hono/logger so requests go to the file too
  app.use('*', async (c, next) => {
    const start = Date.now()
    await next()
    const duration = Date.now() - start
    requestLogger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration: `${duration}ms`,
    })
  })

  app.route('/api', registerRoutes())
  const dist =
    process.env.LOOM_WEB_DIST ?? fileURLToPath(new URL('../../../web/dist/', import.meta.url))
  app.use('/assets/*', serveStatic({ root: dist }))
  app.get('/favicon.ico', (c) => c.body(null, 204))
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404)
    return c.html(await readFile(join(dist, 'index.html'), 'utf8'))
  })
  return app
}

export function startApiServer(port = Number(process.env.LOOM_PORT ?? 3000)) {
  return import('@hono/node-server').then(({ serve }) =>
    serve({ fetch: createApp().fetch, port }, (info) =>
      logger.info('server started', { port: info.port }),
    ),
  )
}
```

Note: The `hono/logger` import is removed entirely. The startup `console.log` is replaced with `logger.info`.

- [ ] **Step 2: Verify the server boots and request logging works**

Run: `pnpm --filter @loom/server dev`, then in another terminal:
```bash
curl http://localhost:3000/api/health
```
Expected: `{"ok":true}` response. In `logs/loom-YYYY-MM-DD.log` you should see a line like:
```
2026-07-02 ... INFO  loom.api - request method=GET path=/api/health status=200 duration=2ms
```
Stop the server with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api/server.ts
git commit -m "feat: replace hono/logger with custom request logging middleware"
```

---

### Task 4: 路由层接入业务日志

**Files:**
- Modify: `packages/server/src/api/routes.ts`

This task adds INFO logging to key route handlers and replaces all `console.error`/`console.warn` in catch blocks with `logger.error`.

- [ ] **Step 1: Add logger imports and child loggers at the top of routes.ts**

At the top of `packages/server/src/api/routes.ts`, add this import after the existing imports (after the `createDeps` import line):

```typescript
import { logger } from '../lib/logger.js'

const apiLogger = logger.child('api')
const syncLogger = logger.child('sync')
const remoteLogger = logger.child('remote')
```

- [ ] **Step 2: Add logging to sync/pull handler**

Find the `app.post('/sync/pull'` handler. Replace its entire body (the try/catch block) with:

```typescript
  app.post('/sync/pull', async (c) => {
    try {
      const { repoPath } = await c.req.json()
      syncLogger.info('pull started', { repoPath })
      const { git, fs } = createNodePlatform()
      const res = await syncPull(repoPath, git, fs, {
        error: (o, m) => syncLogger.error(m, o),
        warn: (o, m) => syncLogger.warn(m, o),
      })
      syncLogger.info('pull completed', { repoPath, clean: res.clean })
      return c.json({ ok: true, ...res })
    } catch (e) {
      const msg = String(e?.message ?? e)
      syncLogger.error('pull failed', { err: e, repoPath: c.req.path })
      const noRemote =
        /no remote|could not find remote|not a git repository|does not appear to be a git/i.test(
          msg,
        )
      return c.json({ ok: false, error: noRemote ? 'no_remote' : 'other', message: msg })
    }
  })
```

- [ ] **Step 3: Add logging to sync/apply handler**

Replace the entire `app.post('/sync/apply'` handler body with:

```typescript
  app.post('/sync/apply', async (c) => {
    try {
      const { repoPath, resolutions } = await c.req.json()
      syncLogger.info('apply resolutions', { repoPath, count: Object.keys(resolutions ?? {}).length })
      const { git, fs } = createNodePlatform()
      await applyResolutions(repoPath, git, fs, resolutions, {
        error: (o, m) => syncLogger.error(m, o),
        warn: (o, m) => syncLogger.warn(m, o),
      })
      syncLogger.info('apply completed', { repoPath })
      return c.json({ ok: true })
    } catch (e) {
      syncLogger.error('apply failed', { err: e })
      const msg = String(e?.message ?? e)
      return c.json({ ok: false, error: 'apply_failed', message: msg })
    }
  })
```

- [ ] **Step 4: Add logging to sync/push handler**

Replace the entire `app.post('/sync/push'` handler body with:

```typescript
  app.post('/sync/push', async (c) => {
    try {
      const { repoPath } = await c.req.json()
      syncLogger.info('push started', { repoPath })
      const { git } = createNodePlatform()
      // Auto-commit uncommitted yaml changes before pushing
      const status = await git.status(repoPath)
      if (status.dirty) {
        await git.add(repoPath, ['.'])
        await git.commit(repoPath, 'loom: sync changes')
      }
      const res = await syncPush(repoPath, git)
      syncLogger.info('push completed', { repoPath, ok: res.ok })
      return c.json(res)
    } catch (e) {
      syncLogger.error('push failed', { err: e })
      const msg = String(e?.message ?? e)
      const noRemote =
        /no remote|could not find remote|not a git repository|does not appear to be a git/i.test(
          msg,
        )
      return c.json({ ok: false, error: noRemote ? 'no_remote' : 'other', message: msg })
    }
  })
```

- [ ] **Step 5: Add logging to project handler**

Find the `app.post('/project'` handler. Replace the entire handler with:

```typescript
  app.post('/project', async (c) => {
    const body = await c.req.json()
    const repoPath = body.repoPath
    apiLogger.info('projection started', { repoPath })
    const { proc } = createNodePlatform()
    // Detect installed agents
    const allAgents: AgentId[] =
      body.installedAgents ?? (['claude-code', 'codex', 'opencode'] as AgentId[])
    const installed = new Set<AgentId>()
    for (const a of allAgents) {
      try {
        if (await proc.isInstalled(a)) installed.add(a)
      } catch {
        /* proc not available, assume installed */ installed.add(a)
      }
    }
    // Build manifest from repo files if not provided
    let mf = body.manifest
    if (!mf) {
      const { fs } = createNodePlatform()
      const files = await readRepoFiles(fs, repoPath)
      const repoManifest = loadRepoManifest(files)
      const home = process.env.HOME || process.env.USERPROFILE || ''
      const localConfig = await readLocalConfig(fs, home)
      mf = buildManifest(repoManifest, localConfig as any)
    }
    // Plan projection (use provided plan or build from manifest)
    const plan = body.plan ?? planProjection(mf, mf.config, installed)
    const deps = createDeps(repoPath, installed)
    const varsCtx = body.varsCtx ?? {
      env: {},
      activeProfile: mf.vars.active,
      defaultProfile: mf.vars.default,
    }
    const res = await executeProjection(plan, mf, varsCtx, deps)
    if (res.ok) {
      apiLogger.info('projection completed', { repoPath })
    } else {
      apiLogger.error('projection failed', { repoPath, step: res.failure.failedStep, err: res.failure.originalError })
    }
    return c.json(res)
  })
```

- [ ] **Step 6: Add logging to install handler**

Replace the `app.post('/install'` handler with:

```typescript
  app.post('/install', async (c) => {
    const { url, ref, repoPath, sourceId } = await c.req.json()
    remoteLogger.info('install skill', { url, ref, repoPath, sourceId })
    const { git, fs } = createNodePlatform()
    try {
      const res = await installSkill(git, fs, url, ref, repoPath, sourceId)
      remoteLogger.info('install completed', { url, sourceId, commit: res.pinned_commit })
      return c.json(res)
    } catch (e) {
      remoteLogger.error('install failed', { err: e, url, sourceId })
      return c.json({ ok: false, error: 'install_failed', message: String(e?.message ?? e) })
    }
  })
```

- [ ] **Step 7: Add logging to update handlers**

Replace the `app.post('/update'` and `app.post('/update/perform'` handlers with:

```typescript
  app.post('/update', async (c) => {
    const { sources } = await c.req.json()
    remoteLogger.info('check updates', { count: sources?.length ?? 0 })
    const { git } = createNodePlatform()
    const updates = await checkUpdates(sources, git)
    return c.json({ updates })
  })

  app.post('/update/perform', async (c) => {
    const body = await c.req.json()
    remoteLogger.info('perform update', { source: body.source?.url, newRef: body.newRef, repoPath: body.repoPath })
    const { git, fs } = createNodePlatform()
    try {
      const res = await performUpdate(
        git,
        fs,
        body.source,
        body.newRef,
        body.repoPath,
        body.sourceId,
        body.oldMembers,
      )
      remoteLogger.info('update completed', { source: body.source?.url, commit: res.pinned_commit })
      return c.json(res)
    } catch (e) {
      remoteLogger.error('update failed', { err: e, source: body.source?.url })
      return c.json({ ok: false, error: 'update_failed', message: String(e?.message ?? e) })
    }
  })
```

- [ ] **Step 8: Replace remaining console calls**

In the `app.post('/sources'` handler, replace:
```typescript
      console.error('auto-install failed for source', url, installErr)
```
with:
```typescript
      remoteLogger.error('auto-install failed for source', { err: installErr, url })
```

In the `app.put('/skill/content'` handler, replace:
```typescript
      logger.error({ err: e }, 'Failed to save skill content')
```
with:
```typescript
      apiLogger.error('failed to save skill content', { err: e })
```

- [ ] **Step 9: Verify no console calls remain in routes.ts**

Run: `rg "console\.(log|error|warn)" packages/server/src/api/routes.ts`
Expected: no output (zero matches)

- [ ] **Step 10: Verify the server boots and routes work**

Run: `pnpm --filter @loom/server dev`, then:
```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/sync/pull -H "Content-Type: application/json" -d '{"repoPath":"."}'
```
Expected: Both return JSON. The log file contains `request`, `pull started`, and either `pull completed` or `pull failed` lines. Stop the server.

- [ ] **Step 11: Commit**

```bash
git add packages/server/src/api/routes.ts
git commit -m "feat: add business logging to all route handlers"
```

---

### Task 5: 桥接 ProjectionDeps logger

**Files:**
- Modify: `packages/server/src/api/deps.ts`

- [ ] **Step 1: Bridge the deps logger to the new logger module**

In `packages/server/src/api/deps.ts`, add the import at the top (after the existing imports):

```typescript
import { logger } from '../lib/logger.js'
```

Then replace the `logger` property in the returned object (around line 42):

```typescript
    logger: { error: (o, m) => console.error(m, o), warn: (o, m) => console.warn(m, o) },
```

with:

```typescript
    logger: {
      error: (o, m) => logger.child('projection').error(m, o),
      warn: (o, m) => logger.child('projection').warn(m, o),
    },
```

- [ ] **Step 2: Verify no console calls remain in deps.ts**

Run: `rg "console\.(log|error|warn)" packages/server/src/api/deps.ts`
Expected: no output (zero matches)

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api/deps.ts
git commit -m "feat: bridge ProjectionDeps logger to persistent logger"
```

---

### Task 6: 添加 logs/ 到 .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add logs/ to .gitignore**

In `.gitignore`, find the existing `# logs` section:
```
# logs
*.log
npm-debug.log*
pnpm-debug.log*
```

Add `logs/` after the `*.log` line:

```
# logs
*.log
logs/
npm-debug.log*
pnpm-debug.log*
```

- [ ] **Step 2: Verify logs/ is ignored**

Run: `git check-ignore logs/`
Expected: `logs/` (confirms it matches an ignore rule)

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add logs/ to gitignore"
```

---

### Task 7: 全量验证

- [ ] **Step 1: Run the full server test suite**

Run: `pnpm --filter @loom/server test`
Expected: All tests pass (existing tests + new logger tests).

- [ ] **Step 2: Boot the server end-to-end**

Run: `pnpm dev`, then test multiple endpoints:
```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/init
curl -X POST http://localhost:3000/api/sync/pull -H "Content-Type: application/json" -d '{"repoPath":"."}'
```

Check the log file `logs/loom-YYYY-MM-DD.log` contains:
- `server started` line on boot
- `request` lines for each HTTP call
- `pull started` / `pull completed` (or `pull failed`) lines
- All lines follow the `timestamp LEVEL  component - message key=val` format

Stop the server with Ctrl+C.

- [ ] **Step 3: Verify uncaughtException logging**

Temporarily add to `packages/server/src/index.ts` before `startApiServer()`:
```typescript
setTimeout(() => { throw new Error('test uncaught') }, 1000)
```
Run `pnpm --filter @loom/server dev`, wait 2 seconds. Expected: server logs `uncaught exception` with full stack to the log file, then exits. Remove the test line.

- [ ] **Step 4: Final commit (if any cleanup)**

If any cleanup was needed, commit it. Otherwise, the implementation is complete.
```
