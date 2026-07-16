# MCP 规则

MCP 规则定义 Loom 中 MCP server 的 desired state、target 应用、配置解析上下文与投影边界。

## R-MCP-001 MCP server 定义与 target 应用分离

Status: active
Applies to: MCP manifest, MCP UI, MCP API

Rule:
MCP server 的定义保存只更新 desired server definition；target 应用只更新该 server 选择投影到哪些 agent。新增 MCP server 默认不应用到任何 target。

Implications:

- Create MCP server 时默认 `targets: []`，不因当前配置视图或当前选中 agent 自动添加 target。
- Edit MCP server 时保留原有 `targets`，除非用户在 target 控制中显式修改。
- MCP server row 与全局 target chip 只更新 desired target state，不触发 projection。

Safety:

- 不把当前配置视图对应的 agent 误写入 manifest targets。
- 不因保存 server 定义而静默修改 target 应用范围。

Examples:

- 用户新增 `playwright` server 后，该 server 出现在列表中，但三个 agent chips 都是未应用状态。
- 用户编辑 `playwright` 的 env 后，原来已应用到 Codex 的 target 仍保留。

Tests:

- packages/web/test/mcp-view.test.tsx
- packages/web/test/views.test.tsx

## R-MCP-002 MCP projection 必须显式触发

Status: active
Applies to: MCP UI, projection

Rule:
MCP 的 target state 改动不会自动 project。用户必须通过 MCP 页面中的 Project changes 显式触发 MCP projection。

Implications:

- Row target chip 和全局 target chip 保存 desired state 后只刷新页面状态。
- MCP 页面 Project changes 按钮调用 MCP scope projection。
- UI 必须把 server 定义、target 应用、Project changes 表达为三件事。

Safety:

- 不在 target toggle 成功后报告 projection 已完成。
- 批量 target 更新中途失败时刷新 manifest，让 UI 显示已保存状态。

Examples:

- 用户把一个 server 应用到 Codex 后，Codex 配置文件只有在点击 Project changes 后才被更新。

Tests:

- packages/web/test/mcp-view.test.tsx
- packages/web/test/views.test.tsx
- packages/server/test/projection/mcp-merge.test.ts

## R-MCP-003 配置视图是只读解析上下文

Status: active
Applies to: MCP detail, MCP editor, vars rendering

Rule:
配置视图用于查看原始定义、默认解析结果或某个 agent 视角下的 transport、env、headers 和 settings preview。它只影响变量解析和预览格式，不改变 desired state。

Implications:

- Detail 和 Editor header 提供 RAW、Default、Claude Code、Codex、OpenCode 配置视图。
- RAW 保留 `${...}`；Default 只按 Base -> Local 解析，不应用 agent override 或 builtin runtime。
- Editor 下方 preview card 使用当前 draft 和配置视图实时展示对应形态。
- Claude Code 预览为 `mcpServers` JSON，Codex 预览为 `mcp_servers` TOML-like，OpenCode 预览为 `mcp` JSON。
- `${var}` 在 Default 中使用中性结果，在 agent 视图中使用对应 per-agent vars 结果。
- Tools 从 RAW 进入时自动切换到 Default；Default 和 agent 视图都可以创建真实调试连接。

Safety:

- 配置视图切换不能触发保存、target 应用或 projection。
- 缺失变量、默认值、JSON 插值等诊断必须在 preview 中可见。

Examples:

- 同一个 `${browsers_path}` 在 Claude Code 与 Codex 下可显示不同 resolved value，但 server 的 targets 不变化。
- Default 调试连接使用 Base → Local 的值，不把任意 agent 当作隐式 fallback。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/web/test/mcp-view.test.tsx

## R-MCP-004 MCP 变量引用可检查 trace

Status: active
Applies to: MCP detail, MCP editor, vars

Rule:
MCP 中的 `${var}` token 必须高亮并可打开变量信息。变量 trace 使用 Base -> Base/agent -> Local -> Local/agent -> Runtime 的覆盖语义。

