import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('ClaudeCodeAdapter', () => {
  it('readMcp parses mcpServers from .claude.json', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { playwright: { type: 'stdio', command: 'npx' } } }),
    )
    const adapter = new ClaudeCodeAdapter()
    const mcp = await adapter.readMcp(fs)
    expect(mcp.playwright).toBeDefined()
    expect(mcp.playwright.command).toBe('npx')
  })
  it('readMcp returns empty when file missing', async () => {
    const adapter = new ClaudeCodeAdapter()
    const mcp = await adapter.readMcp(new NodeFileSystem())
    expect(Object.keys(mcp)).toHaveLength(0)
  })
  it('writeMcp writes merged mcpServers to .claude.json', async () => {
    const fs = new NodeFileSystem()
    const adapter = new ClaudeCodeAdapter()
    await adapter.writeMcp(fs, { playwright: { id: 'playwright', type: 'stdio', command: 'npx' } })
    const raw = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(raw.mcpServers.playwright.command).toBe('npx')
  })
  it('writeMcp preserves other top-level keys in .claude.json', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ otherKey: 'keep', mcpServers: { old: { type: 'stdio', command: 'old' } } }),
    )
    const adapter = new ClaudeCodeAdapter()
    await adapter.writeMcp(fs, { new: { id: 'new', type: 'stdio', command: 'new' } })
    const raw = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(raw.otherKey).toBe('keep')
    expect(raw.mcpServers.new.command).toBe('new')
    expect(raw.mcpServers.old).toBeUndefined()
  })
})
