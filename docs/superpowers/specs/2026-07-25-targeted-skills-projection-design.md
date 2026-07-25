# Skills 定向投影性能设计

- 日期: 2026-07-25
- 状态: 已批准

## 背景

当前单个 skill agent toggle 和 source 级批量 toggle 都会在保存 `skills.yaml` 后调用通用 skills projection。通用路径会重新加载全部 sources 和 local skills、探测 Agent 命令、扫描 source Git tree、读取每个 SkillBundle 的 metadata，并全局 reconcile managed artifacts。

真实数据基准中，稳定投影耗时约 `1.99s-2.33s`，实际复制 45 个文件只占约 `44-54ms`。一次操作会触发约 68 次 `git show`、约 8,839 次 `realPath` 和约 9,050 次 `inspectEntry`。主要成本是无关 source 的读取与全局 preflight，不是 link/copy。

本设计让 agent desired-state mutation 携带精确 change scope，并只 reconcile 受影响的 projection artifacts。相关规则: [cross-cutting](../../rules/cross-cutting.md)、[projection](../../rules/projection.md)、[skills](../../rules/skills.md)。

## 目标

- 单个 source member toggle 只 reconcile 该 source 在 agent 变化集中的 namespaces。
- Source 级批量 toggle 一次写入 YAML、一次执行 source 定向投影，不按 member 调 API 或投影。
- Local skill toggle 只 reconcile 该 local skill 在 agent 变化集中的 artifacts。
- Web mutation 请求在 server projection 完成后才成功，不再追加通用 `/project` 请求。
- Projection 不探测 Agent command；目标范围只由 Agent Catalog、effective `config.agents` 和 capability 决定。
- 热路径不执行 source cache 健康检查、checkout、fetch、metadata `git show` 或全 source scan。
- 保留现有 staging、原子替换、ownership preflight、rollback 和错误日志契约。

## 非目标

- 不检测或兼容用户手动修改 remote source cache 或 projection artifact 的情况。
- 不引入文件 fingerprint、mtime fingerprint 或内容 hash cache invalidation。
- 不增加周期定时器。
- 不删除显式全量 Project/Repair 能力。
- 不放宽 managed artifact ownership、路径授权或 rollback 安全边界。

## Change scope

Skills mutation 在持久化前比较旧、新 desired agents，使用 Agent Catalog 顺序生成对称差集。只把实际发生开关变化的 agents 放进 change scope。

```ts
interface SkillsProjectionChangeSet {
  sources: Array<{
    sourceUrl: string
    agents: AgentId[]
  }>
  locals: Array<{
    skillId: string
    agents: AgentId[]
  }>
}
```

单个 source member 和整个 source 使用同一种 source target。二者只在 manifest mutation 粒度上不同:

- 单 member: 更新一个 member，计算该 member 的 agent 对称差集。
- 整 source: 在内存中一次计算所有 selected members 的新 agents，合并它们的 agent 对称差集，一次写入 YAML。
- Projection: 两者都按 `sourceUrl + changed agent` reconcile；不会按 member 执行 projection。

内存中遍历 members 以计算 next state 不属于禁止的 per-member loop。禁止的是按 member 发 HTTP 请求、写 YAML、加载 source 或执行 projection。

如果 mutation 没有产生 agent 变化，可以省略 projection。Server 仍按现有 contract 返回 mutation 结果。

## 请求与事务边界

Agent mutation route 负责完整命令:

1. 在 repository/projection lease 内读取并验证 manifest。
2. 比较每个 target 的 `expectedAgents` 与当前 manifest；任一不匹配则返回 HTTP 409 `stale_agent_state`，整批不写入、不投影。
3. 计算 next desired state 与 `SkillsProjectionChangeSet`。
4. 一次写入 `skills.yaml`。
5. 使用同一 lease 执行 targeted projection。
6. Projection 成功后返回成功；失败则返回稳定 failure contract。

Web 的单 skill、local skill、source 批量 controls 只发送 mutation 请求，不再调用 `api.project({ scope: 'skills' })`。
单 item 请求是同一 batch body 的单元素特例。所有 skills agent controls 共用一个 pending gate，避免用同一份旧 manifest 并发构造多个 batch。

全局 skills agent control 也改为一个 batch mutation 请求。Server 一次写入 YAML，并将多个 source/local targets 作为一个 projection transaction 执行，避免现有 per-item HTTP loop。

