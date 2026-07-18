# 跨模块规则

这些规则适用于 skills、MCP、memory、vars，以及未来新增的可投影配置。

## R-CROSS-000 Agent 范围由 Catalog 与配置共同确定

Status: active
Applies to: core, server, web, projection

Rule:
Agent Catalog 定义 Loom 支持的 Registered agents 全集。Configured agents 是 effective `config.agents` 中已注册的有序子集；Applicable agents 是 Configured agents 中支持当前 capability 的子集。Settings 始终展示 Registered agents，其他业务页面只展示各自的 Applicable agents。

Implications:

- `config.agents` 缺失或为空数组时，Configured agents 是空集合，不回退到产品默认 agent。
- 从 Configured agents 移除 agent 只隐藏其业务 controls，不删除 per-item selections、Memory assignment 或 agent Vars；重新加入后恢复显示。
- 新仓库显式写入创建时的 Registered agents；Catalog 后续新增 agent 不自动启用到既有仓库。

Safety:

- Capability mismatch 不得进入 projection 或对应页面 controls。
- React 空状态使用 `null` 或显式 `default`，不借真实 agent 充当 sentinel。

Tests:

- packages/core/test/agents.test.ts
- packages/web/test/settings.test.tsx
- packages/web/test/agent-catalog.test.tsx

## R-CROSS-001 UI 反映 desired state，而不是文件系统偶然状态

Status: active
Applies to: skills, MCP, memory, vars, projection

Rule:
Loom UI 必须反映 manifest/config 中的 desired state。磁盘上已有文件可以用于展示可用性或诊断信息，但不能被静默推断成用户已选择的 desired state。

Implications:

- Agent chip 显示 manifest 是否选择了对应 agent。
- 磁盘上的 projection artifact 不会单独让某个 item 显示为已选择。
- 引用的本地文件缺失时，UI 可以展示 unavailable 或缺失诊断，但不能自动删除 desired entry。
- Vars 的目标 agent chips 必须来自 Settings agents；default/agent 查看范围独立于“配置管理/最终结果”视图切换，配置管理中的当前值按所选查看范围展示 default 或 agent-specific 值。
- 没有 Configured agents 时，业务页面保持非 agent 功能，但不显示 agent controls，也不发起 agent-specific 请求。

Safety:

- 不从 stale projection artifact 推断用户意图。
- 不因为文件系统 artifact 存在或缺失就静默重写 desired state。

Examples:

- 如果 ~/.config/opencode/skills/superpowers/executing-plans 存在，但 manifest 没有为该 member 选择 OpenCode agent，UI chip 仍保持未选择。
- 如果 local skill path 不存在，UI 可以展示路径缺失，同时保留 manifest entry。

Tests:

- packages/web/test/views.test.tsx
- packages/server/test/api/local-skill-status.test.ts
- packages/web/test/vars-view.test.tsx

## R-CROSS-002 desired-state 编辑后自动 reconcile projection

Status: active
Applies to: skills, MCP, memory

Rule:
用户修改 skills 或 Memory 的 desired agent state 后，Loom 应自动 reconcile 对应 projection，不要求用户再手动点击一次 project。MCP 是显式 Project changes 例外，见 R-MCP-002。

Implications:

- 单个 agent toggle 保存 manifest 后，会投影相关 scope。
- Memory 页面修改某个 agent 的 Memory assignment 后，会自动运行 memory projection。
- 批量 agent 更新在所有 manifest 更新成功后投影。
- 保存 source members/resources selection 后，会投影 skills。
- MCP agent chip 和全局 agent chip 只保存 desired agent state，不自动投影；MCP projection 由 Project changes 显式触发。

Safety:

- 批量更新中途失败且已有部分更新成功时，要刷新 manifest，让 UI 反映已保存状态。
- projection 成功前不能报告整体成功。

Examples:

- 点击某个 skill 的 OC chip，会更新 manifest agents，然后运行 skills projection。
- 把 Memory `team` 分配给 OpenCode，会更新 `memory_agents.opencode`，然后运行 memory projection。
- 保存 source 内容选择，会更新 source members/resources，然后运行 skills projection。
- 点击 MCP server 的 CX chip，只更新 manifest agents；用户点击 MCP 页面 Project changes 后才运行 MCP projection。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-CROSS-003 批量控制必须有明确 scope

Status: active
Applies to: skills, MCP

Rule:
批量 agent 控制必须让 scope 清晰，并且只更新该 scope。

Implications:

- 全局 skills 批量控制作用于全部 skills。
- Source 级 skills 批量控制只作用于该 source 下 selected members。
- Item 级控制只作用于该 item。
- Source 内容选择与 agent 应用是分离的操作；Add/Edit Source 内不提供 agent controls。

Safety:

- Source 级批量操作不能更新 local skills 或其他 sources。
- 未选择的 source bundles 不能因为批量 agent 操作而加入 manifest 或被投影。

Examples:

- superpowers source header 的 OpenCode chip 只更新 selected superpowers members。
- 顶部 skills 批量 OpenCode chip 更新所有 source members 和 local skills。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-CROSS-004 除非 Loom 能证明归属，否则保留 user-owned artifacts

Status: active
Applies to: projection, skills, MCP, memory

Rule:
Loom 可以删除或替换自己能识别为 Loom-managed 的 artifacts。没有这种证明的 artifacts 视为 user-owned，必须保留。

Implications:

- Copy-projected skill 目录需要 Loom marker，cleanup 才能删除。
- Agent-native config merge 必须保留未知为 Loom-managed 的条目。
- Cleanup 只有在删除 managed child 后，才可以顺带删除空 parent，并且最多删到 projection root。

Safety:

- 不能只根据路径形状删除真实目录。
- 不能把没有 marker 的 source/member 目录视为 Loom-managed。

Examples:

- 包含 .loom-projection.json 的 copied skill 可以在 agents 清空后删除。
- 没有 marker 的 skills/superpowers/custom-skill 目录必须保留。

Tests:

- packages/server/test/projection/executor.test.ts
- packages/server/test/projection/mcp-merge.test.ts

## R-CROSS-005 外部路径操作只能作用于仓库内目标

Status: active
Applies to: server API, web UI

Rule:
Loom 可以解析当前仓库内已存在文件或目录的真实绝对路径，用于复制路径或请求受支持的本机应用打开目标。请求使用仓库相对路径；server 统一执行安全解析，打开操作额外使用受限应用标识。

Implications:

- 目标可以是文件或目录，不绑定特定扩展名或业务资源类型。
- 复制路径返回运行平台的原生绝对路径。
- 首版支持 macOS 和 Windows；不支持的平台返回明确诊断。
- 系统文件管理器对文件执行定位选择，对目录直接打开。
- 上次选择的应用保存在设备级 Loom 配置中，跨仓库、文件和浏览器复用。

Safety:

- 不接受绝对路径、路径穿越或符号链接后落到仓库外的目标。
- 不通过 shell 拼接用户提供的路径或应用名称。
- 应用标识必须来自 server 定义的白名单。

Tests:

- packages/server/test/api/open-path.test.ts
- packages/server/test/platform/node/external-opener.test.ts
- packages/web/test/open-with.test.tsx
