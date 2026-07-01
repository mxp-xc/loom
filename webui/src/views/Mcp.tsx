import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface McpServer {
  id: string; type: string; command?: string; args?: string[]
  url?: string; headers?: Record<string, string>; env?: Record<string, string>
  targets?: string[]
}
interface ManifestData { mcp: McpServer[]; config: { targets?: string[] }; errors: string[] }

const AGENTS = ['claude-code', 'codex', 'opencode'] as const
type Agent = typeof AGENTS[number]
const agentShort = (a: string) => a === 'claude-code' ? 'CC' : a === 'codex' ? 'CX' : 'OC'
const agentColor = (a: string) => a === 'claude-code' ? 'var(--cc)' : a === 'codex' ? 'var(--cx)' : 'var(--oc)'

export default function Mcp({ repoPath }: { repoPath: string }) {
  const [manifest, setManifest] = useState<ManifestData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [projecting, setProjecting] = useState(false)

  const load = () => {
    setError(null)
    api.getManifest(repoPath).then((m) => setManifest(m as ManifestData)).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [repoPath])

  const project = async () => {
    setProjecting(true)
    try { await api.project({ repoPath }); load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setProjecting(false) }
  }

  const agents = manifest?.config?.targets ?? []
  const allAgents: Agent[] = AGENTS.filter(a => agents.includes(a))
  if (allAgents.length === 0) allAgents.push(...AGENTS)

  const selectedServer = manifest?.mcp?.find(s => s.id === selected)

  return (
    <div>
      <div className="head">
        <div>
          <div className="page-title">MCP Servers</div>
          <div className="page-sub">{manifest?.mcp?.length ?? 0} servers</div>
        </div>
        <button className="add-btn" onClick={project} disabled={projecting}>
          {projecting ? '投影中…' : '+ 投影'}
        </button>
      </div>

      {error && <div style={{ marginTop: 12, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--error)' }}>{error}</div>}

      {manifest?.mcp?.length === 0 && manifest && (
        <div style={{ marginTop: 18, padding: 32, border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center', color: 'var(--muted)' }}>
          <p style={{ fontSize: 14 }}>还没有配置 MCP Server</p>
        </div>
      )}

      <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '360px 1fr', gap: 0, minHeight: 400, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--card)' }}>
        {/* List */}
        <div className="mlist" style={{ borderRight: '1px solid var(--border)' }}>
          {manifest?.mcp?.map((srv) => {
            const srvAgents = srv.targets ?? agents
            const isRemote = srv.type === 'sse' || srv.type === 'http'
            return (
              <div
                key={srv.id}
                className={'mcp' + (selected === srv.id ? ' sel' : '')}
                onClick={() => setSelected(srv.id)}
              >
                <div className="mcp-top">
                  <span className="mid">{srv.id}</span>
                  <span className={'mtype' + (isRemote ? ' remote' : '')}>{srv.type}</span>
                  <span className="mcnt">{srvAgents.length}/3</span>
                </div>
                <div className="mcp-bottom">
                  <span className="mcmd">{srv.type === 'stdio' ? `${srv.command} ${srv.args?.join(' ') ?? ''}` : srv.url}</span>
                  {allAgents.map(a => (
                    <span key={a} className={'tg ' + (srvAgents.includes(a) ? 'on' : 'off')}
                      style={{ ['--c' as string]: agentColor(a) }}>{agentShort(a)}</span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Detail */}
        <div style={{ padding: '18px 24px', overflow: 'auto' }}>
          {selectedServer ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span className="page-title" style={{ fontSize: 16 }}>{selectedServer.id}</span>
                <span className={'mtype' + (selectedServer.type !== 'stdio' ? ' remote' : '')}>{selectedServer.type}</span>
              </div>
              <div style={{ marginTop: 16 }}>
                <span className="label">targets</span>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {allAgents.map(a => {
                    const srvAgents = selectedServer.targets ?? agents
                    return (
                      <span key={a} className={'tg ' + (srvAgents.includes(a) ? 'on' : 'off')}
                        style={{ ['--c' as string]: agentColor(a), width: 40, height: 40, fontSize: 12 }}>{agentShort(a)}</span>
                    )
                  })}
                </div>
              </div>
              {selectedServer.type === 'stdio' ? (
                <>
                  <div style={{ marginTop: 16 }}>
                    <span className="label">command</span>
                    <div style={{ marginTop: 4, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{selectedServer.command}</div>
                  </div>
                  {selectedServer.args && (
                    <div style={{ marginTop: 12 }}>
                      <span className="label">args</span>
                      <div style={{ marginTop: 4, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{selectedServer.args.join(' ')}</div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ marginTop: 16 }}>
                  <span className="label">url</span>
                  <div style={{ marginTop: 4, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{selectedServer.url}</div>
                </div>
              )}
              {selectedServer.env && Object.keys(selectedServer.env).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <span className="label">env</span>
                  <div style={{ marginTop: 4, fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--muted)' }}>
                    {Object.entries(selectedServer.env).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--muted)', textAlign: 'center', paddingTop: 60 }}>选择左侧 MCP server 查看详情</div>
          )}
        </div>
      </div>
    </div>
  )
}
