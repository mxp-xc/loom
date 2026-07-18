export type ExternalApplication = 'vscode' | 'zed' | 'system'

export class UnsupportedPlatformError extends Error {
  constructor(readonly platform: NodeJS.Platform) {
    super(`Opening paths is not supported on ${platform}`)
    this.name = 'UnsupportedPlatformError'
  }
}

export class ApplicationNotFoundError extends Error {
  constructor(readonly application: ExternalApplication) {
    super(`${application} is not installed or could not be found`)
    this.name = 'ApplicationNotFoundError'
  }
}

export interface IExternalOpener {
  open(
    targetPath: string,
    application: ExternalApplication,
    targetKind: 'file' | 'directory',
  ): Promise<void>
}
