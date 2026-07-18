# Sync 规则

这些规则定义 Git 同步、冲突处理和强制同步的产品契约。

## R-SYNC-001 普通同步不覆盖冲突

Status: active
Applies to: Sync 普通拉取、普通上传、冲突处理

Rule:
普通拉取必须保留本地和远端冲突，进入冲突处理流程；普通上传遇到 non-fast-forward 时必须拒绝。

Implications:

- 用户需要先拉取并解决冲突，或显式选择强制操作。

Safety:

- 普通同步不得静默覆盖远端提交或丢弃本地变更。

Examples:

- 普通上传发现远端领先时，返回 non-fast-forward 失败，而不是自动 force push。

Tests:

- packages/server/test/sync/session-manager.test.ts
- packages/server/test/sync/push.test.ts

## R-SYNC-002 强制推送覆盖远端

Status: active
Applies to: Sync 强制推送

Rule:
强制推送把本地 `HEAD` 推送到 `origin`，忽略远端领先导致的冲突。

Implications:

- 强制推送前可自动提交本地 dirty 配置。
- 远端已有但本地没有的提交可能丢失。

Safety:

- 强制推送必须由独立操作触发，并在前端经过二次确认。

Examples:

- 用户确认强制推送后，本地配置成为远端结果，即使远端存在本地没有的提交。

Tests:

- packages/server/test/sync/push.test.ts
- packages/server/test/platform/node/git.test.ts
- packages/web/test/sync.test.tsx

## R-SYNC-003 强制拉取完全对齐远端

Status: active
Applies to: Sync 强制拉取

Rule:
强制拉取把本地仓库对齐 `FETCH_HEAD`，并删除 untracked 文件和目录。

Implications:

- 本地未提交修改、本地领先提交、untracked 文件和目录都会被丢弃。

Safety:

- 强制拉取遇到活动冲突会话时必须拒绝，不得静默删除会话。

Examples:

- 存在未完成冲突会话时，强制拉取入口不可继续执行，用户必须先处理该会话。

Tests:

- packages/server/test/sync/session-manager.test.ts
- packages/web/test/sync.test.tsx

## R-SYNC-004 强制操作必须二次确认

Status: active
Applies to: Sync 页面

Rule:
强制推送和强制拉取必须先展示二次确认，用户确认后才调用后端 API。

Implications:

- 取消确认不得发起请求。
- 确认文案必须说明会覆盖或删除的内容。

Safety:

- 未配置 remote、已有冲突或同步操作进行中时，强制操作入口必须不可用。

Examples:

- 用户在强制拉取确认框中点击取消时，前端不调用 force pull API。

Tests:

- packages/web/test/sync.test.tsx

## R-SYNC-005 切换 remote 不触发同步

Status: active
Applies to: Sync remote 配置

Rule:
切换 remote 只更新 Git `origin` URL，不得自动拉取、上传或提交。

Implications:

- 切换成功后页面必须提示用户需要手动拉取或上传。
- 已有冲突或活动同步会话时不得切换 remote。

Safety:

- 切换 remote 不得静默改变本地文件、远端提交或同步会话状态。

Examples:

- 用户选择新的 remote 后，Loom 更新 `origin` URL 并刷新页面状态，但不会自动执行 pull、push 或 commit。

Tests:

- packages/server/test/api/routes.test.ts
- packages/web/test/sync.test.tsx

## R-SYNC-006 拉取完成后应用投影

Status: active
Applies to: Sync 普通拉取、冲突解决完成、强制拉取

Rule:
远端状态成功应用到本地仓库后，必须立即按同步后的 desired state 执行完整 projection reconciliation。

Implications:

- 远端新增或删除的 skills、MCP、memory 投影会同步应用到本地 agent-native 文件。
- 存在未解决冲突时不得提前应用投影；最后一个冲突解决并应用后再执行。
- Projection 失败必须作为同步失败暴露，不能静默返回同步完成。
- 当前机器不可用的 remote skill source 按 Projection 规则降级为 warning；同步继续应用其他可投影内容，并保留该 source 的已有 managed namespace。

Safety:

- 投影仍须遵守 Projection 规则中的 managed artifact 边界，不得删除 user-owned 文件。

Tests:

- packages/server/test/sync/session-manager.test.ts
