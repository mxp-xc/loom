import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IGit } from '../ports/git.js'
import type { IFileSystem } from '../ports/fs.js'
import type { SkillMeta } from './frontmatter.js'
import {
  formatSourceMemberSkillId,
  type SkillSource,
  type SourceTree,
  type SourceTreeNode,
} from '@loom/core'
import { scanSourceTree } from './source-tree.js'

type DiscoverSkillSource = Pick<SkillSource, 'url'> &
  Partial<Pick<SkillSource, 'name' | 'ref' | 'type'>>

export async function discoverSourceTree(
  git: IGit,
  sourceInput: string | DiscoverSkillSource,
): Promise<SourceTree> {
  const source = normalizeDiscoverSource(sourceInput)
  const tmp = await mkdtemp(join(tmpdir(), 'discover-'))
  try {
    await git.clone(source.url, tmp, !source.ref)
    if (source.ref) await git.checkout(tmp, source.ref)
    return await scanSourceTree(git, tmp, source.ref ?? 'HEAD', source)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export async function discoverSkills(
  git: IGit,
  _fs: IFileSystem,
  sourceInput: string | DiscoverSkillSource,
  installed: Set<string> = new Set(),
): Promise<(SkillMeta & { installed: boolean })[]> {
  const source = normalizeDiscoverSource(sourceInput)
  const tree = await discoverSourceTree(git, source)
  return flattenBundles(tree.nodes).map((member) => ({
    name: member.name,
    description: member.description ?? '',
    path: member.entry,
    installed: installed.has(formatSourceMemberSkillId(source, member.name, 'hyphen')),
  }))
}

function normalizeDiscoverSource(input: string | DiscoverSkillSource): DiscoverSkillSource {
  if (typeof input === 'string') return { url: input }
  const ref = input.ref?.trim()
  const name = input.name?.trim()
  return {
    url: input.url,
    ...(name ? { name } : {}),
    ...(ref ? { ref } : {}),
    ...(input.type ? { type: input.type } : {}),
  }
}

function flattenBundles(
  nodes: readonly SourceTreeNode[],
): Array<Extract<SourceTreeNode, { kind: 'bundle' }>> {
  return nodes.flatMap((node) =>
    node.kind === 'bundle'
      ? [node]
      : node.kind === 'container'
        ? flattenBundles(node.children)
        : [],
  )
}
