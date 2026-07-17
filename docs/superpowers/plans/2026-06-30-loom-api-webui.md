# Loom API + WebUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 HTTP API 层(Hono,投影/同步/安装/更新/配置端点,调用 Plan 1-3 层)+ React WebUI(Vite + Tailwind v4 + shadcn/ui,四视图 + 三态主题 + Settings 两级配置三态展示),API 生产时静态服务 WebUI dist。

**Architecture:** API 层 Hono 路由装配 Plan 1-3 的 executeProjection/syncPull/syncPush/installSkill/checkUpdates/performUpdate/buildManifest/planProjection;WebUI 走 /api/... 相对路径,dev Vite proxy、prod API 静态服务。TDD(vitest),前端组件用 playwright-cli 验证(spec 行 374 三端无坑待实测)。

**Tech Stack:** Hono + @hono/node-server(API),React + Vite + Tailwind v4 + shadcn/ui(WebUI,spec 已定),React Router,Plan 1-3 全部层

## Global Constraints

- 继承 Plan 1-3 Global Constraints(snake_case、ESM import .js、pnpm vitest、Core 零平台依赖、日志 catch 带完整对象不静默)
- 引入 Hono + @hono/node-server(API 层,TS-first 轻量 ESM 友好);WebUI 栈 spec 已定(React + Vite + Tailwind v4 + shadcn/ui)
- 三态主题自写 ThemeProvider(React Context + localStorage + matchMedia,亮色默认,不引 next-themes);spec 行 394 用 `data-theme` 属性(非 .dark class):Tailwind v4 `@custom-variant dark (&:is([data-theme=dark] *))`(shadcn init 后手动改),ThemeProvider/no-flash 用 `setAttribute('data-theme', ...)`;index.html no-flash 内联脚本
- WebUI/API 集成:dev Vite server.proxy `/api` → API;prod API 用 @hono/node-server/serveStatic 静态服务 webui/dist(两规则 SPA fallback);WebUI 统一用 `/api/...` 相对路径
- API 端点只做 HTTP 编解码 + 调用 Plan 1-3 层 + 依赖装配(NodePlatform + adapters);不写业务逻辑
- shadcn/ui 用 `pnpm dlx shadcn@latest init`(Tailwind v4 + `@` 别名);组件按需 add
- Settings 两级配置三态展示(最终结果/仓库级/本地级,sdot 四态标识,见 spec 行 100-130/401-410):最终结果=mergeConfig(repo,local),仓库级读 repo config,本地级读 local config;左 sdot 标识来源(空心灰=继承/实心蓝=覆盖/实心蓝锁=固定/绿=生效自仓库级)
- 时间格式/日志规范继承 CLAUDE.md(中国时区,日志到秒,catch 记完整对象)
- WebUI 测试需 jsdom(每个 webui 测试文件加 `// @vitest-environment jsdom`,Plan 1 vitest.config 默认 node);webui 作 pnpm workspace 子包(根 pnpm-workspace.yaml `packages: [webui]`);webui 测试在根跑用 `pnpm vitest run tests/webui/...`(不用 `--filter`)
- serveStatic root 绝对路径在 Win/Mac/Linux 均可用(@hono/node-server serveStatic 内部用 `path.join(root, filename)`,不丢弃 root;无需 rewriteRequestPath);本 plan 假定 Win/Mac 开发

---

## File Structure

- `src/api/server.ts` — Hono app + 路由装配 + 静态服务 webui/dist + startApiServer
- `src/api/deps.ts` — 装配 NodePlatform(fs/git/proc) + 3 adapters + 投影/同步/远程依赖注入
- `src/api/routes.ts` — 端点(project/sync/install/update/config/health)
- `webui/index.html` — no-flash 内联脚本 + #root
- `webui/vite.config.ts` — React + Tailwind v4 + @ 别名 + dev proxy /api
- `webui/src/main.tsx` / `App.tsx` — 入口 + ThemeProvider + Router
- `webui/src/theme.tsx` — ThemeProvider(三态,亮色默认)
- `webui/src/lib/api.ts` — /api 客户端(fetch 相对路径)
- `webui/src/views/{Skills,Mcp,Sync,Settings}.tsx` — 四视图
- `webui/src/components/ui/` — shadcn 组件
- `tests/api/*.test.ts` — API 单测

---

## Task 1: API 服务器(Hono + 路由装配 + 静态服务)

**Files:**

- Create: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

**Interfaces:**

- Consumes: Hono + @hono/node-server;routes(Task 2)
- Produces: `createApp(): Hono`(路由装配 + 静态服务 SPA fallback)、`startApiServer(port?): Promise<import('http').Server>`。被 CLI/启动消费

**前置:安装 API 依赖**(第 2 轮 review 发现第 1 轮漏装 Hono,否则 Task 1 起所有 API 测试 `ERR_MODULE_NOT_FOUND`):

```bash
pnpm add hono @hono/node-server
```

- [ ] **Step 1: 写失败测试**

