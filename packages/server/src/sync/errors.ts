export type SyncGitErrorCode = 'invalid_repo' | 'no_remote' | 'other'

export function syncErrorMessage(err: unknown): string {
  return String((err as Error)?.message ?? err)
}

export function isNonFastForwardSyncError(message: string): boolean {
  return /non-fast-forward|fetch first|updates were rejected because the tip/i.test(message)
}

export function classifySyncGitError(message: string): SyncGitErrorCode {
  if (/invalid repo/i.test(message)) return 'invalid_repo'
  if (
    /no remote|could not find remote|not a git repository|does not appear to be a git|could not read from remote repository/i.test(
      message,
    )
  ) {
    return 'no_remote'
  }
  return 'other'
}
