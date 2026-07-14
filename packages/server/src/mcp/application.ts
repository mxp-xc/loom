import { join } from 'node:path'
import {
  addMcpServer,
  removeMcpServer,
  setMcpTargets,
  updateMcpServer,
  normalizeOrder,
  sameOrder,
  type AgentId,
  type McpServer,
} from '@loom/core'
import type { IFileSystem } from '../ports/fs.js'
import { readYaml, writeYaml } from '../api/repo-config.js'

export class McpApplicationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'McpApplicationError'
  }
}

export class McpApplication {
  constructor(private readonly fs: IFileSystem) {}

  async addServer(repoPath: string, server: McpServer): Promise<{ server: McpServer }> {
    await this.updateServers(repoPath, (servers) => addMcpServer(servers, server))
    return { server }
  }

  async removeServer(repoPath: string, id: string): Promise<void> {
    await this.updateServers(repoPath, (servers) => removeMcpServer(servers, id))
  }

  async updateServer(
    repoPath: string,
    id: string,
    server: unknown,
  ): Promise<{ server: McpServer }> {
    const next = validatedServer(id, server)
    const result = await this.updateServers(repoPath, (servers) =>
      updateMcpServer(servers, id, next),
    )
    if (!result.changed) throw notFound(id)
    return { server: next }
  }

  async setTargets(repoPath: string, id: string, targets: AgentId[]): Promise<void> {
    const result = await this.updateServers(repoPath, (servers) =>
      setMcpTargets(servers, id, targets),
    )
    if (!result.changed) throw notFound(id)
  }

  async reorderServers(repoPath: string, ids: string[]): Promise<{ ids: string[] }> {
    const servers = await this.readServers(repoPath)
    const current = serverIds(servers)
    const nextIds = normalizeOrder(ids, current)
    if (!sameOrder(current, nextIds)) {
      const byId = new Map(servers.map((server) => [server.id, server]))
      await this.writeServers(
        repoPath,
        nextIds.map((id) => byId.get(id)!),
      )
    }
    return { ids: nextIds }
  }

  private async readServers(repoPath: string): Promise<McpServer[]> {
    return (await readYaml(this.fs, this.mcpYamlPath(repoPath))) ?? []
  }

  private async writeServers(repoPath: string, servers: McpServer[]): Promise<void> {
    await writeYaml(this.fs, this.mcpYamlPath(repoPath), servers)
  }

  private async updateServers(
    repoPath: string,
    mutate: (servers: McpServer[]) => { changed: boolean; data: McpServer[] },
  ): Promise<{ changed: boolean; data: McpServer[] }> {
    const result = mutate(await this.readServers(repoPath))
    if (result.changed) await this.writeServers(repoPath, result.data)
    return result
  }

  private mcpYamlPath(repoPath: string): string {
    return join(repoPath, 'mcp.yaml')
  }
}

function validatedServer(id: string, server: unknown): McpServer {
  if (!server || typeof server !== 'object') throw invalidServer('id 和 server 不能为空')
  const candidate = server as Partial<McpServer>
  const type = candidate.type
  const validTransport =
    (type === 'stdio' && typeof candidate.command === 'string' && candidate.command.trim()) ||
    ((type === 'sse' || type === 'http') &&
      typeof candidate.url === 'string' &&
      candidate.url.trim())
  if (!validTransport) throw invalidServer('MCP server 类型或连接字段无效')
  return { ...candidate, id } as McpServer
}

function invalidServer(message: string): McpApplicationError {
  return new McpApplicationError(400, 'invalid_server', message)
}

function notFound(id: string): McpApplicationError {
  return new McpApplicationError(404, 'not_found', `MCP server ${id} not found`)
}

function serverIds(servers: McpServer[]): string[] {
  if (!Array.isArray(servers))
    throw new McpApplicationError(422, 'invalid_mcp_manifest', 'MCP manifest must be an array')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    if (!server || typeof server.id !== 'string' || !server.id) {
      throw new McpApplicationError(422, 'invalid_mcp_manifest', 'MCP manifest is malformed')
    }
    if (seen.has(server.id))
      throw new McpApplicationError(
        409,
        'duplicate_mcp_id',
        `Duplicate MCP server id: ${server.id}`,
      )
    seen.add(server.id)
    ids.push(server.id)
  }
  return ids
}
