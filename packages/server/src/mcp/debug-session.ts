import { createHash, randomUUID } from 'node:crypto'
import type { AgentId, McpServer } from '@loom/core'

export type McpDebugSource = 'saved' | 'draft'

export interface McpDebugTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpDebugClient {
  listTools(): Promise<{ tools: McpDebugTool[] }>
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void> | void
}

export interface McpDebugSessionSnapshot {
  sessionId: string
  source: McpDebugSource
  serverFingerprint: string
  previewTarget: AgentId
  tools: McpDebugTool[]
  createdAt: string
  idleExpiresAt: string
  hardExpiresAt: string
}

export interface McpDebugCallResult {
  ok: true
  result: unknown
  durationMs: number
  calledAt: string
  idleExpiresAt: string
}

export interface McpDebugLogger {
  error(message: string, context?: Record<string, unknown>): void
  warn?(message: string, context?: Record<string, unknown>): void
  info?(message: string, context?: Record<string, unknown>): void
}

export interface McpDebugSessionManagerOptions {
  connect?: (server: McpServer) => Promise<McpDebugClient>
  createId?: () => string
  now?: () => number
  idleMs?: number
  hardMs?: number
  maxSessions?: number
  logger?: McpDebugLogger
}

interface McpDebugSession {
  id: string
  source: McpDebugSource
  serverId: string
  serverFingerprint: string
  previewTarget: AgentId
  client: McpDebugClient
  tools: McpDebugTool[]
  createdAt: number
  lastUsedAt: number
  hardExpiresAt: number
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_HARD_MS = 30 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 8

export class McpDebugSessionError extends Error {
  constructor(
    readonly code:
      | 'connect_failed'
      | 'list_tools_failed'
      | 'session_expired'
      | 'tool_call_failed'
      | 'too_many_sessions',
    message: string,
    readonly status = 200,
    readonly durationMs?: number,
  ) {
    super(message)
    this.name = 'McpDebugSessionError'
  }
}

export class McpDebugSessionManager {
  private readonly sessions = new Map<string, McpDebugSession>()
  private readonly connect: (server: McpServer) => Promise<McpDebugClient>
  private readonly createId: () => string
  private readonly now: () => number
  private readonly idleMs: number
  private readonly hardMs: number
  private readonly maxSessions: number
  private readonly logger?: McpDebugLogger
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: McpDebugSessionManagerOptions = {}) {
    this.connect = options.connect ?? connectMcpDebugClient
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.hardMs = options.hardMs ?? DEFAULT_HARD_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.logger = options.logger
  }

  async createSession(input: {
    source: McpDebugSource
    server: McpServer
    previewTarget: AgentId
  }): Promise<McpDebugSessionSnapshot> {
    this.sweepExpired()
    if (this.sessions.size >= this.maxSessions)
      throw new McpDebugSessionError(
        'too_many_sessions',
        'MCP debug session 数量已达上限，请断开已有连接后重试',
      )

    let client: McpDebugClient
    try {
      client = await this.connect(input.server)
    } catch (err) {
      this.logger?.error('MCP debug connect failed', {
        err,
        serverId: input.server.id,
        transportType: input.server.type,
      })
      throw new McpDebugSessionError('connect_failed', normalizeErrorMessage(err, '连接失败'))
    }

    let tools: McpDebugTool[]
    try {
      tools = normalizeTools((await client.listTools()).tools)
    } catch (err) {
      this.logger?.error('MCP debug list tools failed', {
        err,
        serverId: input.server.id,
        transportType: input.server.type,
      })
      await this.closeClient(input.server.id, 'pending', client)
      throw new McpDebugSessionError(
        'list_tools_failed',
        normalizeErrorMessage(err, '获取 tools 失败'),
      )
    }

    const createdAt = this.now()
    const id = this.createId()
    const session: McpDebugSession = {
      id,
      source: input.source,
      serverId: input.server.id,
      serverFingerprint: fingerprintServer(input.server),
      previewTarget: input.previewTarget,
      client,
      tools,
      createdAt,
      lastUsedAt: createdAt,
      hardExpiresAt: createdAt + this.hardMs,
    }
    this.sessions.set(id, session)
    return this.snapshot(session)
  }

