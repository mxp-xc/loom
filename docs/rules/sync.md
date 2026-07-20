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
- Git 结果应用后、projection 完成前必须保留 durable session；服务重启后前向重试 projection，成功后才清理会话。
- 强制拉取在 `reset --hard` / `clean` 前必须先持久化 `applying`；重启后可幂等重放 Git apply，再进入 `projection_pending`。
- 等待 projection 的会话不能被 abort，也不能再创建同 repository 的同步会话。
- 当前机器不可用的 remote skill source 按 Projection 规则降级为 warning；同步继续应用其他可投影内容，并保留该 source 的已有 managed namespace。

Safety:

- 投影仍须遵守 Projection 规则中的 managed artifact 边界，不得删除 user-owned 文件。

Tests:

- packages/server/test/sync/session-manager.test.ts

## R-SYNC-007 冲突编辑只接受有界 UTF-8 regular blob

Status: active
Applies to: Sync 冲突展示、保存、Web 冲突编辑器

Rule:
在线冲突编辑只接受 size limit 内、UTF-8 有效且 Git mode 为 `100644` 或 `100755` 的 regular blob。其他冲突返回 typed unsupported，只允许用户放弃本次合并。

Implications:

- Index stage 的 mode、OID、尾换行和 executable mode 必须保留。
- Missing stage 表示 add/delete conflict；已存在 stage 的读取失败必须作为错误暴露。
- Binary、invalid UTF-8、超大内容、symlink、gitlink 和 mixed mode 不显示 raw RESULT 保存入口。
- Abort 只有在 API 返回 `ok: true` 后才能清空冲突 UI。

Safety:

- Conflict stage 和 worktree result 在读取前检查大小，并限制读取并发。
- 保存使用 same-directory exclusive temporary 与 atomic replacement；parent/target link、hardlink、special entry或 identity drift 均 fail closed。

Tests:

- packages/server/test/sync/session-manager.test.ts
- packages/web/test/conflict-editor.test.tsx
- packages/web/test/sync.test.tsx

## R-SYNC-008 Applied repository tree 不跟随 link

Status: active
Applies to: Sync 后 projection、repository manifest reader

Rule:
同步应用后的 repository 输入只读取 canonical repository 内 identity 稳定的真实目录和单 link regular files。

Implications:

- 顶层 config、skills、MCP 文件以及 `vars`、`memories` 目录和 direct-child 文件使用同一 no-follow policy。
- Missing optional input 可以跳过；已存在 entry 的 kind、读取、canonical containment 或 identity failure 必须终止 projection。

Safety:

- Repository tree 内的 symlink、junction、hardlink 或 special entry 不能把 projection 读取带出 repository。
- Boundary failure 必须发生在首次 agent-native write 前，并记录完整 error object。

Tests:

- packages/server/test/api/repo-config.test.ts
- packages/server/test/sync/session-manager.test.ts

## R-SYNC-009 Session state 与 cache 使用可信物理目录

Status: active
Applies to: Sync session、recovery、maintenance、quota

Rule:
Sync state/cache root、repository hash directory 和 session entry 必须是可信路径中的真实直接子项；persisted session 绑定 canonical repository path、physical identity、hash、session id、worktree path、operation、status、setup/cleanup progress、OID 和时间。

Implications:

- 同一 repository 同时存在多个 active session 时停止操作，不按目录顺序任取一个。
- 只有 missing state/cache entry 可以视为不存在；权限、IO、malformed schema 和 identity failure 均 fail closed。
- Quota traversal 使用 `lstat`，不递归 link，并限制深度和 entry 数量。
- Setup 在 worktree 创建、remote ref 创建和 merge 完成后推进 persisted progress；cleanup 每完成 worktree、directory、ref 或 prune step 后立即推进 persisted progress。
- Save、abort、recovery 和 maintenance 在同一 repository process lock 内 reload session，并通过 monotonic revision/CAS 写入。

Safety:

- State/cache root、hash directory 或 JSON entry 为 link、非预期 kind 或 canonical escape 时不得继续写入或恢复。
- Session metadata 不能把 cleanup、Git 或 projection 权限指向其他 repository 或 worktree。

Tests:

- packages/server/test/sync/session-manager.test.ts
