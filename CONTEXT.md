# Loom

Loom 管理仓库级 agent 配置，并把期望状态投影到各 agent 的原生文件中。本术语表用于统一领域语言，避免后续实现和文档对同一概念使用不同说法。

## Language

**Agent**:
接收 Loom 投影配置的支持对象，例如 Claude Code、Codex 或 OpenCode。
_Avoid_: client, target app

**Target**:
被选择接收某个 skill、MCP server、memory 或其他可投影内容的 agent。
_Avoid_: enabled agent, destination

**Desired state**:
由 Loom manifest 和 UI 控件表达的期望配置状态。Projection 负责让 agent 文件与该状态一致。
_Avoid_: current filesystem state, installed state

**Projection**:
把 desired state 对齐到 agent 原生文件和目录的动作。
_Avoid_: deploy, export, sync

**Projection artifact**:
由 projection 创建或更新的文件、目录、符号链接或配置项。
_Avoid_: generated file, installed file

**Managed artifact**:
Loom 能识别为自己管理、因此可以继续对齐或删除的 projection artifact。
_Avoid_: generated artifact

**User-owned artifact**:
Loom 无法证明由自己管理的既有文件或目录。Loom 必须保留 user-owned artifact。
_Avoid_: unmanaged garbage

**Source**:
manifest 中配置的远端 skill 集合，由 URL 和 ref 标识。
_Avoid_: repo, dependency

**Source member**:
从 source 中发现并被选入 Loom manifest 的 skill。
_Avoid_: remote skill, sub-skill

**Local skill**:
直接来自当前仓库或本地路径的 skill，而不是从 source 中选择的 skill。
_Avoid_: custom skill

**Scan**:
在用户保存 desired state 前，发现候选 source member 或 local skill 的动作。
_Avoid_: import, install

**Memory**:
由 Loom 管理并投影到支持 agent 的仓库级 agent 指令内容。
_Avoid_: prompt, note

**Vars**:
类型化的仓库变量，可解析进投影内容，并避免不必要地暴露 secret。
_Avoid_: env vars, settings

**MCP server**:
由 Loom 管理并投影到 agent-specific MCP 配置中的 Model Context Protocol server 条目。
_Avoid_: tool, plugin
