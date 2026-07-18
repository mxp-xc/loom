import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeExternalOpener } from '../../../src/platform/node/external-opener.js'
import { UnsupportedPlatformError } from '../../../src/ports/external-opener.js'

const tempPaths: string[] = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('NodeExternalOpener', () => {
  it('uses macOS application names and reveals files in Finder', async () => {
    const launch = vi.fn().mockResolvedValue(undefined)
    const opener = new NodeExternalOpener('darwin', launch)

    await opener.open('/repo/readme.txt', 'vscode', 'file')
    await opener.open('/repo/readme.txt', 'zed', 'file')
    await opener.open('/repo/readme.txt', 'system', 'file')
    await opener.open('/repo/docs', 'system', 'directory')

    expect(launch.mock.calls).toEqual([
      ['open', ['-a', 'Visual Studio Code', '/repo/readme.txt']],
      ['open', ['-a', 'Zed', '/repo/readme.txt']],
      ['open', ['-R', '/repo/readme.txt']],
      ['open', ['/repo/docs']],
    ])
  })

  it('uses Explorer and known Windows application locations without a shell', async () => {
    const localAppData = mkdtempSync(join(tmpdir(), 'loom-apps-'))
    tempPaths.push(localAppData)
    const codePath = join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')
    const zedPath = join(localAppData, 'Programs', 'Zed', 'Zed.exe')
    mkdirSync(join(localAppData, 'Programs', 'Microsoft VS Code'), { recursive: true })
    mkdirSync(join(localAppData, 'Programs', 'Zed'), { recursive: true })
    writeFileSync(codePath, '')
    writeFileSync(zedPath, '')
    const launch = vi.fn().mockResolvedValue(undefined)
    const opener = new NodeExternalOpener('win32', launch, { LOCALAPPDATA: localAppData })

    await opener.open('C:\\repo\\guide.txt', 'vscode', 'file')
    await opener.open('C:\\repo', 'zed', 'directory')
    await opener.open('C:\\repo\\guide.txt', 'system', 'file')
    await opener.open('C:\\repo', 'system', 'directory')

    expect(launch.mock.calls).toEqual([
      [codePath, ['C:\\repo\\guide.txt']],
      [zedPath, ['C:\\repo']],
      ['explorer.exe', ['/select,', 'C:\\repo\\guide.txt']],
      ['explorer.exe', ['C:\\repo']],
    ])
  })

  it('reports unsupported platforms explicitly', async () => {
    const opener = new NodeExternalOpener('linux', vi.fn())

    await expect(opener.open('/repo', 'system', 'directory')).rejects.toBeInstanceOf(
      UnsupportedPlatformError,
    )
  })
})
