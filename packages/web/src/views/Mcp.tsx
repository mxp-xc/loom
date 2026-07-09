import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { McpServer, McpType } from '@loom/core'
import { Check, Copy, Edit3, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { useManifest } from '@/hooks/useManifest'
import {
  normalizeManifestOperationError,
  useManifestOperations,
} from '@/hooks/useManifestOperations'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import { AGENTS, agentColor, agentName, agentShort, type AgentId } from '@/lib/agents'
import type { VarsLayerRef, VarsMatrixResponse } from '@/lib/vars'
import {
  buildMcpSettingsPreview,
  buildResolvedMcpServer,
  formatMcpTraceLayer,
  getMcpVariableTokens,
} from './mcp/mcp-preview'
import { useMcpPreviewVars } from './mcp/useMcpPreviewVars'
import styles from './Mcp.module.css'

const MCP_TYPES: McpType[] = ['stdio', 'sse', 'http']

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

type EditorMode = 'create' | 'edit' | null

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
    .map(([key, value]) => key + '=' + (value ?? ''))
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
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote)
      return value.slice(1, -1)
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
    if (equalsAt === -1) throw new Error(label + ' 第 ' + (index + 1) + ' 行需要 KEY=value')
    const key = line.slice(0, equalsAt).trim()
    if (!key) throw new Error(label + ' 第 ' + (index + 1) + ' 行缺少 key')
    record[key] = unquoteRecordValue(line.slice(equalsAt + 1).trim())
  })
  return Object.keys(record).length > 0 ? record : undefined
}

function buildServerFromForm(
  form: McpServerFormState,
  options: { idOverride?: string; preserveTargets?: AgentId[] } = {},
): McpServer {
  const id = (options.idOverride ?? form.id).trim()
  if (!id) throw new Error('id 不能为空')
  if (form.type === 'stdio' && !form.command.trim()) throw new Error('command 不能为空')
  if (form.type !== 'stdio' && !form.url.trim()) throw new Error('url 不能为空')
  const env = parseRecordLines(form.env, 'env')
  const targets = options.preserveTargets?.length ? options.preserveTargets : undefined
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

function formToDraftServer(form: McpServerFormState, fallbackId = 'draft'): McpServer {
  const server: McpServer = { id: form.id.trim() || fallbackId, type: form.type }
  if (form.type === 'stdio') {
    server.command = form.command.trim() || 'npx'
    server.args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined
  } else {
    server.url = form.url.trim() || 'https://example.test/sse'
  }
  try {
    server.env = parseRecordLines(form.env, 'env')
    if (form.type !== 'stdio') server.headers = parseRecordLines(form.headers, 'headers')
  } catch {}
  return server
}

function serverSubtitle(server: McpServer): string {
  return server.type === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : (server.url ?? '')
}

function TargetChip({
  agent,
  active,
  label,
  onClick,
  disabled,
}: {
  agent: AgentId
  active: boolean | 'mixed'
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  const state = active === 'mixed' ? 'mixed' : active ? 'on' : 'off'
  return (
    <button
      type="button"
      className={styles.targetChip}
      style={{ '--c': agentColor[agent] } as CSSProperties}
      data-state={state}
      aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {agentShort[agent]}
    </button>
  )
}

function PreviewTargetSwitch({
  value,
  agents,
  onChange,
}: {
  value: AgentId
  agents: AgentId[]
  onChange: (agent: AgentId) => void
}) {
  return (
    <div className={styles.previewSwitch} aria-label="preview target">
      <span>Preview as</span>
      {(agents.length ? agents : AGENTS).map((agent) => (
        <button
          key={agent}
          type="button"
          className={styles.previewPill}
          data-active={value === agent}
          aria-label={'Preview as ' + agentShort[agent]}
          onClick={() => onChange(agent)}
        >
          {agentShort[agent]}
        </button>
      ))}
    </div>
  )
}

function renderValueWithTokens(value: string, onInspect: (key: string) => void): ReactNode {
  const tokens = getMcpVariableTokens(value)
  if (tokens.length === 0) return value
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) nodes.push(value.slice(cursor, token.start))
    nodes.push(
      <button
        key={token.key + '-' + token.start}
        type="button"
        className={styles.varToken}
        aria-label={'查看变量 ' + token.key}
        onClick={() => onInspect(token.key)}
      >
        {token.token}
      </button>,
    )
    cursor = token.end
  }
  if (cursor < value.length) nodes.push(value.slice(cursor))
  return nodes
}

