# 仓库指南

## 项目结构与模块组织

Loom 是 Bun workspace monorepo。共享且无 IO 的领域逻辑在 `packages/core/src`；Hono API、Node 平台适配器和投影/同步编排在 `packages/server/src`；React/Vite 前端在 `packages/web/src`。测试按 package 放在 `packages/*/test`。设计与贡献文档在 `docs/`，UI 规范从 `docs/ui/index.md` 开始。临时调试文件放 `temp/`，不要散落到源码目录。

## 领域术语与业务规则

- 领域术语入口是 `CONTEXT.md`；只用于统一概念命名，不承载业务规则。
- 业务规则入口是 `docs/rules/index.md`。涉及业务规则、安全边界、对外契约或可投影/同步行为的改动，先读该索引，再按索引读取对应规则文件；具体 scope 与规则目录以该索引为准。
- 如果代码改动改变、澄清或新增上述规则、边界或契约，必须同步更新 `docs/rules/`，并补充或调整对应测试。
- 纯机械重构、格式化、无行为变化的内部整理，不需要读取全部 rules；但如果重构过程中发现现有代码与规则冲突，先停下来说明冲突，再决定改代码还是改规则。
- 新 feature spec 应链接相关 rules，不复制规则正文；规则描述当前事实，不写历史沿革。

## 构建、测试与本地开发

- `bun dev`：同时启动 API 与 Web，并自动选择可用端口。
- `bun dev:api`：只启动 server package。
- `bun --cwd packages/web dev`：只启动 Vite 前端。
- `bun run test`：运行全部 Vitest 项目。
- `bun run test <path>` 或 `bun run test -t "name"`：按文件或用例名过滤测试。
- 默认验证跑 test 即可，不跑 build 脚本。
- `bun run format:check`：检查 Prettier 格式。
- `bun run format`：自动格式化。

## 本地服务与端口

- 多个 worktree / agent 可同时运行服务；看到 `5173` 或其他端口被占用是正常现象，默认不要排查或清理。
- 需要服务时直接运行 `bun dev`，让项目自动选择可用端口；前端验证使用该命令输出的 URL。
- 只管理自己启动的 dev server：重启只重启自己的 session/process，不要 kill、复用或重启用户/其他 worktree 的服务。只有自己的服务启动失败或用户明确要求时，才排查端口。

## 代码风格与命名约定

使用 ESM TypeScript。源码导入本地文件时写 `.js` 后缀，即使源文件是 `.ts`。格式化由 Prettier 负责：无分号、单引号、trailing comma，并启用 Tailwind 插件。保持 `packages/core` 不依赖文件系统、进程或网络 IO；新增 IO 能力优先通过 server 的 ports/adapters 接入。文件与测试名应直观描述行为，例如 `projection.test.ts`、`executor-memory.test.ts`。

## 测试规范

测试框架是 Vitest；Web 测试使用 jsdom 与 Testing Library。优先覆盖业务行为、关键分支、边界条件、错误路径和对外契约，不为实现细节堆覆盖率。Server 测试常用临时目录，并通过 `vi.stubEnv('HOME', ...)` 隔离用户配置。前端交互改动应尽量用自动化浏览器验证；涉及视觉变化的 PR 请附截图。

## Commit 与 Pull Request

近期提交采用 Conventional Commit 风格，例如 `feat(vars): add vars management`、`fix: unify target controls and editors`、`chore: simplify bun package scripts`。每个 commit 聚焦一个逻辑变更。PR 应包含简短摘要、已运行的测试、相关 issue；涉及 UI 时附截图，涉及配置、同步或迁移风险时说明影响与回滚方式。

## 安全与配置提示

不要提交本机 `~/.loom/config.yaml`、agent 配置目录、密钥、生成日志，或 `temp/` 之外的临时文件。配置路径可通过 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`OPENCODE_CONFIG_DIR`、`LOOM_PORT`、`LOOM_WEB_PORT` 覆盖。
