import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLocalConfig, readRepoFiles, readYaml } from '../../src/api/repo-config.js'

afterEach(() => vi.restoreAllMocks())

describe('repo config read errors', () => {
  it('logs unexpected config and local config read failures with full errors', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const fs = {
      readFile: vi.fn(async () => {
        throw denied
      }),
      exists: vi.fn(async () => false),
      readDir: vi.fn(async () => []),
    }

    await expect(readRepoFiles(fs, '/repo')).resolves.toEqual({})
    await expect(readYaml(fs, '/repo/config.yaml')).rejects.toBe(denied)
    await expect(readLocalConfig(fs, '/home')).rejects.toBe(denied)
    const output = write.mock.calls.map(([value]) => String(value)).join('')
    expect(output).toContain('failed to read repository config file')
    expect(output).toContain('failed to read local config')
    expect(output).toContain('permission denied')
  })

  it('wraps malformed YAML without exposing source while retaining the cause', async () => {
    const secret = 'top-secret-config-source'
    const fs = {
      readFile: vi.fn(async () => `active_repo: [${secret}`),
      exists: vi.fn(async () => true),
    }
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const error = await readYaml(fs, '/repo/config.yaml').catch((caught) => caught)
    expect(error).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(error)).not.toContain(secret)
    expect(error.stack).not.toContain(secret)

    const localError = await readLocalConfig(fs, '/home').catch((caught) => caught)
    expect(localError).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(localError)).not.toContain(secret)
    expect(localError.stack).not.toContain(secret)
    expect(write.mock.calls.map(([value]) => String(value)).join('')).not.toContain(secret)
  })

  it('does not log expected ENOENT reads', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const fs = {
      readFile: vi.fn(async () => {
        throw missing
      }),
      exists: vi.fn(async () => false),
      readDir: vi.fn(async () => []),
    }
    await readRepoFiles(fs, '/repo')
    await readLocalConfig(fs, '/home')
    expect(write).not.toHaveBeenCalled()
  })
})