function RecordPreview({
  record,
  empty,
  onInspect,
}: {
  record: Record<string, string> | undefined
  empty: string
  onInspect: (key: string) => void
}) {
  const entries = Object.entries(record ?? {})
  if (entries.length === 0) return <div className={styles.emptyLine}>{empty}</div>
  return (
    <div className={styles.recordList}>
      {entries.map(([key, value]) => (
        <div className={styles.recordRow} key={key}>
          <span>{key}</span>
          <code>{renderValueWithTokens(value, onInspect)}</code>
        </div>
      ))}
    </div>
  )
}

function serverVariableKeys(server: McpServer): string[] {
  const values = [
    server.command,
    ...(server.args ?? []),
    server.url,
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ].filter((value): value is string => Boolean(value))
  return Array.from(
    new Set(values.flatMap((value) => getMcpVariableTokens(value).map((token) => token.key))),
  )
}

function FieldCard({
  title,
  tone,
  children,
}: {
  title: string
  tone?: string
  children: ReactNode
}) {
  return (
    <section className={styles.fieldCard}>
      <div className={styles.cardKicker}>{title}</div>
      {tone && <div className={styles.cardTone}>{tone}</div>}
      <div className={styles.fieldBody}>{children}</div>
    </section>
  )
}

function McpVariableInspector({
  variableKey,
  matrix,
  onClose,
}: {
  variableKey: string | null
  matrix: VarsMatrixResponse | undefined
  onClose: () => void
}) {
  if (!variableKey) return null
  const resolution = matrix?.resolution.ok ? matrix.resolution : null
  const value = resolution?.values[variableKey]
  const source = resolution?.sources[variableKey]
  const chain = resolution?.overrideChains[variableKey] ?? (source ? [source] : [])
  return (
    <div className={styles.variableOverlay} role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={'变量信息 ' + '$' + '{' + variableKey + '}'}
        className={styles.variablePanel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.variableHead}>
          <div>
            <div className={styles.cardKicker}>VARIABLE TRACE</div>
            <h3>
              变量信息 <span>{'$' + '{' + variableKey + '}'}</span>
            </h3>
          </div>
          <IconButton label="关闭变量信息" tooltip="关闭" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </header>
        <div className={styles.variableBody}>
          <section className={styles.variableValue}>
            <span>Resolved value</span>
            <code>{value ? String(value.value) : '未解析'}</code>
          </section>
          <section className={styles.traceCard}>
            <span>Trace</span>
            <ol>
              {chain.map((layer: VarsLayerRef, index) => (
                <li key={layer.locality + layer.layer + index}>
                  <b>{index + 1}</b>
                  <span>{formatMcpTraceLayer(layer)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </section>
    </div>
  )
}

function McpDetail({
  server,
  previewTarget,
  matrix,
  onPreviewTarget,
  onEdit,
  onCopy,
  onInspect,
}: {
  server: McpServer
  previewTarget: AgentId
  matrix: VarsMatrixResponse | undefined
  onPreviewTarget: (agent: AgentId) => void
  onEdit: () => void
  onCopy: () => void
  onInspect: (key: string) => void
}) {
  const preview = buildResolvedMcpServer(server, previewTarget, matrix)
  const settings = buildMcpSettingsPreview(server, previewTarget, matrix)
  const commandLine =
    server.type === 'stdio'
      ? [preview.server.command, ...(preview.server.args ?? [])].filter(Boolean).join(' ')
      : (preview.server.url ?? '')
  return (
    <div className={styles.detailScroll}>
      <section className={styles.detailHero}>
        <div>
          <div className={styles.cardKicker}>SELECTED SERVER</div>
          <h2>{server.id}</h2>
          <p>{server.type === 'stdio' ? 'local process' : 'remote endpoint'}</p>
        </div>
        <div className={styles.detailActions}>
          <PreviewTargetSwitch value={previewTarget} agents={AGENTS} onChange={onPreviewTarget} />
          <IconButton label="Copy server JSON" tooltip="Copy" onClick={onCopy}>
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="编辑当前 MCP server" tooltip="编辑" onClick={onEdit}>
            <Edit3 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </section>
      <div className={styles.detailGrid}>
        <FieldCard title="TRANSPORT" tone={server.type}>
          <code className={styles.commandLine}>
            {renderValueWithTokens(commandLine, onInspect)}
          </code>
        </FieldCard>
        <FieldCard title="ENV" tone="resolved preview">
          <RecordPreview record={preview.server.env} empty="未配置 env" onInspect={onInspect} />
        </FieldCard>
        {server.type !== 'stdio' && (
          <FieldCard title="HEADERS" tone="remote auth">
            <RecordPreview
              record={preview.server.headers}
              empty="未配置 headers"
              onInspect={onInspect}
            />
          </FieldCard>
        )}
      </div>
      {serverVariableKeys(server).length > 0 && (
        <section className={styles.variableStrip}>
          <span>Variables</span>
          {serverVariableKeys(server).map((key) => (
            <button
              key={key}
              type="button"
              className={styles.varToken}
              aria-label={'查看变量 ' + key}
              onClick={() => onInspect(key)}
            >
              {'$' + '{' + key + '}'}
            </button>
          ))}
        </section>
      )}
      <section className={styles.previewCard}>
        <div className={styles.previewHead}>
          <div>
            <div className={styles.cardKicker}>TARGET SETTINGS PREVIEW</div>
            <p>
              {agentName[previewTarget]} · {settings.path}
            </p>
          </div>
        </div>
        {settings.diagnostics.length > 0 && (
          <div className={styles.previewDiagnostics}>
            {settings.diagnostics.map((item, index) => (
              <span key={item.code + index}>
                {item.code}: {item.message}
              </span>
            ))}
          </div>
        )}
        <pre>{settings.text}</pre>
      </section>
    </div>
  )
}

function McpEditor({
  mode,
  initial,
  previewTarget,
  matrix,
  busy,
  error,
  onPreviewTarget,
  onCancel,
  onSubmit,
}: {
  mode: Exclude<EditorMode, null>
  initial?: McpServer
  previewTarget: AgentId
  matrix: VarsMatrixResponse | undefined
  busy: boolean
  error: string | null
  onPreviewTarget: (agent: AgentId) => void
  onCancel: () => void
  onSubmit: (form: McpServerFormState) => void
}) {
  const [form, setForm] = useState<McpServerFormState>(() => serverToForm(initial))
  useEffect(() => {
    setForm(mode === 'edit' ? serverToForm(initial) : emptyMcpForm())
  }, [initial?.id, mode])
  const settings = buildMcpSettingsPreview(
    formToDraftServer(form, initial?.id),
    previewTarget,
    matrix,
  )
  const setField = <K extends keyof McpServerFormState>(key: K, value: McpServerFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))
  return (
    <div className={styles.detailScroll}>
      <section className={styles.editorHero}>
        <div>
          <div className={styles.cardKicker}>
            {mode === 'edit' ? 'EDIT SERVER' : 'CREATE SERVER'}
          </div>
          <h2>{mode === 'edit' ? '编辑 MCP server' : '新增 MCP server'}</h2>
          <p>保存 server 定义；target 应用和 Project changes 在左侧列表显式完成。</p>
        </div>
        <PreviewTargetSwitch value={previewTarget} agents={AGENTS} onChange={onPreviewTarget} />
      </section>
      {error && <div className={styles.formError}>{error}</div>}
      <section className={styles.editorCard}>
        <label>
          <span>server id</span>
          <input
            aria-label="server id"
            value={form.id}
            disabled={mode === 'edit'}
            onChange={(event) => setField('id', event.target.value)}
            placeholder="new-browser-tools"
          />
        </label>
        <div className={styles.typeGrid}>
          {MCP_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              data-active={form.type === type}
              onClick={() => setField('type', type)}
            >
              {type}
            </button>
          ))}
        </div>
        {form.type === 'stdio' ? (
          <>
            <label>
              <span>command</span>
              <input
                aria-label="command"
                value={form.command}
                onChange={(event) => setField('command', event.target.value)}
                placeholder="npx"
              />
            </label>
            <label>
              <span>args</span>
              <input
                aria-label="args"
                value={form.args}
                onChange={(event) => setField('args', event.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem"
              />
            </label>
          </>
        ) : (
          <label>
            <span>url</span>
            <input
              aria-label="url"
              value={form.url}
              onChange={(event) => setField('url', event.target.value)}
              placeholder="https://example.test/sse"
            />
          </label>
        )}
        <label>
          <span>env</span>
          <textarea
            aria-label="env file"
            value={form.env}
            onChange={(event) => setField('env', event.target.value)}
            placeholder="KEY=value"
          />
        </label>
        {form.type !== 'stdio' && (
          <label>
            <span>headers</span>
            <textarea
              aria-label="headers file"
              value={form.headers}
              onChange={(event) => setField('headers', event.target.value)}
              placeholder="Authorization=Bearer token"
            />
          </label>
        )}
        <div className={styles.editorActions}>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={() => onSubmit(form)} disabled={busy}>
            {busy ? 'Saving…' : 'Save server'}
          </Button>
        </div>
      </section>
      <section className={styles.previewCard}>
        <div className={styles.cardKicker}>WRITE PREVIEW</div>
        <p>
          {agentName[previewTarget]} · {settings.path}
        </p>
        <pre>{settings.text}</pre>
      </section>
    </div>
  )
}

export default function Mcp({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError()
  const { manifest } = useManifest(repoPath, { onError: setError, onSuccess: () => setError(null) })
  const { showToast } = useToast()
  const operations = useManifestOperations(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
    onToast: showToast,
  })
  const { matrices } = useMcpPreviewVars(repoPath)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | McpType>('all')
  const [previewTarget, setPreviewTarget] = useState<AgentId>('codex')
  const [editorMode, setEditorMode] = useState<EditorMode>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null)
  const [inspectedVar, setInspectedVar] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const servers = manifest?.mcp ?? []
  const visibleAgents = ((manifest?.config?.targets ?? AGENTS) as AgentId[]).filter((agent) =>
    AGENTS.includes(agent),
  )
  const selectedServer = servers.find((server) => server.id === selected)

  useEffect(() => {
    if (servers.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !servers.some((server) => server.id === selected)) setSelected(servers[0].id)
  }, [selected, servers])

  const filteredServers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return servers.filter(
      (server) =>
        (filter === 'all' || server.type === filter) &&
        (!term ||
          (server.id + ' ' + server.type + ' ' + serverSubtitle(server))
            .toLowerCase()
            .includes(term)),
    )
  }, [filter, search, servers])

  const submitServer = async (form: McpServerFormState) => {
    setEditorBusy(true)
    setEditorError(null)
    try {
      if (editorMode === 'edit') {
        if (!selectedServer) return
        const server = buildServerFromForm(form, {
          idOverride: selectedServer.id,
          preserveTargets: (selectedServer.targets ?? []) as AgentId[],
        })
        const result = await operations.updateMcpServer(selectedServer.id, server)
        if (result.ok) setEditorMode(null)
        else setEditorError(result.message || '保存 MCP Server 失败')
      } else {
        const server = buildServerFromForm(form)
        const result = await operations.addMcpServer(server)
        if (result.ok) {
          setEditorMode(null)
          setSelected(server.id)
        } else setEditorError(result.message || '添加 MCP Server 失败')
      }
    } catch (err) {
      console.error({ err }, 'Failed to submit MCP server')
      setEditorError(normalizeManifestOperationError(err, '保存 MCP Server 失败'))
    } finally {
      setEditorBusy(false)
    }
  }

  const copySelected = () => {
    if (!selectedServer) return
    navigator.clipboard
      ?.writeText(JSON.stringify([selectedServer], null, 2))
      .then(() => {
        setCopied(true)
        showToast('已拷贝到剪贴板')
        setTimeout(() => setCopied(false), 1200)
      })
      .catch((err) => {
        console.error({ err }, 'Failed to copy MCP server')
        showToast('拷贝失败')
      })
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <div className={styles.kicker}>MCP WORKBENCH</div>
          <h1>MCP Servers</h1>
          <p>定义、target 应用与 Project changes 分开处理；preview target 只影响变量解析预览。</p>
        </div>
        <div className={styles.heroMeta}>
          <span>{servers.length} configured</span>
          {error && <b>{error}</b>}
        </div>
      </section>
      <section className={styles.workbench}>
        <aside className={styles.inventory}>
          <div className={styles.inventoryTop}>
            <div>
              <div className={styles.kicker}>INVENTORY</div>
              <h2>MCP server 列表</h2>
            </div>
            <div className={styles.inventoryActions}>
              <IconButton
                label="Add server"
                tooltip="Add server"
                onClick={() => {
                  setEditorError(null)
                  setEditorMode('create')
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label="Project changes"
                tooltip={operations.pending.project('mcp') ? '投影中…' : 'Project changes'}
                onClick={() => void operations.project('mcp')}
                disabled={operations.pending.project('mcp')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>
          {servers.length > 0 && (
            <div className={styles.globalTargets}>
              <span>应用到全部 server</span>
              <div>
                {visibleAgents.map((agent) => {
                  const count = servers.filter((server) =>
                    (server.targets ?? []).includes(agent),
                  ).length
                  const state = count === 0 ? 'off' : count === servers.length ? 'on' : 'mixed'
                  return (
                    <TargetChip
                      key={agent}
                      agent={agent}
                      active={state === 'mixed' ? 'mixed' : state === 'on'}
                      label={'全部 MCP servers 应用到 ' + agentShort[agent]}
                      onClick={() => void operations.setAllMcpTargets(servers, agent)}
                      disabled={operations.pending.mcp.allTargets(agent)}
                    />
                  )
                })}
              </div>
            </div>
          )}
          <label className={styles.searchBox}>
            <Search className="h-3.5 w-3.5" />
            <input
              type="search"
              aria-label="搜索 MCP server"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search server…"
            />
          </label>
          <div className={styles.filterRow}>
            {(['all', ...MCP_TYPES] as const).map((item) => (
              <button
                key={item}
                type="button"
                data-active={filter === item}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div className={styles.serverList}>
            {filteredServers.map((server) => {
              const activeTargets = server.targets ?? []
              return (
                <article
                  key={server.id}
                  className={styles.serverCard}
                  data-selected={selected === server.id}
                >
                  <button
                    type="button"
                    className={styles.serverMain}
                    aria-label={'选择 ' + server.id}
                    onClick={() => {
                      setSelected(server.id)
                      setEditorMode(null)
                    }}
                  >
                    <span>
                      <b>{server.id}</b>
                      <em>{server.type}</em>
                    </span>
                    <small>{serverSubtitle(server)}</small>
                  </button>
                  <div className={styles.serverFoot}>
                    <div className={styles.rowTargets}>
                      {visibleAgents.map((agent) => (
                        <TargetChip
                          key={agent}
                          agent={agent}
                          active={activeTargets.includes(agent)}
                          label={server.id + ' 应用到 ' + agentShort[agent]}
                          onClick={() =>
                            void operations.toggleMcpTarget(
                              { ...server, targets: server.targets ?? [] },
                              agent,
                            )
                          }
                        />
                      ))}
                    </div>
                    <div className={styles.rowActions}>
                      <IconButton
                        label={'编辑 ' + server.id}
                        tooltip="编辑"
                        onClick={() => {
                          setSelected(server.id)
                          setEditorError(null)
                          setEditorMode('edit')
                        }}
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        label={'删除 ' + server.id}
                        tooltip="删除"
                        tone="danger"
                        onClick={() => setDeleteTarget(server)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </div>
                </article>
              )
            })}
            {filteredServers.length === 0 && (
              <div className={styles.emptyState}>没有匹配的 MCP server</div>
            )}
          </div>
        </aside>
        <main className={styles.detail}>
          {editorMode ? (
            <McpEditor
              mode={editorMode}
              initial={editorMode === 'edit' ? selectedServer : undefined}
              previewTarget={previewTarget}
              matrix={matrices[previewTarget]}
              busy={editorBusy}
              error={editorError}
              onPreviewTarget={setPreviewTarget}
              onCancel={() => setEditorMode(null)}
              onSubmit={submitServer}
            />
          ) : selectedServer ? (
            <McpDetail
              server={selectedServer}
              previewTarget={previewTarget}
              matrix={matrices[previewTarget]}
              onPreviewTarget={setPreviewTarget}
              onEdit={() => {
                setEditorError(null)
                setEditorMode('edit')
              }}
              onCopy={copySelected}
              onInspect={setInspectedVar}
            />
          ) : (
            <div className={styles.noSelection}>
              <h2>还没有 MCP server</h2>
              <p>从左侧新增一个 server，保存后默认不会应用到任何 target。</p>
              <Button variant="primary" onClick={() => setEditorMode('create')}>
                Add server
              </Button>
            </div>
          )}
        </main>
      </section>
      {deleteTarget && (
        <div
          className={styles.variableOverlay}
          role="presentation"
          onMouseDown={() => setDeleteTarget(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="删除 MCP server"
            className={styles.confirmPanel}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3>删除 {deleteTarget.id}？</h3>
            <p>
              只删除 Loom desired state；已投影到 agent 的配置需要之后通过 Project changes
              显式同步。
            </p>
            <div>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  const id = deleteTarget.id
                  const result = await operations.deleteMcpServer(id)
                  if (result.ok) {
                    setDeleteTarget(null)
                    if (selected === id) setSelected(null)
                  }
                }}
              >
                删除
              </Button>
            </div>
          </section>
        </div>
      )}
      <McpVariableInspector
        variableKey={inspectedVar}
        matrix={matrices[previewTarget]}
        onClose={() => setInspectedVar(null)}
      />
      {copied && (
        <div className={styles.copyToast}>
          <Check className="h-3.5 w-3.5" />
          Copied
        </div>
      )}
    </div>
  )
}
