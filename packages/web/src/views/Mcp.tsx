import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Modal from '@/components/Modal'
import Toast from '@/components/Toast'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import { inputStyle } from '@/lib/styles'
import { Button } from '@/components/ui/button'
import { Plus, RefreshCw, Trash2, Copy, Check } from 'lucide-react'
import { type McpServer, type McpType } from '@loom/core'
import { useManifest } from '@/hooks/useManifest'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'

const MCP_TYPES: McpType[] = ['stdio', 'sse', 'http']

export default function Mcp({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError()
  const { manifest, reload } = useManifest(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
  })
  const { toast, showToast, dismiss } = useToast()
  const [selected, setSelected] = useState<string | null>(null)
  const [projecting, setProjecting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)
  const [srvId, setSrvId] = useState('')
  const [srvType, setSrvType] = useState<McpType>('stdio')
  const [srvCommand, setSrvCommand] = useState('')
  const [srvArgs, setSrvArgs] = useState('')
  const [srvUrl, setSrvUrl] = useState('')
  const [srvTargets, setSrvTargets] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!selected && manifest?.mcp?.length) setSelected(manifest.mcp[0].id)
  }, [manifest, selected])

  const project = async () => {
    setProjecting(true)
    try {
      await api.project({ repo: repoPath, scope: 'mcp' })
      showToast('投影完成')
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setProjecting(false)
    }
  }

  const resetAddForm = () => {
    setAddErr(null)
    setSrvId('')
    setSrvType('stdio')
    setSrvCommand('')
    setSrvArgs('')
    setSrvUrl('')
    setSrvTargets([])
  }
  const openAdd = () => {
    resetAddForm()
    setAddOpen(true)
  }
  const closeAdd = () => setAddOpen(false)

  const handleAddServer = async () => {
    if (!srvId.trim()) {
      setAddErr('id 不能为空')
      return
    }
    if (srvType === 'stdio' && !srvCommand.trim()) {
      setAddErr('command 不能为空')
      return
    }
    if (srvType !== 'stdio' && !srvUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    setAddBusy(true)
    setAddErr(null)
    try {
      const server: any = { id: srvId.trim(), type: srvType }
      if (srvType === 'stdio') {
        server.command = srvCommand.trim()
        const argsStr = srvArgs.trim()
        server.args = argsStr ? argsStr.split(/\s+/) : undefined
      } else {
        server.url = srvUrl.trim()
      }
      if (srvTargets.length > 0) server.targets = srvTargets
      await api.addMcpServer({ repo: repoPath, server })
      closeAdd()
      reload()
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const toggleTarget = (a: AgentId) => {
    setSrvTargets((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]))
  }

  const agents = manifest?.config?.targets ?? []
  const visibleAgents: AgentId[] = agents

  const selectedServer = manifest?.mcp?.find((s) => s.id === selected)

  const handleToggleTarget = async (
    agent: AgentId,
    server: McpServer | undefined = selectedServer,
  ) => {
    if (!server) return
    const currentTargets = server.targets ?? []
    const newTargets = currentTargets.includes(agent)
      ? currentTargets.filter((a) => a !== agent)
      : [...currentTargets, agent]
    try {
      await api.updateMcpTargets({ repo: repoPath, id: server.id, targets: newTargets })
      reload()
    } catch (e) {
      setError(e)
    }
  }

  const handleCopy = () => {
    if (!selectedServer) return
    const text = JSON.stringify([selectedServer], null, 2)
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        showToast('已拷贝到剪贴板')
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => showToast('拷贝失败'))
  }

  return (
    <div>
      <div className="head">
        <div>
          <div className="page-title">MCP Servers</div>
          <div className="page-sub">{manifest?.mcp?.length ?? 0} servers</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button variant="primary" size="sm" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5" />
            Add server
          </Button>
          <Button variant="secondary" size="sm" onClick={project} disabled={projecting}>
            <RefreshCw className="h-3.5 w-3.5" />
            {projecting ? '投影中…' : '投影'}
          </Button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 14px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            color: 'var(--error)',
            border: '1px solid var(--error)',
            borderRadius: 'var(--radius-card)',
            background: 'rgba(220,38,38,0.06)',
          }}
        >
          {error}
        </div>
      )}

      {manifest?.mcp?.length === 0 && manifest && (
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
          <p style={{ fontSize: 14 }}>还没有配置 MCP Server</p>
          <p style={{ marginTop: 4, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
            点击右上 <b>+ Add server</b> 添加
          </p>
        </div>
      )}

      <div
        style={{
          marginTop: 18,
          display: 'grid',
          gridTemplateColumns: '360px 1fr',
          gap: 0,
          minHeight: 400,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-card)',
          overflow: 'hidden',
          background: 'var(--card)',
        }}
      >
        {/* List */}
        <div className="mlist" style={{ borderRight: '1px solid var(--border)' }}>
          {manifest?.mcp?.map((srv) => {
            const srvAgents = srv.targets ?? []
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
                  <span className="mcnt">
                    {srvAgents.filter((agent) => visibleAgents.includes(agent)).length}/
                    {visibleAgents.length}
                  </span>
                </div>
                <div className="mcp-bottom">
                  <span className="mcmd">
                    {srv.type === 'stdio' ? `${srv.command} ${srv.args?.join(' ') ?? ''}` : srv.url}
                  </span>
                  {visibleAgents.map((a) => (
                    <span
                      key={a}
                      className={'tg ' + (srvAgents.includes(a) ? 'on' : 'off')}
                      style={{ ['--c' as string]: agentColor[a], cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleTarget(a, srv)
                      }}
                    >
                      {agentShort[a]}
                    </span>
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
                <span className="page-title" style={{ fontSize: 16 }}>
                  {selectedServer.id}
                </span>
                <span className={'mtype' + (selectedServer.type !== 'stdio' ? ' remote' : '')}>
                  {selectedServer.type}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  title="拷贝配置 JSON"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 10px',
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span style={{ fontSize: 11 }}>{copied ? '已拷贝' : '拷贝'}</span>
                </Button>
              </div>
              <div style={{ marginTop: 16 }}>
                <span className="label">targets</span>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {visibleAgents.map((a) => {
                    const srvAgents = selectedServer.targets ?? []
                    return (
                      <span
                        key={a}
                        className={'tg ' + (srvAgents.includes(a) ? 'on' : 'off')}
                        style={{
                          ['--c' as string]: agentColor[a],
                          width: 40,
                          height: 40,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                        onClick={() => handleToggleTarget(a)}
                      >
                        {agentShort[a]}
                      </span>
                    )
                  })}
                </div>
              </div>
              {selectedServer.type === 'stdio' ? (
                <>
                  <div style={{ marginTop: 16 }}>
                    <span className="label">command</span>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        color: 'var(--text)',
                      }}
                    >
                      {selectedServer.command}
                    </div>
                  </div>
                  {selectedServer.args && (
                    <div style={{ marginTop: 12 }}>
                      <span className="label">args</span>
                      <div
                        style={{
                          marginTop: 4,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 13,
                          color: 'var(--text)',
                        }}
                      >
                        {selectedServer.args.join(' ')}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ marginTop: 16 }}>
                  <span className="label">url</span>
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 13,
                      color: 'var(--text)',
                    }}
                  >
                    {selectedServer.url}
                  </div>
                </div>
              )}
              {selectedServer.env && Object.keys(selectedServer.env).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <span className="label">env</span>
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: 'var(--muted)',
                    }}
                  >
                    {Object.entries(selectedServer.env).map(([k, v]) => (
                      <div key={k}>
                        {k}: {v}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selectedServer.type !== 'stdio' &&
                selectedServer.headers &&
                Object.keys(selectedServer.headers).length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <span className="label">headers</span>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 12,
                        color: 'var(--muted)',
                      }}
                    >
                      {Object.entries(selectedServer.headers).map(([k, v]) => (
                        <div key={k}>
                          {k}: {v}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ color: 'var(--error)' }}
                  onClick={async () => {
                    if (!selectedServer) return
                    try {
                      await api.deleteMcpServer({ repo: repoPath, id: selectedServer.id })
                      setSelected(null)
                      reload()
                    } catch (e) {
                      setError(e)
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </Button>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--muted)', textAlign: 'center', paddingTop: 60 }}>
              选择左侧 MCP server 查看详情
            </div>
          )}
        </div>
      </div>

      {/* Add Server Modal */}
      <Modal open={addOpen} onClose={closeAdd} title="Add MCP Server">
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

        <div style={{ marginBottom: 14 }}>
          <span className="label">
            id <span style={{ color: 'var(--error)' }}>*</span>
          </span>
          <input
            value={srvId}
            onChange={(e) => setSrvId(e.target.value)}
            placeholder="my-mcp-server"
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <span className="label">type</span>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            {MCP_TYPES.map((t) => (
              <Button
                key={t}
                variant="ghost"
                size="sm"
                onClick={() => setSrvType(t)}
                style={{
                  flex: 1,
                  border: '1px solid var(--border)',
                  background: srvType === t ? 'var(--bg)' : 'transparent',
                  color: srvType === t ? 'var(--bright)' : 'var(--muted)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {t}
              </Button>
            ))}
          </div>
        </div>

        {srvType === 'stdio' ? (
          <>
            <div style={{ marginBottom: 14 }}>
              <span className="label">
                command <span style={{ color: 'var(--error)' }}>*</span>
              </span>
              <input
                value={srvCommand}
                onChange={(e) => setSrvCommand(e.target.value)}
                placeholder="npx"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 18 }}>
              <span className="label">
                args <span style={{ color: 'var(--muted)' }}>(空格分隔)</span>
              </span>
              <input
                value={srvArgs}
                onChange={(e) => setSrvArgs(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                style={inputStyle}
              />
            </div>
          </>
        ) : (
          <div style={{ marginBottom: 18 }}>
            <span className="label">
              url <span style={{ color: 'var(--error)' }}>*</span>
            </span>
            <input
              value={srvUrl}
              onChange={(e) => setSrvUrl(e.target.value)}
              placeholder="http://localhost:3001/sse"
              style={inputStyle}
            />
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <span className="label">
            targets <span style={{ color: 'var(--muted)' }}>(可选)</span>
          </span>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {visibleAgents.map((a) => (
              <span
                key={a}
                className={'tg ' + (srvTargets.includes(a) ? 'on' : 'off')}
                style={{
                  ['--c' as string]: agentColor[a],
                  width: 40,
                  height: 40,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
                onClick={() => toggleTarget(a)}
              >
                {agentShort[a]}
              </span>
            ))}
          </div>
        </div>

        <Button
          variant="primary"
          style={{ width: '100%' }}
          onClick={handleAddServer}
          disabled={addBusy}
        >
          {addBusy ? '添加中…' : '添加 MCP Server'}
        </Button>
      </Modal>
      {toast && <Toast message={toast} onClose={dismiss} />}
    </div>
  )
}
