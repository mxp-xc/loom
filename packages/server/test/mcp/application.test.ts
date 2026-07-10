import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpApplication } from '../../src/mcp/application.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'

describe('McpApplication', () => {
  let home: string
  let repoPath: string
  let app: McpApplication

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'loom-mcp-app-'))
    repoPath = join(home, '.loom', 'repos', 'default')
    await mkdir(repoPath, { recursive: true })
    app = new McpApplication(new NodeFileSystem())
  })

  afterEach(async () => rm(home, { recursive: true, force: true }))

  it('adds a server when mcp.yaml is missing', async () => {
    const server = { id: 'shell', type: 'stdio' as const, command: 'echo' }

    await expect(app.addServer(repoPath, server)).resolves.toEqual({ server })

    const parsed = yaml.load(await readFile(join(repoPath, 'mcp.yaml'), 'utf8'))
    expect(parsed).toEqual([server])
  })

  it('updates an existing server after validating transport fields and preserving the route id', async () => {
    await writeFile(join(repoPath, 'mcp.yaml'), '- id: srv1\n  type: stdio\n  command: echo\n')

    await expect(
      app.updateServer(repoPath, 'srv1', {
        id: 'ignored',
        type: 'http',
        url: 'https://example.test/mcp',
      }),
    ).resolves.toEqual({
      server: { id: 'srv1', type: 'http', url: 'https://example.test/mcp' },
    })

    const parsed = yaml.load(await readFile(join(repoPath, 'mcp.yaml'), 'utf8'))
    expect(parsed).toEqual([{ id: 'srv1', type: 'http', url: 'https://example.test/mcp' }])
  })

  it('rejects stdio updates without a command', async () => {
    await writeFile(join(repoPath, 'mcp.yaml'), '- id: srv1\n  type: stdio\n  command: echo\n')

    await expect(app.updateServer(repoPath, 'srv1', { type: 'stdio' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_server',
    })
  })

  it('updates targets and maps missing servers to not_found', async () => {
    await writeFile(join(repoPath, 'mcp.yaml'), '- id: srv1\n  type: stdio\n  command: echo\n')

    await expect(app.setTargets(repoPath, 'missing', [])).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
    await app.setTargets(repoPath, 'srv1', ['claude-code', 'codex'])

    const parsed = yaml.load(await readFile(join(repoPath, 'mcp.yaml'), 'utf8')) as any
    expect(parsed[0].targets).toEqual(['claude-code', 'codex'])
  })

  it('removes existing servers and ignores absent ones', async () => {
    await writeFile(join(repoPath, 'mcp.yaml'), '- id: srv1\n  type: stdio\n  command: echo\n')

    await app.removeServer(repoPath, 'srv1')
    await app.removeServer(repoPath, 'missing')

    const parsed = yaml.load(await readFile(join(repoPath, 'mcp.yaml'), 'utf8'))
    expect(parsed).toEqual([])
  })
})
