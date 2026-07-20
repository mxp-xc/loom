# 跨模块规则

这些规则适用于 skills、MCP、memory、vars，以及未来新增的可投影配置。

## R-CROSS-000 Agent 范围由 Catalog 与配置共同确定

Status: active
Applies to: core, server, web, projection

Rule:
Agent Catalog 定义 Loom 支持的 Registered agents 全集。Configured agents 是 effective `config.agents` 中已注册的有序子集；Applicable agents 是 Configured agents 中支持当前 capability 的子集。Settings 始终展示 Registered agents，其他业务页面只展示各自的 Applicable agents。

Implications:

- `config.agents` 缺失或为空数组时，Configured agents 是空集合，不回退到产品默认 agent。
- 从 Configured agents 移除 agent 只隐藏其业务 controls，不删除 per-item selections、Memory assignment 或 agent Vars；重新加入后恢复显示。
- 新仓库显式写入创建时的 Registered agents；Catalog 后续新增 agent 不自动启用到既有仓库。

Safety:

- Capability mismatch 不得进入 projection 或对应页面 controls。
- React 空状态使用 `null` 或显式 `default`，不借真实 agent 充当 sentinel。

Tests:

- packages/core/test/agents.test.ts
- packages/web/test/settings.test.tsx
- packages/web/test/agent-catalog.test.tsx

## R-CROSS-001 UI 反映 desired state，而不是文件系统偶然状态

Status: active
Applies to: skills, MCP, memory, vars, projection

Rule:
Loom UI 必须反映 manifest/config 中的 desired state。磁盘上已有文件可以用于展示可用性或诊断信息，但不能被静默推断成用户已选择的 desired state。

Implications:

- Agent chip 显示 manifest 是否选择了对应 agent。
- 磁盘上的 projection artifact 不会单独让某个 item 显示为已选择。
- 引用的本地文件缺失时，UI 可以展示 unavailable 或缺失诊断，但不能自动删除 desired entry。
- Vars 的目标 agent chips 必须来自 Settings agents；default/agent 查看范围独立于“配置管理/最终结果”视图切换，配置管理中的当前值按所选查看范围展示 default 或 agent-specific 值。
- 没有 Configured agents 时，业务页面保持非 agent 功能，但不显示 agent controls，也不发起 agent-specific 请求。

Safety:

- 不从 stale projection artifact 推断用户意图。
- 不因为文件系统 artifact 存在或缺失就静默重写 desired state。

Examples:

- 如果 ~/.config/opencode/skills/superpowers/executing-plans 存在，但 manifest 没有为该 member 选择 OpenCode agent，UI chip 仍保持未选择。
- 如果 local skill path 不存在，UI 可以展示路径缺失，同时保留 manifest entry。

Tests:

- packages/web/test/skills-view.test.tsx
- packages/web/test/mcp-view.test.tsx
- packages/web/test/memory-view.test.tsx
- packages/server/test/api/local-skill-status.test.ts
- packages/web/test/vars-view.test.tsx

## R-CROSS-002 desired-state 编辑后自动 reconcile projection

Status: active
Applies to: skills, MCP, memory

Rule:
用户修改 skills 或 Memory 的 desired agent state 后，Loom 应自动 reconcile 对应 projection，不要求用户再手动点击一次 project。MCP 是显式 Project changes 例外，见 R-MCP-002。

Implications:

- 单个 agent toggle 保存 manifest 后，会投影相关 scope。
- Memory 页面修改某个 agent 的 Memory assignment 后，会自动运行 memory projection。
- 批量 agent 更新在所有 manifest 更新成功后投影。
- 保存 source members/resources selection 后，会投影 skills。
- MCP agent chip 和全局 agent chip 只保存 desired agent state，不自动投影；MCP projection 由 Project changes 显式触发。

Safety:

- 批量更新中途失败且已有部分更新成功时，要刷新 manifest，让 UI 反映已保存状态。
- projection 成功前不能报告整体成功。

Examples:

- 点击某个 skill 的 OC chip，会更新 manifest agents，然后运行 skills projection。
- 把 Memory `team` 分配给 OpenCode，会更新 `memory_agents.opencode`，然后运行 memory projection。
- 保存 source 内容选择，会更新 source members/resources，然后运行 skills projection。
- 点击 MCP server 的 CX chip，只更新 manifest agents；用户点击 MCP 页面 Project changes 后才运行 MCP projection。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/skills-view.test.tsx
- packages/web/test/mcp-view.test.tsx
- packages/web/test/memory-view.test.tsx

