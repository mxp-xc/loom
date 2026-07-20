export type GitPushResult =
  { ok: true } | { ok: false; nonFastForward?: boolean; message?: string; cause?: unknown }

export type GitTreeEntryType = 'blob' | 'tree' | 'commit'

export interface GitTreeEntry {
  mode: string
  type: GitTreeEntryType
  oid: string
  path: string
}

export interface IGit {
  init(repoPath: string): Promise<void>
  fetch(repoPath: string): Promise<void>
  mergeBase(repoPath: string, a: string, b: string): Promise<string>
  lsRemote(url: string): Promise<{ tags: Record<string, string>; head: string; branches: string[] }>
  clone(url: string, dest: string, shallow?: boolean): Promise<void>
  checkout(repoPath: string, ref: string): Promise<void>
  add(repoPath: string, paths: string[]): Promise<void>
  commit(repoPath: string, msg: string): Promise<void>
  push(repoPath: string): Promise<GitPushResult>
  forcePush(repoPath: string): Promise<GitPushResult>
  status(repoPath: string): Promise<{ dirty: boolean }>
  show(repoPath: string, ref: string, path: string): Promise<string>
  showBytes?(repoPath: string, ref: string, path: string): Promise<Uint8Array>
  revParseHead(repoPath: string): Promise<string>
  revParse(repoPath: string, ref: string): Promise<string>
  lsTree(repoPath: string, ref: string, dir: string): Promise<string[]>
  readTree(repoPath: string, ref: string): Promise<GitTreeEntry[]>
  // Remote config operations (used by /sync/remote endpoints)
  addOrUpdateRemote(repoPath: string, remoteUrl: string): Promise<void>
  getRemoteUrl(repoPath: string): Promise<string | null>
}