Implications:

- `${var}` token 在 transport、env、headers 和 settings preview 中可点击。
- 变量信息弹窗使用 Vars 弹窗视觉语言，并展示 resolved value、来源层级和诊断。
- Trace 层级命名不得把 MCP env 或 settings key 当作变量来源层。

Safety:

- Secret 变量展示遵循 Vars 的遮罩规则。
- 缺失变量不能被静默显示为空值；必须展示诊断。

Examples:

- `${active_repo}` 的 trace 可以显示 Base、Local-Codex、Runtime-Codex 等层级，而不是显示 “MCP env”。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/web/test/mcp-view.test.tsx

## R-MCP-005 MCP detail 按 transport 展示字段

Status: active
Applies to: MCP detail, MCP editor preview

Rule:
MCP detail 只展示对当前 transport 有意义的字段。`stdio` 不展示 headers；`sse` 与 `http` 的 env 和 headers 分开展示。

Implications:

- `stdio` server 展示 command、args、env 与 settings preview，不显示 headers 空卡片。
- Remote transport 的 env 与 headers 分成独立区域，避免把 runtime env 和 auth headers 混在一起。
- Detail 中不展示 projection paths 等与当前 server 定义重复或低频的冗余信息。

Safety:

- Headers 中的敏感值必须遮罩或遵循现有安全展示规则。
- 不用空态卡片占位不存在的字段。

Examples:

- `sse` server 展示 `Authorization` header 和 `REQUEST_TIMEOUT` env；`stdio` server 只展示 env。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/web/test/mcp-view.test.tsx

## R-MCP-006 MCP import 是显式 desired-state 写入

Status: active
Applies to: MCP import, MCP UI, MCP API

Rule:
从 Claude Code、Codex、OpenCode 原生配置导入 MCP server 必须由用户显式触发并确认。导入只写入 Loom 的 `mcp.yaml` desired state，不修改 agent-native 配置，也不自动运行 projection。

Implications:

- 导入预览展示来源 agent、最终 id、targets、改名和 ignored fields。
- 导入后 targets 按来源生成；同一 server 从多个来源导入时合并 targets。
- 同名同定义只合并 targets；同名不同定义自动改名，保留现有 desired entry。
- 导入成功后仍由用户点击 Project changes 才投影到 agent-native 文件。

Safety:

- 不从磁盘现状静默推断 desired state；只有确认导入的条目会写入 `mcp.yaml`。
- 不覆盖现有不同定义的 desired entry。
- 不修改 agent-native MCP 配置文件。

Examples:

- 从 Codex 导入 browser 后，`mcp.yaml` 中该 server 带 `targets: ['codex']`。
- `mcp.yaml` 已有不同定义的 browser 时，从 Codex 导入的条目写为 browser-cx。

Tests:

- packages/server/test/mcp/importer.test.ts
- packages/server/test/api/mcp-import-routes.test.ts
- packages/web/test/mcp-view.test.tsx

## R-MCP-007 MCP 数组顺序是仓库共享展示顺序

Status: active
Applies to: MCP manifest, MCP UI, MCP API

Rule:
`mcp.yaml` server 数组顺序同时是 MCP 页面仓库共享的展示顺序，不保存独立 order 字段。

Implications:

- Reorder 只重排当前仍存在的 server；请求遗漏的 server 按当前顺序追加。
- 搜索生效时 UI 禁止排序，避免把局部结果误写成全局顺序。
- 顺序未变化时不写文件。

Safety:

- Reorder 不修改 server 定义或 targets，也不触发 projection。
- MCP 数据自身存在重复 id 时拒绝 reorder，不能猜测实体身份。

Examples:

- 当前为 A、B、C，请求为 C、A 时，最终为 C、A、B。

Tests:

- packages/server/test/mcp/application.test.ts
- packages/server/test/api/routes-fixes.test.ts
- packages/web/test/views.test.tsx
