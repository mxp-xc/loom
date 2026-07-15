# Skills SourceTree 与组合资源投影

## 目标

保留现有以 SkillBundle 列表添加独立 skills 的轻量体验，并新增完整目录树视图，让用户可以把同一 source 内的共享流程、脚本、模板、图片和其他资源与 skills 一起投影。Loom 不解析 `SKILL.md` 中的自然语言引用，而是通过保留所选内容之间的目录关系，使 Agent 能按相对路径访问这些资源。

## 范围与边界

- 关联内容只允许来自同一个 source，不支持跨 source 依赖、本地任意路径依赖或远程 URL 依赖。
- 不引入 source mode。Bundle 视图和 Tree 视图来自同一个扫描结果，共享同一份选择状态。
- 不生成中转 `SKILL.md`，不改写 skill 内容，也不解析 Markdown 链接或自然语言引用。
- 删除自定义 glob 扫描能力。Source 扫描完整目录树；搜索只影响界面查找，不改变扫描范围或 desired state。
- Tree 交互使用成熟的开源 React 组件，不手写树的键盘导航、多选、半选和展开状态基础设施。

## 相关规则

- [跨模块规则](../../rules/cross-cutting.md)
- [Skills 规则](../../rules/skills.md)
- [Projection 规则](../../rules/projection.md)

实现本设计时必须同步更新其中受影响的 source scan、member identity、projection namespace 和 managed artifact 规则。

## 删除现有 Source Glob 能力

- Remote source 不再提供或保存自定义 glob pattern，添加、编辑、扫描、刷新和更新 source 时都不能配置 glob。
- Remote source 始终读取目标 commit 的完整 Git tree，并从同一棵 SourceTree 派生 Bundle 和 Tree 视图。搜索只用于界面查找，不改变扫描范围。
- Source scan/refresh 动作继续保留；local skill discovery 不受影响。
- 不提供兼容或迁移。现有配置中出现 `scan` 字段时必须明确报错，不能静默忽略或继续使用。

## SourceTree

每个 source 只执行一次目录扫描，生成运行时 `SourceTree`。扫描、两个视图、更新比较和 projection planning 共同使用这棵树，避免分别实现 skill 扫描与 resource 扫描。

Remote source 的 SourceTree 基于 `pinned_commit` 对应的 Git tree 构建，不使用 glob，也不递归枚举 checkout 中的未跟踪文件。这样只暴露版本控制内容，并保留 Git entry type，避免 `.git`、临时文件、cache 和平台相关遍历顺序进入扫描结果。

SourceTree 包含以下节点：

- `SkillBundle`：目录直接包含大小写精确的 `SKILL.md`，并且后代不存在另一个 `SkillBundle`。Bundle root 以下的全部文件和目录属于同一个不可拆分的投影单元。
- `Container`：不构成 SkillBundle 的结构目录。它可以包含其他 containers、SkillBundles 和普通 resources。
- `Resource`：位于 SkillBundle 之外的普通文件。资源目录通过 Container 及其 resource descendants 表达。
- `Invalid candidate`：目录直接包含 `SKILL.md`，同时后代存在 SkillBundle。扫描必须报告外层和后代 entry paths；该 source 在结构修正前不能保存或投影。

Git symlink 和 submodule 作为不可选择节点显示。Scanner 不跟随 symlink，也不自动拉取 submodule。SkillBundle 内出现 symlink 或 submodule 时，整个 bundle invalid；第一版不提供内部 symlink 例外。

SkillBundle 在 Tree 视图中显示为一个折叠的 skill 节点，不展示或单独选择内部文件。Bundle 的内容始终整体更新、整体投影和整体清理。

## 双视图

Bundle 视图是默认的轻量视图，只从 SourceTree 中过滤并展示 SkillBundles，保留当前按列表查找和选择无依赖 skills 的工作流。

Tree 视图展示完整 SourceTree：

- SkillBundle 使用独立 skill 图标并保持折叠。
- Container 和普通 resources 可以展开和选择。
- 普通 resources 默认未选择，避免 Bundle 视图用户在不可见的情况下投影额外内容。
- Tree 视图提供明确的“全选资源”操作，用户可以在此基础上排除不需要的文件或目录。
- 切换视图不会自动选择、取消选择或迁移任何节点，也不作为 manifest 状态保存。

Tree 视图必须支持搜索。搜索结果保留匹配节点及其完整祖先链，并自动展开这些祖先，使用户能够看到结果在 source 中的位置并直接勾选。清除搜索后恢复正常树展示，已有选择保持不变。

