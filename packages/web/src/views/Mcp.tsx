import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { normalizeOrder, type McpServer, type McpType } from '@loom/core'
import {
  Activity,
  Braces,
  Check,
  CircleStop,
  Copy,
  Download,
  Edit3,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Unplug,
  Wrench,
  X,
} from 'lucide-react'
import MonacoTextEditor from '@/components/monaco/MonacoTextEditor'
import { registerVarsCompletionProvider } from '@/components/monaco/varsCompletion'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { TargetChip } from '@/components/ui/TargetChip'
import { SortableList } from '@/components/ui/sortable-list'
import { useManifest } from '@/hooks/useManifest'
import {
  normalizeManifestOperationError,
  useManifestOperations,
} from '@/hooks/useManifestOperations'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import { ErrorState, FieldError } from '@/components/ErrorFeedback'
import { api, type CreateMcpDebugSessionResponse, type McpDebugTool } from '@/lib/api'
import { AGENTS, agentColor, agentName, agentShort, type AgentId } from '@/lib/agents'
import type { VarsLayerRef, VarsMatrixResponse } from '@/lib/vars'
import {
  buildMcpSettingsPreview,
  buildResolvedMcpServer,
  formatMcpTraceLayer,
  getMcpVariableTokens,
} from './mcp/mcp-preview'
import McpImportDialog from './mcp/McpImportDialog'
import { useMcpPreviewVars } from './mcp/useMcpPreviewVars'
import styles from './Mcp.module.css'

const MCP_TYPES: McpType[] = ['stdio', 'sse', 'http']
const MCP_FILTERS = ['all', 'local', 'remote'] as const

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
type RecordEditMode = 'file' | 'pairs'
type McpFilter = (typeof MCP_FILTERS)[number]
type McpDebugSource = 'saved' | 'draft'
type McpDebugConnectionState = 'idle' | 'connecting' | 'connected' | 'stale'
type McpDetailTab = 'config' | 'debug'

interface RecordRow {
  id: string
  key: string
  value: string
}

type JsonSchemaLike = Record<string, unknown>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return (
    '{' +
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ':' + stableStringify(item))
      .join(',') +
    '}'
  )
}

function connectionOnlyServer(server: McpServer): McpServer {
  if (server.type === 'stdio') {
    return {
      id: server.id,
      type: server.type,
      command: server.command,
      args: server.args,
      env: server.env,
    }
  }
  return {
    id: server.id,
    type: server.type,
    url: server.url,
    env: server.env,
    headers: server.headers,
  }
}

function sampleObjectFromSchema(schema: unknown): Record<string, unknown> {
  const sample = sampleFromSchema(schema, 0)
  return isPlainRecord(sample) ? sample : {}
}

function sampleFromSchema(schema: unknown, depth: number): unknown {
  if (!schema || typeof schema !== 'object') return null
  const value = schema as JsonSchemaLike

  if ('default' in value) return value.default
  if ('const' in value) return value.const
  if (Array.isArray(value.examples) && value.examples.length > 0) return value.examples[0]
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0]

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const candidates = value[key]
    if (Array.isArray(candidates) && candidates.length > 0) {
      return sampleFromSchema(candidates[0], depth)
    }
  }

  const schemaType = Array.isArray(value.type) ? value.type[0] : value.type
  if (schemaType === 'object' || isPlainRecord(value.properties)) {
    if (depth >= 2) return {}
    const sample: Record<string, unknown> = {}
    const properties = isPlainRecord(value.properties) ? value.properties : {}
    const required = Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === 'string')
      : []
    const keys = [...required, ...Object.keys(properties).filter((key) => !required.includes(key))]
    for (const key of keys) sample[key] = sampleFromSchema(properties[key], depth + 1)
    return sample
  }

  if (schemaType === 'array') {
    return value.items ? [sampleFromSchema(value.items, depth + 1)] : []
  }
  if (schemaType === 'integer' || schemaType === 'number') return 0
  if (schemaType === 'boolean') return false
  if (schemaType === 'string') return ''
  return null
}

function starterArgsForTool(tool: McpDebugTool | null): string {
  return JSON.stringify(sampleObjectFromSchema(tool?.inputSchema), null, 2)
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
    .map(([key, value]) => key + '=' + (value ?? ''))
    .join('\n')
}

function highlightJsonLine(line: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = []
  const tokenPattern =
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g
  let cursor = 0
  for (const match of line.matchAll(tokenPattern)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push(line.slice(cursor, index))
    const token = match[0]
    const className = match[1]
      ? 'hljs-attr'
      : match[2]
        ? 'hljs-string'
        : match[3]
          ? 'hljs-literal'
          : /-?\d/.test(token)
            ? 'hljs-number'
            : 'hljs-punctuation'
    parts.push(
      <span key={keyPrefix + '-' + index} className={className}>
        {token}
      </span>,
    )
    cursor = index + token.length
  }
  if (cursor < line.length) parts.push(line.slice(cursor))
  return parts
}

