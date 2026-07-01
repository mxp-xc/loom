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
  project: (body: unknown) => post('/project', body).then(json),
  syncPull: (repoPath: string) => post('/sync/pull', { repoPath }).then(json),
  syncApply: (repoPath: string, resolutions: Record<string, 'ours' | 'theirs'>) =>
    post('/sync/apply', { repoPath, resolutions }).then(json),
  syncPush: (repoPath: string) => post('/sync/push', { repoPath }).then(json),
  install: (body: unknown) => post('/install', body).then(json),
  update: (sources: unknown[]) => post('/update', { sources }).then(json),
  performUpdate: (body: unknown) => post('/update/perform', body).then(json),
  getConfig: (repoPath: string) =>
    fetch(`${base}/config?repoPath=${encodeURIComponent(repoPath)}`).then(json),
  getManifest: (repoPath: string) =>
    fetch(`${base}/manifest?repoPath=${encodeURIComponent(repoPath)}`).then(json),
  getSkillContent: (repoPath: string, skillId: string, sourceUrl?: string, localPath?: string) => {
    const params = new URLSearchParams({ repoPath, skillId })
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
    repoPath: string
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
  putConfig: (body: { repoPath: string; level: 'repo' | 'local'; field: string; value: unknown }) =>
    fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),

  addLocalSkill: (body: { repoPath: string; skill: { id: string; path?: string } }) =>
    post('/skills/local', body).then(json),
  addSource: (body: { repoPath: string; url: string; ref: string }) =>
    post('/sources', body).then(json),
  addMcpServer: (body: {
    repoPath: string
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
  deleteSource: (body: { repoPath: string; url: string }) =>
    fetch(`${base}/sources`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  deleteLocalSkill: (body: { repoPath: string; id: string }) =>
    fetch(`${base}/skills/local`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  deleteMcpServer: (body: { repoPath: string; id: string }) =>
    fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  getSyncRemote: (repoPath: string) =>
    fetch(`${base}/sync/remote?repoPath=${encodeURIComponent(repoPath)}`).then(json) as Promise<{
      remoteUrl: string | null
    }>,
  setSyncRemote: (body: { repoPath: string; remoteUrl: string }) =>
    post('/sync/remote', body).then(json),
  scanSource: (url: string) =>
    post('/sources/scan', { url }).then(json) as Promise<{
      members: Array<{ name: string; description: string; path: string; installed: boolean }>
    }>,
  updateMcpTargets: (body: { repoPath: string; id: string; targets: string[] }) =>
    post('/mcp/targets', body).then(json),
  updateSkillTargets: (body: {
    repoPath: string
    sourceUrl: string
    memberName: string
    targets: string[]
  }) => post('/skills/targets', body).then(json),
  updateLocalSkillTargets: (body: { repoPath: string; id: string; targets: string[] }) =>
    post('/skills/local/targets', body).then(json),
}
