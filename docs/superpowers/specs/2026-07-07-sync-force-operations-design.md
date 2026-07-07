# Sync 强制推送与强制拉取设计

## 背景

Sync 页已有普通拉取、普通上传和隔离式冲突处理。普通上传在远端领先时拒绝 non-fast-forward；普通拉取通过隔离 worktree 生成冲突会话，避免把冲突标记写入正式工作区。

本设计新增两个显式危险操作：

- 强制推送：用本地配置覆盖远端 Git 仓库，忽略远端领先导致的冲突。
- 强制拉取：丢弃本地所有变更，并应用远端内容。

相关规则入口：[docs/rules/index.md](../../rules/index.md)。实现该功能时应补充同步相关规则，描述强制操作的产品契约和安全边界。

## 目标

- Sync 页支持强制推送和强制拉取。
- 两个强制操作都必须经过二次确认。
- 强制操作与普通同步路径分离，避免普通操作误触危险语义。
- 后端保留可测试、可审计的明确 workflow。

## 非目标

- 不改变普通拉取、普通上传和冲突编辑器的既有语义。
- 不新增冲突自动解决策略。
- 不新增远端分支选择；继续沿用当前 Sync 对 `origin` / `FETCH_HEAD` / `HEAD` 的默认策略。

## 推荐方案

新增独立 API 与 UI 操作：

- `POST /api/sync/force-push`
- `POST /api/sync/force-pull`

前端不通过给普通 `/sync/push` 或 `/sync/pull` 传 `force: true` 来触发危险行为。独立端点让调用点、日志、测试和错误处理都能明确区分普通同步与强制同步。

## 后端设计

### 强制推送

新增 `syncForcePush(repoPath, git, logger)` workflow。

行为：

1. 读取仓库状态。
2. 如果工作区 dirty，则 `git add .` 并提交 `loom: sync changes`。
3. 执行 force push，将本地 `HEAD` 推到远端 `origin`，覆盖远端冲突。
4. 返回 `{ ok: true }`；认证失败、无 remote、非 git 仓库等错误按现有 sync 错误分类返回。

实现需要在 `IGit` / `NodeGit` 增加明确的 force push 能力，避免复用普通 `push()` 后再用字符串参数暗改语义。

### 强制拉取

新增 `SyncSessionManager.forcePull(repoPath)` 或等价 workflow，由路由通过现有 sync manager 调用。

行为：

1. 获取仓库锁，避免与普通拉取、保存冲突、终止冲突并发。
2. 如果存在活动冲突会话，拒绝执行并提示先放弃或解决当前同步会话；不在强制拉取里静默删除会话。
3. 执行 `fetch origin --tags`。
4. 将本地 `HEAD`、index 和工作区强制对齐 `FETCH_HEAD`。
5. 删除 untracked 文件和目录，使本地工作区完全对齐远端。
6. 返回 `{ ok: true, clean: true }`。

这里的“丢弃本地所有变更”包含：

- 未提交的 tracked 文件修改；
- 本地存在但远端不存在的提交；
- untracked 文件和目录。

如果仓库尚无本地 `HEAD`，沿用普通 pull 的初始拉取思路：将 `HEAD` 指向 `FETCH_HEAD` 后 reset/clean。

### 日志与错误处理

- 强制推送、强制拉取开始和完成都应记录 info 日志，包含 `repoPath` 和 operation。
- 错误路径必须记录完整 `err` 对象和上下文。
- 返回给前端的错误继续使用稳定错误码和安全 message，不暴露额外敏感信息。

## 前端设计

Sync 页保留现有拉取/上传按钮，并新增两个危险操作入口：

- 强制拉取
- 强制推送

按钮状态：

- 未配置 remote 时禁用。
- 正在执行任意 sync 操作时禁用。
- 存在待解决冲突时禁用，并提示需要先解决或放弃当前冲突。

二次确认：

- 点击强制推送后弹出确认框，文案明确说明：远端内容会被本地配置覆盖，其他设备已推送但本地没有的内容可能丢失。
- 点击强制拉取后弹出确认框，文案明确说明：本地未提交修改、本地提交、未跟踪文件和目录都会被远端覆盖或删除。
- 用户取消时不调用 API。
- 用户确认后执行对应 API，并用 toast 或错误提示展示结果。

可以优先使用现有 UI 基础组件实现轻量确认弹窗；如果当前项目没有通用确认弹窗，则在 Sync 页内实现局部确认组件，避免为两个按钮引入全局抽象。

## 测试计划

### Server

- `syncForcePush`：
  - dirty 仓库会先 add/commit，再 force push；
  - clean 仓库直接 force push；
  - force push 失败时分类错误并记录完整 err。
- `forcePull`：
  - 本地 tracked 修改被远端覆盖；
  - 本地领先提交被丢弃；
  - untracked 文件和目录被删除；
  - 活动冲突会话存在时拒绝执行。
- API routes：
  - `/api/sync/force-push` 委托 force push workflow；
  - `/api/sync/force-pull` 委托 sync manager；
  - 错误响应沿用 sync 错误格式。

### Web

- 取消强制推送确认时不调用 API。
- 确认强制推送时调用 `api.syncForcePush(repoPath)`。
- 取消强制拉取确认时不调用 API。
- 确认强制拉取时调用 `api.syncForcePull(repoPath)`。
- busy、remote 缺失、冲突存在时按钮禁用。

### 浏览器验证

前端实现后使用 `playwright-cli` 自动验证：

- 强制按钮存在且危险文案可见；
- 取消确认不会发起请求；
- 确认后展示成功或错误反馈。

## 需要同步更新的文档

实现阶段应补充 `docs/rules/` 中的同步规则，并在 `docs/rules/index.md` 加入入口。规则应只描述当前产品契约和安全边界：

- 普通同步不覆盖冲突；
- 强制推送覆盖远端；
- 强制拉取使本地完全对齐远端并删除 untracked；
- 强制操作必须有二次确认。
