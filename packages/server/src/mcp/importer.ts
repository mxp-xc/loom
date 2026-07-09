import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { parse as parseToml } from 'smol-toml'
import type { AgentId, McpServer, McpType } from '@loom/core'
import { agentMcpFile } from '../adapters/paths.js'
import type { IFileSystem } from '../ports/fs.js'

const AGENTS: AgentId[] = ['claude-code', 'codex', 'opencode']
const SOURCE_SUFFIX: Record<AgentId, string> = {
  'claude-code': 'cc',
  codex: 'cx',
  opencode: 'oc',
}
const SUPPORTED_TYPES = new Set<McpType>(['stdio', 'sse', 'http'])

export type McpImportSourceStatus = 'ready' | 'missing_file' | 'parse_failed'
export type McpImportItemStatus = 'ready' | 'renamed' | 'disabled' | 'unchanged'

export interface McpImportDiagnostic {
  code: string
  message: string
  field?: string
}

export interface McpImportSourceResult {
  agent: AgentId
  path: string
  status: McpImportSourceStatus
  diagnostics: McpImportDiagnostic[]
}

export interface McpImportItem {
  key: string
  id: string
  finalId: string
  server?: McpServer
  sourceAgents: AgentId[]
  targets: AgentId[]
  status: McpImportItemStatus
  selectedByDefault: boolean
  ignoredFields: string[]
  renameReason?: 'source_conflict' | 'existing_conflict' | 'suffix_conflict'
  diagnostics: McpImportDiagnostic[]
}

export interface McpImportScanResult {
  ok: true
  items: McpImportItem[]
  sources: McpImportSourceResult[]
  existing: { count: number }
}

export type McpImportApplyResult =
  | {
      ok: true
      imported: number
      renamed: number
      ignoredFields: number
      entries: McpServer[]
    }
  | { ok: false; error: 'stale_import_preview'; message: string }

export interface McpImportLogger {
  error?: (obj: unknown, msg: string) => void
  warn?: (obj: unknown, msg: string) => void
}

export interface ScanMcpImportsInput {
  fs: IFileSystem
  repoPath: string
  sources?: AgentId[]
  logger?: McpImportLogger
}

export interface ApplyMcpImportsInput extends ScanMcpImportsInput {
  keys: string[]
}

interface EnabledSourceEntry {
  id: string
  agent: AgentId
  server: McpServer
  ignoredFields: string[]
  diagnostics: McpImportDiagnostic[]
}

interface DisabledSourceEntry {
  id: string
  agent: AgentId
  ignoredFields: string[]
  diagnostics: McpImportDiagnostic[]
}

interface SourceEntries {
  source: McpImportSourceResult
  enabled: EnabledSourceEntry[]
  disabled: DisabledSourceEntry[]
}

interface ImportGroup {
  id: string
  server: McpServer
  sourceAgents: AgentId[]
  ignoredFields: string[]
  diagnostics: McpImportDiagnostic[]
}

export async function scanMcpImports(input: ScanMcpImportsInput): Promise<McpImportScanResult> {
  const sources = normalizeSources(input.sources)
  const existing = await readMcpYaml(input.fs, input.repoPath)
  const sourceEntries = await Promise.all(
    sources.map((agent) => readSourceEntries(input.fs, agent, input.logger)),
  )
  const groups = groupEnabledEntries(sourceEntries.flatMap((entry) => entry.enabled))
  const disabled = sourceEntries.flatMap((entry) => entry.disabled).map(disabledItem)
  const planned = planGroups(existing, groups)
  return {
    ok: true,
    items: [...planned, ...disabled],
    sources: sourceEntries.map((entry) => entry.source),
    existing: { count: existing.length },
  }
}

