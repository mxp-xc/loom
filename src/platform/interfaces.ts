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
}
export interface IProcess {
  isInstalled(agentId: string): Promise<boolean>
}
export interface IGit {
  init(repoPath: string): Promise<void>
  fetch(repoPath: string): Promise<void>
  mergeBase(repoPath: string, a: string, b: string): Promise<string>
  lsRemote(url: string): Promise<{ tags: Record<string, string>; head: string }>
  clone(url: string, dest: string, shallow?: boolean): Promise<void>
  checkout(repoPath: string, ref: string): Promise<void>
  add(repoPath: string, paths: string[]): Promise<void>
  commit(repoPath: string, msg: string): Promise<void>
  push(repoPath: string): Promise<{ ok: boolean; nonFastForward?: boolean }>
  status(repoPath: string): Promise<{ dirty: boolean }>
  show(repoPath: string, ref: string, path: string): Promise<string>
  revParseHead(repoPath: string): Promise<string>
  lsTree(repoPath: string, ref: string, dir: string): Promise<string[]>
}
