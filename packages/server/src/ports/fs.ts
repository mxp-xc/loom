export interface IFileSystem {
  createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  createFileLink(targetFile: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  removeLink(linkPath: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  mkdir(path: string, recursive?: boolean): Promise<void>
  readDir(path: string): Promise<string[]>
  isLink(path: string): Promise<boolean>
  copyDir(src: string, dest: string): Promise<void>
  copyFile(src: string, dest: string): Promise<void>
  move(src: string, dest: string): Promise<void>
  removeDir(path: string): Promise<void>
  replaceFile(tempPath: string, targetPath: string): Promise<void>
  removeFile(path: string): Promise<void>
  realPath(path: string): Promise<string>
}
