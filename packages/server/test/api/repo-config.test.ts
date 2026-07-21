import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
const fixtureRepoPath = resolve('repo')
const fixtureHomePath = resolve('home')

vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => repoConfigLogger },
}))

afterEach(() => vi.restoreAllMocks())

class LeafLinkContractFileSystem extends NodeFileSystem {
  readonly inspectLinkedFile = vi.fn()
  readonly readLinkedFile = vi.fn()

  constructor(private readonly linkedPath: string) {
    super()
  }

  override async inspectEntry(path: string) {
    if (path === this.linkedPath) {
      this.inspectLinkedFile()
      return { kind: 'link' as const, identity: `contract-link:${path}`, linkCount: 1 }
    }
    return super.inspectEntry(path)
  }

  override async readFile(path: string): Promise<string> {
    if (path === this.linkedPath) this.readLinkedFile()
    return super.readFile(path)
  }
}

async function expectRepositoryLinkRejected(
  relativePath: string,
  kind: 'directory' | 'file' | 'nested-file',
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'loom-repo-config-')))
  try {
    const repo = join(root, 'repo')
    const external = join(root, 'external')
    await mkdir(repo)
    await mkdir(external)
    const target = join(external, kind === 'directory' ? 'directory' : 'file')
    if (kind === 'directory') await mkdir(target)
    else await writeFile(target, 'outside\n')
    const link = join(repo, relativePath)
    await mkdir(join(link, '..'), { recursive: true })
    let fs: NodeFileSystem
    if (kind === 'directory') {
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      fs = new NodeFileSystem()
    } else if (process.platform === 'win32') {
      // Keep directory enumeration real while exercising the leaf-link IFileSystem contract.
      await writeFile(link, 'file link contract placeholder\n')
      fs = new LeafLinkContractFileSystem(link)
    } else {
      await symlink(target, link, 'file')
      fs = new NodeFileSystem()
    }

    await expect(readRepoFiles(fs, repo)).rejects.toMatchObject({
      code: 'repository_boundary_invalid',
      cause: expect.objectContaining({ message: 'unexpected repository entry kind: link' }),
    })
    if (fs instanceof LeafLinkContractFileSystem) {
      expect(fs.inspectLinkedFile).toHaveBeenCalledTimes(1)
      expect(fs.readLinkedFile).not.toHaveBeenCalled()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

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
        path === fixtureRepoPath
          ? { kind: 'directory' as const, identity: 'repo', linkCount: 2 }
          : { kind: 'file' as const, identity: path, linkCount: 1 },
      ),
    }

    const repositoryError = await readRepoFiles(fs, fixtureRepoPath).catch((error) => error)
    expect(repositoryError).toMatchObject({
      code: 'repository_boundary_invalid',
      cause: denied,
    })
    await expect(readYaml(fs, join(fixtureRepoPath, 'config.yaml'))).rejects.toBe(denied)
    await expect(readLocalConfig(fs, fixtureHomePath)).rejects.toBe(denied)
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to read repository file', {
      err: repositoryError,
      path: join(fixtureRepoPath, 'config.yaml'),
    })
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to read local config', {
      err: denied,
      path: join(fixtureHomePath, '.loom', 'config.yaml'),
    })
  })

  it('wraps malformed YAML without exposing source while retaining the cause', async () => {
    const secret = 'top-secret-config-source'
    const fs = {
      readFile: vi.fn(async () => `active_repo: [${secret}`),
      exists: vi.fn(async () => true),
    }
    const error = await readYaml(fs, join(fixtureRepoPath, 'config.yaml')).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(error)).not.toContain(secret)
    expect(error.stack).not.toContain(secret)

    const localError = await readLocalConfig(fs, fixtureHomePath).catch((caught) => caught)
    expect(localError).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(localError)).not.toContain(secret)
    expect(localError.stack).not.toContain(secret)
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to parse YAML config', {
      err: error,
      path: join(fixtureRepoPath, 'config.yaml'),
    })
    expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to parse local config', {
      err: localError,
      path: join(fixtureHomePath, '.loom', 'config.yaml'),
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
        path === fixtureRepoPath
          ? { kind: 'directory' as const, identity: 'repo', linkCount: 2 }
          : null,
      ),
    }
    await readRepoFiles(fs, fixtureRepoPath)
    await readLocalConfig(fs, fixtureHomePath)
    expect(repoConfigLogger.error).not.toHaveBeenCalled()
  })

  it.each(['vars', 'memories'] as const)('rejects repository links at %s', (relativePath) =>
    expectRepositoryLinkRejected(relativePath, 'directory'),
  )

  it.each([
    ['config.yaml', 'file'],
    ['vars/linked.yaml', 'nested-file'],
    ['memories/linked.md', 'nested-file'],
  ] as const)('rejects repository links at %s', (relativePath, kind) =>
    expectRepositoryLinkRejected(relativePath, kind),
  )

  it.each(['null\n', 'scalar\n', '- list\n'])(
    'rejects a non-object local config container: %s',
    async (source) => {
      const fs = {
        readFile: vi.fn(async () => source),
        exists: vi.fn(async () => true),
      }

      const error = await readLocalConfig(fs, fixtureHomePath).catch((caught) => caught)
      expect(error).toMatchObject({
        code: 'config_container_invalid',
        cause: expect.any(TypeError),
      })
      expect(repoConfigLogger.error).toHaveBeenCalledWith('failed to parse local config', {
        err: error,
        path: join(fixtureHomePath, '.loom', 'config.yaml'),
      })
    },
  )

  it('accepts an empty local config as an object', async () => {
    const fs = {
      readFile: vi.fn(async () => ''),
      exists: vi.fn(async () => true),
    }
    const result = await readLocalConfig(fs, fixtureHomePath)
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

      await expect(read(fs, fixtureRepoPath)).rejects.toMatchObject({
        code: 'manifest_container_invalid',
        file,
        diagnostics: [expect.objectContaining({ file, code: 'manifest_container_invalid' })],
      })
      expect(repoConfigLogger.error).toHaveBeenCalledWith(
        'failed to parse repository manifest document',
        {
          err: expect.objectContaining({ code: 'manifest_container_invalid' }),
          path: join(fixtureRepoPath, file),
        },
      )
    },
  )

  it('uses safe defaults for missing manifest documents and accepts an empty repo config', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const missingFs = { readFile: vi.fn(async () => Promise.reject(missing)) }
    await expect(readSkillsManifest(missingFs, fixtureRepoPath)).resolves.toEqual({
      sources: [],
      skills: [],
    })
    await expect(readMcpManifest(missingFs, fixtureRepoPath)).resolves.toEqual([])

    const emptyConfig = await readRepoConfig({ readFile: vi.fn(async () => '') }, fixtureRepoPath)
    expect(emptyConfig).toEqual({})
    expect(Object.getPrototypeOf(emptyConfig)).toBeNull()
  })
})
