# MCP Workbench

MCP 页面用于管理仓库级 MCP server、target 应用和显式 Project changes。页面采用 workbench 布局，不使用新增/编辑 modal。

## 布局

桌面端为左右两栏：

- Page head 下方显示页面级全局 target bar，用于批量更新所有 server 的 desired targets。
- 左侧 inventory 固定宽度，包含 Add server、Project changes、搜索、transport filter 和 server rows。
- 右侧 detail/editor 固定卡片宽度，内容高度受 workbench 限制，超出后在卡片内部滚动。

窄屏下两栏纵向排列，inventory 与 detail/editor 都占满宽度。切换 preview target 只能影响内容高度，不应改变卡片宽度或造成 horizontal overflow。

## Inventory

Inventory 顶部的 Add server 与 Project changes 靠近 server 列表主操作区。全局 target chips 表示“应用到全部 server”，row target chips 表示单个 server 的 desired targets。

Target chip 使用 CC/CX/OC 短标签与品牌色状态区分：

- off：低对比边框与 muted 文本。
- mixed：半强调状态，仅用于全局 target chip。
- on：填充或高亮状态。

Row actions 使用有间距的图标按钮，edit 与 delete 不挤压 target chips。删除必须先确认。

## Detail

Detail header 显示 selected server、描述、transport 和全局 Preview as CC/CX/OC switch。Preview target 是只读上下文，用于 transport/env/headers/settings preview 的变量解析，不改变 targets。

字段展示规则：

- \`stdio\` 展示 command、args、env 和 settings preview，不显示 headers。
- \`sse\`/\`http\` 的 env 与 headers 分开展示。
- 不展示 projection paths 等和列表或 Project changes 冗余的信息。

\`\${var}\` token 使用可点击高亮样式，hover 时呈现可交互光标。点击后打开变量信息弹窗。

## Embedded editor

Create/Edit 在 workbench 右侧内嵌显示。表单只编辑 server definition，不显示 target/projection 控件。

- Create 保存时默认不应用到任何 target。
- Edit 保存时保留原 server targets。
- Cancel 与 Save server 使用圆角、分层按钮样式，并与表单内容保持足够间距。
- 表单下方展示 settings preview，随 draft 与 preview target 更新。

## Settings preview

Settings preview 以当前 preview target 展示 agent-native 写入形态：

- Claude Code：\`mcpServers\` JSON。
- Codex：\`mcp_servers\` TOML-like preview。
- OpenCode：\`mcp\` JSON。

Preview 需要展示变量解析后的值和诊断。缺失变量、默认值、JSON interpolation 等状态应在 preview 中可辨识。

## 变量信息弹窗

变量信息弹窗沿用 Vars modal 的视觉语言：暗色浮层、柔和边框、分区卡片、清晰关闭控件。Trace 使用 Base → Base/agent → Local → Local/agent → Runtime 语义，不显示 “MCP env” 这类消费位置作为变量来源。

## 状态

- Loading：保持 workbench 骨架稳定，避免布局跳动。
- Empty：在 inventory 中提示新增 server，并保留 Add server 主操作。
- Error：展示可恢复错误信息，不覆盖用户已输入 draft。
- Long text：路径、command、header value 和 preview code 应换行或内部滚动，不撑破页面。
