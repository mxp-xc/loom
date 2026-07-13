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

## R-SKILLS-005 Source scan 使用 ref-aware SKILL.md pattern

Status: active
Applies to: source scan, source members

Rule:
Source scan 默认使用 `**/SKILL.md`，并可由 source 的 `scan` pattern 缩小扫描范围。扫描必须基于该 source 当前选择的 ref。任意匹配到的 `SKILL.md` 所在目录都可成为 source member，member name 来自该目录 basename。

Implications:

- `skills/<name>/SKILL.md`、`skills/<category>/<name>/SKILL.md` 和其他目录下的 `SKILL.md` 使用同一套发现规则。
- 空 `scan` 表示使用默认 `**/SKILL.md`，不写入 manifest。
- root-level `SKILL.md` 使用 source repo id 作为 member name。
- Scan results 和保存后的 source members 必须保留 runtime `path`，以便 projection 和详情页读取真实 source member 目录。

Safety:

- 同一 source 内如果多个 `SKILL.md` 派生出相同 member name，scan 必须失败并提示冲突路径，不能静默覆盖。
- Member name 仍需满足 skill id 命名约束；无效目录名跳过并记录 warning。
- `path` 只作为 source cache 内的相对 `SKILL.md` 路径使用，不能解析为任意绝对路径或父目录跳转。

Examples:

- `skills/engineering/tdd/SKILL.md` 发现为 member `tdd`，runtime path 为 `skills/engineering/tdd/SKILL.md`。
- `scan: skills/engineering/**/SKILL.md` 只发现 engineering 范围内的 source members。

Tests:

- packages/server/test/projection/scan.test.ts
- packages/server/test/remote/discover.test.ts
- packages/server/test/api/routes-fixes.test.ts
- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-SKILLS-006 Source name 是 projection namespace

Status: active
Applies to: remote sources, skills projection, skills UI

Rule:
每个 source 都有稳定的 `name`。新增 source 时如果用户没有提供 `name`，系统使用 URL 派生仓库名作为默认值并持久化到 `skills.yaml`。`name` 用于 UI 展示和 source member projection namespace；remote cache identity 仍由 source URL 派生。

Implications:

- 保存 source 时必须写入 `name`，旧配置缺失 `name` 时运行时回退到 `deriveRepoId(url)`。
- 同一个 `skills.yaml` 内 source `url` 和 source `name` 都不能重复。
- 修改 `name` 后必须重新投影 skills，因为 desired projection namespace 已变化。
- 查找 `remote-cache`、刷新 source、读取 source 内容时不能使用 `name` 作为 cache id。

Safety:

- `name` 只能匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`。
- source 改名不记录 `previousName`；旧 namespace 只能由 projection orphan cleanup 删除可证明为 Loom-managed 的 artifacts。
- 无 marker 的真实目录必须保留。

Examples:

- `name: openai-skills` 且 member `brainstorming` 在 `skill_naming: dir` 下投影为 `openai-skills/brainstorming`。
- 同一个 URL 的 cache 仍位于 `remote-cache/<deriveRepoId(url)>`，改名不会触发新的 cache 目录。

Tests:

- packages/core/test/manifest.test.ts
- packages/core/test/mutators.test.ts
- packages/core/test/projection.test.ts
- packages/server/test/skills/application.test.ts
- packages/server/test/projection/executor.test.ts
- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-SKILLS-007 Source member 缺失必须确认 reconcile

Status: active
Applies to: remote source updates, source scan, source members, local skills

Rule:
远端更新或 source scan/member 选择变化导致已保存 member 缺失时，Loom 必须展示缺失项并让用户决定删除或保留为 local skill。缺失项默认选择保留；保留项复制到 assets/skills/<id>，并继承原 targets。

Implications:

- 更新结果分别展示新增、更新和远端已删除的 members。
- 缺失项支持逐项选择、全选、取消全选和不保留。
- 远端更新会更新 cache 内容、持久化最新 commit 和完整 member 集合。
- 最终选择保存后自动 reconcile skills projection。

Safety:

- 现有 local skill 目录或 manifest entry 不得被覆盖。
- 用户确认前不得丢弃需要保留的旧 member 内容。
- Manifest 保存和 projection 完成前不能报告整体更新成功。

Examples:

- Source 更新后远端删除 alpha；用户保留 alpha 时，它复制到 assets/skills/alpha 并继续使用原 targets。
- 修改 scan 后 beta 不再出现在选中视图；保存前同样要求用户决定保留或删除 beta。

Tests:

- packages/server/test/remote/update.test.ts
- packages/server/test/skills/reconciliation.test.ts
- packages/server/test/skills/application.test.ts
- packages/web/test/skill-reconciliation-dialog.test.tsx
- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx
