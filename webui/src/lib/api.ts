const base = '/api'

function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    return res.text().then(
      (t) => { throw new Error(`${res.status} ${res.statusText}${t ? `: ${t}` : ''}`) },
      () => { throw new Error(`${res.status} ${res.statusText}`) },
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
  init: () => post('/init', {}).then(json) as Promise<{ ok: boolean; active_repo: string; repoPath: string }>,
  status: () => fetch(`${base}/status`).then(json) as Promise<{ active_repo: string; repoPath: string }>,
  project: (body: unknown) => post('/project', body).then(json),
  syncPull: (repoPath: string) => post('/sync/pull', { repoPath }).then(json),
  syncPush: (repoPath: string) => post('/sync/push', { repoPath }).then(json),
  install: (body: unknown) => post('/install', body).then(json),
  update: (sources: unknown[]) => post('/update', { sources }).then(json),
  performUpdate: (body: unknown) => post('/update/perform', body).then(json),
  getConfig: (repoPath: string) =>
    fetch(`${base}/config?repoPath=${encodeURIComponent(repoPath)}`).then(json),
  getManifest: (repoPath: string) =>
    fetch(`${base}/manifest?repoPath=${encodeURIComponent(repoPath)}`).then(json),
  putConfig: (body: unknown) => post('/config', body).then(json),
}
