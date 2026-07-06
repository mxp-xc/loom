import { useState } from 'react'
import { api } from '@/lib/api'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import { deriveRepoId, type SkillSource, type Manifest } from '@loom/core'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { AlertTriangle, ChevronDown, RefreshCw, Pencil, Trash2, ScanLine } from 'lucide-react'
import type { SkillDetail } from './types'

interface Props {
  repoPath: string
  manifest: Manifest
  reload: () => void
  showToast: (msg: string) => void
  setError: (e: unknown) => void
  onOpenDetail: (d: SkillDetail) => void
  onOpenScan: (src: SkillSource) => void
  onOpenEdit: (src: SkillSource) => void
  expandedGroups: Set<string>
  onToggleGroup: (key: string) => void
}

type SourceUpdate = 'repair' | { label: string; newRef?: string }
type DeleteTarget =
  { kind: 'source'; url: string; label: string } | { kind: 'local'; id: string; label: string }

const chevronStyle = (isCollapsed: boolean): React.CSSProperties => ({
  color: 'var(--signal)',
  transition: 'transform var(--dur) var(--ease)',
  transform: isCollapsed ? 'rotate(-90deg)' : 'none',
})

const renderChip = (agent: AgentId, active: boolean, onClick?: () => void) => (
  <button
    type="button"
    key={agent}
    className={'chip ' + (active ? 'active' : 'inactive')}
    style={{ ['--c' as string]: agentColor[agent] }}
    onClick={onClick}
    aria-pressed={active}
    title={`${agentShort[agent]} ${active ? '已启用' : '未启用'}`}
  >
    {agentShort[agent]}
  </button>
)

