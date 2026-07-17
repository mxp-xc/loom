import { dirname } from 'node:path'
import { getMcpCodec, getAgent, toNativeMcpEntry, type AgentId, type McpServer } from '@loom/core'
import type { IAgentAdapter, McpFragment } from '../ports/adapter.js'
import type { IFileSystem } from '../ports/fs.js'
import { agentMcpFile, type AgentPathContext } from './paths.js'

export class GenericMcpAdapter implements IAgentAdapter {
  readonly agent: AgentId
  readonly path: string

  constructor(agent: AgentId, path: string) {
    const definition = getAgent(agent)
    if (!definition.mcp) throw new Error(`Agent ${agent} does not support mcp`)
    this.agent = agent
    this.path = path
  }

  async readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>> {
    if (!(await fs.exists(this.path))) return {}
    const definition = getAgent(this.agent)
    const mcp = definition.mcp!
    const codec = getMcpCodec(mcp.codec)
    const entries = codec.readEntries(codec.parse(await fs.readFile(this.path)), mcp.rootKey)
    return Object.fromEntries(
      Object.entries(entries).map(([id, value]) => [id, fromNativeEntry(id, value)]),
    )
  }

  async writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> {
    const definition = getAgent(this.agent)
    const mcp = definition.mcp!
    const codec = getMcpCodec(mcp.codec)
    const document = (await fs.exists(this.path)) ? codec.parse(await fs.readFile(this.path)) : {}
    const entries = Object.fromEntries(
      Object.entries(merged).map(([id, fragment]) => [id, toNativeMcpEntry(fragment as McpServer)]),
    )
    const next = codec.writeEntries(document, mcp.rootKey, entries)
    await fs.mkdir(dirname(this.path), true)
    await fs.writeFile(this.path, codec.serialize(next))
  }
}

export function createAgentMcpAdapter(
  agent: AgentId,
  context?: AgentPathContext,
): GenericMcpAdapter {
  return new GenericMcpAdapter(agent, agentMcpFile(agent, context))
}

function fromNativeEntry(id: string, value: unknown): McpFragment {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const type = raw.type === 'sse' || raw.type === 'http' ? raw.type : 'stdio'
  return {
    id,
    type,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args: Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === 'string')
      : undefined,
    env: stringRecord(raw.env),
    url: typeof raw.url === 'string' ? raw.url : undefined,
    headers: stringRecord(raw.headers),
    agents: [],
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}
