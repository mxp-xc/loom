# 仓库指南

## 项目结构与模块组织

Loom 是 Bun workspace monorepo。共享且无 IO 的领域逻辑在 `packages/core/src`；Hono API、Node 平台适配器和投影/同步编排在 `packages/server/src`；React/Vite 前端在 `packages/web/src`。测试按 package 放在 `packages/*/test`。设计与贡献文档在 `docs/`，UI 规范从 `docs/ui/index.md` 开始。临时调试文件放 `temp/`，不要散落到源码目录。

## 构建、测试与本地开发

- `bun dev`：同时启动 API 与 Web，并自动选择可用端口。
- `bun dev:api`：只启动 server package。
- `bun --cwd packages/web dev`：只启动 Vite 前端。
- `bun run test`：运行全部 Vitest 项目。
- `bun run test <path>` 或 `bun run test -t "name"`：按文件或用例名过滤测试。
- `bun run format:check`：检查 Prettier 格式。
- `bun run format`：自动格式化。

## 代码风格与命名约定

使用 ESM TypeScript。源码导入本地文件时写 `.js` 后缀，即使源文件是 `.ts`。格式化由 Prettier 负责：无分号、单引号、trailing comma，并启用 Tailwind 插件。保持 `packages/core` 不依赖文件系统、进程或网络 IO；新增 IO 能力优先通过 server 的 ports/adapters 接入。文件与测试名应直观描述行为，例如 `projection.test.ts`、`executor-memory.test.ts`。

## 测试规范

测试框架是 Vitest；Web 测试使用 jsdom 与 Testing Library。优先覆盖业务行为、关键分支、边界条件、错误路径和对外契约，不为实现细节堆覆盖率。Server 测试常用临时目录，并通过 `vi.stubEnv('HOME', ...)` 隔离用户配置。前端交互改动应尽量用自动化浏览器验证；涉及视觉变化的 PR 请附截图。

## Commit 与 Pull Request

近期提交采用 Conventional Commit 风格，例如 `feat(vars): add vars management`、`fix: unify target controls and editors`、`chore: simplify bun package scripts`。每个 commit 聚焦一个逻辑变更。PR 应包含简短摘要、已运行的测试、相关 issue；涉及 UI 时附截图，涉及配置、同步或迁移风险时说明影响与回滚方式。

## 安全与配置提示

不要提交本机 `~/.loom/config.yaml`、agent 配置目录、密钥、生成日志，或 `temp/` 之外的临时文件。配置路径可通过 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`OPENCODE_CONFIG_DIR`、`LOOM_PORT`、`LOOM_WEB_PORT` 覆盖。