Agent toggle 的 projection 失败时，保留已经写入的 desired state，UI 刷新 manifest 并显示失败。Projection executor 自身仍回滚本次 artifact mutation。Source 内容 reconcile/update 的既有 manifest/cache 回滚语义保持不变。

## Targeted planning

Targeted workflow 只加载基础 manifest 与 change set 引用的 skills:

- Source target 只解析对应 `sourceUrl`，不 hydrate 其他 sources，也不扫描 local skills。
- Local target 只解析对应 `skillId`，不读取 remote source caches。
- Applicable agents 是 effective `config.agents` 中 Catalog 声明支持 `skills` capability 的 agents。
- 不调用 `where`、`which` 或 `isCommandInstalled`。Skill projection 写入 agent-native directory，不依赖 Agent executable 正在 PATH 中。

显式 `/project`、同步后的全量 reconcile 和 Repair 继续使用完整 manifest plan。它们是全量 desired-state reconciliation，不复用 mutation change set。

## Source projection catalog

Remote source projection 需要 SourceTree 结构和 tracked regular-file 清单，以维持 bundle/resource 选择、排除 `.git`、拒绝 symlink/submodule，并只物化 Git tracked files。该数据不应通过每次 projection 的完整 source scan获得。

Server 维护进程内 source projection catalog，key 为:

```text
canonical repository identity + sourceUrl + pinned_commit
```

`pinned_commit` 是 immutable Git object identity，不是额外 fingerprint。Catalog value 只包含 projection 所需结构与 tracked file paths，不包含 SkillBundle description。

Catalog 填充与失效规则:

- Source add/update/repair 已经得到新 commit 和 tree 时，立即写入 catalog。
- Source edit 仅改变 members/resources/agents 时复用同一 `pinned_commit` entry。
- 服务启动后后台校验 managed source caches，并预热 catalog；启动与 API ready 不等待该任务。
- Startup 只在短 repository read lease 内读取 manifest 和 catalog revision 快照；cache health 与 Git tree 扫描在 lease 外执行，不阻塞前台 mutation。
- Source cache 被替换或 source 被删除时，失效对应 repository/source entries。
- 每个 repository/source 维护 revision；失效后完成的旧异步 health/tree 结果不得写回 catalog。
- 冷启动时 targeted projection 若早于预热，只对目标 source 执行一次本地 `git readTree(pinned_commit)` 并写入 catalog。

Targeted projection 不执行 `git show`、`rev-parse HEAD`、checkout、fetch、clone、remote probe 或 cache repair。一次冷 catalog miss 允许一个目标 source 的本地 `readTree`；warm projection 不启动 Git process。

## Source cache 健康与 Repair

Cache 健康检查从 projection 热路径移出:

- 服务启动后异步检查 managed repositories 的 source cache root、`.git` ownership 和 checkout/commit 一致性。
- 结果缓存在进程内，供 source 状态和 Update/Repair UI 使用。
- 不配置周期检查。
- 用户点击 Check update 时，先读取/补做本地健康检查；损坏时立即返回 `needsRepair`，不先执行远端 `lsRemote`。
- 用户点击 Repair 时复用现有 source repair/update 流程。
- Projection 发现已知 unhealthy 或缺失 cache 时保留现有 managed namespace并返回 source-specific warning，不在 projection 内修复。

## Executor scope 与 cleanup

Targeted executor 必须把 prepare、apply、cleanup 和 managed state 更新限制在 change set:

- Source target 直接派生每个 `sourceUrl + agent` 的 namespace path，不枚举 agent skills root 的其他 children。
- Agent 对该 source 仍有任一 selected member 时，整体 staging 并替换该 namespace。
- Agent 对该 source 已无 selected member 时，只删除这个明确 namespace，且必须通过 owner repo、source identity、source name 和 namespace marker 验证。
- Unrelated sources、agents 和 user-owned directories 不读取、不替换、不删除。
- Local target 只读取和更新目标 `(skillId, agent)` 的 managed state；其他 state entries 原样保留。
- 多个 targets 可以并行准备 source data和 staging，但 final apply 仍进入同一个 journal，任一失败按实际 mutation 逆序 rollback。

显式全量 projection 继续执行 global orphan cleanup。Targeted projection 不根据 partial plan 推断全局 orphan。

## Staging 与文件物化

现有 namespace staging 和 atomic swap 保留。一次 `sourceUrl + agent` reconcile 只创建一个 staging namespace:

