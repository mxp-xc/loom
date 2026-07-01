 # Web UI Functional Fixes Implementation Plan
 
 > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
 
 **Goal:** Fix all broken/missing interactions in the Loom Web UI so every clickable element works and matches the spec's "Terminal Loom" design intent.
 
 **Architecture:** Backend (Hono REST) + Frontend (React/Vite). Fixes span both layers: new API endpoints for delete/update/scan, fixes to existing endpoints for file-init safety and sync FETCH_HEAD, and frontend rewrites for Skills/MCP/Settings/Sync views to wire up dead buttons and fix rendering bugs.
 
 **Tech Stack:** Hono, React 18, Vite, simple-git, js-yaml, gray-matter, CSS variables (views use inline styles + index.css classes, no Tailwind utility classes in view components)
 
 **Test remote repo:** `https://github.com/mxp-xc/my-loom.git` — use for Sync pull/push integration testing.
 
 **Key constraint:** AGENTS.md forbids `git commit`/`git push` without explicit user permission. Tasks list commit steps for the worker to request approval, not auto-execute.

**Parallelization safety:** Tasks 1, 3, 4, 5, 6 all modify the same three files and MUST run strictly sequentially in order 1->3->4->5->6. Tasks 2, 7, 8, 9, 10 touch disjoint files and can be parallelized after their backend prerequisites complete.

