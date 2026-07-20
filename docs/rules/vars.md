# Vars 规则

这些规则定义 typed vars 的解析、分层覆盖、secret 展示和变更安全边界。

## R-VARS-001 Vars 解析只读取 Vars，不读取系统环境变量

Status: active
Applies to: vars resolver, memory preview, memory projection

Rule:
Vars 中的 `${key}` 引用只从 Loom Vars 的最终可见值中解析，不读取 `process.env` 或其他系统环境变量。缺失引用、循环引用和不支持的插值必须返回诊断，而不是返回可供业务消费的不完整结果。

Implications:

- 字符串引用按已合并的 vars 值递归解析。
- 引用缺失或形成循环时，调用方应展示结构化诊断。
- Memory 预览和 projection 使用同一套 vars 诊断语义。

Safety:

- 不把运行进程的环境变量作为隐式 fallback。
- 解析失败时不静默写入半渲染内容。

Examples:

- 如果 `memory.context` 引用了不存在的 `memory.rtk`，Memory 预览展示 key、reference 和 path 诊断，而不是读取同名环境变量。

Tests:

- packages/core/test/vars.test.ts
- packages/web/test/memory-editor.test.tsx
- packages/server/test/projection/executor-memory.test.ts

## R-VARS-002 Agent-aware vars 使用固定覆盖链

Status: active
Applies to: agent-aware vars, vars API, vars UI

Rule:
Agent-aware vars 解析按 base、base agent override、local、local agent override、builtin runtime 的顺序合并。用户可编辑 key schema 由 base 定义；非 base 层只覆盖已定义 key 的 value。

Implications:

- Base key 是用户 key 的 schema registry。
- Agent、local、local-agent 层不能用 typed definition 新增 key。
- Override value 必须符合 base definition 的类型。
- Builtin runtime vars 不写入磁盘，且用户不能定义 `LOOM_*` key。
- Default 解析上下文只合并 base 与 local，不包含 agent override 或 builtin runtime。
- Vars 页面始终加载 Default matrix，并只加载 Configured agents 的 agent matrices；空配置时仍可编辑 Base/Local Default 槽位。
- Vars 的 agent slots 和 modal choices 只枚举 Configured agents；隐藏的 agent override 文件不删除，重新配置后恢复显示。

Safety:

- 未知 agent override 文件产生诊断，不参与渲染。
- Local vars 只参与本机解析和投影，不进入仓库同步内容。

Examples:

- `vars/agents/codex.yaml` 中出现未知 key 时，Vars matrix 保留可修复诊断，而不是把该 key 当作新 schema。

Tests:

- packages/core/test/vars.test.ts
- packages/core/test/vars-codec.test.ts
- packages/server/test/api/vars-routes.test.ts
- packages/web/test/vars-profile-model.test.ts
- packages/web/test/vars-view.test.tsx

## R-VARS-003 Secret 默认遮罩并传递 taint

Status: active
Applies to: vars API, vars UI, vars resolver

Rule:
`secret` 类型在 API 响应、列表、补全和解析预览中默认遮罩；依赖 secret 的解析结果也必须被视为 secret-tainted 并遮罩。显式 reveal 只返回用户请求的单个变量值。

Implications:

- Secret 的编辑值、列表摘要、completion value 和 resolved preview 默认不暴露明文。
- 依赖 secret 的非 secret 变量也不能在解析结果中泄露最终值。
- 用户显式 reveal 后，只能看到被请求的变量，不顺带暴露其他 secret 或传递依赖值。

Safety:

- 错误响应和日志不得泄露 malformed YAML 中的 secret 明文。
- `secret` 是显示层和 API 层的遮罩能力，不等同于加密存储。

Examples:

- `api.token` 是 secret，`auth.header` 引用它；resolved view 中二者都应遮罩。

Tests:

- packages/server/test/api/vars-routes.test.ts
- packages/web/test/vars-editors.test.tsx
- packages/core/test/vars.test.ts