## R-CROSS-003 批量控制必须有明确 scope

Status: active
Applies to: skills, MCP

Rule:
批量 agent 控制必须让 scope 清晰，并且只更新该 scope。

Implications:

- 全局 skills 批量控制作用于全部 skills。
- Source 级 skills 批量控制只作用于该 source 下 selected members。
- Item 级控制只作用于该 item。
- Source 内容选择与 agent 应用是分离的操作；Add/Edit Source 内不提供 agent controls。

Safety:

- Source 级批量操作不能更新 local skills 或其他 sources。
- 未选择的 source bundles 不能因为批量 agent 操作而加入 manifest 或被投影。

Examples:

- superpowers source header 的 OpenCode chip 只更新 selected superpowers members。
- 顶部 skills 批量 OpenCode chip 更新所有 source members 和 local skills。

Tests:

- packages/web/test/manifest-operations.test.tsx
- packages/web/test/skills-view.test.tsx
- packages/web/test/mcp-view.test.tsx

## R-CROSS-004 除非 Loom 能证明归属，否则保留 user-owned artifacts

Status: active
Applies to: projection, skills, MCP, memory

Rule:
Loom 可以删除或替换自己能识别为 Loom-managed 的 artifacts。没有这种证明的 artifacts 视为 user-owned，必须保留。

Implications:

- Copy-projected skill 目录需要 Loom marker，cleanup 才能删除。
- Agent-native config merge 必须保留未知为 Loom-managed 的条目。
- Cleanup 只有在删除 managed child 后，才可以顺带删除空 parent，并且最多删到 projection root。

Safety:

- 不能只根据路径形状删除真实目录。
- 不能把没有 marker 的 source/member 目录视为 Loom-managed。

Examples:

- 包含 .loom-projection.json 的 copied skill 可以在 agents 清空后删除。
- 没有 marker 的 skills/superpowers/custom-skill 目录必须保留。

Tests:

- packages/server/test/projection/executor.test.ts
- packages/server/test/projection/mcp-merge.test.ts

## R-CROSS-005 外部路径操作只能作用于仓库内目标

Status: active
Applies to: server API, web UI

Rule:
Loom 可以解析当前仓库内已存在文件或目录的真实绝对路径，用于复制路径或请求受支持的本机应用打开目标。请求使用仓库相对路径；server 统一执行安全解析，打开操作额外使用受限应用标识。

Implications:

- 目标可以是文件或目录，不绑定特定扩展名或业务资源类型。
- 复制路径返回运行平台的原生绝对路径。
- 首版支持 macOS 和 Windows；不支持的平台返回明确诊断。
- 系统文件管理器对文件执行定位选择，对目录直接打开。
- 上次选择的应用保存在设备级 Loom 配置中，跨仓库、文件和浏览器复用。

Safety:

- 不接受绝对路径、路径穿越或符号链接后落到仓库外的目标。
- 不通过 shell 拼接用户提供的路径或应用名称。
- 应用标识必须来自 server 定义的白名单。

Tests:

- packages/server/test/api/open-path.test.ts
- packages/server/test/platform/node/external-opener.test.ts
- packages/web/test/open-with.test.tsx

## R-CROSS-006 Persisted manifest 先验证容器，再进入业务逻辑

Status: active
Applies to: manifest loading, skills, MCP, config, projection

Rule:
仓库内 `skills.yaml`、`mcp.yaml`、`config.yaml` 必须先通过运行时容器验证，才能进入 mutation 或 projection。`skills.yaml` 顶层是包含 `sources` 与 `skills` 数组的对象，`mcp.yaml` 顶层是数组，`config.yaml` 顶层是对象。文件缺失使用对应空值；空 `config.yaml` 等价于空对象，显式 `null` 或 scalar 不是空配置。

Implications:

- 已存在但容器错误的文件产生结构化 diagnostic，不静默替换成空 desired state。
- 非对象 list item 产生精确到文件和索引的 diagnostic；对象 item 继续接受字段级 schema 验证。
- Config 是 open-ended 文档；已解析的未知 own fields 在读取、merge 和无关 mutation 中保留。
- Vars/Memory filename map 与 Config merge 只消费 own properties，并使用不继承 `Object.prototype` 的动态 records。

