# AGENTS.md

## 项目概要

Loom 是一个 code agent 周边设施管理工具。配置一份 Skills/MCP/Config,自动投影到 Claude Code、Codex、OpenCode 等多个 agent;基于 Git 实现多端增量同步。

## 架构

- 前端: React 18 + Vite + Tailwind CSS v4 + Radix UI,默认端口 5173
- 后端: Hono,默认端口 3000(可通过 `LOOM_PORT` 环境变量配置)
- Monorepo: bun workspaces,`packages/web` + `packages/server` + `packages/core`(共享库)
- 全局配置: `~/.loom/`

## 开发命令

```bash
bun dev           # 启动前后端(热加载)
bun dev:api       # 仅后端
bun dev:web       # 启动前后端(web 优先,与 dev 相同)
bun build         # 构建
bun test          # 运行测试
```

仅前端: `bun --filter @loom/web dev`

## 文档

所有设计文档、UI 规范和实现计划在 [docs/index.md](docs/index.md) 下分层索引。

## 约定

- 用户可见内容用中文;代码标识符用英文
- 前端改动参考 [docs/ui/](docs/ui/index.md) 中的设计系统,不要自行发明样式
- 临时文件放 `temp/`
- JS/TS 用 `bun`
