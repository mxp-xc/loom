# Projection 规则

Projection 把 manifest desired state 对齐到 agent-native 文件和配置。本文件定义 projection 可以创建、替换或删除什么。

## R-PROJECTION-001 Projection 是 desired-state reconciliation

Status: active
Applies to: skills, MCP, memory

Rule:
Projection 把 Loom 中选择的 desired state 写入支持的 agents。Projection 不能从现有 agent 文件反向推断新的 desired state。

Implications:

- 没有 targets 的 item 不应该继续保持 projected。
- manifest 中选择了 target 且源内容可用时，应投影到该 target。
- Projection error 必须暴露，不能静默假装 reconciliation 已完成。

Safety:

- 保留不属于 known managed artifact 的 user-owned 文件和目录。
- Projection 失败时，在可回滚范围内回滚已创建的 projection artifacts。

Examples:

- 清空 managed copied source member 的最后一个 target，会删除该 copied member 目录。
- 如果 projection 在创建 link 后失败，rollback 会删除该 link。

Tests:

- packages/server/test/projection/executor.test.ts
- packages/server/test/projection/undo-memory.test.ts

## R-PROJECTION-002 Copy projection 必须标记 managed skill directories

Status: active
Applies to: skills projection

Rule:
当 skills 使用 copy projection 时，Loom 会在 copied skill 目录写入 .loom-projection.json marker。Cleanup 使用该 marker 区分 managed copy 和 user-owned directory。

Implications:

- 带 marker 的 copied directories 可以在 reconciliation 中被替换或删除。
- 没有 marker 的真实目录必须保留，即使其路径看起来像 source member id。
- Rollback 只有在 copied artifact 带 marker 时才可以删除它。

Safety:

- 不删除没有 marker 的 legacy 或用户创建目录。
- 不只用 source/member 路径形状证明归属。

Examples:

- skills/superpowers/executing-plans/.loom-projection.json 表示 Loom 可以在 targets 清空时删除该 copied skill。
- skills/superpowers/executing-plans/SKILL.md 存在但没有 marker 时必须保留。

Tests:

- packages/server/test/projection/executor.test.ts

## R-PROJECTION-003 只在删除 managed child 后清理空 namespace parent

Status: active
Applies to: skills projection

Rule:
Projection 删除 managed 或 linked skill child 后，可以删除随之变空的 parent namespace directories，但最多删到 agent skills root 的下一层，不能删除 skills root 本身。

Implications:

- 删除最后一个 managed superpowers/* skill 后，也会删除空的 superpowers directory。
- 非空 parent directory 保留。
- Parent cleanup 是 managed child cleanup 的后续动作，不是独立扫描并删除目录。

Safety:

- 永远不删除 agent skills root。
- 永远不删除非空 parent directory。
- 不因为 parent directory 看起来像 source repo id 就删除它。

Examples:

- 删除 skills/superpowers/executing-plans 后，只有当 skills/superpowers 变空时才删除 skills/superpowers。
- 如果 skills/superpowers/custom 仍存在，skills/superpowers 必须保留。

Tests:

- packages/server/test/projection/executor.test.ts

## R-PROJECTION-004 MCP projection 保留 non-managed entries

Status: active
Applies to: MCP projection

Rule:
MCP projection 合并 Loom-managed MCP entries，同时保留不在 Loom managed id set 中的用户手写 entries。

Implications:

- 从 Loom 删除一个 MCP server，会删除对应 managed projected entry。
- Loom managed ids 之外的既有 entries 保留。
- 如果 managed state 缺失，MCP merge 安全降级为保留既有 entries。

Safety:

- First run 或 state 丢失后，不删除 unknown MCP entries。

Examples:

- 如果 Loom 之前 managed filesystem，从 manifest 删除它会移除 projected filesystem MCP entry。
- 用户手写的 custom-local MCP entry 保留。

Tests:

- packages/server/test/projection/mcp-merge.test.ts

## R-PROJECTION-005 MCP projection 按目标 agent 渲染 vars

Status: active
Applies to: MCP projection, vars

Rule:
MCP projection 写入某个 agent-native MCP 配置时，必须使用该目标 agent 的 Vars 解析结果渲染 server definition。

Implications:

- 同一个 MCP server 投影到 CC、CX、OC 时，\`\${var}\` 可以解析成不同 agent-specific value。
- Projection 使用 Base → Base/agent → Local → Local/agent → Runtime 的覆盖语义。
- Preview target 的展示语义必须与真实 projection 的 per-agent vars 渲染语义一致。

Safety:

- 不能把 UI 当前 preview target 用作所有目标 agent 的投影上下文。
- 缺失变量或解析错误必须暴露为 projection error 或 preview diagnostic，不能静默写入错误值。

Examples:

- \`\${browsers_path}\` 投影到 Codex 时使用 Codex 的 resolved value，投影到 OpenCode 时使用 OpenCode 的 resolved value。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/server/test/projection/mcp-merge.test.ts