```typescript
// tests/api/server.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createApp } from '../../src/api/server'

// mock routes.js(其依赖 Plan 1-3 全部模块,仓库尚无 src/);Task 1 仅验静态服务 + SPA fallback + API 404,不触达 Plan 1-3
vi.mock('../../src/api/routes.js', () => ({
  registerRoutes: () => new Hono().get('/health', (c) => c.json({ ok: true })),
}))

let webuiDist: string
beforeEach(async () => {
  webuiDist = await mkdtemp(join(tmpdir(), 'webui-'))
  await writeFile(join(webuiDist, 'index.html'), '<html><body>SPA</body></html>')
  await mkdir(join(webuiDist, 'assets'), { recursive: true })
  await writeFile(join(webuiDist, 'assets', 'app.js'), 'console.log(1)')
  process.env.LOOM_WEBUI_DIST = webuiDist
})
afterEach(async () => {
  delete process.env.LOOM_WEBUI_DIST
  await rm(webuiDist, { recursive: true, force: true }).catch(() => {})
})

describe('createApp', () => {
  it('GET /api/health returns ok', async () => {
    const res = await createApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('serves static asset from webui dist', async () => {
    const res = await createApp().request('/assets/app.js')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('console.log(1)')
  })
  it('SPA fallback: unknown non-api route returns index.html', async () => {
    const res = await createApp().request('/skills/frontend-design')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<html')
  })
  it('api 404 returns json not index.html', async () => {
    const res = await createApp().request('/api/nonexistent')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/api/server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/api/server.ts
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { registerRoutes } from './routes.js'

export function createApp(): Hono {
  const app = new Hono()
  app.use('*', logger())
  app.route('/api', registerRoutes()) // health 在 registerRoutes 内(/api/health)
  const dist =
    process.env.LOOM_WEBUI_DIST ?? fileURLToPath(new URL('../../webui/dist/', import.meta.url))
  app.use('/assets/*', serveStatic({ root: dist }))
  app.get('/favicon.ico', (c) => c.body(null, 204)) // 缺 favicon 返 204,避免落 SPA fallback 返 index.html
  // SPA fallback + API 404:/api/* 未匹配返 JSON 404;其余 GET 返 index.html(不吞 /api)
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404)
    return c.html(await readFile(join(dist, 'index.html'), 'utf8'))
  })
  return app
}

export function startApiServer(port = Number(process.env.LOOM_PORT ?? 3000)) {
  return import('@hono/node-server').then(({ serve }) =>
    serve({ fetch: createApp().fetch, port }, (info) =>
      console.log(`Loom API on http://localhost:${info.port}`),
    ),
  )
}
```

> 注:`serveStatic({ root: dist })` 传绝对路径在 Win/Mac/Linux 均可用(@hono/node-server serveStatic 内部用 `path.join(root, filename)`,不丢弃 root;无需 rewriteRequestPath)。测试 SPA fallback 用 `LOOM_WEBUI_DIST` env 指向临时 dist。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/api/server.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat(api): Hono app + route assembly + static SPA fallback"
```

---

## Task 2: API 端点(调用 Plan 1-3 层)

**Files:**

- Create: `src/api/routes.ts`, `src/api/deps.ts`
- Test: `tests/api/routes.test.ts`

**Interfaces:**

- Consumes: Plan 1-3 的 `executeProjection`/`resolveFullLinks`/`scanSourceMembers`/`syncPull`/`syncPush`/`installSkill`/`checkUpdates`/`performUpdate`/`buildManifest`/`planProjection`/`loadRepoManifest`/`mergeConfig`;Hono
- Produces: `registerRoutes(): Hono` — POST /api/project、POST /api/sync/pull、POST /api/sync/push、POST /api/install、POST /api/update、GET/PUT /api/config;`createDeps(repoPath): ProjectionDeps` 装配 NodePlatform + adapters

- [ ] **Step 1: 写失败测试**

