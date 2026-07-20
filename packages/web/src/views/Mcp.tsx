import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  applicableAgents,
  isAgentId,
  normalizeOrder,
  type McpServer,
  type McpType,
} from '@loom/core'
import {
  Activity,
  ArrowLeft,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  Command,
  Copy,
  Download,
  Edit3,
  FileJson2,
  FileText,
  GripVertical,
  KeyRound,
  LayoutList,
  LoaderCircle,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  Trash2,
  Unplug,
  Variable,
  Wrench,
  X,
} from 'lucide-react'
import MonacoTextEditor from '@/components/monaco/MonacoTextEditor'
import { registerVarsCompletionProvider } from '@/components/monaco/varsCompletion'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { AgentChip } from '@/components/ui/AgentChip'
import { SortableList } from '@/components/ui/sortable-list'
import { useManifest } from '@/hooks/useManifest'
import {
  normalizeManifestOperationError,
  useManifestOperations,
} from '@/hooks/useManifestOperations'
import { useToast } from '@/hooks/useToast'
import { useViewError } from '@/hooks/useViewError'
import { ErrorState, FieldError } from '@/components/ErrorFeedback'
import {
  api,
  type CreateMcpDebugSessionResponse,
  type McpDebugPreviewAgent,
  type McpDebugTool,
} from '@/lib/api'
import { agentColor, agentName, agentShort, type AgentId } from '@/lib/agents'
import type { VarsLayerRef, VarsMatrixResponse } from '@/lib/vars'
import {
  buildMcpSettingsPreview,
  buildResolvedMcpServer,
  formatMcpTraceLayer,
  getMcpVariableTokens,
} from './mcp/mcp-preview'
import McpImportDialog from './mcp/McpImportDialog'
import { useMcpPreviewVars, type McpResolveContext } from './mcp/useMcpPreviewVars'
import styles from './mcp/McpWorkbench.module.css'

const MCP_TYPES: McpType[] = ['stdio', 'sse', 'http']

interface McpServerFormState {
  id: string
  type: McpType
  command: string
  args: string[]
  url: string
  env: string
  headers: string
}

type EditorMode = 'create' | 'edit' | null
type EditorViewMode = 'visual' | 'json'
type RecordEditMode = 'file' | 'pairs'
type McpDebugConnectionState = 'idle' | 'connecting' | 'connected'
type McpDetailTab = 'config' | 'debug'
type McpConfigView = 'raw' | McpResolveContext

function isAgentConfigView(view: McpConfigView): view is AgentId {
  return isAgentId(view)
}

function drawerLocation(): { selected: string | null; editorMode: EditorMode } {
  if (typeof window === 'undefined') return { selected: null, editorMode: null }
  const params = new URLSearchParams(window.location.search)
  const view = params.get('view')
  const server = params.get('server')
  if (view === 'create') return { selected: null, editorMode: 'create' }
  if (view === 'edit' && server) return { selected: server, editorMode: 'edit' }
  if (view === 'detail' && server) return { selected: server, editorMode: null }
  return { selected: null, editorMode: null }
}

function writeDrawerLocation(view: 'detail' | 'edit' | 'create' | null, server?: string) {
  const url = new URL(window.location.href)
  if (view) url.searchParams.set('view', view)
  else url.searchParams.delete('view')
  if (server) url.searchParams.set('server', server)
  else url.searchParams.delete('server')
  window.history.pushState({}, '', url)
}

interface RecordRow {
  id: string
  key: string
  value: string
}

type JsonSchemaLike = Record<string, unknown>

interface ToolInputParameter {
  path: string
  type: string
  required: boolean
  description: string
  details: string[]
}

const MCP_TOOL_PARAMETERS_EXPANDED_KEY = 'loom:mcp-debug:parameters-expanded'

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

function schemaTypeLabel(schema: JsonSchemaLike): string {
  const schemaType = schema.type
  if (Array.isArray(schemaType)) {
    const types = schemaType.filter((item): item is string => typeof item === 'string')
    if (types.length > 0) return types.join(' | ')
  }
  if (typeof schemaType === 'string') return schemaType
  if (isPlainRecord(schema.properties)) return 'object'
  if (schema.items) return 'array'
  return 'unknown'
}

function schemaDetailValue(value: unknown): string {
  if (typeof value === 'string') return value
  const serialized = stableStringify(value)
  return serialized === undefined ? String(value) : serialized
}

function toolInputParameters(schema: unknown): ToolInputParameter[] {
  const parameters: ToolInputParameter[] = []

  const visit = (value: unknown, parentPath: string, depth: number) => {
    if (!isPlainRecord(value) || depth > 4) return
    const properties = isPlainRecord(value.properties) ? value.properties : null
    if (!properties) return
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter((item): item is string => typeof item === 'string')
        : [],
    )

    for (const [name, propertyValue] of Object.entries(properties)) {
      const path = parentPath ? `${parentPath}.${name}` : name
      const property = isPlainRecord(propertyValue) ? propertyValue : {}
      const details: string[] = []
      if ('default' in property) details.push(`default: ${schemaDetailValue(property.default)}`)
      if (Array.isArray(property.enum) && property.enum.length > 0) {
        details.push(`enum: ${property.enum.map(schemaDetailValue).join(' | ')}`)
      }
      if ('const' in property) details.push(`const: ${schemaDetailValue(property.const)}`)

      parameters.push({
        path,
        type: schemaTypeLabel(property),
        required: required.has(name),
        description:
          typeof property.description === 'string' && property.description.trim()
            ? property.description
            : '未提供 description',
        details,
      })

      visit(property, path, depth + 1)
      if (property.items) visit(property.items, `${path}[]`, depth + 1)
    }
  }

  visit(schema, '', 0)
  return parameters
}

function initialToolParametersExpanded(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(MCP_TOOL_PARAMETERS_EXPANDED_KEY) !== 'false'
  } catch (err) {
    console.error({ err }, 'Failed to read MCP tool parameters disclosure state')
    return true
  }
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
    args: [],
    url: '',
    env: '',
    headers: '',
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

function renderSettingsPreviewSyntax(text: string, language: 'json' | 'toml'): ReactNode[] {
  const lines = text.split('\n')
  return lines.flatMap((line, index) => [
    ...(language === 'toml'
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
    args: [...(server.args ?? [])],
    url: server.url ?? '',
    env: recordToLines(server.env),
    headers: recordToLines(server.headers),
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
    if (Object.hasOwn(record, key)) throw new Error(label + ' 包含重复 key: ' + key)
    record[key] = unquoteRecordValue(line.slice(equalsAt + 1).trim())
  })
  return Object.keys(record).length > 0 ? record : undefined
}

function recordValidationError(value: string, label: string): string | null {
  try {
    parseRecordLines(value, label)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : `${label} 格式无效`
  }
}

function buildServerFromForm(
  form: McpServerFormState,
  options: { idOverride?: string; preserveAgents?: AgentId[] } = {},
): McpServer {
  const id = (options.idOverride ?? form.id).trim()
  if (!id) throw new Error('id 不能为空')
  if (form.type === 'stdio' && !form.command.trim()) throw new Error('command 不能为空')
  if (form.type !== 'stdio' && !form.url.trim()) throw new Error('url 不能为空')
  const env = parseRecordLines(form.env, 'env')
  const agents = options.preserveAgents?.length ? options.preserveAgents : undefined
  if (form.type === 'stdio') {
    return {
      id,
      type: form.type,
      command: form.command.trim(),
      args: form.args.length > 0 ? [...form.args] : undefined,
      env,
      agents,
    }
  }
  return {
    id,
    type: form.type,
    url: form.url.trim(),
    env,
    headers: parseRecordLines(form.headers, 'headers'),
    agents,
  }
}

function formToPreviewServer(form: McpServerFormState, fallbackId = 'new-server'): McpServer {
  const server: McpServer = { id: form.id.trim() || fallbackId, type: form.type }
  if (form.type === 'stdio') {
    server.command = form.command.trim() || 'npx'
    server.args = form.args.length > 0 ? [...form.args] : undefined
  } else {
    server.url = form.url.trim() || 'https://example.test/sse'
  }
  try {
    server.env = parseRecordLines(form.env, 'env')
    if (form.type !== 'stdio') server.headers = parseRecordLines(form.headers, 'headers')
  } catch {}
  return server
}

function formToSource(form: McpServerFormState): string {
  const definition: Record<string, unknown> = { id: form.id, type: form.type }
  if (form.type === 'stdio') {
    definition.command = form.command
    if (form.args.length > 0) definition.args = form.args
  } else {
    definition.url = form.url
  }
  const env = parseRecordLines(form.env, 'env')
  if (env) definition.env = env
  if (form.type !== 'stdio') {
    const headers = parseRecordLines(form.headers, 'headers')
    if (headers) definition.headers = headers
  }
  return JSON.stringify(definition, null, 2)
}

function formFromSource(source: string, expectedId?: string): McpServerFormState {
  const value: unknown = JSON.parse(source)
  if (!isPlainRecord(value)) throw new Error('Server JSON 必须是对象')
  if ('agents' in value) throw new Error('agents 只能在列表中配置')
  if (typeof value.id !== 'string') throw new Error('id 必须是字符串')
  if (!MCP_TYPES.includes(value.type as McpType)) throw new Error('type 必须是 stdio、sse 或 http')
  if (expectedId !== undefined && value.id !== expectedId) throw new Error('已保存的 id 不可修改')
  const type = value.type as McpType
  const allowedKeys = new Set(
    type === 'stdio'
      ? ['id', 'type', 'command', 'args', 'env']
      : ['id', 'type', 'url', 'env', 'headers'],
  )
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unsupportedKeys.length > 0)
    throw new Error(`${type} 不支持字段: ${unsupportedKeys.join(', ')}`)
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))
  )
    throw new Error('args 必须是 string[]')
  for (const key of ['env', 'headers'] as const) {
    const record = value[key]
    if (record === undefined) continue
    if (!isPlainRecord(record) || Object.values(record).some((item) => typeof item !== 'string'))
      throw new Error(`${key} 必须是 string record`)
  }
  if (type === 'stdio' && typeof value.command !== 'string') throw new Error('stdio 需要 command')
  if (type !== 'stdio' && typeof value.url !== 'string') throw new Error(`${type} 需要 url`)
  return serverToForm({
    id: value.id,
    type,
    command: typeof value.command === 'string' ? value.command : undefined,
    args: value.args as string[] | undefined,
    url: typeof value.url === 'string' ? value.url : undefined,
    env: value.env as Record<string, string> | undefined,
    headers: value.headers as Record<string, string> | undefined,
  })
}

