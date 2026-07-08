import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import { parseSkillFrontmatterName, type SkillMeta } from './frontmatter.js'
import { resolveGitUrl } from './resolve-url.js'
import { formatSourceMemberSkillId, type SkillSource } from '@loom/core'
import { logger } from '../lib/logger.js'
import { scanSourceMembers } from '../projection/scan.js'

const discoverLogger = logger.child('remote.discover')

type DiscoverSkillSource = Pick<SkillSource, 'url'> &
  Partial<Pick<SkillSource, 'ref' | 'type' | 'scan'>>

export async function discoverSkills(
  git: IGit,
  fs: IFileSystem,
  sourceInput: string | DiscoverSkillSource,
  installed: Set<string> = new Set(),
): Promise<(SkillMeta & { installed: boolean })[]> {
  const source = normalizeDiscoverSource(sourceInput)
  const tmp = await mkdtemp(join(tmpdir(), 'discover-'))
  try {
    await git.clone(resolveGitUrl(source.url), tmp, !source.ref)
    if (source.ref) await git.checkout(tmp, source.ref)
    const scanned = await scanSourceMembers(tmp, {
      url: source.url,
      ref: source.ref ?? 'HEAD',
      ...(source.type ? { type: source.type } : {}),
      ...(source.scan ? { scan: source.scan } : {}),
    })
    const out: (SkillMeta & { installed: boolean })[] = []
    for (const member of scanned) {
      const relativePath = member.relativePath ?? 'SKILL.md'
      const content = await fs.readFile(join(tmp, relativePath))
      const frontmatterName = parseSkillFrontmatterName(content)
      if (frontmatterName && frontmatterName !== member.name) {
        discoverLogger.warn('source skill frontmatter name differs from path member name', {
          url: source.url,
          path: relativePath,
          frontmatterName,
          memberName: member.name,
        })
      }
      out.push({
        name: member.name,
        description: member.description ?? '',
        path: relativePath,
        installed: installed.has(formatSourceMemberSkillId(source.url, member.name, 'hyphen')),
      })
    }
    return out
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function normalizeDiscoverSource(input: string | DiscoverSkillSource): DiscoverSkillSource {
  if (typeof input === 'string') return { url: input }
  const ref = input.ref?.trim()
  const scan = input.scan?.trim()
  return {
    url: input.url,
    ...(ref ? { ref } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(scan ? { scan } : {}),
  }
}