```typescript
// tests/api/routes.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRoutes } from '../../src/api/routes'

// mock Plan 1-3 层,只验 API 编解码 + 调用
vi.mock('../../src/projection/executor.js', () => ({
  executeProjection: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/sync/pull.js', () => ({
  syncPull: vi.fn(async () => ({ files: [], varsFiles: [], textConflicts: [], clean: true })),
}))
vi.mock('../../src/sync/push.js', () => ({ syncPush: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../src/core/manifest.js', () => ({
  loadRepoManifest: vi.fn(() => ({ repoConfig: { targets: ['claude-code'] }, errors: [] })),
  mergeConfig: vi.fn((repo: Record<string, unknown>) => ({ ...repo, active_repo: 'default' })),
  buildManifest: vi.fn(),
}))
vi.mock('../../src/platform/node/index.js', () => ({
  createNodePlatform: vi.fn(() => ({ fs: {}, git: {}, proc: {} })),
}))

describe('API routes', () => {
  const app = new Hono().route('/api', registerRoutes())

  it('POST /api/project calls executeProjection, returns result', async () => {
    const res = await app.request('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: '/tmp/r',
        manifest: {
          skills: { sources: [], skills: [] },
          mcp: [],
          vars: { default: {}, active: {} },
          config: {},
          errors: [],
        },
        varsCtx: { env: {}, activeProfile: {}, defaultProfile: {} },
        plan: { links: [], mcpEntries: [], skippedAgents: [], strategy: 'link' },
        installedAgents: ['claude-code'],
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
  it('POST /api/sync/pull returns PullResult', async () => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clean).toBe(true)
  })
  it('POST /api/sync/push returns {ok}', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: '/tmp/r' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
  it('GET /api/config returns effective + repo + local config (三态)', async () => {
    // mock loadRepoManifest/buildManifest/mergeConfig
    const res = await app.request('/api/config?repoPath=/tmp/r')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('effective')
    expect(body).toHaveProperty('repo')
    expect(body).toHaveProperty('local')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/api/routes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/api/deps.ts
import { join } from 'node:path'
import { createNodePlatform } from '../platform/node/index.js'
import { ClaudeCodeAdapter } from '../adapters/claude-code.js'
import { CodexAdapter } from '../adapters/codex.js'
import { OpenCodeAdapter } from '../adapters/opencode.js'
import type { ProjectionDeps } from '../projection/executor.js'
import type { AgentId } from '../core/types.js'

// 装配 NodePlatform + 3 adapters;resolveSkillSrc 由 API 层按 link.source 构造(不跨 HTTP 传函数)+ logger(不静默)
export function createDeps(repoPath: string, installedAgents: Set<AgentId>): ProjectionDeps {
  const platform = createNodePlatform()
  return {
    fs: platform.fs,
    adapters: {
      'claude-code': new ClaudeCodeAdapter(),
      codex: new CodexAdapter(),
      opencode: new OpenCodeAdapter(),
    },
    installedAgents,
    resolveSkillSrc: (link) => {
      if (link.source === 'local') return join(repoPath, 'assets', 'skills', link.skillId)
      const { repoId, memberName } = link.source
      return join(repoPath, 'remote-cache', repoId, 'skills', memberName) // 简化:实际 member path 由 scan 决定,Plan 2 scanSourceMembers 返回
    },
    logger: { error: (o, m) => console.error(m, o), warn: (o, m) => console.warn(m, o) },
  }
}
```

```typescript
// src/api/routes.ts
import { Hono } from 'hono'
import { executeProjection } from '../projection/executor.js'
import { syncPull } from '../sync/pull.js'
import { syncPush } from '../sync/push.js'
import { installSkill } from '../remote/install.js'
import { checkUpdates, performUpdate } from '../remote/update.js'
import { loadRepoManifest, mergeConfig } from '../core/manifest.js'
import { createNodePlatform } from '../platform/node/index.js'
import { createDeps } from './deps.js'
import type { AgentId } from '../core/types.js'

export function registerRoutes(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/project', async (c) => {
    const { repoPath, manifest, varsCtx, plan, installedAgents } = await c.req.json()
    const deps = createDeps(repoPath, new Set(installedAgents as AgentId[])) // resolveSkillSrc 由 API 层构造,不跨 HTTP
    const res = await executeProjection(plan, manifest, varsCtx, deps)
    return c.json(res)
  })

  app.post('/sync/pull', async (c) => {
    const { repoPath } = await c.req.json()
    const { git, fs } = createNodePlatform()
    const res = await syncPull(repoPath, git, fs, {
      error: (o, m) => console.error(m, o),
      warn: (o, m) => console.warn(m, o),
    })
    return c.json(res)
  })

  app.post('/sync/push', async (c) => {
    const { repoPath } = await c.req.json()
    const { git } = createNodePlatform()
    const res = await syncPush(repoPath, git)
    return c.json(res)
  })

  app.post('/install', async (c) => {
    const { url, ref, repoPath, sourceId } = await c.req.json()
    const { git, fs } = createNodePlatform()
    const res = await installSkill(git, fs, url, ref, repoPath, sourceId)
    return c.json(res) // {pinned_commit, cacheDir};caller(前端)写 skills.yaml + 投影
  })

  app.post('/update', async (c) => {
    const { sources } = await c.req.json()
    const { git } = createNodePlatform()
    const updates = await checkUpdates(sources, git)
    return c.json({ updates })
  })

  // 执行更新:fetch+checkout 新 ref + orphan 检测;caller(前端)据返回改 skills.yaml ref+pinned_commit + 重建投影 + orphan 覆盖项保留 UI(spec 行 298-299)
  app.post('/update/perform', async (c) => {
    const { source, newRef, repoPath, sourceId, oldMembers } = await c.req.json()
    const { git, fs } = createNodePlatform()
    const res = await performUpdate(git, fs, source, newRef, repoPath, sourceId, oldMembers)
    return c.json(res)
  })

  // GET /api/config?repoPath=... 返回三态:effective(mergeConfig) + repo + local
  app.get('/config', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const { fs } = createNodePlatform()
    const repoManifest = loadRepoManifest(/* 读 repoPath 下 yaml */ {} as any) // 简化:实际读文件
    const localConfig = {} as any // 读 ~/.loom/config.yaml
    const effective = mergeConfig(repoManifest.repoConfig, localConfig)
    return c.json({ effective, repo: repoManifest.repoConfig, local: localConfig })
  })

  // GET /api/manifest?repoPath=... 返回完整 manifest(skills/mcp/vars/config,供 Skills/Mcp 视图渲染;实际文件 IO 留执行)
  app.get('/manifest', async (c) => {
    const repoPath = c.req.query('repoPath')!
    const manifest = loadRepoManifest(/* 读 repoPath 下 yaml */ {} as any)
    return c.json(manifest)
  })

  // PUT /api/config 写配置:body { repoPath, level: 'repo'|'local', field, value }
  // value=null 表示删本地级行回退继承(spec 行 129,非设空字符串);level=local 写 ~/.loom/config.yaml,level=repo 写 repoPath/config.yaml
  // 实际文件 IO(set/delete field + 写回)留执行,本端点给契约供前端调用
  app.put('/config', async (c) => {
    const { repoPath, level, field, value } = await c.req.json()
    return c.json({ ok: true, repoPath, level, field, value })
  })

  return app
}
```

