import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  GitBranch,
  Loader2,
  RadioTower,
  ShieldAlert,
  Upload,
} from 'lucide-react'
import { api, type GitConflictFile, type SyncPullResponse } from '@/lib/api'
import { Button } from '@/components/ui/button'
import Modal from '@/components/Modal'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import styles from './Sync.module.css'

const ConflictEditor = lazy(() => import('./sync/ConflictEditor'))

type FeedbackAction = 'pull' | 'push' | 'force-pull' | 'force-push' | 'remote'
type FeedbackStatus = 'running' | 'success' | 'warning' | 'error'

interface FeedbackState {
  action: FeedbackAction
  status: FeedbackStatus
  message: string
  detail: string
}

type SyncPushResponse = {
  ok?: boolean
  nonFastForward?: boolean
  error?: string
  message?: string
}

const feedbackCopy = {
  pull: {
    title: '拉取远程变更',
    running: '正在拉取远程变更…',
    detail: 'Loom 会按 Git 规则合并 remote，并把需要人工处理的冲突留在页面里。',
  },
  push: {
    title: '上传本地变更',
    running: '正在上传本地变更…',
    detail: 'Loom 会把当前本地配置推送到 remote；如果远端更新领先，会提示先拉取。',
  },
  'force-pull': {
    title: '强制拉取结果',
    running: '正在强制拉取…',
    detail: '本地未提交修改、本地提交、未跟踪文件和目录都会被远端覆盖或删除。',
  },
  'force-push': {
    title: '强制推送结果',
    running: '正在强制推送…',
    detail: '远端内容会被本地配置覆盖，其他设备新增但本地没有的内容可能丢失。',
  },
  remote: {
    title: '更换 remote',
    running: '正在更换 remote…',
    detail: '只更新 Git origin URL，不会自动拉取、上传或提交。',
  },
} satisfies Record<FeedbackAction, { title: string; running: string; detail: string }>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function runningFeedback(action: FeedbackAction): FeedbackState {
  const copy = feedbackCopy[action]
  return { action, status: 'running', message: copy.running, detail: copy.detail }
}

function stoppedFeedback(action: FeedbackAction): FeedbackState {
  return {
    action,
    status: 'warning',
    message: '已停止等待',
    detail: '已取消本次前端请求；如果服务端已开始执行，请稍后刷新确认最终状态。',
  }
}

