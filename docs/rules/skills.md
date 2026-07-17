# Skills 规则

这些规则定义 local skills、remote sources、source members、agent controls 和 skills projection 行为。

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

## R-SKILLS-002 Source member 顺序与 SourceTree 保持一致且稳定

Status: active
Applies to: source members

Rule:
已保存 source members 和 SourceTree 中派生的 bundle results 应使用同一套确定性展示顺序。

Implications:

- Source list 不应使用与 Bundle/Tree 选择界面不同的 member 排序。
- 排序应稳定，并且对 skill id 足够 locale-independent。

Safety:

- 展示顺序不能依赖 remote filesystem traversal order。

Examples:

- brainstorming 排在 dispatching-parallel-agents 前，dispatching-parallel-agents 排在 executing-plans 前。

Tests:

- packages/web/test/skill-member-order.test.ts
- packages/web/test/views.test.tsx

## R-SKILLS-003 Source-level agent controls 只作用于 selected members

Status: active
Applies to: source members, skills UI

Rule:
Source 级 agent chip 只作用于该 source 的 `members` 中已选择的 bundles。

Implications:

- 如果每个 selected member 都已有该 agent，点击 source chip 会从 selected members 移除该 agent。
- 否则，点击 source chip 会把该 agent 添加到 selected members。
- 未写入 `members` 的 bundles 不会因为 source-level bulk action 被选择或投影。
- Global、source、item 和 detail agent controls 只枚举 Applicable Skills agents；隐藏 agent 的已保存选择保持不变。
- Applicable Skills agents 为空时，内容浏览、source 管理和编辑仍可用，但不显示 agent controls。

Safety:

- Source-level control 不能更新 local skills。
- Source-level control 不能更新其他 sources。

Examples:

- 点击 source header 中的 superpowers OpenCode chip，只更新 selected superpowers members。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-SKILLS-004 Bulk scope 的 agent chip 是三态

Status: active
Applies to: skills UI, MCP UI

Rule:
Bulk agent chips 表达其 scope 内的全部选择、全部未选择或部分选择状态。

Implications:

- on 表示 scope 内每个 applicable item 都有该 agent。
- off 表示 scope 内没有 applicable item 有该 agent。
- mixed 表示 scope 内部分但非全部 applicable items 有该 agent。
- 有帮助时，mixed chip 应展示计数。

Safety:

- 不能仅因为存在 stale projection artifact 就把 bulk chip 显示为 selected。

Examples:

- 如果 12 个 source members 中有 2 个 agent OpenCode，source 或 global chip 可以显示 2/12。

Tests:

- packages/web/test/views.test.tsx

## R-SKILLS-005 Remote source scan 生成完整 SourceTree

Status: active
Applies to: source scan, source members

Rule:
Remote source scan 必须读取当前 ref 对应 commit 的完整 Git tree，并从同一棵 SourceTree 派生 Bundle 和 Tree 视图。Remote source 不提供或保存自定义 glob；manifest 出现遗留 `scan` 字段时必须明确报错。

Implications:

- 目录直接包含大小写精确的 `SKILL.md`，且后代不存在另一个 SkillBundle 时，该目录构成一个不可拆分的 SkillBundle。
- 目录直接包含 `SKILL.md`，同时后代存在 SkillBundle 时，scan 必须报告所有冲突 entry paths，并阻止保存和投影。
- SkillBundle 在 Tree 中作为单个节点展示；其内部文件不能单独选择。
- SkillBundle 外的普通文件作为 resources 展示；结构目录作为 containers 展示。
- Git symlink 和 submodule 不可选择；SkillBundle 内出现 symlink 或 submodule 时，该 bundle 无效。
- Local skill discovery 继续使用其现有发现规则，不受 remote SourceTree 约束。

Safety:

- SourceTree 只包含目标 commit 中受 Git 管理的 entries，不跟随 symlink、不拉取 submodule，也不包含 checkout 中的未跟踪内容。
- 同一 source 内 member `entry` 和 `name` 分别唯一；冲突必须明确报错，不能静默覆盖。
- `entry` 是规范化的 source-relative `SKILL.md` 路径，不能为绝对路径或包含父目录跳转。
- Member name 仍需满足 skill id 命名约束。
- Root-level `SKILL.md` 的 member name 使用 source name；其他 bundle 使用其所在目录 basename。

Examples:

