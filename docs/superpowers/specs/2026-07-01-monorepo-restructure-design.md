## Monorepo 重构：三层 Package 结构

> 日期：2026-07-01
> 状态：已确认，待实施

## 背景与动机

当前 loom 仓库是一个"半 workspace"中间态：

- `webui` 已是 pnpm workspace 的一个 package（`pnpm-workspace.yaml` 里 `packages: [webui]`），有自己的 `package.json` / `tsconfig.json` / `vite.config.ts`。
- 后端 `src/` 不是 package，直接挂在仓库根上。根 `package.json` 同时扮演"后端包"和"workspace 根"两个角色。
- 前端 `webui/src/lib/api.ts` 用 `fetch` + 内联手写响应类型，不引用后端的类型定义。

由此产生四个具体问题：

1. **依赖重复**：`react` / `react-dom` / `react-router-dom` / `@testing-library/*` / `jsdom` / `typescript` / `vitest` 同时出现在根和 `webui/package.json`。
2. **无共享类型**：前端手抄 API 响应类型，后端类型无法作为单一来源。
3. **tsconfig 污染**：根 `tsconfig.json` 带 `jsx: react-jsx`、`DOM` lib、`@/* → ./webui/src/*`，只为给 `tests/webui/` 做类型检查，同时又 `exclude: ["webui"]`。
4. **扩展性受限**：根 `package.json` 身兼数职，将来加 CLI 或 desktop 包时缺乏清晰的 package 边界。

用户已确认桌面端（Tauri）是明确方向，但时机未定、I/O 架构未定（sidecar vs Rust 重写）。当前阶段先把 web 端做完整。

## 目标

- 消除"半 workspace"混乱（依赖重复、tsconfig 污染、根 package.json 身份不清）
- 让前后端共享类型/契约，以后端为单一来源
- 目录归属清晰，降低心智负担
- 为将来桌面端/CLI 扩展留好 package 边界

## 方案选型

### 三包 workspace（选定）

```
packages/
  core/     纯领域：types + manifest + merge + projection(plan) + vars + version
  server/   端口接口(ports/) + node 实现 + adapter 实现 + executor + remote + sync + Hono API
  web/      React UI，import type from @loom/core
```

依赖图：`web → core ← server`，无环。core 是共享类型和纯逻辑的单一来源。

### 为什么不拆四层 + shared

桌面端 I/O 架构（sidecar 跑 node vs Rust 重写）未定，直接决定 shared 包里放什么：

- 如果选 sidecar，desktop 复用 server 包，shared 几乎不需要。
- 如果选 Rust 重写，端口接口要提出来，但还需要一套 `invoke()` 适配层——其形状现在无从知道。

现在拆 shared 是在猜一个答案未定的题。改为在 server 内部用 `ports/` 子目录隔离端口接口，保持零外部依赖、零实现。将来要拆 `@loom/shared` 时，是一次纯机械的 `git mv` + 改 import 路径，不碰任何调用逻辑。

### 为什么不选两包或纯目录

- **两包（server + web）**：共享类型要么放 server 让 web 反向依赖（脏），要么前端继续手抄（B 目标落空）。
- **纯目录区分**：根 `package.json` 身兼数职的问题不解决，无法用 workspace 协议做依赖隔离。

## 设计

### 1. Package 结构

```
loom/
├── pnpm-workspace.yaml          # packages: [packages/*]
├── package.json                 # 纯 workspace 根，只含编排脚本
├── tsconfig.base.json           # 共享编译选项
├── vitest.config.ts             # projects 模式
├── packages/
│   ├── core/
│   │   ├── package.json         # name: @loom/core
│   │   ├── tsconfig.json        # extends base
│   │   ├── vitest.config.ts     # defineProject, node
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── manifest.ts
│   │   │   ├── merge.ts
│   │   │   ├── projection.ts
│   │   │   ├── vars.ts
│   │   │   └── version.ts
│   │   └── test/
│   ├── server/
│   │   ├── package.json         # name: @loom/server
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts     # defineProject, node
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── ports/           # 接缝层
│   │   │   │   ├── fs.ts
│   │   │   │   ├── git.ts
│   │   │   │   ├── process.ts
│   │   │   │   └── adapter.ts
│   │   │   ├── platform/node/
│   │   │   ├── adapters/
│   │   │   ├── projection/
│   │   │   ├── remote/
│   │   │   ├── sync/
│   │   │   └── api/
│   │   └── test/
│   └── web/
│       ├── package.json         # name: @loom/web
│       ├── tsconfig.json
│       ├── vitest.config.ts     # defineProject, jsdom
│       ├── vite.config.ts
│       ├── src/
│       └── test/
├── archive/
└── temp/
```

### 2. 依赖关系

**`@loom/core`**：无内部依赖。外部 `js-yaml`（manifest 解析）、`zod`（schema 校验）。这些是底层通用库，不绑定业务逻辑，未来可能还有 utils 类依赖。

