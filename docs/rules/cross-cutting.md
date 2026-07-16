# 跨模块规则

这些规则适用于 skills、MCP、memory、vars，以及未来新增的可投影配置。

## R-CROSS-001 UI 反映 desired state，而不是文件系统偶然状态

Status: active
Applies to: skills, MCP, memory, vars, projection

Rule:
Loom UI 必须反映 manifest/config 中的 desired state。磁盘上已有文件可以用于展示可用性或诊断信息，但不能被静默推断成用户已选择的 desired state。

Implications:

- Target chip 显示 manifest 是否选择了对应 agent。
- 磁盘上的 projection artifact 不会单独让某个 item 显示为已选择。
- 引用的本地文件缺失时，UI 可以展示 unavailable 或缺失诊断，但不能自动删除 desired entry。
- Vars 的目标 agent chips 必须来自 Settings targets；default/agent 查看范围独立于“配置管理/最终结果”视图切换，配置管理中的当前值按所选查看范围展示 default 或 agent-specific 值。
- 需要初始 agent 视角的只读/详情视图（例如 Vars 最终结果）默认使用 Settings 中的首个 target；没有 configured target 时才回退到产品默认 agent。

Safety:

- 不从 stale projection artifact 推断用户意图。
- 不因为文件系统 artifact 存在或缺失就静默重写 desired state。

Examples:

- 如果 ~/.config/opencode/skills/superpowers/executing-plans 存在，但 manifest 没有为该 member 选择 OpenCode target，UI chip 仍保持未选择。
- 如果 local skill path 不存在，UI 可以展示路径缺失，同时保留 manifest entry。

Tests:

- packages/web/test/views.test.tsx
- packages/server/test/api/local-skill-status.test.ts
- packages/web/test/vars-view.test.tsx

## R-CROSS-002 desired-state 编辑后自动 reconcile projection

Status: active
Applies to: skills, MCP, memory

Rule:
用户修改 skills 或 memory 的 desired target state 后，Loom 应自动 reconcile projection，不要求用户再手动点击一次 project。MCP 是显式 Project changes 例外，见 R-MCP-002。

Implications:

- 单个 target toggle 保存 manifest 后，会投影相关 scope。
- Memory 页面修改某个 Target 的 Memory 映射后，会自动运行 memory projection。
- 批量 target 更新在所有 manifest 更新成功后投影。
- 保存 source members/resources selection 后，会投影 skills。
- MCP target chip 和全局 target chip 只保存 desired target state，不自动投影；MCP projection 由 Project changes 显式触发。

Safety:

- 批量更新中途失败且已有部分更新成功时，要刷新 manifest，让 UI 反映已保存状态。
- projection 成功前不能报告整体成功。

Examples:

- 点击某个 skill 的 OpenCode chip，会更新 manifest targets，然后运行 skills projection。
- 把 Memory `team` 分配给 OpenCode，会更新 `memory_targets.opencode`，然后运行 memory projection。
- 保存 source 内容选择，会更新 source members/resources，然后运行 skills projection。
- 点击 MCP server 的 Codex chip，只更新 manifest targets；用户点击 MCP 页面 Project changes 后才运行 MCP projection。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-CROSS-003 批量控制必须有明确 scope

Status: active
Applies to: skills, MCP

Rule:
批量 target 控制必须让 scope 清晰，并且只更新该 scope。

Implications:

- 全局 skills 批量控制作用于全部 skills。
- Source 级 skills 批量控制只作用于该 source 下 selected members。
- Item 级控制只作用于该 item。
- Source 内容选择与 target 应用是分离的操作；Add/Edit Source 内不提供 target controls。

Safety:

- Source 级批量操作不能更新 local skills 或其他 sources。
- 未选择的 source bundles 不能因为批量 target 操作而加入 manifest 或被投影。

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

- 包含 .loom-projection.json 的 copied skill 可以在 targets 清空后删除。
- 没有 marker 的 skills/superpowers/custom-skill 目录必须保留。

Tests:

- packages/server/test/projection/executor.test.ts
- packages/server/test/projection/mcp-merge.test.ts
