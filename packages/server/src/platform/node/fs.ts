import {
  constants,
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
  readlink,
  rmdir,
  open,
  link,
} from 'node:fs/promises'
import { basename, join, isAbsolute, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  FileSystemDestinationExistsError,
  type FileSystemEntry,
  type IFileSystem,
} from '../../ports/fs.js'
import { renameDirectoryNoReplace } from './exclusive-rename.js'

export interface FsOptions {
  forceLinkError?: string | null
  rename?: (from: string, to: string) => Promise<void>
  renameNoReplace?: (from: string, to: string) => Promise<void>
  beforeRenameNoReplace?: (from: string, to: string) => Promise<void>
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

  async writeFileBytes(path: string, content: Uint8Array, mode?: number): Promise<void> {
    await fsWriteFile(path, content, mode === undefined ? undefined : { mode })
  }

  async writeFileExclusive(path: string, content: string, mode?: number): Promise<FileSystemEntry> {
    return this.writeExclusive(path, content, mode)
  }

  async writeFileBytesExclusive(
    path: string,
    content: Uint8Array,
    mode?: number,
  ): Promise<FileSystemEntry> {
    return this.writeExclusive(path, content, mode)
  }

  private async writeExclusive(
    path: string,
    content: string | Uint8Array,
    mode?: number,
  ): Promise<FileSystemEntry> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      mode,
    )
    let identity: string | undefined
    let result: FileSystemEntry | undefined
    let operationError: unknown
    try {
      const created = await handle.stat()
      identity = `${created.dev}:${created.ino}`
      if (typeof content === 'string') await handle.writeFile(content, 'utf8')
      else await handle.writeFile(content)
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error(`Exclusive file is not regular: ${path}`)
      result = { kind: 'file', identity: `${stat.dev}:${stat.ino}`, linkCount: stat.nlink }
    } catch (error) {
      operationError = error
    }

    const cleanupErrors = await collectCleanupErrors([() => handle.close()])
    if (operationError && identity) {
      cleanupErrors.push(
        ...(await collectCleanupErrors([() => this.removeEntryIfIdentity(path, identity)])),
      )
    }
    if (operationError) {
      throwWithCleanupErrors(
        operationError,
        cleanupErrors,
        'exclusive file write and cleanup failed',
      )
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
    return result!
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

  async copyFileNoFollow(src: string, dest: string, expectedIdentity: string): Promise<void> {
    await fsMkdir(dirname(dest), { recursive: true })
    const source = await open(src, constants.O_RDONLY | noFollowFlag())
    let destination: Awaited<ReturnType<typeof open>> | undefined
    let destinationIdentity: string | undefined
    let operationError: unknown
    try {
      const before = await source.stat()
      const identity = `${before.dev}:${before.ino}`
      if (!before.isFile() || before.nlink !== 1 || identity !== expectedIdentity) {
        throw new Error(`refuse to copy unstable regular file: ${src}`)
      }
      destination = await open(
        dest,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        before.mode,
      )
      const created = await destination.stat()
      destinationIdentity = `${created.dev}:${created.ino}`
      await destination.writeFile(await source.readFile())
      const after = await source.stat()
      if (
        `${after.dev}:${after.ino}` !== identity ||
        after.nlink !== 1 ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error(`source file changed while copying: ${src}`)
      }
    } catch (error) {
      operationError = error
    }

    const openedDestination = destination
    destination = undefined
    const cleanupErrors = await collectCleanupErrors([
      ...(openedDestination ? [() => openedDestination.close()] : []),
      () => source.close(),
    ])
    if (operationError && destinationIdentity) {
      cleanupErrors.push(
        ...(await collectCleanupErrors([
          () => this.removeEntryIfIdentity(dest, destinationIdentity),
        ])),
      )
    }
    if (operationError) {
      throwWithCleanupErrors(operationError, cleanupErrors, 'file copy and cleanup failed')
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }

  async move(src: string, dest: string): Promise<void> {
    await fsMkdir(dirname(dest), { recursive: true })
    await this.renameWithRetry(src, dest)
  }

  async moveNoReplace(
    src: string,
    dest: string,
    expectedIdentity?: string,
  ): Promise<FileSystemEntry> {
    const destinationParent = await lstat(dirname(dest))
    if (!destinationParent.isDirectory() || destinationParent.isSymbolicLink()) {
      throw new Error(`Destination parent is not a physical directory: ${dirname(dest)}`)
    }
    const source = await lstat(src)
    const sourceIdentity = `${source.dev}:${source.ino}`
    if (expectedIdentity && sourceIdentity !== expectedIdentity) {
      throw new Error(`Source identity changed before move: ${src}`)
    }

    if (source.isDirectory() && !source.isSymbolicLink()) {
      return this.moveDirectoryNoReplace(src, dest, sourceIdentity, source.mode)
    }
    if (source.isSymbolicLink()) {
      return this.moveLinkNoReplace(src, dest, sourceIdentity)
    }
    if (source.isFile()) {
      return this.moveFileNoReplace(src, dest, sourceIdentity)
    }
    throw new Error(`Refuse to move unsupported filesystem entry: ${src}`)
  }

  async moveDirectoryAtomic(
    src: string,
    dest: string,
    expectedIdentity: string,
  ): Promise<FileSystemEntry> {
    const destinationParent = await lstat(dirname(dest))
    if (!destinationParent.isDirectory() || destinationParent.isSymbolicLink()) {
      throw new Error(`Destination parent is not a physical directory: ${dirname(dest)}`)
    }
    const source = await lstat(src)
    const sourceIdentity = `${source.dev}:${source.ino}`
    if (!source.isDirectory() || source.isSymbolicLink() || sourceIdentity !== expectedIdentity) {
      throw new Error(`Source directory identity changed before atomic move: ${src}`)
    }
    if (await this.inspectEntry(dest)) {
      throw new FileSystemDestinationExistsError(dest)
    }

    try {
      await this.opts.beforeRenameNoReplace?.(src, dest)
      if ((this.opts.platform ?? process.platform) === 'win32') {
        await this.renameWithRetry(src, dest)
      } else {
        await (this.opts.renameNoReplace ?? renameDirectoryNoReplace)(src, dest)
      }
    } catch (error) {
      const [sourceAfterFailure, destinationAfterFailure] = await Promise.all([
        this.inspectEntry(src),
        this.inspectEntry(dest),
      ])
      if (
        !sourceAfterFailure &&
        destinationAfterFailure?.kind === 'directory' &&
        destinationAfterFailure.identity === expectedIdentity
      ) {
        return destinationAfterFailure
      }
      if (isDestinationConflict(error) || destinationAfterFailure) {
        throw new FileSystemDestinationExistsError(dest, { cause: error })
      }
      throw error
    }
    const moved = await this.inspectEntry(dest)
    if (moved?.kind !== 'directory' || moved.identity !== expectedIdentity) {
      throw new Error(`Atomic directory move identity changed: ${dest}`)
    }
    return moved
  }

  private async moveDirectoryNoReplace(
    src: string,
    dest: string,
    sourceIdentity: string,
    mode: number,
  ): Promise<FileSystemEntry> {
    try {
      await fsMkdir(dest, { recursive: false, mode })
    } catch (error) {
      if (isDestinationConflict(error) || (await this.inspectEntry(dest))) {
        throw new FileSystemDestinationExistsError(dest, { cause: error })
      }
      throw error
    }
    const destination = await this.inspectEntry(dest)
    if (destination?.kind !== 'directory') {
      throw new Error(`Failed to reserve destination directory: ${dest}`)
    }

    const moved: Array<{ name: string; identity: string }> = []
    let rollbackSourceIdentity = sourceIdentity
    try {
      await this.assertIdentity(src, 'directory', sourceIdentity)
      for (const name of await readdir(src)) {
        await this.assertIdentity(src, 'directory', sourceIdentity)
        const child = await this.inspectEntry(join(src, name))
        if (!child) throw new Error(`Directory child disappeared during move: ${join(src, name)}`)
        const installed = await this.moveNoReplace(
          join(src, name),
          join(dest, name),
          child.identity,
        )
        moved.push({ name, identity: installed.identity })
      }
      await this.assertIdentity(src, 'directory', sourceIdentity)
      await this.removeEmptyDirectoryIfIdentity(src, sourceIdentity)
      return destination
    } catch (error) {
      if (error instanceof RestoredEmptyDirectoryError) {
        rollbackSourceIdentity = error.restoredIdentity
      }
      const rollbackErrors: unknown[] = []
      try {
        await this.assertIdentity(src, 'directory', rollbackSourceIdentity)
        await this.assertIdentity(dest, 'directory', destination.identity)
        for (const child of [...moved].reverse()) {
          await this.moveNoReplace(join(dest, child.name), join(src, child.name), child.identity)
        }
        await this.removeEmptyDirectoryIfIdentity(dest, destination.identity)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'directory move and rollback failed', {
          cause: error,
        })
      }
      throw error
    }
  }

  private async removeEmptyDirectoryIfIdentity(
    path: string,
    expectedIdentity: string,
  ): Promise<void> {
    const before = await this.inspectEntry(path)
    if (before?.kind !== 'directory' || before.identity !== expectedIdentity) {
      throw new Error(`Directory identity changed before empty removal: ${path}`)
    }
    const quarantine = join(
      dirname(path),
      `.${basename(path)}.loom-remove-${process.pid}-${crypto.randomUUID()}`,
    )
    await this.renameWithRetry(path, quarantine)
    const isolated = await this.inspectEntry(quarantine)
    if (isolated?.kind !== 'directory' || isolated.identity !== expectedIdentity) {
      const errors: unknown[] = [new Error(`Directory changed while isolating: ${path}`)]
      if (isolated) {
        try {
          await this.moveNoReplace(quarantine, path, isolated.identity)
        } catch (restoreError) {
          errors.push(restoreError)
        }
      }
      throw new AggregateError(errors, 'empty directory isolation failed', { cause: errors[0] })
    }
    try {
      await rmdir(quarantine)
    } catch (error) {
      let restored: FileSystemEntry
      try {
        restored = await this.moveNoReplace(quarantine, path, expectedIdentity)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'empty directory removal and restore failed',
          { cause: error },
        )
      }
      throw new RestoredEmptyDirectoryError(path, restored.identity, { cause: error })
    }
  }

  private async moveLinkNoReplace(
    src: string,
    dest: string,
    sourceIdentity: string,
  ): Promise<FileSystemEntry> {
    const target = await readlink(src)
    await this.assertIdentity(src, 'link', sourceIdentity)
    try {
      const targetKind = (await stat(src)).isDirectory() ? 'junction' : 'file'
      await symlink(target, dest, process.platform === 'win32' ? targetKind : undefined)
    } catch (error) {
      if (isDestinationConflict(error) || (await this.inspectEntry(dest))) {
        throw new FileSystemDestinationExistsError(dest, { cause: error })
      }
      throw error
    }
    const destination = await this.inspectEntry(dest)
    if (destination?.kind !== 'link') throw new Error(`Moved link is unavailable: ${dest}`)
    try {
      await this.assertIdentity(src, 'link', sourceIdentity)
      await this.removeEntryIfIdentity(src, sourceIdentity)
      return destination
    } catch (error) {
      const cleanupErrors = await collectCleanupErrors([
        () => this.removeEntryIfIdentity(dest, destination.identity),
      ])
      throwWithCleanupErrors(error, cleanupErrors, 'link move and rollback failed')
    }
  }

  private async moveFileNoReplace(
    src: string,
    dest: string,
    sourceIdentity: string,
  ): Promise<FileSystemEntry> {
    try {
      await link(src, dest)
    } catch (error) {
      if (isDestinationConflict(error) || (await this.inspectEntry(dest))) {
        throw new FileSystemDestinationExistsError(dest, { cause: error })
      }
      throw error
    }
    try {
      await this.assertIdentity(src, 'file', sourceIdentity)
      await this.assertIdentity(dest, 'file', sourceIdentity)
      await this.removeEntryIfIdentity(src, sourceIdentity)
      const destination = await this.inspectEntry(dest)
      if (destination?.kind !== 'file' || destination.identity !== sourceIdentity) {
        throw new Error(`Moved file is unavailable: ${dest}`)
      }
      return destination
    } catch (error) {
      const cleanupErrors = await collectCleanupErrors([
        () => this.removeEntryIfIdentity(dest, sourceIdentity),
      ])
      throwWithCleanupErrors(error, cleanupErrors, 'file move and rollback failed')
    }
  }

  private async assertIdentity(
    path: string,
    kind: FileSystemEntry['kind'],
    identity: string,
  ): Promise<void> {
    const entry = await this.inspectEntry(path)
    if (!entry || entry.kind !== kind || entry.identity !== identity) {
      throw new Error(`Filesystem entry identity changed: ${path}`)
    }
  }

  private async renameWithRetry(src: string, dest: string): Promise<void> {
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

  async removeEntryIfIdentity(path: string, expectedIdentity: string): Promise<void> {
    const before = await this.inspectEntry(path)
    if (!before || before.identity !== expectedIdentity) {
      throw new Error(`Filesystem entry identity changed before removal: ${path}`)
    }
    const quarantine = join(
      dirname(path),
      `.${basename(path)}.loom-remove-${process.pid}-${crypto.randomUUID()}`,
    )
    await this.renameWithRetry(path, quarantine)
    const isolated = await this.inspectEntry(quarantine)
    if (!isolated || isolated.kind !== before.kind || isolated.identity !== expectedIdentity) {
      const errors: unknown[] = [new Error(`Filesystem entry changed while isolating: ${path}`)]
      if (isolated) {
        try {
          await this.moveNoReplace(quarantine, path, isolated.identity)
        } catch (restoreError) {
          errors.push(restoreError)
        }
      }
      throw new AggregateError(errors, 'filesystem entry isolation failed', { cause: errors[0] })
    }
    try {
      if (isolated.kind === 'link') await this.removeLink(quarantine)
      else if (isolated.kind === 'directory') await this.removeDir(quarantine)
      else if (isolated.kind === 'file') await this.removeFile(quarantine)
      else throw new Error(`Refuse to remove unsupported filesystem entry: ${path}`)
    } catch (error) {
      const restoreErrors: unknown[] = []
      try {
        const current = await this.inspectEntry(quarantine)
        if (current) {
          if (current.kind !== isolated.kind || current.identity !== expectedIdentity) {
            throw new Error(`Filesystem entry changed after failed removal: ${path}`)
          }
          await this.moveNoReplace(quarantine, path, expectedIdentity)
        }
      } catch (restoreError) {
        restoreErrors.push(restoreError)
      }
      if (restoreErrors.length > 0) {
        throw new AggregateError(
          [error, ...restoreErrors],
          'filesystem entry removal and restore failed',
          { cause: error },
        )
      }
      throw error
    }
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

  async replaceFileIfIdentity(
    tempPath: string,
    targetPath: string,
    expectedTargetIdentity: string | null,
  ): Promise<FileSystemEntry> {
    const temporary = await this.inspectEntry(tempPath)
    if (temporary?.kind !== 'file') throw new Error(`Replacement file is unavailable: ${tempPath}`)
    const current = await this.inspectEntry(targetPath)
    if (
      (expectedTargetIdentity === null && current) ||
      (expectedTargetIdentity !== null &&
        (current?.kind !== 'file' || current.identity !== expectedTargetIdentity))
    ) {
      throw new Error(`Replacement target identity changed: ${targetPath}`)
    }
    if (expectedTargetIdentity === null) {
      return this.moveNoReplace(tempPath, targetPath, temporary.identity)
    }

    const backupPath = `${targetPath}.loom-replace-${process.pid}-${crypto.randomUUID()}`
    await this.moveNoReplace(targetPath, backupPath, expectedTargetIdentity)
    let installed: FileSystemEntry | null = null
    try {
      installed = await this.moveNoReplace(tempPath, targetPath, temporary.identity)
      await this.removeEntryIfIdentity(backupPath, expectedTargetIdentity)
      return installed
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (installed) {
        try {
          await this.removeEntryIfIdentity(targetPath, installed.identity)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (!(await this.inspectEntry(targetPath))) {
        try {
          await this.moveNoReplace(backupPath, targetPath, expectedTargetIdentity)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'file replacement and rollback failed',
          {
            cause: error,
          },
        )
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

  async inspectEntry(path: string): Promise<FileSystemEntry | null> {
    try {
      const entry = await lstat(path)
      const kind = entry.isSymbolicLink()
        ? 'link'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other'
      return { kind, identity: `${entry.dev}:${entry.ino}`, linkCount: entry.nlink }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async readLink(path: string): Promise<string> {
    return readlink(path)
  }
}

async function collectCleanupErrors(operations: Array<() => Promise<unknown>>): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const operation of operations) {
    try {
      await operation()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function throwWithCleanupErrors(
  primaryError: unknown,
  cleanupErrors: unknown[],
  message: string,
): never {
  if (cleanupErrors.length === 0) throw primaryError
  throw new AggregateError([primaryError, ...cleanupErrors], message, { cause: primaryError })
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isTransientWindowsFileLock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'ENOTEMPTY'
}

function isDestinationConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'EEXIST' || error.code === 'ENOTEMPTY' || error.code === 'EISDIR'
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
}

class RestoredEmptyDirectoryError extends Error {
  constructor(
    path: string,
    readonly restoredIdentity: string,
    options?: ErrorOptions,
  ) {
    super(`Directory was not empty during move: ${path}`, options)
    this.name = 'RestoredEmptyDirectoryError'
  }
}

function resolveAbs(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p)
}