Tree 视图使用 `react-arborist`，由组件提供虚拟化、过滤时保留并展开祖先、键盘导航、焦点管理、ARIA tree/treeitem 语义和可定制节点渲染。Tree 禁用重命名和拖放。Loom 在自定义节点 renderer 中提供受控 checkbox，并根据 SourceTree 的 SkillBundle 硬边界与 resource selection 规则计算 checked/indeterminate 状态；业务选择状态不复用组件的临时行选择状态。

## 保存边界

完整目录树不写入 manifest，最终 target 目录也不作为状态保存。系统只持久化用户无法从 source 重新推导的 desired selection：

```text
Source checkout
    │
    ├─ scan ──────────────> SourceTree                    runtime only
    │                           │
    │                           └─ user selection
    │                                  │
    └──────────────────────────> DesiredSelection         persisted
                                       │
                                       ├─ selected bundle entry paths
                                       ├─ selected resource roots
                                       └─ excluded resource paths
                                              │
                                              └─ plan
                                                   │
                                                   v
                                             ProjectionTree  runtime only
                                                   │
                                                   └─ reconcile target filesystem
```

例如 source 内容为：

```text
folder/
├── skill-dir1/
│   ├── SKILL.md
│   └── shared/
│       └── prompt.md
├── skill-dir2/
│   ├── SKILL.md
│   └── shared/
│       └── checklist.md
└── shared/
    ├── workflow.md
    └── archive/
        └── old.md
```

用户选择两个 bundles 和 `folder/shared`，但排除 `folder/shared/archive` 时，持久化语义是：

```text
DesiredSelection
├── bundles
│   ├── folder/skill-dir1/SKILL.md
│   └── folder/skill-dir2/SKILL.md
├── resource roots
│   └── folder/shared
└── resource exclusions
    └── folder/shared/archive
```

`skill-dir1/shared` 和 `skill-dir2/shared` 位于各自 SkillBundle 内，不需要也不能单独保存选择；选择 bundle 已经包含它们的完整内容。`folder` 只作为未选择的共同祖先参与 planning，不作为 desired selection 保存。

## Manifest

`skills.yaml` 使用 `members` 保存已选择 SkillBundles，使用 source-global `resources.include/exclude` 保存普通资源选择：

```yaml
sources:
  - name: my-skills
    url: https://git.example.com/me/skills.git
    ref: main
    type: branch
    pinned_commit: abc123

    members:
      - name: skill-dir1
        entry: folder/skill-dir1/SKILL.md
        targets:
          - codex
          - claude-code

      - name: skill-dir2
        entry: folder/skill-dir2/SKILL.md
        targets:
          - codex

    resources:
      include:
        - path: folder/shared
          kind: directory

      exclude:
        - path: folder/shared/archive
          kind: directory

skills: []
```

Member 字段契约：

- `members` 只包含用户明确选择的 SkillBundles；未选择和新发现的 bundles 不写入 manifest。
- `entry` 是 member 的 canonical identity，使用规范化的 source-relative `SKILL.md` 路径。
- `name` 是最后一次成功扫描确认的名称快照，用于展示和缺失 member reconcile；member identity 不依赖 name。
- 同一 source 内 `entry` 和 `name` 分别唯一；name 必须满足 skill id 约束。Bundle 视图在名称旁展示 entry parent path，避免深层目录产生视觉歧义。
- `targets` 只属于 member。不存在独立 `enabled`；member 是否被选择由它是否存在于 `members` 表达。

Resource 字段契约：

- `resources` 属于整个 source，不配置 targets。
- `include` 默认空。`kind: file` 精确选择一个文件，`kind: directory` 选择该目录中的普通 resource descendants，并把该目录作为显式 projection root。
- `exclude` 从已 include 的范围中排除文件或目录。
- 路径规则按 source-relative path 的匹配深度决定优先级，最具体的规则优先；相同路径下 `exclude` 优先。更具体的 include 可以恢复被祖先 exclude 的后代。
- Resource 遍历遇到 SkillBundle root 必须停止；include 祖先目录不会选择当前或未来的 bundles。
- 所有路径使用 `/`，不得为空、绝对路径或包含 `..`。同类冗余规则在保存前规范化并按路径稳定排序。
- `kind` 是持久契约。更新后路径类型与保存的 kind 不一致时，该选择 unavailable，不能把原文件选择静默扩大为目录选择或反向收缩。

Tree 操作与 manifest mutation 一一对应：

- 勾选 SkillBundle：添加一条 member；取消勾选：删除该 member。
- 勾选普通文件或目录：添加 include；取消已选范围中的子项：添加更具体的 exclude。
- 在 excluded subtree 中重新勾选后代：添加更具体的 include。
- 勾选 Container 时，当前已发现的 descendant bundles 分别写入 members，普通 resources 由该 directory include 表达。后续新 bundle 仍不会自动写入。

