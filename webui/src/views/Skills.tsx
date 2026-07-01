import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface SkillMember { name: string; enabled?: boolean; targets?: string[] }
interface SkillSource { url: string; ref: string; pinned_commit?: string; members?: SkillMember[] }
interface LocalSkill { id: string; path?: string }
interface ManifestData {
  skills: { sources: SkillSource[]; skills: LocalSkill[] }
  config: { targets?: string[] }
  errors: string[]
}

const AGENTS = ['claude-code', 'codex', 'opencode'] as const
type Agent = typeof AGENTS[number]

const agentShort = (a: string) => a === 'claude-code' ? 'CC' : a === 'codex' ? 'CX' : 'OC'
const agentColor = (a: string) => a === 'claude-code' ? 'var(--cc)' : a === 'codex' ? 'var(--cx)' : 'var(--oc)'

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1].split('/').pop()!.replace(/\.git$/, '')
}

export default function Skills({ repoPath }: { repoPath: string }) {
  const [manifest, setManifest] = useState<ManifestData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projecting, setProjecting] = useState(false)
  const [projectResult, setProjectResult] = useState<unknown>(null)

  const load = () => {
    setError(null)
    api.getManifest(repoPath).then((m) => setManifest(m as ManifestData)).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [repoPath])

  const project = async () => {
    setProjecting(true); setError(null); setProjectResult(null)
    try { const res = await api.project({ repoPath }); setProjectResult(res); load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setProjecting(false) }
  }

  const agents = manifest?.config?.targets ?? []
  const allAgents: Agent[] = AGENTS.filter(a => agents.includes(a))
  if (allAgents.length === 0) allAgents.push(...AGENTS)

  const renderChip = (agent: Agent, active: boolean) => (
    <span
      className={'chip ' + (active ? 'active' : 'inactive')}
      style={{ ['--c' as string]: agentColor(agent) }}
    >{agentShort(agent)}</span>
  )

  const sourceCount = manifest?.skills?.sources?.length ?? 0
  const localCount = manifest?.skills?.skills?.length ?? 0
  const totalSkills = (manifest?.skills?.sources?.reduce((acc, s) => acc + (s.members?.length ?? 0), 0) ?? 0) + localCount

  return (
    <div>
      <div className="head">
        <div>
          <div className="page-title">Skills</div>
          <div className="page-sub">{totalSkills} skills · {sourceCount} sources · {localCount} local</div>
        </div>
        <button className="add-btn" onClick={project} disabled={projecting}>
          {projecting ? '投影中…' : '+ 投影'}
        </button>
      </div>

      {manifest?.errors && manifest.errors.length > 0 && (
        <div style={{ marginTop: 12, padding: 10, border: `1px solid var(--error)`, borderRadius: 6, background: 'var(--card)', fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--error)' }}>
          {manifest.errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      {error && <div style={{ marginTop: 12, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--error)' }}>{error}</div>}
      {projectResult != null && (
        <div style={{ marginTop: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card)', fontFamily: "'Fira Code', monospace", fontSize: 12 }}>
          <pre>{JSON.stringify(projectResult, null, 2)}</pre>
        </div>
      )}

      {!manifest && !error && <div style={{ color: 'var(--muted)', marginTop: 20 }}>加载中…</div>}

      {sourceCount === 0 && localCount === 0 && manifest && (
        <div style={{ marginTop: 18, padding: 32, border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center', color: 'var(--muted)' }}>
          <p style={{ fontSize: 14 }}>还没有配置任何 Skill</p>
          <p style={{ marginTop: 4, fontFamily: "'Fira Code', monospace", fontSize: 12 }}>编辑 skills.yaml 添加 source 或 local skill</p>
        </div>
      )}

      {/* Remote sources */}
      {manifest?.skills?.sources?.map((src) => {
        const repoId = deriveRepoId(src.url)
        return (
          <div key={src.url} className="group">
            <div className="group-head">
              <span className="gname"><span className="arrow">▼</span>{repoId}</span>
              <span className="gurl">{src.url}</span>
              <span className="gref">@ {src.ref}</span>
              <span className="gacts">
                <button className="gbtn">⟳ check</button>
                <button className="gbtn">⋯</button>
              </span>
            </div>
            {src.members?.map((m) => {
              const isEnabled = m.enabled !== false
              const mTargets = m.targets ?? agents
              return (
                <div key={m.name} className="skill">
                  <span className={'sdot ' + (isEnabled ? 'green' : 'dim')} />
                  <span className="sname" style={{ color: isEnabled ? 'var(--text)' : 'var(--muted)' }}>
                    {repoId}-{m.name}
                  </span>
                  <span className="chips">
                    {allAgents.map(a => renderChip(a, isEnabled && mTargets.includes(a)))}
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
                <span className="sname" style={{ color: 'var(--muted)' }}>未指定 members(全启用)</span>
                <span className="chips">{allAgents.map(a => renderChip(a, true))}</span>
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
            <span className="gname"><span className="arrow">▼</span>local skills <span className="local-tag">local</span></span>
            <span className="gurl">./assets/skills</span>
            <span className="gacts"><button className="gbtn">⋯</button></span>
          </div>
          {manifest.skills.skills.map((s) => (
            <div key={s.id} className="skill">
              <span className="sdot green" />
              <span className="sname">{s.id}</span>
              <span className="chips">{allAgents.map(a => renderChip(a, agents.includes(a)))}</span>
              <span className="sstate st-proj">projected</span>
            </div>
          ))}
        </div>
      )}

      {(sourceCount > 0 || localCount > 0) && (
        <>
          <div className="legend">
            <div className="lg"><span className="sw" style={{ background: 'var(--cc)' }} />CC Claude Code</div>
            <div className="lg"><span className="sw" style={{ background: 'var(--cx)' }} />CX Codex</div>
            <div className="lg"><span className="sw" style={{ background: 'var(--oc)' }} />OC OpenCode</div>
            <div className="lg"><span className="sw" style={{ background: 'var(--warn)' }} />有更新</div>
          </div>
          <div className="hint">source 级操作(更新 ref / scan / 删除)在分组头 ⋯ 菜单;发现安装新 source 走右上 + Add source</div>
        </>
      )}
    </div>
  )
}