Safety:

- 容器错误必须在业务写入、外部 process、Git mutation 或 projection artifact 写入前失败。
- 不读取 inherited properties，不允许 `__proto__` 等动态 key 改变输出对象 prototype。
- 错误响应和日志不得回显原始 YAML 内容。

Examples:

- `config.yaml` 内容为空时可以读取为 `{}`；内容为 `null` 时返回 invalid-config diagnostic。
- `mcp.yaml` 写成 `{ servers: [] }` 时不能被当成没有 MCP servers。

Tests:

- packages/core/test/manifest.test.ts
- packages/server/test/api/repo-config.test.ts
- packages/server/test/projection/scan.test.ts
- packages/server/test/mcp/application.test.ts
- packages/server/test/skills/application.test.ts

## R-CROSS-007 Caller 或 persisted path 不是 mutation authority

Status: active
Applies to: skills, projection, source update, sync, recovery

Rule:
Caller input、plan、cache metadata 或 persisted journal 中的 path 只能用于绑定已知 identity，不能单独授权读取、覆盖、移动或删除。Mutation path 必须从已授权 canonical root 和经过 schema 验证的稳定 identity 重新派生。

Implications:

- Persisted state 使用 versioned runtime schema；malformed state、EACCES 或 EIO 不得降级为 missing。
- Recovery 重新验证 root、entry kind、canonical containment 和 physical identity。
- External ref、source cache、session staging 和 agent-native destination 分别绑定其所有者 identity。

Safety:

- 不对 journal 中的任意 absolute path 直接执行 remove、move、replace 或 recursive copy。
- Root、ancestor、leaf 是 link、junction、special entry或身份漂移时 fail closed，外部 sentinel 保持不变。

Examples:

- Source update journal 中即使存在 `stagingDir` 字段，recovery 也只操作由 canonical repository 和 session id重新派生且 ownership匹配的 staging entry。

Tests:

- packages/server/test/skills/update-sessions.test.ts
- packages/server/test/projection/executor.test.ts

## R-CROSS-008 Filesystem batch mutation 先完整验证再提交

Status: active
Applies to: skills mutation, source preserve, projection

Rule:
同一业务操作涉及多个 filesystem artifacts 时，必须在首次 user-visible destination mutation 前完成整批 identity、path graph、source kind、destination collision 和 ownership preflight。新内容先写入 owned staging，最终安装不能替换既有 entry。

Implications:

- Duplicate normalized path、file/ancestor collision 或任一 late validation error 都产生零 final mutation。
- Copy/snapshot 不跟随 link 或 junction，只接受契约允许的 regular files 和真实 directories。
- Commit 前出现并发 destination 时保留该 destination并失败，不能覆盖或报告成功。

Safety:

- Partial copy、marker write或 commit失败不能留下看似完整但未登记的 final artifact。
- Rollback 只操作 owner token 和 physical identity 都匹配当前事务的 artifact；primary 与 rollback failure 必须同时可观测。

Examples:

- 同一 archive 同时包含 `docs` 文件和 `docs/usage.md` 时，在创建 skill directory 前拒绝整个 batch。

Tests:

- packages/server/test/skills/application.test.ts
- packages/server/test/projection/executor.test.ts

## R-CROSS-009 B2 API failure 使用稳定 HTTP contract

Status: active
Applies to: skills, MCP, MCP import, MCP debug

Rule:
B2 API 的 request validation 返回 HTTP 400，not found 返回 404，collision 或 stale state 返回 409，invalid persisted configuration 返回 422，operational 或 unexpected failure 返回 500。Failure response 不得使用 HTTP 200。

Implications:

- Typed Application error 保留稳定 code 与分类后的 status；route 不信任缺省或未知 lifecycle status。
- Repository authorization error 继续使用 R-REPOSITORY-002 的 `invalid_repo` / `repo_unavailable` contract，不得被 operation-specific error 覆盖。
- MCP debug 的 missing session、session capacity、connect/list-tools/tool-call failure 分别映射为 404、409、500。

Safety:

- Response 使用固定安全 message，不回显 unexpected `error.message`、path、stack、cause 或 secret。
- Catch/error boundary 记录完整 `{ err }`；同一 route boundary 不重复记录同一 failure。