## Projection Tree

每个 source 投影到 Agent skills root 下的独立 namespace：

```text
<agent-skills>/<source-name>/...
```

Projection planner 按 target 收集 selected roots：该 target 的 member bundle roots，加上 source-global selected resource roots。Planner 计算这些 roots 的最长共同父路径前缀 `projectionBase`，再把每个 source path 映射为 `relative(projectionBase, sourcePath)`：

1. Selected root 自身的名称必须保留；计算的是 roots 的共同父路径，而不是把某个 selected root 本身作为可删除前缀。
2. 所有 selected roots 统一移除同一个前缀，不逐分支收缩内部 containers，因此 selected roots 之间的相对路径保持不变。
3. SkillBundle root 以下的结构始终原样保留。
4. 明确选择的资源目录保留自身名称和内部相对结构；exclude 只裁掉内容，不改变该 root 的 target path。
5. 不同父目录下的同名节点没有共同可删除前缀，因此祖先自然保留，不会因 flatten 产生名称冲突。
6. 选择集合变化可能改变 `projectionBase`。Projection 将由此产生的 path moves 作为 desired-state reconcile，清理旧 managed artifacts 并创建新 artifacts。

例如：

```text
source                              target
folder/                             <agent-skills>/<source-name>/
├── skill-dir1/                     ├── skill-dir1/
├── skill-dir2/          ->         ├── skill-dir2/
└── shared/                         └── shared/
```

三个 selected roots 的最长共同父路径是 `folder`，因此 `folder` 不出现在 target 中。

不同分支下的同名节点不会被错误 flatten：

```text
source                              target
team-a/skill/                       <agent-skills>/<source-name>/
team-b/skill/            ->         ├── team-a/skill/
                                    └── team-b/skill/
```

在前述详细示例中，三个 selected roots 的最长共同父路径是 `folder`，因此计算出的 ProjectionTree 为：

```text
<agent-skills>/<source-name>/
├── skill-dir1/
│   ├── SKILL.md
│   └── shared/
│       └── prompt.md
├── skill-dir2/
│   ├── SKILL.md
│   └── shared/
│       └── checklist.md
└── shared/
    └── workflow.md
```

这里的 ProjectionTree 可以随 desired selection 或 source 内容重新计算；manifest 始终保存 source-relative selection paths，而不是上述压缩后的 target paths。

## Projection Execution

Pure planner 为每个 source/target 组合生成 `SourceProjectionPlan`，包含 source identity、source namespace、target、`projectionBase` 和需要物化的 bundle/resource entries。不同 target 的 member 集合不同，因此各自计算 projection base；source-global resources 只加入至少存在一个该 source member 的 target。

Executor 按 `<agent-skills>/<source-name>` 整体 reconcile source namespace，不再把 source members 当作互不相关的顶层 links。执行流程：

1. 在 Agent skills discovery root 外构建 staging namespace。
2. 按 plan 物化 bundles、resources 和 Loom ownership marker，并验证所有 destination paths 都位于 namespace 内。
3. 如果正式 namespace 已存在，只有 ownership marker 匹配当前 repo/source 时才将它移动到 backup；没有 marker 或 marker 属于其他 owner 时 projection 失败。
4. 将 staging namespace 切换到正式路径。后续 source/target 失败时，journal 从 backup 恢复所有已替换 namespaces。
5. 全部 projection 成功后才删除 backups。某 target 不再包含该 source 的 member 时，只删除 marker 能证明归属的 namespace。

Namespace root 始终是真实目录，并包含 `.loom-projection.json`：

```json
{
  "version": 1,
  "managedBy": "loom",
  "kind": "skill-source",
  "ownerRepo": "<canonical-repo-path-hash>",
  "sourceKey": "<source-url-hash>",
  "sourceName": "my-skills"
}
```

Marker 不保存原始 Git URL，避免把 URL 中可能存在的凭据写入 Agent 目录。`ownerRepo` 是 normalized canonical repo root 的 SHA-256，区分同一台机器上的 Loom repositories；`sourceKey` 是 source URL 的 SHA-256，用于识别 source 改名后的旧 namespace。

Materialization strategy：

