import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { glob } from 'tinyglobby'
import type { AgentId } from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'

export interface SkillMemberSnapshot {
  name: string
  path: string
  entry?: string
  agents?: readonly AgentId[]
}

export interface SkillMemberChange {
  name: string
  previousPath?: string
  nextPath?: string
  agents?: AgentId[]
}

export interface SkillMemberChangeSet {
  added: SkillMemberChange[]
  updated: SkillMemberChange[]
  removed: SkillMemberChange[]
  unchanged: SkillMemberChange[]
}

export async function classifySkillMemberChanges(
  fs: Pick<IFileSystem, 'readFile'>,
  previousRoot: string,
  nextRoot: string,
  previousMembers: readonly SkillMemberSnapshot[],
  nextMembers: readonly SkillMemberSnapshot[],
): Promise<SkillMemberChangeSet> {
  const previous = new Map(previousMembers.map((member) => [member.entry ?? member.name, member]))
  const next = new Map(nextMembers.map((member) => [member.entry ?? member.name, member]))
  const changes: SkillMemberChangeSet = { added: [], updated: [], removed: [], unchanged: [] }

  for (const member of previousMembers) {
    if (!next.has(member.entry ?? member.name)) changes.removed.push(toChange(member, undefined))
  }
  for (const member of nextMembers) {
    const old = previous.get(member.entry ?? member.name)
    if (!old) {
      changes.added.push(toChange(undefined, member))
      continue
    }
    const oldPath = normalizeSkillPath(old.path)
    const newPath = normalizeSkillPath(member.path)
    const pathChanged = oldPath !== newPath
    const contentChanged =
      (await fingerprintDirectory(fs, join(previousRoot, dirname(oldPath)))) !==
      (await fingerprintDirectory(fs, join(nextRoot, dirname(newPath))))
    changes[pathChanged || contentChanged ? 'updated' : 'unchanged'].push(toChange(old, member))
  }

  for (const list of [changes.added, changes.updated, changes.removed, changes.unchanged]) {
    list.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }
  return changes
}

export function normalizeSkillPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (
    !normalized ||
    isAbsolute(path) ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..') ||
    (normalized !== 'SKILL.md' && !normalized.endsWith('/SKILL.md'))
  ) {
    throw new Error(`Invalid source skill path "${path}"`)
  }
  return normalized
}

async function fingerprintDirectory(
  fs: Pick<IFileSystem, 'readFile'>,
  directory: string,
): Promise<string> {
  const files = (
    await glob('**/*', { cwd: directory, onlyFiles: true, dot: true, ignore: ['**/.git/**'] })
  ).sort((a, b) => a.localeCompare(b, 'en'))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(await fs.readFile(join(directory, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function toChange(
  previous: SkillMemberSnapshot | undefined,
  next: SkillMemberSnapshot | undefined,
): SkillMemberChange {
  return {
    name: (next ?? previous)!.name,
    ...(previous ? { previousPath: normalizeSkillPath(previous.path) } : {}),
    ...(next ? { nextPath: normalizeSkillPath(next.path) } : {}),
    ...(previous?.agents ? { agents: [...previous.agents] } : {}),
  }
}
