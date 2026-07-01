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
  revParse(repoPath: string, ref: string): Promise<string>
  lsTree(repoPath: string, ref: string, dir: string): Promise<string[]>
  // Create a merge commit with two parents (HEAD + mergeHead) over the given tree.
  // Used by syncPull so the result is a real descendant of the remote tip (pushable).
  commitTree(repoPath: string, tree: string, parents: string[], message: string): Promise<string>
  // Update a ref to point at a commit (fast-forward only, no merge). Used to ff to FETCH_HEAD.
  updateRef(repoPath: string, ref: string, commit: string): Promise<void>
  // Write the working-tree content of a path into the object store, return its tree hash.
  // For syncPull we write the full repo tree (worktree index) so merge results land in history.
  writeTree(repoPath: string): Promise<string>
}
