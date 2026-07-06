import type { IGit } from '../ports/git.js'
import {
  classifySyncGitError,
  isNonFastForwardSyncError,
  type SyncGitErrorCode,
  syncErrorMessage,
} from './errors.js'

export type SyncPushResult =
  | { ok: true }
  | {
      ok: false
      nonFastForward?: boolean
      error?: SyncGitErrorCode
      message?: string
    }

type PushLogger = {
  error: (message: string, context?: Record<string, unknown>) => void
}

export async function syncPush(
  repoPath: string,
  git: IGit,
  logger?: PushLogger,
): Promise<SyncPushResult> {
  try {
    const status = await git.status(repoPath)
    if (status.dirty) {
      await git.add(repoPath, ['.'])
      await git.commit(repoPath, 'loom: sync changes')
    }

    const result = await git.push(repoPath)
    if (result.ok) return { ok: true }

    const message = result.message ?? 'push failed'
    const { cause, message: _message, ...logResult } = result
    const errorContext = cause === undefined ? {} : { err: cause }
    if (result.nonFastForward || isNonFastForwardSyncError(message)) {
      logger?.error('push rejected', {
        ...errorContext,
        repoPath,
        result: logResult,
        nonFastForward: true,
      })
      return { ok: false, nonFastForward: true, message }
    }

    const error = classifySyncGitError(message)
    logger?.error('push rejected', { ...errorContext, repoPath, error, result: logResult })
    return { ok: false, error, message }
  } catch (err) {
    const message = syncErrorMessage(err)
    const error = classifySyncGitError(message)
    logger?.error('push failed', { err, repoPath, error })
    return { ok: false, error, message }
  }
}