> 注:routes 的 `loadRepoManifest`/`localConfig` 读取需实际文件 IO(读 repoPath 下 *.yaml + ~/.loom/config.yaml),MVP 用简化占位,执行时补全。`/update` 只做检测;执行更新(performUpdate)由前端确认后单独端点触发。`resolveSkillSrc` 由前端传字符串、API 层转函数(简化)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/api/routes.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/api/routes.ts src/api/deps.ts tests/api/routes.test.ts
git commit -m "feat(api): endpoints (project/sync/install/update/config) wiring Plan 1-3"
```

---

## Task 3: WebUI 脚手架(Vite + React + Tailwind v4 + shadcn)

**Files:**

- Create: `webui/package.json`, `webui/vite.config.ts`, `webui/tsconfig.json`, `webui/src/index.css`, `webui/src/main.tsx`, `webui/src/App.tsx`

**Interfaces:**

- Produces: WebUI 工程骨架(Vite + React + Tailwind v4 + shadcn/ui + `@` 别名 + dev proxy /api + 基础 App 渲染)。被 Task 4-6 消费

- [ ] **Step 1: 初始化工程**

```bash
mkdir -p webui && cd webui
pnpm create vite@latest . --template react-ts   # 生成 tsconfig.json + tsconfig.app.json + tsconfig.node.json 三件套(勿覆盖)
pnpm install
pnpm add -D tailwindcss @tailwindcss/vite @types/node jsdom @testing-library/react @testing-library/jest-dom tw-animate-css
pnpm add react-router-dom
```

> 注:① webui 测试用 @testing-library/react 需 jsdom,每个 webui 测试文件顶部加 `// @vitest-environment jsdom`(Plan 1 vitest.config 默认 node)。② `@` 别名需同时加到 `tsconfig.json` 与 `tsconfig.app.json` 的 `paths`(shadcn 要求,勿用单文件 tsconfig 覆盖三件套)。③ webui 作 pnpm workspace 子包:根 `pnpm-workspace.yaml` 加 `packages: [webui]`;pnpm 默认不 hoist react 到根 node_modules 顶层,根跑 `tests/webui/*.test.tsx` 需在根 `.npmrc` 加 `public-hoist-pattern[]=react*`、`public-hoist-pattern[]=react-dom`、`public-hoist-pattern[]=@testing-library*`(或根 package.json 加这些 devDep),否则 `Cannot find module 'react'`;webui 测试在根跑用 `pnpm vitest run tests/webui/...`(不用 `--filter`)。

- [ ] **Step 2: 配置 Tailwind v4 + `@` 别名 + dev proxy**

```ts
// webui/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) } }, // ESM 不用 __dirname
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } }, // dev:WebUI → API
  },
})
```

```json
// webui/tsconfig.json 顶层加 compilerOptions.baseUrl+paths(solution-style references 不破坏,shadcn init 读 tsconfig.json 解析 @/*;勿加 target/module/include—已在 tsconfig.app.json)
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }
}
```

```json
// webui/tsconfig.app.json 的 compilerOptions 内同步加 baseUrl+paths(Vite 模板已含 target/module/strict/jsx 等,仅追加这两项)
{
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }
}
```

```css
/* webui/src/index.css(Step 2 仅 @import tailwindcss;@custom-variant/tw-animate-css/:root/.dark 由 Step 3 shadcn init 写入,Step 2 写了会被覆盖) */
@import 'tailwindcss';
```

- [ ] **Step 3: shadcn init + 基础组件**

```bash
pnpm dlx shadcn@latest init   # 生成 components.json + 写 index.css(:root/.dark/@theme inline + @custom-variant dark + tw-animate-css)
pnpm dlx shadcn@latest add button card tabs dropdown-menu
```

shadcn init 后手动改 `webui/src/index.css` 的 `@custom-variant dark` 行为 data-theme 方案(spec 行 394,ThemeProvider 用 setAttribute('data-theme')):

```css
@custom-variant dark (&:is([data-theme=dark] *));
```

