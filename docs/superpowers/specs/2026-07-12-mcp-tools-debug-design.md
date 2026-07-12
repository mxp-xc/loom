# MCP tools 调试设计

## 目标

在 MCP Workbench 中增加 tools 调试能力。用户可以对已保存的 MCP server 或正在编辑的草稿执行临时连接，查看 server 暴露的 tools，并用可编辑 JSON 参数直接调用 tool。

相关规则：

- [R-CROSS-001](../../rules/cross-cutting.md)：UI 反映 desired state，而不是文件系统偶然状态。
- [R-MCP-001](../../rules/mcp.md)：MCP server 定义与 target 应用分离。
- [R-MCP-002](../../rules/mcp.md)：MCP projection 必须显式触发。
- [R-MCP-003](../../rules/mcp.md)：Preview target 是只读解析上下文。
- [R-MCP-004](../../rules/mcp.md)：MCP 变量引用可检查 trace。
- [R-MCP-005](../../rules/mcp.md)：MCP detail 按 transport 展示字段。

## 范围

本轮纳入：

- 已保存 MCP server 的临时连接测试。
- editor draft 的临时连接测试。
- 连接成功后展示 tools 列表。
- 按 tool inputSchema 生成初始测试参数。
- 使用 Monaco 编辑 tool 参数 JSON。
- 直接调用 tool 并展示结果。
- 后端临时 debug session 生命周期管理与兜底清理。

本轮不纳入：

- prompts 调试。
- resources 或 resource templates 调试。
- JSON Schema 校验。
- 将调试结果写入 manifest、agent-native 配置或投影状态。
- 跨页面复用长期 MCP 连接池。

## 用户体验原则

调试能力是临时运行面，不是 desired state。它不能修改 server definition、targets 或 projection artifact。已保存 server 的调试来源显示为 saved server，草稿的调试来源显示为 draft，避免用户误以为草稿已经保存。

工具调用是一次真实 MCP tool call。用户点击 Call 后立即执行，不做二次确认。Call 期间按钮禁用并显示 loading，避免重复提交。

参数编辑只要求 JSON 语法可解析为 object。Tool inputSchema 仅用于生成初始参数和辅助展示，不用于阻断调用。这样可以兼容 schema 不标准、缺字段或使用非标准扩展的 MCP server。

MCP detail 的主路径仍然是配置查看与编辑。用户从左侧 server 列表点击条目进入 detail，默认停留在 `配置` 区域；`Tools 调试` 是同级 tab，只有用户切换到该 tab 后才展示连接、tools、参数和结果。调试区不能直接插在配置内容下方，也不能替代既有编辑入口。

`Tools 调试` tab 不提供 saved/draft source toggle。调试来源由当前上下文决定：已保存 detail 使用 saved server，编辑器草稿使用 draft buffer。界面不额外展示 command/session/source 三张摘要卡，避免和配置区重复。

Tools 列表负责选择 tool；右侧调用区只展示参数编辑、重置参数、调用动作和结果，不重复展示 tool 标题、描述或 inputSchema strip。重置按钮文案为 `重置参数`。

## 选型

采用后端临时 debug session。

前端负责收集当前调试对象、展示 tools、编辑参数和触发调用。后端负责连接 MCP server、持有临时 client、执行 listTools 和 callTool，并统一清理连接。

不采用一次性连接，因为 stdio server 每次 call 都重启，调试体验差，也容易隐藏初始化成本。不采用长期连接池，因为它容易和 Loom desired state、草稿状态和变量解析上下文混淆。

## 后端架构

新增 `McpDebugSessionManager`，在 server 进程内持有短生命周期 session。

每个 session 记录：

- `id`：随机 session id。
- `source`：`saved` 或 `draft`。
- `serverFingerprint`：由解析后的 transport config 计算，用于前端提示 stale。
- `previewTarget`：本次连接使用的 agent 视角。
- `client` 与 transport cleanup handle。
- `tools`：连接后 listTools 得到的工具清单。
- `createdAt`、`lastUsedAt`、`expiresAt`。

连接入口接收 resolved MCP server config，而不是直接读取 agent-native 配置。对于已保存 server，前端传 server id，后端从 manifest 读取 server definition 后按 preview target 解析变量。对于草稿，前端传 draft definition，后端同样按 preview target 解析变量。解析失败时返回结构化诊断，不创建 session。

