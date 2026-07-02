import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import Modal from '@/components/Modal'
import Toast from '@/components/Toast'
import MarkdownPreview from '@/components/MarkdownPreview'

interface SkillMember {
  name: string
  enabled?: boolean
  targets?: string[]
}
interface SkillSource {
  url: string
  ref: string
  pinned_commit?: string
  members?: SkillMember[]
}
interface LocalSkill {
  id: string
  path?: string
  targets?: string[]
}
interface ManifestData {
  skills: { sources: SkillSource[]; skills: LocalSkill[] }
  config: { targets?: string[] }
  errors: string[]
}
interface ScanMember {
  name: string
  description: string
  path: string
  installed: boolean
}
interface SkillDetail {
  skillId: string
  source?: string
  path?: string
  targets: string[]
}

interface RefreshMember {
  name: string
  path: string
}

const AGENTS = ['claude-code', 'codex', 'opencode'] as const
type Agent = (typeof AGENTS)[number]

const agentShort = (a: string) => (a === 'claude-code' ? 'CC' : a === 'codex' ? 'CX' : 'OC')
const agentColor = (a: string) =>
  a === 'claude-code' ? 'var(--cc)' : a === 'codex' ? 'var(--cx)' : 'var(--oc)'
const agentSkillPath = (agent: Agent, skillId: string): string => {
  const dir = agent === 'claude-code' ? '~/.claude' : agent === 'codex' ? '~/.codex' : '~/.opencode'
  return `${dir}/skills/${skillId}`
}

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1]
    .split('/')
    .pop()!
    .replace(/\.git$/, '')
}

const inputStyle: React.CSSProperties = {
  marginTop: 4,
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  outline: 'none',
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
const refreshBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 34,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 15,
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  cursor: 'pointer',
}
const copyBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '3px 8px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--muted)',
  cursor: 'pointer',
}

