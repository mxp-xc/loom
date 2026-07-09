import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { McpServer, McpType } from '@loom/core'
import { Check, Copy, Edit3, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import MonacoTextEditor from '@/components/monaco/MonacoTextEditor'
import { registerVarsCompletionProvider } from '@/components/monaco/varsCompletion'
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
    .map(([key, value]) => key + '=' + (value ?? ''))
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

function TargetChip({
  agent,
  active,
  label,
  onClick,
  disabled,
  count,
}: {
  agent: AgentId
  active: boolean | 'mixed'
  label: string
  onClick: () => void
  disabled?: boolean
  count?: number
}) {
  const state = active === 'mixed' ? 'mixed' : active ? 'on' : 'off'
  return (
    <button
      type="button"
      className="target-chip"
      style={{ '--c': agentColor[agent] } as CSSProperties}
      data-state={state}
      data-tooltip={label}
      aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      disabled={disabled}
    >
      {agentShort[agent]}
      {count !== undefined && <span className="target-chip-count">{count}</span>}
    </button>
  )
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
  varsKeys,
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
  const settings = buildMcpSettingsPreview(
    formToDraftServer(form, initial?.id),
    previewTarget,
    matrix,
  )
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
      {error && <div className={styles.formError}>{error}</div>}
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
          <pre>{settings.text}</pre>
        </section>
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
      <div>
        <div className={styles.cardKicker}>SETTINGS.JSON TARGETS</div>
        <strong>批量设置 · 应用于全部 MCP servers</strong>
      </div>
      <div className="target-chips">
        {visibleAgents.map((agent) => {
          const count = servers.filter((server) => (server.targets ?? []).includes(agent)).length
          const state = count === 0 ? 'off' : count === servers.length ? 'on' : 'mixed'
          return (
            <TargetChip
              key={agent}
              agent={agent}
              active={state === 'mixed' ? 'mixed' : state === 'on'}
              label={'全部 MCP servers 应用到 ' + agentShort[agent]}
              count={count}
              onClick={() => void operations.setAllMcpTargets(servers, agent)}
              disabled={operations.pending.mcp.allTargets(agent)}
            />
          )
        })}
      </div>
    </section>
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
  const [filter, setFilter] = useState<McpFilter>('all')
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
  const remoteCount = servers.filter((server) => server.type !== 'stdio').length
  const fullyProjected = servers.filter(
    (server) =>
      visibleAgents.length > 0 &&
      visibleAgents.every((agent) => (server.targets ?? []).includes(agent)),
  ).length
  const targetLinks = servers.reduce((sum, server) => sum + (server.targets ?? []).length, 0)

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
          <p>管理本地 stdio 与远程 SSE/HTTP server，并把它们清晰投影到各个 agent。</p>
        </div>
        <div className={styles.heroMeta}>
          <span>
            <b>{servers.length}</b>
            servers
            <small>{remoteCount} remote</small>
          </span>
          <span>
            <b>{fullyProjected}</b>
            fully projected
            <small>all targets enabled</small>
          </span>
          <span>
            <b>{targetLinks}</b>
            target links
            <small>agent projections</small>
          </span>
          {error && <b>{error}</b>}
        </div>
      </section>
      <GlobalTargetsBar servers={servers} visibleAgents={visibleAgents} operations={operations} />
      <section className={styles.workbench} role="region" aria-label="MCP workbench">
        <aside className={styles.inventory}>
          <div className={styles.inventoryTop}>
            <div>
              <div className={styles.kicker}>INVENTORY</div>
              <h2>{servers.length} configured</h2>
            </div>
            <div className={styles.inventoryActions}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                aria-label="Add server"
                className={styles.inventoryActionPrimary}
                onClick={() => {
                  setEditorError(null)
                  setEditorMode('create')
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add server</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label="Project changes"
                className={styles.inventoryActionProject}
                onClick={() => void operations.project('mcp')}
                disabled={operations.pending.project('mcp')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>投影</span>
              </Button>
            </div>
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
            {filteredServers.map((server) => {
              const activeTargets = server.targets ?? []
              const projectionState = serverProjectionState(server, visibleAgents)
              return (
                <article
                  key={server.id}
                  role="button"
                  tabIndex={0}
                  aria-label={'选择 ' + server.id}
                  className={styles.serverCard}
                  data-selected={selected === server.id}
                  onClick={() => {
                    setSelected(server.id)
                    setEditorMode(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelected(server.id)
                      setEditorMode(null)
                    }
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
              varsKeys={mcpVarsKeys}
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
