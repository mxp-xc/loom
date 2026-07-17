import type { IFileSystem } from '../../ports/fs.js'
import type { IGit } from '../../ports/git.js'
import { join } from 'node:path'
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
  const loom = join(homePath, '.loom')
  const repo = join(loom, 'repos', 'default')
  await fs.mkdir(loom, true)
  const localConfig = join(loom, 'config.yaml')
  if (!(await fs.exists(localConfig))) await fs.writeFile(localConfig, SKELETON.configLocal)
  await fs.mkdir(join(repo, 'vars'), true)
  await fs.mkdir(join(repo, 'assets', 'skills'), true)
  await fs.mkdir(join(repo, 'remote-cache'), true)
  const ensure = async (p: string, content: string) => {
    if (!(await fs.exists(p))) await fs.writeFile(p, content)
  }
  await ensure(join(repo, '.gitignore'), SKELETON.gitignore)
  await ensure(join(repo, 'skills.yaml'), SKELETON.skills)
  await ensure(join(repo, 'mcp.yaml'), SKELETON.mcp)
  await ensure(join(repo, 'vars', 'base.yaml'), SKELETON.varsBase)
  await ensure(join(repo, 'config.yaml'), SKELETON.repoConfig)
  if (!(await fs.exists(join(repo, '.git')))) await git.init(repo)
}
