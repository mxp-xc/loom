import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { OpenCodeAdapter } from '../../src/adapters/opencode'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('OPENCODE_CONFIG_DIR', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('OpenCodeAdapter', () => {
  it('readMcp parses mcp from opencode.json', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(
      join(home, 'opencode.json'),
      JSON.stringify({ mcp: { playwright: { type: 'stdio', command: 'npx' } } }),
    )
    const adapter = new OpenCodeAdapter()
    const mcp = await adapter.readMcp(fs)
    expect(mcp.playwright).toBeDefined()
    expect(mcp.playwright.command).toBe('npx')
  })
  it('readMcp returns empty when file missing', async () => {
    const adapter = new OpenCodeAdapter()
    const mcp = await adapter.readMcp(new NodeFileSystem())
    expect(Object.keys(mcp)).toHaveLength(0)
  })
  it('writeMcp writes merged mcp to opencode.json', async () => {
    const fs = new NodeFileSystem()
    const adapter = new OpenCodeAdapter()
    await adapter.writeMcp(fs, { playwright: { id: 'playwright', type: 'stdio', command: 'npx' } })
    const raw = JSON.parse(await fs.readFile(join(home, 'opencode.json')))
    expect(raw.mcp.playwright.command).toBe('npx')
  })
  it('writeMcp preserves other top-level keys in opencode.json', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(
      join(home, 'opencode.json'),
      JSON.stringify({ otherKey: 'keep', mcp: { old: { type: 'stdio', command: 'old' } } }),
    )
    const adapter = new OpenCodeAdapter()
    await adapter.writeMcp(fs, { new: { id: 'new', type: 'stdio', command: 'new' } })
    const raw = JSON.parse(await fs.readFile(join(home, 'opencode.json')))
    expect(raw.otherKey).toBe('keep')
    expect(raw.mcp.new.command).toBe('new')
    expect(raw.mcp.old).toBeUndefined()
  })
})
