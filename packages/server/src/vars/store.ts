import { parseVarsEnvironment, serializeVarsEnvironment, type VarsEnvironment } from '@loom/core'
import { dirname, isAbsolute, join } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'
import type { LoggerPort } from '../ports/logger.js'

type StoreLogger = Pick<LoggerPort, 'error'>
type JournalEntry = {
  environment: string
  target: string
  original?: string
  temp: string
  replaced: boolean
}

const ENVIRONMENT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

export class VarsStore {
  private readonly varsPath: string
  private readonly repoPath: string

  constructor(
    repoPath: string,
    private readonly fs: IFileSystem,
    private readonly logger?: StoreLogger,
  ) {
    this.repoPath = repoPath
    this.varsPath = join(repoPath, 'vars')
  }

  async list(): Promise<string[]> {
    await this.ensureVarsPath(false)
    if (!(await this.fs.exists(this.varsPath))) return []
    const environments = (await this.fs.readDir(this.varsPath))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.slice(0, -5))
      .filter(isValidEnvironment)
      .sort()
    for (const environment of environments) await this.validateTargetFile(this.pathFor(environment))
    return environments
  }

  async read(environment: string): Promise<VarsEnvironment> {
    await this.ensureVarsPath(false)
    const target = this.pathFor(environment)
    await this.validateTargetFile(target)
    try {
      return parseVarsEnvironment(await this.fs.readFile(target))
    } catch (error) {
      if (isMissing(error)) throw environmentNotFound(error)
      throw error
    }
  }

  async create(environment: string, value: VarsEnvironment): Promise<void> {
    await this.ensureVarsPath(false)
    const target = this.pathFor(environment)
    await this.validateTargetFile(target)
    if (await this.fs.exists(target))
      throw Object.assign(new Error(`environment already exists: ${environment}`), {
        code: 'EEXIST',
      })
    await this.writeMany({ [environment]: value })
  }

  async delete(environment: string): Promise<void> {
    await this.ensureVarsPath(false)
    const target = this.pathFor(environment)
    await this.validateTargetFile(target)
    try {
      await this.fs.readFile(target)
      await this.fs.removeFile(target)
    } catch (error) {
      if (isMissing(error)) throw environmentNotFound(error)
      throw error
    }
  }

  async write(environment: string, value: VarsEnvironment): Promise<void> {
    await this.writeMany({ [environment]: value })
  }

  async writeMany(values: Record<string, VarsEnvironment>): Promise<string[]> {
    const environments = Object.keys(values).sort()
    const serialized = environments.map((environment) => ({
      environment,
      target: this.pathFor(environment),
      content: serializeVarsEnvironment(values[environment]!),
    }))
    await this.ensureVarsPath(true)
    for (const item of serialized) await this.validateTargetFile(item.target)
    const journal: JournalEntry[] = []
    let operationError: unknown
    const rollbackErrors: unknown[] = []
    try {
      for (const item of serialized) {
        let original: string | undefined
        try {
          original = await this.fs.readFile(item.target)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        if (original === item.content) continue
        const temp = await this.allocateTemporaryPath(item.environment)
        await this.fs.writeFile(temp, item.content)
        journal.push({
          environment: item.environment,
          target: item.target,
          original,
          temp,
          replaced: false,
        })
      }
      for (const item of journal) {
        await this.validateTargetFile(item.target)
        await this.fs.replaceFile(item.temp, item.target)
        item.replaced = true
      }
    } catch (error) {
      operationError = error
      for (const item of [...journal].reverse().filter((entry) => entry.replaced)) {
        try {
          if (item.original === undefined) await this.fs.removeFile(item.target)
          else {
            const restore = `${item.temp}.restore`
            await this.fs.writeFile(restore, item.original)
            await this.fs.replaceFile(restore, item.target)
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
          this.logger?.error('vars atomic rollback failed', {
            err: rollbackError,
            files: environments,
          })
        }
      }
      this.logger?.error('vars atomic write failed', { err: error, files: environments })
    }

    const cleanupErrors: unknown[] = []
    for (const path of journal.flatMap((item) => [item.temp, `${item.temp}.restore`])) {
      try {
        await this.fs.removeFile(path)
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) {
          cleanupErrors.push(cleanupError)
          this.logger?.error('vars temporary file cleanup failed', {
            err: cleanupError,
            files: environments,
          })
        }
      }
    }

    if (operationError !== undefined) {
      const secondaryErrors = [...rollbackErrors, ...cleanupErrors]
      if (secondaryErrors.length) {
        throw new AggregateError(
          [operationError, ...secondaryErrors],
          'vars atomic write, rollback, or cleanup failed',
          { cause: operationError },
        )
      }
      throw operationError
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'vars temporary file cleanup failed', {
        cause: cleanupErrors[0],
      })
    }
    return journal.map((item) => item.environment)
  }

  private pathFor(environment: string): string {
    if (!isValidEnvironment(environment) || isAbsolute(environment))
      throw new Error(`invalid environment name: ${environment}`)
    return join(this.varsPath, `${environment}.yaml`)
  }

  private async ensureVarsPath(create: boolean): Promise<void> {
    const repoRealPath = await this.fs.realPath(this.repoPath)
    if (!(await this.fs.exists(this.varsPath))) {
      if (!create) return
      await this.fs.mkdir(this.varsPath, true)
    }
    const varsRealPath = await this.fs.realPath(this.varsPath)
    if ((await this.fs.isLink(this.varsPath)) || varsRealPath !== join(repoRealPath, 'vars')) {
      const error = new Error(`invalid vars path: ${this.varsPath}`)
      this.logger?.error('vars path validation failed', { err: error, files: [] })
      throw error
    }
    try {
      await this.fs.readDir(this.varsPath)
    } catch (error) {
      const validationError = new Error(`invalid vars path: ${this.varsPath}`, { cause: error })
      this.logger?.error('vars path validation failed', { err: validationError, files: [] })
      throw validationError
    }
  }

  private async validateTargetFile(target: string): Promise<void> {
    if (await this.fs.isLink(target)) {
      const error = Object.assign(new Error(`vars environment symlink not allowed: ${target}`), {
        code: 'vars_symlink_not_allowed',
      })
      this.logger?.error('vars target validation failed', { err: error, files: [] })
      throw error
    }
    if (!(await this.fs.exists(target))) return
    const targetRealPath = await this.fs.realPath(target)
    const varsRealPath = await this.fs.realPath(this.varsPath)
    if (dirname(targetRealPath) !== varsRealPath) {
      const error = Object.assign(new Error(`invalid vars target path: ${target}`), {
        code: 'vars_target_invalid',
      })
      this.logger?.error('vars target validation failed', { err: error, files: [] })
      throw error
    }
  }

  private async allocateTemporaryPath(environment: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const path = join(this.varsPath, `.${environment}.tmp-${process.pid}-${crypto.randomUUID()}`)
      const restorePath = `${path}.restore`
      if (
        !(await this.fs.isLink(path)) &&
        !(await this.fs.exists(path)) &&
        !(await this.fs.isLink(restorePath)) &&
        !(await this.fs.exists(restorePath))
      )
        return path
    }
    throw new Error(`unable to allocate vars temporary file for ${environment}`)
  }
}

function isValidEnvironment(value: string): boolean {
  return value !== '.' && value !== '..' && ENVIRONMENT_NAME.test(value) && !value.includes('..')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function environmentNotFound(cause: unknown): Error {
  return Object.assign(new Error('environment not found', { cause }), {
    code: 'environment_not_found',
  })
}
