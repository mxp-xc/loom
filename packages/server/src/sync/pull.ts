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

export interface PullFileResult { path: string; result: MergeResult }
export interface PullResult {
  files: PullFileResult[]
  varsFiles: PullFileResult[]
  textConflicts: TextFileConflict[]
  clean: boolean
}

type Logger = { error: (obj: unknown, msg: string) => void; warn?: (obj: unknown, msg: string) => void }

export async function syncPull(repoPath: string, git: IGit, fs: IFileSystem, logger?: Logger): Promise<PullResult> {
  await git.fetch(repoPath)
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
  const clean = allResults.every(f => f.result.conflicts.length === 0) && textConflicts.length === 0

  if (clean) {
    for (const f of allResults) {
      const dest = join(repoPath, f.path)
      const dir = dirname(dest)
      if (!(await fs.exists(dir))) await fs.mkdir(dir, true)
      await fs.writeFile(dest, f.result.merged)
    }
    await git.add(repoPath, allResults.map(f => f.path))
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
      const mergeCommit = await git.commitTree(repoPath, tree, [head, remoteTip], 'merge: pull from origin')
      await git.updateRef(repoPath, 'HEAD', mergeCommit)
      await git.checkout(repoPath, '.')
    }
  }

  return { files, varsFiles, textConflicts, clean }
}

async function safeShow(git: IGit, repoPath: string, ref: string, path: string, logger?: Logger): Promise<string> {
  try { return await git.show(repoPath, ref, path) }
  catch (e) { logger?.warn?.({ err: e, ref, path }, 'git show miss (file absent at ref)'); return '' }
}

async function listVarsFilesUnion(git: IGit, repoPath: string, base: string, logger?: Logger): Promise<string[]> {
  const all = new Set<string>()
  for (const ref of [base, 'HEAD', 'FETCH_HEAD']) {
    try {
      for (const f of await git.lsTree(repoPath, ref, 'vars')) all.add(f.startsWith('vars/') ? f : `vars/${f}`)
    } catch (e) { logger?.warn?.({ err: e, ref }, 'ls-tree vars miss') }
  }
  return [...all]
}

async function detectTextConflicts(git: IGit, repoPath: string, base: string, logger?: Logger): Promise<TextFileConflict[]> {
  const out: TextFileConflict[] = []
  const allAssets = new Set<string>()
  for (const ref of [base, 'HEAD', 'FETCH_HEAD']) {
    try {
      for (const f of await git.lsTree(repoPath, ref, 'assets')) allAssets.add(f.startsWith('assets/') ? f : `assets/${f}`)
    } catch (e) { logger?.warn?.({ err: e, ref }, 'ls-tree assets miss') }
  }
  for (const p of allAssets) {
    const b = await safeShow(git, repoPath, base, p, logger)
    const o = await safeShow(git, repoPath, 'HEAD', p, logger)
    const t = await safeShow(git, repoPath, 'FETCH_HEAD', p, logger)
    if (o !== b && t !== b && o !== t) out.push({ file: p, base: b, ours: o, theirs: t })
  }
  return out
}