export default function SkillSourceList({
  repoPath,
  manifest,
  reload,
  showToast,
  setError,
  onOpenDetail,
  onOpenScan,
  onOpenEdit,
  expandedGroups,
  onToggleGroup,
}: Props) {
  const [checking, setChecking] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, SourceUpdate>>({})
  const [updating, setUpdating] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const agents = manifest.config?.targets ?? []
  const visibleAgents: AgentId[] = agents
  const sourceCount = manifest.skills.sources.length
  const localCount = manifest.skills.skills.length

  const handleChipToggle = async (
    sourceUrl: string,
    memberName: string,
    agent: AgentId,
    currentTargets: string[],
  ) => {
    const newTargets = currentTargets.includes(agent)
      ? currentTargets.filter((a) => a !== agent)
      : [...currentTargets, agent]
    try {
      await api.updateSkillTargets({ repo: repoPath, sourceUrl, memberName, targets: newTargets })
      reload()
    } catch (e) {
      setError(e)
    }
  }

  const handleLocalChipToggle = async (id: string, agent: AgentId, currentTargets: string[]) => {
    const newTargets = currentTargets.includes(agent)
      ? currentTargets.filter((a) => a !== agent)
      : [...currentTargets, agent]
    try {
      await api.updateLocalSkillTargets({ repo: repoPath, id, targets: newTargets })
      reload()
    } catch (e) {
      setError(e)
    }
  }

  const handleCheck = async (src: SkillSource) => {
    setChecking(src.url)
    try {
      const res = (await api.update(repoPath, [src])) as any
      if (res.updates?.[0]?.hasUpdate) {
        const u = res.updates[0]
        if (u.needsRepair) {
          setUpdates((prev) => ({ ...prev, [src.url]: 'repair' }))
          showToast(`${deriveRepoId(src.url)} 缓存损坏,请点击 update 修复`)
          return
        }
        // Tag tracking shows the tag name; branch tracking shows a short commit hash.
        const latest = u.latestTag ?? (u.latestCommit ? u.latestCommit.slice(0, 7) : 'unknown')
        setUpdates((prev) => ({
          ...prev,
          [src.url]: { label: latest, newRef: u.latestTag },
        }))
        showToast(`${deriveRepoId(src.url)} 有更新: ${src.ref} -> ${latest}`)
      } else {
        showToast(`${deriveRepoId(src.url)} 已是最新`)
      }
    } catch (e) {
      setError(e)
    } finally {
      setChecking(null)
    }
  }

  const handlePerformUpdate = async (src: SkillSource) => {
    setUpdating(src.url)
    try {
      const repoId = deriveRepoId(src.url)
      const update = updates[src.url]
      const res = (await api.performUpdate({
        source: src,
        newRef: update && update !== 'repair' ? (update.newRef ?? src.ref) : src.ref,
        repo: repoPath,
        sourceId: repoId,
        oldMembers: src.members ?? [],
      })) as any
      showToast(`${repoId} 已更新到 ${res.pinned_commit?.slice(0, 7) ?? src.ref}`)
      setUpdates((prev) => {
        const n = { ...prev }
        delete n[src.url]
        return n
      })
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setUpdating(null)
    }
  }

  const requestDeleteSource = (url: string, label: string) => {
    setDeleteTarget({ kind: 'source', url, label })
  }

  const requestDeleteLocal = (id: string) => {
    setDeleteTarget({ kind: 'local', id, label: id })
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      if (deleteTarget.kind === 'source') {
        await api.deleteSource({ repo: repoPath, url: deleteTarget.url })
        showToast('已删除 source')
      } else {
        await api.deleteLocalSkill({ repo: repoPath, id: deleteTarget.id })
        showToast('已删除 local skill')
      }
      setDeleteTarget(null)
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setDeleteBusy(false)
    }
  }

  if (sourceCount === 0 && localCount === 0) return null

  return (
    <>
      <div className="skill-groups">
        {/* Remote sources */}
        {manifest.skills.sources.map((src) => {
          const repoId = deriveRepoId(src.url)
          const key = src.url + '-' + src.ref
          const isExpanded = expandedGroups.has(key)
          const sourceUpdate = updates[src.url]
          return (
            <div key={key} className="group">
              <div
                className="group-head"
                style={{ position: 'relative' }}
                data-expanded={isExpanded}
                onClick={() => onToggleGroup(key)}
              >
                <button
                  type="button"
                  className="gname"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? '折叠' : '展开'} ${repoId}`}
                >
                  <ChevronDown size={14} style={chevronStyle(!isExpanded)} />
                  {repoId}
                </button>
                {src.type === 'tag' ? (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 'var(--radius)',
                      background: 'rgba(139,92,246,0.14)',
                      color: 'var(--oc)',
                      border: '1px solid color-mix(in srgb, var(--oc) 30%, transparent)',
                    }}
                  >
                    tag
                  </span>
                ) : (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 'var(--radius)',
                      background: 'rgba(56,189,248,0.12)',
                      color: 'var(--info)',
                      border: '1px solid color-mix(in srgb, var(--info) 30%, transparent)',
                    }}
                  >
                    {src.type ?? 'branch'}
                  </span>
                )}
                <a
                  href={src.url.replace(/\.git$/, '')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gurl"
                  title={src.url}
                  onClick={(e) => e.stopPropagation()}
                >
                  {src.url}
                </a>
                <span className="gref">@ {src.ref}</span>
                {sourceUpdate && (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: 'var(--warn)',
                    }}
                  >
                    {'-> '}
                    {sourceUpdate === 'repair' ? 'repair' : sourceUpdate.label}
                  </span>
                )}
                <span className="gacts" onClick={(e) => e.stopPropagation()}>
                  <IconButton
                    label={`检查更新 source ${repoId}`}
                    tooltip={checking === src.url ? '检查中…' : '检查更新'}
                    size="sm"
                    onClick={() => handleCheck(src)}
                    disabled={checking === src.url}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </IconButton>
                  {updates[src.url] && (
                    <IconButton
                      label={`更新 source ${repoId}`}
                      tooltip={updating === src.url ? '更新中…' : '更新'}
                      size="sm"
                      onClick={() => handlePerformUpdate(src)}
                      disabled={updating === src.url}
                      tone="warning"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                  <IconButton
                    label={`编辑 source ${repoId}`}
                    tooltip="编辑"
                    size="sm"
                    onClick={() => onOpenEdit(src)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={`扫描 source ${repoId}`}
                    tooltip="scan"
                    size="sm"
                    onClick={() => onOpenScan(src)}
                  >
                    <ScanLine className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={`删除 source ${repoId}`}
                    tooltip="删除"
                    size="sm"
                    tone="danger"
                    onClick={() => requestDeleteSource(src.url, repoId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </span>
              </div>
              {isExpanded &&
                src.members?.map((m) => {
                  const isEnabled = m.enabled !== false
                  const mTargets = m.targets ?? []
                  return (
                    <div key={m.name} className="skill">
                      <span className={'sdot ' + (isEnabled ? 'green' : 'dim')} />
                      <span
                        className={'sname clickable' + (isEnabled ? '' : ' dim')}
                        onClick={() =>
                          onOpenDetail({
                            skillId:
                              manifest.config?.skill_naming === 'hyphen'
                                ? `${repoId}-${m.name}`
                                : `${repoId}/${m.name}`,
                            source: src.url,
                            targets: mTargets,
                          })
                        }
                      >
                        {m.name}
                      </span>
                      <span className="chips">
                        {visibleAgents.map((a) =>
                          renderChip(a, isEnabled && mTargets.includes(a), () =>
                            handleChipToggle(src.url, m.name, a, mTargets),
                          ),
                        )}
                      </span>
                      {!isEnabled && <span className="disabled-label">disabled</span>}
                    </div>
                  )
                })}
              {isExpanded && !src.members?.length && (
                <div className="skill">
                  <span className="sdot green" />
                  <span className="sname" style={{ color: 'var(--muted)' }}>
                    未发现 members
                  </span>
                  <span className="chips">{visibleAgents.map((a) => renderChip(a, false))}</span>
                </div>
              )}
            </div>
          )
        })}

        {/* Local skills */}
        {localCount > 0 && (
          <div className="group local-skills-group">
            <div
              className="group-head"
              data-expanded={expandedGroups.has('local')}
              onClick={() => onToggleGroup('local')}
            >
              <button
                type="button"
                className="gname"
                aria-expanded={expandedGroups.has('local')}
                aria-label={`${expandedGroups.has('local') ? '折叠' : '展开'} local skills`}
              >
                <ChevronDown size={14} style={chevronStyle(!expandedGroups.has('local'))} />
                local skills <span className="local-tag">local</span>
              </button>
            </div>
            {expandedGroups.has('local') &&
              manifest.skills.skills.map((s) => {
                const lTargets = s.targets ?? []
                const missing = Boolean(s.path && s.available === false)
                return (
                  <div key={s.id} className={'skill' + (missing ? ' skill-missing' : '')}>
                    <span className={'sdot ' + (missing ? 'yellow' : 'green')} />
                    <span className="skill-main">
                      <span className="skill-name-line">
                        {missing ? (
                          <span className="sname dim">{s.id}</span>
                        ) : (
                          <button
                            type="button"
                            className="sname clickable skill-name-button"
                            onClick={() =>
                              onOpenDetail({ skillId: s.id, path: s.path, targets: lTargets })
                            }
                          >
                            {s.id}
                          </button>
                        )}
                        {s.path && <span className="ref-badge">ref</span>}
                        {missing && (
                          <span className="missing-ref-badge" role="status">
                            <AlertTriangle size={12} /> 路径不存在
                          </span>
                        )}
                      </span>
                      {s.path && (
                        <span className="skill-local-path">
                          <span className="skill-local-path-label">本地路径</span>
                          <span>{s.path}</span>
                        </span>
                      )}
                    </span>
                    <span className="chips">
                      {visibleAgents.map((a) =>
                        renderChip(a, lTargets.includes(a), () =>
                          handleLocalChipToggle(s.id, a, lTargets),
                        ),
                      )}
                    </span>
                    <span className="skill-actions">
                      <IconButton
                        label={`删除 local skill ${s.id}`}
                        tooltip="删除"
                        tone="danger"
                        onClick={() => requestDeleteLocal(s.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </span>
                  </div>
                )
              })}
          </div>
        )}
      </div>

      <div className="legend">
        {visibleAgents.map((agent) => (
          <div className="lg" key={agent}>
            <span className="sw" style={{ background: agentColor[agent] }} />
            {agentShort[agent]}{' '}
            {agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'OpenCode'}
          </div>
        ))}
        <div className="lg">
          <span className="sw" style={{ background: 'var(--warn)' }} />
          有更新
        </div>
      </div>
      <div className="hint">
        source 级操作(更新 ref / scan / 删除)在分组头右侧;发现安装新 source 走右上 + Add source
      </div>

      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleteBusy) setDeleteTarget(null)
        }}
        title={deleteTarget?.kind === 'local' ? '删除 local skill' : '删除 source'}
        width={380}
        busy={deleteBusy}
      >
        <p style={{ color: 'var(--text)', fontSize: 13 }}>
          确认删除 <strong>{deleteTarget?.label}</strong>？此操作不可撤销。
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleteBusy}
            onClick={() => setDeleteTarget(null)}
          >
            取消
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleteBusy}
            style={{ color: 'var(--error)' }}
            onClick={() => void confirmDelete()}
          >
            {deleteBusy ? '删除中…' : '删除'}
          </Button>
        </div>
      </Modal>
    </>
  )
}
