import { join } from 'node:path'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type { LoggerPort } from '../ports/logger.js'

export interface GitConflictFile {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string | null
  binary: boolean
}

export interface PullResult {
  clean: boolean
  conflicts: GitConflictFile[]
}

type Logger = Pick<LoggerPort, 'error' | 'warn'>

const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})(?: |$)/m

export async function syncPull(
  repoPath: string,
  git: IGit,
  fs: IFileSystem,
  logger?: Logger,
): Promise<PullResult> {
  const existingConflicts = await git.unmergedPaths(repoPath)
  if (existingConflicts.length > 0) {
    return {
      clean: false,
      conflicts: await readConflicts(repoPath, git, fs, logger, existingConflicts),
    }
  }

  const status = await git.status(repoPath)
  if (status.dirty) {
    try {
      await git.add(repoPath, ['.'])
      await git.commit(repoPath, 'loom: auto-commit before pull')
    } catch (err) {
      logger?.error('auto-commit before pull failed', { err, repoPath })
      throw err
    }
  }

  await git.fetch(repoPath)

  try {
    await git.revParseHead(repoPath)
  } catch {
    const remoteTip = await git.revParse(repoPath, 'FETCH_HEAD')
    await git.updateRef(repoPath, 'HEAD', remoteTip)
    await git.resetHard(repoPath, 'FETCH_HEAD')
    return { clean: true, conflicts: [] }
  }

  const remoteTip = await git.revParse(repoPath, 'FETCH_HEAD')
  const merge = await git.merge(repoPath, remoteTip)
  if (merge.clean) return { clean: true, conflicts: [] }

  return { clean: false, conflicts: await readConflicts(repoPath, git, fs, logger) }
}

export async function saveConflict(
  repoPath: string,
  git: IGit,
  fs: IFileSystem,
  path: string,
  result: string,
): Promise<{ clean: boolean; remaining: GitConflictFile[] }> {
  const unmerged = await git.unmergedPaths(repoPath)
  if (!unmerged.includes(path)) throw new Error(`不是当前冲突文件: ${path}`)
  if (CONFLICT_MARKER.test(result)) throw new Error('结果仍包含未解决的冲突标记')

  await fs.writeFile(join(repoPath, path), result)
  await git.add(repoPath, [path])

  const remainingPaths = await git.unmergedPaths(repoPath)
  if (remainingPaths.length === 0) {
    await git.commit(repoPath, 'merge: resolve conflicts')
    return { clean: true, remaining: [] }
  }

  return {
    clean: false,
    remaining: await readConflicts(repoPath, git, fs, undefined, remainingPaths),
  }
}

export async function abortConflictMerge(repoPath: string, git: IGit): Promise<void> {
  await git.abortMerge(repoPath)
}

async function readConflicts(
  repoPath: string,
  git: IGit,
  fs: IFileSystem,
  logger?: Logger,
  paths?: string[],
): Promise<GitConflictFile[]> {
  const conflictPaths = paths ?? (await git.unmergedPaths(repoPath))
  return Promise.all(
    conflictPaths.map(async (path) => {
      const [base, ours, theirs] = await Promise.all([
        git.showIndexStage(repoPath, 1, path),
        git.showIndexStage(repoPath, 2, path),
        git.showIndexStage(repoPath, 3, path),
      ])
      let result: string | null = null
      try {
        result = await fs.readFile(join(repoPath, path))
      } catch (err) {
        logger?.warn?.('conflict worktree file unavailable', { err, repoPath, path })
      }
      return {
        path,
        base,
        ours,
        theirs,
        result,
        binary: [base, ours, theirs, result].some((text) => text?.includes('\0') ?? false),
      }
    }),
  )
}