function highlightTomlLine(line: string, keyPrefix: string): ReactNode[] {
  const section = /^(\s*)(\[[^\]]+\])(\s*)$/.exec(line)
  if (section) {
    return [
      section[1],
      <span key={keyPrefix + '-section'} className="hljs-section">
        {section[2]}
      </span>,
      section[3],
    ]
  }

  const pair = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/.exec(line)
  if (!pair) return highlightJsonLine(line, keyPrefix)

  return [
    pair[1],
    <span key={keyPrefix + '-key'} className="hljs-attr">
      {pair[2]}
    </span>,
    <span key={keyPrefix + '-op'} className="hljs-punctuation">
      {pair[3]}
    </span>,
    ...highlightJsonLine(pair[4], keyPrefix + '-value'),
  ]
}

function renderSettingsPreviewSyntax(text: string, target: AgentId): ReactNode[] {
  const lines = text.split('\n')
  return lines.flatMap((line, index) => [
    ...(target === 'codex'
      ? highlightTomlLine(line, 'line-' + index)
      : highlightJsonLine(line, 'line-' + index)),
    index < lines.length - 1 ? '\n' : null,
  ])
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
    .map((row) => row.key.trim() + '=' + row.value)
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

function serverProjectionState(server: McpServer, visibleAgents: AgentId[]) {
  const active = (server.targets ?? []).filter((agent) => visibleAgents.includes(agent)).length
  if (active === 0) return { tone: 'draft', label: 'draft' }
  if (active === visibleAgents.length) return { tone: 'projected', label: 'projected' }
  return { tone: 'partial', label: 'partial' }
}

function TypeBadge({ type, large }: { type: McpType; large?: boolean }) {
  return (
    <span className={large ? styles.typeBadgeLarge : styles.typeBadge} data-type={type}>
      {type}
    </span>
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
          style={{ '--c': agentColor[agent] } as CSSProperties}
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

function renderValueWithTokens(
  value: string,
  onInspect: (key: string) => void,
  labelPrefix = '查看变量 ',
): ReactNode {
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
        aria-label={labelPrefix + token.key}
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
  resolved,
  empty,
  onInspect,
}: {
  record: Record<string, string> | undefined
  resolved?: Record<string, string> | undefined
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
          <code>
            {renderValueWithTokens(value, onInspect, '查看字段变量 ')}
            {resolved?.[key] && resolved[key] !== value && (
              <small className={styles.recordResolved}>
                <span>解析预览</span>
                <span>{resolved[key]}</span>
              </small>
            )}
          </code>
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
      <div className={styles.fieldCardHead}>
        <div className={styles.cardKicker}>{title}</div>
        {tone && <small>{tone}</small>}
      </div>
      <div className={styles.fieldBody}>{children}</div>
    </section>
  )
}

function RecordField({
  name,
  mode,
  value,
  rows,
  setMode,
  onTextChange,
  onRowsChange,
  varsKeys = [],
}: {
  name: 'env' | 'headers'
  mode: RecordEditMode
  value: string
  rows: RecordRow[]
  setMode: (mode: RecordEditMode) => void
  onTextChange: (value: string) => void
  onRowsChange: (rows: RecordRow[]) => void
  varsKeys?: string[]
}) {
  const varsKeysRef = useRef(varsKeys)

  useEffect(() => {
    varsKeysRef.current = varsKeys
  }, [varsKeys])

  const onEditorMount = useCallback(
    (_editor: unknown, monaco: unknown) =>
      registerVarsCompletionProvider(monaco, 'plaintext', () => varsKeysRef.current),
    [],
  )

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
    <section className={styles.recordField}>
      <div className={styles.recordHead}>
        <span>{name}</span>
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
        <MonacoTextEditor
          key={varsKeys.length > 0 ? name + '-vars' : name + '-plain'}
          ariaLabel={name + ' file'}
          height="150px"
          language="plaintext"
          value={value}
          onChange={onTextChange}
          onEditorMount={varsKeys.length > 0 ? onEditorMount : undefined}
          options={{
            lineNumbers: 'off',
            padding: { top: 10, bottom: 10 },
          }}
        />
      ) : (
        <div className={styles.kvList}>
          {rows.map((row, index) => (
            <div className={styles.kvRow} key={row.id}>
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
            <div className={styles.cardKicker}>VARIABLE</div>
            <h3>变量信息</h3>
            <p>{'$' + '{' + variableKey + '}'}</p>
          </div>
          <div className={styles.variableHeadActions}>
            <span>{value?.type ?? 'unknown'}</span>
            <IconButton
              label="关闭变量信息"
              tooltip="关闭"
              className={styles.variableClose}
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </header>
        <div className={styles.variableBody}>
          <section className={styles.variableCard}>
            <span>definition</span>
            <code className={styles.variableName}>{'$' + '{' + variableKey + '}'}</code>
            <dl className={styles.variableMeta}>
              <div>
                <dt>resolved value</dt>
                <dd>{value ? String(value.value) : '未解析'}</dd>
              </div>
              <div>
                <dt>type</dt>
                <dd>{value?.type ?? 'unknown'}</dd>
              </div>
              <div>
                <dt>source</dt>
                <dd>{source ? '当前来源 · ' + formatMcpTraceLayer(source) : '未解析'}</dd>
              </div>
            </dl>
          </section>
          <section className={styles.variableCard}>
            <span>resolution trace</span>
            <ol className={styles.variableTrace}>
              {chain.map((layer: VarsLayerRef, index) => (
                <li key={layer.locality + layer.layer + index}>
                  <b>{index + 1}</b>
                  <div>
                    <strong>{formatMcpTraceLayer(layer)}</strong>
                    <p>
                      {layer.locality === 'builtin'
                        ? '运行时注入的变量值。'
                        : layer.locality === 'local'
                          ? '本机配置覆盖或补充。'
                          : '仓库同步配置提供的基线。'}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <footer className={styles.variableFooter}>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </footer>
      </section>
    </div>
  )
}

function McpDebugPanel({
  repoPath,
  source,
  server,
  previewTarget,
}: {
  repoPath: string
  source: McpDebugSource
  server: McpServer
  previewTarget: AgentId
}) {
  const [connection, setConnection] = useState<McpDebugConnectionState>('idle')
  const [session, setSession] = useState<Extract<
    CreateMcpDebugSessionResponse,
    { ok: true }
  > | null>(null)
  const [selectedTool, setSelectedTool] = useState<string | null>(null)
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [calling, setCalling] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const connectionKey = useMemo(
    () => source + ':' + previewTarget + ':' + stableStringify(connectionOnlyServer(server)),
    [previewTarget, server, source],
  )
  const connectionKeyRef = useRef(connectionKey)
  const tools = session?.tools ?? []
  const activeTool = tools.find((tool) => tool.name === selectedTool) ?? tools[0] ?? null
  const regionLabel = source === 'draft' ? 'MCP draft tools debug' : 'MCP tools debug'

  useEffect(() => {
    sessionIdRef.current = session?.sessionId ?? null
  }, [session?.sessionId])

  useEffect(() => {
    return () => {
      if (sessionIdRef.current) void api.disconnectMcpDebugSession(sessionIdRef.current)
    }
  }, [])

  useEffect(() => {
    if (connectionKeyRef.current === connectionKey) return
    connectionKeyRef.current = connectionKey
    if (session) {
      const staleSessionId = session.sessionId
      sessionIdRef.current = null
      setSession(null)
      setSelectedTool(null)
      setConnection('stale')
      setResult(null)
      setError(null)
      setParseError(null)
      setCalling(false)
      void api.disconnectMcpDebugSession(staleSessionId).catch((err) => {
        console.error(
          { err, sessionId: staleSessionId },
          'Failed to disconnect stale MCP debug session',
        )
      })
    }
  }, [connectionKey, session])

  useEffect(() => {
    setArgs(starterArgsForTool(activeTool))
    setParseError(null)
    setResult(null)
  }, [activeTool?.name])

  const disconnectCurrent = async () => {
    if (!session) {
      setConnection('idle')
      return
    }
    const sessionId = session.sessionId
    setSession(null)
    setSelectedTool(null)
    setConnection('idle')
    setResult(null)
    setError(null)
    setParseError(null)
    try {
      await api.disconnectMcpDebugSession(sessionId)
    } catch (err) {
      console.error({ err, sessionId }, 'Failed to disconnect MCP debug session')
    }
  }

  const connect = async () => {
    setConnection('connecting')
    setError(null)
    setParseError(null)
    setResult(null)
    if (session) {
      try {
        await api.disconnectMcpDebugSession(session.sessionId)
      } catch (err) {
        console.error({ err, sessionId: session.sessionId }, 'Failed to replace MCP debug session')
      }
    }
    try {
      const request =
        source === 'saved'
          ? ({ repo: repoPath, source, serverId: server.id, previewTarget } as const)
          : ({
              repo: repoPath,
              source,
              draft: connectionOnlyServer(server),
              previewTarget,
            } as const)
      const response = await api.createMcpDebugSession(request)
      if (!response.ok) {
        setSession(null)
        setConnection('idle')
        setError(response.message || response.error || '连接 MCP debug session 失败')
        return
      }
      setSession(response)
      const firstTool = response.tools[0] ?? null
      setSelectedTool(firstTool?.name ?? null)
      setArgs(starterArgsForTool(firstTool))
      setConnection('connected')
    } catch (err) {
      console.error({ err, source, serverId: server.id }, 'Failed to create MCP debug session')
      setSession(null)
      setConnection('idle')
      setError(normalizeManifestOperationError(err, '连接 MCP debug session 失败'))
    }
  }

  const callTool = async () => {
    if (!session || !activeTool || connection !== 'connected') return
    setCalling(true)
    setError(null)
    setParseError(null)
    setResult(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(args)
      if (!isPlainRecord(parsed)) throw new Error('arguments must be a JSON object')
    } catch (err) {
      console.error({ err, args, toolName: activeTool.name }, 'Failed to parse MCP tool arguments')
      setParseError('参数 JSON 无法解析')
      setCalling(false)
      return
    }

    try {
      const response = await api.callMcpDebugTool(session.sessionId, {
        toolName: activeTool.name,
        arguments: parsed,
      })
      if (!response.ok) {
        setError(response.message || response.error || 'MCP tool 调用失败')
        if (response.error === 'session_expired') {
          setSession(null)
          setConnection('idle')
        }
        return
      }
      setResult(JSON.stringify(response, null, 2))
    } catch (err) {
      console.error(
        { err, sessionId: session.sessionId, toolName: activeTool.name },
        'Failed to call MCP tool',
      )
      setError(normalizeManifestOperationError(err, 'MCP tool 调用失败'))
    } finally {
      setCalling(false)
    }
  }

  const canCall = connection === 'connected' && Boolean(activeTool) && !calling
  const connectLabel = connection === 'stale' ? 'Reconnect debug session' : 'Connect debug session'

  return (
    <section className={styles.debugPanel} role="region" aria-label={regionLabel}>
      <div className={styles.debugToolbar}>
        <div>
          <div className={styles.cardKicker}>DEBUG SESSION</div>
          <strong>Tools only</strong>
          <small>
            {source === 'draft'
              ? '连接当前草稿，字段变更后需要重新连接。'
              : '连接、tools、参数和结果在 detail 内分栏。'}
          </small>
        </div>
        <div className={styles.debugActions}>
          <span className={styles.debugState} data-state={connection}>
            <Activity className="h-3.5 w-3.5" />
            {connection}
          </span>
          {connection === 'connected' ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void disconnectCurrent()}
            >
              <Unplug className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="sm"
              aria-label={connectLabel}
              onClick={() => void connect()}
              disabled={connection === 'connecting'}
            >
              {connection === 'connecting' ? (
                <LoaderCircle className="h-3.5 w-3.5" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {connection === 'stale' ? 'Reconnect' : 'Connect'}
            </Button>
          )}
        </div>
      </div>

      {(error || parseError) && <div className={styles.debugError}>{parseError ?? error}</div>}

      <div className={styles.debugBody}>
        <section className={styles.debugTools}>
          <div className={styles.debugPanelHead}>
            <strong>Tools</strong>
            <span>{tools.length}</span>
          </div>
          <div className={styles.debugToolList}>
            {tools.map((tool) => (
              <button
                key={tool.name}
                type="button"
                data-active={activeTool?.name === tool.name}
                onClick={() => setSelectedTool(tool.name)}
              >
                <Wrench className="h-3.5 w-3.5" />
                <span>{tool.name}</span>
                {tool.description && <small>{tool.description}</small>}
              </button>
            ))}
            {tools.length === 0 && <div className={styles.debugEmpty}>连接后显示 tools</div>}
          </div>
        </section>

        <section className={styles.debugCall}>
          <div className={styles.debugPanelHead}>
            <div>
              <strong>参数</strong>
              <small>JSON arguments</small>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setArgs(starterArgsForTool(activeTool))}
              disabled={!activeTool}
            >
              <Braces className="h-3.5 w-3.5" />
              重置参数
            </Button>
          </div>
          <div className={styles.debugEditor}>
            <MonacoTextEditor
              ariaLabel="Tool arguments JSON"
              language="json"
              height="100%"
              value={args}
              onChange={setArgs}
              options={{
                folding: false,
                lineNumbersMinChars: 3,
                padding: { top: 10, bottom: 10 },
                wordWrap: 'on',
              }}
            />
          </div>
          <div className={styles.debugCallActions}>
            <Button
              type="button"
              variant="primary"
              onClick={() => void callTool()}
              disabled={!canCall}
            >
              {calling ? <CircleStop className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {calling ? 'Calling' : 'Call tool'}
            </Button>
            <span>{connection === 'connected' ? '真实调用，无二次确认' : '连接后才能调用'}</span>
          </div>
          <pre className={styles.debugResult} data-empty={!result}>
            {result ?? 'Call result will appear here.'}
          </pre>
        </section>
      </div>
    </section>
  )
}

function McpDetail({
  repoPath,
  server,
  previewTarget,
  matrix,
  onPreviewTarget,
  onEdit,
  onCopy,
  onInspect,
}: {
  repoPath: string
  server: McpServer
  previewTarget: AgentId
  matrix: VarsMatrixResponse | undefined
  onPreviewTarget: (agent: AgentId) => void
  onEdit: () => void
  onCopy: () => void
  onInspect: (key: string) => void
}) {
  const [detailTab, setDetailTab] = useState<McpDetailTab>('config')
  const preview = buildResolvedMcpServer(server, previewTarget, matrix)
  const settings = buildMcpSettingsPreview(server, previewTarget, matrix)
  const rawCommandLine =
    server.type === 'stdio'
      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
      : (server.url ?? '')
  const resolvedCommandLine =
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
        <TypeBadge type={server.type} large />
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
      <div className={styles.detailTabs} role="tablist" aria-label="MCP detail sections">
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === 'config'}
          data-active={detailTab === 'config'}
          onClick={() => setDetailTab('config')}
        >
          配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === 'debug'}
          data-active={detailTab === 'debug'}
          onClick={() => setDetailTab('debug')}
        >
          Tools 调试
        </button>
      </div>
      {detailTab === 'config' ? (
        <>
          <div className={styles.detailGrid}>
            <FieldCard title="TRANSPORT" tone={server.type}>
              <div className={styles.codePreview}>
                <pre className={styles.commandLine}>
                  {renderValueWithTokens(rawCommandLine, onInspect, '查看 transport 变量 ')}
                </pre>
                {resolvedCommandLine !== rawCommandLine && (
                  <div className={styles.resolvedPreview}>
                    <span>解析预览</span>
                    <code>{resolvedCommandLine}</code>
                  </div>
                )}
              </div>
            </FieldCard>
            <FieldCard title="ENV" tone="resolved preview">
              <RecordPreview
                record={server.env}
                resolved={preview.server.env}
                empty="未配置 env"
                onInspect={onInspect}
              />
            </FieldCard>
            {server.type !== 'stdio' && (
              <FieldCard title="HEADERS" tone="remote auth">
                <RecordPreview
                  record={server.headers}
                  resolved={preview.server.headers}
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
                <strong>{agentName[previewTarget]} 写入预览</strong>
                <p>使用当前 target 的变量解析结果，预览 transport、env、headers 和最终配置形态。</p>
              </div>
            </div>
            <div
              className={styles.previewPath}
              style={{ '--c': agentColor[previewTarget] } as CSSProperties}
            >
              <span>{agentName[previewTarget]}</span>
              <code>{settings.path}</code>
              <em>{(server.targets ?? []).includes(previewTarget) ? '当前已应用' : '仅预览'}</em>
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
            <pre className={styles.syntaxPreview}>
              <code>{renderSettingsPreviewSyntax(settings.text, previewTarget)}</code>
            </pre>
          </section>
        </>
      ) : (
        <McpDebugPanel
          repoPath={repoPath}
          source="saved"
          server={server}
          previewTarget={previewTarget}
        />
      )}
    </div>
  )
}

function McpEditor({
  repoPath,
  mode,
  initial,
  previewTarget,
  matrix,
  varsKeys,
  busy,
  error,
  onPreviewTarget,
  onCancel,
  onSubmit,
}: {
  repoPath: string
  mode: Exclude<EditorMode, null>
  initial?: McpServer
  previewTarget: AgentId
  matrix: VarsMatrixResponse | undefined
  varsKeys: string[]
  busy: boolean
  error: string | null
  onPreviewTarget: (agent: AgentId) => void
  onCancel: () => void
  onSubmit: (form: McpServerFormState) => void
}) {
  const [form, setForm] = useState<McpServerFormState>(() => serverToForm(initial))
  const [envMode, setEnvMode] = useState<RecordEditMode>('file')
  const [headersMode, setHeadersMode] = useState<RecordEditMode>('file')
  const [envRows, setEnvRows] = useState<RecordRow[]>(() => rowsFromRecord(initial?.env))
  const [headersRows, setHeadersRows] = useState<RecordRow[]>(() =>
    rowsFromRecord(initial?.headers),
  )

  useEffect(() => {
    setForm(mode === 'edit' ? serverToForm(initial) : emptyMcpForm())
    setEnvMode('file')
    setHeadersMode('file')
    setEnvRows(rowsFromRecord(mode === 'edit' ? initial?.env : undefined))
    setHeadersRows(rowsFromRecord(mode === 'edit' ? initial?.headers : undefined))
  }, [initial?.id, mode])
  const draftServer = useMemo(() => formToDraftServer(form, initial?.id), [form, initial?.id])
  const settings = buildMcpSettingsPreview(draftServer, previewTarget, matrix)
  const transportLabel =
    form.type === 'stdio' ? 'local process' : form.type === 'sse' ? 'event stream' : 'remote http'
  const setField = <K extends keyof McpServerFormState>(key: K, value: McpServerFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))
  return (
    <div className={styles.editorShell}>
      <section className={styles.editorHero}>
        <div>
          <div className={styles.cardKicker}>
            {mode === 'edit' ? 'EDIT SERVER' : 'CREATE SERVER'}
          </div>
          <h2>{mode === 'edit' ? '编辑 MCP server' : '新增 MCP server'}</h2>
          <p>编辑 server 定义本身；是否应用到各 agent，回到列表里单独控制。</p>
          <div className={styles.editorHeroMeta}>
            <span>{transportLabel}</span>
            <span>{mode === 'create' ? 'unprojected by default' : 'definition only'}</span>
            <span>draft only</span>
          </div>
        </div>
        <TypeBadge type={form.type} large />
        <PreviewTargetSwitch value={previewTarget} agents={AGENTS} onChange={onPreviewTarget} />
      </section>
      {error && <FieldError id="mcp-server-form-error">{error}</FieldError>}
      <div className={styles.editorFormStack}>
        <section className={styles.editorCard}>
          <div className={styles.editorCardHead}>
            <div>
              <div className={styles.cardKicker}>IDENTITY</div>
              <strong>命名与说明</strong>
            </div>
            <small>不会写入 header/env</small>
          </div>
          <div className={styles.editorFields}>
            <label>
              <span>server id</span>
              <input
                aria-label="server id"
                value={form.id}
                disabled={mode === 'edit'}
                onChange={(event) => setField('id', event.target.value)}
                placeholder="new-browser-tools"
              />
              <small>保存后作为各 agent 配置里的 key。</small>
            </label>
          </div>
        </section>

        <section className={styles.editorCard}>
          <div className={styles.editorCardHead}>
            <div>
              <div className={styles.cardKicker}>CONNECTION</div>
              <strong>Transport 与入口</strong>
            </div>
          </div>
          <div className={styles.editorTransport}>
            {MCP_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                data-active={form.type === type}
                aria-pressed={form.type === type}
                onClick={() => setField('type', type)}
              >
                <span>{type}</span>
                <small>
                  {type === 'stdio'
                    ? 'local process'
                    : type === 'sse'
                      ? 'event stream'
                      : 'remote http'}
                </small>
              </button>
            ))}
          </div>
          <div className={styles.editorFields}>
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
          </div>
        </section>

        <section className={styles.editorCard}>
          <div className={styles.editorCardHead}>
            <div>
              <div className={styles.cardKicker}>VARIABLES</div>
              <strong>{form.type === 'stdio' ? 'Env 变量' : 'Env 与 headers'}</strong>
            </div>
            <small>{form.type === 'stdio' ? 'stdio 不显示 headers' : 'remote auth 单独成行'}</small>
          </div>
          <RecordField
            name="env"
            mode={envMode}
            value={form.env}
            rows={envRows}
            setMode={setEnvMode}
            onTextChange={(value) => setField('env', value)}
            onRowsChange={setEnvRows}
            varsKeys={varsKeys}
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
              varsKeys={varsKeys}
            />
          )}
        </section>

        <section className={`${styles.previewCard} ${styles.editorCard}`}>
          <div className={styles.previewHead}>
            <div>
              <div className={styles.cardKicker}>WRITE PREVIEW</div>
              <p>
                {agentName[previewTarget]} · {settings.path}
              </p>
            </div>
          </div>
          <pre className={styles.syntaxPreview}>
            <code>{renderSettingsPreviewSyntax(settings.text, previewTarget)}</code>
          </pre>
        </section>
        <McpDebugPanel
          repoPath={repoPath}
          source="draft"
          server={draftServer}
          previewTarget={previewTarget}
        />
      </div>
      <footer className={styles.editorActionbar}>
        <div>
          <strong>{mode === 'create' ? 'Create as draft' : 'Save draft changes'}</strong>
          <span>
            {mode === 'create'
              ? '新增后默认不应用到任何 target。'
              : '只保存 server 定义，不改变 target 应用状态。'}
          </span>
        </div>
        <div className={styles.editorActions}>
          <Button type="button" variant="ghost" className={styles.editorCancel} onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-label="Save server"
            className={styles.editorSave}
            onClick={() => onSubmit(form)}
            disabled={busy}
          >
            <Check className="h-3.5 w-3.5" />
            {busy ? 'Saving…' : mode === 'create' ? 'Create draft' : 'Save draft'}
          </Button>
        </div>
      </footer>
    </div>
  )
}

function GlobalTargetsBar({
  servers,
  visibleAgents,
  operations,
}: {
  servers: McpServer[]
  visibleAgents: AgentId[]
  operations: ReturnType<typeof useManifestOperations>
}) {
  if (servers.length === 0) return null
  return (
    <section className={styles.globalTargets} role="region" aria-label="全局 MCP targets">
      <span className={styles.globalTargetsLabel}>投影目标</span>
      <div className="target-chips">
        {visibleAgents.map((agent) => {
          const count = servers.filter((server) => (server.targets ?? []).includes(agent)).length
          const state = count === 0 ? 'off' : count === servers.length ? 'on' : 'mixed'
          return (
            <TargetChip
              key={agent}
              agent={agent}
              state={state}
              label={'全部 MCP servers 应用到 ' + agentShort[agent]}
              tooltip={'应用到 ' + agentShort[agent]}
              onClick={() => void operations.setAllMcpTargets(servers, agent)}
              disabled={operations.pending.mcp.allTargets(agent)}
              stopPropagation
            />
          )
        })}
      </div>
    </section>
  )
}

export default function Mcp({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError({
    title: 'MCP Server 加载失败',
    message: '请检查项目配置后重试',
  })
  const { manifest } = useManifest(repoPath, { onError: setError, onSuccess: () => setError(null) })
  const { showToast, showErrorToast } = useToast()
  const operations = useManifestOperations(repoPath, {
    onError: (message) =>
      showErrorToast(new Error(message), {
        title: 'MCP 操作失败',
        message: '请检查配置后重试',
      }),
    onToast: showToast,
  })
  const { matrices } = useMcpPreviewVars(repoPath)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<McpFilter>('all')
  const [previewTarget, setPreviewTarget] = useState<AgentId>('codex')
  const [editorMode, setEditorMode] = useState<EditorMode>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null)
  const [inspectedVar, setInspectedVar] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [serverOrder, setServerOrder] = useState<string[]>([])

  const manifestServers = manifest?.mcp ?? []
  const orderedServerIds = normalizeOrder(
    serverOrder,
    manifestServers.map((server) => server.id),
  )
  const serversById = new Map(manifestServers.map((server) => [server.id, server]))
  const servers = orderedServerIds.map((id) => serversById.get(id)!).filter(Boolean)
  const visibleAgents = ((manifest?.config?.targets ?? AGENTS) as AgentId[]).filter((agent) =>
    AGENTS.includes(agent),
  )
  const selectedServer = servers.find((server) => server.id === selected)
  const mcpVarsKeys = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(matrices).flatMap((matrix) => [
            ...(matrix?.userKeys ?? []),
            ...(matrix?.builtinKeys ?? []),
          ]),
        ),
      ).sort(),
    [matrices],
  )

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
        (filter === 'all' ||
          (filter === 'local' && server.type === 'stdio') ||
          (filter === 'remote' && server.type !== 'stdio')) &&
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
        showErrorToast(err, { title: '复制失败', message: '请检查剪贴板权限后重试' })
      })
  }

  const reorderServers = async (next: McpServer[]) => {
    const previous = orderedServerIds
    const nextIds = next.map((server) => server.id)
    setServerOrder(nextIds)
    try {
      const result = await api.reorderMcpServers({ repo: repoPath, ids: nextIds })
      setServerOrder(result.ids)
    } catch (reorderError) {
      console.error({ err: reorderError }, 'Failed to reorder MCP servers')
      setServerOrder(previous)
      try {
        const current = (await api.getManifest(repoPath)) as { mcp?: McpServer[] }
        setServerOrder(current.mcp?.map((server) => server.id) ?? previous)
      } catch (reloadError) {
        console.error({ err: reloadError }, 'Failed to reload MCP order after reorder failure')
      }
      showErrorToast(reorderError, { title: 'MCP 排序失败', message: '已恢复原顺序，请重试' })
    }
  }

  return (
    <div className={styles.page}>
      {error && <ErrorState {...error} />}
      <section className={styles.workbench} role="region" aria-label="MCP workbench">
        <aside className={styles.inventory} aria-label="MCP inventory">
          <div className={styles.inventoryTop}>
            <div className={styles.inventoryHeading}>
              <div className={styles.inventoryTitle}>
                <div className={styles.kicker}>MCP</div>
                <h2>Server 列表</h2>
              </div>
              <div
                className={styles.inventoryActions}
                role="toolbar"
                aria-label="MCP inventory actions"
              >
                <IconButton
                  label="Add server"
                  tooltip="Add server"
                  variant="secondary"
                  size="sm"
                  className={styles.inventoryActionPrimary}
                  onClick={() => {
                    setEditorError(null)
                    setEditorMode('create')
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label="Import MCP"
                  tooltip="Import"
                  variant="secondary"
                  size="sm"
                  className={styles.inventoryActionImport}
                  onClick={() => setImportOpen(true)}
                  disabled={operations.pending.mcp.importScan || operations.pending.mcp.importApply}
                >
                  <Download className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label="Project changes"
                  tooltip={operations.pending.project('mcp') ? '投影中…' : '投影'}
                  variant="secondary"
                  size="sm"
                  onClick={() => void operations.project('mcp')}
                  disabled={operations.pending.project('mcp')}
                >
                  {operations.pending.project('mcp') ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </IconButton>
              </div>
            </div>
            <GlobalTargetsBar
              servers={servers}
              visibleAgents={visibleAgents}
              operations={operations}
            />
          </div>
          <label className={styles.searchBox}>
            <Search className="h-3.5 w-3.5" />
            <input
              type="search"
              aria-label="搜索 MCP server"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by id, command, url"
            />
          </label>
          <div className={styles.filterRow}>
            {MCP_FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                data-active={filter === item}
                onClick={() => setFilter(item)}
              >
                {item === 'all' ? 'All' : item === 'local' ? 'Local' : 'Remote'}
              </button>
            ))}
          </div>
          <div className={styles.serverList}>
            <SortableList
              items={filteredServers}
              label={(server) => server.id}
              disabled={search.trim().length > 0 || filter !== 'all'}
              onReorder={reorderServers}
            >
              {(server) => {
                const activeTargets = server.targets ?? []
                const projectionState = serverProjectionState(server, visibleAgents)
                return (
                  <article
                    role="button"
                    tabIndex={-1}
                    aria-label={'选择 ' + server.id}
                    className={styles.serverCard}
                    data-selected={selected === server.id}
                    onClick={() => {
                      setSelected(server.id)
                      setEditorMode(null)
                    }}
                  >
                    <span className={styles.serverMain} aria-label={'选择 ' + server.id}>
                      <span className={styles.serverTopline}>
                        <b>{server.id}</b>
                        <TypeBadge type={server.type} />
                        <span className={styles.rowActions} aria-label={server.id + ' actions'}>
                          <IconButton
                            label={'编辑 ' + server.id}
                            tooltip="编辑"
                            onClick={(event) => {
                              event.stopPropagation()
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
                            onClick={(event) => {
                              event.stopPropagation()
                              setDeleteTarget(server)
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </IconButton>
                        </span>
                      </span>
                      <small>{serverSubtitle(server)}</small>
                    </span>
                    <div className={styles.serverFoot}>
                      <span className={styles.projectionState} data-tone={projectionState.tone}>
                        {projectionState.label}
                      </span>
                      <div className={styles.rowTargets}>
                        {visibleAgents.map((agent) => (
                          <TargetChip
                            key={agent}
                            agent={agent}
                            state={activeTargets.includes(agent) ? 'on' : 'off'}
                            label={server.id + ' 应用到 ' + agentShort[agent]}
                            tooltip={server.id + ' 应用到 ' + agentShort[agent]}
                            onClick={() =>
                              void operations.toggleMcpTarget(
                                { ...server, targets: server.targets ?? [] },
                                agent,
                              )
                            }
                            stopPropagation
                          />
                        ))}
                      </div>
                    </div>
                  </article>
                )
              }}
            </SortableList>
            {filteredServers.length === 0 && (
              <div className={styles.emptyState}>没有匹配的 MCP server</div>
            )}
          </div>
        </aside>
        <McpImportDialog
          open={importOpen}
          operations={operations}
          onClose={() => setImportOpen(false)}
        />
        <main className={styles.detail}>
          {editorMode ? (
            <McpEditor
              repoPath={repoPath}
              mode={editorMode}
              initial={editorMode === 'edit' ? selectedServer : undefined}
              previewTarget={previewTarget}
              matrix={matrices[previewTarget]}
              varsKeys={mcpVarsKeys}
              busy={editorBusy}
              error={editorError}
              onPreviewTarget={setPreviewTarget}
              onCancel={() => setEditorMode(null)}
              onSubmit={submitServer}
            />
          ) : selectedServer ? (
            <McpDetail
              repoPath={repoPath}
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
