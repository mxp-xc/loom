import type {
  DeleteImpact,
  VarEntryInput,
  RevealedVarEntry,
  VarsDiagnostic,
  VarsEnvironment,
  VarsMutationResponse,
  VarsResolution,
} from './vars'

const base = '/api'

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

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
  },
  init: () =>
    post('/init', {}).then(json) as Promise<{ ok: boolean; active_repo: string; repoPath: string }>,
  status: () =>
    fetch(`${base}/status`).then(json) as Promise<{ active_repo: string; repoPath: string }>,
  project: (body: { repo: string; scope?: 'skills' | 'mcp' | 'memory' | 'all' }) =>
    post('/project', body).then(json),
  syncPull: (repo: string) => post('/sync/pull', { repo }).then(json) as Promise<SyncPullResponse>,
  getSyncSession: (repo: string) =>
    fetch(`${base}/sync/session?repo=${encodeURIComponent(repo)}`).then(json) as Promise<
      SyncPullResponse & { active: boolean }
    >,
  saveSyncConflict: (body: { sessionId: string; path: string; result: string }) =>
    post('/sync/conflicts/save', body).then(json) as Promise<SyncConflictSaveResponse>,
  abortSyncMerge: (sessionId: string) => post('/sync/conflicts/abort', { sessionId }).then(json),
  syncPush: (repo: string) => post('/sync/push', { repo }).then(json),
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
  addSource: (body: { repo: string; url: string; ref: string }) =>
    post('/sources', body).then(json),
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
  scanSource: (url: string) =>
    post('/sources/scan', { url }).then(json) as Promise<{
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
  refreshSource: (repo: string, url: string, ref: string) =>
    post('/sources/refresh', { repo, url, ref }).then(json) as Promise<{
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
  updateSourceMeta: (body: { repo: string; url: string; ref?: string; type?: 'branch' | 'tag' }) =>
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
