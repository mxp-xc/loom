import type {
  DeleteImpact,
  VarEntryInput,
  RevealedVarEntry,
  VarsDiagnostic,
  VarsEnvironment,
  VarsMutationResponse,
  VarsMatrixResponse,
  VarsResolution,
  AgentAwareVarsResolution,
  VarOverride,
} from './vars'
import type { AgentId, McpServer } from '@loom/core'

const base = '/api'

export interface McpImportDiagnostic {
  code: string
  message: string
  field?: string
}

export interface McpImportSourceResult {
  agent: AgentId
  path?: string
  status: 'ready' | 'missing_file' | 'parse_failed'
  diagnostics: McpImportDiagnostic[]
}

export interface McpImportItem {
  key: string
  id: string
  finalId: string
  server?: McpServer
  sourceAgents: AgentId[]
  targets: AgentId[]
  status: 'ready' | 'renamed' | 'disabled' | 'unchanged'
  selectedByDefault: boolean
  ignoredFields: string[]
  renameReason?: 'source_conflict' | 'existing_conflict' | 'suffix_conflict'
  diagnostics: McpImportDiagnostic[]
}

export interface McpImportScanResponse {
  ok: true
  items: McpImportItem[]
  sources: McpImportSourceResult[]
  existing: { count: number }
}

export type McpImportApplyResponse =
  | { ok: true; imported: number; renamed: number; ignoredFields: number; entries: McpServer[] }
  | { ok: false; error: 'stale_import_preview'; message: string }

export interface McpDebugTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export type CreateMcpDebugSessionResponse =
  | {
      ok: true
      sessionId: string
      source: 'saved' | 'draft'
      serverFingerprint: string
      previewTarget: AgentId
      tools: McpDebugTool[]
      createdAt: string
      idleExpiresAt: string
      hardExpiresAt: string
    }
  | {
      ok: false
      error: string
      message: string
      diagnostics?: VarsDiagnostic[]
    }

export type CallMcpDebugToolResponse =
  | {
      ok: true
      result: unknown
      durationMs: number
      calledAt: string
      idleExpiresAt: string
    }
  | {
      ok: false
      error: string
      message: string
      durationMs?: number
    }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly diagnostics?: VarsDiagnostic[],
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options)
    this.name = 'ApiError'
    this.details = options?.details
  }
  readonly details?: Record<string, unknown>
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
      const payload = JSON.parse(text) as {
        error?:
          | ({ code?: string; message?: string; diagnostics?: VarsDiagnostic[] } & Record<
              string,
              unknown
            >)
          | string
        message?: string
        diagnostics?: VarsDiagnostic[]
      }
      const nested = typeof payload.error === 'object' ? payload.error : undefined
      const message =
        nested?.message ??
        payload.message ??
        (typeof payload.error === 'string' ? payload.error : undefined)
      throw new ApiError(
        message ?? `${res.status} ${res.statusText}`,
        res.status,
        nested?.code,
        nested?.diagnostics ?? payload.diagnostics,
        { details: nested },
      )
    } catch (cause) {
      if (cause instanceof ApiError) throw cause
      throw new ApiError(
        `${res.status} ${res.statusText}${text ? `: ${text}` : ''}`,
        res.status,
        undefined,
        undefined,
        { cause },
      )
    }
  }
  return res.json() as Promise<T>
}

interface RequestOptions {
  signal?: AbortSignal
}

function post(path: string, body: unknown, options: RequestOptions = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  })
}

