# Projection 规则

Projection 把 manifest desired state 对齐到 agent-native 文件和配置。本文件定义 projection 可以创建、替换或删除什么。

## R-PROJECTION-001 Projection 是 desired-state reconciliation

Status: active
Applies to: skills, MCP, memory

Rule:
Projection 把 Loom 中选择的 desired state 写入同时满足 Configured、Applicable 和 Installed 的 agents。Projection 不能从现有 agent 文件反向推断新的 desired state。

Implications:

- 没有 agents 的 item 不应该继续保持 projected。
- manifest 中选择了 agent 且源内容可用时，应投影到该 agent。
- Scoped projection 只准备和写入所选领域；MCP 或 memory projection 不读取、安装或更新 skill sources。
- Projection error 必须暴露，不能静默假装 reconciliation 已完成。
- Skills 只删除 marker 或 namespace ownership 能证明为 managed 的 artifacts；MCP 只删除 managed id state 证明的 entries。
- Memory 不因 agent 从配置移除而删除既有原生文件，直到存在独立 ownership 设计。

Safety:

- 保留不属于 known managed artifact 的 user-owned 文件和目录。
- Projection 失败时，在可回滚范围内回滚已创建的 projection artifacts。

Examples:

- 清空 managed copied source member 的最后一个 agent，会删除该 copied member 目录。
- 如果 projection 在创建 link 后失败，rollback 会删除该 link。

Tests:

- packages/server/test/projection/executor.test.ts
- packages/server/test/projection/scan.test.ts
- packages/server/test/projection/undo-memory.test.ts

## R-PROJECTION-002 Copy projection 必须标记 managed skill directories

Status: active
Applies to: local skills projection

Rule:
当 local skills 使用 copy projection 时，Loom 会在 copied skill 目录写入 .loom-projection.json marker。Cleanup 使用该 marker 区分 managed copy 和 user-owned directory。Remote source namespace 使用 R-PROJECTION-006 的整体 ownership contract。

Implications:

- 带 marker 的 copied directories 可以在 reconciliation 中被替换或删除。
- 没有 marker 的真实目录必须保留，即使其路径看起来像 source member id。
- Rollback 只有在 copied artifact 带 marker 时才可以删除它。

Safety:

- 不删除没有 marker 的 legacy 或用户创建目录。
- 不只用 source/member 路径形状证明归属。

Examples:

- skills/superpowers/executing-plans/.loom-projection.json 表示 Loom 可以在 agents 清空时删除该 copied skill。
- skills/superpowers/executing-plans/SKILL.md 存在但没有 marker 时必须保留。

Tests:

- packages/server/test/projection/executor.test.ts

## R-PROJECTION-003 只在删除 managed child 后清理空 namespace parent

Status: active
Applies to: skills projection

Rule:
Projection 删除 managed 或 linked skill child 后，可以删除随之变空的 parent namespace directories。如果 agent skills root 因本次 cleanup 变空，也可以删除该 skills root，但不能继续删除 skills root 的父目录。

Implications:

- 删除最后一个 managed local skill child 后，可以删除随之变空的 namespace directory。
- 删除最后一个 managed skill 后，如果 skills root 为空，也会删除 skills root。
- 非空 parent directory 保留。
- Parent cleanup 是 managed child cleanup 的后续动作，不是独立扫描并删除目录。

Safety:

- 只在删除 managed child 后清理空 skills root。
- 永远不删除非空 parent directory。
- 不因为 parent directory 看起来像 source repo id 就删除它。

Examples:

- 删除 skills/local-group/example 后，只有当 skills/local-group 变空时才删除 skills/local-group。
- 如果 skills/local-group 是 skills root 下最后一个条目，删除后也可以删除空的 skills root。
- 如果 skills/local-group/custom 仍存在，skills/local-group 必须保留。

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

- 同一个 MCP server 投影到 Claude Code、Codex、OpenCode 时，`${var}` 可以解析成不同 agent-specific value。
- Projection 使用 Base → Base/agent → Local → Local/agent → Runtime 的覆盖语义。
- Preview agent 的展示语义必须与真实 projection 的 per-agent vars 渲染语义一致。

Safety:

- 不能把 UI 当前 preview agent 用作所有目标 agent 的投影上下文。
- 缺失变量或解析错误必须暴露为 projection error 或 preview diagnostic，不能静默写入错误值。

Examples:

- `${browsers_path}` 投影到 Codex 时使用 Codex 的 resolved value，投影到 OpenCode 时使用 OpenCode 的 resolved value。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/server/test/projection/mcp-merge.test.ts

## R-PROJECTION-006 Remote source 按 source namespace 整体 reconcile

Status: active
Applies to: remote source skills projection

Rule:
每个 remote source 投影到 `<agent-skills>/<source-name>/` 独立 namespace。Projection planner 对每个 agent 收集该 source 的 selected bundle roots 和 selected resource roots，移除它们的最长共同父路径前缀后保留其余目录结构；executor 将该 namespace 作为一个 managed unit 整体替换。

Implications:

- 最长共同父路径只移除 selected roots 共同的未选择祖先，不能移除 selected root 自身名称。
- 未选择的空父目录自然省略；若省略后产生同名 destination collision，必须保留足以消除冲突的父目录。
- SkillBundle 内部结构始终完整保留；明确选择的 resource directory 保留自身名称和内部相对结构。
- 不同 agent 的 members 不同，因此各自计算 projection base；source-global resources 只投影到至少选择了该 source 一个 member 的 agent。
- 选择或 source 内容变化导致 projection base 改变时，旧路径的清理和新路径的创建属于同一次 desired-state reconcile。

Safety:

- Namespace root 必须有能证明 repo 和 source 归属的 marker；marker 不保存可能包含凭据的原始 Git URL。
- 同一 agent 中，local skill destination 不得与 source namespace 重合或位于其下；planner 必须在任何文件系统写入前拒绝冲突。
- 替换或删除现有 namespace 前必须验证 marker ownership；没有 marker、marker 不匹配或 destination collision 时 projection 失败并保留原内容。
- Namespace staging、替换和跨 agent 执行必须可回滚；全部成功前不能删除 backups 或报告成功。
- Executor 只物化 SourceTree commit 中的 tracked files；cache checkout 中的未跟踪文件不得进入 namespace。
- Projection 前必须将 Loom 管理的 source cache checkout 对齐到 plan 的 SourceTree commit；cache 漂移时只能使用本地已有 Git 对象恢复，不得隐式 fetch。
- Link projection 必须区分 file/directory link；稀疏目录不得用覆盖 excludes 的整目录 link。Copy 必须保持二进制内容。
- Source 改名后的 orphan cleanup 只能删除 marker 能证明属于同一 repo/source 的旧 namespace。

Examples:

- 选择 `folder/skill-dir1`、`folder/skill-dir2` 和 `folder/shared` 时，agent 省略共同祖先 `folder`，保留三个 selected roots 的相对结构。
- `team-a/skill` 与 `team-b/skill` 同时选择时，agent 保留 `team-a` 和 `team-b`，避免两个 `skill` 冲突。

Tests:

- packages/core/test/projection.test.ts
- packages/server/test/projection/executor.test.ts
- packages/server/test/projection/executor-source-namespace.test.ts
