# AGENTS.md

## 项目概要

Loom 是 code agent 周边设施管理工具:维护一份 Skills / MCP / Memory / Config 配置,投影到 Claude Code、Codex、OpenCode 三个 agent;以 Git 仓库为载体实现多端增量同步。

## 技术栈

- Monorepo(bun workspaces):`packages/core`(共享纯逻辑,无 IO)+ `packages/server`(Hono 后端)+ `packages/web`(React SPA)
- 前端 React 18 + Vite + Tailwind v4 + Radix UI(固定 `127.0.0.1`,默认 5173,被占则随机,`LOOM_WEB_PORT` 覆盖);后端 Hono on `@hono/node-server`(默认 3000,被占则随机,`LOOM_PORT` 覆盖)
- 测试 vitest(workspace projects,web 用 jsdom);格式化 prettier(无分号、单引号、trailingComma all、tailwind 插件),pre-commit 跑 `lint-staged`。无 eslint。

## 命令

```bash
bun dev                       # 前后端(scripts/dev.mjs 自动选空闲端口或用 LOOM_PORT)
bun dev:api                   # 仅后端
bun --cwd packages/web dev    # 仅前端
bun build                     # 全 workspace 构建
bun run test                  # vitest run(全 package)
bun run test:watch            # 监听
bun run format / format:check
```

单测过滤:`bun run test <文件路径>`、`bun run test -t "<测试名>"`、`bun --cwd packages/server test -- <pattern>`(仅该 package)。

## 架构

### 全局目录 `~/.loom/`

- `config.yaml` — 本机级配置(`active_repo`、`proxy`),不进 git
- `repos/<name>/` — 被同步的 git 仓库:`config.yaml`(repo 级)、`skills.yaml`、`mcp.yaml`、`vars/<profile>.yaml`、`memories/<name>.md`、`assets/skills/<id>/`(本地 skill,canonical)、`remote-cache/<repoId>/`(源仓库克隆,gitignored)
- `state/<repo>/projected-mcp.json` — 记录 loom 上次投影的 mcp id,区分"loom 管理可删"与"用户手写保留";丢失则降级为保留全部

`initLoom`(`platform/node/init.ts`)首次运行建骨架并 `git init`。

### Agent 适配

配置位置由 `adapters/paths.ts` 集中解析(支持 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `OPENCODE_CONFIG_DIR` 覆盖):

| agent       | MCP 文件                                   | skills 目录              | memory 文件                |
| ----------- | ------------------------------------------ | ------------------------ | -------------------------- |
| claude-code | `~/.claude.json`(JSON `mcpServers`)        | `~/.claude/skills/`      | `~/.claude/CLAUDE.md`      |
| codex       | `~/.codex/config.toml`(TOML `mcp_servers`) | `~/.codex/skills/`       | `~/.codex/AGENTS.md`       |
| opencode    | `<xdg>/opencode/opencode.json`(JSON `mcp`) | `<xdg>/opencode/skills/` | `<xdg>/opencode/AGENTS.md` |

各 agent 一个 adapter 类(实现 `IAgentAdapter` 的 `readMcp`/`writeMcp`),只管格式读写。新增 agent:扩 paths + 加 adapter,不在路由层散落格式判断。

### Manifest 与投影

`packages/core` 纯逻辑(便于单测),`packages/server` 做 IO 与编排。manifest 由 repo 文件 + `~/.loom/config.yaml` 深合并(local 优先)后 zod 校验;`assets/skills/` 下未登记的本地 skill(含 `SKILL.md`)自动并入。

`planProjection`(纯函数)算每个条目的目标 agent:**目标 = 条目自身 targets ∩ 全局 config.targets ∩ 已安装 agent**。`executeProjection` 落地为 skill 符号链接(或 `strategy: copy`)、MCP 合并写入、memory 渲染写入,全程记 journal、失败回滚。

约束/陷阱:

- projection 清理**只删符号链接**,真实文件/目录一律保留(保护用户数据)
- MCP 合并依 state 文件区分 loom 管理 vs 用户手写条目
- memory 投影时每 agent 注入 `LOOM_AGENT`/`LOOM_CONFIG_DIR`/`LOOM_SKILLS_DIR`/`LOOM_AGENT_FILE` 环境变量

### 变量替换

`${VAR}` 解析顺序:env → active profile vars → default profile vars → 字面默认值;未定义抛 `ResolveError`。`\${` 转义字面量。用于 MCP 字段与 memory 内容。见 `core/vars.ts`。

### Git 同步

每个 loom repo 是 git 仓库。`sync/pull` 对 `skills.yaml`/`mcp.yaml`/`config.yaml` 及 `vars/*.yaml` 做 YAML 感知的三方合并(`core/merge.ts`,按 kind 区分语义),对 `assets/` 文本冲突单独检测,产出可 fast-forward push 的合并提交。`sync/push` 先 auto-commit 脏 yaml。源 skill 仓库克隆到 `remote-cache/<repoId>/` 按 commit pin。

### 端口与依赖注入

`ports/` 定义 `IFileSystem`/`IGit`/`IProcess`/`IAgentAdapter`,真实实现在 `platform/node/`。路由收 `RouteDeps { fs, git, proc, home }`。新增 IO 能力优先扩接口,不在路由层直接调 node API。测试用 `mkdtemp` + `vi.stubEnv('HOME')` 起真实文件系统。

### API 与前端

Hono app 路由全挂 `/api`;server 同时托管 `packages/web/dist` 静态资源 + SPA fallback(`LOOM_WEB_DIST` 覆盖)。前端 SPA(react-router),views:Skills / Mcp / Memory / Sync / Settings,`lib/api.ts` 类型化客户端,`useManifest` 缓存。**字段级即时保存**(乐观更新),无全局 save bar。主题用 CSS 变量(`var(--primary)`),非 tailwind color token。

### 日志

`lib/logger.ts` 写 `logs/loom-YYYY-MM-DD.log` 并镜像 console(`LOOM_LOG_DIR` / `LOOM_LOG_LEVEL` 可调),`logger.child('component')` 派生。约定:catch / 错误分支必须记日志,带完整 `err` 对象(`logger.error('msg', { err })`),不静默吞错。server 入口注册 uncaughtException/unhandledRejection → flush 后退出。

## 约定

- 用户可见内容用中文;代码标识符用英文
- ESM TypeScript,import 路径写 `.js` 后缀(源码是 `.ts`,moduleResolution: Bundler);bun 直接跑 TS,无编译步骤
- 前端改动参考 [`docs/ui/`](docs/ui/index.md) 设计系统,不自创样式
- 临时文件放 `temp/`;设计文档索引见 [docs/index.md](docs/index.md)