export async function applyMcpImports(input: ApplyMcpImportsInput): Promise<McpImportApplyResult> {
  const selectedKeys = new Set(input.keys)
  const scan = await scanMcpImports(input)
  const selected = scan.items.filter((item) => selectedKeys.has(item.key))
  if (
    selected.length !== selectedKeys.size ||
    selected.some((item) => item.status === 'disabled')
  ) {
    return stalePreview()
  }

  const entries = await readMcpYaml(input.fs, input.repoPath)
  let changed = false
  let imported = 0
  let renamed = 0
  let ignoredFields = 0

  for (const item of selected) {
    if (!item.server || item.status === 'unchanged') continue
    const idx = entries.findIndex((entry) => entry.id === item.finalId)
    if (idx >= 0) {
      if (!sameDefinition(entries[idx], item.server)) return stalePreview()
      const nextTargets = mergeTargets(entries[idx].targets ?? [], item.targets)
      if (!sameTargets(entries[idx].targets ?? [], nextTargets)) {
        entries[idx] = { ...entries[idx], targets: nextTargets }
        changed = true
      }
    } else {
      entries.push({ ...item.server, id: item.finalId, targets: item.targets })
      changed = true
    }
    imported++
    if (item.status === 'renamed') renamed++
    ignoredFields += item.ignoredFields.length
  }

  if (changed) {
    await input.fs.mkdir(dirname(mcpYamlPath(input.repoPath)), true)
    await input.fs.writeFile(mcpYamlPath(input.repoPath), yaml.dump(entries) + '\n')
  }

  return { ok: true, imported, renamed, ignoredFields, entries }
}

function normalizeSources(sources: AgentId[] | undefined): AgentId[] {
  if (!sources?.length) return AGENTS
  return AGENTS.filter((agent) => sources.includes(agent))
}

async function readSourceEntries(
  fs: IFileSystem,
  agent: AgentId,
  logger?: McpImportLogger,
): Promise<SourceEntries> {
  const path = agentMcpFile(agent)
  if (!(await fs.exists(path))) {
    return {
      source: {
        agent,
        path,
        status: 'missing_file',
        diagnostics: [{ code: 'missing_file', message: 'MCP 配置文件不存在' }],
      },
      enabled: [],
      disabled: [],
    }
  }

  try {
    const raw = await fs.readFile(path)
    const { container, entries } = parseSourceConfig(agent, raw)
    const enabled: EnabledSourceEntry[] = []
    const disabled: DisabledSourceEntry[] = []
    for (const [id, value] of Object.entries(entries)) {
      const normalized = normalizeSourceEntry(container, id, value)
      if (normalized.server) enabled.push({ agent, id, ...normalized, server: normalized.server })
      else disabled.push({ agent, id, ...normalized })
    }
    return {
      source: { agent, path, status: 'ready', diagnostics: [] },
      enabled,
      disabled,
    }
  } catch (err) {
    logger?.error?.({ err, source: agent }, 'MCP import scan failed')
    return {
      source: {
        agent,
        path,
        status: 'parse_failed',
        diagnostics: [{ code: 'parse_failed', message: 'MCP 配置解析失败' }],
      },
      enabled: [],
      disabled: [],
    }
  }
}

