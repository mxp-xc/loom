import { useState } from 'react'
import { api } from '@/lib/api'

export default function Sync({ repoPath }: { repoPath: string }) {
  const [pull, setPull] = useState<unknown>(null)
  const [push, setPush] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<unknown>, set: (v: unknown) => void) => {
    setError(null); setBusy(label)
    try { set(await fn()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  const pullResult = pull as { clean?: boolean; files?: unknown[]; varsFiles?: unknown[]; textConflicts?: unknown[] } | null
  const pushResult = push as { ok?: boolean; nonFastForward?: boolean } | null

  return (
    <div>
      <div className="head">
        <div className="page-title">Sync</div>
      </div>

      <div className="syncbar">
        <span className="msg">
          {pullResult
            ? pullResult.clean ? '合并成功,无冲突' : `存在冲突`
            : '尚未拉取'}
        </span>
        <span className="acts">
          <button className="sbtn" onClick={() => run('pull', () => api.syncPull(repoPath), setPull)} disabled={busy !== null}>
            {busy === 'pull' ? '拉取中…' : '⇅ 拉取'}
          </button>
          <button className="sbtn" onClick={() => run('push', () => api.syncPush(repoPath), setPush)} disabled={busy !== null}>
            {busy === 'push' ? '上传中…' : '↑ 上传'}
          </button>
        </span>
      </div>

      {error && <div style={{ marginTop: 12, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--error)' }}>{error}</div>}

      {pullResult && !pullResult.clean && pullResult.files && (
        <div style={{ marginTop: 22 }}>
          <span className="label">冲突字段</span>
          {pullResult.files.map((f: any, i: number) => f.result?.conflicts?.map((c: any, j: number) => (
            <div key={`${i}-${j}`} style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--nav)' }}>
                <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--bright)' }}>{f.path}</span>
                <span style={{ color: 'var(--muted)' }}>·</span>
                <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--text)' }}>{c.path}</span>
                <span style={{ color: 'var(--muted)' }}>·</span>
                <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--text)' }}>{c.field}</span>
                <span style={{ marginLeft: 'auto', fontFamily: "'Fira Code', monospace", fontSize: 9, padding: '2px 7px', borderRadius: 3, background: 'rgba(251,191,36,0.12)', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)' }}>conflict</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
                <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                  <div className="label" style={{ marginBottom: 6 }}>LOCAL</div>
                  <div style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{String(c.ours)}</div>
                </div>
                <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                  <div className="label" style={{ marginBottom: 6 }}>BASE</div>
                  <div style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--muted)' }}>{String(c.base)}</div>
                </div>
                <div style={{ padding: '12px 14px' }}>
                  <div className="label" style={{ marginBottom: 6 }}>REMOTE</div>
                  <div style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{String(c.theirs)}</div>
                </div>
              </div>
            </div>
          )))}
        </div>
      )}

      {pullResult?.textConflicts && pullResult.textConflicts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <span className="label">文本文件冲突(需外部解决)</span>
          <div style={{ marginTop: 8, fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--warn)' }}>
            {(pullResult.textConflicts as any[]).map((t, i) => <div key={i}>{t.file}</div>)}
          </div>
        </div>
      )}

      {pushResult && (
        <div style={{ marginTop: 16, padding: 11, border: `1px solid ${pushResult.ok ? 'var(--signal)' : 'var(--error)'}`, borderRadius: 6, background: 'var(--card)' }}>
          <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, color: pushResult.ok ? 'var(--signal)' : 'var(--error)' }}>
            {pushResult.ok ? '✓ 上传成功' : pushResult.nonFastForward ? '✕ 非 fast-forward,需先拉取' : '✕ 上传失败'}
          </span>
        </div>
      )}
    </div>
  )
}