**`@loom/server`**：内部 `@loom/core`（`workspace:*`）。外部 `hono`、`@hono/node-server`、`simple-git`、`tinyglobby`、`gray-matter`、`smol-toml`。devDeps `tsx`、`@types/node`。

**`@loom/web`**：内部 `@loom/core`（`workspace:*`，仅 `import type`）。外部 `react`、`react-dom`、`react-router-dom`、`@radix-ui/react-slot`、`@radix-ui/react-tabs`、`class-variance-authority`、`clsx`、`tailwind-merge`。devDeps 含 `tailwindcss`、`@tailwindcss/vite`、`@vitejs/plugin-react`、`vite`、`@testing-library/*`、`jsdom`、`@types/react`、`@types/react-dom`、`@types/node`、`typescript`。

无环依赖：`web → core ← server`。

### 3. 测试组织

采用 co-located 模式（每包自带 `test/` 目录），理由：

- 调研 9 个主流 pnpm workspace 项目（hono、radix-ui、vite、nuxt、astro、shadcn/ui、vitest、remix、turborepo），7/9 用 co-located。Turborepo 维护者建议："if tests are only concerned with one package, put them in that package."
- 现有 22 个测试文件零跨包运行时依赖，1:1 干净拆分。
- vitest projects 模式天然为 co-located 设计。

测试归属映射：

| 现有路径 | 目标路径 |
|---|---|
| `tests/core/*` | `packages/core/test/*` |
| `tests/adapters/*` | `packages/server/test/adapters/*` |
| `tests/api/*` | `packages/server/test/api/*` |
| `tests/platform/*` | `packages/server/test/platform/*` |
| `tests/projection/*` | `packages/server/test/projection/*` |
| `tests/remote/*` | `packages/server/test/remote/*` |
| `tests/sync/*` | `packages/server/test/sync/*` |
| `tests/webui/*` | `packages/web/test/*` |

用包内 `test/` 目录（Astro/Nuxt 风格）而非紧挨源码的 `*.test.ts`（Hono 风格），因为 server 包测试文件较多且涉及 mock/fixtures，独立 `test/` 目录更整洁。

### 4. TypeScript 配置

**`tsconfig.base.json`**（所有包 extends）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022"]
  }
}
```

不使用 `customConditions` / `@loom/source` 条件导出。当前无构建步骤，各包 exports 直接指向源码。将来加构建步骤时再补。

**各包 exports**（统一模式）：

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  }
}
```

**各包 tsconfig 差异**：

- `@loom/core`：`rootDir: src`, `outDir: dist`，lib 只有 ES2022
- `@loom/server`：同上 + `types: ["node"]`，lib 只有 ES2022
- `@loom/web`：`jsx: react-jsx`, `noEmit: true`, `isolatedModules: true`, `resolveJsonModule: true`, lib 加 `DOM` / `DOM.Iterable`

web 包的 `lib` 加 `DOM`/`DOM.Iterable`，server 和 core 不加——编译期隔离前端专属 API。

### 5. Vitest 配置