function parseSourceConfig(
  agent: AgentId,
  raw: string,
): { container: string; entries: Record<string, unknown> } {
  if (agent === 'codex') {
    const parsed = parseToml(raw) as Record<string, unknown>
    return { container: 'mcp_servers', entries: asRecord(parsed.mcp_servers) }
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (agent === 'claude-code')
    return { container: 'mcpServers', entries: asRecord(parsed.mcpServers) }
  return { container: 'mcp', entries: asRecord(parsed.mcp) }
}

function normalizeSourceEntry(
  container: string,
  id: string,
  value: unknown,
): {
  server?: McpServer
  ignoredFields: string[]
  diagnostics: McpImportDiagnostic[]
} {
  const raw = asRecord(value)
  const ignoredFields = collectIgnoredFields(container, id, raw)
  const diagnostics: McpImportDiagnostic[] = []
  const rawType = raw.type ?? raw.transport ?? 'stdio'
  const type = typeof rawType === 'string' ? rawType : 'stdio'
  if (!SUPPORTED_TYPES.has(type as McpType)) {
    return {
      ignoredFields,
      diagnostics: [
        {
          code: 'unsupported_transport',
          message: '不支持的 MCP transport: ' + String(rawType),
          field: pathFor(container, id, 'type'),
        },
      ],
    }
  }

  const server: McpServer = { id, type: type as McpType }
  const command = stringField(raw.command, pathFor(container, id, 'command'), ignoredFields)
  const url = stringField(raw.url, pathFor(container, id, 'url'), ignoredFields)
  const args = stringArrayField(raw.args, pathFor(container, id, 'args'), ignoredFields)
  const env = stringRecordField(raw.env, pathFor(container, id, 'env'), ignoredFields)
  const headers = stringRecordField(raw.headers, pathFor(container, id, 'headers'), ignoredFields)

  if (server.type === 'stdio') {
    if (!command) {
      diagnostics.push({
        code: 'missing_command',
        message: 'stdio MCP server 缺少 command',
        field: pathFor(container, id, 'command'),
      })
    } else server.command = command
    if (args?.length) server.args = args
    if (env) server.env = env
  } else {
    if (!url) {
      diagnostics.push({
        code: 'missing_url',
        message: server.type + ' MCP server 缺少 url',
        field: pathFor(container, id, 'url'),
      })
    } else server.url = url
    if (env) server.env = env
    if (headers) server.headers = headers
  }

  if (diagnostics.some((diagnostic) => diagnostic.code.startsWith('missing_'))) {
    return { ignoredFields, diagnostics }
  }
  return { server, ignoredFields, diagnostics }
}

function groupEnabledEntries(entries: EnabledSourceEntry[]): ImportGroup[] {
  const groups: ImportGroup[] = []
  for (const entry of entries.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent))) {
    const existing = groups.find(
      (group) => group.id === entry.id && sameDefinition(group.server, entry.server),
    )
    if (existing) {
      existing.sourceAgents = mergeTargets(existing.sourceAgents, [entry.agent])
      existing.ignoredFields.push(...entry.ignoredFields)
      existing.diagnostics.push(...entry.diagnostics)
    } else {
      groups.push({
        id: entry.id,
        server: entry.server,
        sourceAgents: [entry.agent],
        ignoredFields: [...entry.ignoredFields],
        diagnostics: [...entry.diagnostics],
      })
    }
  }
  return groups
}

function planGroups(existing: McpServer[], groups: ImportGroup[]): McpImportItem[] {
  const occupied = new Map(existing.map((server) => [server.id, server] as const))
  const planned: McpImportItem[] = []

  for (const group of groups) {
    const existingSameId = occupied.get(group.id)
    let finalId = group.id
    let renameReason: McpImportItem['renameReason']
    if (existingSameId && !sameDefinition(existingSameId, group.server)) {
      finalId = allocateId(group.id, group.sourceAgents[0], occupied)
      renameReason = 'existing_conflict'
    } else if (existingSameId && sameDefinition(existingSameId, group.server)) {
      finalId = group.id
    } else if (occupied.has(group.id)) {
      finalId = allocateId(group.id, group.sourceAgents[0], occupied)
      renameReason = 'source_conflict'
    }

    const server = { ...group.server, id: finalId, targets: targetsFor(group.sourceAgents) }
    const status = itemStatus(finalId, group.id, existingSameId, server)
    planned.push({
      key: itemKey(group.id, finalId, group.sourceAgents, server),
      id: group.id,
      finalId,
      server,
      sourceAgents: targetsFor(group.sourceAgents),
      targets: targetsFor(group.sourceAgents),
      status,
      selectedByDefault: status === 'ready' || status === 'renamed',
      ignoredFields: group.ignoredFields,
      ...(renameReason ? { renameReason } : {}),
      diagnostics: group.diagnostics,
    })
    if (!existingSameId || finalId !== group.id) occupied.set(finalId, server)
  }

  return planned
}