(shadcn init 默认写 `(&:is(.dark *))`,改 `[data-theme=dark]` 对齐 ThemeProvider 的 data-theme 属性,否则 dark 模式样式不生效)

````

- [ ] **Step 4: 写 App 骨架 + 测试**

```tsx
// webui/src/App.tsx
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'

// AppRoutes 不含 Router(测试包 MemoryRouter,避免 React Router v6 嵌套 Router 抛 invariant);main.tsx 用 App(包 BrowserRouter)
export function AppRoutes() {
  return (
    <>
      <nav className="flex gap-2 p-2 border-b">
        <NavLink to="/skills">Skills</NavLink>
        <NavLink to="/mcp">MCP</NavLink>
        <NavLink to="/sync">Sync</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <Routes>
        <Route path="/skills" element={<div>Skills 视图(占位)</div>} />
        <Route path="/mcp" element={<div>MCP 视图(占位)</div>} />
        <Route path="/sync" element={<div>Sync 视图(占位)</div>} />
        <Route path="/settings" element={<div>Settings 视图(占位)</div>} />
        <Route path="*" element={<div>Loom</div>} />
      </Routes>
    </>
  )
}

export default function App() {
  return <BrowserRouter><AppRoutes /></BrowserRouter>
}
````

```tsx
// webui/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

测试(playwright-cli 端到端验证,spec 要求前端验证用 playwright-cli):

```bash
# 启动 API(3000)+ WebUI dev(5173),用 playwright-cli 截图验证四导航可点
pnpm vitest run tests/webui/app.test.tsx  # 组件单测:render App 断言 4 个 NavLink(根目录跑,不用 --filter)
```

```tsx
// tests/webui/app.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from '../../webui/src/App'

describe('App', () => {
  it('renders 4 nav links', () => {
    render(
      <MemoryRouter>
        <AppRoutes />
      </MemoryRouter>,
    )
    // exact:true 精确匹配 NavLink 文本,避免子串匹配占位 div(MemoryRouter 默认 "/" 只渲染 Loom 占位)
    expect(screen.getByText('Skills', { exact: true })).toBeDefined()
    expect(screen.getByText('MCP', { exact: true })).toBeDefined()
    expect(screen.getByText('Sync', { exact: true })).toBeDefined()
    expect(screen.getByText('Settings', { exact: true })).toBeDefined()
  })
})
```

- [ ] **Step 5: 提交**

```bash
git add webui/ tests/webui/app.test.tsx
git commit -m "feat(webui): scaffold Vite + React + Tailwind v4 + shadcn + router"
```

---

## Task 4: 三态主题(ThemeProvider + no-flash)

**Files:**

- Create: `webui/src/theme.tsx`
- Modify: `webui/index.html`(no-flash 脚本)、`webui/src/main.tsx`(包 ThemeProvider)

**Interfaces:**

- Produces: `ThemeProvider`(三态 dark/light/system,亮色默认,localStorage 持久化,matchMedia 监听)、`useTheme()` hook。被 Task 5-6 消费

- [ ] **Step 1: 写失败测试**

```tsx
// tests/webui/theme.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { render } from '@testing-library/react'
import { ThemeProvider, useTheme } from '../../webui/src/theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  // jsdom 无 matchMedia,stub 完整实现(含 addEventListener/removeEventListener,供 system 模式监听)
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('dark'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('ThemeProvider', () => {
  it('default theme is light (spec:亮色默认)', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    })
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
  it('setTheme("dark") sets data-theme=dark + persists', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    })
    act(() => result.current.setTheme('dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('loom-theme')).toBe('dark')
  })
  it('system theme follows matchMedia', () => {
    renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider defaultTheme="system">{children}</ThemeProvider>,
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark') // matchMedia stub matches=true -> prefers dark
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/webui/theme.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```tsx
// webui/src/theme.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'dark' | 'light' | 'system'
const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null)

export function ThemeProvider({
  children,
  defaultTheme = 'light',
  storageKey = 'loom-theme',
}: {
  children: ReactNode
  defaultTheme?: Theme
  storageKey?: string
}) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme,
  )

  useEffect(() => {
    const root = document.documentElement
    const applied =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    root.setAttribute('data-theme', applied) // spec 行 394:data-theme 属性方案(非 .dark class,shadcn init 后 @custom-variant 同步改)
  }, [theme])

  // system 模式监听系统变化
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = (t: Theme) => {
    localStorage.setItem(storageKey, t)
    setThemeState(t)
  }
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
```

`webui/index.html` `<head>` 加 no-flash 内联脚本(React 挂载前先定 class):

```html
<script>
  ;(function () {
    var t = localStorage.getItem('loom-theme') || 'light'
    var d =
      t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t
    document.documentElement.setAttribute('data-theme', d)
  })()
</script>
```

`webui/src/main.tsx` 用 `<ThemeProvider defaultTheme="light">` 包 App。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/webui/theme.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webui/src/theme.tsx webui/index.html webui/src/main.tsx tests/webui/theme.test.tsx
git commit -m "feat(webui): three-state theme provider (light default, system matchMedia, no-flash)"
```

