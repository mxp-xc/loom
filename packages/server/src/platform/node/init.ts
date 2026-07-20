import type { IFileSystem } from '../../ports/fs.js'
import type { IGit } from '../../ports/git.js'
import { join, normalize } from 'node:path'
import { AGENT_IDS } from '@loom/core'

const SKELETON = {
  configLocal: `active_repo: default\n`,
  gitignore: `remote-cache/\n`,
  skills: `sources: []\nskills: []\n`,
  mcp: `[]\n`,
  varsBase: `# base vars\n# browsers_path:\n#   type: string\n#   format: path\n#   value: ~/.cache/ms-playwright\n`,
  repoConfig: `# repo-level config (synced via git)\nprofile: local\nagents: [${AGENT_IDS.join(', ')}]\nprojection:\n  strategy: link\nupdate_check:\n  enabled: true\n  interval: 6h\n`,
}

export async function initLoom(homePath: string, fs: IFileSystem, git: IGit): Promise<void> {
  const canonicalHome = normalize(await fs.realPath(homePath))
  const loom = join(canonicalHome, '.loom')
  const repo = join(loom, 'repos', 'default')
  await ensurePhysicalDirectory(fs, loom)
  await ensurePhysicalDirectory(fs, join(loom, 'repos'))
  await ensurePhysicalDirectory(fs, repo)
  const localConfig = join(loom, 'config.yaml')
  await ensureFile(fs, localConfig, SKELETON.configLocal)
  await ensurePhysicalDirectory(fs, join(repo, 'vars'))
  await ensurePhysicalDirectory(fs, join(repo, 'assets'))
  await ensurePhysicalDirectory(fs, join(repo, 'assets', 'skills'))
  await ensurePhysicalDirectory(fs, join(repo, 'remote-cache'))
  await ensureFile(fs, join(repo, '.gitignore'), SKELETON.gitignore)
  await ensureFile(fs, join(repo, 'skills.yaml'), SKELETON.skills)
  await ensureFile(fs, join(repo, 'mcp.yaml'), SKELETON.mcp)
  await ensureFile(fs, join(repo, 'vars', 'base.yaml'), SKELETON.varsBase)
  await ensureFile(fs, join(repo, 'config.yaml'), SKELETON.repoConfig)
  if (!(await fs.exists(join(repo, '.git')))) await git.init(repo)
}

async function ensureFile(fs: IFileSystem, path: string, content: string): Promise<void> {
  try {
    await fs.writeFileExclusive(path, content)
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
}

async function ensurePhysicalDirectory(fs: IFileSystem, path: string): Promise<void> {
  let entry = await fs.inspectEntry(path)
  if (!entry) {
    try {
      await fs.mkdir(path, false)
    } catch (err) {
      if (!isAlreadyExists(err)) throw err
    }
    entry = await fs.inspectEntry(path)
  }
  if (entry?.kind !== 'directory') {
    throw new Error(`bootstrap path is not a real directory: ${path}`)
  }
  const canonical = normalize(await fs.realPath(path))
  const after = await fs.inspectEntry(path)
  const confirmedCanonical = normalize(await fs.realPath(path))
  if (
    canonical !== normalize(path) ||
    after?.kind !== 'directory' ||
    after.identity !== entry.identity ||
    confirmedCanonical !== canonical
  ) {
    throw new Error(`bootstrap directory changed during validation: ${path}`)
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
