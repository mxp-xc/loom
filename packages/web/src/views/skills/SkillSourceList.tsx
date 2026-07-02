import { useState } from 'react'
import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import { deriveRepoId, type SkillSource, type Manifest } from '@loom/core'
import type { SkillDetail } from './types'

interface Props {
  repoPath: string
  manifest: Manifest
  reload: () => void
  showToast: (msg: string) => void
  setError: (e: unknown) => void
  onOpenDetail: (d: SkillDetail) => void
  onOpenScan: (src: SkillSource) => void
}

const menuBtnStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '8px 12px',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  color: 'var(--text)',
}
const menuStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 10,
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--card)',
  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  minWidth: 120,
}

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
}: Props) {
  const [checking, setChecking] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, string>>({})
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
        setUpdates((prev) => ({ ...prev, [src.url]: latest }))
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
      const res = (await api.performUpdate({
        source: src,
        newRef: src.ref,
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
        return (
          <div key={src.url + '-' + src.ref} className="group">
            <div className="group-head" style={{ position: 'relative' }}>
              <span className="gname">
                <span className="arrow">▼</span>
                {repoId}
              </span>
              <a
                href={src.url.replace(/\.git$/, '')}
                target="_blank"
                rel="noopener noreferrer"
                className="gurl"
                style={{ textDecoration: 'none' }}
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
                  {updates[src.url]}
                </span>
              )}
              <span className="gacts">
                <button
                  className="gbtn"
                  onClick={() => handleCheck(src)}
                  disabled={checking === src.url}
                >
                  {checking === src.url ? '...' : 'check'}
                </button>
                {updates[src.url] && (
                  <button
                    className="gbtn"
                    onClick={() => handlePerformUpdate(src)}
                    disabled={updating === src.url}
                    style={{ color: 'var(--warn)' }}
                  >
                    {updating === src.url ? '...' : 'update'}
                  </button>
                )}
                <button
                  className="gbtn"
                  onClick={() => setMenuOpen(menuOpen === src.url ? null : src.url)}
                >
                  ⋯
                </button>
              </span>
              {menuOpen === src.url && (
                <div style={{ ...menuStyle, right: 14, top: '100%' }}>
                  <button
                    style={{ ...menuBtnStyle }}
                    onClick={() => {
                      setMenuOpen(null)
                      onOpenScan(src)
                    }}
                  >
                    scan
                  </button>
                  <button
                    style={{ ...menuBtnStyle, color: 'var(--error)' }}
                    onClick={() => handleDeleteSource(src.url)}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
            {src.members?.map((m) => {
              const isEnabled = m.enabled !== false
              const mTargets = m.targets ?? agents
              return (
                <div key={m.name} className="skill">
                  <span className={'sdot ' + (isEnabled ? 'green' : 'dim')} />
                  <span
                    className={'sname clickable' + (isEnabled ? '' : ' dim')}
                    onClick={() =>
                      onOpenDetail({
                        skillId: `${repoId}-${m.name}`,
                        source: src.url,
                        targets: mTargets,
                      })
                    }
                  >
                    {repoId}-{m.name}
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
            {!src.members?.length && (
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
          <div className="group-head">
            <span className="gname">
              <span className="arrow">▼</span>local skills <span className="local-tag">local</span>
            </span>
            <span className="gurl">./assets/skills</span>
          </div>
          {manifest.skills.skills.map((s) => {
            const lTargets = s.targets ?? agents
            return (
              <div key={s.id} className="skill">
                <span className="sdot green" />
                <span
                  className="sname clickable"
                  onClick={() => onOpenDetail({ skillId: s.id, path: s.path, targets: lTargets })}
                >
                  {s.id}
                </span>
                <span className="chips">
                  {allAgents.map((a) =>
                    renderChip(a, lTargets.includes(a), () =>
                      handleLocalChipToggle(s.id, a, lTargets),
                    ),
                  )}
                </span>
                <span className="sstate st-proj">projected</span>
                <span style={{ position: 'relative', display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="gbtn"
                    onClick={() =>
                      setMenuOpen(menuOpen === 'local:' + s.id ? null : 'local:' + s.id)
                    }
                  >
                    ⋯
                  </button>
                  {menuOpen === 'local:' + s.id && (
                    <div style={{ ...menuStyle, right: 0, top: '100%', minWidth: 100 }}>
                      <button
                        style={{ ...menuBtnStyle, color: 'var(--error)' }}
                        onClick={() => handleDeleteLocal(s.id)}
                      >
                        删除
                      </button>
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
