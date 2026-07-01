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
} from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { IFileSystem } from '../interfaces.js'

export interface FsOptions {
  forceLinkError?: string | null
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

  async removeLink(linkPath: string): Promise<void> {
    if (!(await this.isLink(linkPath))) return
    // recursive:false ensures we never recurse into the link target.
    // On Windows junctions this avoids deleting real target contents.
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
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}