- `copy` 把 plan 中的选中内容复制进 staging tree。
- `link` 可以为完整 SkillBundle，以及没有 excludes、没有 descendant bundles 的完整 resource directory 创建 directory link。
- 稀疏 resource directory 使用真实结构目录和 file links。文件系统 port 明确区分 file/directory link；平台不支持、权限不足或跨设备时回退 copy，并记录包含完整错误对象的 warning。
- Namespace root 本身不创建 link，以便保存 marker 并安全替换。Bundle 映射到 namespace root 时物化其第一层 children，而不修改 source cache。
- Local skills 保持现有独立 projection contract，不进入 source namespace executor。

Source namespace 每次整体重建，因此 path moves、resource 删除和 excludes 通过替换 desired tree 完成，不需要逐文件推断 stale artifacts。Source 改名后，orphan cleanup 通过 marker 中的 `sourceKey` 识别旧 namespace；任何 namespace 外或无法证明归属的 artifact 都必须保留。

## 选择与 Targets

- SkillBundle 继续拥有独立的 targets desired state；是否被选择由 member 是否存在于 manifest 表达。
- Resource 选择属于整个 source，不配置独立 targets，也不绑定到某一个具体 skill。
- 某个 target 至少存在一个 targets 包含该 target 的 source member 时，才向该 target 投影已选择 resources。
- Source 新增普通资源时，如果它位于已选择的资源目录内，则自动进入 desired projection。
- Source 新增 SkillBundle 时必须由用户明确选择，不能因祖先资源目录已选择而自动启用。

## Source 更新

Source 更新使用 prepare/preview/finalize 流程。Prepare 在隔离的 candidate checkout 中读取新 ref，构建并校验新的 SourceTree，比较 desired selection，并计算新的 ProjectionTree；在用户完成必要确认前，不修改 manifest 或现有 projection。

更新行为：

- 相同 `entry` 的 bundle 内容变化时保留 targets，并整体更新 bundle。相同 entry 的 name 变化只更新 name 快照，不改变 identity。
- 新 SkillBundle 只进入 scan/update result，默认不写入 members。
- 已选择 SkillBundle 缺失时，进入删除或保留为 local skill 的 reconcile 流程。
- Bundle 移动或重命名按旧 entry 删除加新 entry 新增处理，不自动重绑定 identity。
- Selected resource directory 中新增或修改的普通文件自动进入 projection；删除内容会删除对应 managed artifact，但保留 manifest selection，并显示 unavailable 诊断。
- Resource path 的实际类型与保存的 kind 不一致时标记 unavailable，不自动改变选择范围。
- Resource subtree 新增 `SKILL.md` 时形成新的未选择 bundle 硬边界。Update preview 必须要求用户选择启用新 bundle、接受该 subtree 不再作为普通资源投影，或取消更新。
- Bundle 内新增第二个 `SKILL.md` 会产生 invalid candidate，prepare 失败，不能进入 finalize。
- 新 ProjectionTree 的 `projectionBase` 发生变化时，preview 展示 path moves；finalize 将其作为正常 desired-state reconcile。

Finalize 推进 candidate cache、manifest 和 projection，但这三个动作不是单个文件系统原子操作。实现必须保留旧 cache/manifest 直到新 projection 成功，并提供补偿式 rollback；失败日志记录原始错误、失败阶段和完整 rollback 结果。只有全部完成后才能清理旧 cache 和 update session。

## 失败与诊断

- 嵌套 SkillBundle candidate 是阻断性扫描错误，必须展示全部冲突 entry paths。
- Planner 只能移除所有 selected roots 共同拥有的父路径前缀，不能独立 flatten 分支内部 containers。
- 被用户排除的资源可能导致自然语言引用失效；Loom 不推断引用关系，Tree 视图应让最终选择保持可见和可检查。
- Projection 仍须遵守 managed artifact 边界；不能因目标目录形状相似而删除 user-owned artifacts。

## 验证范围

- Scanner 测试覆盖普通 bundles、深层 bundles、root-level bundle、共享 resources 和嵌套 candidate 冲突。
- Manifest codec/mutator 测试覆盖 entry/name 唯一性、resource include/exclude 最具体路径优先、kind mismatch 和规范化排序。
- View-model 测试证明 Bundle/Tree 来自同一个 SourceTree，切换视图不改变选择。
- Tree 交互测试覆盖搜索、祖先自动展开、勾选、半选、全选资源和清除搜索后的选择保持。
- Projection planning 测试覆盖最长共同父路径、selected root 名称保留、bundle 内部结构保留、不同分支同名节点，以及选择变化导致的 path reconcile。
- Executor 测试覆盖 link/copy、managed cleanup、rollback 和 user-owned artifact 保留。
- Source update 测试覆盖 candidate checkout 隔离、missing member reconcile、resource boundary change、projection path preview 和 finalize rollback。
