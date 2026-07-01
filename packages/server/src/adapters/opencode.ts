import { agentMcpFile } from './paths.js'
import { toAgentEntry } from './types.js'
import type { McpFragment, IAgentAdapter } from '../ports/adapter.js'
import type { IFileSystem } from '../ports/fs.js'
import type { AgentId } from '@loom/core'

export class OpenCodeAdapter implements IAgentAdapter {
  readonly agent: AgentId = 'opencode'

  async readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>> {
    const file = agentMcpFile('opencode')
    if (!(await fs.exists(file))) return {}
    const raw = JSON.parse(await fs.readFile(file)) as { mcp?: Record<string, any> }
    const out: Record<string, McpFragment> = {}
    for (const [name, s] of Object.entries(raw.mcp ?? {})) {
      out[name] = {
        id: name,
        type: s.type ?? 'stdio',
        command: s.command,
        args: s.args,
        env: s.env,
        url: s.url,
        headers: s.headers,
        targets: [],
      }
    }
    return out
  }

  async writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> {
    const file = agentMcpFile('opencode')
    let config: Record<string, unknown> = {}
    if (await fs.exists(file))
      config = JSON.parse(await fs.readFile(file)) as Record<string, unknown>
    const mcp: Record<string, unknown> = {}
    for (const [name, f] of Object.entries(merged)) mcp[name] = toAgentEntry(f)
    config.mcp = mcp
    await fs.writeFile(file, JSON.stringify(config, null, 2))
  }
}