function put(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function del(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const api = {
  vars: {
    listEnvironments: (repoPath: string) =>
      fetch(`${base}/vars/environments?repoPath=${encodeURIComponent(repoPath)}`).then(
        json,
      ) as Promise<{
        ok: true
        environments: string[]
        diagnostics?: VarsDiagnostic[]
      }>,
    getEnvironment: (repoPath: string, environment: string) =>
      fetch(
        `${base}/vars/environments/${encodeURIComponent(environment)}?repoPath=${encodeURIComponent(repoPath)}`,
      ).then(json) as Promise<{ ok: true; name: string; environment: VarsEnvironment }>,
    createEnvironment: (repoPath: string, environment: string) =>
      post('/vars/environments', { repoPath, environment }).then(json) as Promise<{
        ok: true
        environment: string
      }>,
    deleteEnvironment: (repoPath: string, environment: string) =>
      del('/vars/environments', { repoPath, environment }).then(json) as Promise<{ ok: true }>,
    setVariable: (repoPath: string, environment: string, key: string, entry: VarEntryInput) =>
      put('/vars/variables', { repoPath, environment, key, entry }).then(
        json,
      ) as Promise<VarsMutationResponse>,
    renameVariable: (repoPath: string, environment: string, oldKey: string, newKey: string) =>
      post('/vars/variables/rename', { repoPath, environment, oldKey, newKey }).then(
        json,
      ) as Promise<VarsMutationResponse>,
    inspectVariableDelete: (repoPath: string, environment: string, key: string) =>
      post('/vars/variables/delete-impact', { repoPath, environment, key }).then(json) as Promise<{
        ok: true
        impact: DeleteImpact
      }>,
    deleteVariable: (
      repoPath: string,
      environment: string,
      key: string,
      options: { confirmed?: boolean; impactToken?: string } = {},
    ) =>
      del('/vars/variables', { repoPath, environment, key, ...options }).then(
        json,
      ) as Promise<VarsMutationResponse>,
    resolve: (repoPath: string, chain: string[]) =>
      post('/vars/resolve', { repoPath, chain }).then(json) as Promise<VarsResolution>,
    validateDraft: (
      repoPath: string,
      chain: string[],
      environment: string,
      key: string,
      entry: VarEntryInput,
    ) =>
      post('/vars/validate', { repoPath, chain, environment, key, entry }).then(json) as Promise<{
        ok: true
        resolution: VarsResolution
      }>,
    revealVariable: (repoPath: string, environment: string, key: string) =>
      post('/vars/variables/reveal', { repoPath, environment, key }).then(json) as Promise<{
        ok: true
        entry: RevealedVarEntry
      }>,
    getMatrix: (repoPath: string, agent: string) =>
      fetch(
        `${base}/vars/matrix?repoPath=${encodeURIComponent(repoPath)}&agent=${encodeURIComponent(agent)}`,
      ).then(json) as Promise<VarsMatrixResponse>,
    setBaseKey: (repoPath: string, key: string, definition: VarEntryInput) =>
      put('/vars/base-key', { repoPath, key, definition }).then(json) as Promise<{ ok: true }>,
    deleteBaseKey: (repoPath: string, key: string) =>
      del('/vars/base-key', { repoPath, key }).then(json) as Promise<{ ok: true }>,
    renameBaseKey: (repoPath: string, oldKey: string, newKey: string) =>
      post('/vars/base-key/rename', { repoPath, oldKey, newKey }).then(json) as Promise<{
        ok: true
      }>,
    setOverride: (
      repoPath: string,
      layer: 'base-agent' | 'local' | 'local-agent',
      key: string,
      override: VarOverride,
      agent?: string,
    ) =>
      put('/vars/override', { repoPath, layer, key, override, agent }).then(json) as Promise<{
        ok: true
      }>,
    clearOverride: (
      repoPath: string,
      layer: 'base-agent' | 'local' | 'local-agent',
      key: string,
      agent?: string,
    ) => del('/vars/override', { repoPath, layer, key, agent }).then(json) as Promise<{ ok: true }>,
  },
  init: () =>
    post('/init', {}).then(json) as Promise<{ ok: boolean; active_repo: string; repoPath: string }>,
  status: () =>
    fetch(`${base}/status`).then(json) as Promise<{ active_repo: string; repoPath: string }>,
  project: (body: { repo: string; scope?: 'skills' | 'mcp' | 'memory' | 'all' }) =>
    post('/project', body).then(json),
  syncPull: (repo: string, options?: RequestOptions) =>
    post('/sync/pull', { repo }, options).then(json) as Promise<SyncPullResponse>,
  getSyncSession: (repo: string) =>
    fetch(`${base}/sync/session?repo=${encodeURIComponent(repo)}`).then(json) as Promise<
      SyncPullResponse & { active: boolean }
    >,
  saveSyncConflict: (body: { sessionId: string; path: string; result: string }) =>
    post('/sync/conflicts/save', body).then(json) as Promise<SyncConflictSaveResponse>,
  abortSyncMerge: (sessionId: string) => post('/sync/conflicts/abort', { sessionId }).then(json),
  syncPush: (repo: string, options?: RequestOptions) =>
    post('/sync/push', { repo }, options).then(json),
  syncForcePush: (repo: string) => post('/sync/force-push', { repo }).then(json),
  syncForcePull: (repo: string) =>
    post('/sync/force-pull', { repo }).then(json) as Promise<SyncPullResponse>,
  install: (body: unknown) => post('/install', body).then(json),
  update: (repo: string, sources: unknown[]) => post('/update', { repo, sources }).then(json),
  performUpdate: (body: unknown) => post('/update/perform', body).then(json),
  getConfig: (repo: string) => fetch(`${base}/config?repo=${encodeURIComponent(repo)}`).then(json),
  getManifest: (repo: string) =>
    fetch(`${base}/manifest?repo=${encodeURIComponent(repo)}`).then(json),
  getSkillContent: (repo: string, skillId: string, sourceUrl?: string, localPath?: string) => {
    const params = new URLSearchParams({ repo, skillId })
    if (sourceUrl) params.set('sourceUrl', sourceUrl)
    if (localPath) params.set('localPath', localPath)
    return fetch(`${base}/skill/content?${params}`).then(json) as Promise<{
      ok: boolean
      content?: string
      path?: string
      error?: string
      message?: string
    }>
  },
  saveSkillContent: (body: {
    repo: string
    skillId: string
    sourceUrl?: string
    localPath?: string
    content: string
  }) =>
    fetch(`${base}/skill/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json) as Promise<{ ok: boolean; path?: string; error?: string; message?: string }>,
  putConfig: (body: { repo: string; level: 'repo' | 'local'; field: string; value: unknown }) =>
    fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),

  addLocalSkill: (body: { repo: string; skill: { id: string; path?: string } }) =>
    post('/skills/local', body).then(json),
  scanLocalSkills: (dir: string, repo: string) =>
    post('/skills/local/scan', { dir, repo }).then(json) as Promise<{
      ok: boolean
      skills: Array<{ name: string; path: string }>
      error?: string
      message?: string
    }>,
  importLocalSkills: (body: {
    repo: string
    skills: Array<{ name: string; path: string }>
    mode: 'move' | 'ref'
  }) => post('/skills/local/import', body).then(json) as Promise<{ ok: boolean; count?: number }>,
  writeLocalSkills: (body: {
    repo: string
    skills: Array<{ name: string; files: Array<{ path: string; content: string }> }>
  }) => post('/skills/local/write', body).then(json) as Promise<{ ok: boolean; count?: number }>,
  addSource: (body: {
    repo: string
    name: string
    url: string
    ref: string
    type?: 'branch' | 'tag'
    scan?: string
  }) => post('/sources', body).then(json),
  addMcpServer: (body: {
    repo: string
    server: {
      id: string
      type: string
      command?: string
      args?: string[]
      url?: string
      headers?: Record<string, string>
      env?: Record<string, string>
      targets?: string[]
    }
  }) => post('/mcp', body).then(json),
  updateMcpServer: (body: { repo: string; id: string; server: unknown }) =>
    fetch(`${base}/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  scanMcpImports: (body: { repo: string; sources?: AgentId[] }) =>
    post('/mcp/import/scan', body).then(json) as Promise<McpImportScanResponse>,
  applyMcpImports: (body: { repo: string; sources?: AgentId[]; keys: string[] }) =>
    post('/mcp/import/apply', body).then(json) as Promise<McpImportApplyResponse>,
  createMcpDebugSession: (
    body:
      | { repo: string; source: 'saved'; serverId: string; previewTarget: AgentId }
      | { repo: string; source: 'draft'; draft: McpServer; previewTarget: AgentId },
  ) => post('/mcp/debug/sessions', body).then(json) as Promise<CreateMcpDebugSessionResponse>,
  callMcpDebugTool: (
    sessionId: string,
    body: { toolName: string; arguments: Record<string, unknown> },
  ) =>
    post(`/mcp/debug/sessions/${encodeURIComponent(sessionId)}/tools/call`, body).then(
      json,
    ) as Promise<CallMcpDebugToolResponse>,
  disconnectMcpDebugSession: (sessionId: string) =>
    fetch(`${base}/mcp/debug/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }).then(json) as Promise<{ ok: true }>,
  deleteSource: (body: { repo: string; url: string }) =>
    fetch(`${base}/sources`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  deleteLocalSkill: (body: { repo: string; id: string }) =>
    fetch(`${base}/skills/local`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  deleteMcpServer: (body: { repo: string; id: string }) =>
    fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  getSyncRemote: (repo: string) =>
    fetch(`${base}/sync/remote?repo=${encodeURIComponent(repo)}`).then(json) as Promise<{
      remoteUrl: string | null
    }>,
  setSyncRemote: (body: { repo: string; remoteUrl: string }) =>
    post('/sync/remote', body).then(json),
  scanSource: (body: { url: string; ref?: string; type?: 'branch' | 'tag'; scan?: string }) =>
    post('/sources/scan', body).then(json) as Promise<{
      members: Array<{ name: string; description: string; path: string; installed: boolean }>
    }>,
  getSourceRefs: (url: string) =>
    post('/sources/refs', { url }).then(json) as Promise<{
      ok: boolean
      branches: string[]
      tags: string[]
      error?: string
      message?: string
    }>,
  refreshSource: (
    repo: string,
    source: { url: string; ref: string; type?: 'branch' | 'tag'; scan?: string },
  ) =>
    post('/sources/refresh', { repo, ...source }).then(json) as Promise<{
      ok: boolean
      members?: Array<{ name: string; path: string }>
      error?: string
      message?: string
    }>,
  setSourceMembers: (body: { repo: string; url: string; members: string[] }) =>
    post('/sources/members', body).then(json) as Promise<{
      ok: boolean
      error?: string
      message?: string
    }>,
  updateSourceMeta: (body: {
    repo: string
    url: string
    name?: string
    ref?: string
    type?: 'branch' | 'tag'
    scan?: string
  }) =>
    post('/sources/update', body).then(json) as Promise<{
      ok: boolean
      error?: string
      message?: string
    }>,
  updateMcpTargets: (body: { repo: string; id: string; targets: string[] }) =>
    post('/mcp/targets', body).then(json),
  updateSkillTargets: (body: {
    repo: string
    sourceUrl: string
    memberName: string
    targets: string[]
  }) => post('/skills/targets', body).then(json),
  updateSourceSkillTargets: (body: {
    repo: string
    sourceUrl: string
    updates: Array<{ memberName: string; targets: string[] }>
  }) => post('/skills/source-targets', body).then(json),
  updateLocalSkillTargets: (body: { repo: string; id: string; targets: string[] }) =>
    post('/skills/local/targets', body).then(json),

  getMemory: (repo: string) =>
    fetch(`${base}/memory?repo=${encodeURIComponent(repo)}`).then(json) as Promise<{
      memories: Array<{ name: string }>
      active: string | null
      activeContent: string
    }>,
  createMemory: (body: { repo: string; name: string }) => post('/memory', body).then(json),
  deleteMemory: (repo: string, name: string) =>
    fetch(`${base}/memory?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }).then(json),
  saveMemoryContent: (body: { repo: string; name: string; content: string }) =>
    fetch(`${base}/memory/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  renameMemory: (body: { repo: string; name: string; newName: string }) =>
    post('/memory/rename', body).then(json),
  setMemoryActive: (body: { repo: string; name: string | null }) =>
    post('/memory/active', body).then(json),
  previewMemory: (body: { repo: string; content: string; agent: string }) =>
    post('/memory/preview', body).then(json) as Promise<{
      rendered?: string
      diagnostics?: VarsDiagnostic[]
      resolution?: Extract<AgentAwareVarsResolution, { ok: true }>
      error?: string
      message?: string
    }>,
}

export interface GitConflictFile {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string | null
  binary: boolean
}

export interface SyncPullResponse {
  ok: boolean
  clean: boolean
  sessionId?: string
  conflicts: GitConflictFile[]
  error?: string
  message?: string
}

export interface SyncConflictSaveResponse {
  ok: boolean
  clean: boolean
  remaining: GitConflictFile[]
  sessionId?: string
  error?: string
  message?: string
}