## R-VARS-004 Vars 变更必须保护引用与存储边界

Status: active
Applies to: vars mutations, vars API, vars storage

Rule:
Vars 新增、编辑、删除和重命名必须维护引用图和存储安全边界。删除被引用 key 需要当前 impact token；重命名必须同步更新 vars 与已登记消费者引用；同一仓库的并发 mutation 必须串行化。

Implications:

- 删除有依赖的 base key 前先返回影响范围。
- 使用过期 impact token 的删除请求会被拒绝。
- 重命名 key 时同步改写 base、override layer 以及 memory/MCP 等已登记消费者引用。
- 写入前完成序列化和校验，写入失败时回滚可回滚的变更。

Safety:

- Vars 操作必须限制在授权的当前仓库内。
- `vars` 目录或环境 YAML 指向仓库外的 symlink 时拒绝操作。
- 并发读写不能暴露 mutation 的中间状态。

Examples:

- 删除 `agent_name` 前，如果 memory 模板仍引用它，API 应拒绝直接删除并返回影响信息。

Tests:

- packages/core/test/vars-mutators.test.ts
- packages/core/test/vars-graph.test.ts
- packages/server/test/vars/store.test.ts
- packages/server/test/api/vars-routes.test.ts

## R-VARS-005 Typed VarEntry 在所有生命周期使用同一 schema

Status: active
Applies to: vars codec, lifecycle, mutation, resolver, API, UI

Rule:
Typed VarEntry 的读取、规范化、clone、mutation、解析和序列化使用同一结构契约。`string` 与 `secret` 的 value 是 string，并可选 `plain`、`markdown`、`json`、`yaml`、`toml`、`shell` 或 `path` format；`number`、`boolean` 与 `json` 使用各自类型，不能携带 `format` 或其他未知字段。

Implications:

- 无关的 set、rename 或 delete 不得让合法 formatted entry 崩溃或丢失 `format`。
- `number` 只接受有限值；`json` 只接受可安全复制的 JSON value。
- Typed entry 的未知字段是错误；legacy vars 仍按 legacy codec 规则读取。
- Secret 遮罩后的 entry 保留 `format`，因此展示层不丢失编辑语义。

Safety:

- Normalization 只读取 enumerable own data properties，不执行 getter。
- JSON value 不接受 cycle、symbol key、accessor、稀疏数组或非普通 object prototype。

Tests:

- packages/core/test/vars-codec.test.ts
- packages/core/test/vars-mutators.test.ts
- packages/core/test/vars.test.ts
- packages/server/test/vars/application.test.ts

## R-VARS-006 Vars token 使用奇偶反斜杠转义语法

Status: active
Applies to: vars graph, resolver, renderer, rename, delete impact, registered consumers

Rule:
`${key}` 与 `${key:default}` 前连续反斜杠的奇偶性决定 token 是否生效：偶数个反斜杠表示 active token，奇数个表示 literal token。渲染时每对反斜杠折叠为一个，literal token 保留 `${...}` 文本。

Implications:

- Graph、dangling reference、delete impact、rename、resolver 和 renderer 使用同一 token scanner。
- Rename 只改写 active token，并原样保留 token 前的反斜杠与 default 文本。
- Legacy resolver 支持 template default；agent-aware resolver 对 active default 返回结构化 `UNSUPPORTED_DEFAULT` diagnostic。
- Memory 与 MCP 等已登记消费者的引用检查和 rename 遵循相同转义语法。

Safety:

- Literal token 不得形成依赖边、阻塞删除或被 rename。
- 偶数反斜杠后的 active token 不得被旧的“前一字符是反斜杠”判断误当成 literal。

Examples:

- `\${name}` 渲染为 literal `${name}`。
- `\\${name}` 渲染为一个反斜杠加上 `name` 的解析值。

Tests:

- packages/core/test/vars-render.test.ts
- packages/core/test/vars-graph.test.ts
- packages/core/test/vars-mutators.test.ts
- packages/server/test/api/vars-routes.test.ts
