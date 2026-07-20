import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLocalConfig,
  readMcpManifest,
  readRepoConfig,
  readRepoFiles,
  readSkillsManifest,
  readYaml,
} from '../../src/api/repo-config.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'

const repoConfigLogger = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => repoConfigLogger },
}))

afterEach(() => vi.restoreAllMocks())

describe('repo config read errors', () => {
  it('logs unexpected config and local config read failures with full errors', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const fs = {
      readFile: vi.fn(async () => {
        throw denied
      }),
      readDir: vi.fn(async () => []),
      exists: vi.fn(async () => true),
      realPath: vi.fn(async (path: string) => path),
      inspectEntry: vi.fn(async (path: string) =>
        path === '/repo'
          ? { kind: 'directory' as const, identity: 'repo', linkCount: 2 }
          : { kind: 'file' as const, identity: path, linkCount: 1 },
      ),
    }

    const repositoryError = await readRepoFiles(fs, '/repo').catch((error) => error)
    expect(repositoryError).toMatchObject({
      code: 'repository_boundary_invalid',
      cause: denied,
    })
    await expect(readYaml(fs, '/repo/config.yaml')).rejects.toBe(denied)
    await expect(readLocalConfig(fs, '/home')).rejects.toBe(denied)
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to read repository file', {
      err: repositoryError,
      path: '/repo/config.yaml',
    })
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to read local config', {
      err: denied,
      path: '/home/.loom/config.yaml',
    })
  })

  it('wraps malformed YAML without exposing source while retaining the cause', async () => {
    const secret = 'top-secret-config-source'
    const fs = {
      readFile: vi.fn(async () => `active_repo: [${secret}`),
      exists: vi.fn(async () => true),
    }
    const error = await readYaml(fs, '/repo/config.yaml').catch((caught) => caught)
    expect(error).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(error)).not.toContain(secret)
    expect(error.stack).not.toContain(secret)

    const localError = await readLocalConfig(fs, '/home').catch((caught) => caught)
    expect(localError).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(localError)).not.toContain(secret)
    expect(localError.stack).not.toContain(secret)
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to parse YAML config', {
      err: error,
      path: '/repo/config.yaml',
    })
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to parse local config', {
      err: localError,
      path: '/home/.loom/config.yaml',
    })
  })

  it('does not log expected ENOENT reads', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const fs = {
      readFile: vi.fn(async () => {
        throw missing
      }),
      readDir: vi.fn(async () => []),
      exists: vi.fn(async () => false),
      realPath: vi.fn(async (path: string) => path),
      inspectEntry: vi.fn(async (path: string) =>
        path === '/repo' ? { kind: 'directory' as const, identity: 'repo', linkCount: 2 } : null,
      ),
    }
    await readRepoFiles(fs, '/repo')
    await readLocalConfig(fs, '/home')
    expect(repoConfigLogger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['config.yaml', 'file'],
    ['vars', 'directory'],
    ['memories', 'directory'],
    ['vars/linked.yaml', 'nested-file'],
    ['memories/linked.md', 'nested-file'],
  ] as const)('rejects repository links at %s', async (relativePath, kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'loom-repo-config-')))
    const repo = join(root, 'repo')
    const external = join(root, 'external')
    await mkdir(repo)
    await mkdir(external)
    const target = join(external, kind === 'directory' ? 'directory' : 'file')
    if (kind === 'directory') await mkdir(target)
    else await writeFile(target, 'outside\n')
    const link = join(repo, relativePath)
    await mkdir(join(link, '..'), { recursive: true })
    await symlink(target, link, kind === 'directory' ? 'dir' : 'file')

    try {
      await expect(readRepoFiles(new NodeFileSystem(), repo)).rejects.toMatchObject({
        code: 'repository_boundary_invalid',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['null\n', 'scalar\n', '- list\n'])(
    'rejects a non-object local config container: %s',
    async (source) => {
      const fs = {
        readFile: vi.fn(async () => source),
        exists: vi.fn(async () => true),
      }

      const error = await readLocalConfig(fs, '/home').catch((caught) => caught)
      expect(error).toMatchObject({
        code: 'config_container_invalid',
        cause: expect.any(TypeError),
      })
      expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to parse local config', {
        err: error,
        path: '/home/.loom/config.yaml',
      })
    },
  )

  it('accepts an empty local config as an object', async () => {
    const fs = {
      readFile: vi.fn(async () => ''),
      exists: vi.fn(async () => true),
    }
    const result = await readLocalConfig(fs, '/home')
    expect(result).toEqual({})
    expect(Object.getPrototypeOf(result)).toBeNull()
  })

  it.each([
    ['skills.yaml', 'scalar\n', readSkillsManifest],
    ['mcp.yaml', 'servers: []\n', readMcpManifest],
    ['config.yaml', 'null\n', readRepoConfig],
  ] as const)(
    'rejects an invalid %s container with structured diagnostics',
    async (file, source, read) => {
      const fs = {
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith(file)) return source
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }),
      }

      await expect(read(fs, '/repo')).rejects.toMatchObject({
        code: 'manifest_container_invalid',
        file,
        diagnostics: [expect.objectContaining({ file, code: 'manifest_container_invalid' })],
      })
      expect(repoConfigLogger.error).toHaveBeenCalledWith(
        'failed to parse repository manifest document',
        {
          err: expect.objectContaining({ code: 'manifest_container_invalid' }),
          path: `/repo/${file}`,
        },
      )
    },
  )

  it('uses safe defaults for missing manifest documents and accepts an empty repo config', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const missingFs = { readFile: vi.fn(async () => Promise.reject(missing)) }
    await expect(readSkillsManifest(missingFs, '/repo')).resolves.toEqual({
      sources: [],
      skills: [],
    })
    await expect(readMcpManifest(missingFs, '/repo')).resolves.toEqual([])

    const emptyConfig = await readRepoConfig({ readFile: vi.fn(async () => '') }, '/repo')
    expect(emptyConfig).toEqual({})
    expect(Object.getPrototypeOf(emptyConfig)).toBeNull()
  })
})