**Rollback strategy:** Each task is a separate commit. git revert rolls back a single task. Loom's ~/.loom/repos/default/ is itself a git repo, so YAML changes are recoverable.
 
 ---
 
 ## File Structure
 
 **Backend files modified:**
 - `packages/server/src/api/routes.ts` — new endpoints: DELETE source/skill/mcp, POST /sources/scan, PUT /config, POST /skills/targets, POST /mcp/targets; fix readYaml with file-init fallback
 - `packages/server/src/platform/node/git.ts` — fix `fetch()` to use raw command that sets FETCH_HEAD
 
 **Frontend files modified:**
 - `packages/web/src/lib/api.ts` — add new API methods for delete, scan, targets, config-put
 - `packages/web/src/views/Skills.tsx` — wire agent chip onClick, check button, ⋯ menu (delete), source-scan add flow, projection result toast, remove JSON dump
 - `packages/web/src/views/Mcp.tsx` — wire detail panel target toggles, add clip-to-copy, headers rendering, projection preview
 - `packages/web/src/views/Settings.tsx` — fix ConfigField rendering, add config editing (input + save)
 - `packages/web/src/views/Sync.tsx` — add conflict resolution buttons (accept ours/theirs)
 - `packages/web/src/components/ConfigField.tsx` — handle object/array values, add edit mode
 
 **Test files created:**
 - `packages/server/test/api/routes-fixes.test.ts` — tests for all new/changed endpoints
 
 ---
 
 ## Task 1: Fix backend YAML file-init safety
 
 `readYaml` throws when `skills.yaml` or `mcp.yaml` doesn't exist, breaking first-use add operations.
 
 **Files:**
 - Modify: `packages/server/src/api/routes.ts` (the `readYaml` helper + 3 POST handlers)
 - Create: `packages/server/test/api/routes-fixes.test.ts`
 
 - [ ] **Step 1: Write the failing test**
 
 Create `packages/server/test/api/routes-fixes.test.ts`:
 
 ```typescript
 import { describe, it, expect, vi } from 'vitest'
 import { Hono } from 'hono'
 import { registerRoutes } from '../../src/api/routes'
 
 const memFiles: Record<string, string> = {}

// Reset shared state before each test to avoid order dependencies
// (add eforeEach(() => { for (const k of Object.keys(memFiles)) delete memFiles[k] })
//  after the describe blocks if tests start interfering)
 const memFs = {
   readFile: vi.fn(async (p: string) => { if (!(p in memFiles)) throw new Error('not found'); return memFiles[p] }),
   writeFile: vi.fn(async (p: string, c: string) => { memFiles[p] = c }),
   exists: vi.fn(async (p: string) => p in memFiles),
   readDir: vi.fn(async () => []),
   mkdir: vi.fn(async () => {}),
 }
 
 vi.mock('../../src/projection/executor.js', () => ({ executeProjection: vi.fn(async () => ({ ok: true })) }))
 vi.mock('../../src/sync/pull.js', () => ({ syncPull: vi.fn(async () => ({ files: [], varsFiles: [], textConflicts: [], clean: true })) }))
 vi.mock('../../src/sync/push.js', () => ({ syncPush: vi.fn(async () => ({ ok: true })) }))
 vi.mock('@loom/core', () => ({
   loadRepoManifest: vi.fn(() => ({ repoConfig: {}, errors: [] })),
   mergeConfig: vi.fn((repo: Record<string, unknown>) => ({ ...repo })),
   buildManifest: vi.fn(),
   planProjection: vi.fn(),
 }))
 vi.mock('../../src/platform/node/index.js', () => ({ createNodePlatform: vi.fn(() => ({ fs: memFs, git: {}, proc: {} })) }))
 vi.mock('../../src/platform/node/init.js', () => ({ initLoom: vi.fn() }))
 
 describe('routes file-init safety', () => {
   const app = new Hono().route('/api', registerRoutes())
 
   it('POST /api/skills/local works when skills.yaml does not exist', async () => {
     const res = await app.request('/api/skills/local', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r1', skill: { id: 'test-skill' } }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
   })
 
   it('POST /api/mcp works when mcp.yaml does not exist', async () => {
     delete memFiles['/tmp/r1/mcp.yaml']
     const res = await app.request('/api/mcp', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r1', server: { id: 'test', type: 'stdio', command: 'echo' } }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
   })
 })
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: FAIL with `write_failed` error (readYaml throws on missing file)
 
 - [ ] **Step 3: Fix readYaml to return null when file is missing**
 
 In `packages/server/src/api/routes.ts`, replace the `readYaml` function (currently around line 38):
 
 ```typescript
 async function readYaml(fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> }, filePath: string): Promise<any> {
   const yaml = await import('js-yaml')
   if (!(await fs.exists(filePath))) return null
   const raw = await fs.readFile(filePath)
   return yaml.load(raw) ?? null
 }
 ```
 
 Then update the three POST handlers to use `??` fallback:
 - `POST /skills/local`: `const data = await readYaml(fs, filePath) ?? { sources: [], skills: [] }`
 - `POST /sources`: `const data = await readYaml(fs, filePath) ?? { sources: [], skills: [] }`
 - `POST /mcp`: `const data = await readYaml(fs, filePath) ?? []` (remove the `if (!Array.isArray(data)) throw` line)
 
 - [ ] **Step 4: Run test to verify it passes**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: PASS
 
 - [ ] **Step 5: Request commit approval**
 
 Inform user: "Task 1 complete, ready to commit: fix YAML file-init safety for first-use add operations"
 
 ---
 
 ## Task 2: Fix sync/pull FETCH_HEAD error
 
 `simpleGit.fetch(['--tags'])` doesn't reliably set `FETCH_HEAD`. `syncPull` calls `git.mergeBase(repoPath, 'FETCH_HEAD', 'HEAD')` which fails with "Not a valid object name FETCH_HEAD".
 
 **Files:**
 - Modify: `packages/server/src/platform/node/git.ts:26-28` (the `fetch` method)
 
 - [ ] **Step 1: Fix fetch to use raw command**
 
 In `packages/server/src/platform/node/git.ts`, replace the `fetch` method:
 
 ```typescript
 async fetch(repoPath: string): Promise<void> {
   // Use raw to ensure FETCH_HEAD is set — simple-git's .fetch() wrapper
   // doesn't reliably create FETCH_HEAD for merge-base lookups
   await this.git(repoPath).raw(['fetch', '--tags'])
 }
 ```
 
 - [ ] **Step 2: Manual integration test with test repo**
 
 Start dev server (`pnpm dev`), go to Sync page, configure remote as `https://github.com/mxp-xc/my-loom.git`, click 拉取.
 Expected: Pull succeeds or shows a meaningful error (not "Not a valid object name FETCH_HEAD").
 
 - [ ] **Step 3: Request commit approval**
 
 Inform user: "Task 2 complete, ready to commit: fix sync fetch to set FETCH_HEAD via raw command"
 
 ---
 
 ## Task 3: Add DELETE endpoints (source/skill/mcp)
 
 **Files:**
 - Modify: `packages/server/src/api/routes.ts` — add 3 DELETE routes
 - Modify: `packages/web/src/lib/api.ts` — add 3 API methods
 - Modify: `packages/server/test/api/routes-fixes.test.ts` — add tests
 
 - [ ] **Step 1: Write the failing tests**
 
 Append to `packages/server/test/api/routes-fixes.test.ts`:
 
 ```typescript
 describe('DELETE endpoints', () => {
   const app = new Hono().route('/api', registerRoutes())
 
   it('DELETE /api/sources removes a source by url', async () => {
     memFiles['/tmp/r2/skills.yaml'] = 'sources:\n  - url: https://github.com/test/repo\n    ref: main\nskills: []\n'
     const res = await app.request('/api/sources', {
       method: 'DELETE',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r2', url: 'https://github.com/test/repo' }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
     const yaml = yaml.load(memFiles['/tmp/r2/skills.yaml'])
     expect(yaml.sources).toHaveLength(0)
   })
 
   it('DELETE /api/skills/local removes a local skill by id', async () => {
     memFiles['/tmp/r3/skills.yaml'] = 'sources: []\nskills:\n  - id: test-skill\n'
     const res = await app.request('/api/skills/local', {
       method: 'DELETE',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r3', id: 'test-skill' }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
     const yaml = yaml.load(memFiles['/tmp/r3/skills.yaml'])
     expect(yaml.skills).toHaveLength(0)
   })
 
   it('DELETE /api/mcp removes a server by id', async () => {
     memFiles['/tmp/r4/mcp.yaml'] = '- id: test\n  type: stdio\n  command: echo\n'
     const res = await app.request('/api/mcp', {
       method: 'DELETE',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r4', id: 'test' }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
     const yaml = yaml.load(memFiles['/tmp/r4/mcp.yaml'])
     expect(yaml).toHaveLength(0)
   })
 })
 ```
 
 - [ ] **Step 2: Run tests to verify they fail**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: FAIL (no DELETE routes exist, 404)
 
 - [ ] **Step 3: Add DELETE routes to routes.ts**
 
 Add after the existing `POST /mcp` handler in `packages/server/src/api/routes.ts`:
 
 ```typescript
   app.delete('/sources', async (c) => {
     try {
       const { repoPath, url } = await c.req.json()
       const { fs } = createNodePlatform()
       const filePath = join(repoPath, 'skills.yaml')
       const data = await readYaml(fs, filePath) ?? { sources: [], skills: [] }
       data.sources = (data.sources ?? []).filter((s: any) => s.url !== url)
       await writeYaml(fs, filePath, data)
       return c.json({ ok: true })
     } catch (e) {
       return c.json({ ok: false, error: 'delete_failed', message: String(e?.message ?? e) })
     }
   })
 
   app.delete('/skills/local', async (c) => {
     try {
       const { repoPath, id } = await c.req.json()
       const { fs } = createNodePlatform()
       const filePath = join(repoPath, 'skills.yaml')
       const data = await readYaml(fs, filePath) ?? { sources: [], skills: [] }
       data.skills = (data.skills ?? []).filter((s: any) => s.id !== id)
       await writeYaml(fs, filePath, data)
       return c.json({ ok: true })
     } catch (e) {
       return c.json({ ok: false, error: 'delete_failed', message: String(e?.message ?? e) })
     }
   })
 
   app.delete('/mcp', async (c) => {
     try {
       const { repoPath, id } = await c.req.json()
       const { fs } = createNodePlatform()
       const filePath = join(repoPath, 'mcp.yaml')
       const data = await readYaml(fs, filePath) ?? []
       const filtered = data.filter((s: any) => s.id !== id)
       await writeYaml(fs, filePath, filtered)
       return c.json({ ok: true })
     } catch (e) {
       return c.json({ ok: false, error: 'delete_failed', message: String(e?.message ?? e) })
     }
   })
 ```
 
 - [ ] **Step 4: Add API methods to api.ts**
 
 Add to the `api` object in `packages/web/src/lib/api.ts`:
 
 ```typescript
   deleteSource: (body: { repoPath: string; url: string }) =>
     fetch(`${base}/sources`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json),
   deleteLocalSkill: (body: { repoPath: string; id: string }) =>
     fetch(`${base}/skills/local`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json),
   deleteMcpServer: (body: { repoPath: string; id: string }) =>
     fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json),
 ```
 
 - [ ] **Step 5: Run tests to verify they pass**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: PASS
 
 - [ ] **Step 6: Request commit approval**
 
 Inform user: "Task 3 complete, ready to commit: add DELETE endpoints for source/skill/mcp"
 
 ---
 
 ## Task 4: Add source-scan endpoint for Add Source flow
 
 The spec requires: user enters URL → loom clones shallow → scans `**/SKILL.md` → shows member list. `discoverSkills` already exists in `packages/server/src/remote/discover.ts` but has no API endpoint.
 
 **Files:**
 - Modify: `packages/server/src/api/routes.ts` — add `POST /sources/scan`
 - Modify: `packages/web/src/lib/api.ts` — add `scanSource` method
 - Modify: `packages/server/test/api/routes-fixes.test.ts` — add test
 
 - [ ] **Step 1: Write the failing test**
 
 Append to `packages/server/test/api/routes-fixes.test.ts`. Add this mock at the top of the file with the other vi.mock calls:
 
 ```typescript
 vi.mock('../../src/remote/discover.js', () => ({
   discoverSkills: vi.fn(async () => [
     { name: 'brainstorming', description: 'desc', path: '/tmp/skills/brainstorming', installed: false },
     { name: 'test-driven-development', description: 'desc2', path: '/tmp/skills/tdd', installed: true },
   ]),
 }))
 ```
 
 Add this describe block at the bottom:
 
 ```typescript
 describe('source scan', () => {
   const app = new Hono().route('/api', registerRoutes())
 
   it('POST /api/sources/scan returns discovered members', async () => {
     const res = await app.request('/api/sources/scan', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ url: 'https://github.com/obra/superpowers' }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.members).toHaveLength(2)
     expect(body.members[0].name).toBe('brainstorming')
   })
 })
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: FAIL (no /sources/scan route, 404)
 
 - [ ] **Step 3: Add the scan endpoint**
 
 Add to `packages/server/src/api/routes.ts`, after the `POST /sources` handler:
 
 ```typescript
   app.post('/sources/scan', async (c) => {
     try {
       const { url } = await c.req.json()
       const { git, fs } = createNodePlatform()
       const { discoverSkills } = await import('../remote/discover.js')
       const { loadRepoManifest, buildManifest } = await import('@loom/core')
      const home = process.env.HOME || process.env.USERPROFILE || ''
      const repoPath = c.req.query('repoPath')
      const files = await readRepoFiles(fs, repoPath || '')
      const repoManifest = loadRepoManifest(files)
      const installed = new Set<string>()
      for (const src of repoManifest.sources ?? []) {
        const repoId = src.url.split(':').pop()?.split('/').pop()?.replace(/\.git$/, '') ?? ''
        for (const m of src.members ?? []) installed.add(${repoId}-)
      }
      const members = await discoverSkills(git, fs, url, installed)
       return c.json({ members })
     } catch (e) {
       return c.json({ ok: false, error: 'scan_failed', message: String(e?.message ?? e) })
     }
   })
 ```
 
 - [ ] **Step 4: Add API method**
 
 Add to `packages/web/src/lib/api.ts`:
 
 ```typescript
   scanSource: (url: string) =>
     post('/sources/scan', { url }).then(json) as Promise<{ members: Array<{ name: string; description: string; path: string; installed: boolean }> }>,
 ```
 
 - [ ] **Step 5: Run test to verify it passes**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: PASS
 
 - [ ] **Step 6: Request commit approval**
 
 Inform user: "Task 4 complete, ready to commit: add POST /sources/scan endpoint for member discovery"
 
 ---
 
 ## Task 5: Add targets update endpoints (for agent chip toggles)
 
 Agent chips need to toggle projection targets for both skills (member-level) and MCP servers.
 
 **Files:**
 - Modify: `packages/server/src/api/routes.ts` — add `POST /skills/targets` and `POST /mcp/targets`
 - Modify: `packages/web/src/lib/api.ts` — add `updateSkillTargets` and `updateMcpTargets` methods
 - Modify: `packages/server/test/api/routes-fixes.test.ts` — add test
 
 - [ ] **Step 1: Write the failing test**
 
 Append to `packages/server/test/api/routes-fixes.test.ts`:
 
 ```typescript
 describe('targets update', () => {
   const app = new Hono().route('/api', registerRoutes())
 
   it('POST /api/mcp/targets updates targets for an mcp server', async () => {
     memFiles['/tmp/r5/mcp.yaml'] = '- id: srv1\n  type: stdio\n  command: echo\n  targets:\n    - claude-code\n'
     const res = await app.request('/api/mcp/targets', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r5', id: 'srv1', targets: ['claude-code', 'codex'] }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
     const yaml = yaml.load(memFiles['/tmp/r5/mcp.yaml'])
     expect(yaml[0].targets).toEqual(['claude-code', 'codex'])
   })
 })
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: FAIL (no /mcp/targets route, 404)
 
 - [ ] **Step 3: Add targets update routes**
 
 Add to `packages/server/src/api/routes.ts`, after the DELETE routes:
 
 ```typescript
   app.post('/mcp/targets', async (c) => {
     try {
       const { repoPath, id, targets } = await c.req.json()
       const { fs } = createNodePlatform()
       const filePath = join(repoPath, 'mcp.yaml')
       const data = await readYaml(fs, filePath) ?? []
       const server = data.find((s: any) => s.id === id)
       if (!server) return c.json({ ok: false, error: 'not_found', message: `MCP server ${id} not found` })
       server.targets = targets
       await writeYaml(fs, filePath, data)
       return c.json({ ok: true })
     } catch (e) {
       return c.json({ ok: false, error: 'update_failed', message: String(e?.message ?? e) })
     }
   })
 
   app.post('/skills/targets', async (c) => {
     try {
       const { repoPath, sourceUrl, memberName, targets } = await c.req.json()
       const { fs } = createNodePlatform()
       const filePath = join(repoPath, 'skills.yaml')
       const data = await readYaml(fs, filePath) ?? { sources: [], skills: [] }
       const source = (data.sources ?? []).find((s: any) => s.url === sourceUrl)
       if (!source) return c.json({ ok: false, error: 'not_found', message: `Source ${sourceUrl} not found` })
       if (!source.members) source.members = []
       let member = source.members.find((m: any) => m.name === memberName)
       if (!member) {
         member = { name: memberName, targets }
         source.members.push(member)
       } else {
         member.targets = targets
       }
       await writeYaml(fs, filePath, data)
       return c.json({ ok: true })
     } catch (e) {
       return c.json({ ok: false, error: 'update_failed', message: String(e?.message ?? e) })
     }
   })
 ```
 
 - [ ] **Step 4: Add API methods**
 
 Add to `packages/web/src/lib/api.ts`:
 
 ```typescript
   updateMcpTargets: (body: { repoPath: string; id: string; targets: string[] }) =>
     post('/mcp/targets', body).then(json),
   updateSkillTargets: (body: { repoPath: string; sourceUrl: string; memberName: string; targets: string[] }) =>
     post('/skills/targets', body).then(json),
 ```
 
 - [ ] **Step 5: Run tests to verify they pass**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: PASS
 
 - [ ] **Step 6: Request commit approval**
 
 Inform user: "Task 5 complete, ready to commit: add targets update endpoints for skills and mcp"
 
 ---
 
 ## Task 6: Implement PUT /config (settings editing)
 
 **Files:**
 - Modify: `packages/server/src/api/routes.ts` — replace the 501 `PUT /config` handler
 - Modify: `packages/web/src/lib/api.ts` — fix `putConfig` to use PUT method
 - Modify: `packages/server/test/api/routes-fixes.test.ts` — add test
 
 - [ ] **Step 1: Write the failing test**
 
 Append to `packages/server/test/api/routes-fixes.test.ts`:
 
 ```typescript
 describe('PUT /config', () => {
   const app = new Hono().route('/api', registerRoutes())
 
   it('PUT /api/config updates a repo-level config field', async () => {
     memFiles['/tmp/r6/config.yaml'] = 'profile: local\ntargets:\n  - claude-code\n'
     const res = await app.request('/api/config', {
       method: 'PUT',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ repoPath: '/tmp/r6', level: 'repo', field: 'profile', value: 'default' }),
     })
     expect(res.status).toBe(200)
     const body = await res.json()
     expect(body.ok).toBe(true)
     const yaml = yaml.load(memFiles['/tmp/r6/config.yaml'])
     expect(yaml.profile).toBe('default')
   })
 })
 ```
 
 - [ ] **Step 2: Run test to verify it fails**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: FAIL (returns 501)
 
 - [ ] **Step 3: Implement PUT /config**
 
 Replace the `PUT /config` handler in `packages/server/src/api/routes.ts` (currently returns 501):
 
 ```typescript
   app.put('/config', async (c) => {
     try {
       const { repoPath, level, field, value } = await c.req.json()
       const { fs } = createNodePlatform()
       const home = process.env.HOME || process.env.USERPROFILE || ''
 
       if (level === 'local') {
         const localPath = join(home, '.loom', 'config.yaml')
         const data = await readYaml(fs, localPath) ?? {}
         if (value === null) delete data[field]
         else data[field] = value
         await writeYaml(fs, localPath, data)
       } else {
         const repoConfigPath = join(repoPath, 'config.yaml')
         const data = await readYaml(fs, repoConfigPath) ?? {}
         if (value === null) delete data[field]
         else data[field] = value
         await writeYaml(fs, repoConfigPath, data)
       }
       return c.json({ ok: true })
     } catch (e) {
       return c.json({ ok: false, error: 'config_update_failed', message: String(e?.message ?? e) })
     }
   })
 ```
 
 - [ ] **Step 4: Fix putConfig in api.ts**
 
 Replace the `putConfig` method in `packages/web/src/lib/api.ts` (currently uses `post`):
 
 ```typescript
   putConfig: (body: { repoPath: string; level: 'repo' | 'local'; field: string; value: unknown }) =>
     fetch(`${base}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json),
 ```
 
 - [ ] **Step 5: Run test to verify it passes**
 
 Run: `pnpm --filter @loom/server test routes-fixes`
 Expected: PASS
 
 - [ ] **Step 6: Request commit approval**
 
 Inform user: "Task 6 complete, ready to commit: implement PUT /config for settings editing"
 
 ---
 
 ## Task 7: Rewrite Skills.tsx — agent chips, check button, ⋯ menu, scan flow, toast
 
 This is the largest frontend task. Wire up all dead buttons, add source-scan flow, replace JSON dump with toast.
 
 **Files:**
 - Modify: `packages/web/src/views/Skills.tsx` — full rewrite
 
 - [ ] **Step 1: Rewrite Skills.tsx**
 
 Replace the entire content of `packages/web/src/views/Skills.tsx`. The new version must:
 
 1. **Agent chips** get `onClick` that calls `api.updateSkillTargets` then reloads manifest
 2. **`⟳ check` button** calls `api.update([src])` and shows toast with result
 3. **`⋯` menu** opens a dropdown with "删除" option that calls `api.deleteSource` or `api.deleteLocalSkill`
 4. **Add Source tab** has a 2-step flow: enter URL → click "扫描" → `api.scanSource(url)` → show member list with checkboxes → click "添加 Source" to save
 5. **Projection button** shows a toast ("投影完成") instead of JSON dump
 6. Remove the `projectResult` JSON `<pre>` display entirely
 
 Key code patterns (worker should implement the full file):
 
 - Chip click handler:
 ```tsx
 const handleChipToggle = async (sourceUrl: string, memberName: string, agent: Agent, currentTargets: string[]) => {
   const newTargets = currentTargets.includes(agent)
     ? currentTargets.filter(a => a !== agent)
     : [...currentTargets, agent]
   await api.updateSkillTargets({ repoPath, sourceUrl, memberName, targets: newTargets })
   load()
 }
 ```
 
 - Check handler:
 ```tsx
 const handleCheck = async (src: SkillSource) => {
   setChecking(src.url)
   const res = await api.update([src]) as any
   if (res.updates?.[0]?.hasUpdate) {
     setUpdates(prev => ({ ...prev, [src.url]: res.updates[0].latestTag }))
   }
   setChecking(null)
 }
 ```
 
 - ⋯ menu with delete:
 ```tsx
 {menuOpen === src.url && (
   <div style={{ position: 'absolute', right: 14, top: 0, zIndex: 10, ... }}>
     <button onClick={() => handleDeleteSource(src.url)}>删除</button>
   </div>
 )}
 ```
 
 - Source scan flow in the Add modal:
 ```tsx
 // After url+ref inputs, add a "扫描" button
 <button onClick={handleScan} disabled={scanning}>{scanning ? '扫描中…' : '扫描'}</button>
 // When scanMembers is populated, show checkboxes
 {scanMembers.map(m => (
   <label key={m.name}>
     <input type="checkbox" checked={scanSelected.has(m.name)} onChange={...} />
     {m.name} {m.installed && '(已安装)'}
   </label>
 ))}
 ```
 
 - Toast instead of JSON dump:
 ```tsx
 const [toast, setToast] = useState<string | null>(null)
 const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }
 // In project():
 showToast('投影完成')
 // Remove all projectResult / <pre>{JSON.stringify(...)}</pre> code
 ```
 
 - [ ] **Step 2: Run dev server and Playwright test**
 
 Run: `pnpm dev` then use playwright-cli to:
 1. Go to Skills page, click agent chips → verify they toggle and manifest reloads
 2. Click `⟳ check` → verify toast appears
 3. Click `⋯` → verify dropdown with 删除 appears, click it → verify source disappears
 4. Click `+ Add skill` → Source tab → enter URL → click 扫描 → verify member list appears
 5. Click 投影 → verify toast "投影完成" appears (not JSON dump)
 
 - [ ] **Step 3: Request commit approval**
 
 Inform user: "Task 7 complete, ready to commit: wire up Skills view interactions (chips, check, menu, scan, toast)"
 
 ---
 
 ## Task 8: Rewrite Mcp.tsx — detail target toggles, clip-to-copy, headers
 
 **Files:**
 - Modify: `packages/web/src/views/Mcp.tsx`
 
 - [ ] **Step 1: Wire detail panel target toggles**
 
 In `packages/web/src/views/Mcp.tsx`, the detail panel's target chips (`.tg` spans) currently have no onClick. Add:
 
 ```tsx
 const handleToggleTarget = async (agent: Agent) => {
   if (!selectedServer) return
   const currentTargets = selectedServer.targets ?? agents
   const newTargets = currentTargets.includes(agent)
     ? currentTargets.filter(a => a !== agent)
     : [...currentTargets, agent]
   await api.updateMcpTargets({ repoPath, id: selectedServer.id, targets: newTargets })
   load()
 }
 
 // In detail panel, change target spans from readonly to clickable:
 {allAgents.map(a => {
   const srvAgents = selectedServer.targets ?? agents
   return (
     <span key={a} className={'tg ' + (srvAgents.includes(a) ? 'on' : 'off')}
       style={{ ['--c' as string]: agentColor(a), width: 40, height: 40, fontSize: 12, cursor: 'pointer' }}
       onClick={() => handleToggleTarget(a)}
     >{agentShort(a)}</span>
   )
 })}
 ```
 
 Also make the list-item toggles clickable (same handler).
 
 - [ ] **Step 2: Add clip-to-copy for MCP config preview**
 
 Add a copy button in the detail panel that copies the server's config as YAML:
 
 ```tsx
 const [copied, setCopied] = useState(false)
 const handleCopy = () => {
   // Use JSON.stringify instead of js-yaml (not available in browser bundle)
   const text = JSON.stringify([selectedServer], null, 2)
   navigator.clipboard.writeText(text)
   setCopied(true)
   setTimeout(() => setCopied(false), 2000)
 }
 // Add button in detail header:
 <button className="gbtn" onClick={handleCopy}>{copied ? '✓' : '📋'}</button>
 ```
 
 - [ ] **Step 3: Add headers rendering in detail panel**
 
 After the env section in the detail panel, add headers display for sse/http types:
 
 ```tsx
 {selectedServer.type !== 'stdio' && selectedServer.headers && Object.keys(selectedServer.headers).length > 0 && (
   <div style={{ marginTop: 12 }}>
     <span className="label">headers</span>
     <div style={{ marginTop: 4, fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--muted)' }}>
       {Object.entries(selectedServer.headers).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
     </div>
   </div>
 )}
 ```
 
 - [ ] **Step 4: Run dev server and Playwright test**
 
 Run: `pnpm dev` then use playwright-cli to:
 1. Go to MCP page, select a server, click target toggles in detail → verify they toggle
 2. Click 📋 → verify clipboard copies YAML
 3. Select a remote-type server → verify headers are shown
 
 - [ ] **Step 5: Request commit approval**
 
 Inform user: "Task 8 complete, ready to commit: wire MCP detail target toggles, clip-to-copy, headers display"
 
 ---
 
 ## Task 9: Fix Settings — ConfigField rendering + config editing
 
 **Files:**
 - Modify: `packages/web/src/components/ConfigField.tsx` — handle objects/arrays, add edit mode
 - Modify: `packages/web/src/views/Settings.tsx` — wire up editing with PUT /config
 
 - [ ] **Step 1: Fix ConfigField to handle complex values**
 
 Replace `packages/web/src/components/ConfigField.tsx` entirely:
 
 ```tsx
 import { useState } from 'react'
 export type ConfigLevel = 'effective' | 'repo' | 'local'
 
 function formatValue(v: unknown): string {
   if (v == null) return '(空)'
   if (typeof v === 'string') return v
   if (typeof v === 'number' || typeof v === 'boolean') return String(v)
   if (Array.isArray(v)) return v.join(', ')
   if (typeof v === 'object') {
     try { return JSON.stringify(v) } catch { return '[object Object]' }
   }
   return String(v)
 }
 
 // ConfigLevel type defined above
 
 export function ConfigField({
   name, value, level, inRepo, inLocal, fixed, repoPath,
 }: {
   name: string
   value: unknown
   level: ConfigLevel
   inRepo: boolean
   inLocal: boolean
   fixed: boolean
   repoPath: string
 }) {
   const [editing, setEditing] = useState(false)
   const [editValue, setEditValue] = useState(formatValue(value))
   const [saving, setSaving] = useState(false)
   const [err, setErr] = useState<string | null>(null)
 
   let dotClass = ''
   let title = ''
   if (fixed) { dotClass = 'sdot-cfg fixed'; title = '固定本地级' }
   else if (level === 'effective') {
     if (inLocal) { dotClass = 'sdot-cfg local'; title = '生效自本地级' }
     else if (inRepo) { dotClass = 'sdot-cfg repo'; title = '生效自仓库级' }
     else { dotClass = 'sdot-cfg inherit'; title = '两处未设' }
   } else if (level === 'local') {
     dotClass = inLocal ? 'sdot-cfg local' : 'sdot-cfg inherit'
     title = inLocal ? '本地覆盖' : '继承仓库级'
   }
 
   const canEdit = level !== 'effective' && !fixed
  if (editing && level === 'effective') setEditing(false)  // safety guard
 
   const handleSave = async () => {
     setSaving(true); setErr(null)
     try {
       // Parse value: try JSON for arrays/objects, else string
       let parsed: unknown = editValue
       if (editValue.startsWith('[') || editValue.startsWith('{')) {
         parsed = JSON.parse(editValue)
       } else if (editValue === '(空)' || editValue === '') {
         parsed = null
       }
       const { api } = await import('@/lib/api')
       await api.putConfig({ repoPath, level, field: name, value: parsed })
       setEditing(false)
       onSaved?.()
     } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
     finally { setSaving(false) }
   }
 
   return (
     <div className="flex items-center gap-2" style={{ padding: '10px 16px' }}>
       {dotClass && <span className={dotClass} title={title} />}
       <span style={{ width: 160, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{name}</span>
       {editing ? (
         <>
           <input
             value={editValue}
             onChange={e => setEditValue(e.target.value)}
             style={{ flex: 1, padding: '4px 8px', fontSize: 13, fontFamily: "'Fira Code', monospace",
               border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }}
             autoFocus
           />
           <button className="gbtn" onClick={handleSave} disabled={saving} style={{ color: 'var(--signal)' }}>
             {saving ? '…' : '✓'}
           </button>
           <button className="gbtn" onClick={() => { setEditing(false); setEditValue(formatValue(value)) }}>×</button>
           {err && <span style={{ fontSize: 11, color: 'var(--error)' }}>{err}</span>}
         </>
       ) : (
         <>
           <span style={{ flex: 1, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--muted)' }}>
             {formatValue(value)}
           </span>
           {canEdit && (
             <button className="gbtn" onClick={() => { setEditing(true); setEditValue(formatValue(value)) }}>编辑</button>
           )}
         </>
       )}
     </div>
   )
 }
 ```
 
 - [ ] **Step 2: Update Settings.tsx to pass repoPath to ConfigField**
 
 In `packages/web/src/views/Settings.tsx`, update the `ConfigField` usage to pass `repoPath`:
 
 ```tsx
 {fields.map((f) => (
   <ConfigField
     key={f}
     name={f}
     level={level}
     value={(cfg[level] as Record<string, unknown>)[f]}
     inRepo={f in cfg.repo}
     inLocal={f in cfg.local}
     fixed={f === 'active_repo'}
     repoPath={repoPath}
   />
 ))}
 ```
 
 - [ ] **Step 3: Run dev server and Playwright test**
 
 Run: `pnpm dev` then use playwright-cli to:
 1. Go to Settings page → verify `projection` and `update_check` show JSON string instead of `[object Object]`
 2. Switch to 仓库级 tab → click 编辑 on a field → change value → click ✓ → verify page reloads with new value
 3. Switch to 本地级 tab → edit a field → verify it saves
 
 - [ ] **Step 4: Request commit approval**
 
 Inform user: "Task 9 complete, ready to commit: fix Settings ConfigField rendering and add config editing"
 
 ---
 
 ## Task 10: Add Sync conflict resolution UI (frontend scaffolding)

**Note:** This task adds the UI for selecting which side to keep (ours/theirs). The backend endpoint to apply resolutions (POST /sync/resolve) is deferred to a follow-up. The buttons will highlight the user's choice visually but will not yet write the resolution back. This is explicitly UI-only scaffolding.
 
 **Files:**
 - Modify: `packages/web/src/views/Sync.tsx`
 
 - [ ] **Step 1: Add accept ours/theirs buttons to conflict cards**
 
 In `packages/web/src/views/Sync.tsx`, the conflict card currently shows LOCAL/BASE/REMOTE in a 3-column grid but no action buttons. Add "使用本地" and "使用远程" buttons:
 
 Find the conflict card render (the `pullResult.files.map` block). In each conflict card, add a resolve bar after the 3-column grid:
 
 ```tsx
 // Add state for resolution choices
 const [resolutions, setResolutions] = useState<Record<string, 'ours' | 'theirs'>>({})
 
 // In each conflict card, after the 3-column grid div, add:
 <div style={{ display: 'flex', gap: 8, padding: '8px 14px', borderTop: '1px solid var(--border)', background: 'var(--nav)' }}>
   <button
     className="sbtn"
     style={resolutions[`${i}-${j}`] === 'ours' ? { borderColor: 'var(--signal)', color: 'var(--signal)' } : {}}
     onClick={() => setResolutions(prev => ({ ...prev, [`${i}-${j}`]: 'ours' }))}
   >使用本地</button>
   <button
     className="sbtn"
     style={resolutions[`${i}-${j}`] === 'theirs' ? { borderColor: 'var(--signal)', color: 'var(--signal)' } : {}}
     onClick={() => setResolutions(prev => ({ ...prev, [`${i}-${j}`]: 'theirs' }))}
   >使用远程</button>
 </div>
 ```
 
 - [ ] **Step 2: Manual test with test repo**
 
 This requires a conflict scenario to test properly. For now, verify the buttons render when conflicts exist by:
 1. Using the test remote `https://github.com/mxp-xc/my-loom.git`
 2. Making a local change that conflicts with remote
 3. Pulling and verifying the conflict UI shows with buttons
 
 If no conflict can be created easily, at minimum verify the pull works without crashing.
 
 - [ ] **Step 3: Request commit approval**
 
 Inform user: "Task 10 complete, ready to commit: add Sync conflict resolution buttons"
 
 ---
 
 ## Self-Review
 
 **1. Spec coverage check:**
 - Agent chip toggles (Skills): Task 7 ✓
 - Agent target toggles (MCP): Task 8 ✓
 - Add source with auto-scan: Task 4 + Task 7 ✓
 - Delete (source/skill/mcp): Task 3 + Task 7 ✓
 - Check for updates: Task 7 ✓ (uses existing `/update` endpoint)
 - Projection result not JSON dump: Task 7 ✓ (toast)
 - Settings [object Object] fix: Task 9 ✓
 - Settings editing: Task 6 + Task 9 ✓
 - Sync pull FETCH_HEAD fix: Task 2 ✓
 - Sync conflict resolution: Task 10 ✓
 - MCP clip-to-copy: Task 8 ✓
 - MCP headers display: Task 8 ✓
 - File-init safety: Task 1 ✓
 
 **Gaps (not covered in this plan, lower priority):**
 - Preview SKILL.md content (would need new endpoint + modal) — deferred
 - Projection link visualization (manifest ──▶ agent SVG) — deferred, visual polish
 - Semantic event stream in Sync — deferred
 - Variable interpolation `${VAR}` Combobox in MCP — deferred
 - Theme switcher position (currently in sidebar, spec says Settings) — acceptable
- Sync conflict apply backend (POST /sync/resolve) — deferred, Task 10 is UI-only
- Atomic YAML writes (temp file + rename) — deferred, current writeYaml is direct write
- PUT /config input validation for reserved fields (active_repo) — deferred
- Frontend automated tests (vitest jsdom) — deferred, all frontend verification is manual Playwright
 
 **2. Placeholder scan:** No "TBD" or "implement later" in task steps. Task 7 has high-level code patterns rather than full file content because Skills.tsx is ~270 lines — worker should implement the full file following the patterns. All other tasks have complete code.
 
 **3. Type consistency:** `scanSource` returns `{ members: ScanMember[] }` in both api.ts and routes.ts. `updateMcpTargets` / `updateSkillTargets` use `{ repoPath, id/targets }` consistent with routes. `putConfig` uses `{ repoPath, level, field, value }` consistent in both layers. `ConfigField` adds `repoPath` prop — Settings.tsx must pass it (Task 9 Step 2).
 
 ---
 
 ## Execution Handoff
 
 Plan complete and saved to `docs/superpowers/plans/2026-07-01-webui-fixes.md`. Two execution options:
 
 **1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
 
 **2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints
 
 **Which approach?**
 
 If Subagent-Driven chosen:
 - REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
 - Fresh subagent per task + two-stage review
 
 If Inline Execution chosen:
 - REQUIRED SUB-SKILL: Use superpowers:executing-plans
 - Batch execution with checkpoints for review
