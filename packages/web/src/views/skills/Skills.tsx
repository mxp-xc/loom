import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronsDownUp, ChevronsUpDown, Plus, RefreshCw } from 'lucide-react'
import { useManifest } from '@/hooks/useManifest'
import { useManifestOperations } from '@/hooks/useManifestOperations'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import type { SkillSource } from '@loom/core'
import SkillSourceList from './SkillSourceList'
import GlobalTargetsBar from './GlobalTargetsBar'
import MemberScanModal from './MemberScanModal'
import SkillDetailEditor from './SkillDetailEditor'
import EditSourceModal from './EditSourceModal'
import AddSkillModal from './AddSkillModal'
import type { SkillDetail } from './types'
import styles from './Skills.module.css'

export default function Skills({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError()
  const { manifest } = useManifest(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
  })
  const { showToast } = useToast()
  const operations = useManifestOperations(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
    onToast: showToast,
  })
  const [addOpen, setAddOpen] = useState(false)
  const [scanSource, setScanSource] = useState<SkillSource | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [editSource, setEditSource] = useState<SkillSource | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const sourceCount = manifest?.skills?.sources?.length ?? 0
  const localCount = manifest?.skills?.skills?.length ?? 0
  const totalSkills =
    (manifest?.skills?.sources?.reduce((acc, s) => acc + (s.members?.length ?? 0), 0) ?? 0) +
    localCount
  const groupKeys = [
    ...(manifest?.skills?.sources.map((source) => `${source.url}-${source.ref}`) ?? []),
    ...(localCount > 0 ? ['local'] : []),
  ]
  const allCollapsed = groupKeys.every((key) => !expandedGroups.has(key))

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAllGroups = () => {
    setExpandedGroups(allCollapsed ? new Set(groupKeys) : new Set())
  }

  return (
    <div className={styles['skills-page']}>
      <div className="page-head">
        <div>
          <div className="page-title">Skills</div>
          <div className="page-sub">
            {totalSkills} skills · {sourceCount} sources · {localCount} local
          </div>
        </div>
        <div className={styles['skills-head-actions']}>
          {groupKeys.length > 0 && (
            <Button variant="secondary" size="sm" onClick={toggleAllGroups}>
              {allCollapsed ? (
                <ChevronsUpDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronsDownUp className="h-3.5 w-3.5" />
              )}
              {allCollapsed ? '全部展开' : '全部收起'}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add skill
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className={styles['project-button']}
            onClick={() => void operations.project('skills')}
            disabled={operations.pending.project('skills')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {operations.pending.project('skills') ? '投影中…' : '投影'}
          </Button>
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
          <GlobalTargetsBar manifest={manifest} operations={operations} />
          <SkillSourceList
            manifest={manifest}
            operations={operations}
            onOpenDetail={setDetail}
            onOpenScan={setScanSource}
            onOpenEdit={setEditSource}
            expandedGroups={expandedGroups}
            onToggleGroup={toggleGroup}
          />
        </>
      )}

      <MemberScanModal
        source={scanSource}
        operations={operations}
        onClose={() => setScanSource(null)}
        onConfirm={() => setScanSource(null)}
      />

      <SkillDetailEditor
        repoPath={repoPath}
        detail={detail}
        showToast={showToast}
        onClose={() => setDetail(null)}
      />

      <AddSkillModal open={addOpen} repoPath={repoPath} onClose={() => setAddOpen(false)} />
      <EditSourceModal
        repoPath={repoPath}
        source={editSource}
        showToast={showToast}
        onClose={() => setEditSource(null)}
        onSaved={() => setEditSource(null)}
      />
    </div>
  )
}
