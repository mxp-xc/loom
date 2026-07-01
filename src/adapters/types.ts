import type { AgentId, McpServer } from '../core/types.js'

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
  | { kind: 'unlink'; path: string }
  | { kind: 'restoreMcp'; path: string; backup: string | null }

export interface ProjectionJournal { undos: UndoAction[] }

export interface ProjectionFailure {
  failedStep: string
  originalError: unknown
  rollbackReport: { undone: number; rollbackFailures: { path: string; err: unknown }[] }
}

export interface IAgentAdapter {
  readonly agent: AgentId
  readMcp(fs: import('../platform/interfaces.js').IFileSystem): Promise<Record<string, McpFragment>>
  writeMcp(fs: import('../platform/interfaces.js').IFileSystem, merged: Record<string, McpFragment>): Promise<void>
}

export function toAgentEntry(f: McpFragment): Record<string, unknown> {
  const e: Record<string, unknown> = { type: f.type }
  if (f.command !== undefined) e.command = f.command
  if (f.args !== undefined) e.args = f.args
  if (f.env !== undefined) e.env = f.env
  if (f.url !== undefined) e.url = f.url
  if (f.headers !== undefined) e.headers = f.headers
  return e
}
