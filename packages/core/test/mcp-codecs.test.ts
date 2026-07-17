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

it('omits Loom-only agents from native MCP entries', () => {
  expect(
    toNativeMcpEntry({
      id: 'browser',
      type: 'stdio',
      command: 'npx',
      agents: ['codex'],
    }),
  ).toEqual({ type: 'stdio', command: 'npx' })
})