export default function Skills({ repoPath }: { repoPath: string }) {
  const [manifest, setManifest] = useState<ManifestData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projecting, setProjecting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addTab, setAddTab] = useState<'local' | 'source'>('local')
  const [addBusy, setAddBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState('')
  const [srcUrl, setSrcUrl] = useState('')
  const [srcRef, setSrcRef] = useState('main')
 const [checking, setChecking] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, string>>({})
  const [updating, setUpdating] = useState<string | null>(null)
 const [scanningSource, setScanningSource] = useState<string | null>(null)
 const [scanModal, setScanModal] = useState<{
   source: SkillSource
   members: RefreshMember[]
   existing: Set<string>
 } | null>(null)
const [scanModalSelected, setScanModalSelected] = useState<Set<string>>(new Set())
const [scanModalSaving, setScanModalSaving] = useState(false)
const scanLock = useRef(false)
const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanMembers, setScanMembers] = useState<ScanMember[]>([])
  const [scanSelected, setScanSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<string | null>(null)
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)

  const showToast = (msg: string) => setToast(msg)
  const copyPath = async (p: string) => {
    if (!navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(p)
      setCopiedPath(p)
      setTimeout(() => setCopiedPath(null), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const loadSkillContent = async (d: SkillDetail) => {
    setSkillLoading(true)
    setSkillError(null)
    setSkillContent(null)
    try {
      const res = await api.getSkillContent(repoPath, d.skillId, d.source, d.path)
      if (res.ok) setSkillContent(res.content ?? null)
      else setSkillError(res.message ?? res.error ?? '读取失败')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSkillError(msg === 'Failed to fetch' ? '网络错误,请检查后端服务是否运行' : msg)
    } finally {
      setSkillLoading(false)
    }
  }

  const openDetail = (d: SkillDetail) => {
    setDetail(d)
    loadSkillContent(d)
  }

  const closeDetail = () => {
    setDetail(null)
    setSkillContent(null)
    setSkillError(null)
    setSkillLoading(false)
  }

  const load = () => {
    setError(null)
    api
      .getManifest(repoPath)
      .then((m) => setManifest(m as ManifestData))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [repoPath])

  const project = async () => {
    setProjecting(true)
    setError(null)
    try {
      const res = (await api.project({ repoPath })) as any
      if (res.ok) {
        showToast('投影完成')
        load()
      } else {
        setError(res.message || '投影失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProjecting(false)
    }
  }

  const handleChipToggle = async (
    sourceUrl: string,
    memberName: string,
    agent: Agent,
    currentTargets: string[],
  ) => {
    const newTargets = currentTargets.includes(agent)
      ? currentTargets.filter((a) => a !== agent)
      : [...currentTargets, agent]
    try {
      await api.updateSkillTargets({ repoPath, sourceUrl, memberName, targets: newTargets })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

 const handleLocalChipToggle = async (id: string, agent: Agent, currentTargets: string[]) => {
   const newTargets = currentTargets.includes(agent)
     ? currentTargets.filter((a) => a !== agent)
     : [...currentTargets, agent]
   try {
     await api.updateLocalSkillTargets({ repoPath, id, targets: newTargets })
     load()
   } catch (e) {
     setError(e instanceof Error ? e.message : String(e))
   }
 }

  const handleGlobalTargetToggle = async (agent: Agent) => {
    const current = manifest?.config?.targets ?? []
    const newTargets = current.includes(agent)
      ? current.filter((a) => a !== agent)
      : [...current, agent]
    try {
      await api.putConfig({ repoPath, level: 'repo', field: 'targets', value: newTargets })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
     setError(e instanceof Error ? e.message : String(e))
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
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUpdating(null)
    }
  }

const handleScanSource = async (src: SkillSource) => {
  setMenuOpen(null)
  // Synchronous guard: a second click before the first resolves would open a
  // second modal that overwrites the first. scan is now near-instant (local
  // glob), so this mainly protects against the clone-fallback path.
  if (scanLock.current) return
  scanLock.current = true
  setScanningSource(src.url)
  try {
    const res = await api.refreshSource(repoPath, src.url, src.ref)
     if (res.ok) {
       const members = res.members ?? []
       const existing = new Set((src.members ?? []).map((m) => m.name))
       setScanModal({ source: src, members, existing })
       // Pre-select members already configured; new ones left unchecked so the
       // user explicitly opts in instead of silently enabling everything.
       setScanModalSelected(new Set(members.filter((m) => existing.has(m.name)).map((m) => m.name)))
     } else {
       setError(res.message ?? res.error ?? '扫描失败')
     }
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e))
  } finally {
    setScanningSource(null)
    scanLock.current = false
  }
}

 const handleConfirmScanMembers = async (selected: string[]) => {
   if (!scanModal) return
   setScanModalSaving(true)
   try {
     const res = await api.setSourceMembers({
       repoPath,
       url: scanModal.source.url,
       members: selected,
     })
     if (res.ok) {
       showToast(`${deriveRepoId(scanModal.source.url)}: ${selected.length} members`)
       setScanModal(null)
       load()
     } else {
       setError(res.message ?? res.error ?? '保存失败')
     }
   } catch (e) {
     setError(e instanceof Error ? e.message : String(e))
   } finally {
     setScanModalSaving(false)
   }
 }

 const handleDeleteSource = async (url: string) => {
    setMenuOpen(null)
    try {
      await api.deleteSource({ repoPath, url })
      showToast('已删除 source')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDeleteLocal = async (id: string) => {
    setMenuOpen(null)
    try {
      await api.deleteLocalSkill({ repoPath, id })
      showToast('已删除 local skill')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleScan = async () => {
    if (scanning) return
    if (!srcUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    setScanning(true)
    setAddErr(null)
    setScanMembers([])
    try {
      const res = (await api.scanSource(srcUrl.trim())) as any
      if (Array.isArray(res.members)) {
        setScanMembers(res.members)
        setScanSelected(
          new Set(
            res.members.filter((m: ScanMember) => !m.installed).map((m: ScanMember) => m.name),
          ),
        )
      } else {
        setAddErr(res.message || '扫描失败')
      }
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  const resetAddForm = () => {
    setAddErr(null)
    setLocalPath('')
    setSrcUrl('')
    setSrcRef('main')
    setAddTab('local')
    setScanMembers([])
    setScanSelected(new Set())
  }
  const openAdd = () => {
    resetAddForm()
    setAddOpen(true)
  }
  const closeAdd = () => setAddOpen(false)

  const handleAddLocal = async () => {
    const path = localPath.trim()
    if (!path) {
      setAddErr('path 不能为空')
      return
    }
    const id =
      path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() ?? ''
    if (!id) {
      setAddErr('无法从 path 提取 id')
      return
    }
    setAddBusy(true)
    setAddErr(null)
    try {
      await api.addLocalSkill({ repoPath, skill: { id, path } })
      closeAdd()
      load()
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const handleAddSource = async () => {
    if (!srcUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    setAddBusy(true)
    setAddErr(null)
    try {
      await api.addSource({ repoPath, url: srcUrl.trim(), ref: srcRef.trim() || 'main' })
      closeAdd()
      load()
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const agents = manifest?.config?.targets ?? []
  const allAgents: Agent[] = [...AGENTS]
  const derivedLocalId = localPath.trim()
    ? (localPath
        .trim()
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() ?? '')
    : ''

  const renderChip = (agent: Agent, active: boolean, onClick?: () => void) => (
    <span
      key={agent}
      className={'chip ' + (active ? 'active' : 'inactive')}
      style={{ ['--c' as string]: agentColor(agent) }}
      onClick={onClick}
    >
      {agentShort(agent)}
    </span>
  )

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
          <button className="add-btn" onClick={openAdd}>
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
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

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

     {menuOpen && (
       <div style={{ position: 'fixed', inset: 0, zIndex: 5 }} onClick={() => setMenuOpen(null)} />
     )}

     {manifest && (sourceCount > 0 || localCount > 0) && (
       <div
         style={{
            display: 'grid',
           gridTemplateColumns: '12px minmax(0, 1fr) auto 90px 28px',
           alignItems: 'center',
           gap: 12,
           marginTop: 14,
            marginBottom: 6,
            padding: '8px 14px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--card)',
          }}
        >
          <span />
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            全局 targets
          </span>
          <span className="chips" style={{ display: 'flex', gap: 7 }}>
            {allAgents.map((a) =>
              renderChip(a, agents.includes(a), () => handleGlobalTargetToggle(a)),
            )}
          </span>
          <span />
          <span />
        </div>
      )}

      {/* Remote sources */}
      {manifest?.skills?.sources?.map((src) => {
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
                    style={{ ...menuBtnStyle, opacity: scanningSource === src.url ? 0.5 : 1 }}
                    onClick={() => handleScanSource(src)}
                 >
                    {scanningSource === src.url ? '...' : 'scan'}
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
                      openDetail({
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
      {(manifest?.skills?.skills?.length ?? 0) > 0 && manifest && (
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
             <div
               key={s.id}
               className="skill"
             >
               <span className="sdot green" />
                <span
                  className="sname clickable"
                  onClick={() => openDetail({ skillId: s.id, path: s.path, targets: lTargets })}
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

      {(sourceCount > 0 || localCount > 0) && (
        <>
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
            source 级操作(更新 ref / scan / 删除)在分组头 ⋯ 菜单;发现安装新 source 走右上 + Add
            source
          </div>
        </>
      )}

      {/* Add Skill Modal */}
      <Modal open={addOpen} onClose={closeAdd} title="Add Skill">
        <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
          {(['local', 'source'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setAddTab(tab)
                setAddErr(null)
              }}
              style={{
                flex: 1,
                padding: '6px 0',
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 500,
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                background: addTab === tab ? 'var(--bg)' : 'transparent',
                color: addTab === tab ? 'var(--bright)' : 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              {tab === 'local' ? 'Local Skill' : 'Source'}
            </button>
          ))}
        </div>

        {addErr && (
          <div
            style={{
              marginBottom: 12,
              padding: 8,
              borderRadius: 'var(--radius)',
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              color: 'var(--error)',
              border: '1px solid var(--error)',
              background: 'var(--card)',
            }}
          >
            {addErr}
          </div>
        )}

        {addTab === 'local' ? (
          <>
            <div style={{ marginBottom: 14 }}>
              <span className="label">
                path <span style={{ color: 'var(--error)' }}>*</span>
              </span>
              <input
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="./assets/skills/my-skill"
                style={inputStyle}
              />
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                本地 skill 目录路径，id 将从目录名自动提取
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: 'var(--signal)',
                }}
              >
                id: {derivedLocalId || '—'}
              </div>
            </div>
            <button
              className="add-btn"
              onClick={handleAddLocal}
              disabled={addBusy}
              style={{ width: '100%' }}
            >
              {addBusy ? '添加中…' : '添加 Local Skill'}
            </button>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <span className="label">
                url <span style={{ color: 'var(--error)' }}>*</span>
              </span>
              <input
                value={srcUrl}
                onChange={(e) => setSrcUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <span className="label">ref</span>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input
                  value={srcRef}
                  onChange={(e) => setSrcRef(e.target.value)}
                  onBlur={() => {
                    if (srcUrl.trim()) handleScan()
                  }}
                  placeholder="main"
                  style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                />
                <button
                  onClick={handleScan}
                  disabled={scanning}
                  title="扫描"
                  style={refreshBtnStyle}
                >
                  {scanning ? '...' : '↻'}
                </button>
              </div>
            </div>
            {scanMembers.length > 0 && (
              <div
                style={{
                  marginBottom: 14,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {scanMembers.map((m) => (
                  <label
                    key={m.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderBottom: '1px solid var(--border)',
                      cursor: m.installed ? 'default' : 'pointer',
                      opacity: m.installed ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={scanSelected.has(m.name)}
                      disabled={m.installed}
                      onChange={(e) => {
                        setScanSelected((prev) => {
                          const n = new Set(prev)
                          if (e.target.checked) n.add(m.name)
                          else n.delete(m.name)
                          return n
                        })
                      }}
                    />
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                      {m.name}
                    </span>
                    {m.installed && (
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>(已安装)</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <button
              className="add-btn"
              onClick={handleAddSource}
              disabled={addBusy}
              style={{ width: '100%' }}
            >
              {addBusy ? '添加中…' : '添加 Source'}
            </button>
          </>
        )}
      </Modal>

     {/* Skill Detail Modal */}
     {/* Scan Members Modal */}
     <Modal
       open={!!scanModal}
       onClose={() => (scanModalSaving ? undefined : setScanModal(null))}
       title={`Scan · ${scanModal ? deriveRepoId(scanModal.source.url) : ''}`}
       width={520}
       minHeight={300}
     >
       {scanModal && (
         <div>
           <div
             style={{
               marginBottom: 12,
               fontSize: 12,
               color: 'var(--muted)',
               fontFamily: "'JetBrains Mono', monospace",
             }}
             >
               发现 {scanModal.members.length} 个 member,勾选要启用的
             </div>
           {scanModal.members.length > 0 && (
             <div
               style={{
                 display: 'flex',
                 alignItems: 'center',
                 gap: 12,
                 marginBottom: 8,
                 fontFamily: "'JetBrains Mono', monospace",
                 fontSize: 11,
               }}
             >
               <button
                 onClick={() => {
                   const all = scanModalSelected.size === scanModal.members.length
                   setScanModalSelected(all ? new Set() : new Set(scanModal.members.map((m) => m.name)))
                 }}
                 style={{
                   background: 'none',
                   border: '1px solid var(--border)',
                   borderRadius: 'var(--radius)',
                   padding: '2px 8px',
                   color: 'var(--muted)',
                   cursor: 'pointer',
                 }}
               >
                 {scanModalSelected.size === scanModal.members.length ? '全不选' : '全选'}
               </button>
               <span style={{ color: 'var(--muted)' }}>
                 已选 {scanModalSelected.size} / {scanModal.members.length}
               </span>
             </div>
           )}
             {scanModal.members.length === 0 ? (
             <div style={{ fontSize: 12, color: 'var(--muted)' }}>未发现任何 SKILL.md</div>
           ) : (
             <div
               style={{
                 border: '1px solid var(--border)',
                 borderRadius: 'var(--radius)',
                 maxHeight: 280,
                 overflow: 'auto',
                 marginBottom: 14,
               }}
             >
              {scanModal.members.map((m) => {
                const checked = scanModalSelected.has(m.name)
                return (
                  <label
                    key={m.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 10px',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setScanModalSelected((prev) => {
                          const n = new Set(prev)
                          if (e.target.checked) n.add(m.name)
                          else n.delete(m.name)
                          return n
                        })
                      }}
                    />
                    <span
                      style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                    >
                      {m.name}
                    </span>
                  </label>
                )
              })}
             </div>
           )}
           <div style={{ display: 'flex', gap: 8 }}>
             <button
               className="add-btn"
               onClick={() =>
                 handleConfirmScanMembers([...scanModalSelected])
               }
               disabled={scanModalSaving}
               style={{ flex: 1 }}
             >
               {scanModalSaving ? '保存中…' : `保存 (${scanModalSelected.size})`}
             </button>
             <button
               className="add-btn"
               onClick={() => setScanModal(null)}
               disabled={scanModalSaving}
               style={{ flex: '0 0 auto' }}
             >
               取消
             </button>
           </div>
         </div>
       )}
     </Modal>

     <Modal
       open={!!detail}
        onClose={closeDetail}
        title={detail?.skillId ?? ''}
        width={760}
        minHeight={460}
      >
        {detail && (
          <div>
            {detail.source && (
              <div style={{ marginBottom: 12 }}>
                <div className="label">source</div>
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    color: 'var(--text)',
                    wordBreak: 'break-all',
                  }}
                >
                  {detail.source}
                </div>
              </div>
            )}
            {detail.path && (
              <div style={{ marginBottom: 12 }}>
                <div className="label">path</div>
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    color: 'var(--text)',
                    wordBreak: 'break-all',
                  }}
                >
                  {detail.path}
                </div>
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <div className="label">targets</div>
              <div style={{ display: 'flex', gap: 7, marginTop: 6 }}>
                {allAgents.map((a) => renderChip(a, detail.targets.includes(a)))}
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div className="label">projected links</div>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {allAgents.map((a) => {
                  const p = agentSkillPath(a, detail.skillId)
                  const active = detail.targets.includes(a)
                  return (
                    <div
                      key={a}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        opacity: active ? 1 : 0.45,
                      }}
                    >
                      {renderChip(a, active)}
                      <span
                        style={{
                          flex: 1,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          color: 'var(--text)',
                          wordBreak: 'break-all',
                        }}
                      >
                        {p}
                      </span>
                      <button onClick={() => copyPath(p)} style={copyBtnStyle} title="复制">
                        {copiedPath === p ? 'copied' : 'copy'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <div className="label">SKILL.md</div>
              {skillLoading && (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>加载中…</div>
              )}
              {skillError && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    color: 'var(--error)',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {skillError}
                </div>
              )}
              {skillContent && (
                <MarkdownPreview
                  content={skillContent}
                  editable={!detail.source}
                  onSave={async (newContent) => {
                    await api.saveSkillContent({
                      repoPath,
                      skillId: detail.skillId,
                      localPath: detail.path,
                      content: newContent,
                    })
                    setSkillContent(newContent)
                    showToast('已保存')
                  }}
                />
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
