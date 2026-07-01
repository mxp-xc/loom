import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import { parseSkillMeta, type SkillMeta } from './frontmatter.js'
import { resolveGitUrl } from './resolve-url.js'

const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']

export async function discoverSkills(
  git: IGit, fs: IFileSystem, url: string, installed: Set<string> = new Set(),
): Promise<(SkillMeta & { installed: boolean })[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'discover-'))
  try {
    await git.clone(resolveGitUrl(url), tmp, true)
    const matches = await glob('**/SKILL.md', { cwd: tmp, ignore: DEFAULT_IGNORE, onlyFiles: true })
    const repoId = deriveRepoId(url)
    const out: (SkillMeta & { installed: boolean })[] = []
    for (const m of matches) {
      const dir = dirname(m), dirName = basename(dir)
      const meta = parseSkillMeta(await fs.readFile(join(tmp, m)), dirName, join(tmp, dir))
      if (meta) out.push({ ...meta, installed: installed.has(`${repoId}-${dirName}`) })
    }
    return out
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1].split('/').pop()!.replace(/\.git$/, '')
}
