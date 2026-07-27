import { isAbsolute, join, normalize } from 'node:path'
import {
  SHARED_HOME,
  skillProjectionDestinationKey,
  type SkillProjectionDestination,
} from '@loom/core'
import { agentSkillsDir, type AgentPathContext } from '../adapters/paths.js'
import type { IFileSystem } from '../ports/fs.js'
import {
  captureAgentDirectoryChain,
  captureSafeDirectoryChain,
  type SafeDirectoryChain,
} from './fs-boundary.js'

export function resolveSkillDestinationRoot(
  destination: SkillProjectionDestination,
  context: AgentPathContext,
): string {
  if (destination.kind === 'agent') return agentSkillsDir(destination.agent, context)
  if (!isAbsolute(context.home)) throw new Error('Projection home must be absolute')
  return join(context.home, ...SHARED_HOME.root.segments, ...SHARED_HOME.capabilities.skills.path)
}

export async function captureSkillDestinationDirectoryChain(
  fs: IFileSystem,
  destination: SkillProjectionDestination,
  targetDirectory: string,
  context: AgentPathContext,
): Promise<SafeDirectoryChain> {
  if (destination.kind === 'agent') {
    return captureAgentDirectoryChain(fs, destination.agent, 'skills', targetDirectory, context)
  }
  if (!isAbsolute(context.home)) throw new Error('Projection home must be absolute')
  return captureSafeDirectoryChain(
    fs,
    normalize(context.home),
    targetDirectory,
    'shared skills destination',
  )
}

export function describeSkillDestination(destination: SkillProjectionDestination): string {
  return destination.kind === 'shared'
    ? 'shared skills destination'
    : `${skillProjectionDestinationKey(destination)} skills destination`
}
