import { join, dirname } from 'node:path'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import { threeWayMerge, type MergeResult, type Kind } from '@loom/core'
import type { TextFileConflict } from './conflicts.js'

const STRUCT_FILES: { path: string; kind: Kind }[] = [
  { path: 'skills.yaml', kind: 'skills' },
  { path: 'mcp.yaml', kind: 'mcp' },
  { path: 'config.yaml', kind: 'config' },
]

export interface PullFileResult {
  path: string
  result: MergeResult
}
export interface PullResult {
  files: PullFileResult[]
  varsFiles: PullFileResult[]
  textConflicts: TextFileConflict[]
  clean: boolean
}

type Logger = {
  error: (obj: unknown, msg: string) => void
  warn?: (obj: unknown, msg: string) => void
}

export async function syncPull(
  repoPath: string,
  git: IGit,
  fs: IFileSystem,
  logger?: Logger,
): Promise<PullResult> {
  // Auto-commit uncommitted changes before pulling so they're not lost
  const status = await git.status(repoPath)
  if (status.dirty) {
    try {
      await git.add(repoPath, ['.'])
    } catch {
      /* skip */
    }
    try {
      await git.commit(repoPath, 'loom: auto-commit before pull')
    } catch {
      /* nothing to commit */
    }
  }

  await git.fetch(repoPath)

  // Check if local HEAD exists (empty repo with no commits yet)
  let headExists = true
  try {
    await git.revParseHead(repoPath)
  } catch {
    headExists = false
  }

  if (!headExists) {
    // Initial pull: fast-forward to remote, reset working tree
    const remoteTip = await git.revParse(repoPath, 'FETCH_HEAD')
    await git.updateRef(repoPath, 'HEAD', remoteTip)
    await git.resetHard(repoPath, 'FETCH_HEAD')
    return { files: [], varsFiles: [], textConflicts: [], clean: true }
  }

  let base: string
  try {
    base = await git.mergeBase(repoPath, 'FETCH_HEAD', 'HEAD')
  } catch {
    // FETCH_HEAD not set (remote is empty or fetch failed)
    return { files: [], varsFiles: [], textConflicts: [], clean: true }
  }

  const files: PullFileResult[] = []
  for (const { path, kind } of STRUCT_FILES) {
    const baseText = await safeShow(git, repoPath, base, path, logger)
    const oursText = await safeShow(git, repoPath, 'HEAD', path, logger)
    const theirsText = await safeShow(git, repoPath, 'FETCH_HEAD', path, logger)
    files.push({ path, result: threeWayMerge(baseText, oursText, theirsText, kind) })
  }

  const varsPaths = await listVarsFilesUnion(git, repoPath, base, logger)
  const varsFiles: PullFileResult[] = []
  for (const p of varsPaths) {
    const baseText = await safeShow(git, repoPath, base, p, logger)
    const oursText = await safeShow(git, repoPath, 'HEAD', p, logger)
    const theirsText = await safeShow(git, repoPath, 'FETCH_HEAD', p, logger)
    varsFiles.push({ path: p, result: threeWayMerge(baseText, oursText, theirsText, 'vars') })
  }

  const textConflicts = await detectTextConflicts(git, repoPath, base, logger)

  const allResults = [...files, ...varsFiles]
  const clean =
    allResults.every((f) => f.result.conflicts.length === 0) && textConflicts.length === 0

  if (clean) {
    for (const f of allResults) {
      const dest = join(repoPath, f.path)
      const dir = dirname(dest)
      if (!(await fs.exists(dir))) await fs.mkdir(dir, true)
      await fs.writeFile(dest, f.result.merged)
    }
    await git.add(
      repoPath,
      allResults.map((f) => f.path),
    )
    // Produce a commit that is a descendant of FETCH_HEAD so the subsequent
    // push is fast-forward. If local HEAD == merge-base (pure fast-forward,
    // no local commits), just move the ref to FETCH_HEAD. Otherwise create a
    // real merge commit with two parents (HEAD + FETCH_HEAD).
    const head = await git.revParseHead(repoPath)
    const remoteTip = await git.revParse(repoPath, 'FETCH_HEAD')
    if (head === base) {
      await git.updateRef(repoPath, 'HEAD', remoteTip)
      await git.checkout(repoPath, '.')
    } else {
      const tree = await git.writeTree(repoPath)
      const mergeCommit = await git.commitTree(
        repoPath,
        tree,
        [head, remoteTip],
        'merge: pull from origin',
      )
      await git.updateRef(repoPath, 'HEAD', mergeCommit)
      await git.checkout(repoPath, '.')
    }
  }

  return { files, varsFiles, textConflicts, clean }
}

async function safeShow(
  git: IGit,
  repoPath: string,
  ref: string,
  path: string,
  logger?: Logger,
): Promise<string> {
  try {
    return await git.show(repoPath, ref, path)
  } catch (e) {
    logger?.warn?.({ err: e, ref, path }, 'git show miss (file absent at ref)')
    return ''
  }
}

