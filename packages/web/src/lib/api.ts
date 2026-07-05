const base = '/api'

function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    return res.text().then(
      (t) => {
        throw new Error(`${res.status} ${res.statusText}${t ? `: ${t}` : ''}`)
      },
      () => {
        throw new Error(`${res.status} ${res.statusText}`)
      },
    )
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

export const api = {
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
