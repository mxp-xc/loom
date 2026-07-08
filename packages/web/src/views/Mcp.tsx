import { useEffect, useState, type CSSProperties } from 'react'
import { type McpServer, type McpType } from '@loom/core'
import { Check, Copy, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { useManifest } from '@/hooks/useManifest'
import {
  normalizeManifestOperationError,
  useManifestOperations,
  type ManifestOperations,
} from '@/hooks/useManifestOperations'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import { agentColor, agentShort, type AgentId } from '@/lib/agents'
import { inputStyle } from '@/lib/styles'
import { cn } from '@/lib/utils'
import styles from './Mcp.module.css'

const MCP_TYPES: McpType[] = ['stdio', 'sse', 'http']

type McpServerModalMode = 'create' | 'edit'

interface McpServerFormState {
  id: string
  type: McpType
  command: string
  args: string
  url: string
  env: string
  headers: string
  targets: AgentId[]
}

type RecordEditMode = 'file' | 'pairs'

interface RecordRow {
  id: string
  key: string
  value: string
}

let recordRowId = 0

function newRecordRow(key = '', value = ''): RecordRow {
  recordRowId += 1
  return { id: String(recordRowId), key, value }
}

function emptyMcpForm(): McpServerFormState {
  return {
    id: '',
    type: 'stdio',
    command: '',
    args: '',
    url: '',
    env: '',
    headers: '',
    targets: [],
  }
}

function recordToLines(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}=${value ?? ''}`)
    .join('\n')
}

function rowsFromRecord(record: Record<string, string> | undefined): RecordRow[] {
  const rows = Object.entries(record ?? {}).map(([key, value]) => newRecordRow(key, value ?? ''))
  return rows.length > 0 ? rows : [newRecordRow()]
}

function rowsFromLines(value: string): RecordRow[] {
  const rows = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const normalized = line.startsWith('export ') ? line.slice(7).trimStart() : line
      const equalsAt = normalized.indexOf('=')
      if (equalsAt === -1) return newRecordRow(normalized, '')
      return newRecordRow(
        normalized.slice(0, equalsAt).trim(),
        unquoteRecordValue(normalized.slice(equalsAt + 1).trim()),
      )
    })
  return rows.length > 0 ? rows : [newRecordRow()]
}

function rowsToLines(rows: RecordRow[]): string {
  return rows
    .filter((row) => row.key.trim() || row.value.trim())
    .map((row) => `${row.key.trim()}=${row.value}`)
    .join('\n')
}

function serverToForm(server: McpServer | undefined): McpServerFormState {
  if (!server) return emptyMcpForm()
  return {
    id: server.id,
    type: server.type,
    command: server.command ?? '',
    args: server.args?.join(' ') ?? '',
    url: server.url ?? '',
    env: recordToLines(server.env),
    headers: recordToLines(server.headers),
    targets: (server.targets ?? []) as AgentId[],
  }
}

function unquoteRecordValue(value: string): string {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      return value.slice(1, -1)
    }
  }
  return value
}

function parseRecordLines(value: string, label: string): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  value.split(/\r?\n/).forEach((rawLine, index) => {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const line = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed
    const equalsAt = line.indexOf('=')
    if (equalsAt === -1) {
      throw new Error(`${label} 第 ${index + 1} 行需要 KEY=value`)
    }

    const key = line.slice(0, equalsAt).trim()
    if (!key) {
      throw new Error(`${label} 第 ${index + 1} 行缺少 key`)
    }
    record[key] = unquoteRecordValue(line.slice(equalsAt + 1).trim())
  })

  return Object.keys(record).length > 0 ? record : undefined
}

function buildServerFromForm(form: McpServerFormState, idOverride?: string): McpServer {
  const id = (idOverride ?? form.id).trim()
  if (!id) throw new Error('id 不能为空')
  if (form.type === 'stdio' && !form.command.trim()) throw new Error('command 不能为空')
  if (form.type !== 'stdio' && !form.url.trim()) throw new Error('url 不能为空')

  const env = parseRecordLines(form.env, 'env')
  const targets = form.targets.length > 0 ? form.targets : undefined

  if (form.type === 'stdio') {
    return {
      id,
      type: form.type,
      command: form.command.trim(),
      args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
      env,
      targets,
    }
  }

  return {
    id,
    type: form.type,
    url: form.url.trim(),
    env,
    headers: parseRecordLines(form.headers, 'headers'),
    targets,
  }
}

function fieldStyle(marginBottom = 14): CSSProperties {
  return { marginBottom }
}

function RecordField({
  name,
  mode,
  value,
  rows,
  setMode,
  onTextChange,
  onRowsChange,
  marginBottom = 14,
}: {
  name: 'env' | 'headers'
  mode: RecordEditMode
  value: string
  rows: RecordRow[]
  setMode: (mode: RecordEditMode) => void
  onTextChange: (value: string) => void
  onRowsChange: (rows: RecordRow[]) => void
  marginBottom?: number
}) {
  const syncRows = (nextRows: RecordRow[]) => {
    onRowsChange(nextRows)
    onTextChange(rowsToLines(nextRows))
  }

  const switchMode = () => {
    if (mode === 'file') {
      onRowsChange(rowsFromLines(value))
      setMode('pairs')
    } else {
      onTextChange(rowsToLines(rows))
      setMode('file')
    }
  }

  const modeLabel =
    mode === 'file' ? `切换 ${name} 为 key value 编辑` : `切换 ${name} 为 env file 编辑`

  return (
    <div className={styles['mcp-field']} style={fieldStyle(marginBottom)}>
      <div className={styles['mcp-record-head']}>
        <span className="label">{name}</span>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          aria-label={modeLabel}
          onClick={switchMode}
        >
          {mode === 'file' ? 'key/value' : 'env file'}
        </Button>
      </div>

      {mode === 'file' ? (
        <textarea
          aria-label={`${name} file`}
          className={styles['mcp-json']}
          value={value}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={name === 'env' ? 'KEY=value' : 'Header-Name=value'}
        />
      ) : (
        <div className={styles['mcp-kv-list']}>
          {rows.map((row, index) => (
            <div className={styles['mcp-kv-row']} key={row.id}>
              <input
                aria-label={`${name} key ${index + 1}`}
                value={row.key}
                onChange={(event) => {
                  const next = rows.map((item) =>
                    item.id === row.id ? { ...item, key: event.target.value } : item,
                  )
                  syncRows(next)
                }}
                placeholder="KEY"
                style={inputStyle}
              />
              <input
                aria-label={`${name} value ${index + 1}`}
                value={row.value}
                onChange={(event) => {
                  const next = rows.map((item) =>
                    item.id === row.id ? { ...item, value: event.target.value } : item,
                  )
                  syncRows(next)
                }}
                placeholder="value"
                style={inputStyle}
              />
              <IconButton
                label={`删除 ${name} 行 ${index + 1}`}
                tooltip="删除行"
                tone="danger"
                onClick={() => {
                  const next =
                    rows.length <= 1 ? [newRecordRow()] : rows.filter((item) => item.id !== row.id)
                  syncRows(next)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          ))}
          <IconButton
            label={`新增 ${name} 行`}
            tooltip="新增行"
            onClick={() => syncRows([...rows, newRecordRow()])}
          >
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  )
}

function McpServerModal({
  open,
  mode,
  initialServer,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean
  mode: McpServerModalMode
  initialServer?: McpServer
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (form: McpServerFormState) => void
}) {
  const [form, setForm] = useState<McpServerFormState>(() => serverToForm(initialServer))
  const [envMode, setEnvMode] = useState<RecordEditMode>('file')
  const [headersMode, setHeadersMode] = useState<RecordEditMode>('file')
  const [envRows, setEnvRows] = useState<RecordRow[]>(() => rowsFromRecord(initialServer?.env))
  const [headersRows, setHeadersRows] = useState<RecordRow[]>(() =>
    rowsFromRecord(initialServer?.headers),
  )

  useEffect(() => {
    if (!open) return
    setForm(mode === 'edit' ? serverToForm(initialServer) : emptyMcpForm())
    setEnvMode('file')
    setHeadersMode('file')
    setEnvRows(rowsFromRecord(mode === 'edit' ? initialServer?.env : undefined))
    setHeadersRows(rowsFromRecord(mode === 'edit' ? initialServer?.headers : undefined))
  }, [initialServer?.id, mode, open])

  const setField = <K extends keyof McpServerFormState>(key: K, value: McpServerFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const title = mode === 'edit' ? '编辑 MCP Server' : 'Add MCP Server'
  const submitText =
    mode === 'edit' ? (busy ? '保存中…' : '保存修改') : busy ? '添加中…' : '添加 MCP Server'

  return (
    <Modal open={open} onClose={onClose} title={title} busy={busy}>
      {error && (
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
          {error}
        </div>
      )}

      <label className={styles['mcp-field']} style={fieldStyle()}>
        <span className="label">id</span>
        <input
          data-autofocus
          value={form.id}
          onChange={(event) => setField('id', event.target.value)}
          placeholder="my-mcp-server"
          disabled={mode === 'edit'}
          style={inputStyle}
        />
      </label>

      <div className={styles['mcp-field']} style={fieldStyle()}>
        <span className="label">type</span>
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          {MCP_TYPES.map((type) => (
            <Button
              key={type}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setField('type', type)}
              style={{
                flex: 1,
                border: '1px solid var(--border)',
                background: form.type === type ? 'var(--bg)' : 'transparent',
                color: form.type === type ? 'var(--bright)' : 'var(--muted)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {type}
            </Button>
          ))}
        </div>
      </div>

      {form.type === 'stdio' ? (
        <>
          <label className={styles['mcp-field']} style={fieldStyle()}>
            <span className="label">command</span>
            <input
              value={form.command}
              onChange={(event) => setField('command', event.target.value)}
              placeholder="npx"
              style={inputStyle}
            />
          </label>
          <label className={styles['mcp-field']} style={fieldStyle(18)}>
            <span className="label">args（空格分隔）</span>
            <input
              value={form.args}
              onChange={(event) => setField('args', event.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              style={inputStyle}
            />
          </label>
        </>
      ) : (
        <label className={styles['mcp-field']} style={fieldStyle(18)}>
          <span className="label">url</span>
          <input
            value={form.url}
            onChange={(event) => setField('url', event.target.value)}
            placeholder="http://localhost:3001/sse"
            style={inputStyle}
          />
        </label>
      )}

      <RecordField
        name="env"
        mode={envMode}
        value={form.env}
        rows={envRows}
        setMode={setEnvMode}
        onTextChange={(value) => setField('env', value)}
        onRowsChange={setEnvRows}
      />

      {form.type !== 'stdio' && (
        <RecordField
          name="headers"
          mode={headersMode}
          value={form.headers}
          rows={headersRows}
          setMode={setHeadersMode}
          onTextChange={(value) => setField('headers', value)}
          onRowsChange={setHeadersRows}
        />
      )}

      <Button
        type="button"
        variant="primary"
        style={{ width: '100%' }}
        onClick={() => onSubmit(form)}
        disabled={busy}
      >
        {submitText}
      </Button>
    </Modal>
  )
}

function McpTargetsBar({
  servers,
  agents,
  operations,
}: {
  servers: McpServer[]
  agents: AgentId[]
  operations: ManifestOperations
}) {
  if (servers.length === 0 || agents.length === 0) return null

  const anyUpdating = agents.some((agent) => operations.pending.mcp.allTargets(agent))

  return (
    <div
      className="global-targets-bar"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
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
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        批量设置 · 应用于全部 MCP servers
      </span>
      <span className="target-chips" style={{ display: 'flex', gap: 7 }}>
        {agents.map((agent) => {
          const count = servers.filter((server) => (server.targets ?? []).includes(agent)).length
          const state = count === 0 ? 'off' : count === servers.length ? 'on' : 'mixed'
          const stateText =
            state === 'on'
              ? '全部 MCP servers 已选择'
              : state === 'mixed'
                ? '部分 MCP servers 已选择'
                : '未选择 MCP servers'
          const tooltip =
            state === 'on' ? '全部已选择' : state === 'mixed' ? '部分已选择' : '未选择'
          return (
            <button
              key={agent}
              type="button"
              className="target-chip"
              style={{ '--c': agentColor[agent] } as CSSProperties}
              data-state={state}
              aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
              aria-label={`${agentShort[agent]}：${stateText}`}
              data-tooltip={`${agentShort[agent]}：${tooltip}`}
              disabled={anyUpdating}
              onClick={() => void operations.setAllMcpTargets(servers, agent)}
            >
              {agentShort[agent]}
              {state === 'mixed' && (
                <span className="target-chip-count">
                  {count}/{servers.length}
                </span>
              )}
            </button>
          )
        })}
      </span>
    </div>
  )
}

export default function Mcp({ repoPath }: { repoPath: string }) {
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
  const [selected, setSelected] = useState<string | null>(null)
  const [modalMode, setModalMode] = useState<McpServerModalMode | null>(null)
  const [modalBusy, setModalBusy] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const modalOperations = useManifestOperations(repoPath, {
    onError: setModalError,
    onToast: showToast,
  })
  const [copied, setCopied] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const servers = manifest?.mcp ?? []
  const visibleAgents = (manifest?.config?.targets ?? []) as AgentId[]
  const selectedServer = servers.find((server) => server.id === selected)

  useEffect(() => {
    if (servers.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !servers.some((server) => server.id === selected)) {
      setSelected(servers[0].id)
    }
  }, [selected, servers])

  const openCreate = () => {
    setModalError(null)
    setModalMode('create')
  }

  const openEdit = () => {
    if (!selectedServer) return
    setModalError(null)
    setModalMode('edit')
  }

  const closeModal = () => {
    if (modalBusy) return
    setModalMode(null)
    setModalError(null)
  }

  const handleSubmitServer = async (form: McpServerFormState) => {
    setModalBusy(true)
    setModalError(null)
    try {
      const server = buildServerFromForm(
        form,
        modalMode === 'edit' ? selectedServer?.id : undefined,
      )
      let result
      if (modalMode === 'edit') {
        if (!selectedServer) return
        result = await modalOperations.updateMcpServer(selectedServer.id, server)
      } else {
        result = await modalOperations.addMcpServer(server)
      }
      if (result.ok) setModalMode(null)
      else setModalError(result.message || '保存 MCP Server 失败')
    } catch (err) {
      console.error({ err }, 'Failed to submit MCP server')
      setModalError(normalizeManifestOperationError(err, '保存 MCP Server 失败'))
    } finally {
      setModalBusy(false)
    }
  }

  const handleToggleTarget = async (
    agent: AgentId,
    server: McpServer | undefined = selectedServer,
  ) => {
    if (!server) return
    const currentTargets = server.targets ?? []
    await operations.toggleMcpTarget({ ...server, targets: currentTargets }, agent)
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
      <div className="page-head">
        <div>
          <div className="page-title">MCP Servers</div>
          <div className="page-sub">{servers.length} servers</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            Add server
          </Button>
          <IconButton
            label="投影 MCP"
            tooltip={operations.pending.project('mcp') ? '投影中…' : '投影'}
            onClick={() => void operations.project('mcp')}
            disabled={operations.pending.project('mcp')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
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

      {servers.length === 0 && manifest && (
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

      <McpTargetsBar servers={servers} agents={visibleAgents} operations={operations} />

      <div
        style={{
          marginTop: 18,
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          gap: 0,
          minHeight: 400,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-card)',
          overflow: 'hidden',
          background: 'var(--card)',
        }}
      >
        <div className={styles.mlist} style={{ borderRight: '1px solid var(--border)' }}>
          {servers.map((server) => {
            const serverAgents = server.targets ?? []
            const isRemote = server.type === 'sse' || server.type === 'http'
            return (
              <div
                key={server.id}
                className={cn(styles.mcp, selected === server.id && styles.sel)}
                onClick={() => setSelected(server.id)}
              >
                <div className={styles['mcp-top']}>
                  <span className={styles.mid}>{server.id}</span>
                  <span className={cn(styles.mtype, isRemote && styles.remote)}>{server.type}</span>
                  <span className={styles.mcnt}>
                    {serverAgents.filter((agent) => visibleAgents.includes(agent)).length}/
                    {visibleAgents.length}
                  </span>
                </div>
                <div className={styles['mcp-bottom']}>
                  <span className={styles.mcmd}>
                    {server.type === 'stdio'
                      ? `${server.command} ${server.args?.join(' ') ?? ''}`
                      : server.url}
                  </span>
                  {visibleAgents.map((agent) => (
                    <button
                      type="button"
                      key={agent}
                      className={cn(
                        styles.tg,
                        serverAgents.includes(agent) ? styles.on : styles.off,
                      )}
                      style={
                        {
                          '--c': agentColor[agent],
                          cursor: 'pointer',
                        } as CSSProperties
                      }
                      aria-pressed={serverAgents.includes(agent)}
                      aria-label={`${server.id}：${agentShort[agent]}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleToggleTarget(agent, server)
                      }}
                    >
                      {agentShort[agent]}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ padding: '18px 24px', overflow: 'auto' }}>
          {selectedServer ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="page-title" style={{ fontSize: 16 }}>
                  {selectedServer.id}
                </span>
                <span
                  className={cn(styles.mtype, selectedServer.type !== 'stdio' && styles.remote)}
                >
                  {selectedServer.type}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <IconButton
                    label={
                      copied
                        ? `已拷贝 MCP Server ${selectedServer.id}`
                        : `拷贝 MCP Server ${selectedServer.id}`
                    }
                    tooltip={copied ? '已拷贝' : '拷贝配置 JSON'}
                    onClick={handleCopy}
                    tone={copied ? 'success' : 'default'}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </IconButton>
                  <IconButton
                    label={`编辑 MCP Server ${selectedServer.id}`}
                    tooltip="编辑"
                    onClick={openEdit}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={`删除 MCP Server ${selectedServer.id}`}
                    tooltip="删除"
                    tone="danger"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
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
                    {Object.entries(selectedServer.env).map(([key, value]) => (
                      <div key={key}>
                        {key}: {value}
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
                      {Object.entries(selectedServer.headers).map(([key, value]) => (
                        <div key={key}>
                          {key}: {value}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </>
          ) : (
            <div style={{ color: 'var(--muted)', textAlign: 'center', paddingTop: 60 }}>
              选择左侧 MCP server 查看详情
            </div>
          )}
        </div>
      </div>

      <McpServerModal
        open={modalMode !== null}
        mode={modalMode ?? 'create'}
        initialServer={modalMode === 'edit' ? selectedServer : undefined}
        busy={modalBusy}
        error={modalError}
        onClose={closeModal}
        onSubmit={handleSubmitServer}
      />

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="删除 MCP Server"
        width={380}
      >
        <p style={{ color: 'var(--text)', fontSize: 13 }}>
          确认删除 <strong>{selectedServer?.id}</strong>？此操作不可撤销。
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
            取消
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ color: 'var(--error)' }}
            onClick={async () => {
              if (!selectedServer) return
              const result = await operations.deleteMcpServer(selectedServer.id)
              if (result.ok) {
                setDeleteOpen(false)
                setSelected(null)
              }
            }}
          >
            删除
          </Button>
        </div>
      </Modal>
    </div>
  )
}
