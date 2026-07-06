import { useState } from 'react'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import {
  formatSourceMemberSkillId,
  sourceIdentity,
  type SkillSource,
  type Manifest,
} from '@loom/core'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { AlertTriangle, ChevronDown, RefreshCw, Pencil, Trash2, ScanLine } from 'lucide-react'
import type { SkillDetail } from './types'
import type { ManifestOperations, SourceUpdateState } from '@/hooks/useManifestOperations'

interface Props {
  manifest: Manifest
  operations: ManifestOperations
  onOpenDetail: (d: SkillDetail) => void
  onOpenScan: (src: SkillSource) => void
  onOpenEdit: (src: SkillSource) => void
  expandedGroups: Set<string>
  onToggleGroup: (key: string) => void
}

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
  manifest,
  operations,
  onOpenDetail,
  onOpenScan,
  onOpenEdit,
  expandedGroups,
  onToggleGroup,
}: Props) {
  const [updates, setUpdates] = useState<Record<string, SourceUpdateState>>({})
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  const agents = manifest.config?.targets ?? []
  const visibleAgents: AgentId[] = agents
  const sourceCount = manifest.skills.sources.length
  const localCount = manifest.skills.skills.length

  const handleChipToggle = async (
    sourceUrl: string,
    memberName: string,
    agent: AgentId,
    currentTargets: AgentId[],
  ) => {
    await operations.toggleSourceSkillTarget(sourceUrl, memberName, agent, currentTargets)
  }

  const handleLocalChipToggle = async (id: string, agent: AgentId, currentTargets: AgentId[]) => {
    await operations.toggleLocalSkillTarget(id, agent, currentTargets)
  }

  const handleCheck = async (src: SkillSource) => {
    const result = await operations.checkSourceUpdate(src)
    if (result.ok && result.result?.update) {
      setUpdates((prev) => ({ ...prev, [src.url]: result.result!.update! }))
    }
  }

  const handlePerformUpdate = async (src: SkillSource) => {
    const result = await operations.performSourceUpdate(src, updates[src.url])
    if (result.ok) {
      setUpdates((prev) => {
        const n = { ...prev }
        delete n[src.url]
        return n
      })
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
    const result =
      deleteTarget.kind === 'source'
        ? await operations.deleteSource(deleteTarget.url)
        : await operations.deleteLocalSkill(deleteTarget.id)
    if (result.ok) {
      setDeleteTarget(null)
    }
  }

  if (sourceCount === 0 && localCount === 0) return null

  const deleteBusy =
    deleteTarget?.kind === 'source'
      ? operations.pending.source.delete(deleteTarget.url)
      : deleteTarget?.kind === 'local'
        ? operations.pending.skills.deleteLocal(deleteTarget.id)
        : false

  return (
    <>
      <div className="skill-groups">
        {/* Remote sources */}
        {manifest.skills.sources.map((src) => {
          const repoId = sourceIdentity(src).repoId
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
                    tooltip={operations.pending.source.check(src) ? '检查中…' : '检查更新'}
                    size="sm"
                    onClick={() => handleCheck(src)}
                    disabled={operations.pending.source.check(src)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </IconButton>
                  {updates[src.url] && (
                    <IconButton
                      label={`更新 source ${repoId}`}
                      tooltip={operations.pending.source.update(src) ? '更新中…' : '更新'}
                      size="sm"
                      onClick={() => handlePerformUpdate(src)}
                      disabled={operations.pending.source.update(src)}
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
                  const mTargets = (m.targets ?? []) as AgentId[]
                  return (
                    <div key={m.name} className="skill">
                      <span className={'sdot ' + (isEnabled ? 'green' : 'dim')} />
                      <span
                        className={'sname clickable' + (isEnabled ? '' : ' dim')}
                        onClick={() =>
                          onOpenDetail({
                            skillId: formatSourceMemberSkillId(src, m.name, manifest.config),
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
                const lTargets = (s.targets ?? []) as AgentId[]
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