- `skills/engineering/tdd/SKILL.md` 发现为 member `tdd`，canonical entry 为 `skills/engineering/tdd/SKILL.md`。
- 外层和内层目录都直接包含 `SKILL.md` 时，source 在结构修正前不能保存。

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
远端更新或 SourceTree 变化导致已保存 member 缺失时，Loom 必须展示缺失项并让用户决定删除或保留为 local skill。缺失项默认选择保留；保留项复制到 assets/skills/<id>，并继承原 agents。

Implications:

- 更新结果分别展示新增、更新和远端已删除的 members。
- 缺失项支持逐项选择、全选、取消全选和不保留。
- 打开 Skills 页面和编辑现有 source 不得访问远端；编辑内容初始只读取 live cache 中的 pinned commit，cache 缺失时明确报错，不自动拉取或修复。
- Remote refs 只在用户首次打开 ref 选择或切换 branch/tag 时按需读取；同一编辑会话内复用结果。
- 远端 SourceTree 只在用户选择其他 ref 或主动刷新时读取。
- 初始编辑和未主动扫描的同 ref/type 保存必须基于当前 pinned commit，不得隐式拉取远端或替换 live cache。
- 用户主动刷新或选择其他 ref 后，保存必须绑定当前展示的 SourceTree commit；如果该 ref 在扫描后再次移动，保存明确失败并要求刷新，不能静默写入其他 commit。
- 远端更新先在隔离 candidate 中扫描和生成 preview；用户确认 finalize 前不能改变 live cache。
- Finalize 同时更新 cache、最新 commit、selection 和 projection；任一步失败必须恢复更新前状态。
- 更新前 cache 缺失或损坏时，recovery 不得依赖该 cache 重新生成旧 projection，也不能因此阻塞重试。
- 最终选择保存后自动 reconcile skills projection。

Safety:

- 现有 local skill 目录或 manifest entry 不得被覆盖。
- 用户确认前不得丢弃需要保留的旧 member 内容。
- Manifest 保存和 projection 完成前不能报告整体更新成功。

Examples:

- Source 更新后远端删除 alpha；用户保留 alpha 时，它复制到 assets/skills/alpha 并继续使用原 agents。
- SourceTree 更新后 beta 对应的 entry 缺失；保存前必须要求用户决定保留或删除 beta。

Tests:

- packages/server/test/remote/update.test.ts
- packages/server/test/skills/reconciliation.test.ts
- packages/server/test/skills/application.test.ts
- packages/web/test/skill-reconciliation-dialog.test.tsx
- packages/web/test/manifest-operations.test.tsx
- packages/web/test/views.test.tsx

## R-SKILLS-008 顶层 group 顺序是仓库共享展示状态

Status: active
Applies to: skills manifest, skills UI

Rule:
`skills.yaml.group_order` 非权威地表达 source groups 与整个 local group 的展示顺序。Source 使用 `source:<url>`，存在至少一个 local skill 时使用 `local`；source member 与 local group 内的 skill 不参与排序。

Implications:

- 读取时按保存顺序去重、忽略未知 group，并按当前 source 顺序追加遗漏 source，最后按需追加 local。
- 字段缺失、类型错误或包含非字符串时回退为当前 source 顺序加末尾 local。
- 读取不自动改写；下一次成功 reorder 或相关 Skills mutation 写入完整规范顺序。

Safety:

- `group_order` 不能创建、删除、隐藏或恢复任何 skill 实体。
- Reorder 不修改 agents、source/member 定义，也不触发 projection。

Examples:

- 当前 groups 为 A、C、local，保存值为 B、A、A 时，展示顺序为 A、C、local。

Tests:

- packages/core/test/order.test.ts
- packages/server/test/skills/application.test.ts
- packages/web/test/views.test.tsx

## R-SKILLS-009 Source URL 使用标准 Git remote URL

Status: active
Applies to: remote sources, source scan, source updates

Rule:
Source `url` 必须使用 Git 可直接识别的完整 remote URL。Loom 将该值原样传给 Git，不展开 provider-specific 简写。新增 Source 的 UI 默认引导使用 HTTPS；用户仍可显式配置 SSH URL。

Implications:

- HTTPS URL 可用于 GitHub、GitLab、GitCode、Gitee 或自建 Git 服务。
- SSH URL 使用运行 Loom 的系统 Git/SSH 凭据和 host 配置。
- `github:owner/repo`、`gitee:owner/repo` 等 Loom 简写不受支持。