Transport 由 server 类型决定：

- `stdio`：使用 MCP TypeScript SDK 的 `StdioClientTransport`，由后端 spawn command/args，并注入解析后的 env。
- `http`：优先使用 `StreamableHTTPClientTransport`，注入 headers。
- `sse`：使用 `SSEClientTransport`；如后续需要兼容 http 自动降级，可在实现计划中单独评估。

Client 使用 MCP TypeScript SDK 的 `Client`。连接后立即 `listTools()`，成功才登记 session。连接或 listTools 失败必须 close 已创建的 client/transport，并记录完整错误对象。

## API

新增 MCP debug routes：

- `POST /api/mcp/debug/sessions`
- `POST /api/mcp/debug/sessions/:id/tools/call`
- `DELETE /api/mcp/debug/sessions/:id`

创建 session 请求：

```ts
type CreateMcpDebugSessionRequest =
  | {
      repo: string
      source: 'saved'
      serverId: string
      previewTarget: AgentId
    }
  | {
      repo: string
      source: 'draft'
      draft: McpServer
      previewTarget: AgentId
    }
```

创建 session 响应：

```ts
type CreateMcpDebugSessionResponse =
  | {
      ok: true
      sessionId: string
      source: 'saved' | 'draft'
      serverFingerprint: string
      previewTarget: AgentId
      tools: McpDebugTool[]
      createdAt: string
      idleExpiresAt: string
      hardExpiresAt: string
    }
  | {
      ok: false
      error: string
      message: string
      diagnostics?: VarsDiagnostic[]
    }
```

Tool 调用请求：

```ts
interface CallMcpDebugToolRequest {
  toolName: string
  arguments: Record<string, unknown>
}
```

Tool 调用响应保留 SDK 返回结构：

```ts
type CallMcpDebugToolResponse =
  | {
      ok: true
      result: unknown
      durationMs: number
      calledAt: string
    }
  | {
      ok: false
      error: string
      message: string
      durationMs?: number
    }
```

当 session 不存在、已过期或已清理时返回 `session_expired`。前端收到后显示重新连接入口，不自动重连。

## Session 生命周期

Session 清理有三层：

- 主动清理：前端在 Disconnect、重新连接、切换 server、草稿变更导致 stale、组件 unmount 时调用 DELETE。
- 空闲回收：后端定时扫描 `lastUsedAt`，例如 5 分钟无调用后 close 并移除 session。
- 硬上限：每个 session 例如 30 分钟后强制 close，即使期间持续调用也不继续持有。

所有 cleanup 都走同一函数。Cleanup 调 `client.close()`，失败时用完整错误对象记录日志，但仍从 registry 移除 session，避免连接状态无法释放。Server 关闭时也要遍历关闭所有 session。

为了限制资源占用，manager 应设置并发上限，例如全局最多 8 个 session。超过上限时拒绝新建并提示先断开已有连接或稍后重试。未来如需 per-repo/per-user 限制，可在 manager 层扩展。

## 前端集成边界

前端调试入口放在 MCP Workbench 右侧，不新增页面。高保真原型保留在 `temp/prototypes/mcp-tools-debug/`，正式实现复用现有组件、样式、Monaco 和 fixture，不把 prototype-only 代码混入生产路径。

已保存 server 和草稿都支持连接：

- Detail 中对当前 selected server 执行连接；入口位于 `Tools 调试` tab。
- Editor 中对当前 draft 执行 Test draft；来源由 editor draft 上下文隐式决定，不再由用户切换。
- 草稿字段变化后，当前 debug session 标为 stale；用户需要重新连接。
- Preview target 变化后，已有 session 同样标为 stale，因为变量解析上下文已变化。

Tools 列表和调用区只依赖后端返回的 session 数据。前端不直接连接 MCP server，也不 spawn stdio 进程。

## 参数生成与 Monaco

参数生成函数接收 tool inputSchema，返回 JSON 字符串。它只做启发式生成：

