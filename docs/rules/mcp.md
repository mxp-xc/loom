# MCP 规则

MCP 规则定义 Loom 中 MCP server 的 desired state、target 应用、preview target 与投影边界。

## R-MCP-001 MCP server 定义与 target 应用分离

Status: active
Applies to: MCP manifest, MCP UI, MCP API

Rule:
MCP server 的定义保存只更新 desired server definition；target 应用只更新该 server 选择投影到哪些 agent。新增 MCP server 默认不应用到任何 target。

Implications:

- Create MCP server 时默认 \`targets: []\`，不因当前 preview target 或当前选中 agent 自动添加 target。
- Edit MCP server 时保留原有 \`targets\`，除非用户在 target 控制中显式修改。
- MCP server row 与全局 target chip 只更新 desired target state，不触发 projection。

Safety:

- 不把 preview target 误写入 manifest targets。
- 不因保存 server 定义而静默修改 target 应用范围。

Examples:

- 用户新增 \`playwright\` server 后，该 server 出现在列表中，但 CC/CX/OC chips 都是未应用状态。
- 用户编辑 \`playwright\` 的 env 后，原来已应用到 Codex 的 target 仍保留。

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

- 用户把一个 server 应用到 CX 后，Codex 配置文件只有在点击 Project changes 后才被更新。

Tests:

- packages/web/test/mcp-view.test.tsx
- packages/web/test/views.test.tsx
- packages/server/test/projection/mcp-merge.test.ts

## R-MCP-003 Preview target 是只读解析上下文

Status: active
Applies to: MCP detail, MCP editor, vars rendering

Rule:
Preview target 用于查看某个 agent 视角下的 transport、env、headers 和 settings preview。它只影响变量解析和预览格式，不改变 desired state。

Implications:

- Detail header 提供 CC/CX/OC preview switch。
- Editor 下方 preview card 使用当前 draft 和 preview target 实时展示写入形态。
- Claude Code 预览为 \`mcpServers\` JSON，Codex 预览为 \`mcp_servers\` TOML-like，OpenCode 预览为 \`mcp\` JSON。
- \`\${var}\` 解析使用所选 target 的 per-agent vars 结果。

Safety:

- Preview target 切换不能触发保存、target 应用或 projection。
- 缺失变量、默认值、JSON 插值等诊断必须在 preview 中可见。

Examples:

- 同一个 \`\${browsers_path}\` 在 CC 与 CX 下可显示不同 resolved value，但 server 的 targets 不变化。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/web/test/mcp-view.test.tsx

## R-MCP-004 MCP 变量引用可检查 trace

Status: active
Applies to: MCP detail, MCP editor, vars

Rule:
MCP 中的 \`\${var}\` token 必须高亮并可打开变量信息。变量 trace 使用 Base → Base/agent → Local → Local/agent → Runtime 的覆盖语义。

Implications:

- \`\${var}\` token 在 transport、env、headers 和 settings preview 中可点击。
- 变量信息弹窗使用 Vars 弹窗视觉语言，并展示 resolved value、来源层级和诊断。
- Trace 层级命名不得把 MCP env 或 settings key 当作变量来源层。

Safety:

- Secret 变量展示遵循 Vars 的遮罩规则。
- 缺失变量不能被静默显示为空值；必须展示诊断。

Examples:

- \`\${active_repo}\` 的 trace 可以显示 Base、Local-Codex、Runtime-Codex 等层级，而不是显示 “MCP env”。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/web/test/mcp-view.test.tsx

## R-MCP-005 MCP detail 按 transport 展示字段

Status: active
Applies to: MCP detail, MCP editor preview

Rule:
MCP detail 只展示对当前 transport 有意义的字段。\`stdio\` 不展示 headers；\`sse\` 与 \`http\` 的 env 和 headers 分开展示。

Implications:

- \`stdio\` server 展示 command、args、env 与 settings preview，不显示 headers 空卡片。
- Remote transport 的 env 与 headers 分成独立区域，避免把 runtime env 和 auth headers 混在一起。
- Detail 中不展示 projection paths 等与当前 server 定义重复或低频的冗余信息。

Safety:

- Headers 中的敏感值必须遮罩或遵循现有安全展示规则。
- 不用空态卡片占位不存在的字段。

Examples:

- \`sse\` server 展示 \`Authorization\` header 和 \`REQUEST_TIMEOUT\` env；\`stdio\` server 只展示 env。

Tests:

- packages/web/test/mcp-preview.test.ts
- packages/web/test/mcp-view.test.tsx
