# Sync 规则

这些规则定义 Git 同步、冲突处理和强制同步的产品契约。

## R-SYNC-001 普通同步不覆盖冲突

- Status：active
- Applies to：Sync 普通拉取、普通上传、冲突处理。
- Rule：普通拉取必须保留本地和远端冲突，进入冲突处理流程；普通上传遇到 non-fast-forward 时必须拒绝。
- Implications：用户需要先拉取并解决冲突，或显式选择强制操作。
- Safety：普通同步不得静默覆盖远端提交或丢弃本地变更。
- Tests：`packages/server/test/sync/session-manager.test.ts`、`packages/server/test/sync/push.test.ts`。

## R-SYNC-002 强制推送覆盖远端

- Status：active
- Applies to：Sync 强制推送。
- Rule：强制推送把本地 `HEAD` 推送到 `origin`，忽略远端领先导致的冲突。
- Implications：强制推送前可自动提交本地 dirty 配置；远端已有但本地没有的提交可能丢失。
- Safety：强制推送必须由独立操作触发，并在前端经过二次确认。
- Tests：`packages/server/test/sync/push.test.ts`、`packages/server/test/platform/node/git.test.ts`、`packages/web/test/sync.test.tsx`。

## R-SYNC-003 强制拉取完全对齐远端

- Status：active
- Applies to：Sync 强制拉取。
- Rule：强制拉取把本地仓库对齐 `FETCH_HEAD`，并删除 untracked 文件和目录。
- Implications：本地未提交修改、本地领先提交、untracked 文件和目录都会被丢弃。
- Safety：强制拉取遇到活动冲突会话时必须拒绝，不得静默删除会话。
- Tests：`packages/server/test/sync/session-manager.test.ts`、`packages/web/test/sync.test.tsx`。

## R-SYNC-004 强制操作必须二次确认

- Status：active
- Applies to：Sync 页面。
- Rule：强制推送和强制拉取必须先展示二次确认，用户确认后才调用后端 API。
- Implications：取消确认不得发起请求；确认文案必须说明会覆盖或删除的内容。
- Safety：未配置 remote、已有冲突或同步操作进行中时，强制操作入口必须不可用。
- Tests：`packages/web/test/sync.test.tsx`。

## R-SYNC-005 切换 remote 不触发同步

- Status：active
- Applies to：Sync remote 配置。
- Rule：切换 remote 只更新 Git `origin` URL，不得自动拉取、上传或提交。
- Implications：切换成功后页面必须提示用户需要手动拉取或上传；已有冲突或活动同步会话时不得切换 remote。
- Safety：切换 remote 不得静默改变本地文件、远端提交或同步会话状态。
- Tests：`packages/server/test/api/routes.test.ts`、`packages/web/test/sync.test.tsx`。
