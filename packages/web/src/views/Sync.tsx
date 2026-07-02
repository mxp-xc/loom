import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Toast from '@/components/Toast'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'

const ERROR_MAP: Record<string, string> = {
  no_remote: '未配置远程仓库，请先在下方配置 git remote URL',
  auth_failed: '认证失败，请检查 remote URL 或凭证',
  network: '网络错误，请检查连接',
  conflict: '存在冲突，请先解决后再推送',
  dirty: '工作区有未提交的改动，请先提交或暂存',
}

function translateError(msg: string): string {
  if (!msg) return '操作失败，请检查仓库配置和网络连接'
  // Check if the response contains a structured error code
  for (const [code, text] of Object.entries(ERROR_MAP)) {
    if (msg.toLowerCase().includes(code)) return text
  }
  // Fallback heuristics
  if (msg.includes('500') && msg.includes('Internal Server Error')) return '服务端错误，请稍后重试'
  if (msg.includes('no such remote') || msg.includes('No configured push destination'))
    return ERROR_MAP.no_remote
  if (msg.includes('Authentication failed') || msg.includes('401') || msg.includes('403'))
    return ERROR_MAP.auth_failed
  if (msg.includes('non-fast-forward') || msg.includes('fetch first')) return ERROR_MAP.conflict
  if (msg.includes('dirty') || msg.includes('uncommitted')) return ERROR_MAP.dirty
  if (msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT') || msg.includes('network'))
    return ERROR_MAP.network
  return msg
}

export default function Sync({ repoPath }: { repoPath: string }) {
  const [pull, setPull] = useState<unknown>(null)
  const [push, setPush] = useState<unknown>(null)
  const { error, setError } = useViewError()
  const [busy, setBusy] = useState<string | null>(null)
  const [savedRemote, setSavedRemote] = useState<string>('')
  const [remoteInput, setRemoteInput] = useState<string>('')
  const [remoteLoaded, setRemoteLoaded] = useState(false)
  const [remoteSaving, setRemoteSaving] = useState(false)
  const [remoteErr, setRemoteErr] = useState<string | null>(null)

  const [resolutions, setResolutions] = useState<Record<string, 'ours' | 'theirs'>>({})
  const { toast, showToast, dismiss } = useToast()

  // Load remote URL on mount
  useEffect(() => {
    api
      .getSyncRemote(repoPath)
      .then((r) => {
        setSavedRemote(r.remoteUrl ?? '')
        setRemoteInput(r.remoteUrl ?? '')
        setRemoteLoaded(true)
      })
      .catch(() => setRemoteLoaded(true))
  }, [repoPath])

  const run = async (label: string, fn: () => Promise<unknown>, set: (v: unknown) => void) => {
    setError(null)
    setBusy(label)
    try {
      const result = await fn()
      // Check for structured error in response body (200 + ok:false)
      if (result && typeof result === 'object' && 'ok' in result && (result as any).ok === false) {
        const r = result as any
        if (r.nonFastForward) setError('非 fast-forward，请先拉取远程变更')
        else setError(translateError(r.message))
        return
      }
      set(result)
    } catch (e) {
      setError(translateError(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(null)
    }
  }

  const saveRemote = async () => {
    if (!remoteInput.trim()) {
      setRemoteErr('remote URL 不能为空')
      return
    }
    setRemoteSaving(true)
    setRemoteErr(null)
    try {
      await api.setSyncRemote({ repoPath, remoteUrl: remoteInput.trim() })
      setSavedRemote(remoteInput.trim())
      setRemoteLoaded(true)
    } catch (e) {
      setRemoteErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoteSaving(false)
    }
  }

  const pullResult = pull as {
    clean?: boolean
    files?: unknown[]
    varsFiles?: unknown[]
    textConflicts?: unknown[]
  } | null
  const pushResult = push as { ok?: boolean; nonFastForward?: boolean } | null

  const hasRemote = savedRemote.trim().length > 0

  return (
    <div>
      <div className="head">
        <div className="page-title">Sync</div>
      </div>

      {/* Remote config */}
      {remoteLoaded && !hasRemote && (
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
            尚未配置 git remote，拉取和上传功能不可用。请输入远程仓库 URL。
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              value={remoteInput}
              onChange={(e) => {
                setRemoteInput(e.target.value)
                setRemoteErr(null)
              }}
              placeholder="https://github.com/user/repo.git"
              style={{
                flex: 1,
                padding: '7px 10px',
                fontSize: 13,
                fontFamily: "'JetBrains Mono', monospace",
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
            <button className="add-btn" onClick={saveRemote} disabled={remoteSaving}>
              {remoteSaving ? '保存中…' : '保存'}
            </button>
          </div>
          {remoteErr && (
            <div
              style={{
                marginTop: 8,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                color: 'var(--error)',
              }}
            >
              {remoteErr}
            </div>
          )}
        </div>
      )}

      {/* Current remote display */}
      {remoteLoaded && hasRemote && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span className="label">remote</span>
          <a
            href={savedRemote}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: 'var(--primary)',
              textDecoration: 'none',
            }}
          >
            {savedRemote}
          </a>
        </div>
      )}

      <div className="syncbar" style={{ marginTop: hasRemote ? 12 : 16 }}>
        <span className="msg">
          {pullResult
            ? pullResult.clean
              ? '合并成功,无冲突'
              : `存在冲突,请选择解决方式后点击「应用解决」`
            : '点击拉取预览远程变更'}
        </span>
        <span className="acts">
          <button
            className="sbtn"
            onClick={() => run('pull', () => api.syncPull(repoPath), setPull)}
            disabled={busy !== null || !hasRemote}
          >
            {busy === 'pull' ? '拉取中…' : '⇅ 拉取'}
          </button>
          <button
            className="sbtn"
            onClick={() => run('push', () => api.syncPush(repoPath), setPush)}
            disabled={busy !== null || !hasRemote}
          >
            {busy === 'push' ? '上传中…' : '↑ 上传'}
          </button>
        </span>
      </div>

      {!hasRemote && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          请先配置 remote URL 以启用同步功能
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: '1px solid var(--error)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--card)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            color: 'var(--error)',
          }}
        >
          {error}
        </div>
      )}

      {pullResult && !pullResult.clean && (
        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 'auto' }}>
            {(() => {
              const totalConflicts = (pullResult.files ?? []).reduce(
                (acc: number, f: any) => acc + (f.result?.conflicts?.length ?? 0),
                0,
              )
              const resolved = Object.keys(resolutions).length
              return resolved === totalConflicts
                ? `全部 ${totalConflicts} 项已选择`
                : `已选择 ${resolved}/${totalConflicts} 项`
            })()}
          </span>
          <button
            className="sbtn"
            onClick={() => {
              setPull(null)
              setResolutions({})
              setError(null)
            }}
            disabled={busy !== null}
          >
            放弃
          </button>
          <button
            className="add-btn"
            style={{ marginLeft: 0 }}
            onClick={async () => {
              setBusy('apply')
              setError(null)
              try {
                await api.syncApply(repoPath, resolutions)
                setPull(null)
                setResolutions({})
                showToast('冲突已解决并合并')
              } catch (e) {
                setError(e)
              } finally {
                setBusy(null)
              }
            }}
            disabled={
              busy !== null ||
              (() => {
                const totalConflicts = (pullResult.files ?? []).reduce(
                  (acc: number, f: any) => acc + (f.result?.conflicts?.length ?? 0),
                  0,
                )
                return Object.keys(resolutions).length !== totalConflicts
              })()
            }
          >
            {busy === 'apply' ? '应用中…' : '应用解决'}
          </button>
        </div>
      )}

      {pullResult && !pullResult.clean && pullResult.files && (
        <div style={{ marginTop: 22 }}>
          <span className="label">冲突字段</span>
          {pullResult.files.map((f: any, i: number) =>
            f.result?.conflicts?.map((c: any, j: number) => (
              <div
                key={`${i}-${j}`}
                style={{
                  marginTop: 8,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-card)',
                  overflow: 'hidden',
                  background: 'var(--card)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: 'var(--bright)',
                    }}
                  >
                    {f.path}
                  </span>
                  <span style={{ color: 'var(--muted)' }}>·</span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: 'var(--text)',
                    }}
                  >
                    {c.path}
                  </span>
                  <span style={{ color: 'var(--muted)' }}>·</span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: 'var(--text)',
                    }}
                  >
                    {c.field}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 9,
                      padding: '2px 7px',
                      borderRadius: 'var(--radius)',
                      background: 'rgba(251,191,36,0.12)',
                      color: 'var(--warn)',
                      border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
                    }}
                  >
                    conflict
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
                  <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                    <div className="label" style={{ marginBottom: 6 }}>
                      LOCAL
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        color: 'var(--text)',
                      }}
                    >
                      {String(c.ours)}
                    </div>
                  </div>
                  <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                    <div className="label" style={{ marginBottom: 6 }}>
                      BASE
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        color: 'var(--muted)',
                      }}
                    >
                      {String(c.base)}
                    </div>
                  </div>
                  <div style={{ padding: '12px 14px' }}>
                    <div className="label" style={{ marginBottom: 6 }}>
                      REMOTE
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        color: 'var(--text)',
                      }}
                    >
                      {String(c.theirs)}
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '8px 14px',
                    borderTop: '1px solid var(--border)',
                    background: 'var(--bg)',
                  }}
                >
                  <button
                    className="sbtn"
                    style={
                      resolutions[`${c.file}:${c.path}:${c.field}`] === 'ours'
                        ? { borderColor: 'var(--primary)', color: 'var(--primary)' }
                        : {}
                    }
                    onClick={() =>
                      setResolutions((prev) => ({
                        ...prev,
                        [`${c.file}:${c.path}:${c.field}`]: 'ours',
                      }))
                    }
                  >
                    使用本地
                  </button>
                  <button
                    className="sbtn"
                    style={
                      resolutions[`${c.file}:${c.path}:${c.field}`] === 'theirs'
                        ? { borderColor: 'var(--primary)', color: 'var(--primary)' }
                        : {}
                    }
                    onClick={() =>
                      setResolutions((prev) => ({
                        ...prev,
                        [`${c.file}:${c.path}:${c.field}`]: 'theirs',
                      }))
                    }
                  >
                    使用远程
                  </button>
                </div>
              </div>
            )),
          )}
        </div>
      )}

      {pullResult?.textConflicts && pullResult.textConflicts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <span className="label">文本文件冲突(需外部解决)</span>
          <div
            style={{
              marginTop: 8,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: 'var(--warn)',
            }}
          >
            {(pullResult.textConflicts as any[]).map((t, i) => (
              <div key={i}>{t.file}</div>
            ))}
          </div>
        </div>
      )}

      {pushResult && (
        <div
          style={{
            marginTop: 16,
            padding: 11,
            border: `1px solid ${pushResult.ok ? 'var(--primary)' : 'var(--error)'}`,
            borderRadius: 'var(--radius-card)',
            background: 'var(--card)',
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              color: pushResult.ok ? 'var(--primary)' : 'var(--error)',
            }}
          >
            {pushResult.ok
              ? '✓ 上传成功'
              : pushResult.nonFastForward
                ? '✕ 非 fast-forward,需先拉取'
                : '✕ 上传失败'}
          </span>
        </div>
      )}
      {toast && <Toast message={toast} onClose={dismiss} />}
    </div>
  )
}