Examples:

- Stale MCP import preview 返回 HTTP 409 `stale_import_preview`。
- MCP debug transport connect failure 返回 HTTP 500 `connect_failed`，底层 process 或 network message 只进入日志。

Tests:

- packages/server/test/api/b2-route-contracts.test.ts
- packages/server/test/api/mcp-import-routes.test.ts
- packages/server/test/api/mcp-debug-routes.test.ts

## R-CROSS-010 跨资源命令使用统一 lease

Status: active
Applies to: repository state, local config, projection, source update, MCP import, Sync

Rule:
读取或修改多个持久化 artifact 的顶层命令必须通过 server-wide resource lease coordinator 获取完整资源集。资源 key 使用已授权 canonical identity，获取前去重并按固定全序排列；同一资源按到达顺序执行，只有资源集不相交的命令可以并行。

Implications:

- `read` 与 `mutation` 双向排斥，writer等待active reader，reader等待先到writer；读取不得观察跨文件 mutation 的中间状态。
- 同一命令的read、validate、write、projection、rollback与cleanup属于同一 lease；不能只锁最终文件写入。
- Local config使用canonical home identity，不挂到任一repository key；需要repo与local config的命令一次获取两个key。
- Projection同时获取repository、projection state与所有可能触达的agent-native target key；MCP import同时获取实际native source config key。不同repository只有完整资源集不相交时才能并行。
- Sync、普通API和child process复用同一跨进程lock protocol；push、force-push与remote update不得绕过。
- 跨进程协议必须能锁定尚不存在的逻辑资源，不得为了加锁预先创建业务文件或目录。
- Top-level command只获取一次。内部callback使用已持有上下文或unlocked helper，不得重入同一non-reentrant resource。

Safety:

- 无效request先完成authorization再排队；依赖当前状态的validation在lease内重读。
- Operation、rollback或release失败后必须释放内存调度状态，使后续waiter可以从最终状态继续。
- 不存在的目标使用canonical existing parent与validated basename形成稳定key，不能等待创建后才决定锁身份。

Tests:

- packages/server/test/concurrency/resource-lease-coordinator.test.ts
- packages/server/test/api/resource-lease-integration.test.ts
- packages/server/test/sync/session-manager.test.ts

## R-CROSS-011 API failure envelope 与 status policy

Status: active
Applies to: HTTP API、Web API client

Rule:
非 2xx API failure 使用 `{ ok: false, error: string, message: string, diagnostics? }`；request validation为400、not found为404、state conflict为409、quota为413、invalid persisted input为422、operational或unexpected failure为500。明确建模为discriminated union的业务结果可以使用HTTP 200。

Implications:

- Web client在API统一期间同时解码flat `error: string`与nested `error: { code, message }`，并保留稳定code、message和diagnostics。
- Sync push的Git拒绝是HTTP 200 business result；Sync session、pull、save与transport failure使用互斥success DTO或非2xx `ApiError`，不能用optional fields拼出不可能状态。
- Config与Memory对malformed persisted config统一返回422；unexpected read/write failure返回500。

Safety:

- Unexpected error的原始message、path、stack、cause或secret只进入包含完整`{ err }`的日志，不进入response。
- 同一route boundary只记录一次同一failure。

Tests:

- packages/web/test/api.test.ts
- packages/web/test/sync.test.tsx
- packages/server/test/api/memory.test.ts
- packages/server/test/api/routes.test.ts

## R-CROSS-012 Runtime owner负责释放后台资源

Status: active
Applies to: API route runtime、Sync maintenance、MCP debug sessions

Rule:
创建maintenance timer、session manager或transport的runtime必须暴露幂等`dispose()`并释放自己创建的资源；注入的dependency保持caller-owned，除非显式转移ownership。

Implications:

- Runtime dispose先停止maintenance，再等待进行中的recovery、session create与cleanup，重复或并发调用不得重复释放。
- MCP session capacity包含正在连接的session；dispose开始后拒绝新session，已开始的create不能在dispose完成后留下session或transport。

Safety:

- Expired session的异步cleanup必须可被dispose观察和等待。
- Runtime shutdown完成时不得遗留owned MCP client或session。

Tests:

- packages/server/test/mcp/debug-session.test.ts
- packages/server/test/api/routes.test.ts
