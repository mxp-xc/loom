# Loom

Loom 是一个仓库级 agent 配置管理工具。它把仓库中的期望配置整理成 manifest，并投影到不同 agent 的原生配置位置，当前支持 Claude Code、Codex 和 OpenCode。

Loom 主要管理四类内容：

- Skills：远端 source member 与本地 skill 的选择、启用状态和投影目标。
- MCP servers：仓库级 MCP 配置，并按目标 agent 写入对应原生配置。
- Memory：仓库级 agent 指令内容，并投影为 agent 可读取的指令文件。
- Vars：类型化变量，支持按环境和 agent 解析，避免在投影内容中硬编码敏感或易变值。

## 快速开始

```bash
bun install
bun dev
```

`bun dev` 会同时启动 API 与 Web，并自动选择可用端口。终端会输出前端访问地址，默认优先使用：

- Web：`http://127.0.0.1:4180`
- API：`http://127.0.0.1:4310`

如果端口被占用，开发脚本会自动换到可用端口。也可以显式设置：

```bash
LOOM_PORT=4310 LOOM_WEB_PORT=4180 bun dev
```

## 常用命令

| 命令                         | 用途                  |
| ---------------------------- | --------------------- |
| `bun dev`                    | 同时启动 API 与 Web   |
| `bun dev:api`                | 只启动 server package |
| `bun --cwd packages/web dev` | 只启动 Vite 前端      |
| `bun run test`               | 运行全部 Vitest 测试  |
| `bun run test <path>`        | 按文件或路径过滤测试  |
| `bun run test -t "name"`     | 按用例名过滤测试      |
| `bun run format:check`       | 检查 Prettier 格式    |
| `bun run format`             | 自动格式化            |

默认验证跑 `bun run test` 即可，通常不需要跑 build 脚本。

## 项目结构

| 路径                  | 说明                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `packages/core/src`   | 无 IO 的领域逻辑、类型、manifest、projection plan、vars 解析         |
| `packages/server/src` | Hono API、Node 平台适配器、agent 投影、远端 source、Git sync         |
| `packages/web/src`    | React/Vite 前端，包含 Skills、MCP、Memory、Vars、Sync、Settings 页面 |
| `packages/*/test`     | 各 package 的 Vitest 测试                                            |
| `docs/`               | 业务规则、UI 规范与设计/计划文档                                     |
| `temp/`               | 临时调试和中间产物                                                   |

## 配置文件

Loom 读取目标仓库中的以下文件：

| 文件            | 说明                                                             |
| --------------- | ---------------------------------------------------------------- |
| `config.yaml`   | 仓库级基础配置，例如默认 targets、projection 策略、active memory |
| `skills.yaml`   | skill sources、本地 skills、成员选择和目标 agent                 |
| `mcp.yaml`      | MCP server 列表和目标 agent                                      |
| `vars/*.yaml`   | typed variables 环境文件，例如 `default.yaml` 或其他 profile     |
| `memories/*.md` | 可选 memory 内容，active memory 由配置选择                       |

本机覆盖配置位于 `~/.loom/config.yaml`，用于保存只属于当前机器的选择，例如 active repo、profile 或本地代理设置。仓库配置描述共享事实，本机配置描述本地偏好。

## 投影目标

Projection 会把 Loom 管理的内容写入 agent 原生位置：

- Claude Code：skills 目录、`CLAUDE.md`、MCP 配置。
- Codex：skills 目录、`AGENTS.md`、`config.toml`。
- OpenCode：skills 目录、`AGENTS.md`、`opencode.json`。

可通过环境变量覆盖部分本机路径：

- `CLAUDE_CONFIG_DIR`
- `CODEX_HOME`
- `OPENCODE_CONFIG_DIR`
- `XDG_CONFIG_HOME`
- `LOOM_PORT`
- `LOOM_WEB_PORT`
- `LOOM_LOG_DIR`

Projection 只应管理 Loom 能识别的产物；无法证明由 Loom 管理的既有文件或目录应被视为 user-owned artifact 并保留。

## 文档入口

- [领域术语](CONTEXT.md)：统一 Loom 的核心概念命名。
- [文档索引](docs/index.md)：业务规则、UI 规范与 superpowers 文档入口。
- [规则索引](docs/rules/index.md)：业务规则、安全边界和对外契约入口。
- [UI 规范](docs/ui/index.md)：设计系统与组件目标态。

修改 skills、MCP、memory、vars、projection 或 sync 相关行为前，先从 [规则索引](docs/rules/index.md) 进入对应规则文件。

## 开发约定

- 使用 ESM TypeScript，本地源码导入写 `.js` 后缀。
- `packages/core` 保持无文件系统、进程或网络 IO。
- 新增 IO 能力优先放在 server 的 ports/adapters 边界。
- 测试优先覆盖业务行为、关键分支、边界、错误路径和对外契约。
- 不提交本机 agent 配置、密钥、生成日志，或 `temp/` 之外的临时文件。