- `string`：空字符串；有 enum 时取第一个 enum。
- `number` / `integer`：`0`。
- `boolean`：`false`。
- `array`：按 items 生成一个示例元素。
- `object`：按 properties 递归生成，最多两层。
- 缺失、循环、非对象或无法理解的 schema：`{}`。

生成逻辑不执行 JSON Schema validate，也不因 required 缺失阻断调用。Required 只影响初始参数是否优先生成字段。

Monaco 使用 `json` language、明确 aria-label、word wrap、稳定高度和现有 theme。点击 Call 时仅做 `JSON.parse`。解析失败时在参数编辑器附近显示错误，并记录完整错误对象；不调用后端。

## 错误处理

后端错误分为：

- `resolution_failed`：变量解析失败，返回 diagnostics。
- `connect_failed`：连接失败。
- `list_tools_failed`：连接后列 tools 失败。
- `session_expired`：session 不存在或已回收。
- `tool_call_failed`：tool call 抛错或 SDK 返回调用错误。
- `cleanup_failed`：cleanup 失败，只写日志，不阻断 session 移除。

所有 catch 和 cleanup 失败必须记录完整错误对象，例如 `logger.error('MCP debug connect failed', { err, serverId })`。不能只记录 `err.message`。

前端错误显示在调试区内部，不覆盖用户正在编辑的 draft，不只依赖 toast。连接失败和 tool call 失败都应提供可恢复动作，例如重新连接或重新调用。

## 安全边界

MCP debug 可以执行真实 tool call，因此 UI 必须明确表达这是临时调试执行。它不自动投影、不保存参数、不修改 desired targets。

Remote headers 和 env 中的 secret 展示沿用现有遮罩语义。Debug API 响应不得泄露已遮罩 secret 明文。日志中不得记录完整 env、headers 或 tool arguments 的 secret 明文；必要时记录 server id、tool name、transport type、错误对象和 duration。

Stdio 连接只使用用户在 Loom 中配置的 command/args，不做 shell 拼接。实现时必须避免通过 shell 字符串执行。

## 测试与验证

后端测试：

- 创建 stdio/http/sse debug session 时选择正确 transport。
- 连接成功后返回 tools 并登记 session。
- listTools 失败时关闭 client 并不登记 session。
- callTool 复用 session，更新 lastUsedAt，返回 result。
- session 不存在或过期时返回 `session_expired`。
- idle timeout 和 hard timeout 都会 close 并移除 session。
- cleanup 失败时记录错误并移除 session。

前端测试：

- Detail 默认展示配置区，不自动展示 tools 调试区。
- Detail 切到 `Tools 调试` tab 后能连接已保存 server 并展示 tools。
- Editor 能 Test draft，draft 变化后 session 标为 stale。
- Preview target 变化后 session 标为 stale。
- Tool 参数由 schema 生成并可在 Monaco 中编辑。
- 参数 JSON parse 失败时不调用后端。
- Call tool loading 时禁用按钮并展示结果或错误。
- session_expired 时提示重新连接。

验证命令：

```bash
bun run test -- packages/server/test/mcp
bun run test -- packages/server/test/api
bun run test -- packages/web/test/mcp-view.test.tsx
bun run test
```

涉及 UI 实现时必须启动 `bun dev`，并用 `playwright-cli` 自动验证 MCP 页面在桌面与 375px 视口下无空白、无明显重叠、Monaco 参数区可见，不能把浏览器人工确认当作验收。

## 验收标准

- 已保存 server 和 editor draft 都能创建临时 debug session。
- 已保存 server detail 默认停留在配置区；tools 调试只能在 `Tools 调试` tab 中出现。
- 连接成功后可看到 tools 列表。
- Tool 参数根据 inputSchema 生成初始 JSON，并可在 Monaco 中修改。
- Tool call 不做 JSON Schema 校验，只要求参数 JSON 可解析为 object。
- Tool call 结果和错误在调试区展示。
- 调试区不展示 saved/draft source toggle，不展示 command/session/source 摘要卡，不重复展示 tool 标题、描述或 inputSchema strip。
- 用户刷新、关闭页面或网络中断后，后端能通过 idle timeout 和 hard timeout 释放 session。
- 调试不会修改 `mcp.yaml`、targets、projection artifact 或 agent-native MCP 配置。
- 连接、调用、清理中的错误都有完整日志对象。
