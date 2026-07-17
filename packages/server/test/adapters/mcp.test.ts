import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getMcpCodec, getAgent, agentsSupporting, type AgentId } from '@loom/core'
import { createAgentMcpAdapter } from '../../src/adapters/mcp.js'
import type { AgentPathContext } from '../../src/adapters/paths.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'

let home: string
let context: AgentPathContext

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'loom-target-home-'))
  context = { home, env: {}, platform: process.platform }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe.each(agentsSupporting('mcp'))('GenericMcpAdapter(%s)', (agent: AgentId) => {
  it('returns empty for a missing native file', async () => {
    const adapter = createAgentMcpAdapter(agent, context)
    await expect(adapter.readMcp(new NodeFileSystem())).resolves.toEqual({})
  })

  it('writes and reads entries while preserving unrelated document content', async () => {
    const fs = new NodeFileSystem()
    const adapter = createAgentMcpAdapter(agent, context)
    const mcp = getAgent(agent).mcp!
    const codec = getMcpCodec(mcp.codec)
    const initial = codec.writeEntries({ keep: 'value' }, mcp.rootKey, {
      old: { type: 'stdio', command: 'old' },
    })
    await fs.mkdir(dirname(adapter.path), true)
    await fs.writeFile(adapter.path, codec.serialize(initial))

    await adapter.writeMcp(fs, {
      browser: { id: 'browser', type: 'stdio', command: 'npx', args: ['playwright'] },
    })

    const document = codec.parse(await fs.readFile(adapter.path)) as Record<string, unknown>
    expect(document.keep).toBe('value')
    expect(codec.readEntries(document, mcp.rootKey)).toEqual({
      browser: { type: 'stdio', command: 'npx', args: ['playwright'] },
    })
    expect(await adapter.readMcp(fs)).toMatchObject({
      browser: { id: 'browser', type: 'stdio', command: 'npx', args: ['playwright'] },
    })
  })
})