1. 从 projection catalog 选择该 agent 的 bundles 与 source-global resources。
2. 完整 preflight 目标 namespace、source entries、collision 和 ownership。
3. 在 owned transaction directory 构建 namespace。
4. 原子替换旧 namespace，并把 backup 记入 journal。
5. 所有 targets 成功后删除 backups；失败则 rollback。

Source 中有多少 members 不改变 projection 调用次数。Source 批量 toggle 与单 member toggle 的差异只可能来自该 agent 最终需要物化的文件数量。

## 错误处理

- Manifest validation、target not found、catalog/source unavailable、ownership conflict 和 projection failure 使用现有稳定 HTTP 分类。
- Route catch boundary 记录完整 `{ err }`，不向 response 回显 path、stack 或底层 Git message。
- Background cache validation failure记录完整 `{ err, repo, sourceId }`，不阻止 server 启动。
- Projection warning 与 failure 不静默转换成成功 toast。
- Successful mutation 的 projection warnings 必须从 workflow 传到 route 和 Web；Web 刷新 manifest、显示 warning，并抑制普通 success/toast。
- Batch mutation 任一 target projection 失败时，executor 回滚全部已应用 targets；UI reload 已持久化 desired state。

## 规则更新

实现时同步更新:

- `R-CROSS-002`: desired-state mutation 由 server 在同一命令中完成 targeted reconcile。
- `R-CROSS-003`: source/global bulk 是一次 batch mutation，不按 item/member 执行请求或 projection。
- `R-PROJECTION-001`: projection targets 由 Configured + Applicable agents 决定，不再要求 executable Installed 探测。
- `R-PROJECTION-006`: targeted source cleanup 只作用于明确 namespace；健康检查不在 projection 热路径；catalog miss 只允许目标 source 的本地 tree read。
- `R-SKILLS-003` 与 `R-SKILLS-004`: source/global bulk 的一次写入和一次 projection transaction 语义。

## 测试计划

Core:

- Agent change set 使用 Catalog 顺序且只包含 old/new 对称差集。
- Source bulk 合并所有 member changes，但只产出一个 source target。

Server application/API:

- Single member toggle 一次 YAML write、一次 source targeted projection。
- Source bulk toggle 一次 YAML write、一次 source targeted projection，不按 member 调 projection。
- Local toggle 只产生 local target。
- Global bulk 一次请求、一次 YAML write、一个复合 change set。
- Projection failure 返回 failure，并保留已写 desired state。
- Stale `expectedAgents` 返回 409，且不写 YAML、不执行 projection。
- Invalid config/source identity 返回 422，missing target 返回 404，unexpected projection failure 返回 500。
- Projection warning 原样传播到 API response。

Workflow/executor:

- Target source load 不访问其他 source cache 或 local skills。
- Warm source target不调用任何 Git/process command；cold miss 只调用目标 source 的一次 `readTree`。
- 不调用 Agent command detection。
- Targeted source cleanup 不删除或 inspect 无关 namespace。
- Targeted local cleanup 不改变无关 managed state。
- Multi-target apply 失败会恢复已替换 namespaces 和 managed state。
- Explicit full projection 仍能执行 global orphan cleanup。

Web:

- Single/source/local controls 只调用 mutation API，不追加 `/project`。
- Source bulk 发送一个包含全部 member next agents 的请求。
- Global bulk 发送一个 batch 请求，不执行 per-item request loop。
- Mutation/projection failure 后刷新 manifest 并显示错误。
- Item/source/global 共用 pending gate；pending 时不提交第二个 stale batch。
- Warning 和 rejected `ApiError` 都刷新 manifest；warning 不触发 success/toast。

## 性能验收

使用当前真实 `~/.loom/repos/default` 数据投影到隔离 home，记录至少 5 次 warm run:

- Single source member toggle 不产生 `git show`、Agent command detection 或无关 source access。
- Source bulk toggle 对同一 agent 只 reconcile 一个 namespace。
- Warm single/source-bulk 中位数目标不高于 `200ms`，且单次不高于 `500ms`。
- Copy/link 的文件物化时间单独记录，避免把 YAML、planning、preflight 与 materialization 混成一个数字。
- 与当前约 `2s` baseline 对比报告总耗时、Git 调用数、`realPath`、`inspectEntry` 和实际物化文件数。

验证命令包括聚焦 Vitest、`bun run test:rtk` 和 `bun run format:check`。Web 行为改动后运行自己的 `bun dev`，使用带 session 名的 `playwright-cli` 自动验证 single toggle、source bulk、global bulk 与失败反馈。
