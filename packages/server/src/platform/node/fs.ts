import {
  symlink,
  rm,
  readFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  readdir,
  stat,
  lstat,
  copyFile,
  rename,
  realpath,
  rmdir,
} from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { IFileSystem } from '../../ports/fs.js'

export interface FsOptions {
  forceLinkError?: string | null
  rename?: (from: string, to: string) => Promise<void>
  rmdir?: (path: string) => Promise<void>
  platform?: NodeJS.Platform
}

export class NodeFileSystem implements IFileSystem {
  constructor(private opts: FsOptions = {}) {}

  async createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }> {
    // Check isLink (lstat) before exists (stat): a broken symlink has no
    // resolvable target so exists() returns false, but it is still a link
    // on disk that we must replace rather than let symlink() hit EEXIST.
    if (await this.isLink(linkPath)) {
      await this.removeLink(linkPath)
    } else if (await this.exists(linkPath)) {
      throw new Error(`refuse to overwrite real file: ${linkPath}`)
    }
    const absTarget = resolveAbs(targetDir)
    const absLink = resolveAbs(linkPath)
    try {
      if (this.opts.forceLinkError) {
        throw Object.assign(new Error('simulated'), { code: this.opts.forceLinkError })
      }
      if (process.platform === 'win32') {
        await symlink(absTarget, absLink, 'junction')
      } else {
        await symlink(absTarget, absLink, 'dir')
      }
      return { fallback: null }
    } catch (e: any) {
      if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'ENOSYS') {
        await this.copyDir(absTarget, absLink)
        return { fallback: 'copy' }
      }
      throw e
    }
  }

  async createFileLink(targetFile: string, linkPath: string): Promise<{ fallback: 'copy' | null }> {
    if (await this.isLink(linkPath)) {
      await this.removeLink(linkPath)
    } else if (await this.exists(linkPath)) {
      throw new Error(`refuse to overwrite real file: ${linkPath}`)
    }
    const absTarget = resolveAbs(targetFile)
    const absLink = resolveAbs(linkPath)
    await fsMkdir(dirname(absLink), { recursive: true })
    try {
      if (this.opts.forceLinkError) {
        throw Object.assign(new Error('simulated'), { code: this.opts.forceLinkError })
      }
      await symlink(absTarget, absLink, 'file')
      return { fallback: null }
    } catch (error: any) {
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'ENOSYS') {
        await copyFile(absTarget, absLink)
        return { fallback: 'copy' }
      }
      throw error
    }
  }

  async removeLink(linkPath: string): Promise<void> {
    if (!(await this.isLink(linkPath))) return
    // Bun on Windows returns EFAULT for rm(..., { recursive: false }) on junctions.
    // rmdir removes the junction entry without traversing into its target.
    if ((this.opts.platform ?? process.platform) === 'win32') {
      await (this.opts.rmdir ?? rmdir)(linkPath)
      return
    }
    await rm(linkPath, { recursive: false, force: true })
  }

  async isLink(path: string): Promise<boolean> {
    try {
      const s = await lstat(path)
      return s.isSymbolicLink()
    } catch {
      return false
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fsWriteFile(path, content, 'utf8')
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await fsMkdir(path, { recursive })
  }

  async readDir(path: string): Promise<string[]> {
    return readdir(path)
  }

  // Public intentionally: Plan 2 Task 0 exposes this via IFileSystem.
  async copyDir(src: string, dest: string): Promise<void> {
    await fsMkdir(dest, { recursive: true })
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const s = join(src, entry.name)
      const d = join(dest, entry.name)
      if (entry.isDirectory()) {
        await this.copyDir(s, d)
      } else {
        await copyFile(s, d)
      }
    }
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await fsMkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest)
  }

  async move(src: string, dest: string): Promise<void> {
    await fsMkdir(dirname(dest), { recursive: true })
    const move = this.opts.rename ?? rename
    const attempts = (this.opts.platform ?? process.platform) === 'win32' ? 5 : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await move(src, dest)
        return
      } catch (error) {
        lastError = error
        if (!isTransientWindowsFileLock(error) || attempt === attempts - 1) throw error
        await delay(300 * (attempt + 1))
      }
    }
    throw lastError
  }

  async removeDir(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true })
  }

  async replaceFile(tempPath: string, targetPath: string): Promise<void> {
    await fsMkdir(dirname(targetPath), { recursive: true })
    if ((this.opts.platform ?? process.platform) !== 'win32') {
      await (this.opts.rename ?? rename)(tempPath, targetPath)
      return
    }
    const backupPath = `${targetPath}.replace-backup-${process.pid}-${crypto.randomUUID()}`
    let backedUp = false
    try {
      try {
        await (this.opts.rename ?? rename)(targetPath, backupPath)
        backedUp = true
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      await (this.opts.rename ?? rename)(tempPath, targetPath)
      if (backedUp) await rm(backupPath, { force: true })
    } catch (error) {
      if (backedUp) {
        try {
          await rm(targetPath, { force: true })
          await (this.opts.rename ?? rename)(backupPath, targetPath)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'file replacement and rollback failed', {
            cause: error,
          })
        }
      }
      throw error
    }
  }

  async removeFile(path: string): Promise<void> {
    try {
      const entry = await lstat(path)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error(`refuse to remove directory as file: ${path}`)
      }
      await rm(path, { recursive: false, force: true })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  async realPath(path: string): Promise<string> {
    return realpath(path)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isTransientWindowsFileLock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'ENOTEMPTY'
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}
