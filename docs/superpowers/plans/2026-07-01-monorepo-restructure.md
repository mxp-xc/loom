# Monorepo 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 loom 从"半 workspace"中间态重构为三包 pnpm workspace（@loom/core + @loom/server + @loom/web），消除依赖重复、tsconfig 污染，建立共享类型契约。

**Architecture:** 三包 workspace，依赖图 web -> core <- server 无环。core 是纯领域逻辑+类型，server 是基础设施+API，web 是 React UI。端口接口集中在 server 内 ports/ 子目录，为将来提取 @loom/shared 留接缝。

**Tech Stack:** pnpm workspace、TypeScript、vitest (projects 模式)、Hono、React、Vite

**Spec:** docs/superpowers/specs/2026-07-01-monorepo-restructure-design.md

---

## 前置准备

- [ ] **Step 0: 创建分支**

```bash
git checkout -b refactor/monorepo-restructure
```

---

## File Structure

### 新建文件

| 文件 | 职责 |
|---|---|
| `tsconfig.base.json` | 共享 TS 编译选项，所有包 extends |
| `packages/core/package.json` | @loom/core 包定义 |
| `packages/core/tsconfig.json` | core 编译配置 |
| `packages/core/vitest.config.ts` | core 测试配置 |
| `packages/core/src/index.ts` | core 公共 API re-export |
| `packages/server/package.json` | @loom/server 包定义 |
| `packages/server/tsconfig.json` | server 编译配置 |
| `packages/server/vitest.config.ts` | server 测试配置 |
| `packages/server/src/ports/fs.ts` | IFileSystem 接口 |
| `packages/server/src/ports/git.ts` | IGit 接口 |
| `packages/server/src/ports/process.ts` | IProcess 接口 |
| `packages/server/src/ports/adapter.ts` | IAgentAdapter 等接口 |
| `packages/web/package.json` | @loom/web 包定义 |
| `packages/web/tsconfig.json` | web 编译配置 |
| `packages/web/vitest.config.ts` | web 测试配置 |

### 移动文件

| 来源 | 目标 |
|---|---|
| `src/core/*` | `packages/core/src/*` |
| `src/adapters/*` | `packages/server/src/adapters/*` |
| `src/api/*` | `packages/server/src/api/*` |
| `src/platform/*` | `packages/server/src/platform/*` |
| `src/projection/*` | `packages/server/src/projection/*` |
| `src/remote/*` | `packages/server/src/remote/*` |
| `src/sync/*` | `packages/server/src/sync/*` |
| `src/index.ts` | `packages/server/src/index.ts` |
| `webui/*` | `packages/web/*` |
| `tests/core/*` | `packages/core/test/*` |
| `tests/{adapters,api,platform,projection,remote,sync}/*` | `packages/server/test/*` |
| `tests/webui/*` | `packages/web/test/*` |

### 删除文件

| 文件 | 原因 |
|---|---|
| `src/` (整个目录) | 全部迁出 |
| `webui/` (整个目录, 含 node_modules) | 全部迁出 |
| `tests/` (整个目录) | 全部迁出 |
| `tsconfig.json` (根级) | 被 tsconfig.base.json 取代 |

---

## Task 1: 创建 workspace 骨架

**Files:**
- Create: `tsconfig.base.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `packages/core/`, `packages/server/`, `packages/web/` 目录

- [ ] **Step 1: 创建 packages 目录结构**

```bash
mkdir -p packages/core/src packages/core/test
mkdir -p packages/server/src/ports packages/server/test
mkdir -p packages/web/src packages/web/test
```

- [ ] **Step 2: 创建 tsconfig.base.json**

包含 `isolatedModules: true`（所有使用 esbuild/Vite 的包都需要）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "lib": ["ES2022"]
  }
}
```

- [ ] **Step 3: 修改 pnpm-workspace.yaml**

```yaml
packages:
  - packages/*
allowBuilds:
  esbuild: true
```

- [ ] **Step 4: 修改根 package.json**

