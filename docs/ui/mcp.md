# MCP Workbench

MCP 页面管理仓库级 MCP server 定义、desired agents 和显式 Project changes。定义保存不自动投影配置，也不改写现有 agents；完整业务契约见 [MCP 规则](../rules/mcp.md)。

## 页面结构

页面主体由 server inventory 和右侧抽屉组成。抽屉状态写入 URL：

- `?view=detail&server=<id>`：查看已保存 Server。
- `?view=edit&server=<id>`：编辑已保存 Server。
- `?view=create`：创建 Server。

Detail 抽屉宽度为 `680–740px`，Edit/Create 为 `760–880px`。抽屉挂载时从右侧滑入；窄屏下全屏显示。抽屉 header 和 Editor footer 固定，正文独立滚动；`配置 / Tools` tabs 固定在正文顶部。所有视口不得产生页面级横向滚动。

## Inventory

页面 header 的动作从左到右为 Add server、Project changes。Inventory header 使用两层布局：第一层显示“所有 Servers”、数量和列表操作，第二层显示 Apply all agents；列表不提供 transport filter。列表使用 `Server / Agents / 操作` 三列，表头和内容水平、垂直对齐。每行使用等宽字体展示 Server ID 和连接摘要，并展示 transport 色点、transport 标签、Applicable agents 的 desired agent chips、编辑和删除操作。Agent chip 使用品牌图标，并通过完整名称、pressed state 和 tooltip 表达含义。

- 点击行进入 Detail；键盘可使用 Enter 或 Space 打开。
- `GripVertical` 是唯一排序把手，支持鼠标、触摸和键盘排序。
- 搜索生效时禁用排序。
- 排序使用乐观更新；保存期间锁定，失败时恢复服务端顺序。
- 行 agent chips 只更新单个 Server；Apply all 只批量更新 desired agents。
- 删除必须确认，且不会自动运行 Project changes。

Import dialog 扫描 Applicable MCP agents 的原生配置并展示来源、最终 ID、agents、改名状态、ignored fields 和 disabled 原因。默认选中可导入项，不选 unchanged 项；stale preview 必须重新扫描后才能 apply。

## Detail

Detail header 显示 Server ID、transport、配置视图和常用操作。配置与 Tools tabs 使用图标、明确的 active surface 和 pointer cursor。配置视图包括：

- `RAW`：保留 `${...}` 变量引用。
- `Default`：按 Base → Local 解析，展示解析后的 Loom Server 定义。
- Applicable MCP agent 视图：按对应 agent 的真实变量矩阵解析 connection、env、headers 和写入配置。

配置定义按 Connection、Environment 和 Headers 分组。`stdio` 展示 command 与 arguments；`sse`/`http` 展示 endpoint URL。写入预览默认展开，header 与正文使用独立 surface 和分隔边框，并按目标格式显示 JSON 或 TOML 高亮。

RAW 中的变量 token 可打开 Variable Inspector，查看 mask 后的值、来源和 trace。已解析视图只显示解析结果，不再渲染变量按钮。

## Editor

Editor 只编辑完整 Server 定义，不包含 agents。Edit 保存时保留 persisted agents，Create 默认不应用到任何 agent。

- Command 独占一行。
- Arguments 的权威值为 `string[]`，使用独立拖拽把手排序，不显示冗余上下箭头，并支持增删、多行粘贴、空字符串和保留空格。
- Environment 与 Headers 使用边框和 active surface 明确的 Key/value、raw text segmented control；Key/value 模式显示 KEY/VALUE 列标题、字段图标和带文字的新增操作，多行模式使用 Monaco。
- 空 value 合法；空 key 或重复 key 就地报错并禁用保存。
- Visual 与 JSON 使用带图标的 segmented control，并双向同步完整定义。
- 非法 JSON 保留原始文本、锁定 Visual 和 Tools，并禁用保存。
- 配置视图只改变 Preview；编辑字段始终保留原始 `${...}`。

保存状态、错误和 partial success 在固定 footer 中反馈，不通过临时草稿概念表达。

## Tools

Tools 是 Detail、Edit 和 Create 中的次级路径，只调试已持久化 Server。

- Detail 直接连接当前已保存 Server。
- Edit 使用“保存并连接”，Create 使用“创建并连接”。持久化失败时不创建 session。
- 保存成功后保持当前 Editor/Tools，不自动跳回 Detail。
- 从 RAW 进入 Tools 时自动切换到 Default；Default 使用 Base -> Local，agent 视图使用对应 agent 解析环境。
- 修改连接字段或离开 Tools 后立即 disconnect。
- 连接请求期间切换解析环境、修改连接或离开 Tools 会使请求失效；迟到的 session 会立即断开。
- Web 只发送 `source: 'saved'`。

连接后显示 tools 列表、JSON Schema 参数编辑器、reset、call、duration、result、parse error 和 session expiry。Tools 列表支持按名称和描述进行多关键词搜索，筛选不改变当前工具、参数或调用结果。桌面工作区填满抽屉剩余高度，列表、参数和结果在各自区域内滚动；窄屏恢复单列自然内容流。

## 弹窗与状态

Delete、dirty-close、Variable Inspector 和 Import 使用统一 scrim、surface、边框、圆角、字号和按钮层级。Toast、loading、saving、connecting、calling、empty、invalid JSON 和错误状态应保持稳定布局。

默认使用亮色主题；暗色主题降低背景和高亮对比度，避免高亮区域刺眼。长 command、arguments、URL、header value 和 preview code 必须换行或在局部滚动，不得撑破抽屉。
