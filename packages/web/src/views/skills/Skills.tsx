import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { ChevronsDownUp, ChevronsUpDown, LoaderCircle, Plus, RefreshCw, Send } from 'lucide-react'
import { useManifest } from '@/hooks/useManifest'
import { sourceUpdateSnapshot, useManifestOperations } from '@/hooks/useManifestOperations'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import { ErrorState, WarningState } from '@/components/ErrorFeedback'
import {
  applicableAgents,
  formatSourceMemberSkillId,
  normalizeOrder,
  normalizeSkillGroupOrder,
  type SkillSource,
} from '@loom/core'
import { api } from '@/lib/api'
import SkillSourceList from './SkillSourceList'
import GlobalAgentsBar from './GlobalAgentsBar'
import SkillDetailEditor from './SkillDetailEditor'
import EditSourceModal from './EditSourceModal'
import AddSkillModal from './AddSkillModal'
import SourceNamespaceCollisionDialog from './SourceNamespaceCollisionDialog'
import type { SkillDetail, SkillDetailIdentity } from './types'
import styles from './Skills.module.css'

function repositorySourceUpdateSnapshot(repoPath: string, source: SkillSource): string {
  return JSON.stringify([repoPath, sourceUpdateSnapshot(source)])
}

export default function Skills({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError({
    title: 'Skills 加载失败',
    message: '请检查项目配置后重试',
  })
  const { manifest } = useManifest(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
  })
  const { showToast, showErrorToast } = useToast()
  const operations = useManifestOperations(repoPath, {
    onError: (message) =>
      showErrorToast(new Error(message), {
        title: 'Skills 操作失败',
        message: '请检查配置后重试',
      }),
    onToast: showToast,
  })
  const [addOpen, setAddOpen] = useState(false)
  const [detailIdentity, setDetailIdentity] = useState<SkillDetailIdentity | null>(null)
  const [editSource, setEditSource] = useState<SkillSource | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [groupOrder, setGroupOrder] = useState<string[]>([])
  const checkedSourceSnapshotsRef = useRef(new Map<string, string>())
  const manifestSourceSnapshotsRef = useRef(new Map<string, string>())
  manifestSourceSnapshotsRef.current = new Map(
    manifest?.skills.sources.map((source) => [
      source.url,
      repositorySourceUpdateSnapshot(repoPath, source),
    ]) ?? [],
  )

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
  const normalizedGroupOrder = manifest
    ? normalizeOrder(groupOrder, normalizeSkillGroupOrder(manifest.skills))
    : []
  const visibleAgents = applicableAgents(manifest?.config?.agents, 'skills')
  const unavailableSources =
    manifest?.skills.sources.filter((source) => source.availability?.available === false) ?? []
  const detail = useMemo<SkillDetail | null>(() => {
    if (!manifest || !detailIdentity) return null
    if (detailIdentity.kind === 'local') {
      const skill = manifest.skills.skills.find(({ id }) => id === detailIdentity.skillId)
      if (!skill) return null
      return {
        skillId: skill.id,
        path: skill.path,
        agents: skill.agents ?? [],
        shared: skill.shared === true,
      }
    }

    const source = manifest.skills.sources.find(({ url }) => url === detailIdentity.sourceUrl)
    const member = source?.members?.find(({ entry }) => entry === detailIdentity.memberEntry)
    if (!source || !member) return null
    return {
      skillId: formatSourceMemberSkillId(source, member.name, manifest.config),
      source: source.url,
      memberEntry: member.entry,
      path: member.path ?? member.entry,
      agents: member.agents ?? [],
      shared: member.shared === true,
    }
  }, [detailIdentity, manifest])

  const reorderGroups = async (ids: string[]) => {
    const previous = normalizedGroupOrder
    setGroupOrder(ids)
    try {
      const result = await api.reorderSkillGroups({ repo: repoPath, ids })
      setGroupOrder(result.ids)
    } catch (reorderError) {
      console.error({ err: reorderError }, 'Failed to reorder skill groups')
      setGroupOrder(previous)
      try {
        const current = (await api.getManifest(repoPath)) as {
          skills?: { group_order?: string[]; sources?: unknown[]; skills?: unknown[] }
        }
        if (current.skills?.group_order) setGroupOrder(current.skills.group_order)
      } catch (reloadError) {
        console.error({ err: reloadError }, 'Failed to reload skill order after reorder failure')
      }
      showErrorToast(reorderError, { title: 'Skills 排序失败', message: '已恢复原顺序，请重试' })
    }
  }

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

  useEffect(() => {
    if (!manifest) return
    const sourceUrls = new Set(manifest.skills.sources.map((source) => source.url))
    for (const url of checkedSourceSnapshotsRef.current.keys()) {
      if (!sourceUrls.has(url)) checkedSourceSnapshotsRef.current.delete(url)
    }
    if (operations.pending.source.checkAll) return

    const changedSources = manifest.skills.sources.filter((source) => {
      const snapshot = repositorySourceUpdateSnapshot(repoPath, source)
      return checkedSourceSnapshotsRef.current.get(source.url) !== snapshot
    })
    if (changedSources.length === 0) return
    for (const source of changedSources) {
      checkedSourceSnapshotsRef.current.set(
        source.url,
        repositorySourceUpdateSnapshot(repoPath, source),
      )
    }
    void operations.checkAllSourceUpdates(changedSources, {
      notify: false,
      notifyUpdatesAsCompleted: true,
      shouldNotifySourceUpdate: (source) =>
        manifestSourceSnapshotsRef.current.get(source.url) ===
        repositorySourceUpdateSnapshot(repoPath, source),
    })
  }, [manifest, operations.checkAllSourceUpdates, operations.pending.source.checkAll, repoPath])

  return (
    <div className={styles['skills-page']}>
      <div className={`page-head ${styles['skills-head']}`}>
        <div>
          <div className="page-title">Skills</div>
          <div className="page-sub">
            {totalSkills} skills · {sourceCount} sources · {localCount} local
          </div>
        </div>
        <div className={styles['skills-head-actions']}>
          {manifest && sourceCount > 0 && (
            <IconButton
              label="检查全部更新"
              tooltip="检查全部更新"
              variant="secondary"
              size="sm"
              disabled={operations.pending.source.checkAll}
              onClick={() => void operations.checkAllSourceUpdates(manifest.skills.sources)}
            >
              <RefreshCw
                className={
                  'h-3.5 w-3.5' + (operations.pending.source.checkAll ? ' animate-spin' : '')
                }
              />
            </IconButton>
          )}
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
          <Button
            aria-label="添加 Skill 或 Source"
            variant="primary"
            size="sm"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void operations.project('skills')}
            disabled={operations.pending.project('skills')}
          >
            {operations.pending.project('skills') ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {operations.pending.project('skills') ? '投影中…' : '投影'}
          </Button>
        </div>
      </div>

      {manifest?.errors && manifest.errors.length > 0 && (
        <ErrorState
          title="部分 Skills 配置无法读取"
          message="请修正配置后重新加载"
          detail={manifest.errors.join('\n')}
        />
      )}
      {unavailableSources.length > 0 && (
        <WarningState
          title="部分 Source 在当前机器不可用"
          message={`${unavailableSources.map((source) => source.name ?? source.url).join('、')} 暂不参与投影；其他 Skills 仍可正常使用，现有投影已保留。`}
          detail={unavailableSources
            .map((source) => source.availability?.message ?? source.url)
            .join('\n')}
        />
      )}
      {error && <ErrorState {...error} />}
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
            点击右上角的 <b>+</b> 添加 Skill 或 Source
          </p>
        </div>
      )}

      {manifest && (
        <>
          <GlobalAgentsBar manifest={manifest} agents={visibleAgents} operations={operations} />
          <SkillSourceList
            manifest={manifest}
            visibleAgents={visibleAgents}
            operations={operations}
            onOpenDetail={setDetailIdentity}
            onOpenScan={setEditSource}
            onOpenEdit={setEditSource}
            expandedGroups={expandedGroups}
            onToggleGroup={toggleGroup}
            groupOrder={normalizedGroupOrder}
            onReorderGroups={reorderGroups}
          />
        </>
      )}

      <SkillDetailEditor
        repoPath={repoPath}
        detail={detail}
        agents={visibleAgents}
        operations={operations}
        showToast={showToast}
        onClose={() => setDetailIdentity(null)}
      />

      <AddSkillModal open={addOpen} repoPath={repoPath} onClose={() => setAddOpen(false)} />
      <EditSourceModal
        repoPath={repoPath}
        source={editSource}
        showToast={showToast}
        onClose={() => setEditSource(null)}
        onSaved={() => setEditSource(null)}
      />
      <SourceNamespaceCollisionDialog
        collision={operations.sourceNamespaceCollision}
        busy={operations.pending.skills.resolvingCollision}
        onClose={operations.dismissSourceNamespaceCollision}
        onResolve={operations.resolveSourceNamespaceCollision}
      />
    </div>
  )
}
