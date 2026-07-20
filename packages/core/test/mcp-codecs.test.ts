import { describe, expect, it } from 'vitest'
import { getMcpCodec, toNativeMcpEntry } from '../src/index.js'

describe.each([
  ['json-object', 'mcpServers', JSON.stringify({ keep: true, mcpServers: { old: {} } })],
  ['toml-table', 'mcp_servers', 'model = "gpt"\n[mcp_servers.old]\ncommand = "old"\n'],
] as const)('%s MCP codec', (codecId, rootKey, source) => {
  it('replaces entries while preserving unrelated document content', () => {
    const codec = getMcpCodec(codecId)
    const document = codec.parse(source)
    const next = codec.writeEntries(document, rootKey, {
      browser: { type: 'stdio', command: 'npx' },
    })
    const reparsed = codec.parse(codec.serialize(next))
    expect(codec.readEntries(reparsed, rootKey)).toEqual({
      browser: { type: 'stdio', command: 'npx' },
    })
    expect(reparsed).toMatchObject(codecId === 'json-object' ? { keep: true } : { model: 'gpt' })
  })

  it('renders a parseable one-entry preview', () => {
    const codec = getMcpCodec(codecId)
    const preview = codec.preview(rootKey, 'browser', { type: 'stdio', command: 'npx' })
    expect(codec.readEntries(codec.parse(preview), rootKey)).toEqual({
      browser: { type: 'stdio', command: 'npx' },
    })
  })
})

it.each([
  [
    'stdio',
    {
      id: 'browser',
      type: 'stdio' as const,
      command: 'npx',
      args: ['@playwright/mcp'],
      env: { DEBUG: '1' },
      agents: ['codex' as const],
    },
    { type: 'stdio', command: 'npx', args: ['@playwright/mcp'], env: { DEBUG: '1' } },
  ],
  [
    'http',
    {
      id: 'remote',
      type: 'http' as const,
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer token' },
      agents: ['claude-code' as const],
    },
    {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer token' },
    },
  ],
])('maps %s transport fields and omits Loom-only metadata', (_label, server, expected) => {
  expect(toNativeMcpEntry(server)).toEqual(expected)
})
