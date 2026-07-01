import type { AgentId } from '@loom/core'
import type { IFileSystem } from './fs.js'

export interface McpFragment {
  id: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  targets?: AgentId[]
}
export type UndoAction =
  { kind: 'unlink'; path: string } | { kind: 'restoreMcp'; path: string; backup: string | null }
export interface ProjectionJournal {
  undos: UndoAction[]
}
export interface ProjectionFailure {
  failedStep: string
  originalError: unknown
  rollbackReport: { undone: number; rollbackFailures: { path: string; err: unknown }[] }
}
export interface IAgentAdapter {
  readonly agent: AgentId
  readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>>
  writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void>
}
