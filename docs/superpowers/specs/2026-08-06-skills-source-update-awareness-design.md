# Skills source update checks

Status: Implemented

Related rules: [skills](../../rules/skills.md) and [cross-cutting](../../rules/cross-cutting.md).

## Goal

进入 Skills 页面后，Loom 自动识别哪些 Source group 可以更新，并提供一个作用于全部 Source group 的“检查全部更新”入口。该入口只检查更新，不执行 Source update。Local skills group 没有远端，不属于检查范围。

## Confirmed decisions

### Background update checks

- 进入 Skills 页面时，为每个 remote source 启动一次 Source update check。
- Source update check 是只读操作，不修改 live cache、manifest 或 projection。
- 检查异步执行，不阻塞 Skills 页面的浏览、编辑、投影或其他功能。
- 每个 source 独立产生检查结果；单个 source 的慢响应或失败不阻塞其他 source。
- UI 区分至少以下状态：检查中、可更新、已最新、需要修复、检查失败和当前机器不可用。
- 只有 Source group 参与检查；local skills group 不显示更新状态。
- 自动检查发现可更新项时，在对应 source 检查完成后立即显示“<source> 可更新” toast，不等待其他 source；已最新、需要修复和检查失败保持静默，结果仍更新对应 Source group。

### Check all updates

- Skills 页面提供“检查全部更新”按钮。
- 该按钮对全部 remote sources 发起与单个 Source group 检查按钮相同的 Source update check。
- 操作只刷新每个 Source group 的检查状态，不执行 prepare、finalize 或 projection。
- 每个 source 独立检查；一个 source 失败不阻止其他 source 完成。
- 按钮使用 `RefreshCw` 的 `IconButton`，accessible name 和 tooltip 均为“检查全部更新”。
- 自动检查或“检查全部更新”进行时，按钮图标旋转并禁用，避免重复提交。
- 手动检查全部完成后只显示一条汇总反馈，不为每个 source 连续显示 toast。

### Source group states

Source update check 状态以 source URL 为 UI identity，并绑定当前 `url`、`ref`、`type` 和 `pinned_commit` 快照：

- `checking`：显示旋转的 Source group 检查按钮，其他 Source 操作仍可用。
- `update`：沿用现有 `ref -> latest` 提示和 warning-tone 更新按钮。
- `repair`：显示 `repair` 提示和现有更新按钮。
- `current`：清除旧的 update/repair 提示；检查按钮 tooltip 表示已是最新。
- `error`：在对应 Source group 上提供非阻断错误状态和重试，不把其他 source 标记为失败。
- Source 本身的 availability 继续由 manifest 表达，不把 update check 失败改写成 unavailable。

重新检查时，新的 `current`、`error` 或 `repair` 结果必须替换旧的 `update` 结果，不能保留过期更新提示。

### Trigger and staleness policy

- 初次加载 manifest 后自动检查全部 remote sources。
- 离开 Skills 页面再进入时重新检查。
- 页面停留期间，如果 source 的 `url`、`ref`、`type` 或 `pinned_commit` 发生变化，只重新检查该 source。
- 仅修改 member assignment、group order 或展开状态不触发新的远端检查。
- 同一 source 的旧请求结果与当前 source 快照不匹配时丢弃，不能覆盖新状态。
- 单 Source 检查按钮保留，供用户只重试或刷新一个 source。

## Request orchestration

前端继续调用现有 `POST /update`，每次请求只携带一个 source：

- 自动检查和“检查全部更新”使用有限并发的独立请求，而不是把全部 sources 放进一个请求。
- 独立请求让单个 source 的网络错误保持局部失败；不改变现有 API response contract。
- 并发上限为 4，所有待检查 Source group 立即进入 checking 状态。
- 当前 `/update` 只在本地 cache health 检查期间持有 read lease；远端 `git ls-remote` 在 lease 外执行。实现不得把远端等待移入会阻塞 repository mutation 的 lease。
- 检查操作不进入 manifest refresh，不触发 projection，也不占用 Source update session。

## Existing update behavior

Source update 继续使用现有的 prepare/finalize session。Prepare 在隔离 candidate 中生成变更摘要；finalize 更新 live cache、manifest、selection 和 projection。需要用户处理删除项或资源边界时，不能绕过确认。

## Code ownership

- `useManifestOperations` 统一持有 per-source check 状态、pending gate 和单个/全部检查操作。
- `Skills` 负责初次自动触发和页面头部“检查全部更新”按钮。
- `SkillSourceList` 只渲染共享状态并调用单 Source 检查或现有 Source update 操作，不再维护一份只包含 update/repair 的局部 map。
- Server 保持现有单 Source update-check API 和锁边界。

## Failure behavior

- 自动检查失败不产生页面级 `ErrorState`，也不阻止 Skills 的其他功能。
- 每个失败都在既有错误处理节点记录完整错误对象。
- 手动检查单个 source 时保留明确错误 toast；自动检查失败只在 group 上展示，“检查全部更新”通过单条汇总反馈报告失败数量。
- Source update check 失败不清除 manifest desired state，不修改 cache，也不隐藏 Source group。

## Verification

Web tests cover:

- manifest 首次加载后自动检查所有 remote sources，不检查 local group；
- 页面在 deferred update checks 期间仍可展开 group、编辑和触发其他操作；
- 一个 source 失败时其他 source 仍完成并显示各自状态；
- 自动检查发现更新时逐 source 立即提示，不等待较慢的 source；无更新项不提示；
- “检查全部更新”的 pending、禁用、有限并发和单条汇总反馈；
- `current`、`repair` 和 `error` 能清除旧 update 提示；
- source identity snapshot 变化只重查对应 source，stale response 不覆盖新状态；
- 单 Source 手动检查和现有 prepare/finalize 更新流程保持可用。

Existing server update-check tests remain the contract baseline. Browser verification covers desktop and mobile widths、页面进入时的后台状态变化、全局按钮和 Source group 提示不重叠。

## ADR

不创建 ADR。该设计复用现有 update-check API 和 Source update 边界，容易调整，也没有引入难以逆转的系统级选择。
