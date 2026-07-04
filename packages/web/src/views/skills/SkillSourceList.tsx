import { useState } from 'react'
import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import { deriveRepoId, type SkillSource, type Manifest } from '@loom/core'
import { Button } from '@/components/ui/button'
import { ChevronDown, MoreHorizontal, RefreshCw, Pencil, Trash2, ScanLine } from 'lucide-react'
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

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 10,
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--card)',
  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  minWidth: 120,
}

const chevronStyle = (isCollapsed: boolean): React.CSSProperties => ({
  color: 'var(--signal)',
  transition: 'transform var(--dur) var(--ease)',
  transform: isCollapsed ? 'rotate(-90deg)' : 'none',
})

const renderChip = (agent: AgentId, active: boolean, onClick?: () => void) => (
  <span
    key={agent}
    className={'chip ' + (active ? 'active' : 'inactive')}
    style={{ ['--c' as string]: agentColor[agent] }}
    onClick={onClick}
  >
    {agentShort[agent]}
  </span>
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
  const [menuOpen, setMenuOpen] = useState<string | null>(null)

  const agents = manifest.config?.targets ?? []
  const allAgents: AgentId[] = [...AGENTS]
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
      await api.updateSkillTargets({ repoPath, sourceUrl, memberName, targets: newTargets })
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
      await api.updateLocalSkillTargets({ repoPath, id, targets: newTargets })
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
        repoPath,
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

  const handleDeleteSource = async (url: string) => {
    setMenuOpen(null)
    try {
      await api.deleteSource({ repoPath, url })
      showToast('已删除 source')
      reload()
    } catch (e) {
      setError(e)
    }
  }

  const handleDeleteLocal = async (id: string) => {
    setMenuOpen(null)
    try {
      await api.deleteLocalSkill({ repoPath, id })
      showToast('已删除 local skill')
      reload()
    } catch (e) {
      setError(e)
    }
  }

  if (sourceCount === 0 && localCount === 0) return null

  return (
    <>
      {menuOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 5 }} onClick={() => setMenuOpen(null)} />
      )}

      {/* Remote sources */}
      {manifest.skills.sources.map((src) => {
        const repoId = deriveRepoId(src.url)
        const key = src.url + '-' + src.ref
        const isExpanded = expandedGroups.has(key)
        return (
          <div key={key} className="group">
            <div className="group-head" style={{ position: 'relative' }} data-expanded={isExpanded}>
              <button
                type="button"
                className="gname"
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? '折叠' : '展开'} ${repoId}`}
                onClick={() => onToggleGroup(key)}
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
              {updates[src.url] && (
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: 'var(--warn)',
                  }}
                >
                  {'-> '}
                  {updates[src.url] === 'repair' ? 'repair' : updates[src.url].label}
                </span>
              )}
              <span className="gacts" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCheck(src)}
                  disabled={checking === src.url}
                  title="检查更新"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {checking === src.url ? '...' : 'Check'}
                </Button>
                {updates[src.url] && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handlePerformUpdate(src)}
                    disabled={updating === src.url}
                    style={{
                      color: 'var(--warn)',
                      borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
                    }}
                    title="更新到最新版本"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {updating === src.url ? '...' : 'Update'}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenEdit(src)}
                  title="编辑 source"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMenuOpen(menuOpen === src.url ? null : src.url)}
                  title="更多操作"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </span>
              {menuOpen === src.url && (
                <div
                  style={{ ...menuStyle, right: 14, top: '100%' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ width: '100%', textAlign: 'left', justifyContent: 'flex-start' }}
                    onClick={() => {
                      setMenuOpen(null)
                      onOpenScan(src)
                    }}
                  >
                    <ScanLine className="h-3 w-3" />
                    scan
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      justifyContent: 'flex-start',
                      color: 'var(--error)',
                    }}
                    onClick={() => handleDeleteSource(src.url)}
                  >
                    <Trash2 className="h-3 w-3" />
                    删除
                  </Button>
                </div>
              )}
            </div>
            {isExpanded &&
              src.members?.map((m) => {
                const isEnabled = m.enabled !== false
                const mTargets = m.targets ?? agents
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
                      {allAgents.map((a) =>
                        renderChip(a, isEnabled && mTargets.includes(a), () =>
                          handleChipToggle(src.url, m.name, a, mTargets),
                        ),
                      )}
                    </span>
                    <span className={'sstate ' + (isEnabled ? 'st-proj' : 'st-off')}>
                      {isEnabled ? 'projected' : 'disabled'}
                    </span>
                  </div>
                )
              })}
            {isExpanded && !src.members?.length && (
              <div className="skill">
                <span className="sdot green" />
                <span className="sname" style={{ color: 'var(--muted)' }}>
                  未指定 members(全启用)
                </span>
                <span className="chips">
                  {allAgents.map((a) =>
                    renderChip(a, true, () => handleChipToggle(src.url, '', a, agents)),
                  )}
                </span>
                <span className="sstate st-proj">projected</span>
              </div>
            )}
          </div>
        )
      })}

      {/* Local skills */}
      {localCount > 0 && (
        <div className="group">
          <div className="group-head" data-expanded={expandedGroups.has('local')}>
            <button
              type="button"
              className="gname"
              aria-expanded={expandedGroups.has('local')}
              aria-label={`${expandedGroups.has('local') ? '折叠' : '展开'} local skills`}
              onClick={() => onToggleGroup('local')}
            >
              <ChevronDown size={14} style={chevronStyle(!expandedGroups.has('local'))} />
              local skills <span className="local-tag">local</span>
            </button>
          </div>
          {expandedGroups.has('local') &&
            manifest.skills.skills.map((s) => {
              const lTargets = s.targets ?? agents
              return (
                <div key={s.id} className="skill">
                  <span className="sdot green" />
                  <span className="skill-main">
                    <span className="skill-name-line">
                      <span
                        className="sname clickable"
                        onClick={() =>
                          onOpenDetail({ skillId: s.id, path: s.path, targets: lTargets })
                        }
                      >
                        {s.id}
                      </span>
                      {s.path && <span className="ref-badge">ref</span>}
                    </span>
                    {s.path && (
                      <span className="skill-local-path">
                        <span className="skill-local-path-label">本地路径</span>
                        <span>{s.path}</span>
                      </span>
                    )}
                  </span>
                  <span className="chips">
                    {allAgents.map((a) =>
                      renderChip(a, lTargets.includes(a), () =>
                        handleLocalChipToggle(s.id, a, lTargets),
                      ),
                    )}
                  </span>
                  <span className="sstate st-proj">projected</span>
                  <span className="skill-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setMenuOpen(menuOpen === 'local:' + s.id ? null : 'local:' + s.id)
                      }
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                    {menuOpen === 'local:' + s.id && (
                      <div style={{ ...menuStyle, right: 0, top: '100%', minWidth: 100 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            justifyContent: 'flex-start',
                            color: 'var(--error)',
                          }}
                          onClick={() => handleDeleteLocal(s.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                          删除
                        </Button>
                      </div>
                    )}
                  </span>
                </div>
              )
            })}
        </div>
      )}

      <div className="legend">
        <div className="lg">
          <span className="sw" style={{ background: 'var(--cc)' }} />
          CC Claude Code
        </div>
        <div className="lg">
          <span className="sw" style={{ background: 'var(--cx)' }} />
          CX Codex
        </div>
        <div className="lg">
          <span className="sw" style={{ background: 'var(--oc)' }} />
          OC OpenCode
        </div>
        <div className="lg">
          <span className="sw" style={{ background: 'var(--warn)' }} />
          有更新
        </div>
      </div>
      <div className="hint">
        source 级操作(更新 ref / scan / 删除)在分组头 ⋯ 菜单;发现安装新 source 走右上 + Add source
      </div>
    </>
  )
}
