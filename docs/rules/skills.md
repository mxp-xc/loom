# Skills 规则

这些规则定义 local skills、remote sources、source members、target controls 和 skills projection 行为。

## R-SKILLS-001 assets/skills 是仓库内置 local skill home

Status: active
Applies to: local skills

Rule:
assets/skills/<id> 是 local skills 的内置仓库扫描路径。从这里发现的 skill 应保存为 pathless local skill id，除非用户明确引用其他路径。

Implications:

- Built-in local skills 不应仅因为位于 assets/skills 下就显示为 external ref。
- 当 manifest 中确实配置了 ref path 时，UI 仍可展示可用性和路径诊断。

Safety:

- 不把内置仓库 skills 转成不必要的 path refs。
- 用户明确配置的 path refs 需要保留。

Examples:

- 从内置扫描路径导入 assets/skills/test-qa-skill 时，应表示为 { id: 'test-qa-skill' }。
- 内置扫描路径之外的 custom path 可以保持为 { id, path }。

Tests:

- packages/server/test/api/routes-fixes.test.ts
- packages/web/test/views.test.tsx

## R-SKILLS-002 Source member 顺序与 scan 结果保持一致且稳定

Status: active
Applies to: source members

Rule:
已保存 source members 和 scan results 应使用同一套确定性展示顺序。

Implications:

- Source list 不应使用与 scan UI 不同的 member 排序。
- 排序应稳定，并且对 skill id 足够 locale-independent。

Safety:

- 展示顺序不能依赖 remote filesystem traversal order。

Examples:

- brainstorming 排在 dispatching-parallel-agents 前，dispatching-parallel-agents 排在 executing-plans 前。

Tests:

- packages/web/test/skill-member-order.test.ts
- packages/web/test/views.test.tsx

## R-SKILLS-003 Source-level target controls 只作用于 enabled members

Status: active
Applies to: source members, skills UI

Rule:
Source 级 target chip 只作用于该 source 下 enabled members。

Implications:

- 如果每个 enabled member 都已有该 target，点击 source chip 会从 enabled members 移除该 target。
- 否则，点击 source chip 会把该 target 添加到 enabled members。
- Disabled source members 不会因为 source-level bulk action 被投影。

Safety:

- Source-level control 不能更新 local skills。
- Source-level control 不能更新其他 sources。

Examples:

- 点击 source header 中的 superpowers OC，只更新 enabled superpowers members。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-SKILLS-004 Bulk scope 的 target chip 是三态

Status: active
Applies to: skills UI, MCP UI

Rule:
Bulk target chips 表达其 scope 内的全部选择、全部未选择或部分选择状态。

Implications:

- on 表示 scope 内每个 applicable item 都有该 target。
- off 表示 scope 内没有 applicable item 有该 target。
- mixed 表示 scope 内部分但非全部 applicable items 有该 target。
- 有帮助时，mixed chip 应展示计数。

Safety:

- 不能仅因为存在 stale projection artifact 就把 bulk chip 显示为 selected。

Examples:

- 如果 12 个 source members 中有 2 个 target OpenCode，source 或 global chip 可以显示 2/12。

Tests:

- packages/web/test/views.test.tsx
