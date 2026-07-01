import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { CodexAdapter } from '../../src/adapters/codex'

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

describe('CodexAdapter', () => {
  it('readMcp parses mcp_servers from config.toml', async () => {
    const fs = new NodeFileSystem()
    await mkdir(join(home, '.codex'), { recursive: true })
    await fs.writeFile(
      join(home, '.codex', 'config.toml'),
      `
[mcp_servers.playwright]
type = "stdio"
command = "npx"
`,
    )
    const adapter = new CodexAdapter()
    const mcp = await adapter.readMcp(fs)
    expect(mcp.playwright).toBeDefined()
    expect(mcp.playwright.command).toBe('npx')
  })
  it('readMcp returns empty when file missing', async () => {
    const adapter = new CodexAdapter()
    const mcp = await adapter.readMcp(new NodeFileSystem())
    expect(Object.keys(mcp)).toHaveLength(0)
  })
  it('writeMcp writes merged mcp_servers to config.toml', async () => {
    const fs = new NodeFileSystem()
    const adapter = new CodexAdapter()
    await adapter.writeMcp(fs, { playwright: { id: 'playwright', type: 'stdio', command: 'npx' } })
    const raw = await fs.readFile(join(home, '.codex', 'config.toml'))
    expect(raw).toContain('mcp_servers')
    expect(raw).toContain('playwright')
    expect(raw).toContain('npx')
  })
  it('writeMcp preserves other top-level keys in config.toml', async () => {
    const fs = new NodeFileSystem()
    await mkdir(join(home, '.codex'), { recursive: true })
    await fs.writeFile(
      join(home, '.codex', 'config.toml'),
      `
model = "o4-mini"

[mcp_servers.old]
type = "stdio"
command = "old"
`,
    )
    const adapter = new CodexAdapter()
    await adapter.writeMcp(fs, { new: { id: 'new', type: 'stdio', command: 'new' } })
    const raw = await fs.readFile(join(home, '.codex', 'config.toml'))
    const { parse } = await import('smol-toml')
    const parsed = parse(raw) as any
    expect(parsed.model).toBe('o4-mini')
    expect(parsed.mcp_servers.new.command).toBe('new')
    expect(parsed.mcp_servers.old).toBeUndefined()
  })
})