function serverSubtitle(server: McpServer): string {
  return server.type === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : (server.url ?? '')
}

function TypeBadge({ type }: { type: McpType }) {
  return (
    <span className={styles.transport} data-type={type} data-transport={type}>
      {type}
    </span>
  )
}

function PreviewAgentSwitch({
  value,
  agents,
  onChange,
}: {
  value: McpConfigView
  agents: AgentId[]
  onChange: (view: McpConfigView) => void
}) {
  return (
    <div className={styles.configViewOptions} aria-label="preview agent">
      <button
        type="button"
        className={styles.rawModeButton}
        data-active={value === 'raw'}
        aria-pressed={value === 'raw'}
        onClick={() => onChange('raw')}
      >
        <Braces className="h-3.5 w-3.5" />
        RAW
      </button>
      <button
        type="button"
        className={styles.defaultModeButton}
        data-active={value === 'default'}
        aria-pressed={value === 'default'}
        onClick={() => onChange('default')}
      >
        Default
      </button>
      <span className={styles.configViewDivider} aria-hidden="true" />
      {agents.map((agent) => (
        <AgentChip
          key={agent}
          agent={agent}
          state={value === agent ? 'on' : 'off'}
          label={'Preview as ' + agentName[agent]}
          tooltip={'使用 ' + agentName[agent] + ' 解析配置'}
          onClick={() => onChange(agent)}
        />
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

function RecordField({
  name,
  mode,
  value,
  rows,
  setMode,
  onTextChange,
  onRowsChange,
  error,
  varsKeys = [],
}: {
  name: 'env' | 'headers'
  mode: RecordEditMode
  value: string
  rows: RecordRow[]
  setMode: (mode: RecordEditMode) => void
  onTextChange: (value: string) => void
  onRowsChange: (rows: RecordRow[]) => void
  error?: string | null
  varsKeys?: string[]
}) {
  const varsKeysRef = useRef(varsKeys)

  useEffect(() => {
    varsKeysRef.current = varsKeys
  }, [varsKeys])

  const onEditorMount = useCallback(
    (_editor: unknown, monaco: Parameters<typeof registerVarsCompletionProvider>[0]) =>
      registerVarsCompletionProvider(monaco, 'plaintext', () => varsKeysRef.current),
    [],
  )

  const syncRows = (nextRows: RecordRow[]) => {
    onRowsChange(nextRows)
    onTextChange(rowsToLines(nextRows))
  }

  const switchMode = (nextMode: RecordEditMode) => {
    if (nextMode === mode) return
    if (nextMode === 'pairs') {
      onRowsChange(rowsFromLines(value))
      setMode('pairs')
    } else {
      onTextChange(rowsToLines(rows))
      setMode('file')
    }
  }

  const keyCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.key.trim()
    if (key) counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})

  return (
    <section className={styles.recordEditor}>
      <div className={styles.recordModeBar}>
        <div className={styles.recordModeSwitch} role="tablist" aria-label={`${name} 编辑方式`}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'pairs'}
            aria-label={`切换 ${name} 为 key value 编辑`}
            onClick={() => switchMode('pairs')}
          >
            <LayoutList className="h-3.5 w-3.5" />
            Key/value
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'file'}
            aria-label={`切换 ${name} 为 env file 编辑`}
            onClick={() => switchMode('file')}
          >
            <FileText className="h-3.5 w-3.5" />
            {name === 'env' ? 'env file' : 'raw text'}
          </button>
        </div>
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
        <div className={styles.recordEditor}>
          <div className={styles.recordHeader} aria-hidden="true">
            <span>KEY</span>
            <span>VALUE</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div className={styles.recordRow} key={row.id}>
              <div
                className={styles.recordInput}
                data-invalid={
                  Boolean(row.value.trim() && !row.key.trim()) ||
                  Boolean(row.key.trim() && keyCounts[row.key.trim()] > 1)
                }
              >
                <KeyRound className="h-3.5 w-3.5" />
                <input
                  aria-label={`${name} key ${index + 1}`}
                  aria-invalid={
                    Boolean(row.value.trim() && !row.key.trim()) ||
                    Boolean(row.key.trim() && keyCounts[row.key.trim()] > 1)
                  }
                  value={row.key}
                  onChange={(event) => {
                    const next = rows.map((item) =>
                      item.id === row.id ? { ...item, key: event.target.value } : item,
                    )
                    syncRows(next)
                  }}
                  placeholder={name === 'env' ? 'API_KEY' : 'Authorization'}
                />
              </div>
              <div className={styles.recordInput}>
                <Variable className="h-3.5 w-3.5" />
                <input
                  aria-label={`${name} value ${index + 1}`}
                  value={row.value}
                  onChange={(event) => {
                    const next = rows.map((item) =>
                      item.id === row.id ? { ...item, value: event.target.value } : item,
                    )
                    syncRows(next)
                  }}
                  placeholder="${VARIABLE_NAME}"
                />
              </div>
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
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={styles.addRecordButton}
            aria-label={`新增 ${name} 行`}
            onClick={() => syncRows([...rows, newRecordRow()])}
          >
            <Plus className="h-3.5 w-3.5" />
            {name === 'env' ? '添加环境变量' : '添加 Header'}
          </Button>
        </div>
      )}
      {error && (
        <p className={styles.recordError} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function ArgumentsEditor({
  args,
  onChange,
}: {
  args: string[]
  onChange: (args: string[]) => void
}) {
  const items = args.map((value, index) => ({ id: `argument-${index}`, index, value }))

  return (
    <section className={styles.argumentsEditor} aria-label="Arguments">
      <header className={styles.argumentsHeader}>
        <strong>Arguments</strong>
      </header>
      <SortableList
        items={items}
        activator="child"
        className={styles.argumentList}
        label={(item) => `Argument ${item.index + 1}`}
        onReorder={(next) => onChange(next.map((item) => item.value))}
      >
        {(item, sortable) => (
          <div className={styles.argumentRow} data-dragging={sortable.dragging || undefined}>
            <span className={styles.argumentIndex}>{item.index + 1}</span>
            <button
              type="button"
              className={styles.argumentHandle}
              aria-label={`拖拽 Argument ${item.index + 1}`}
              {...sortable.activatorProps}
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <input
              aria-label={`Argument ${item.index + 1}`}
              value={item.value}
              placeholder={item.index === 0 ? '-y' : '@scope/server'}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text')
                if (!/\r?\n/.test(text)) return
                event.preventDefault()
                const parts = text.replace(/\r\n/g, '\n').split('\n')
                if (parts.at(-1) === '') parts.pop()
                onChange([...args.slice(0, item.index), ...parts, ...args.slice(item.index + 1)])
              }}
              onChange={(event) =>
                onChange(
                  args.map((arg, index) => (index === item.index ? event.target.value : arg)),
                )
              }
            />
            <div className={styles.argumentActions}>
              <IconButton
                label={`删除 Argument ${item.index + 1}`}
                tooltip="删除"
                tone="danger"
                onClick={() => onChange(args.filter((_, index) => index !== item.index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>
        )}
      </SortableList>
      <Button type="button" variant="secondary" size="xs" onClick={() => onChange([...args, ''])}>
        <Plus className="h-3.5 w-3.5" />
        添加参数
      </Button>
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
          <h3>变量信息</h3>
          <IconButton label="关闭变量信息" tooltip="关闭" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </header>
        <div className={styles.variableBody}>
          <div className={styles.variableDefinitionHead}>
            <code>{'$' + '{' + variableKey + '}'}</code>
            <span data-kind={value?.type ?? 'unknown'}>{value?.type ?? 'unknown'}</span>
          </div>
          <dl className={styles.variableSummary}>
            <div>
              <dt>Resolved value</dt>
              <dd>{value ? String(value.value) : '未解析'}</dd>
            </div>
            <div>
              <dt>Current source</dt>
              <dd>{source ? '当前来源 · ' + formatMcpTraceLayer(source) : '未解析'}</dd>
            </div>
          </dl>
          <section className={styles.variableTraceSection}>
            <header>
              <strong>Resolution trace</strong>
              <small>Base → Local → Runtime</small>
            </header>
            <ol className={styles.variableTrace}>
              {chain.map((layer: VarsLayerRef, index) => (
                <li
                  key={layer.locality + layer.layer + index}
                  data-active={index === chain.length - 1}
                >
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
          <div className={styles.variableInspectorActions}>
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function McpDebugPanel({
  repoPath,
  server,
  previewAgent,
  needsSave = false,
  onPersist,
  disabledReason,
}: {
  repoPath: string
  server: McpServer
  previewAgent: McpDebugPreviewAgent
  needsSave?: boolean
  onPersist?: () => Promise<McpServer | null>
  disabledReason?: string
}) {
  const [connection, setConnection] = useState<McpDebugConnectionState>('idle')
  const [session, setSession] = useState<Extract<
    CreateMcpDebugSessionResponse,
    { ok: true }
  > | null>(null)
  const [selectedTool, setSelectedTool] = useState<string | null>(null)
  const [toolQuery, setToolQuery] = useState('')
  const [parametersExpanded, setParametersExpanded] = useState(initialToolParametersExpanded)
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState<string | null>(null)
  const [resultCopied, setResultCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [calling, setCalling] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const connectGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const connectionKey = useMemo(
    () =>
      (disabledReason ?? 'enabled') +
      ':' +
      previewAgent +
      ':' +
      stableStringify(connectionOnlyServer(server)),
    [disabledReason, previewAgent, server],
  )
  const connectionKeyRef = useRef(connectionKey)
  const tools = session?.tools ?? []
  const normalizedToolQuery = toolQuery.trim().toLowerCase()
  const visibleTools = useMemo(() => {
    if (!normalizedToolQuery) return tools
    const tokens = normalizedToolQuery.split(/\s+/)
    return tools.filter((tool) => {
      const searchText = `${tool.name} ${tool.description ?? ''}`.toLowerCase()
      return tokens.every((token) => searchText.includes(token))
    })
  }, [normalizedToolQuery, tools])
  const activeTool = tools.find((tool) => tool.name === selectedTool) ?? tools[0] ?? null
  const activeToolParameters = useMemo(
    () => toolInputParameters(activeTool?.inputSchema),
    [activeTool?.inputSchema],
  )
  const requiredParameterCount = activeToolParameters.filter(
    (parameter) => parameter.required,
  ).length

  useEffect(() => {
    sessionIdRef.current = session?.sessionId ?? null
  }, [session?.sessionId])

  useEffect(() => setToolQuery(''), [session?.sessionId])

  useEffect(() => {
    if (!resultCopied) return
    const timer = window.setTimeout(() => setResultCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [resultCopied])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      connectGenerationRef.current += 1
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (sessionId)
        void api.disconnectMcpDebugSession(sessionId).catch((err) => {
          console.error({ err, sessionId }, 'Failed to disconnect unmounted MCP debug session')
        })
    }
  }, [])

  useEffect(() => {
    if (connectionKeyRef.current === connectionKey) return
    connectionKeyRef.current = connectionKey
    connectGenerationRef.current += 1
    setConnection('idle')
    if (session) {
      const previousSessionId = session.sessionId
      sessionIdRef.current = null
      setSession(null)
      setSelectedTool(null)
      setConnection('idle')
      setResult(null)
      setError(null)
      setParseError(null)
      setCalling(false)
      void api.disconnectMcpDebugSession(previousSessionId).catch((err) => {
        console.error(
          { err, sessionId: previousSessionId },
          'Failed to disconnect replaced MCP debug session',
        )
      })
    }
  }, [connectionKey, session])

  useEffect(() => {
    setArgs(starterArgsForTool(activeTool))
    setParseError(null)
    setResult(null)
    setResultCopied(false)
  }, [activeTool?.name])

  const disconnectCurrent = async () => {
    connectGenerationRef.current += 1
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
    const generation = ++connectGenerationRef.current
    setConnection('connecting')
    setError(null)
    setParseError(null)
    setResult(null)
    setResultCopied(false)
    if (session) {
      try {
        await api.disconnectMcpDebugSession(session.sessionId)
      } catch (err) {
        console.error({ err, sessionId: session.sessionId }, 'Failed to replace MCP debug session')
      }
    }
    try {
      const persisted = needsSave ? await onPersist?.() : server
      if (!persisted) {
        if (mountedRef.current && generation === connectGenerationRef.current) setConnection('idle')
        return
      }
      if (!mountedRef.current || generation !== connectGenerationRef.current) return
      const response = await api.createMcpDebugSession({
        repo: repoPath,
        source: 'saved',
        serverId: persisted.id,
        previewAgent,
      })
      if (!mountedRef.current || generation !== connectGenerationRef.current) {
        if (response.ok)
          void api.disconnectMcpDebugSession(response.sessionId).catch((err) => {
            console.error(
              { err, sessionId: response.sessionId },
              'Failed to disconnect stale MCP debug session',
            )
          })
        return
      }
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
      console.error({ err, serverId: server.id }, 'Failed to create MCP debug session')
      if (!mountedRef.current || generation !== connectGenerationRef.current) return
      setSession(null)
      setConnection('idle')
      setError(normalizeManifestOperationError(err, '连接 MCP debug session 失败'))
    }
  }

  const callTool = async () => {
    if (disabledReason || !session || !activeTool || connection !== 'connected') return
    setCalling(true)
    setError(null)
    setParseError(null)
    setResult(null)
    setResultCopied(false)
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

  const copyResult = async () => {
    if (!result) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(result)
      setError(null)
      setResultCopied(true)
    } catch (err) {
      console.error({ err }, 'Failed to copy MCP tool result')
      setError('复制调用结果失败')
    }
  }

  const toggleParameters = () => {
    setParametersExpanded((previous) => {
      const next = !previous
      try {
        window.localStorage.setItem(MCP_TOOL_PARAMETERS_EXPANDED_KEY, String(next))
      } catch (err) {
        console.error(
          { err, expanded: next },
          'Failed to save MCP tool parameters disclosure state',
        )
      }
      return next
    })
  }

  const canCall = !disabledReason && connection === 'connected' && Boolean(activeTool) && !calling
  const connectLabel = needsSave ? '保存并连接 MCP server' : 'Connect debug session'
  const contextDescription =
    previewAgent === 'default'
      ? '使用 Base → Local 变量连接当前 Server。'
      : `使用 ${agentName[previewAgent]} 变量连接当前 Server。`

  return (
    <section className={styles.toolsDebug} role="region" aria-label="MCP tools debug">
      <div className={styles.toolsToolbar}>
        <div className={styles.toolsIntro}>
          <strong>Tools 调试</strong>
          <small>{disabledReason ?? contextDescription}</small>
        </div>
        <div className={styles.toolsActions}>
          <span className={styles.toolsState} data-state={connection}>
            <Activity className="h-3.5 w-3.5" />
            {connection}
          </span>
          {connection === 'connected' ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.toolsConnectionButton}
              style={{ height: 30, paddingInline: 9 }}
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
              className={styles.toolsConnectionButton}
              style={{ height: 30, paddingInline: 9 }}
              aria-label={connectLabel}
              onClick={() => void connect()}
              disabled={connection === 'connecting' || Boolean(disabledReason)}
            >
              {connection === 'connecting' ? (
                <LoaderCircle className="h-3.5 w-3.5" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {needsSave ? '保存并连接' : '连接'}
            </Button>
          )}
        </div>
      </div>

      {(error || parseError) && <div className={styles.toolsError}>{parseError ?? error}</div>}

      <div className={styles.toolsBody}>
        <section className={styles.toolsColumn}>
          <header>
            <div className={styles.toolsListTitle}>
              <strong>Tools</strong>
              <span aria-label={`显示 ${visibleTools.length} / ${tools.length} 个 Tools`}>
                {normalizedToolQuery ? `${visibleTools.length}/${tools.length}` : tools.length}
              </span>
            </div>
            <label className={styles.toolsSearch}>
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">搜索 Tools</span>
              <input
                type="search"
                aria-label="搜索 Tools"
                placeholder="搜索…"
                value={toolQuery}
                disabled={tools.length === 0}
                onChange={(event) => setToolQuery(event.target.value)}
              />
            </label>
          </header>
          <div className={styles.toolsList}>
            {visibleTools.map((tool) => (
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
            {tools.length === 0 && <div className={styles.toolsNotice}>连接后显示 tools</div>}
            {tools.length > 0 && visibleTools.length === 0 && (
              <div className={styles.toolsNoMatches}>没有匹配的 Tools</div>
            )}
          </div>
        </section>

        <section className={styles.toolCallColumn}>
          <header>
            <div className={styles.selectedTool} aria-live="polite">
              <strong title={activeTool?.name}>{activeTool?.name ?? '参数'}</strong>
              <small title={activeTool?.description}>
                {activeTool?.description ?? 'JSON arguments'}
              </small>
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
          </header>
          <section className={styles.toolParameters} aria-label="Tool 参数说明">
            <button
              type="button"
              className={styles.toolParametersToggle}
              aria-expanded={parametersExpanded}
              onClick={toggleParameters}
              disabled={!activeTool}
            >
              {parametersExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <strong>参数说明</strong>
              <span>
                {activeTool
                  ? `${requiredParameterCount} 必填 · ${activeToolParameters.length} 个`
                  : '选择 Tool 后显示'}
              </span>
            </button>
            {parametersExpanded && activeTool && (
              <div className={styles.toolParametersList} role="list">
                {activeToolParameters.map((parameter) => (
                  <div className={styles.toolParameter} role="listitem" key={parameter.path}>
                    <div className={styles.toolParameterKey}>
                      <code>{parameter.path}</code>
                      <span>{parameter.type}</span>
                      {parameter.required && <b>必填</b>}
                    </div>
                    <p>{parameter.description}</p>
                    {parameter.details.length > 0 && <small>{parameter.details.join(' · ')}</small>}
                  </div>
                ))}
                {activeToolParameters.length === 0 && (
                  <div className={styles.toolParametersEmpty}>这个 Tool 没有入参</div>
                )}
              </div>
            )}
          </section>
          <div className={styles.toolArguments}>
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
          <div className={styles.toolCallActions}>
            <Button
              type="button"
              variant="primary"
              aria-label={calling ? 'Calling MCP tool' : 'Call tool'}
              aria-busy={calling}
              onClick={() => void callTool()}
              disabled={!canCall}
            >
              {calling ? (
                <LoaderCircle className={`${styles.toolCallSpinner} h-3.5 w-3.5`} />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {calling ? 'Calling…' : 'Call tool'}
            </Button>
            <span>{connection === 'connected' ? '真实调用，无二次确认' : '连接后才能调用'}</span>
          </div>
          <section className={styles.toolResultPanel} aria-label="Tool 调用结果">
            <header>
              <strong>调用结果</strong>
              <IconButton
                label={resultCopied ? '已复制调用结果' : '复制调用结果'}
                tooltip={resultCopied ? '已复制' : '复制结果'}
                onClick={() => void copyResult()}
                disabled={!result}
              >
                {resultCopied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </IconButton>
            </header>
            <pre className={styles.toolResult} data-empty={!result}>
              <code>
                {result
                  ? renderSettingsPreviewSyntax(result, 'json')
                  : 'Call result will appear here.'}
              </code>
            </pre>
          </section>
        </section>
      </div>
    </section>
  )
}

function DrawerSectionTabs({
  value,
  onChange,
}: {
  value: McpDetailTab
  onChange: (value: McpDetailTab) => void
}) {
  return (
    <div className={styles.sectionTabs} role="tablist" aria-label="Server 工作区">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'config'}
        onClick={() => onChange('config')}
      >
        <Settings2 className="h-3.5 w-3.5" />
        配置
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'debug'}
        onClick={() => onChange('debug')}
      >
        <Wrench className="h-3.5 w-3.5" />
        Tools
      </button>
    </div>
  )
}

function DetailDefinitionGroup({
  tone,
  icon,
  title,
  meta,
  rows,
}: {
  tone: 'connection' | 'env' | 'headers'
  icon: ReactNode
  title: string
  meta: string
  rows: Array<{ label: string; value: ReactNode }>
}) {
  if (rows.length === 0) return null
  return (
    <section className={styles.definitionGroup} data-tone={tone}>
      <header>
        <span className={styles.definitionGroupIcon}>{icon}</span>
        <div>
          <strong>{title}</strong>
          <small>{meta}</small>
        </div>
      </header>
      <dl>
        {rows.map((row, index) => (
          <div key={`${row.label}-${index}`}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function ServerPreview({
  server,
  configView,
  agent,
  matrix,
}: {
  server: McpServer
  configView: McpConfigView
  agent: AgentId | null
  matrix: VarsMatrixResponse | undefined
}) {
  const raw = configView === 'raw'
  const defaultView = configView === 'default'
  const resolveContext = agent ?? 'default'
  const resolvedPreview = buildResolvedMcpServer(server, resolveContext, matrix)
  const resolved = resolvedPreview.server
  const settings = agent ? buildMcpSettingsPreview(server, agent, matrix) : null
  const diagnostics = raw ? [] : defaultView ? resolvedPreview.diagnostics : settings!.diagnostics
  const text = raw
    ? formToSource(serverToForm(server))
    : defaultView
      ? formToSource(serverToForm(resolved))
      : settings!.text
  const previewKicker = raw
    ? 'SERVER DEFINITION'
    : defaultView
      ? 'RESOLVED SERVER PREVIEW'
      : 'AGENT SETTINGS PREVIEW'
  const previewTitle = raw
    ? '原始 Server 配置'
    : defaultView
      ? 'Default 解析配置'
      : `${agentName[agent!]} 写入预览`
  const previewDescription = raw
    ? '保留 ${...} 变量引用，显示 Loom 中保存的定义。'
    : defaultView
      ? '使用 Base → Local 变量，显示 Server 的实际连接配置。'
      : '使用当前 agent 的变量解析结果，预览最终配置形态。'
  const previewPath = raw
    ? 'mcp.yaml · Server 定义'
    : defaultView
      ? 'mcp.yaml · 解析结果'
      : settings!.path
  const previewLabel = raw ? 'RAW' : defaultView ? 'Default' : agentName[agent!]
  const previewStatus = raw
    ? '未解析'
    : defaultView && diagnostics.length > 0
      ? `${diagnostics.length} 个问题`
      : defaultView
        ? '变量已解析'
        : '写入后配置'
  const previewColor = raw || defaultView ? 'var(--primary)' : agentColor[agent!]
  return (
    <section className={styles.previewCard}>
      <div className={styles.previewHead}>
        <div>
          <div className={styles.cardKicker}>{previewKicker}</div>
          <strong>{previewTitle}</strong>
          <p>{previewDescription}</p>
        </div>
      </div>
      <div className={styles.previewPath} style={{ '--c': previewColor } as CSSProperties}>
        <span>{previewLabel}</span>
        <code>{previewPath}</code>
        <em>{previewStatus}</em>
      </div>
      {diagnostics.length > 0 && (
        <div className={styles.previewDiagnostics}>
          {diagnostics.map((item, index) => (
            <span key={item.code + index}>
              {item.code}: {item.message}
            </span>
          ))}
        </div>
      )}
      <pre className={styles.syntaxPreview}>
        <code>{renderSettingsPreviewSyntax(text, settings?.language ?? 'json')}</code>
      </pre>
    </section>
  )
}

function McpDetail({
  repoPath,
  server,
  configView,
  matrix,
  agents,
  onConfigView,
  onEdit,
  onCopy,
  onInspect,
  onClose,
}: {
  repoPath: string
  server: McpServer
  configView: McpConfigView
  matrix: VarsMatrixResponse | undefined
  agents: AgentId[]
  onConfigView: (view: McpConfigView) => void
  onEdit: () => void
  onCopy: () => void
  onInspect: (key: string) => void
  onClose: () => void
}) {
  const [detailTab, setDetailTab] = useState<McpDetailTab>('config')
  const previewAgent = isAgentConfigView(configView) ? configView : null
  const debugAgent: McpDebugPreviewAgent = configView === 'raw' ? 'default' : configView
  const resolved = buildResolvedMcpServer(server, previewAgent ?? 'default', matrix).server
  const displayed = configView === 'raw' ? server : resolved
  const displayValue = (value: string) =>
    configView === 'raw' ? renderValueWithTokens(value, onInspect) : value
  const envEntries = Object.entries(displayed.env ?? {})
  const headerEntries = Object.entries(displayed.headers ?? {})
  const connectionRows =
    displayed.type === 'stdio'
      ? [
          { label: 'Command', value: <code>{displayValue(displayed.command ?? '')}</code> },
          {
            label: 'Arguments',
            value: (
              <span className={styles.detailArguments}>
                {(displayed.args ?? []).map((arg, index) => (
                  <code key={index}>{displayValue(arg)}</code>
                ))}
              </span>
            ),
          },
        ]
      : [{ label: 'URL', value: <code>{displayValue(displayed.url ?? '')}</code> }]

  useEffect(() => {
    if (detailTab === 'debug' && configView === 'raw') onConfigView('default')
  }, [configView, detailTab, onConfigView])

  return (
    <div className={styles.drawerContent}>
      <header className={styles.paneHeader}>
        <IconButton
          label="返回 Server 列表"
          tooltip="返回"
          className={styles.backButton}
          onClick={onClose}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <div>
          <h2>{server.id}</h2>
          <p>{server.type === 'stdio' ? 'local process' : `${server.type} endpoint`}</p>
        </div>
        <div className={styles.paneHeaderActions}>
          <TypeBadge type={server.type} />
          <PreviewAgentSwitch value={configView} agents={agents} onChange={onConfigView} />
          <IconButton label="Copy server JSON" tooltip="复制" onClick={onCopy}>
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="编辑当前 MCP server" tooltip="编辑" onClick={onEdit}>
            <Edit3 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </header>
      <div
        className={`${styles.drawerBody} ${detailTab === 'debug' ? styles.drawerBodyTools : ''}`}
      >
        <DrawerSectionTabs
          value={detailTab}
          onChange={(next) => {
            if (next === 'debug' && configView === 'raw') onConfigView('default')
            setDetailTab(next)
          }}
        />
        {detailTab === 'config' ? (
          <>
            <section className={styles.detailSection}>
              <header>
                <h3>配置定义</h3>
                <p>连接、环境变量和 headers 按用途分组展示。</p>
              </header>
              <div className={styles.definitionGroups}>
                <DetailDefinitionGroup
                  tone="connection"
                  icon={
                    server.type === 'stdio' ? (
                      <Command className="h-4 w-4" />
                    ) : (
                      <Cloud className="h-4 w-4" />
                    )
                  }
                  title="连接"
                  meta={server.type === 'stdio' ? 'local process' : `${server.type} endpoint`}
                  rows={connectionRows}
                />
                <DetailDefinitionGroup
                  tone="env"
                  icon={<Variable className="h-4 w-4" />}
                  title="Environment"
                  meta={`${envEntries.length} variables`}
                  rows={envEntries.map(([key, value]) => ({
                    label: key,
                    value: <code>{displayValue(value)}</code>,
                  }))}
                />
                {server.type !== 'stdio' && (
                  <DetailDefinitionGroup
                    tone="headers"
                    icon={<KeyRound className="h-4 w-4" />}
                    title="Headers"
                    meta={`${headerEntries.length} headers`}
                    rows={headerEntries.map(([key, value]) => ({
                      label: key,
                      value: <code>{displayValue(value)}</code>,
                    }))}
                  />
                )}
              </div>
            </section>
            <ServerPreview
              server={server}
              configView={configView}
              agent={previewAgent}
              matrix={matrix}
            />
          </>
        ) : (
          <McpDebugPanel repoPath={repoPath} server={server} previewAgent={debugAgent} />
        )}
      </div>
    </div>
  )
}

function McpEditor({
  repoPath,
  mode,
  initial,
  configView,
  matrix,
  varsKeys,
  agents,
  busy,
  error,
  onConfigView,
  onCancel,
  onSubmit,
  onDirtyChange,
}: {
  repoPath: string
  mode: Exclude<EditorMode, null>
  initial?: McpServer
  configView: McpConfigView
  matrix: VarsMatrixResponse | undefined
  varsKeys: string[]
  agents: AgentId[]
  busy: boolean
  error: string | null
  onConfigView: (view: McpConfigView) => void
  onCancel: () => void
  onSubmit: (form: McpServerFormState) => Promise<McpServer | null>
  onDirtyChange: (dirty: boolean) => void
}) {
  const [form, setForm] = useState<McpServerFormState>(() => serverToForm(initial))
  const [section, setSection] = useState<McpDetailTab>('config')
  const [editorView, setEditorView] = useState<EditorViewMode>('visual')
  const [sourceText, setSourceText] = useState(() => formToSource(serverToForm(initial)))
  const [savedSource, setSavedSource] = useState(() => formToSource(serverToForm(initial)))
  const [savedFormSignature, setSavedFormSignature] = useState(() =>
    stableStringify(serverToForm(initial)),
  )
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [envMode, setEnvMode] = useState<RecordEditMode>('pairs')
  const [headersMode, setHeadersMode] = useState<RecordEditMode>('pairs')
  const [envRows, setEnvRows] = useState<RecordRow[]>(() => rowsFromRecord(initial?.env))
  const [headersRows, setHeadersRows] = useState<RecordRow[]>(() =>
    rowsFromRecord(initial?.headers),
  )
  const varsKeysRef = useRef(varsKeys)
  const previousModeRef = useRef(mode)
  const promotedServerIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (section === 'debug' && configView === 'raw') onConfigView('default')
  }, [configView, onConfigView, section])

  useEffect(() => {
    varsKeysRef.current = varsKeys
  }, [varsKeys])

  const onSourceEditorMount = useCallback(
    (_editor: unknown, monaco: Parameters<typeof registerVarsCompletionProvider>[0]) =>
      registerVarsCompletionProvider(monaco, 'json', () => varsKeysRef.current),
    [],
  )

  useEffect(() => {
    const promotedFromCreate = previousModeRef.current === 'create' && mode === 'edit'
    previousModeRef.current = mode
    if (promotedFromCreate) {
      promotedServerIdRef.current = form.id
      const persistedForm = initial ? serverToForm(initial) : form
      const persistedSource = formToSource(persistedForm)
      setForm(persistedForm)
      setSourceText(persistedSource)
      setSavedSource(persistedSource)
      setSavedFormSignature(stableStringify(persistedForm))
      return
    }
    if (promotedServerIdRef.current && initial?.id === promotedServerIdRef.current) {
      promotedServerIdRef.current = null
      const persistedForm = serverToForm(initial)
      setSavedSource(formToSource(persistedForm))
      setSavedFormSignature(stableStringify(persistedForm))
      return
    }
    const nextForm = mode === 'edit' ? serverToForm(initial) : emptyMcpForm()
    setForm(nextForm)
    setSourceText(formToSource(nextForm))
    setSavedSource(formToSource(nextForm))
    setSavedFormSignature(stableStringify(nextForm))
    setSourceError(null)
    setEditorView('visual')
    setSection('config')
    setEnvMode('pairs')
    setHeadersMode('pairs')
    setEnvRows(rowsFromRecord(mode === 'edit' ? initial?.env : undefined))
    setHeadersRows(rowsFromRecord(mode === 'edit' ? initial?.headers : undefined))
  }, [initial?.id, mode])
  const previewAgent = isAgentConfigView(configView) ? configView : null
  const debugAgent: McpDebugPreviewAgent = configView === 'raw' ? 'default' : configView
  const previewServer = useMemo(() => formToPreviewServer(form, initial?.id), [form, initial?.id])
  const transportLabel =
    form.type === 'stdio' ? 'local process' : form.type === 'sse' ? 'event stream' : 'remote http'
  const setField = <K extends keyof McpServerFormState>(key: K, value: McpServerFormState[K]) => {
    setForm((previous) => {
      const next = { ...previous, [key]: value }
      if (!sourceError) {
        try {
          setSourceText(formToSource(next))
        } catch {
          // Keep the last valid JSON while a visual key/value row is incomplete.
        }
      }
      return next
    })
  }
  const updateSource = (value: string) => {
    setSourceText(value)
    try {
      const next = formFromSource(value, mode === 'edit' ? initial?.id : undefined)
      setForm(next)
      setEnvRows(rowsFromRecord(parseRecordLines(next.env, 'env')))
      setHeadersRows(rowsFromRecord(parseRecordLines(next.headers, 'headers')))
      setSourceError(null)
    } catch (sourceParseError) {
      setSourceError(
        sourceParseError instanceof Error ? sourceParseError.message : 'Server JSON 无法解析',
      )
    }
  }
  const dirty =
    Boolean(sourceError) ||
    sourceText !== savedSource ||
    stableStringify(form) !== savedFormSignature
  const envError = recordValidationError(form.env, 'env')
  const headersError = form.type === 'stdio' ? null : recordValidationError(form.headers, 'headers')
  const recordError = envError ?? headersError
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const persist = async () => {
    if (sourceError || recordError) return null
    const saved = await onSubmit(form)
    if (saved) {
      const persistedForm = serverToForm(saved)
      const persistedSource = formToSource(persistedForm)
      setForm(persistedForm)
      setSourceText(persistedSource)
      setSavedSource(persistedSource)
      setSavedFormSignature(stableStringify(persistedForm))
      setEnvRows(rowsFromRecord(saved.env))
      setHeadersRows(rowsFromRecord(saved.headers))
    }
    return saved
  }
  return (
    <div className={styles.drawerContent}>
      <header className={styles.paneHeader}>
        <IconButton
          label="返回 Server 列表"
          tooltip="返回"
          className={styles.backButton}
          onClick={onCancel}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <div>
          <h2>{mode === 'edit' ? '编辑 MCP server' : '新增 MCP server'}</h2>
          <p>{transportLabel}</p>
        </div>
        <div className={styles.paneHeaderActions}>
          <TypeBadge type={form.type} />
          <PreviewAgentSwitch value={configView} agents={agents} onChange={onConfigView} />
        </div>
      </header>
      <div className={`${styles.drawerBody} ${section === 'debug' ? styles.drawerBodyTools : ''}`}>
        <DrawerSectionTabs
          value={section}
          onChange={(next) => {
            if (next === 'debug' && configView === 'raw') onConfigView('default')
            setSection(next)
          }}
        />
        {error && <FieldError id="mcp-server-form-error">{error}</FieldError>}
        {section === 'config' ? (
          <>
            <div className={styles.editorModeBar}>
              <div className={styles.editorModeSwitch} role="tablist" aria-label="Server 编辑方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={editorView === 'visual'}
                  onClick={() => setEditorView('visual')}
                >
                  <LayoutList className="h-3.5 w-3.5" />
                  可视化
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editorView === 'json'}
                  onClick={() => setEditorView('json')}
                >
                  <FileJson2 className="h-3.5 w-3.5" />
                  JSON
                </button>
              </div>
            </div>
            {editorView === 'json' ? (
              <section className={styles.sourceEditorSection}>
                <div className={styles.sourceEditorHead}>
                  <div>
                    <span className={styles.eyebrow}>SERVER SOURCE</span>
                    <strong>完整 Server JSON</strong>
                  </div>
                  <span data-valid={!sourceError}>{sourceError ? '需要修复' : 'JSON 有效'}</span>
                </div>
                <div className={styles.sourceEditorShell} data-invalid={Boolean(sourceError)}>
                  <MonacoTextEditor
                    ariaLabel="完整 Server JSON"
                    ariaDescribedBy={sourceError ? 'mcp-server-source-error' : undefined}
                    language="json"
                    height="430px"
                    value={sourceText}
                    onChange={updateSource}
                    onEditorMount={onSourceEditorMount}
                    options={{
                      fontSize: 14,
                      lineHeight: 22,
                      padding: { top: 14, bottom: 14 },
                      wordWrap: 'on',
                    }}
                  />
                </div>
                {sourceError && (
                  <div className={styles.sourceError} id="mcp-server-source-error">
                    <CircleAlert className="h-4 w-4" />
                    <span>{sourceError}</span>
                  </div>
                )}
              </section>
            ) : (
              <div className={styles.visualEditor} data-readonly={Boolean(sourceError)}>
                <fieldset disabled={Boolean(sourceError)}>
                  <section className={styles.formGroup}>
                    <header>
                      <h3>基本信息</h3>
                      <p>用于在列表和 agent 配置中识别这个 server。</p>
                    </header>
                    <div className={styles.formFields}>
                      <label className={styles.field}>
                        <span>Server ID</span>
                        <div className={styles.fieldInput}>
                          <Server className="h-3.5 w-3.5" />
                          <input
                            aria-label="server id"
                            value={form.id}
                            disabled={mode === 'edit'}
                            onChange={(event) => setField('id', event.target.value)}
                            placeholder="browser-tools"
                          />
                        </div>
                        {mode === 'edit' ? (
                          <small className={styles.readOnlyHint}>
                            <LockKeyhole className="h-3.5 w-3.5" />
                            ID 已锁定，保存后不可修改
                          </small>
                        ) : (
                          <small>小写字母、数字与连字符。</small>
                        )}
                      </label>
                    </div>
                  </section>

                  <section className={styles.formGroup}>
                    <header>
                      <h3>连接</h3>
                      <p>选择 transport 并填写连接信息。</p>
                    </header>
                    <div className={styles.formFields}>
                      <div
                        className={styles.transportTabs}
                        role="radiogroup"
                        aria-label="Transport"
                      >
                        {MCP_TYPES.map((type) => (
                          <button
                            key={type}
                            type="button"
                            role="radio"
                            aria-checked={form.type === type}
                            data-active={form.type === type}
                            data-transport={type}
                            aria-pressed={form.type === type}
                            onClick={() => setField('type', type)}
                          >
                            {type === 'stdio' ? (
                              <Command className="h-3.5 w-3.5" />
                            ) : type === 'sse' ? (
                              <Cloud className="h-3.5 w-3.5" />
                            ) : (
                              <Braces className="h-3.5 w-3.5" />
                            )}
                            {type}
                          </button>
                        ))}
                      </div>
                      <div className={styles.connectionFields}>
                        {form.type === 'stdio' ? (
                          <>
                            <label className={styles.field}>
                              <span>Command</span>
                              <div className={styles.fieldInput}>
                                <Command className="h-3.5 w-3.5" />
                                <input
                                  aria-label="command"
                                  value={form.command}
                                  onChange={(event) => setField('command', event.target.value)}
                                  placeholder="npx"
                                />
                              </div>
                            </label>
                            <ArgumentsEditor
                              args={form.args}
                              onChange={(args) => setField('args', args)}
                            />
                          </>
                        ) : (
                          <label className={styles.field}>
                            <span>Endpoint URL</span>
                            <div className={styles.fieldInput}>
                              <Cloud className="h-3.5 w-3.5" />
                              <input
                                aria-label="url"
                                value={form.url}
                                onChange={(event) => setField('url', event.target.value)}
                                placeholder="https://mcp.example.com/api"
                              />
                            </div>
                          </label>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className={styles.formGroup}>
                    <header>
                      <h3>Environment</h3>
                      <p>运行时环境变量。</p>
                    </header>
                    <div className={styles.formFields}>
                      <RecordField
                        name="env"
                        mode={envMode}
                        value={form.env}
                        rows={envRows}
                        setMode={setEnvMode}
                        onTextChange={(value) => setField('env', value)}
                        onRowsChange={setEnvRows}
                        error={envError}
                        varsKeys={varsKeys}
                      />
                    </div>
                  </section>
                  {form.type !== 'stdio' && (
                    <section className={styles.formGroup}>
                      <header>
                        <h3>Headers</h3>
                        <p>远程认证与请求 headers。</p>
                      </header>
                      <div className={styles.formFields}>
                        <RecordField
                          name="headers"
                          mode={headersMode}
                          value={form.headers}
                          rows={headersRows}
                          setMode={setHeadersMode}
                          onTextChange={(value) => setField('headers', value)}
                          onRowsChange={setHeadersRows}
                          error={headersError}
                          varsKeys={varsKeys}
                        />
                      </div>
                    </section>
                  )}
                </fieldset>
              </div>
            )}

            <ServerPreview
              server={previewServer}
              configView={configView}
              agent={previewAgent}
              matrix={matrix}
            />
          </>
        ) : (
          <McpDebugPanel
            repoPath={repoPath}
            server={previewServer}
            previewAgent={debugAgent}
            needsSave
            onPersist={persist}
            disabledReason={
              sourceError
                ? '修复 Server JSON 后才能保存并连接。'
                : recordError
                  ? recordError
                  : undefined
            }
          />
        )}
      </div>
      <footer className={styles.editorFooter}>
        <div>
          <strong>{busy ? '正在保存' : 'Server 定义'}</strong>
        </div>
        <div className={styles.editorActions}>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-label="保存"
            onClick={() => void persist()}
            disabled={busy || Boolean(sourceError) || Boolean(recordError)}
          >
            <Check className="h-3.5 w-3.5" />
            {busy ? '保存中…' : mode === 'create' ? '创建' : '保存'}
          </Button>
        </div>
      </footer>
    </div>
  )
}

function GlobalAgentsBar({
  servers,
  visibleAgents,
  operations,
  search,
  onSearchChange,
}: {
  servers: McpServer[]
  visibleAgents: AgentId[]
  operations: ReturnType<typeof useManifestOperations>
  search: string
  onSearchChange: (value: string) => void
}) {
  if (servers.length === 0) return null
  return (
    <section
      className={styles.globalAgents}
      role="region"
      aria-label={visibleAgents.length > 0 ? '全局 MCP agents' : 'MCP server search'}
    >
      <label className={styles.search}>
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索 MCP server"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索 server"
        />
      </label>
      {visibleAgents.length > 0 && (
        <div className={styles.globalAgentsControls}>
          <span className={styles.globalAgentsLabel}>批量应用</span>
          <div className="agent-chips" role="group" aria-label="批量设置全部 Server agents">
            {visibleAgents.map((agent) => {
              const count = servers.filter((server) => (server.agents ?? []).includes(agent)).length
              const state = count === 0 ? 'off' : count === servers.length ? 'on' : 'mixed'
              const status =
                state === 'on' ? '全部已应用' : state === 'mixed' ? '部分已应用' : '全部未应用'
              return (
                <AgentChip
                  key={agent}
                  agent={agent}
                  state={state}
                  label={`全部 MCP servers 应用到 ${agentName[agent]}：${status}`}
                  tooltip={`${agentName[agent]}：${status}，点击批量切换`}
                  onClick={() => void operations.setAllMcpAgents(servers, agent)}
                  disabled={operations.pending.mcp.allAgents(agent)}
                  stopPropagation
                />
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

export default function Mcp({ repoPath }: { repoPath: string }) {
  const { error, setError } = useViewError({
    title: 'MCP Server 加载失败',
    message: '请检查项目配置后重试',
  })
  const { manifest } = useManifest(repoPath, { onError: setError, onSuccess: () => setError(null) })
  const visibleAgents = useMemo(
    () => applicableAgents(manifest?.config?.agents, 'mcp'),
    [manifest?.config?.agents],
  )
  const { showToast, showErrorToast } = useToast()
  const operations = useManifestOperations(repoPath, {
    onError: (message) =>
      showErrorToast(new Error(message), {
        title: 'MCP 操作失败',
        message: '请检查配置后重试',
      }),
    onToast: showToast,
  })
  const { matrices } = useMcpPreviewVars(repoPath, visibleAgents, Boolean(manifest))
  const initialDrawer = useMemo(drawerLocation, [])
  const [selected, setSelected] = useState<string | null>(initialDrawer.selected)
  const [search, setSearch] = useState('')
  const [configView, setConfigView] = useState<McpConfigView>('raw')
  const [editorMode, setEditorMode] = useState<EditorMode>(initialDrawer.editorMode)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [dirtyCloseOpen, setDirtyCloseOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null)
  const [inspectedVar, setInspectedVar] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [serverOrder, setServerOrder] = useState<string[]>([])
  const [createdServer, setCreatedServer] = useState<McpServer | null>(null)
  const [drawerEntered, setDrawerEntered] = useState(false)
  const pendingHistoryCloseRef = useRef(false)
  const historyNavigationRef = useRef<'restore-editor' | 'confirm-close' | null>(null)

  const manifestServers = manifest?.mcp ?? []
  const orderedServerIds = normalizeOrder(
    serverOrder,
    manifestServers.map((server) => server.id),
  )
  const serversById = new Map(manifestServers.map((server) => [server.id, server]))
  const servers = orderedServerIds.map((id) => serversById.get(id)!).filter(Boolean)
  const selectedServer =
    servers.find((server) => server.id === selected) ??
    (createdServer?.id === selected ? createdServer : undefined)
  const drawerActive = Boolean(editorMode || selectedServer)
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
    const syncFromHistory = () => {
      if (historyNavigationRef.current === 'restore-editor') {
        historyNavigationRef.current = null
        return
      }
      if (historyNavigationRef.current === 'confirm-close') {
        historyNavigationRef.current = null
        const next = drawerLocation()
        setSelected(next.selected)
        setEditorMode(next.editorMode)
        return
      }
      if (editorMode && editorDirty) {
        pendingHistoryCloseRef.current = true
        setDirtyCloseOpen(true)
        historyNavigationRef.current = 'restore-editor'
        window.history.forward()
        return
      }
      const next = drawerLocation()
      setSelected(next.selected)
      setEditorMode(next.editorMode)
    }
    window.addEventListener('popstate', syncFromHistory)
    return () => window.removeEventListener('popstate', syncFromHistory)
  }, [editorDirty, editorMode, selected])

  useEffect(() => {
    if (!manifest || !selected || servers.some((server) => server.id === selected)) return
    if (createdServer?.id === selected) return
    setSelected(null)
    setEditorMode(null)
    writeDrawerLocation(null)
  }, [createdServer?.id, manifest, selected, servers])

  useEffect(() => {
    if (createdServer && servers.some((server) => server.id === createdServer.id))
      setCreatedServer(null)
  }, [createdServer, servers])

  useEffect(() => {
    if (!drawerActive) {
      setDrawerEntered(false)
      return
    }
    const frame = window.requestAnimationFrame(() => setDrawerEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [drawerActive])

  const openDrawer = (view: 'detail' | 'edit' | 'create', server?: string) => {
    setSelected(server ?? null)
    setEditorMode(view === 'detail' ? null : view)
    writeDrawerLocation(view, server)
  }
  const changeConfigView = (view: McpConfigView) => {
    setConfigView(view)
  }

  useEffect(() => {
    if (isAgentConfigView(configView) && !visibleAgents.includes(configView))
      setConfigView('default')
  }, [configView, visibleAgents])
  const closeDrawer = () => {
    setDrawerEntered(false)
    setSelected(null)
    setEditorMode(null)
    setEditorError(null)
    writeDrawerLocation(null)
  }
  const requestCloseDrawer = () => {
    if (editorMode && editorDirty) {
      pendingHistoryCloseRef.current = false
      setDirtyCloseOpen(true)
      return
    }
    closeDrawer()
  }

  const filteredServers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return servers.filter(
      (server) =>
        !term ||
        (server.id + ' ' + server.type + ' ' + serverSubtitle(server)).toLowerCase().includes(term),
    )
  }, [search, servers])
  const submitServer = async (form: McpServerFormState): Promise<McpServer | null> => {
    setEditorBusy(true)
    setEditorError(null)
    try {
      if (editorMode === 'edit') {
        if (!selectedServer) return null
        const server = buildServerFromForm(form, {
          idOverride: selectedServer.id,
          preserveAgents: (selectedServer.agents ?? []) as AgentId[],
        })
        const result = await operations.updateMcpServer(selectedServer.id, server)
        if (result.ok) return server
        setEditorError(result.message || '保存 MCP Server 失败')
      } else {
        const server = buildServerFromForm(form)
        const result = await operations.addMcpServer(server)
        if (result.ok) {
          setCreatedServer(server)
          setSelected(server.id)
          setEditorMode('edit')
          writeDrawerLocation('edit', server.id)
          return server
        }
        setEditorError(result.message || '添加 MCP Server 失败')
      }
    } catch (err) {
      console.error({ err }, 'Failed to submit MCP server')
      setEditorError(normalizeManifestOperationError(err, '保存 MCP Server 失败'))
    } finally {
      setEditorBusy(false)
    }
    return null
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
      <header className={styles.pageHeading}>
        <div>
          <span className={styles.eyebrow}>CONFIGURATION</span>
          <h1>MCP servers</h1>
          <p>管理仓库中的 Server 定义与 Agent 投影。</p>
        </div>
        <div className={styles.pageActions}>
          <Button
            variant="primary"
            onClick={() => {
              setEditorError(null)
              openDrawer('create')
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add server
          </Button>
          <Button
            variant="secondary"
            onClick={() => void operations.project('mcp')}
            disabled={operations.pending.project('mcp')}
          >
            {operations.pending.project('mcp') ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Project changes
          </Button>
        </div>
      </header>
      <section className={styles.workbench} role="region" aria-label="MCP workbench">
        <aside className={styles.inventory} aria-label="MCP inventory">
          <div className={styles.inventoryHeader}>
            <div className={styles.inventoryHeading}>
              <div className={styles.inventoryTitle}>
                <h2>所有 Servers</h2>
                <span className={styles.serverCount}>{servers.length} 个</span>
              </div>
              <div
                className={styles.inventoryActions}
                role="toolbar"
                aria-label="MCP inventory actions"
              >
                <IconButton
                  label="新增 MCP server"
                  tooltip="新增"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setEditorError(null)
                    openDrawer('create')
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label="Import MCP"
                  tooltip="Import"
                  variant="secondary"
                  size="sm"
                  onClick={() => setImportOpen(true)}
                  disabled={operations.pending.mcp.importScan || operations.pending.mcp.importApply}
                >
                  <Download className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            </div>
            <GlobalAgentsBar
              servers={servers}
              visibleAgents={visibleAgents}
              operations={operations}
              search={search}
              onSearchChange={setSearch}
            />
          </div>
          <div className={styles.serverList}>
            <div className={styles.listColumns} aria-hidden="true">
              <span>Server</span>
              <span>Agents</span>
              <span>操作</span>
            </div>
            <SortableList
              items={filteredServers}
              label={(server) => server.id}
              activator="child"
              disabled={search.trim().length > 0}
              className={styles.serverSortableList}
              onReorder={reorderServers}
            >
              {(server, sortable) => {
                const activeAgents = server.agents ?? []
                const sortingDisabled = search.trim().length > 0
                return (
                  <article
                    role="button"
                    tabIndex={0}
                    aria-label={'选择 ' + server.id}
                    className={styles.serverRow}
                    data-selected={selected === server.id}
                    data-dragging={sortable.dragging || undefined}
                    data-overlay={sortable.overlay || undefined}
                    onClick={() => {
                      openDrawer('detail', server.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      openDrawer('detail', server.id)
                    }}
                  >
                    <span className={styles.serverMain} aria-label={'选择 ' + server.id}>
                      <button
                        type="button"
                        className={styles.dragHandle}
                        title={sortingDisabled ? '清除搜索后可排序' : '拖拽调整顺序'}
                        aria-disabled={sortingDisabled}
                        onClick={(event) => event.stopPropagation()}
                        {...sortable.activatorProps}
                      >
                        <GripVertical className="h-4 w-4" />
                      </button>
                      <span className={styles.serverCopy}>
                        <span className={styles.serverTitle}>
                          <i className={styles.transportDot} data-transport={server.type} />
                          <strong>{server.id}</strong>
                          <TypeBadge type={server.type} />
                        </span>
                        <small>{serverSubtitle(server)}</small>
                      </span>
                    </span>
                    <div className={styles.serverFoot}>
                      <div className={styles.agents}>
                        {visibleAgents.map((agent) => (
                          <AgentChip
                            key={agent}
                            agent={agent}
                            state={activeAgents.includes(agent) ? 'on' : 'off'}
                            label={server.id + ' 应用到 ' + agentName[agent]}
                            tooltip={server.id + ' 应用到 ' + agentName[agent]}
                            onClick={() =>
                              void operations.toggleMcpAgent(
                                { ...server, agents: server.agents ?? [] },
                                agent,
                              )
                            }
                            stopPropagation
                          />
                        ))}
                      </div>
                      <span className={styles.rowActions} aria-label={server.id + ' actions'}>
                        <IconButton
                          label={'编辑 ' + server.id}
                          tooltip="编辑"
                          onClick={(event) => {
                            event.stopPropagation()
                            setEditorError(null)
                            openDrawer('edit', server.id)
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
          sources={visibleAgents}
          operations={operations}
          onClose={() => setImportOpen(false)}
        />
      </section>
      {drawerActive && (
        <div
          className={styles.drawerLayer}
          data-view={editorMode ?? 'detail'}
          data-open={drawerEntered ? 'true' : undefined}
        >
          <button
            className={styles.drawerScrim}
            aria-label="关闭 Server 面板"
            onClick={requestCloseDrawer}
          />
          <aside
            className={styles.contentPane}
            aria-label={
              editorMode === 'create'
                ? '新增 Server'
                : editorMode === 'edit'
                  ? '编辑 Server'
                  : 'Server 详情'
            }
          >
            {editorMode ? (
              <McpEditor
                repoPath={repoPath}
                mode={editorMode}
                initial={editorMode === 'edit' ? selectedServer : undefined}
                configView={configView}
                matrix={matrices[configView === 'raw' ? 'default' : configView]}
                agents={visibleAgents}
                varsKeys={mcpVarsKeys}
                busy={editorBusy}
                error={editorError}
                onConfigView={changeConfigView}
                onCancel={requestCloseDrawer}
                onSubmit={submitServer}
                onDirtyChange={setEditorDirty}
              />
            ) : selectedServer ? (
              <McpDetail
                repoPath={repoPath}
                server={selectedServer}
                configView={configView}
                matrix={matrices[configView === 'raw' ? 'default' : configView]}
                agents={visibleAgents}
                onConfigView={changeConfigView}
                onEdit={() => {
                  setEditorError(null)
                  openDrawer('edit', selectedServer.id)
                }}
                onCopy={copySelected}
                onInspect={setInspectedVar}
                onClose={requestCloseDrawer}
              />
            ) : null}
          </aside>
        </div>
      )}
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
      {dirtyCloseOpen && (
        <div
          className={styles.variableOverlay}
          role="presentation"
          onMouseDown={() => setDirtyCloseOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="放弃未保存的更改"
            className={styles.confirmPanel}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3>放弃未保存的更改？</h3>
            <p>关闭后，本次对 Server 定义的修改不会保存。</p>
            <div>
              <Button variant="ghost" onClick={() => setDirtyCloseOpen(false)}>
                继续编辑
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setDirtyCloseOpen(false)
                  if (pendingHistoryCloseRef.current) {
                    pendingHistoryCloseRef.current = false
                    historyNavigationRef.current = 'confirm-close'
                    window.history.back()
                    return
                  }
                  closeDrawer()
                }}
              >
                放弃更改
              </Button>
            </div>
          </section>
        </div>
      )}
      <McpVariableInspector
        variableKey={inspectedVar}
        matrix={matrices[configView === 'raw' ? 'default' : configView]}
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
