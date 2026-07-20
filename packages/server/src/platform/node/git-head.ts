import type { SimpleGit } from 'simple-git'

export type GitHeadState =
  { kind: 'commit'; oid: string } | { kind: 'unborn'; ref: string; error: unknown }

export class GitUnbornHeadError extends Error {
  readonly code = 'unborn_head'

  constructor(
    readonly ref: string,
    options?: ErrorOptions,
  ) {
    super(`Git HEAD is unborn: ${ref}`, options)
    this.name = 'GitUnbornHeadError'
  }
}

export async function readGitHead(git: Pick<SimpleGit, 'raw'>): Promise<GitHeadState> {
  try {
    const oid = (await git.raw(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    return { kind: 'commit', oid }
  } catch (error) {
    let ref: string
    try {
      ref = (await git.raw(['symbolic-ref', '-q', 'HEAD'])).trim()
    } catch {
      throw error
    }
    const existing = (await git.raw(['for-each-ref', '--format=%(objectname)', ref])).trim()
    if (existing) throw error
    return { kind: 'unborn', ref, error }
  }
}