---

## Task 5: 四视图 + api 客户端

**Files:**

- Create: `webui/src/lib/api.ts`, `webui/src/views/{Skills,Mcp,Sync}.tsx`
- Modify: `webui/src/App.tsx`(挂视图)

**Interfaces:**

- Consumes: `/api/...` 端点(Task 2)、shadcn 组件
- Produces: `api` 客户端(fetch 相对路径)、Skills/Mcp/Sync 三视图(Settings 在 Task 6)

- [ ] **Step 1: 写失败测试**

```tsx
// tests/webui/views.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Skills from '../../webui/src/views/Skills'

vi.mock('../../webui/src/lib/api', () => ({
  api: {
    project: vi.fn(async () => ({ ok: true })),
    getSkills: vi.fn(async () => ({ sources: [], skills: [] })),
  },
}))

describe('Skills view', () => {
  it('renders skills list + project button', async () => {
    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    )
    expect(await screen.findByText('投影')).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/webui/views.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```ts
// webui/src/lib/api.ts
const base = '/api'
export const api = {
  project: (body: unknown) =>
    fetch(`${base}/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  syncPull: (repoPath: string) =>
    fetch(`${base}/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath }),
    }).then((r) => r.json()),
  syncPush: (repoPath: string) =>
    fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath }),
    }).then((r) => r.json()),
  install: (body: unknown) =>
    fetch(`${base}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  update: (sources: unknown[]) =>
    fetch(`${base}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources }),
    }).then((r) => r.json()),
  getConfig: (repoPath: string) =>
    fetch(`${base}/config?repoPath=${encodeURIComponent(repoPath)}`).then((r) => r.json()),
}
```

```tsx
// webui/src/views/Skills.tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

export default function Skills() {
  const [result, setResult] = useState<unknown>(null)
  const project = async () =>
    setResult(await api.project({/* repoPath/manifest/plan 等,实际由 App 上下文提供 */}))
  return (
    <div className="p-4">
      <h1 className="mb-2 text-xl font-bold">Skills</h1>
      <Button onClick={project}>投影</Button>
      {result != null && <pre className="mt-2 text-sm">{JSON.stringify(result)}</pre>}
    </div>
  )
}
```

```tsx
// webui/src/views/Mcp.tsx
export default function Mcp() {
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold">MCP</h1>
      <p>MCP server 列表(调 /api/manifest 渲染 mcp 段)</p>
    </div>
  )
}
```

```tsx
// webui/src/views/Sync.tsx
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useState } from 'react'

export default function Sync() {
  const [pull, setPull] = useState<unknown>(null)
  const [push, setPush] = useState<unknown>(null)
  const repoPath = '/tmp/repo' // 实际由 App 上下文(active_repo)提供
  return (
    <div className="space-y-2 p-4">
      <h1 className="text-xl font-bold">Sync</h1>
      <div className="flex gap-2">
        <Button onClick={async () => setPull(await api.syncPull(repoPath))}>拉取</Button>
        <Button onClick={async () => setPush(await api.syncPush(repoPath))}>上传</Button>
      </div>
      {pull != null && <pre className="text-sm">{JSON.stringify(pull)}</pre>}
      {push != null && <pre className="text-sm">{JSON.stringify(push)}</pre>}
      {/* 冲突三栏 UI:pull.files[].result.conflicts 非空(结构化)或 pull.textConflicts 非空(assets 文本)时渲染本地/合并/远程三栏,文本冲突提供三入口(VSCode/终端/复制 path) */}
    </div>
  )
}
```

`App.tsx` 把占位 div 换成 `<Skills/>`/`<Mcp/>`/`<Sync/>`/`<Settings/>`(Settings Task 6)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/webui/views.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webui/src/lib/api.ts webui/src/views/ webui/src/App.tsx tests/webui/views.test.tsx
git commit -m "feat(webui): Skills/Mcp/Sync views + api client"
```

---

## Task 6: Settings 两级配置三态展示

**Files:**

- Create: `webui/src/views/Settings.tsx`, `webui/src/components/ConfigField.tsx`
- Test: `tests/webui/settings.test.tsx`

**Interfaces:**

- Consumes: `api.getConfig`(Task 5)、spec 行 100-130/401-410 三态模型(最终结果/仓库级/本地级 + sdot 四态)
- Produces: Settings 视图(三态切换 tab + 字段三态展示 + sdot 标识 + 本地级编辑/删除)

- [ ] **Step 1: 写失败测试**

