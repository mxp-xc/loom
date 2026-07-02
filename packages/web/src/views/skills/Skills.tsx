import { useState } from 'react'
import Toast from '@/components/Toast'
import { api } from '@/lib/api'
import { useManifest } from '@/hooks/useManifest'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import type { SkillSource } from '@loom/core'
import SkillSourceList from './SkillSourceList'
import GlobalTargetsBar from './GlobalTargetsBar'
import MemberScanModal from './MemberScanModal'
import SkillDetailEditor from './SkillDetailEditor'
import AddSkillModal from './AddSkillModal'
import type { SkillDetail } from './types'

export default function Skills({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError()
  const { manifest, reload } = useManifest(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
  })
  const { toast, showToast, dismiss } = useToast()
  const [projecting, setProjecting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [scanSource, setScanSource] = useState<SkillSource | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)

  const project = async () => {
    setProjecting(true)
    setError(null)
    try {
      const res = (await api.project({ repoPath })) as any
      if (res.ok) {
        showToast('投影完成')
        reload()
      } else {
        setError(res.message || '投影失败')
      }
    } catch (e) {
      setError(e)
    } finally {
      setProjecting(false)
    }
  }

  const sourceCount = manifest?.skills?.sources?.length ?? 0
  const localCount = manifest?.skills?.skills?.length ?? 0
  const totalSkills =
    (manifest?.skills?.sources?.reduce((acc, s) => acc + (s.members?.length ?? 0), 0) ?? 0) +
    localCount

  return (
    <div>
      <div className="head">
        <div>
          <div className="page-title">Skills</div>
          <div className="page-sub">
            {totalSkills} skills · {sourceCount} sources · {localCount} local
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="add-btn" onClick={() => setAddOpen(true)}>
            + Add skill
          </button>
          <button className="add-btn" onClick={project} disabled={projecting}>
            {projecting ? '投影中…' : '投影'}
          </button>
        </div>
      </div>

      {manifest?.errors && manifest.errors.length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: `1px solid var(--error)`,
            borderRadius: 'var(--radius-card)',
            background: 'var(--card)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: 'var(--error)',
          }}
        >
          {manifest.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
      {error && (
        <div
          style={{
            marginTop: 12,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            color: 'var(--error)',
          }}
        >
          {error}
        </div>
      )}
      {toast && <Toast message={toast} onClose={dismiss} />}

      {!manifest && !error && <div style={{ color: 'var(--muted)', marginTop: 20 }}>加载中…</div>}

      {sourceCount === 0 && localCount === 0 && manifest && (
        <div
          style={{
            marginTop: 18,
            padding: 32,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            textAlign: 'center',
            color: 'var(--muted)',
          }}
        >
          <p style={{ fontSize: 14 }}>还没有配置任何 Skill</p>
          <p style={{ marginTop: 4, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
            点击右上 <b>+ Add skill</b> 添加 source 或 local skill
          </p>
        </div>
      )}

      {manifest && (
        <>
          <GlobalTargetsBar
            repoPath={repoPath}
            manifest={manifest}
            reload={reload}
            setError={setError}
          />
          <SkillSourceList
            repoPath={repoPath}
            manifest={manifest}
            reload={reload}
            showToast={showToast}
            setError={setError}
            onOpenDetail={setDetail}
            onOpenScan={setScanSource}
          />
        </>
      )}

      <MemberScanModal
        repoPath={repoPath}
        source={scanSource}
        showToast={showToast}
        setError={setError}
        onClose={() => setScanSource(null)}
        onConfirm={() => {
          setScanSource(null)
          reload()
        }}
      />

      <SkillDetailEditor
        repoPath={repoPath}
        detail={detail}
        showToast={showToast}
        onClose={() => setDetail(null)}
      />

      <AddSkillModal
        open={addOpen}
        repoPath={repoPath}
        reload={reload}
        onClose={() => setAddOpen(false)}
      />
    </div>
  )
}
