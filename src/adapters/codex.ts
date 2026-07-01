import { dirname } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { agentMcpFile } from './paths.js'
import { toAgentEntry, type McpFragment } from './types.js'
import type { IAgentAdapter } from './types.js'
import type { IFileSystem } from '../platform/interfaces.js'
import type { AgentId } from '../core/types.js'

export class CodexAdapter implements IAgentAdapter {
  readonly agent: AgentId = 'codex'

  async readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>> {
    const file = agentMcpFile('codex')
    if (!(await fs.exists(file))) return {}
    const raw = parse(await fs.readFile(file)) as Record<string, any>
    const servers = (raw.mcp_servers ?? {}) as Record<string, any>
    const out: Record<string, McpFragment> = {}
    for (const [name, s] of Object.entries(servers)) {
      out[name] = { id: name, type: s.type ?? 'stdio', command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers, targets: [] }
    }
    return out
  }

  async writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> {
    const file = agentMcpFile('codex')
    let config: Record<string, unknown> = {}
    if (await fs.exists(file)) config = parse(await fs.readFile(file)) as Record<string, unknown>
    const mcpServers: Record<string, unknown> = {}
    for (const [name, f] of Object.entries(merged)) mcpServers[name] = toAgentEntry(f)
    config.mcp_servers = mcpServers
    await fs.mkdir(dirname(file), true)
    await fs.writeFile(file, stringify(config))
  }
}