```json
{
  "name": "loom",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n api,web -c blue,green \"pnpm --filter @loom/server dev\" \"pnpm --filter @loom/web dev\"",
    "dev:web": "concurrently -n api,web -c blue,green \"pnpm --filter @loom/server dev\" \"pnpm --filter @loom/web dev\"",
    "dev:api": "pnpm --filter @loom/server dev",
    "start": "pnpm --filter @loom/server start",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r run build",
    "build:web": "pnpm --filter @loom/web build"
  },
  "devDependencies": {
    "concurrently": "^10.0.0",
    "typescript": "^5.9.0",
    "vitest": "^2.1.0"
  }
}
```

注意：根 devDeps 不再需要 tsx（server 包自己有）。如果根级脚本需要 tsx，保留它。

- [ ] **Step 5: 修改根 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: { include: ['packages/*/src/**'] },
  },
})
```

- [ ] **Step 6: 删除旧 tsconfig.json**

```bash
rm tsconfig.json
```

- [ ] **Step 7: pnpm install 验证**

```bash
pnpm install
```

验证：pnpm install 成功。此时 packages/* 下只有空目录无 package.json，pnpm 忽略它们，仅安装根 devDeps。

- [ ] **Step 8: Commit**

```bash
git add tsconfig.base.json pnpm-workspace.yaml package.json vitest.config.ts
git commit -m "chore: set up workspace skeleton for three-package structure"
```

---

## Task 2: 迁移 core 包

**Files:**
- Move: `src/core/*` -> `packages/core/src/*`
- Move: `tests/core/*` -> `packages/core/test/*`
- Create: `packages/core/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`
- Modify: `packages/core/test/*.ts` (import 路径)

- [ ] **Step 1: 移动 core 源码**

```bash
git mv src/core/types.ts packages/core/src/types.ts
git mv src/core/manifest.ts packages/core/src/manifest.ts
git mv src/core/merge.ts packages/core/src/merge.ts
git mv src/core/projection.ts packages/core/src/projection.ts
git mv src/core/vars.ts packages/core/src/vars.ts
git mv src/core/version.ts packages/core/src/version.ts
```

- [ ] **Step 2: 移动 core 测试**

```bash
git mv tests/core/manifest.test.ts packages/core/test/manifest.test.ts
git mv tests/core/merge.test.ts packages/core/test/merge.test.ts
git mv tests/core/projection.test.ts packages/core/test/projection.test.ts
git mv tests/core/types.test.ts packages/core/test/types.test.ts
git mv tests/core/vars.test.ts packages/core/test/vars.test.ts
git mv tests/core/version.test.ts packages/core/test/version.test.ts
```

- [ ] **Step 3: 创建 packages/core/src/index.ts**

确切的 re-export 清单（六个模块全收，无同名冲突）：

```ts
export * from './types.js'
export * from './manifest.js'
export * from './merge.js'
export * from './projection.js'
export * from './vars.js'
export * from './version.js'
```

- [ ] **Step 4: 创建 packages/core/package.json**

```json
{
  "name": "@loom/core",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "dependencies": { "js-yaml": "^4.1.0", "zod": "^3.23.0" },
  "devDependencies": { "@types/js-yaml": "^4.0.9", "vitest": "^2.1.0" }
}
```

- [ ] **Step 5: 创建 packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 6: 创建 packages/core/vitest.config.ts**

```ts
import { defineProject } from 'vitest/config'
export default defineProject({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
```

- [ ] **Step 7: 修改 core 测试的 import 路径**

将 `../../src/core/<module>` 改为 `../src/<module>`：
- manifest.test.ts: `../../src/core/manifest` -> `../src/manifest`, `../../src/core/types` -> `../src/types`
- merge.test.ts: `../../src/core/merge` -> `../src/merge`
- projection.test.ts: `../../src/core/projection` -> `../src/projection`, `../../src/core/types` -> `../src/types`
- types.test.ts: `../../src/core/types` -> `../src/types`
- vars.test.ts: `../../src/core/vars` -> `../src/vars`
- version.test.ts: `../../src/core/version` -> `../src/version`

- [ ] **Step 8: 运行 core 测试验证**

```bash
pnpm install
pnpm --filter @loom/core test
```

预期：6 个测试文件全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "refactor: migrate core package to @loom/core"
```

---

## Task 3: 迁移 server 包 — 源码移动 + 端口拆分 + import 改写 (一个 commit)

注意：本 Task 合并了源码移动和 import 改写，确保 commit 时代码可编译。移动后如果不改写 import，`../core/*.js` 路径会断（core 已在 packages/core/），所以必须在同一个 commit 内完成。

**Files:**
- Move: `src/{adapters,api,platform,projection,remote,sync}/*` + `src/index.ts` -> `packages/server/src/*`
- Create: `packages/server/src/ports/{fs,git,process,adapter}.ts`
- Delete: `packages/server/src/platform/interfaces.ts`
- Modify: `packages/server/src/adapters/types.ts` (仅留 toAgentEntry)
- Modify: 所有 server src 文件的 import 路径
- Create: `packages/server/package.json`, `tsconfig.json`, `vitest.config.ts`

### Part A: 移动源码 + 拆分端口接口

- [ ] **Step 1: 移动 server 源码目录**

```bash
git mv src/adapters packages/server/src/adapters
git mv src/api packages/server/src/api
git mv src/platform packages/server/src/platform
git mv src/projection packages/server/src/projection
git mv src/remote packages/server/src/remote
git mv src/sync packages/server/src/sync
git mv src/index.ts packages/server/src/index.ts
```

- [ ] **Step 2: 创建 packages/server/src/ports/fs.ts**

从 platform/interfaces.ts 提取 IFileSystem：

```ts
export interface IFileSystem {
  createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  removeLink(linkPath: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  mkdir(path: string, recursive?: boolean): Promise<void>
  readDir(path: string): Promise<string[]>
  isLink(path: string): Promise<boolean>
  copyDir(src: string, dest: string): Promise<void>
}
```

- [ ] **Step 3: 创建 packages/server/src/ports/git.ts**

从 platform/interfaces.ts 提取 IGit（完整接口，见原文件）。

- [ ] **Step 4: 创建 packages/server/src/ports/process.ts**

```ts
export interface IProcess {
  isInstalled(agentId: string): Promise<boolean>
}
```

- [ ] **Step 5: 创建 packages/server/src/ports/adapter.ts**

从 adapters/types.ts 提取所有接口。IAgentAdapter 的 IFileSystem 从 inline import 改为正常 import：

```ts
import type { AgentId } from '@loom/core'
import type { IFileSystem } from './fs.js'

export interface McpFragment { id: string; type: 'stdio'|'sse'|'http'; command?: string; args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string>; targets?: AgentId[] }
export type UndoAction = { kind: 'unlink'; path: string } | { kind: 'restoreMcp'; path: string; backup: string | null }
export interface ProjectionJournal { undos: UndoAction[] }
export interface ProjectionFailure { failedStep: string; originalError: unknown; rollbackReport: { undone: number; rollbackFailures: { path: string; err: unknown }[] } }
export interface IAgentAdapter { readonly agent: AgentId; readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>>; writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> }
```

- [ ] **Step 6: 修改 packages/server/src/adapters/types.ts**

仅留 toAgentEntry，McpFragment 从 ../ports/adapter.js 导入：

```ts
import type { McpFragment } from '../ports/adapter.js'
export function toAgentEntry(f: McpFragment): Record<string, unknown> {
  const e: Record<string, unknown> = { type: f.type }
  if (f.command !== undefined) e.command = f.command
  if (f.args !== undefined) e.args = f.args
  if (f.env !== undefined) e.env = f.env
  if (f.url !== undefined) e.url = f.url
  if (f.headers !== undefined) e.headers = f.headers
  return e
}
```

- [ ] **Step 7: 删除 packages/server/src/platform/interfaces.ts**

```bash
git rm packages/server/src/platform/interfaces.ts
```

### Part B: 改写所有 server src 的 import 路径

改写规则：
- `../core/*.js` -> `@loom/core`
- `../platform/interfaces.js` -> `../ports/fs.js` / `../ports/git.js` / `../ports/process.js` (按实际接口)
- `../adapters/types.js` (接口) -> `../ports/adapter.js`
- `../adapters/types.js` (toAgentEntry) -> 不变

- [ ] **Step 8: 改写 platform/node/ 下的文件**

这四个文件引用 `../interfaces.js`（不是 `../platform/interfaces.js`），路径改为 `../../ports/*.js`：

- `platform/node/fs.ts`: `../interfaces.js` (IFileSystem) -> `../../ports/fs.js`
- `platform/node/git.ts`: `../interfaces.js` (IGit) -> `../../ports/git.js`
- `platform/node/proc.ts`: `../interfaces.js` (IProcess) -> `../../ports/process.js`
- `platform/node/init.ts`: `../interfaces.js` (IFileSystem, IGit) -> 拆为 `../../ports/fs.js` + `../../ports/git.js`

- [ ] **Step 9: 改写 adapters/ 下的文件**

注意：三个 adapter 文件从 `./types.js` 导入 McpFragment/IAgentAdapter，需拆分：toAgentEntry 留 `./types.js`，McpFragment/IAgentAdapter 改 `../ports/adapter.js`。

- `adapters/claude-code.ts`: IFileSystem -> `../ports/fs.js`, AgentId -> `@loom/core`, McpFragment+IAgentAdapter -> `../ports/adapter.js` (toAgentEntry 留 `./types.js`)
- `adapters/codex.ts`: 同上
- `adapters/opencode.ts`: 同上
- `adapters/paths.ts`: AgentId -> `@loom/core` (无 IFileSystem)

- [ ] **Step 10: 改写 api/ 下的文件**

- `api/routes.ts`: 合并 core imports 为 `import { loadRepoManifest, mergeConfig, buildManifest, planProjection, type AgentId } from '@loom/core'`
- `api/deps.ts`: AgentId -> `@loom/core`
- `api/server.ts`: dist 路径 `../../webui/dist/` -> `../../../web/dist/`；环境变量 `LOOM_WEBUI_DIST` -> `LOOM_WEB_DIST`

- [ ] **Step 11: 改写 projection/ 下的文件**

- `projection/executor.ts`: IFileSystem -> `../ports/fs.js`, 5 个接口 -> `../ports/adapter.js`, core imports 合并为 `@loom/core`
- `projection/mcp-merge.ts`: McpFragment -> `../ports/adapter.js`
- `projection/scan.ts`: IFileSystem -> `../ports/fs.js`, core imports 合并为 `@loom/core`

- [ ] **Step 12: 改写 remote/ 下的文件**

- `remote/discover.ts`: IGit -> `../ports/git.js`, IFileSystem -> `../ports/fs.js`
- `remote/install.ts`: 同上
- `remote/update.ts`: 同上 + core imports 合并为 `@loom/core`

- [ ] **Step 13: 改写 sync/ 下的文件**

- `sync/conflicts.ts`: Conflict -> `@loom/core`
- `sync/pull.ts`: IGit -> `../ports/git.js`, IFileSystem -> `../ports/fs.js`, threeWayMerge -> `@loom/core`
- `sync/push.ts`: IGit -> `../ports/git.js`

### Part C: 创建 server 包配置

- [ ] **Step 14: 创建 packages/server/package.json**

```json
{
  "name": "@loom/server",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": {
    "dev": "node --import tsx src/index.ts",
    "start": "node --import tsx src/index.ts"
  },
  "dependencies": {
    "@loom/core": "workspace:*",
    "@hono/node-server": "^2.0.6",
    "gray-matter": "^4.0.3",
    "hono": "^4.12.27",
    "simple-git": "^3.25.0",
    "smol-toml": "^1.7.0",
    "tinyglobby": "^0.2.17"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.22.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 15: 创建 packages/server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 16: 创建 packages/server/vitest.config.ts**

```ts
import { defineProject } from 'vitest/config'
export default defineProject({
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
})
```

- [ ] **Step 17: 验证无残留的旧路径引用**

```bash
rg -n "interfaces\.js|from.*\.\./core/" packages/server/src/
```

预期：无输出。

- [ ] **Step 18: pnpm install + tsc 类型检查**

```bash
pnpm install
cd packages/server && npx tsc --noEmit && cd ../..
```

预期：类型检查通过。

- [ ] **Step 19: Commit**

```bash
git add packages/server
git commit -m "refactor: migrate server package with ports split and import rewrite"
```

---

## Task 4: 迁移 server 包 — 测试文件 + vi.mock 改写

**Files:**
- Move: `tests/{adapters,api,platform,projection,remote,sync}/*` -> `packages/server/test/*`
- Modify: 所有移动后的测试文件 import 路径 + vi.mock 路径

关键：server 测试的相对路径 `../../src/` 和 `../../../src/` **不需要改变**——迁移前后 test 与 src 的相对深度一致（tests/xxx/ -> packages/server/test/xxx/，src/ -> packages/server/src/）。

只有语义性改写需要：
- `../../src/core/*` -> `@loom/core`
- `../../src/platform/interfaces` -> `../../src/ports/git` 或 `../../src/ports/fs` (注意：还是 ../../src/ 前缀)
- `../../src/adapters/types` -> `../../src/ports/adapter` (接口)

- [ ] **Step 1: 移动测试文件**

```bash
git mv tests/adapters packages/server/test/adapters
git mv tests/api packages/server/test/api
git mv tests/platform packages/server/test/platform
git mv tests/projection packages/server/test/projection
git mv tests/remote packages/server/test/remote
git mv tests/sync packages/server/test/sync
```

- [ ] **Step 2: 改写 test/ 下的 import 和 vi.mock 路径**

通用规则（`../../src/` 前缀不变，只改语义路径）：
- `../../src/core/*` -> `@loom/core`
- `../../src/platform/interfaces` -> `../../src/ports/git` 或 `../../src/ports/fs`
- `../../src/adapters/types` -> `../../src/ports/adapter` (接口)
- 其余 `../../src/*` -> 不变
- `../../../src/*` (platform/node/) -> 不变

**特别注意 vi.mock 路径：**

vi.mock 的路径也必须按同样规则改写。以下是需要改写 mock 路径的文件：

`packages/server/test/api/routes.test.ts` 有 5 个 vi.mock：
- `vi.mock('../../src/projection/executor.js', ...)` -> 不变
- `vi.mock('../../src/sync/pull.js', ...)` -> 不变
- `vi.mock('../../src/sync/push.js', ...)` -> 不变
- `vi.mock('../../src/core/manifest.js', ...)` -> `vi.mock('@loom/core', ...)`
  注意：mock `@loom/core` 会导致 routes.ts 从 @loom/core 导入的 buildManifest 和 planProjection 也变 undefined。需要补全 mock：
  ```ts
  vi.mock('@loom/core', () => ({
    loadRepoManifest: vi.fn(() => ({ repoConfig: { targets: ['claude-code'] }, errors: [] })),
    mergeConfig: vi.fn((repo: Record<string, unknown>) => ({ ...repo, active_repo: 'default' })),
    buildManifest: vi.fn(),
    planProjection: vi.fn(),
  }))
  ```
- `vi.mock('../../src/platform/node/index.js', ...)` -> 不变

`packages/server/test/api/server.test.ts` 有 1 个 vi.mock：
- `vi.mock('../../src/api/routes.js', ...)` -> 不变

逐文件改写清单：
- test/adapters/: claude-code, codex, opencode, paths — 仅 `../../src/` 路径不变，无 core/interfaces 引用
- test/api/: routes (vi.mock core/manifest -> @loom/core + 补全), server (LOOM_WEBUI_DIST -> LOOM_WEB_DIST, 2 处)
- test/platform/node/: fs, git, init — 无语义改写
- test/projection/: executor (core -> @loom/core), mcp-merge (adapters/types -> ports/adapter), scan (core -> @loom/core)
- test/remote/: discover (interfaces -> ports/git), frontmatter (无改写), install (无改写), update (core -> @loom/core)
- test/sync/: conflicts, pull, push — 无语义改写

- [ ] **Step 3: 运行 server 测试验证**

```bash
pnpm install
pnpm --filter @loom/server test
```

预期：全部 19 个测试文件 PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/server/test
git commit -m "refactor: migrate server tests with import and vi.mock path updates"
```

---

## Task 5: 迁移 web 包

**Files:**
- Move: `webui/*` -> `packages/web/*`
- Move: `tests/webui/*` -> `packages/web/test/*`
- Create: `packages/web/package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `packages/web/test/*.tsx` (import + vi.mock 路径)

- [ ] **Step 1: 移动 webui 内容到 packages/web**

```bash
git mv webui/src packages/web/src
git mv webui/index.html packages/web/index.html
git mv webui/vite.config.ts packages/web/vite.config.ts
git mv webui/tsconfig.json packages/web/tsconfig.json
git mv webui/package.json packages/web/package.json
```

webui/node_modules 不在 git 中，不 git mv。Task 7 会物理删除。

- [ ] **Step 2: 移动 web 测试**

```bash
git mv tests/webui/app.test.tsx packages/web/test/app.test.tsx
git mv tests/webui/settings.test.tsx packages/web/test/settings.test.tsx
git mv tests/webui/theme.test.tsx packages/web/test/theme.test.tsx
git mv tests/webui/views.test.tsx packages/web/test/views.test.tsx
```

- [ ] **Step 3: 修改 packages/web/package.json**

name 改 @loom/web，加 @loom/core 依赖和 test 脚本：

```json
{
  "name": "@loom/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview", "test": "vitest run" },
  "dependencies": {
    "@loom/core": "workspace:*",
    "@radix-ui/react-slot": "^1.1.1",
    "@radix-ui/react-tabs": "^1.1.2",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.30.0",
    "tailwind-merge": "^3.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@testing-library/react": "^16.1.0",
    "@types/node": "^22.10.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^26.0.0",
    "tailwindcss": "^4.1.0",
    "tw-animate-css": "^1.2.5",
    "typescript": "^5.6.3",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

注意：移除了 @testing-library/jest-dom（现有测试未使用 jest-dom matchers）。

- [ ] **Step 4: 修改 packages/web/tsconfig.json**

保留现有 webui/tsconfig.json 的所有选项，加 extends base：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "noEmit": true,
    "isolatedModules": true,
    "useDefineForClassFields": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 5: 创建 packages/web/vitest.config.ts**

保留 @ alias 和 dedupe：

```ts
import { defineProject } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) },
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
```

- [ ] **Step 6: 确认 packages/web/vite.config.ts**

vite.config.ts 中 @ alias 指向 ./src/，移动后路径自洽不用改。内容与原 webui/vite.config.ts 相同。

- [ ] **Step 7: 修改 web 测试的 import 和 vi.mock 路径**

`../../webui/src/*` -> `../src/*`（旧结构 test 和 source 不在同一子树，新结构变为同包内 test/ vs src/）

vi.mock 路径同样改写：
- app.test.tsx: `vi.mock('../../webui/src/lib/api', ...)` -> `vi.mock('../src/lib/api', ...)`
- settings.test.tsx: 同上
- views.test.tsx: 同上

- [ ] **Step 8: 运行 web 测试验证**

```bash
pnpm install
pnpm --filter @loom/web test
```

预期：4 个测试文件全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add packages/web
git commit -m "refactor: migrate web package to @loom/web"
```

---

## Task 6: 清理与最终验证

**Files:**
- Delete: `src/`, `webui/` (含 node_modules), `tests/`
- Verify: 全量测试、dev 启动、build

- [ ] **Step 1: 删除空目录残留**

```bash
rm -rf src webui tests
```

注意：webui/node_modules 物理存在但不在 git 中，rm -rf 会一并清理。packages/web/ 的 node_modules 由 Task 5 的 pnpm install 已创建。

- [ ] **Step 2: 验证 workspace 链接**

```bash
pnpm install
```

预期：pnpm install 成功，无 peer dependency 警告。

- [ ] **Step 3: 运行全量测试**

```bash
pnpm test
```

预期：所有包测试全部 PASS（core 6 + server 19 + web 4 = 29 个测试文件）。

- [ ] **Step 4: 验证 dev 启动**

```bash
pnpm dev:web
```

预期：
- API server 在 http://localhost:3000 启动
- Vite dev server 在 http://localhost:5173 启动
- 浏览器访问 http://localhost:5173 能加载 UI
- Ctrl+C 同时关闭两个进程

- [ ] **Step 5: 验证 web 构建**

```bash
pnpm build:web
```

预期：packages/web/dist/ 生成 index.html 和 assets/。

- [ ] **Step 6: 验证生产模式启动**

```bash
pnpm start
```

预期：API server 启动，访问 http://localhost:3000 能加载 web UI。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: clean up old directories and finalize monorepo structure"
```

---

## 回滚策略

每个 Task 是独立 commit，可精确回滚：
```bash
git log --oneline -10
git reset --hard <commit-hash>
```

Task 1-2 完成后 core 独立可用；Task 3 完成后 server 源码可用（但测试未迁移）；Task 4 完成后 server 测试通过；Task 5 完成后 web 可用。
