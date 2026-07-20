import { describe, expect, it, vi } from 'vitest'
import { McpDebugSessionError, McpDebugSessionManager } from '../../src/mcp/debug-session.js'
import type { McpDebugClient } from '../../src/mcp/debug-session.js'

function createClient(overrides: Partial<McpDebugClient> = {}) {
  return {
    listTools: vi.fn(async () => ({
      tools: [
        {
          name: 'capture_live_filter',
          description: 'Filter captures',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
      ],
    })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    close: vi.fn(async () => undefined),
    ...overrides,
  } satisfies McpDebugClient
}

describe('McpDebugSessionManager', () => {
  it('reserves capacity before asynchronous connections finish', async () => {
    let resolveConnect!: (client: McpDebugClient) => void
    const connect = vi.fn(
      () =>
        new Promise<McpDebugClient>((resolve) => {
          resolveConnect = resolve
        }),
    )
    const manager = new McpDebugSessionManager({ connect, maxSessions: 1 })
    const first = manager.createSession({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'first', type: 'stdio', command: 'mcp-server' },
    })

    await expect(
      manager.createSession({
        source: 'saved',
        previewAgent: 'codex',
        server: { id: 'second', type: 'stdio', command: 'mcp-server' },
      }),
    ).rejects.toMatchObject({ code: 'too_many_sessions' })

    resolveConnect(createClient())
    await first
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight create during idempotent disposal', async () => {
    let resolveConnect!: (client: McpDebugClient) => void
    const client = createClient()
    const manager = new McpDebugSessionManager({
      connect: () =>
        new Promise<McpDebugClient>((resolve) => {
          resolveConnect = resolve
        }),
    })
    const creating = manager.createSession({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'pending', type: 'stdio', command: 'mcp-server' },
    })

    const firstDispose = manager.dispose()
    const secondDispose = manager.dispose()
    expect(secondDispose).toBe(firstDispose)
    resolveConnect(client)

    await expect(creating).rejects.toMatchObject({ code: 'manager_disposed' })
    await firstDispose
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(manager.sessionCountForTest()).toBe(0)
    await expect(
      manager.createSession({
        source: 'saved',
        previewAgent: 'codex',
        server: { id: 'late', type: 'stdio', command: 'mcp-server' },
      }),
    ).rejects.toMatchObject({ code: 'manager_disposed' })
  })

  it('maps connection and tool failures while logging their full errors', async () => {
    const connectError = new Error('spawn failed with secret')
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const failedManager = new McpDebugSessionManager({
      connect: vi.fn(async () => {
        throw connectError
      }),
      logger,
    })
    await expect(
      failedManager.createSession({
        source: 'saved',
        previewAgent: 'codex',
        server: { id: 'broken', type: 'stdio', command: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'connect_failed' })
    expect(logger.error).toHaveBeenCalledWith(
      'MCP debug connect failed',
      expect.objectContaining({ err: connectError, serverId: 'broken' }),
    )

    const client = createClient({
      callTool: vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: 'failed' }] })),
    })
    const manager = new McpDebugSessionManager({
      connect: vi.fn(async () => client),
      createId: () => 'tool-error',
      logger,
    })
    await manager.createSession({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'tool-server', type: 'stdio', command: 'mcp-server' },
    })
    await expect(
      manager.callTool('tool-error', { toolName: 'fail', arguments: {} }),
    ).rejects.toMatchObject({ code: 'tool_call_failed' })
    expect(logger.error).toHaveBeenCalledWith(
      'MCP debug tool call failed',
      expect.objectContaining({ err: expect.any(Error), sessionId: 'tool-error' }),
    )
  })

  it('starts one maintenance timer and stops it during disposal', async () => {
    vi.useFakeTimers()
    try {
      const manager = new McpDebugSessionManager()
      const sweep = vi.spyOn(manager, 'sweepExpired')
      manager.startMaintenance(100)
      manager.startMaintenance(100)

      await vi.advanceTimersByTimeAsync(100)
      expect(sweep).toHaveBeenCalledTimes(1)

      await manager.dispose()
      await vi.advanceTimersByTimeAsync(100)
      expect(sweep).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('connects once, returns listed tools, and reuses the session for tool calls', async () => {
    let now = 1000
    const client = createClient()
    const manager = new McpDebugSessionManager({
      connect: vi.fn(async () => client),
      createId: () => 'debug-1',
      now: () => now,
      idleMs: 5000,
      hardMs: 30000,
    })

    const session = await manager.createSession({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'reqable', type: 'stdio', command: 'mcp-server' },
    })

    expect(session).toMatchObject({
      sessionId: 'debug-1',
      source: 'saved',
      previewAgent: 'codex',
      tools: [{ name: 'capture_live_filter', description: 'Filter captures' }],
      createdAt: '1970-01-01T00:00:01.000Z',
      idleExpiresAt: '1970-01-01T00:00:06.000Z',
      hardExpiresAt: '1970-01-01T00:00:31.000Z',
    })
    expect(session.serverFingerprint).toMatch(/^[a-f0-9]{16}$/)

    now += 50
    const result = await manager.callTool('debug-1', {
      toolName: 'capture_live_filter',
      arguments: { pattern: 'mcp' },
    })

    expect(client.callTool).toHaveBeenCalledWith({
      name: 'capture_live_filter',
      arguments: { pattern: 'mcp' },
    })
    expect(result).toEqual({
      ok: true,
      result: { content: [{ type: 'text', text: 'ok' }] },
      durationMs: 0,
      calledAt: '1970-01-01T00:00:01.050Z',
      idleExpiresAt: '1970-01-01T00:00:06.050Z',
    })
  })

  it('closes the client and does not retain a session when listTools fails', async () => {
    const client = createClient({
      listTools: vi.fn(async () => {
        throw new Error('list failed')
      }),
    })
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const manager = new McpDebugSessionManager({
      connect: vi.fn(async () => client),
      logger,
    })

    await expect(
      manager.createSession({
        source: 'saved',
        previewAgent: 'codex',
        server: { id: 'broken', type: 'stdio', command: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'list_tools_failed' })

    expect(client.close).toHaveBeenCalledTimes(1)
    expect(manager.sessionCountForTest()).toBe(0)
    expect(logger.error).toHaveBeenCalledWith(
      'MCP debug list tools failed',
      expect.objectContaining({ err: expect.any(Error), serverId: 'broken' }),
    )
  })

  it('expires sessions by idle timeout and hard lifetime, closing clients during cleanup', async () => {
    let now = 10_000
    const idleClient = createClient()
    const hardClient = createClient()
    const clients = [idleClient, hardClient]
    const manager = new McpDebugSessionManager({
      connect: vi.fn(async () => clients.shift()!),
      createId: () => (clients.length === 1 ? 'idle' : 'hard'),
      now: () => now,
      idleMs: 1000,
      hardMs: 5000,
    })

    await manager.createSession({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'idle-server', type: 'stdio', command: 'mcp-server' },
    })
    now += 500
    await manager.createSession({
      source: 'draft',
      previewAgent: 'codex',
      server: { id: 'hard-server', type: 'stdio', command: 'mcp-server' },
    })

    now = 11_001
    manager.sweepExpired()

    expect(idleClient.close).toHaveBeenCalledTimes(1)
    expect(manager.sessionCountForTest()).toBe(1)

    now = 15_501
    manager.sweepExpired()

    expect(hardClient.close).toHaveBeenCalledTimes(1)
    expect(manager.sessionCountForTest()).toBe(0)
    await expect(
      manager.callTool('hard', { toolName: 'anything', arguments: {} }),
    ).rejects.toBeInstanceOf(McpDebugSessionError)
  })

  it('removes sessions even when cleanup fails and logs the full error object', async () => {
    const cleanupError = new Error('close failed')
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const client = createClient({
      close: vi.fn(async () => {
        throw cleanupError
      }),
    })
    const manager = new McpDebugSessionManager({
      connect: vi.fn(async () => client),
      createId: () => 'cleanup',
      logger,
    })

    await manager.createSession({
      source: 'saved',
      previewAgent: 'codex',
      server: { id: 'reqable', type: 'stdio', command: 'mcp-server' },
    })
    await manager.disconnect('cleanup')

    expect(manager.sessionCountForTest()).toBe(0)
    expect(logger.error).toHaveBeenCalledWith(
      'MCP debug session cleanup failed',
      expect.objectContaining({ err: cleanupError, sessionId: 'cleanup' }),
    )
  })
})
