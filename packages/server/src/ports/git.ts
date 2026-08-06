export type GitPushResult =
  { ok: true } | { ok: false; nonFastForward?: boolean; message?: string; cause?: unknown }

export type GitRefType = 'branch' | 'tag'
export interface GitFetchRefOptions {
  filter?: 'blob:none'
}
export interface GitRemoteRefs {
  tags: Record<string, string>
  branches: Record<string, string>
  head: string
}

const INVALID_GIT_REF_CHARACTERS = /[\u0000-\u0020\u007f~^:?*[\]\\]/

export function isValidGitRefName(ref: string): boolean {
  if (
    !ref ||
    ref === '@' ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('//') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    INVALID_GIT_REF_CHARACTERS.test(ref)
  ) {
    return false
  }
  return ref
    .split('/')
    .every((component) => !component.startsWith('.') && !component.endsWith('.lock'))
}

export function remoteGitRef(ref: string, type: GitRefType): string {
  if (!isValidGitRefName(ref)) throw new Error(`Invalid Git ref: ${ref}`)
  const namespace = `refs/${type === 'tag' ? 'tags' : 'heads'}/`
  if (ref.startsWith('refs/')) {
    if (!ref.startsWith(namespace)) throw new Error(`Invalid Git ref for ${type}: ${ref}`)
    return ref
  }
  return `${namespace}${ref}`
}

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
  fetchRef(
    repoPath: string,
    ref: string,
    type: GitRefType,
    options?: GitFetchRefOptions,
  ): Promise<void>
  mergeBase(repoPath: string, a: string, b: string): Promise<string>
  lsRemote(url: string): Promise<GitRemoteRefs>
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
