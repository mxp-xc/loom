import {
  formatAgentFallbackPath,
  getMcpCodec,
  getAgent,
  parseVariableTokens,
  renderTextWithResolvedVars,
  toNativeMcpEntry,
  type AgentId,
  type McpServer,
  type VarEntry,
} from '@loom/core'
import type { ResolvedVarEntry, VarsDiagnostic, VarsLayerRef, VarsMatrixResponse } from '@/lib/vars'
import { agentName } from '@/lib/agents'

type ResolvedMatrix = VarsMatrixResponse & {
  resolution: Extract<VarsMatrixResponse['resolution'], { ok: true }>
}

export interface McpVariableToken {
  key: string
  token: string
  start: number
  end: number
}

export interface ResolvedMcpPreview {
  server: McpServer
  sections: Array<'transport' | 'env' | 'headers'>
  diagnostics: VarsDiagnostic[]
}

export interface McpSettingsPreview {
  agent: AgentId
  path: string
  language: 'json' | 'toml'
  text: string
  diagnostics: VarsDiagnostic[]
}

function isResolvedMatrix(matrix: VarsMatrixResponse | null | undefined): matrix is ResolvedMatrix {
  return matrix?.resolution.ok === true
}

function coreRenderValue(entry: ResolvedVarEntry): VarEntry {
  if ('masked' in entry) return { type: 'secret', value: entry.value }
  return entry
}

function coreRenderValues(values: Record<string, ResolvedVarEntry>): Record<string, VarEntry> {
  return Object.fromEntries(
    Object.entries(values).map(([key, entry]) => [key, coreRenderValue(entry)]),
  )
}

export function getMcpVariableTokens(text: string): McpVariableToken[] {
  return parseVariableTokens(text)
    .filter((token) => token.defaultValue === undefined)
    .map(({ key, start, end }) => ({ key, token: text.slice(start, end), start, end }))
}

function renderText(
  value: string | undefined,
  matrix: VarsMatrixResponse | null | undefined,
): { value: string | undefined; diagnostics: VarsDiagnostic[] } {
  if (value === undefined) return { value, diagnostics: [] }
  if (!isResolvedMatrix(matrix)) return { value, diagnostics: matrix?.resolution.diagnostics ?? [] }

  const rendered = renderTextWithResolvedVars(value, {
    values: coreRenderValues(matrix.resolution.values),
  })
  return rendered.ok
    ? { value: rendered.text, diagnostics: [] }
    : { value, diagnostics: rendered.diagnostics }
}

function uniqueDiagnostics(diagnostics: VarsDiagnostic[]): VarsDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((item) => {
    const identity = JSON.stringify([
      item.code,
      item.key,
      item.referencedKey,
      item.path,
      item.message,
    ])
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function renderArray(
  values: string[] | undefined,
  matrix: VarsMatrixResponse | null | undefined,
): { value: string[] | undefined; diagnostics: VarsDiagnostic[] } {
  if (!values) return { value: undefined, diagnostics: [] }
  const diagnostics: VarsDiagnostic[] = []
  const value = values.map((item) => {
    const rendered = renderText(item, matrix)
    diagnostics.push(...rendered.diagnostics)
    return rendered.value ?? item
  })
  return { value, diagnostics }
}

function renderRecord(
  record: Record<string, string> | undefined,
  matrix: VarsMatrixResponse | null | undefined,
): { value: Record<string, string> | undefined; diagnostics: VarsDiagnostic[] } {
  if (!record || Object.keys(record).length === 0) return { value: undefined, diagnostics: [] }
  const diagnostics: VarsDiagnostic[] = []
  const value = Object.fromEntries(
    Object.entries(record).map(([key, raw]) => {
      const rendered = renderText(raw, matrix)
      diagnostics.push(...rendered.diagnostics)
      return [key, rendered.value ?? raw]
    }),
  )
  return { value, diagnostics }
}

export function buildResolvedMcpServer(
  server: McpServer,
  context: 'default' | AgentId,
  matrix: VarsMatrixResponse | null | undefined,
): ResolvedMcpPreview {
  const diagnostics: VarsDiagnostic[] = []
  const command = renderText(server.command, matrix)
  const args = renderArray(server.args, matrix)
  const url = renderText(server.url, matrix)
  const env = renderRecord(server.env, matrix)
  const headers =
    server.type === 'stdio'
      ? { value: undefined, diagnostics: [] }
      : renderRecord(server.headers, matrix)

  diagnostics.push(
    ...command.diagnostics,
    ...args.diagnostics,
    ...url.diagnostics,
    ...env.diagnostics,
    ...headers.diagnostics,
  )

  const resolved: McpServer = {
    id: server.id,
    type: server.type,
    command: command.value,
    args: args.value,
    url: url.value,
    env: env.value,
    headers: headers.value,
    agents: server.agents ? [...server.agents] : undefined,
  }
  const sections: ResolvedMcpPreview['sections'] = ['transport']
  if (resolved.env) sections.push('env')
  if (resolved.headers) sections.push('headers')
  void context
  return { server: resolved, sections, diagnostics: uniqueDiagnostics(diagnostics) }
}

export function buildMcpSettingsPreview(
  server: McpServer,
  agent: AgentId,
  matrix: VarsMatrixResponse | null | undefined,
): McpSettingsPreview {
  const resolved = buildResolvedMcpServer(server, agent, matrix)
  const definition = getAgent(agent)
  if (!definition.mcp) throw new Error(`Agent ${agent} does not support MCP`)
  const codec = getMcpCodec(definition.mcp.codec)
  const entry = toNativeMcpEntry(resolved.server)
  if (resolved.server.type === 'stdio') delete entry.headers
  return {
    agent,
    path: formatAgentFallbackPath(agent, definition.mcp.path),
    language: codec.language,
    text: codec.preview(definition.mcp.rootKey, server.id, entry),
    diagnostics: resolved.diagnostics,
  }
}

export function formatMcpTraceLayer(layer: VarsLayerRef): string {
  if (layer.locality === 'synced' && layer.layer === 'base') return 'Base'
  if (layer.locality === 'synced' && layer.layer === 'agent')
    return `Base / ${agentName[layer.agent as AgentId] ?? layer.agent}`
  if (layer.locality === 'local' && layer.layer === 'local') return 'Local'
  if (layer.locality === 'local' && layer.layer === 'agent')
    return `Local / ${agentName[layer.agent as AgentId] ?? layer.agent}`
  if (layer.locality === 'builtin')
    return `Runtime / ${agentName[layer.agent as AgentId] ?? layer.agent ?? 'agent'}`
  return 'Unknown'
}