```tsx
// tests/webui/settings.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Settings from '../../webui/src/views/Settings'

vi.mock('../../webui/src/lib/api', () => ({
  api: {
    getConfig: vi.fn(async () => ({
      effective: { active_repo: 'default', targets: ['claude-code'] }, // mergeConfig 结果
      repo: { targets: ['claude-code'] }, // 仓库级
      local: { active_repo: 'default' }, // 本地级
    })),
  },
}))

describe('Settings', () => {
  it('renders three state tabs (最终结果/仓库级/本地级)', async () => {
    render(<Settings repoPath="/tmp/r" />)
    expect(await screen.findByText('最终结果')).toBeDefined()
    expect(screen.getByText('仓库级')).toBeDefined()
    expect(screen.getByText('本地级')).toBeDefined()
  })
  it('sdot: effective tab active_repo 标锁, targets 生效自仓库标绿', async () => {
    render(<Settings repoPath="/tmp/r" />)
    await screen.findByText('最终结果')
    // active_repo fixed -> sdot fixed;targets inRepo(!inLocal) -> sdot repo(绿,生效自仓库级,spec 行 426)
    expect(document.querySelector('.sdot.fixed')).not.toBeNull()
    expect(document.querySelector('.sdot.repo')).not.toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/webui/settings.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```tsx
// webui/src/views/Settings.tsx
import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { ConfigField } from '@/components/ConfigField'

type Level = 'effective' | 'repo' | 'local'

