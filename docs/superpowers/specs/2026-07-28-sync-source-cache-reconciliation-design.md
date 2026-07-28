# 同步后的 Source Cache 对齐

## 目标

远端仓库配置成功拉取并应用后，Loom 在执行投影前，将每个已配置 Source 的本机 cache 恢复到 manifest 指定的精确 `pinned_commit`。这样，另一台机器同步 Skills 配置后，无需手动修复本机 cache 即可使用该配置。

该行为适用于会把远端状态应用到本机的同步操作：普通拉取、冲突解决完成和强制拉取。服务启动时也会先离线检查 Source cache，并只为 unhealthy cache 执行一次自动补偿，以恢复功能上线前或异常退出后没有 durable sync session 的历史漂移。打开 Skills 页面和普通投影仍不访问 Source 远端。

Skills 投影遇到 user-owned Source namespace 时，由 GUI 请求用户确认并将原目录原子移动到 Agent 配置目录下的 `skill-backups`。若重试又发现另一个独立冲突，已确认的备份保持不变，GUI 继续逐项确认，直到完整投影成功；其他投影失败仍按 identity 恢复当前原目录。

相关规则：

- [R-SYNC-006](../../rules/sync.md#r-sync-006-拉取完成后应用投影)
- [R-PROJECTION-008](../../rules/projection.md#r-projection-008-desired-collision-与-unavailable-source-不得伪装成功)
- [R-SKILLS-007](../../rules/skills.md#r-skills-007-source-member-缺失必须确认-reconcile)

## 设计

### 同步编排

同步的 `onApplied` 阶段在完整投影前新增 Source cache 对齐步骤。该步骤读取已应用的 Skills manifest，并逐个检查 Source 的本机 cache：

- cache 当前检出的 `HEAD` 等于 `pinned_commit` 时，不执行任何操作。
- cache 缺失或 `HEAD` 不匹配时，从 Source URL 恢复 cache。
- Source 没有合法 `pinned_commit` 时保持 unavailable，不使用可能移动的 ref 推导目标提交。

对齐步骤返回每个 Source 的可用状态。随后，投影使用对齐后的 cache；未能恢复的 Source 继续沿用现有的 source-specific warning 行为。

启动预热保持两阶段执行：先在短 read lease 中读取 manifest snapshot，并在 lease 外完成健康 cache 的本地检查和 catalog 预热；只有发现 unhealthy cache 时，才按仓库获取 projection mutation lease，在 lease 内重新读取当前 manifest 并复用同一 reconciliation。全部 cache 已匹配时，启动不得访问远端，也不得获取 mutation lease。

### 精确且隔离的恢复

恢复操作在受 Loom 管理的临时工作区内创建全新的 candidate 目录。Loom clone 已配置的 URL，检出精确 `pinned_commit`，确认解析结果和 candidate `HEAD` 都等于 manifest 中的 pin，并在修改 live cache 前扫描 candidate SourceTree。

校验通过后，Loom 原子提升 candidate cache。如果已有旧 cache，则将其保留为 rollback 材料，直到提升和提升后校验完成。清理与回滚只能操作已记录 identity 且 identity 仍匹配的 owned workspace entry。

实现应复用现有 Source cache boundary 和 transaction 模式，不能让 sync 子系统直接操作任意路径。

### 失败行为

单个 Source 在 clone、checkout、校验、提升或清理阶段失败时，不回滚已经完成的 Git 同步，也不阻止其他无关配置继续投影。Loom 记录包含堆栈的完整错误对象，将该 Source 标记为 unavailable，保留其旧 live cache 和既有 managed projection artifact，并继续处理其他 Source。

只有 Source 恢复失败时，同步结果仍为成功，但返回 source-specific projection warning。Repository authorization、manifest 解析、cache boundary 违规，以及与单个远端 Source 无关的失败，继续按照现有 API 契约作为同步或投影硬失败。

## 数据流

1. Sync 将远端仓库结果应用到 canonical managed repository。
2. Sync 按现有流程持久化 `projection_pending`。
3. Source cache 对齐读取已应用的 `skills.yaml`。
4. 已健康的 cache 直接复用；缺失或不匹配的 cache 在隔离环境中恢复。
5. 对发生变化的 cache，失效或刷新运行时 Source health catalog 和 projection catalog。
6. 完整投影基于各 Source 对齐后的可用状态执行。
7. 现有 warning 聚合逻辑报告仍然不可用的 Source。
8. 只有投影完成后，才清理 durable sync session。

## 测试

聚焦的 server 测试覆盖：

- pull 新增 Source，但本机没有对应 cache；
- `pinned_commit` 已变化，但本机仍是旧 cache；
- cache 已匹配时不 clone、不替换；
- 已配置 branch 或 tag 移动后，仍检出精确 commit；
- clone、checkout、校验或提升失败时保留旧 cache；
- 一个 Source 不可用时，不阻止另一个 Source 恢复和投影；
- candidate 和 backup 清理受 identity 校验保护；
- cache 提升后失效运行时 catalog；
- 普通 Skills 页面加载和普通投影不访问远端；
- 启动时缺失或落后的 cache 自动恢复，全部匹配时不 clone、不获取 mutation lease；
- 普通 pull、冲突解决完成、force pull，以及从 `projection_pending` 恢复时，共用同一条 cache 对齐路径。

验证命令包括聚焦 Vitest、`bun run test:rtk` 和 `bun run format:check`。
