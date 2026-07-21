import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import yaml from 'js-yaml'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { createOpenPathRoutes } from '../../src/api/routes/open-path.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import type { IExternalOpener } from '../../src/ports/external-opener.js'
import { UnsupportedPlatformError } from '../../src/ports/external-opener.js'

describe('open path routes', () => {
  let home: string
  let repoPath: string
  let open: ReturnType<typeof vi.fn<IExternalOpener['open']>>
  let app: Hono

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-open-path-'))
    repoPath = join(home, '.loom', 'repos', 'default')
    mkdirSync(join(repoPath, 'docs'), { recursive: true })
    writeFileSync(join(repoPath, 'docs', 'guide.txt'), 'content')
    open = vi.fn<IExternalOpener['open']>().mockResolvedValue(undefined)
    app = new Hono().route(
      '/api',
      createOpenPathRoutes({
        fs: new NodeFileSystem(),
        home,
        externalOpener: { open },
      }),
    )
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const request = (body: unknown) =>
    app.request('http://localhost/api/open-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const resolveRequest = (body: unknown) =>
    app.request('http://localhost/api/open-path/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('stores and reads the application preference in device config', async () => {
    const update = await app.request('http://localhost/api/open-path/preference', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ application: 'zed' }),
    })

    expect(update.status).toBe(200)
    expect(yaml.load(readFileSync(join(home, '.loom', 'config.yaml'), 'utf8'))).toMatchObject({
      open_with_application: 'zed',
    })

    const response = await app.request('http://localhost/api/open-path/preference')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ application: 'zed' })
  })

  it('falls back to VS Code when the stored application preference is invalid', async () => {
    mkdirSync(join(home, '.loom'), { recursive: true })
    writeFileSync(join(home, '.loom', 'config.yaml'), 'open_with_application: invalid\n')

    const response = await app.request('http://localhost/api/open-path/preference')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ application: 'vscode' })
  })

  it('rejects an invalid application preference', async () => {
    const response = await app.request('http://localhost/api/open-path/preference', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ application: 'terminal' }),
    })

    expect(response.status).toBe(400)
  })

  it('opens an existing repository file with a whitelisted application', async () => {
    const response = await request({ repo: 'default', path: 'docs/guide.txt', application: 'zed' })

    expect(response.status).toBe(200)
    expect(open).toHaveBeenCalledWith(
      realpathSync(join(repoPath, 'docs', 'guide.txt')),
      'zed',
      'file',
    )
  })

  it('opens a directory without requiring a file extension', async () => {
    const response = await request({ repo: 'default', path: 'docs', application: 'system' })

    expect(response.status).toBe(200)
    expect(open).toHaveBeenCalledWith(realpathSync(join(repoPath, 'docs')), 'system', 'directory')
  })

  it('resolves an existing file to its native absolute path without opening it', async () => {
    const response = await resolveRequest({ repo: 'default', path: 'docs/guide.txt' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      path: realpathSync(join(repoPath, 'docs', 'guide.txt')),
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('resolves a directory without requiring a file extension', async () => {
    const response = await resolveRequest({ repo: 'default', path: 'docs' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, path: realpathSync(join(repoPath, 'docs')) })
  })

  it('rejects traversal when resolving a path', async () => {
    const response = await resolveRequest({ repo: 'default', path: '../outside.txt' })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_path' })
  })

  it('rejects a symlink outside the repository when resolving a path', async () => {
    const outside = join(home, process.platform === 'win32' ? 'outside-copy' : 'outside-copy.txt')
    const link = join(repoPath, 'docs', 'outside-copy-link')
    let requestPath = 'docs/outside-copy-link'
    if (process.platform === 'win32') {
      mkdirSync(outside)
      writeFileSync(join(outside, 'outside.txt'), 'outside')
      symlinkSync(outside, link, 'junction')
      requestPath += '/outside.txt'
    } else {
      writeFileSync(outside, 'outside')
      symlinkSync(outside, link, 'file')
    }

    const response = await resolveRequest({ repo: 'default', path: requestPath })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_path' })
  })

  it('rejects an unknown repository', async () => {
    const response = await request({ repo: 'missing', path: 'docs', application: 'vscode' })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_repo' })
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects relative traversal outside the repository', async () => {
    const response = await request({
      repo: 'default',
      path: '../outside.txt',
      application: 'vscode',
    })

    expect(response.status).toBe(400)
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects absolute paths even when they point inside the repository', async () => {
    const response = await request({
      repo: 'default',
      path: join(repoPath, 'docs'),
      application: 'vscode',
    })

    expect(response.status).toBe(400)
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a symlink whose real target is outside the repository', async () => {
    const outside = join(home, process.platform === 'win32' ? 'outside' : 'outside.txt')
    const link = join(repoPath, 'docs', 'outside-link')
    let requestPath = 'docs/outside-link'
    if (process.platform === 'win32') {
      mkdirSync(outside)
      writeFileSync(join(outside, 'outside.txt'), 'outside')
      symlinkSync(outside, link, 'junction')
      requestPath += '/outside.txt'
    } else {
      writeFileSync(outside, 'outside')
      symlinkSync(outside, link, 'file')
    }

    const response = await request({
      repo: 'default',
      path: requestPath,
      application: 'vscode',
    })

    expect(response.status).toBe(400)
    expect(open).not.toHaveBeenCalled()
  })

  it('returns a clear error for unsupported platforms', async () => {
    open.mockRejectedValueOnce(new UnsupportedPlatformError('linux'))

    const response = await request({ repo: 'default', path: 'docs', application: 'system' })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'unsupported_platform' })
  })

  it('rejects unknown applications at validation', async () => {
    const response = await request({ repo: 'default', path: 'docs', application: 'terminal' })

    expect(response.status).toBe(400)
    expect(open).not.toHaveBeenCalled()
  })
})