export default function Settings({ repoPath }: { repoPath: string }) {
  const [cfg, setCfg] = useState<{
    effective: Record<string, unknown>
    repo: Record<string, unknown>
    local: Record<string, unknown>
  } | null>(null)
  const [level, setLevel] = useState<Level>('effective')
  useEffect(() => {
    api.getConfig(repoPath).then(setCfg)
  }, [repoPath])
  if (!cfg) return <div className="p-4">加载中…</div>

  const allFields = Object.keys({ ...cfg.repo, ...cfg.local, ...cfg.effective })
  const fields = level === 'repo' ? allFields.filter((f) => f !== 'active_repo') : allFields // 仓库级 tab 隐藏固定本地字段 active_repo(spec 行 127)
  return (
    <div className="p-4">
      <h1 className="mb-2 text-xl font-bold">Settings</h1>
      <Tabs value={level} onValueChange={(v) => setLevel(v as Level)}>
        <TabsList>
          <TabsTrigger value="effective">最终结果</TabsTrigger>
          <TabsTrigger value="repo">仓库级</TabsTrigger>
          <TabsTrigger value="local">本地级</TabsTrigger>
        </TabsList>
        <TabsContent value={level} className="mt-2 space-y-2">
          {fields.map((f) => (
            <ConfigField
              key={f}
              name={f}
              level={level}
              value={(cfg[level] as Record<string, unknown>)[f]}
              inRepo={f in cfg.repo}
              inLocal={f in cfg.local}
              fixed={f === 'active_repo'} /* active_repo 固定本地级 */
            />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

```tsx
// webui/src/components/ConfigField.tsx
// sdot 四态(spec 行 426):实心蓝锁=固定(active_repo)、绿=生效自仓库级、实心蓝=生效自本地级/本地覆盖、空心灰=继承/两处未设
type Level = 'effective' | 'repo' | 'local'
export function ConfigField({
  name,
  value,
  level,
  inRepo,
  inLocal,
  fixed,
}: {
  name: string
  value: unknown
  level: Level
  inRepo: boolean
  inLocal: boolean
  fixed: boolean
}) {
  let dotClass = '',
    title = ''
  if (fixed) {
    dotClass = 'sdot fixed'
    title = '固定本地级'
  } else if (level === 'effective') {
    if (inLocal) {
      dotClass = 'sdot local'
      title = '生效自本地级'
    } else if (inRepo) {
      dotClass = 'sdot repo'
      title = '生效自仓库级'
    } else {
      dotClass = 'sdot inherit'
      title = '两处未设'
    }
  } else if (level === 'local') {
    dotClass = inLocal ? 'sdot local' : 'sdot inherit'
    title = inLocal ? '本地覆盖' : '继承仓库级'
  } // repo tab 无 sdot(active_repo 固定字段已在 Settings 过滤不展示)
  return (
    <div className="flex items-center gap-2">
      {dotClass && <span className={dotClass} title={title} />}
      <span className="w-40 text-sm">{name}</span>
      <span className="text-muted-foreground text-sm">{String(value ?? '(空)')}</span>
    </div>
  )
}
```

`webui/src/index.css` 加 sdot 样式(空心灰/实心蓝/锁/绿,见 brainstorm 的 loom-settings.html):

```css
.sdot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid #999;
}
.sdot.inherit {
  background: transparent;
} /* 空心灰:继承 */
.sdot.local {
  background: #3b82f6;
  border-color: #3b82f6;
} /* 实心蓝:本地覆盖 */
.sdot.fixed {
  background: #3b82f6;
  border-color: #3b82f6;
} /* 实心蓝锁:固定(active_repo) */
.sdot.repo {
  background: #22c55e;
  border-color: #22c55e;
} /* 绿:生效自仓库级 */
```

> 注:本地级字段编辑/删除(删行回退继承,spec 行 129)+ active_repo 三态都有 fhelp 等细节,按 brainstorm 的 loom-settings.html 最终版实现,本 task 给骨架 + sdot 状态判定核心;视觉细节用 playwright-cli 实测(spec 行 374 三端无坑待实测)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/webui/settings.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add webui/src/views/Settings.tsx webui/src/components/ConfigField.tsx webui/src/index.css tests/webui/settings.test.tsx
git commit -m "feat(webui): Settings three-state config view + sdot status"
```

---

## Self-Review

**1. Spec coverage** (Plan 4 覆盖范围):

- HTTP API(投影/同步/安装/更新/配置端点,调用 Plan 1-3 层)→ Task 1/2 ✓(/api/config 实际 IO 留执行)
- WebUI 脚手架(React + Vite + Tailwind v4 + shadcn/ui + workspace + jsdom)→ Task 3 ✓
- 三态主题(暗/亮/系统,亮色默认,no-flash)→ Task 4 ✓
- 四视图(Skills/Mcp/Sync/Settings)→ Task 5/6 ✓(布局骨架;Skills 分组/chip/Dialog、Mcp master-detail 留执行)
- Settings 两级配置三态展示(最终结果/仓库级/本地级 + sdot 四态,spec 行 100-130/401-410)→ Task 6 ✓(三态切换 + sdot 骨架;effective 来源四态判定 + 编辑/删除留执行)
- API 生产静态服务 WebUI dist(SPA fallback 排除 /api)→ Task 1 ✓
- WebUI/API 集成(dev proxy / prod 静态)→ Task 1/3 ✓
- 冲突三栏 UI + 文本冲突三入口(spec 行 258)→ Task 5 Sync 骨架(完整交互留执行)

**2. Placeholder scan**: 无 TBD/TODO。routes 的 `/api/config` 用 `loadRepoManifest({} as any)` 简化占位(注明执行时读 repoPath yaml + ~/.loom/config.yaml);Sync 冲突三栏 + Settings 编辑/删除给骨架(sdot 状态判定 + 三态切换核心),完整交互按 brainstorm loom-settings.html + playwright-cli 实测(spec 行 374);createDeps 的 resolveSkillSrc 对 source member 用 `remote-cache/<repoId>/skills/<memberName>` 简化(实际 member path 由 Plan 2 scanSourceMembers 返回)。前端测试 vitest(@testing-library/react,jsdom)+ playwright-cli。

**3. Type consistency**: `createApp`/`registerRoutes`/`createDeps(repoPath, installedAgents)`(resolveSkillSrc 由 API 构造,不跨 HTTP)跨 task 一致;复用 Plan 1-3 全部层;WebUI `api` 客户端与端点契约对齐(project 不传 resolveSkillSrc);ThemeProvider/ConfigField 签名一致。snake_case 继承(active_repo)。

**4. 三方包调研结论**: Hono + @hono/node-server(API)引入;WebUI 栈 spec 已定(React + Vite + Tailwind v4 + shadcn/ui);三态主题自写 ThemeProvider(不引 next-themes);静态服务 serveStatic(SPA fallback app.get('*') 排除 /api + readFile index.html);shadcn `pnpm dlx shadcn@latest init`。Core 层(Plan 1)仍零平台依赖。

**5. 第 2 轮 review 修复**: Hono 安装前置(blocker,第 1 轮漏装)、Task1 测试 mock routes.js 解耦 Plan1-3(blocker)、/api/config 测试补 manifest+platform mock(blocker)、Router 拆 AppRoutes 避免嵌套崩(blocker)、ConfigField level/inRepo/inLocal props(tsc 挂 + sdot 四态 blocker)、主题 data-theme(spec 394,blocker)、routes.ts 删死 import(buildManifest/planProjection)、测试 body 删 resolveSkillSrc、tsconfig 三件套不破坏 references、tw-animate-css 装入、pnpm hoist .npmrc、index.css 顺序(shadcn init 覆盖)、sdot 四态加 inRepo/inLocal + 测试验具体类名、加 /api/update/perform + PUT /api/config + GET /api/manifest 端点、Sync 字段名 textConflicts/files、favicon 204、serveStatic 无需 rewriteRequestPath、LOOM_WEBUI_DIST afterEach 清理、getByText exact、jsdom matchMedia stub、startApiServer 返回类型 Promise<Server>。
第 1 轮修复: createApp SPA fallback 排除 /api + API 404 JSON + 删 health 重复、createDeps resolveSkillSrc 构造 + logger、/project 不传 resolveSkillSrc、vite.config fileURLToPath、Task 3 加 @types/node + jsdom + @testing-library/react + workspace + pnpm vitest。

**未覆盖(留给执行/后续)**: routes `/api/config` `/api/manifest` `/api/update/perform` 实际文件 IO(读 repoPath yaml + ~/.loom/config.yaml + 写回 set/delete field)、PUT /api/config 实际写文件、install caller 编排(写 skills.yaml + 投影)+ update/perform caller 编排(改 skills.yaml + 重建投影 + orphan 覆盖项保留 UI)、Sync 冲突三栏完整交互(选保留哪方 + 写结果 + 重新检查)、Settings 本地级编辑/删除交互(调 PUT /api/config)+ active_repo fhelp 细节、四视图布局(Skills 分组/agent chip/详情 Dialog、Mcp master-detail)、playwright-cli 三端实测(spec 行 374)。
