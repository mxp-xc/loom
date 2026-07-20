export type FileSystemEntryKind = 'file' | 'directory' | 'link' | 'other'

export interface FileSystemEntry {
  kind: FileSystemEntryKind
  identity: string
  linkCount?: number
}

export class FileSystemDestinationExistsError extends Error {
  readonly code = 'destination_exists'

  constructor(
    readonly destination: string,
    options?: ErrorOptions,
  ) {
    super(`Destination already exists: ${destination}`, options)
    this.name = 'FileSystemDestinationExistsError'
  }
}

export interface IFileSystem {
  createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  createFileLink(targetFile: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  removeLink(linkPath: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  writeFileBytes?(path: string, content: Uint8Array, mode?: number): Promise<void>
  writeFileExclusive(path: string, content: string, mode?: number): Promise<FileSystemEntry>
  writeFileBytesExclusive?(
    path: string,
    content: Uint8Array,
    mode?: number,
  ): Promise<FileSystemEntry>
  exists(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  mkdir(path: string, recursive?: boolean): Promise<void>
  readDir(path: string): Promise<string[]>
  isLink(path: string): Promise<boolean>
  copyDir(src: string, dest: string): Promise<void>
  copyFile(src: string, dest: string): Promise<void>
  copyFileNoFollow(src: string, dest: string, expectedIdentity: string): Promise<void>
  move(src: string, dest: string): Promise<void>
  moveNoReplace(src: string, dest: string, expectedIdentity?: string): Promise<FileSystemEntry>
  moveDirectoryAtomic(src: string, dest: string, expectedIdentity: string): Promise<FileSystemEntry>
  removeDir(path: string): Promise<void>
  removeEntryIfIdentity(path: string, expectedIdentity: string): Promise<void>
  replaceFile(tempPath: string, targetPath: string): Promise<void>
  replaceFileIfIdentity(
    tempPath: string,
    targetPath: string,
    expectedTargetIdentity: string | null,
  ): Promise<FileSystemEntry>
  removeFile(path: string): Promise<void>
  realPath(path: string): Promise<string>
  inspectEntry(path: string): Promise<FileSystemEntry | null>
  readLink(path: string): Promise<string>
}
