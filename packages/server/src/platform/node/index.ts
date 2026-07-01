import { NodeFileSystem } from './fs.js'
import { NodeGit } from './git.js'
import { NodeProcess } from './proc.js'

export interface NodePlatform {
  fs: NodeFileSystem
  git: NodeGit
  proc: NodeProcess
}
export function createNodePlatform(): NodePlatform {
  return { fs: new NodeFileSystem(), git: new NodeGit(), proc: new NodeProcess() }
}
