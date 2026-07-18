import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  ApplicationNotFoundError,
  UnsupportedPlatformError,
  type ExternalApplication,
  type IExternalOpener,
} from '../../ports/external-opener.js'

type Platform = NodeJS.Platform
type Launch = (command: string, args: string[]) => Promise<void>

function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function firstExisting(paths: Array<string | undefined>): Promise<string | null> {
  for (const path of paths) {
    if (!path) continue
    try {
      await access(path)
      return path
    } catch {
      // Keep checking the known installation locations.
    }
  }
  return null
}

export class NodeExternalOpener implements IExternalOpener {
  constructor(
    private readonly platform: Platform = process.platform,
    private readonly launch: Launch = launchDetached,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async open(
    targetPath: string,
    application: ExternalApplication,
    targetKind: 'file' | 'directory',
  ): Promise<void> {
    if (this.platform === 'darwin') {
      const args =
        application === 'system'
          ? targetKind === 'file'
            ? ['-R', targetPath]
            : [targetPath]
          : ['-a', application === 'vscode' ? 'Visual Studio Code' : 'Zed', targetPath]
      await this.launch('open', args)
      return
    }

    if (this.platform === 'win32') {
      if (application === 'system') {
        await this.launch(
          'explorer.exe',
          targetKind === 'file' ? ['/select,', targetPath] : [targetPath],
        )
        return
      }

      const executable = await this.resolveWindowsApplication(application)
      if (!executable) throw new ApplicationNotFoundError(application)
      await this.launch(executable, [targetPath])
      return
    }

    throw new UnsupportedPlatformError(this.platform)
  }

  private async resolveWindowsApplication(application: Exclude<ExternalApplication, 'system'>) {
    const localAppData = this.env.LOCALAPPDATA
    const programFiles = this.env.ProgramFiles
    const programFilesX86 = this.env['ProgramFiles(x86)']

    if (application === 'vscode') {
      return firstExisting([
        localAppData && join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        programFiles && join(programFiles, 'Microsoft VS Code', 'Code.exe'),
        programFilesX86 && join(programFilesX86, 'Microsoft VS Code', 'Code.exe'),
      ])
    }

    return firstExisting([
      localAppData && join(localAppData, 'Programs', 'Zed', 'Zed.exe'),
      programFiles && join(programFiles, 'Zed', 'Zed.exe'),
    ])
  }
}