async function listVarsFilesUnion(
  git: IGit,
  repoPath: string,
  base: string,
  logger?: Logger,
): Promise<string[]> {
  const all = new Set<string>()
  for (const ref of [base, 'HEAD', 'FETCH_HEAD']) {
    try {
      for (const f of await git.lsTree(repoPath, ref, 'vars'))
        all.add(f.startsWith('vars/') ? f : `vars/${f}`)
    } catch (e) {
      logger?.warn?.({ err: e, ref }, 'ls-tree vars miss')
    }
  }
  return [...all]
}

async function detectTextConflicts(
  git: IGit,
  repoPath: string,
  base: string,
  logger?: Logger,
): Promise<TextFileConflict[]> {
  const out: TextFileConflict[] = []
  const allAssets = new Set<string>()
  for (const ref of [base, 'HEAD', 'FETCH_HEAD']) {
    try {
      for (const f of await git.lsTree(repoPath, ref, 'assets'))
        allAssets.add(f.startsWith('assets/') ? f : `assets/${f}`)
    } catch (e) {
      logger?.warn?.({ err: e, ref }, 'ls-tree assets miss')
    }
  }
  for (const p of allAssets) {
    const b = await safeShow(git, repoPath, base, p, logger)
    const o = await safeShow(git, repoPath, 'HEAD', p, logger)
    const t = await safeShow(git, repoPath, 'FETCH_HEAD', p, logger)
    if (o !== b && t !== b && o !== t) out.push({ file: p, base: b, ours: o, theirs: t })
  }
  return out
}

// Re-run merge with resolutions applied, then write + commit
export async function applyResolutions(
  repoPath: string,
  git: IGit,
  fs: IFileSystem,
  resolutions: Record<string, 'ours' | 'theirs'>,
  logger?: Logger,
): Promise<{ ok: boolean }> {
  await git.fetch(repoPath)
  const base = await git.mergeBase(repoPath, 'FETCH_HEAD', 'HEAD')
  const allResults: PullFileResult[] = []

  for (const { path, kind } of STRUCT_FILES) {
    const baseText = await safeShow(git, repoPath, base, path, logger)
    const oursText = await safeShow(git, repoPath, 'HEAD', path, logger)
    const theirsText = await safeShow(git, repoPath, 'FETCH_HEAD', path, logger)
    allResults.push({ path, result: threeWayMerge(baseText, oursText, theirsText, kind) })
  }

  const varsPaths = await listVarsFilesUnion(git, repoPath, base, logger)
  for (const p of varsPaths) {
    const baseText = await safeShow(git, repoPath, base, p, logger)
    const oursText = await safeShow(git, repoPath, 'HEAD', p, logger)
    const theirsText = await safeShow(git, repoPath, 'FETCH_HEAD', p, logger)
    allResults.push({ path: p, result: threeWayMerge(baseText, oursText, theirsText, 'vars') })
  }

  // For conflicts resolved as 'theirs', replace ours with theirs in the merged text.
  // The merged text already has ours as default. We do a text-level replacement
  // of the ours value with the theirs value for each resolved conflict.
  for (const f of allResults) {
    for (const c of f.result.conflicts) {
      const key = `${c.file}:${c.path}:${c.field}`
      if (resolutions[key] !== 'theirs') continue
      const oursStr = String(c.ours)
      const theirsStr = String(c.theirs)
      if (oursStr !== theirsStr) {
        f.result.merged = f.result.merged.replace(oursStr, theirsStr)
      }
    }
  }

  // Write files
  for (const f of allResults) {
    const dest = join(repoPath, f.path)
    const dir = dirname(dest)
    if (!(await fs.exists(dir))) await fs.mkdir(dir, true)
    await fs.writeFile(dest, f.result.merged)
  }
  await git.add(
    repoPath,
    allResults.map((f) => f.path),
  )

  // Create merge commit
  const head = await git.revParseHead(repoPath)
  const remoteTip = await git.revParse(repoPath, 'FETCH_HEAD')
  if (head === base) {
    await git.updateRef(repoPath, 'HEAD', remoteTip)
    await git.resetHard(repoPath, 'FETCH_HEAD')
    // Re-write resolved files on top of remote tip
    for (const f of allResults) {
      if (f.result.conflicts.length > 0) {
        await fs.writeFile(join(repoPath, f.path), f.result.merged)
      }
    }
    await git.add(
      repoPath,
      allResults.filter((f) => f.result.conflicts.length > 0).map((f) => f.path),
    )
    if (allResults.some((f) => f.result.conflicts.length > 0)) {
      await git.commit(repoPath, 'merge: resolve conflicts')
    }
  } else {
    const tree = await git.writeTree(repoPath)
    const mergeCommit = await git.commitTree(
      repoPath,
      tree,
      [head, remoteTip],
      'merge: resolve conflicts',
    )
    await git.updateRef(repoPath, 'HEAD', mergeCommit)
    await git.resetHard(repoPath, 'HEAD')
  }

  return { ok: true }
}