**根 `vitest.config.ts`**：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: { include: ['packages/*/src/**'] },
  },
})
```

**各包 `vitest.config.ts`**（用 `defineProject`）：

- `@loom/core`：`environment: node`, `include: ['test/**/*.test.ts']`
- `@loom/server`：`environment: node`, `include: ['test/**/*.test.{ts,tsx}']`
- `@loom/web`：`environment: jsdom`, `include: ['test/**/*.test.{ts,tsx}']`, `plugins: [react()]`, `setupFiles: ['test/setup.ts']`

根目录 `vitest run` 跑全部包测试，coverage 自动合并。单包调试在包目录内 `vitest`。

### 6. Dev 脚本

根 `package.json` 用 `concurrently` 管理 dev 进程，一键起、一键关：

```json
{
  "scripts": {
    "dev": "concurrently -n api,web -c blue,green \"pnpm --filter @loom/server dev\" \"pnpm --filter @loom/web dev\"",
    "dev:web": "concurrently -n api,web -c blue,green \"pnpm --filter @loom/server dev\" \"pnpm --filter @loom/web dev\"",
    "dev:api": "pnpm --filter @loom/server dev",
    "start": "pnpm --filter @loom/server start",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r run build",
    "build:web": "pnpm --filter @loom/web build"
  }
}
```

`concurrently` 收到 Ctrl+C 时向所有子进程转发信号，一次关闭全部。`dev` 和 `dev:web` 行为一致——同时起 API server（3000 端口）和 Vite dev server（5173 端口），Vite proxy 把 `/api` 转发到 3000。

端口隔离（多 worktree 场景）后续再做，当前固定 3000/5173。

### 7. 根 package.json

纯 workspace 根，不含业务依赖：

```json
{
  "name": "loom",
  "private": true,
  "type": "module",
  "scripts": { "...见上节..." },
  "devDependencies": {
    "concurrently": "^10.0.0",
    "typescript": "^5.9.0",
    "vitest": "^2.1.0",
    "tsx": "^4.22.0"
  }
}
```

## 迁移策略

### Step 1：创建 workspace 骨架

- `mkdir packages/core packages/server packages/web`
- 创建 `tsconfig.base.json`
- 修改 `pnpm-workspace.yaml`：`packages: [webui]` → `packages: [packages/*]`

### Step 2：迁移 core 包

- 移动 `src/core/*` → `packages/core/src/*`
- 创建 `packages/core/src/index.ts`，re-export 所有公共 API
- 移动 `tests/core/*` → `packages/core/test/*`
- 创建 `packages/core/package.json`、`tsconfig.json`、`vitest.config.ts`
- core 内部文件之间的相对引用不变（`./types.js` 等），无需改动

### Step 3：迁移 server 包

- 移动 `src/{adapters,api,platform,projection,remote,sync}/*` → `packages/server/src/*`
- 移动 `src/index.ts` → `packages/server/src/index.ts`
- 端口接口集中：
  - `src/platform/interfaces.ts` 拆分为 `packages/server/src/ports/{fs,git,process}.ts`
  - `src/adapters/types.ts` 的接口部分（`IAgentAdapter`、`McpFragment`、`UndoAction`、`ProjectionJournal`、`ProjectionFailure`）→ `packages/server/src/ports/adapter.ts`
  - `src/adapters/types.ts` 的工具函数（`toAgentEntry`）留在 `packages/server/src/adapters/types.ts`
- 移动 `tests/{adapters,api,platform,projection,remote,sync}/*` → `packages/server/test/*`
- 创建 `packages/server/package.json`、`tsconfig.json`、`vitest.config.ts`

import 路径改写（机械替换）：

| 旧路径 | 新路径 |
|---|---|
| `../core/types.js` | `@loom/core` |
| `../core/manifest.js` | `@loom/core` |
| `../core/projection.js` | `@loom/core` |
| `../core/merge.js` | `@loom/core` |
| `../core/vars.js` | `@loom/core` |
| `../core/version.js` | `@loom/core` |
| `../platform/interfaces.js` | `./ports/fs.js` / `./ports/git.js` / `./ports/process.js` |
| `../adapters/types.js`（接口） | `./ports/adapter.js` |
| `../adapters/types.js`（函数） | `./adapters/types.js` |

server 包内部其余相对路径不变（`./adapters/claude-code.js` 等）。

**迁移风险**：`IAgentAdapter` 的签名里引用了 `IFileSystem`（当前用 inline import `import('../platform/interfaces.js').IFileSystem`），拆分后要改成从 `./fs.js` 正常 import。这是唯一需要手动调整语义的地方，其余全是机械替换。

### Step 4：迁移 web 包

- 移动 `webui/*` → `packages/web/*`（整个目录内容）
- 移动 `tests/webui/*` → `packages/web/test/*`
- `packages/web/package.json`：name 改 `@loom/web`，加 `"@loom/core": "workspace:*"` 到 dependencies
- `webui/src/lib/api.ts` 里的内联响应类型改为 `import type { Manifest, Config, ... } from '@loom/core'`
- `@/` alias 不变（vite.config.ts 和 tsconfig.json 内部路径自洽）

### Step 5：清理根目录

- 删除 `src/` 目录（已全部迁出）
- 删除 `webui/` 目录（已全部迁出）
- 删除 `tests/` 目录（已全部迁出）
- 根 `package.json` 精简为纯编排
- 删除旧 `tsconfig.json`，保留 `tsconfig.base.json`
- 更新 `vitest.config.ts` 为 projects 模式

### Step 6：验证

```bash
pnpm install              # 重建 workspace 链接
pnpm test                 # 全量测试通过
pnpm dev:web              # 前后端同时启动，web 端功能正常
pnpm build:web            # 前端构建通过
```

## 决策清单

1. 三包结构 `@loom/core` + `@loom/server` + `@loom/web`
2. 端口接口留 server 内 `ports/` 子目录，将来需要再提取 `@loom/shared`
3. co-located 测试，包内 `test/` 目录（Astro/Nuxt 风格）
4. core 保留 `js-yaml`/`zod` 依赖（底层通用库，不绑定业务逻辑）
5. 不用 `customConditions`/`@loom/source`，exports 直接指向源码；将来加构建步骤时再补
6. `concurrently` 管理 dev 进程，一键起关
7. 端口隔离（多 worktree）后续再做

## 将来扩展

- **加构建步骤**：补 `@loom/source` 条件导出 + `customConditions`，exports 的 `import` 指向 `dist`
- **加桌面端（Tauri）**：根据 I/O 架构决定是否提取 `@loom/shared` 包。若 sidecar 模式则直接复用 `@loom/server`；若 Rust 重写则提取端口接口到 `@loom/shared`，再实现 Tauri 侧适配层
- **加 CLI 包**：`packages/cli/`，依赖 `@loom/core` + 自行实现 I/O 或复用 server 的 platform/node
