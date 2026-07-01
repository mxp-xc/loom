import type { McpFragment } from '../ports/adapter.js'

export function toAgentEntry(f: McpFragment): Record<string, unknown> {
  const e: Record<string, unknown> = { type: f.type }
  if (f.command !== undefined) e.command = f.command
  if (f.args !== undefined) e.args = f.args
  if (f.env !== undefined) e.env = f.env
  if (f.url !== undefined) e.url = f.url
  if (f.headers !== undefined) e.headers = f.headers
  return e
}