function disabledItem(entry: DisabledSourceEntry): McpImportItem {
  const sourceAgents = targetsFor([entry.agent])
  return {
    key: itemKey(entry.id, entry.id, sourceAgents, { id: entry.id, type: 'stdio' }),
    id: entry.id,
    finalId: entry.id,
    sourceAgents,
    targets: sourceAgents,
    status: 'disabled',
    selectedByDefault: false,
    ignoredFields: entry.ignoredFields,
    diagnostics: entry.diagnostics,
  }
}

function itemStatus(
  finalId: string,
  originalId: string,
  existingSameId: McpServer | undefined,
  server: McpServer,
): McpImportItemStatus {
  if (finalId !== originalId) return 'renamed'
  if (!existingSameId) return 'ready'
  const nextTargets = mergeTargets(existingSameId.targets ?? [], server.targets ?? [])
  return sameTargets(existingSameId.targets ?? [], nextTargets) ? 'unchanged' : 'ready'
}

function allocateId(id: string, agent: AgentId, occupied: Map<string, McpServer>): string {
  const base = id + '-' + SOURCE_SUFFIX[agent]
  if (!occupied.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = base + '-' + i
    if (!occupied.has(candidate)) return candidate
  }
}

function itemKey(id: string, finalId: string, sourceAgents: AgentId[], server: McpServer): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id,
        finalId,
        sourceAgents: targetsFor(sourceAgents),
        server: comparable(server),
      }),
    )
    .digest('hex')
}

function sameDefinition(a: McpServer, b: McpServer): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b))
}

function comparable(server: McpServer): Record<string, unknown> {
  const out: Record<string, unknown> = { type: server.type }
  if (server.command !== undefined) out.command = server.command
  if (server.args !== undefined) out.args = server.args
  if (server.env !== undefined) out.env = sortRecord(server.env)
  if (server.url !== undefined) out.url = server.url
  if (server.headers !== undefined) out.headers = sortRecord(server.headers)
  return sortRecord(out)
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function targetsFor(agents: AgentId[]): AgentId[] {
  return AGENTS.filter((agent) => agents.includes(agent))
}

function mergeTargets(a: readonly AgentId[], b: readonly AgentId[]): AgentId[] {
  return AGENTS.filter((agent) => a.includes(agent) || b.includes(agent))
}

function sameTargets(a: readonly AgentId[], b: readonly AgentId[]): boolean {
  const left = targetsFor([...a])
  const right = targetsFor([...b])
  return left.length === right.length && left.every((agent, index) => agent === right[index])
}

async function readMcpYaml(fs: IFileSystem, repoPath: string): Promise<McpServer[]> {
  const path = mcpYamlPath(repoPath)
  try {
    const parsed = yaml.load(await fs.readFile(path))
    return Array.isArray(parsed) ? (parsed as McpServer[]) : []
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
}

function mcpYamlPath(repoPath: string): string {
  return join(repoPath, 'mcp.yaml')
}

function stalePreview(): McpImportApplyResult {
  return { ok: false, error: 'stale_import_preview', message: '导入预览已过期，请重新扫描' }
}

function collectIgnoredFields(
  container: string,
  id: string,
  raw: Record<string, unknown>,
): string[] {
  const allowed = new Set(['type', 'transport', 'command', 'args', 'env', 'url', 'headers'])
  return Object.keys(raw)
    .filter((key) => !allowed.has(key))
    .map((key) => pathFor(container, id, key))
}

function pathFor(container: string, id: string, field: string): string {
  return container + '.' + id + '.' + field
}

function stringField(value: unknown, path: string, ignoredFields: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  ignoredFields.push(path)
  return undefined
}

function stringArrayField(
  value: unknown,
  path: string,
  ignoredFields: string[],
): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  ignoredFields.push(path)
  return undefined
}

function stringRecordField(
  value: unknown,
  path: string,
  ignoredFields: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item
    else ignoredFields.push(path + '.' + key)
  }
  return Object.keys(out).length ? out : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
