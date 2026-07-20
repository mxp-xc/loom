import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLogger, cleanupOldLogs } from '../../src/lib/logger.js'
import { parseVarsEnvironment, VarsCodecError } from '@loom/core'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

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
      expect(content).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO  loom - hello world foo=bar count=3\n$/,
      )
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

    it('JSON-stringifies object values', async () => {
      const log = createLogger({ logDir: dir, level: 'DEBUG', console: false })
      log.info('msg', { user: { id: 1, name: 'alice' } })
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).toContain('user={')
      expect(content).toContain('"id":1')
      expect(content).toContain('"name":"alice"')
      expect(content).not.toContain('[object Object]')
    })

    it('JSON-stringifies array values', async () => {
      const log = createLogger({ logDir: dir, level: 'DEBUG', console: false })
      log.info('msg', { tags: [1, 2, 3] })
      await log.flush()
      const files = await readdir(dir)
      const file = files.find((f) => f.endsWith('.log'))!
      const content = await readFile(join(dir, file), 'utf8')
      expect(content).toContain('tags=[1,2,3]')
    })

    it('logs a malformed vars error without exposing its YAML payload', async () => {
      const secret = 'top-secret-yaml-log-payload'
      let error: unknown
      try {
        parseVarsEnvironment(`API_KEY: [${secret}`)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(VarsCodecError)
      expect((error as VarsCodecError).cause).toBeInstanceOf(Error)

      const log = createLogger({ logDir: dir, level: 'ERROR', console: false })
      log.error('vars parse failed', { err: error })
      await log.flush()

      const files = await readdir(dir)
      const content = await readFile(
        join(
          dir,
          files.find((file) => file.endsWith('.log'))!,
        ),
        'utf8',
      )
      expect(content).toContain('vars parse failed')
      expect(content).toContain('invalid vars YAML')
      expect(content).not.toContain(secret)
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
      const today = localDateKey(new Date())
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
    it('deletes log files older than 7 days', async () => {
      // Create an old log file (10 days ago)
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)
      const oldName = `loom-${localDateKey(oldDate)}.log`
      await writeFile(join(dir, oldName), 'old content\n')

      // Create a recent one (3 days ago, should be kept)
      const recentDate = new Date()
      recentDate.setDate(recentDate.getDate() - 3)
      const recentName = `loom-${localDateKey(recentDate)}.log`
      await writeFile(join(dir, recentName), 'recent content\n')

      await cleanupOldLogs(dir, 7)

      const files = await readdir(dir)
      expect(files).not.toContain(oldName)
      expect(files).toContain(recentName)
    })

    it('deletes files exactly 7 days old', async () => {
      const boundaryDate = new Date()
      boundaryDate.setDate(boundaryDate.getDate() - 7)
      const boundaryName = `loom-${localDateKey(boundaryDate)}.log`
      await writeFile(join(dir, boundaryName), 'boundary content\n')

      await cleanupOldLogs(dir, 7)

      const files = await readdir(dir)
      expect(files).not.toContain(boundaryName)
    })
  })
})