Safety:

- Loom 不得把用户选择的 SSH URL 静默改写为 HTTPS，反之亦然。
- Loom 不维护 provider 域名白名单；连接和认证错误由 Git 返回。

Examples:

- `https://git.example.com/team/skills.git`
- `git@gitcode.com:team/skills.git`

Tests:

- packages/server/test/remote/discover.test.ts
- packages/server/test/remote/update.test.ts
- packages/core/test/derive-repo-id.test.ts

## R-SKILLS-010 Source selection 只持久化不可推导的 desired state

Status: active
Applies to: remote sources, source members, source resources, skills UI

Rule:
完整 SourceTree 是运行时扫描结果，不写入 manifest。`members` 保存用户选择的 SkillBundles，source-global `resources.include/exclude` 保存 SkillBundle 外的普通资源选择；Bundle 和 Tree 视图共享同一份选择状态。

Implications:

- Member 使用 `{ name, entry, agents? }`；是否被选择由它是否存在于 `members` 表达，不存在独立 `enabled`。
- `entry` 是 member identity；API 和 agent mutation 必须按 `entry` 定位，`name` 只保存当前展示快照。
- Resource rule 使用规范化的 source-relative `path` 和 `kind: file | directory`；路径优先采用最具体规则，相同路径下 exclude 优先。
- Resource directory 的选择遇到 SkillBundle root 时停止，不会自动选择当前或以后新增的 bundles。
- Bundle 视图默认打开，只展示 SkillBundles；Tree 视图同时展示 bundles、containers 和 resources。
- 普通 resources 默认未选择；搜索只影响查找和祖先展开，不改变 desired state。
- Add/Edit Source 内只编辑 source 内容选择，不配置 member agents；agents 由 Skills 外层 controls 管理。
- Skills source 列表必须展示已保存的 resource include/exclude 规则，并允许独立折叠 resources，不与 SkillBundle 或 agent 状态混淆。
- Edit Source 可以从当前 live cache 内嵌只读预览 SkillBundle；隔离扫描但尚未保存的其他 commit 只提供对应远端文件链接，不能用旧 cache 内容冒充预览。

Safety:

- 新发现的 SkillBundle 必须由用户明确选择，不能因祖先 resource directory 已选择而自动加入 `members`。
- Resource path 的实际类型与保存的 `kind` 不一致时标记 unavailable，不自动改变选择范围。
- Resource 选择属于整个 source，不配置 agents；仅当某 agent 至少有一个该 source member 时才向该 agent 投影 resources。

Examples:

- 选择 `shared/prompts` directory 会选择其中普通资源，但不会选择其后新增的 `shared/prompts/new-skill/SKILL.md` bundle。
- Bundle 视图选中一个 skill 后切换到 Tree，Tree 中同一 bundle 保持选中。

Tests:

- packages/core/test/manifest.test.ts
- packages/core/test/source-tree.test.ts
- packages/web/test/source-tree-selection.test.tsx

## R-SKILLS-011 Source Web 链接不改变 Git remote

Status: active
Applies to: remote sources, source members, skills UI

Rule:
Skills UI 可以从 Source Git remote 推导仓库主页和 member 文件 Web 链接，但推导结果只用于展示，不得写回 Source 或替代 scan、update、clone 使用的 remote。

Implications:

- GitHub、GitCode 和 Gitee member 使用 `/blob/<ref>/<path>`，GitLab 使用 `/-/blob/<ref>/<path>`。
- 未识别但可解析的 forge 使用 `/blob/<ref>/<path>` 作为 best-effort 降级。
- 无法生成安全 HTTP(S) URL 时，UI 显示原 remote 文本但不提供外链。

Safety:

- Web 链接只能使用 HTTP(S)，不能包含 Git remote 中的 username、password、query 或 fragment。
- SSH username 和 transport port 不能进入推导后的 Web URL。
- Web 链接推导不能修改 R-SKILLS-009 规定的 Git transport 行为。

Examples:

- `git@gitcode.com:team/skills.git` 的仓库主页为 `https://gitcode.com/team/skills`。
- GitCode member `skills/example/SKILL.md` 在 `main` 下使用 `https://gitcode.com/team/skills/blob/main/skills/example/SKILL.md`。

Tests:

- packages/web/test/repository-links.test.ts
- packages/web/test/views.test.tsx