export default function Sync({ repoPath }: { repoPath: string }) {
  const [remote, setRemote] = useState('')
  const [remoteInput, setRemoteInput] = useState('')
  const [remoteDraft, setRemoteDraft] = useState('')
  const [editingRemote, setEditingRemote] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [pull, setPull] = useState<SyncPullResponse | null>(null)
  const [conflicts, setConflicts] = useState<GitConflictFile[]>([])
  const [pushResult, setPushResult] = useState<{ ok?: boolean; nonFastForward?: boolean } | null>(
    null,
  )
  const [confirming, setConfirming] = useState<'force-pull' | 'force-push' | null>(null)
  const [feedback, setFeedback] = useState<FeedbackState | null>(null)
  const activeRequestRef = useRef<AbortController | null>(null)
  const { error, setError } = useViewError()
  const { showToast } = useToast()
  const totalConflictCount = conflicts.length ? (pull?.conflicts.length ?? conflicts.length) : 0
  const currentConflictNumber =
    conflicts.length && totalConflictCount
      ? Math.max(1, totalConflictCount - conflicts.length + 1)
      : 0
  const hasActiveSyncSession = conflicts.length > 0 || Boolean(pull?.sessionId)

  useEffect(() => {
    api.getSyncRemote(repoPath).then(
      (result) => {
        const value = result.remoteUrl ?? ''
        setRemote(value)
        setRemoteInput(value)
        setRemoteDraft(value)
        setEditingRemote(false)
        setLoaded(true)
      },
      (err) => {
        console.error({ err }, 'Sync remote load failed')
        setError(err)
        setLoaded(true)
      },
    )
  }, [repoPath, setError])

  useEffect(() => {
    let cancelled = false
    api.getSyncSession(repoPath).then(
      (result) => {
        if (cancelled || !result.active) return
        setPull(result)
        setConflicts(result.conflicts ?? [])
      },
      (err) => {
        if (!cancelled) {
          console.error({ err }, 'Sync session load failed')
          setError(err)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [repoPath, setError])

  const pullRemote = async () => {
    const controller = new AbortController()
    activeRequestRef.current = controller
    setFeedback(runningFeedback('pull'))
    setBusy('pull')
    setError(null)
    try {
      const result = await api.syncPull(repoPath, { signal: controller.signal })
      if (!result.ok) throw new Error(result.message ?? result.error ?? '拉取失败')
      setPull(result)
      setConflicts(result.conflicts ?? [])
      if (result.clean) {
        setFeedback({
          action: 'pull',
          status: 'success',
          message: 'Git 合并完成，无冲突',
          detail: '本地配置已按远端变更更新，可以继续上传或处理其他工作区内容。',
        })
      } else if (result.conflicts?.length) {
        setFeedback(null)
      } else {
        setFeedback({
          action: 'pull',
          status: 'success',
          message: '拉取完成',
          detail: '远端变更已处理完成。',
        })
      }
    } catch (err) {
      if (isAbortError(err)) {
        setError(null)
        setFeedback(stoppedFeedback('pull'))
        return
      }
      console.error({ err }, 'Sync pull failed')
      const message = messageOf(err)
      setError(message)
      setFeedback({
        action: 'pull',
        status: 'error',
        message: '拉取失败',
        detail: message,
      })
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null
      setBusy(null)
    }
  }

  const saveConflict = async (path: string, result: string) => {
    setBusy('save')
    setError(null)
    try {
      if (!pull?.sessionId) throw new Error('同步会话已失效，请重新拉取')
      const saved = await api.saveSyncConflict({ sessionId: pull.sessionId, path, result })
      if (!saved.ok) throw new Error(saved.message ?? saved.error ?? '保存失败')
      setConflicts(saved.remaining)
      if (saved.clean) {
        setPull({ ok: true, clean: true, conflicts: [] })
        showToast('冲突已解决，Git 合并完成')
      }
    } catch (err) {
      console.error({ err }, 'Sync conflict save failed')
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const abortMerge = async () => {
    setBusy('abort')
    setError(null)
    try {
      if (!pull?.sessionId) throw new Error('同步会话已失效')
      await api.abortSyncMerge(pull.sessionId)
      setPull(null)
      setConflicts([])
      showToast('已放弃本次合并')
    } catch (err) {
      console.error({ err }, 'Sync merge abort failed')
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const pushRemote = async () => {
    const controller = new AbortController()
    activeRequestRef.current = controller
    setFeedback(runningFeedback('push'))
    setBusy('push')
    setError(null)
    try {
      const result = (await api.syncPush(repoPath, {
        signal: controller.signal,
      })) as SyncPushResponse
      setPushResult(result)
      if (!result.ok)
        throw new Error(
          result.message ??
            result.error ??
            (result.nonFastForward ? '非 fast-forward，请先拉取' : '上传失败'),
        )
      setFeedback({
        action: 'push',
        status: 'success',
        message: '上传成功，远端已同步',
        detail: 'remote 已接收本地配置。其他设备拉取后会看到这次更新。',
      })
    } catch (err) {
      if (isAbortError(err)) {
        setError(null)
        setFeedback(stoppedFeedback('push'))
        return
      }
      console.error({ err }, 'Sync push failed')
      const message = messageOf(err)
      setError(message)
      setFeedback({
        action: 'push',
        status: 'error',
        message: '上传失败',
        detail: message,
      })
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null
      setBusy(null)
    }
  }

  const forcePullRemote = async () => {
    setConfirming(null)
    setFeedback(runningFeedback('force-pull'))
    setBusy('force-pull')
    setError(null)
    try {
      const result = await api.syncForcePull(repoPath)
      if (!result.ok) throw new Error(result.message ?? result.error ?? '强制拉取失败')
      setPull(result)
      setConflicts([])
      setPushResult(null)
      setFeedback({
        action: 'force-pull',
        status: 'success',
        message: '强制拉取完成',
        detail: '本地内容已对齐 remote。被覆盖或删除的本地内容无法由 Loom 自动恢复。',
      })
    } catch (err) {
      console.error({ err }, 'Sync force pull failed')
      const message = messageOf(err)
      setError(message)
      setFeedback({
        action: 'force-pull',
        status: 'error',
        message: '强制拉取失败',
        detail: message,
      })
    } finally {
      setBusy(null)
    }
  }

  const forcePushRemote = async () => {
    setConfirming(null)
    setFeedback(runningFeedback('force-push'))
    setBusy('force-push')
    setError(null)
    try {
      const result = (await api.syncForcePush(repoPath)) as {
        ok?: boolean
        error?: string
        message?: string
      }
      if (!result.ok) throw new Error(result.message ?? result.error ?? '强制推送失败')
      setPushResult(null)
      setFeedback({
        action: 'force-push',
        status: 'success',
        message: '强制推送完成',
        detail: 'remote 已被本地配置覆盖。其他设备需要拉取后才能获得当前状态。',
      })
    } catch (err) {
      console.error({ err }, 'Sync force push failed')
      const message = messageOf(err)
      setError(message)
      setFeedback({
        action: 'force-push',
        status: 'error',
        message: '强制推送失败',
        detail: message,
      })
    } finally {
      setBusy(null)
    }
  }

  const saveRemote = async (value: string) => {
    const nextRemote = value.trim()
    if (!nextRemote) return setError('remote URL 不能为空')
    if (remote && hasActiveSyncSession) return setError('请先解决或放弃本次合并，再更换 remote。')
    if (busy !== null || feedback !== null) return
    setBusy('remote')
    setError(null)
    try {
      const result = (await api.setSyncRemote({ repo: repoPath, remoteUrl: nextRemote })) as {
        ok?: boolean
        error?: string
        message?: string
      }
      if (result.ok === false) throw new Error(result.message ?? result.error ?? 'remote 保存失败')
      setRemote(nextRemote)
      setRemoteInput(nextRemote)
      setRemoteDraft(nextRemote)
      setEditingRemote(false)
      setPull(null)
      setConflicts([])
      setPushResult(null)
      setFeedback({
        action: 'remote',
        status: 'success',
        message: 'remote 已切换',
        detail: `remote 已切换到 ${nextRemote}，不会自动拉取，也不会自动上传。需要同步时请手动点击拉取或上传。`,
      })
    } catch (err) {
      console.error({ err }, 'Sync remote save failed')
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const confirmTitle = confirming === 'force-pull' ? '确认强制拉取' : '确认强制推送'
  const confirmMessage =
    confirming === 'force-pull'
      ? '本地未提交修改、本地提交、未跟踪文件和目录都会被远端覆盖或删除。'
      : '远端内容会被本地配置覆盖。其他设备已推送但本地没有的内容可能丢失。'
  const confirmBusy = busy === 'force-pull' || busy === 'force-push'
  const feedbackOpen = feedback !== null
  const actionDisabled = busy !== null || feedbackOpen || !remote || conflicts.length > 0
  const statusLabel = conflicts.length ? '需要处理冲突' : pull?.clean ? '已合并' : '等待同步'
  const statusTone = conflicts.length ? 'warning' : pull?.clean ? 'success' : 'idle'
  const feedbackTitle = feedback ? feedbackCopy[feedback.action].title : ''
  const feedbackBusy = feedback?.status === 'running'
  const visibleBusy = busy !== null || feedbackOpen
  const remoteSwitchDisabled = visibleBusy || hasActiveSyncSession
  const remoteSwitchHint = hasActiveSyncSession
    ? '请先解决或放弃本次合并，再更换 remote。'
    : visibleBusy
      ? '同步操作进行中，完成后再更换 remote。'
      : null

  const closeFeedback = () => {
    if (feedbackBusy && feedback) {
      activeRequestRef.current?.abort()
      activeRequestRef.current = null
      setBusy(null)
      setError(null)
      setFeedback(stoppedFeedback(feedback.action))
      return
    }
    setFeedback(null)
  }

  return (
    <div className={styles['sync-page']}>
      <div className={styles.hero}>
        <div className={styles['hero-copy']}>
          <div className="page-head">
            <div>
              <div className="page-title">Sync</div>
              <div className="page-sub">
                用 Git 规则同步 Loom 配置，把本地和 remote 保持在同一条轨道上。
              </div>
            </div>
          </div>
          <div className={styles['hero-metrics']} aria-label="同步状态摘要">
            <span>
              <strong>{remote ? 'remote ready' : 'remote missing'}</strong>
              <small>仓库连接</small>
            </span>
            <span>
              <strong>{conflicts.length || 0}</strong>
              <small>待处理冲突</small>
            </span>
            <span>
              <strong>{visibleBusy ? 'running' : 'idle'}</strong>
              <small>执行状态</small>
            </span>
          </div>
        </div>
        <div className={styles['hero-orbit']} aria-hidden="true">
          <RadioTower className={styles['orbit-icon']} />
          <span />
          <span />
        </div>
      </div>

      {loaded && !remote && (
        <section className={styles.card}>
          <span className="label">配置远程仓库</span>
          <p className={styles['card-copy']}>请输入 Git remote URL 以启用同步。</p>
          <div className={styles['remote-form']}>
            <input
              className={styles['mock-input']}
              value={remoteInput}
              onChange={(event) => setRemoteInput(event.target.value)}
              placeholder="https://github.com/user/repo.git"
            />
            <Button
              size="sm"
              variant="primary"
              onClick={() => void saveRemote(remoteInput)}
              disabled={busy !== null}
            >
              保存
            </Button>
          </div>
        </section>
      )}

      {remote && (
        <section
          className={styles['remote-card']}
          data-editing={editingRemote ? 'true' : undefined}
          aria-label="当前远程仓库"
        >
          <div className={styles['remote-kicker']}>
            <GitBranch className="h-3.5 w-3.5" />
            <span>remote</span>
          </div>
          {editingRemote ? (
            <div className={styles['remote-edit']}>
              <input
                aria-label="remote URL"
                className={styles['mock-input']}
                value={remoteDraft}
                onChange={(event) => setRemoteDraft(event.target.value)}
                placeholder="https://github.com/user/repo.git"
              />
              <div className={styles['remote-edit-actions']}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setRemoteDraft(remote)
                    setEditingRemote(false)
                    setError(null)
                  }}
                  disabled={busy === 'remote'}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  aria-label="保存 remote"
                  onClick={() => void saveRemote(remoteDraft)}
                  disabled={busy !== null || !remoteDraft.trim()}
                >
                  {busy === 'remote' ? '保存中…' : '保存'}
                </Button>
              </div>
              <p className={styles['remote-hint']}>
                只更换 Git origin URL，不会自动拉取、上传或提交。
              </p>
            </div>
          ) : (
            <>
              <a href={remote} target="_blank" rel="noreferrer" className={styles['remote-link']}>
                {remote}
              </a>
              <div className={styles['remote-actions']}>
                <span className={styles['remote-chip']} data-tone={statusTone}>
                  {statusLabel}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="更换 remote"
                  onClick={() => {
                    setRemoteDraft(remote)
                    setEditingRemote(true)
                    setError(null)
                  }}
                  disabled={remoteSwitchDisabled}
                >
                  更换
                </Button>
              </div>
              {remoteSwitchHint && <p className={styles['remote-blocked']}>{remoteSwitchHint}</p>}
            </>
          )}
        </section>
      )}

      <section className={styles['sync-console']} aria-label="同步操作">
        <div className={styles['console-head']}>
          <div>
            <span className="label">sync console</span>
            <p>
              {conflicts.length
                ? 'Git 检测到 ' +
                  totalConflictCount +
                  ' 个冲突文件，当前显示第 ' +
                  currentConflictNumber +
                  '/' +
                  totalConflictCount +
                  ' 个，保存后继续下一个'
                : pull?.clean
                  ? '合并成功，无冲突。需要共享到远端时，可以继续上传。'
                  : '先拉取 remote，再按需要上传本地配置；危险覆盖操作会二次确认。'}
            </p>
          </div>
          <span className={styles['console-status']} data-tone={statusTone}>
            <span />
            {statusLabel}
          </span>
        </div>

        <div className={styles['action-grid']}>
          <button
            type="button"
            className={styles['action-card']}
            aria-label="拉取"
            onClick={() => void pullRemote()}
            disabled={actionDisabled}
          >
            <span className={styles['action-icon']}>
              <ArrowDownToLine className="h-4 w-4" />
            </span>
            <span>
              <strong>{busy === 'pull' ? '拉取中…' : '拉取'}</strong>
              <small>合并 remote 变更</small>
            </span>
          </button>

          <button
            type="button"
            className={styles['action-card']}
            aria-label="上传"
            onClick={() => void pushRemote()}
            disabled={actionDisabled}
          >
            <span className={styles['action-icon']}>
              <Upload className="h-4 w-4" />
            </span>
            <span>
              <strong>{busy === 'push' ? '上传中…' : '上传'}</strong>
              <small>推送本地配置</small>
            </span>
          </button>

          <button
            type="button"
            className={styles['action-card']}
            data-danger="true"
            aria-label="强制拉取"
            onClick={() => setConfirming('force-pull')}
            disabled={actionDisabled}
          >
            <span className={styles['action-icon']}>
              <ShieldAlert className="h-4 w-4" />
            </span>
            <span>
              <strong>{busy === 'force-pull' ? '强制拉取中…' : '强制拉取'}</strong>
              <small>remote 覆盖本地</small>
            </span>
          </button>

          <button
            type="button"
            className={styles['action-card']}
            data-danger="true"
            aria-label="强制推送"
            onClick={() => setConfirming('force-push')}
            disabled={actionDisabled}
          >
            <span className={styles['action-icon']}>
              <Upload className="h-4 w-4" />
            </span>
            <span>
              <strong>{busy === 'force-push' ? '强制推送中…' : '强制推送'}</strong>
              <small>本地覆盖 remote</small>
            </span>
          </button>
        </div>
      </section>

      {error && (
        <div className={styles['error-card']} role="alert">
          <AlertTriangle className="h-4 w-4" />
          {String(error)}
        </div>
      )}

      {conflicts[0] && (
        <Suspense
          fallback={
            <div style={{ marginTop: 18, color: 'var(--muted)', fontSize: 12 }}>
              正在加载冲突编辑器…
            </div>
          }
        >
          <ConflictEditor
            conflict={conflicts[0]}
            index={(pull?.conflicts.length ?? conflicts.length) - conflicts.length}
            total={pull?.conflicts.length ?? conflicts.length}
            saving={busy === 'save' || busy === 'abort'}
            onSave={saveConflict}
            onAbort={abortMerge}
          />
        </Suspense>
      )}

      {pushResult?.ok && (
        <div className={styles['success-note']}>
          <CheckCircle2 className="h-4 w-4" />
          上传成功
        </div>
      )}

      <Modal
        open={feedback !== null}
        onClose={closeFeedback}
        title={feedbackTitle}
        width={440}
        busy={false}
      >
        {feedback && (
          <div className={styles['feedback-body']}>
            <div className={styles['feedback-main']}>
              <span className={styles['feedback-icon']} data-status={feedback.status}>
                {feedback.status === 'running' ? (
                  <Loader2 className="h-5 w-5" />
                ) : feedback.status === 'success' ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <AlertTriangle className="h-5 w-5" />
                )}
              </span>
              <div>
                <p className={styles['feedback-message']}>{feedback.message}</p>
                <p className={styles['feedback-detail']}>{feedback.detail}</p>
              </div>
            </div>
            <div className={styles['modal-actions']}>
              {feedbackBusy ? (
                <Button size="sm" variant="secondary" onClick={closeFeedback}>
                  停止等待
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setFeedback(null)}>
                  关闭
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!confirmBusy) setConfirming(null)
        }}
        title={confirmTitle}
        width={420}
        busy={confirmBusy}
      >
        <div className={styles['confirm-body']}>
          <div className={styles['confirm-alert']}>
            <ShieldAlert className="h-4 w-4" />
            <p>{confirmMessage}</p>
          </div>
          <p className={styles['confirm-copy']}>这是不安全操作，确认后无法由 Loom 自动恢复。</p>
          <div className={styles['modal-actions']}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirming(null)}
              disabled={confirmBusy}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (!confirming) return
                void (confirming === 'force-pull' ? forcePullRemote() : forcePushRemote())
              }}
              disabled={confirmBusy}
            >
              {confirmBusy ? '执行中…' : confirmTitle}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
