import { glob } from 'tinyglobby'
import { join, dirname } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import { parseSkillFrontmatterName, parseSkillMeta, type SkillMeta } from './frontmatter.js'
import { resolveGitUrl } from './resolve-url.js'
import { formatSourceMemberSkillId } from '@loom/core'
import { logger } from '../lib/logger.js'
import { supportedSourceMemberName } from '../projection/scan.js'

const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']
const discoverLogger = logger.child('remote.discover')

export async function discoverSkills(
  git: IGit,
  fs: IFileSystem,
  url: string,
  installed: Set<string> = new Set(),
): Promise<(SkillMeta & { installed: boolean })[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'discover-'))
  try {
    await git.clone(resolveGitUrl(url), tmp, true)
    const matches = await glob('**/SKILL.md', { cwd: tmp, ignore: DEFAULT_IGNORE, onlyFiles: true })
    const out: (SkillMeta & { installed: boolean })[] = []
    for (const m of matches) {
      const memberName = supportedSourceMemberName(m)
      if (!memberName) {
        discoverLogger.warn('unsupported source skill layout; expected skills/<name>/SKILL.md', {
          url,
          path: m,
        })
        continue
      }
      const dir = dirname(m)
      const content = await fs.readFile(join(tmp, m))
      const frontmatterName = parseSkillFrontmatterName(content)
      if (frontmatterName && frontmatterName !== memberName) {
        discoverLogger.warn('source skill frontmatter name differs from path member name', {
          url,
          path: m,
          frontmatterName,
          memberName,
        })
      }
      const meta = parseSkillMeta(content, memberName, join(tmp, dir))
      if (meta) {
        out.push({
          ...meta,
          installed: installed.has(formatSourceMemberSkillId(url, memberName, 'hyphen')),
        })
      }
    }
    return out
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
