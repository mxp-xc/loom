import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowDownToLine, Upload } from 'lucide-react'
import { api, type GitConflictFile, type SyncPullResponse } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import Modal from '@/components/Modal'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'

const ConflictEditor = lazy(() => import('./sync/ConflictEditor'))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function Sync({ repoPath }: { repoPath: string }) {
  const [remote, setRemote] = useState('')
  const [remoteInput, setRemoteInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [pull, setPull] = useState<SyncPullResponse | null>(null)
  const [conflicts, setConflicts] = useState<GitConflictFile[]>([])
  const [pushResult, setPushResult] = useState<{ ok?: boolean; nonFastForward?: boolean } | null>(
    null,
  )
  const [confirming, setConfirming] = useState<'force-pull' | 'force-push' | null>(null)
  const { error, setError } = useViewError()
  const { showToast } = useToast()
  const totalConflictCount = conflicts.length ? (pull?.conflicts.length ?? conflicts.length) : 0
  const currentConflictNumber =
    conflicts.length && totalConflictCount
      ? Math.max(1, totalConflictCount - conflicts.length + 1)
      : 0

  useEffect(() => {
    api.getSyncRemote(repoPath).then(
      (result) => {
        const value = result.remoteUrl ?? ''
        setRemote(value)
        setRemoteInput(value)
        setLoaded(true)
      },
      (err) => {
        setError(err)
        setLoaded(true)
      },
    )
  }, [repoPath])

  useEffect(() => {
    let cancelled = false
    api.getSyncSession(repoPath).then(
      (result) => {
        if (cancelled || !result.active) return
        setPull(result)
        setConflicts(result.conflicts ?? [])
      },
      (err) => {
        if (!cancelled) setError(err)
      },
    )
    return () => {
      cancelled = true
    }
  }, [repoPath, setError])

  const pullRemote = async () => {
    setBusy('pull')
    setError(null)
    try {
      const result = await api.syncPull(repoPath)
      if (!result.ok) throw new Error(result.message ?? result.error ?? '拉取失败')
      setPull(result)
      setConflicts(result.conflicts ?? [])
      if (result.clean) showToast('Git 合并完成，无冲突')
    } catch (err) {
      setError(messageOf(err))
    } finally {
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
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const pushRemote = async () => {
    setBusy('push')
    setError(null)
    try {
      const result = (await api.syncPush(repoPath)) as { ok?: boolean; nonFastForward?: boolean }
      setPushResult(result)
      if (!result.ok)
        throw new Error(result.nonFastForward ? '非 fast-forward，请先拉取' : '上传失败')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const forcePullRemote = async () => {
    setBusy('force-pull')
    setError(null)
    try {
      const result = await api.syncForcePull(repoPath)
      if (!result.ok) throw new Error(result.message ?? result.error ?? '强制拉取失败')
      setPull(result)
      setConflicts([])
      setPushResult(null)
      setConfirming(null)
      showToast('强制拉取完成')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const forcePushRemote = async () => {
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
      setConfirming(null)
      showToast('强制推送完成')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const saveRemote = async () => {
    if (!remoteInput.trim()) return setError('remote URL 不能为空')
    setBusy('remote')
    try {
      await api.setSyncRemote({ repo: repoPath, remoteUrl: remoteInput.trim() })
      setRemote(remoteInput.trim())
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const forceDisabled = busy !== null || !remote || conflicts.length > 0
  const confirmTitle = confirming === 'force-pull' ? '确认强制拉取' : '确认强制推送'
  const confirmMessage =
    confirming === 'force-pull'
      ? '本地未提交修改、本地提交、未跟踪文件和目录都会被远端覆盖或删除。'
      : '远端内容会被本地配置覆盖。其他设备已推送但本地没有的内容可能丢失。'
  const confirmBusy = busy === 'force-pull' || busy === 'force-push'

  return (
    <div>
      <div className="head">
        <div className="page-title">Sync</div>
      </div>

      {loaded && !remote && (
        <div
          style={{
            marginTop: 14,
            padding: 18,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--card)',
          }}
        >
          <span className="label">配置远程仓库</span>
          <p style={{ marginTop: 6, fontSize: 13, color: 'var(--muted)' }}>
            请输入 Git remote URL 以启用同步。
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              className="mock-input"
              style={{ flex: 1 }}
              value={remoteInput}
              onChange={(event) => setRemoteInput(event.target.value)}
              placeholder="https://github.com/user/repo.git"
            />
            <Button size="sm" variant="primary" onClick={saveRemote} disabled={busy !== null}>
              保存
            </Button>
          </div>
        </div>
      )}

      {remote && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8, fontSize: 12 }}>
          <span className="label">remote</span>
          <a
            href={remote}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--primary)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            {remote}
          </a>
        </div>
      )}

      <div className="syncbar" style={{ marginTop: 12 }}>
        <span className="msg">
          {conflicts.length
            ? `Git 检测到 ${totalConflictCount} 个冲突文件，当前显示第 ${currentConflictNumber}/${totalConflictCount} 个，保存后继续下一个`
            : pull?.clean
              ? '合并成功，无冲突'
              : '点击拉取并按 Git 规则合并远程变更'}
        </span>
        <span className="acts">
          <IconButton
            label="拉取"
            tooltip={busy === 'pull' ? '拉取中…' : '拉取'}
            onClick={pullRemote}
            disabled={busy !== null || !remote || conflicts.length > 0}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="上传"
            tooltip={busy === 'push' ? '上传中…' : '上传'}
            onClick={pushRemote}
            disabled={busy !== null || !remote || conflicts.length > 0}
          >
            <Upload className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="强制拉取"
            tooltip={busy === 'force-pull' ? '强制拉取中…' : '强制拉取'}
            tone="danger"
            onClick={() => setConfirming('force-pull')}
            disabled={forceDisabled}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="强制推送"
            tooltip={busy === 'force-push' ? '强制推送中…' : '强制推送'}
            tone="danger"
            onClick={() => setConfirming('force-push')}
            disabled={forceDisabled}
          >
            <Upload className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: '1px solid var(--error)',
            borderRadius: 'var(--radius-card)',
            color: 'var(--error)',
            fontSize: 12,
          }}
        >
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
        <div style={{ marginTop: 12, color: 'var(--primary)', fontSize: 12 }}>✓ 上传成功</div>
      )}
      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!confirmBusy) setConfirming(null)
        }}
        title={confirmTitle}
        width={420}
        busy={confirmBusy}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, color: 'var(--text)', fontSize: 13, lineHeight: 1.7 }}>
            {confirmMessage}
          </p>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
            这是不安全操作，确认后无法由 Loom 自动恢复。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
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
              onClick={() =>
                void (confirming === 'force-pull' ? forcePullRemote() : forcePushRemote())
              }
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
