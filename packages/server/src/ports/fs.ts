export interface IFileSystem {
  createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  removeLink(linkPath: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  mkdir(path: string, recursive?: boolean): Promise<void>
  readDir(path: string): Promise<string[]>
  isLink(path: string): Promise<boolean>
  copyDir(src: string, dest: string): Promise<void>
  move(src: string, dest: string): Promise<void>
  removeDir(path: string): Promise<void>
}