  async callTool(
    sessionId: string,
    request: { toolName: string; arguments: Record<string, unknown> },
  ): Promise<McpDebugCallResult> {
    const session = this.activeSession(sessionId)
    const startedAt = this.now()
    session.lastUsedAt = startedAt
    try {
      const result = await session.client.callTool({
        name: request.toolName,
        arguments: request.arguments,
      })
      if (isToolErrorResult(result)) {
        throw new Error('MCP tool returned isError=true')
      }
      const calledAt = this.now()
      session.lastUsedAt = calledAt
      return {
        ok: true,
        result,
        durationMs: Math.max(0, calledAt - startedAt),
        calledAt: toIso(calledAt),
        idleExpiresAt: toIso(calledAt + this.idleMs),
      }
    } catch (err) {
      const durationMs = Math.max(0, this.now() - startedAt)
      this.logger?.error('MCP debug tool call failed', {
        err,
        sessionId,
        serverId: session.serverId,
        toolName: request.toolName,
        durationMs,
      })
      throw new McpDebugSessionError(
        'tool_call_failed',
        normalizeErrorMessage(err, 'MCP tool 调用失败'),
        200,
        durationMs,
      )
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await this.closeClient(session.serverId, sessionId, session.client)
  }

  sweepExpired(): void {
    const now = this.now()
    for (const session of [...this.sessions.values()]) {
      const idleExpired = now - session.lastUsedAt > this.idleMs
      const hardExpired = now > session.hardExpiresAt
      if (!idleExpired && !hardExpired) continue
      this.sessions.delete(session.id)
      void this.closeClient(session.serverId, session.id, session.client)
    }
  }

  startMaintenance(intervalMs = 60_000): () => void {
    if (this.maintenanceTimer) return () => this.stopMaintenance()
    this.maintenanceTimer = setInterval(() => this.sweepExpired(), intervalMs)
    this.maintenanceTimer.unref?.()
    return () => this.stopMaintenance()
  }

  stopMaintenance(): void {
    if (!this.maintenanceTimer) return
    clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
  }

  async dispose(): Promise<void> {
    this.stopMaintenance()
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)))
  }

  sessionCountForTest(): number {
    return this.sessions.size
  }

  private activeSession(sessionId: string): McpDebugSession {
    this.sweepExpired()
    const session = this.sessions.get(sessionId)
    if (!session)
      throw new McpDebugSessionError('session_expired', 'MCP debug session 已过期，请重新连接')
    return session
  }

  private snapshot(session: McpDebugSession): McpDebugSessionSnapshot {
    return {
      sessionId: session.id,
      source: session.source,
      serverFingerprint: session.serverFingerprint,
      previewTarget: session.previewTarget,
      tools: session.tools,
      createdAt: toIso(session.createdAt),
      idleExpiresAt: toIso(session.lastUsedAt + this.idleMs),
      hardExpiresAt: toIso(session.hardExpiresAt),
    }
  }

  private async closeClient(
    serverId: string,
    sessionId: string,
    client: McpDebugClient,
  ): Promise<void> {
    try {
      await client.close()
    } catch (err) {
      this.logger?.error('MCP debug session cleanup failed', { err, serverId, sessionId })
    }
  }
}

export async function connectMcpDebugClient(server: McpServer): Promise<McpDebugClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'loom-mcp-debug', version: '0.1.0' })
  const transport = await createTransport(server)
  await client.connect(transport)
  return {
    listTools: () => client.listTools() as Promise<{ tools: McpDebugTool[] }>,
    callTool: (request) => client.callTool(request),
    close: () => client.close(),
  }
}

async function createTransport(server: McpServer): Promise<unknown> {
  if (server.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const env = {
      ...processEnvForChild(),
      ...(server.env ?? {}),
    }
    return new StdioClientTransport({
      command: server.command ?? '',
      args: server.args ?? [],
      env,
    })
  }

  if (!server.url) throw new Error('MCP remote server url is required')
  if (server.type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    })
  }

  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  })
}

function processEnvForChild(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

function normalizeTools(tools: unknown): McpDebugTool[] {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === 'object')
    .map((tool) => ({
      name: typeof tool.name === 'string' ? tool.name : '',
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: 'inputSchema' in tool ? tool.inputSchema : undefined,
    }))
    .filter((tool) => tool.name)
}

function fingerprintServer(server: McpServer): string {
  return createHash('sha256')
    .update(stableStringify(sanitizeServer(server)))
    .digest('hex')
    .slice(0, 16)
}

function sanitizeServer(server: McpServer): Omit<McpServer, 'targets'> {
  const { targets: _targets, ...connection } = server
  return connection
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return (
    '{' +
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ':' + stableStringify(item))
      .join(',') +
    '}'
  )
}

function isToolErrorResult(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && (result as { isError?: unknown }).isError === true,
  )
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message || fallback : String(error || fallback)
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}
