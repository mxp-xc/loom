# MCP Workbench 与 Server 编辑器重设计

## 目标

重新设计 MCP 管理页面的列表、详情、新增和编辑体验，使用户始终知道自己从哪一行进入、当前正在查看或修改哪个 server，并在不丢失数据边界的前提下完成完整 MCP server 配置。

设计需要满足以下结果：

- 默认使用亮色主题，并提供低眩光暗色主题。
- 桌面端保留完整列表上下文，通过右侧抽屉承载详情、新增和编辑；移动端使用全屏抽屉。
- 列表、详情、编辑器和写入预览共享正式组件与视觉语言，不创建一套仅用于原型的控件。
- GUI 与 JSON 源码可以无损往返，尤其不能再把 `args: string[]` 合并成单个字符串。
- Server 定义、desired targets 和显式 Project changes 仍是三个独立概念。
- 在 16 英寸 MacBook 常见 CSS 视口和 27 英寸宽屏上都保持可读、完整和紧凑。

相关业务规则：[MCP 规则](../../rules/mcp.md)。本设计受 R-MCP-001、R-MCP-002、R-MCP-003、R-MCP-004、R-MCP-005 与 R-MCP-007 约束。当前页面说明见 [MCP Workbench](../../ui/mcp.md)；本设计实现后，列表加抽屉布局将替代其中固定左右 workbench 的布局描述。

## 范围

本轮纳入：

- MCP 列表、搜索、transport filter、全局 targets、行 targets 和行操作。
- Server 详情抽屉，以及新增、编辑抽屉。
- `stdio`、`sse`、`http` 三种 transport 的完整 Server 编辑。
- Arguments、env、headers 的可视化编辑。
- 完整 Server JSON 源码编辑及其与 GUI 的双向同步。
- 详情和编辑共用的 agent-native 写入预览。
- 详情、新增和编辑中的 Tools 调试入口、连接状态、参数编辑和调用结果。
- 保存、删除、切换、关闭、校验失败和异步失败反馈。
- 亮色、暗色、桌面、窄屏、键盘和 reduced-motion 行为。

本轮不纳入：

- 修改 MCP manifest、projection 或 vars 的业务规则。
- 自动运行 projection。
- Shell 命令字符串解析或跨平台 shell quoting 推断。
- 新建通用表单框架、通用 JSON schema 平台或新的设计系统。
- 修改 Import 和 server 排序的既有业务规则；这些能力只适配新的列表布局。

## 信息架构

页面由三层组成：

1. 页面工具区：页面标题、Add server、Import、Project changes、全局 `Apply all` targets 和主题切换。
2. 列表工作区：搜索、transport filter、表头和完整 server 列表。
3. 右侧抽屉：根据入口显示 detail、create 或 edit，不替换列表路由，也不让内容突然出现在固定空白区域。

点击 server 行打开详情；点击行内编辑按钮直接打开编辑。点击 Add server 打开新增。抽屉打开期间来源行持续高亮，关闭后焦点返回触发入口。详情中的 Edit 复用同一抽屉层并从详情平滑扩展到编辑宽度，不先关闭再重新出现。

详情、新增和编辑的抽屉主体顶部统一使用“配置 / Tools”两个 tabs。默认进入配置，Tools 是需要用户主动进入的次级路径；它不进入列表操作列，也不占用固定 header 的主操作位置。

URL 应表达当前状态，使刷新和浏览器前进/后退可恢复 detail、create 或 edit。具体 query 或子路由形式由现有路由约定决定，但必须保证一次历史返回只关闭当前抽屉层，不离开 MCP 页面。

## 响应式布局

列表工具区与表格主体在宽屏上使用约 `1120px` 的最大内容宽度并水平居中，避免 27 英寸显示器上 Server 列无限拉长。表格采用受控列宽：Server 列吸收剩余空间但有上限，Targets 与操作列保持稳定宽度；Server 标题与内容之间不出现大段无意义留白。

抽屉使用右侧固定层：

- Detail 宽度约 `620px`。
- Create/Edit 宽度使用 `clamp(760px, 58vw, 880px)`。
- 在 `1512 x 982` 和 `1440 x 900` CSS 视口中，编辑抽屉必须完整显示 header、可滚动主体和 footer，列表仍保留可识别上下文。
- 视口不足以同时提供可用列表宽度和至少 `760px` 编辑宽度时，编辑抽屉改为全屏；detail 可先使用较宽 overlay，再在移动断点改为全屏。
- 移动端抽屉使用 `100dvh`，考虑 safe area，不产生页面级横向滚动。

抽屉 header 与 footer 固定在抽屉内部，只有主体纵向滚动。Preview 和 Monaco 可以有自己的内容滚动，但页面不得形成两个竞争的纵向主滚动区。长 command、argument、路径、key/value 和代码使用换行、截断提示或内部滚动，不能撑破抽屉。

抽屉打开、detail 扩展为 editor、editor 收回 detail 和关闭使用 `220-260ms` 的空间连续过渡。动画只使用 transform、opacity 等不会造成布局抖动的属性；`prefers-reduced-motion` 下取消位移动画并保留即时状态反馈。

## 列表

表头固定高度，所有标题在各自网格单元内水平和垂直居中。Targets 与操作列的行内容同样水平、垂直居中，并与表头精确对齐。Server 行主体仍按阅读顺序左对齐。

每行至少显示：

- Server 列最左侧的 `GripVertical` 排序把手。
- Server id 和一行辅助信息。
- `stdio`、`sse` 或 `http` transport 标签。
- CC、CX、OC target chips。
- Edit 与 Delete 图标按钮。

行操作不显示右箭头。整行负责进入详情，Edit 和 Delete 使用独立按钮并阻止行点击。Delete 必须先打开确认 dialog，确认文本包含 server id；删除 pending 时禁用重复操作，成功后关闭相关抽屉并显示完成反馈，失败时保留行和抽屉状态。

搜索或 transport filter 生效时继续遵守 R-MCP-007，禁用排序。Loading 使用稳定骨架，不改变列宽；Empty 保留 Add server；Error 在列表区域提供可重试入口，不覆盖页面级操作。

排序使用显式把手，不把整行作为拖拽激活区，避免与“点击整行进入详情”冲突。把手支持鼠标移动阈值、触摸长按和键盘排序，并提供“调整 `<server id>` 顺序”的可访问名称。视觉把手保持克制，但桌面和移动端命中区不小于 `40 x 40px`。

拖动时原位置降低透明度，DragOverlay 保持原行宽、圆角和阴影；放置后先乐观更新列表，再持久化完整 server id 顺序。成功显示“Server 顺序已保存”；失败恢复服务端顺序并显示可重试错误。排序不修改 server 定义或 targets，也不触发 Project changes。搜索或 transport filter 生效时把手进入 disabled 状态，tooltip 说明“清除搜索和筛选后可排序”。

## Targets

页面级 `Apply all`、server row 和配置视图切换全部复用正式 `TargetChip` 及其 CC/CX/OC 品牌色。视觉 chip 固定为 `26 x 26px`，支持 `on`、`off` 和全局 `mixed` 状态；可交互场景通过外层命中区满足桌面和触摸可用性，不放大视觉 chip。

Targets 表达 desired state，而不是 projection 状态：

- 点击 row 或全局 chip 只更新 desired targets。
- Preview target 只切换解析上下文和输出格式。
- Project changes 是唯一触发 MCP projection 的页面操作。

Targets 只在列表行和页面级 `Apply all` 中配置。Detail、Editor 和 Server JSON 不提供 targets 编辑；保存定义时必须保留当前 targets，不能因编辑其他字段重写 desired state。Create 保存后初始 targets 为 `[]`，且不自动 Project changes。

## 抽屉状态与反馈

Detail header 显示 server id、transport、状态标签和 Preview as 控件。Editor header 显示 Create server 或 Edit server、server id、dirty 状态和来源上下文；说明文字保持单行或短句，不堆叠多层 eyebrow、标题和描述。

用户触发动作后必须在 `100ms` 内获得可见反馈：按钮 pressed 状态、来源行高亮或抽屉开始移动。保存时 footer 主按钮进入 pending 并禁用重复提交；成功后保留当前 server 上下文，显示明确完成反馈并刷新列表；失败时保留 draft、滚动位置和当前 tab，在对应字段或 footer 显示可恢复错误。

有未保存修改时，关闭抽屉、切换 server、浏览器返回或刷新必须确认。纯 detail 状态可直接关闭。新增成功后进入新 server 的 detail；编辑成功后回到同一 server 的 detail，不让用户失去列表位置。

编辑或新增页面进入 Tools 后，如果当前字段与已保存定义不同，主动作显示“保存并连接”。它先执行与 Save server 相同的校验和持久化，成功后再创建调试连接；保存失败时不尝试连接。已连接时修改任意连接字段会立即断开 session 并回到未连接状态，不显示 draft 或 stale 调试概念。

如果定义 mutation 成功而显式 target mutation 失败，界面必须报告部分成功，重新读取 server，并仅保留未完成的 target dirty state；不得回报“全部保存成功”。

## Server 数据模型

GUI 与源码共享一个经过 schema 校验的 `McpServer` draft，不维护两套业务数据。完整形态为：

```ts
interface McpServerDraft {
  id: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}
```

该结构只描述 Editor 可修改的 Server 定义。Targets 由列表单独管理，不进入 GUI/JSON 双向编辑模型；编辑既有 Server 时，提交定义必须保留其当前 targets。

`stdio` 的主要连接字段是 `command` 与 `args`；`sse`、`http` 的主要连接字段是 `url`。env 对三种 transport 均可用；headers 只在 remote transport 的 GUI、detail 和 Preview 中展示。切换 transport 时，不得静默删除暂时不适用的 draft 字段；如果被隐藏字段已有内容，transport 控件附近显示“已保留但当前不会写入”的状态，并允许用户通过切回原 transport 或 JSON 源码处理。

保存前使用与服务端契约一致的 schema 校验字段类型、required 字段、重复 key 和 target 枚举。可选空集合统一序列化策略，避免 GUI/JSON 每次切换制造无意义 dirty state。

## Arguments 可视化编辑

Arguments 的权威模型是 `string[]`。GUI 使用数组行编辑器，不把多个参数合并到一个输入框：

- 每行显示稳定序号、完整宽度输入、拖拽手柄和删除按钮。
- Add argument 在末尾增加一项，新增项立即获得焦点。
- 支持指针、触摸和键盘排序；排序改变数组顺序，因为参数顺序属于命令语义。
- 单个参数可以很长，输入区域独占整行并支持水平滚动或适当换行。
- 空字符串是合法参数，不因输入为空自动删除；删除必须由用户显式执行。

向单行粘贴包含换行符的文本时，将其作为批量录入：先把 CRLF 规范为 LF，再按 `\n` 拆分为多个数组项，并从当前行开始替换/插入。保留内部空行对应的空字符串参数；仅忽略由文本末尾单个换行产生的最后一个空分段。粘贴完成后提供一次可撤销反馈。

不提供“把所有参数写成一个 shell 字符串”的主编辑模式。该形式无法在 Windows、POSIX shell 和不同 quoting 规则之间保证无损往返。多行文本也不成为第三套持久状态；批量粘贴只是把文本转换为 `string[]`。需要精确批量编辑时使用完整 Server JSON。

## Env 与 Headers 可视化编辑

env 和 headers 使用一致的 key/value 行编辑器：

- 每行包含 key、可扩展 value、删除和排序控制。
- value 保持原始字符串，支持长文本和 `${var}` token。
- 空 value 合法；空 key 和重复 key 阻止保存，并在具体行显示错误。
- 新增行后焦点进入 key；键盘可完成新增、移动和删除。
- Secret header 的展示和详情预览继续遵守现有遮罩规则。

env 与 headers 的对象语义不依赖行顺序；GUI 可以保留用户当前行序以获得稳定编辑体验，但持久化与 dirty 判断不能把对象 key 顺序当作业务变化。

## GUI 与 JSON 双向同步

Editor 顶部使用“可视化 / JSON”分段控件。JSON 使用现有 `MonacoTextEditor`，`language="json"`，字号不低于 `14px`，显示完整 Server 对象而不是只编辑 arguments。

同步规则：

1. 打开 editor 时，从当前 Server 或 create 默认值生成 canonical draft 和格式化 JSON。
2. GUI 每次有效修改都更新 canonical draft，并重新生成 JSON 文本。
3. JSON 输入先更新独立的 source text；解析和 schema 校验都成功后，立即替换 canonical draft，GUI 随之更新。
4. JSON 语法或 schema 非法时保留用户 source text，显示 Monaco marker 与就近错误摘要，canonical draft 保持最近一次合法值，保存按钮禁用。
5. 非法 JSON 状态下仍可切换到 GUI 查看最近一次合法数据，但 GUI 为只读，并明确标注“JSON 尚未生效”。用户必须修复 JSON，或显式选择“丢弃无效 JSON”后才能继续用 GUI 编辑。
6. “丢弃无效 JSON”重新以最近一次合法 draft 生成源码，不得在无确认的切换中覆盖用户文本。

JSON 顶层必须是单个 Server object。未知字段视为 schema 错误，避免 GUI 无法展示却在下一次序列化时静默丢失。数组顺序、字符串内容和空字符串参数必须无损保留；对象 key 顺序不构成产品契约。

视图切换本身不保存、不修改 targets、不改变 Preview target，也不清除 dirty state。`Ctrl/Cmd+S` 在 JSON 合法且表单可提交时触发与 Save server 相同的动作。

## Detail 与写入预览

Detail 和 Editor 复用同一个 Server Preview 组件，Preview 默认展开。它使用当前 persisted server 或合法 draft，并根据 Preview as 的 CC、CX、OC 只读上下文实时生成 agent-native 形态：

- Claude Code：`mcpServers` JSON。
- Codex：`mcp_servers` TOML-like。
- OpenCode：`mcp` JSON。

Preview target 使用统一 `TargetChip`，切换只影响变量解析和输出格式。代码区复用正式 MCP 的 JSON/TOML syntax highlight，不使用单色 `<pre>`。key、string、number、literal、punctuation、section 和 `${var}` token 均有可辨识但不过饱和的语义色。

Preview 保留变量 resolved value、默认值、缺失变量、JSON interpolation 等诊断。`${var}` token 可打开 Vars 视觉语言一致的信息层，trace 与遮罩遵守 R-MCP-004。Preview loading 保持代码区尺寸；生成失败显示可恢复错误，不清空 draft。

Detail 按 R-MCP-005 只显示当前 transport 有意义的字段，不用空卡片占位。`stdio` 显示 command、args、env 和 Preview；`sse`、`http` 显示 url，并将 env、headers 分为独立区域。

## Tools 调试

Tools 是详情、新增和编辑抽屉中的次级 tab，默认不打开。它不出现在列表操作列或固定 header 中，避免把低频诊断动作提升为 MCP 管理主路径。Detail 与 Editor 使用相同的调试工作区和状态语言。

调试只连接已保存的 Server，不建立或展示 draft session：

- Detail 直接使用当前 persisted Server 创建 session。
- Edit 有未保存变化时使用“保存并连接”，先保存当前定义，成功后连接刚保存的 Server。
- Create 使用“创建并连接”，先创建 Server，成功后连接新 Server。
- 保存失败、字段校验失败或 JSON 非法时阻止连接，并把错误放在对应字段或 Tools 顶部。
- 已连接后修改 command、args、url、env、headers 或 transport，立即断开旧 session 并恢复未连接状态。

Tools 使用固定 header 中当前选择的 CC、CX 或 OC 作为变量解析与运行环境。`RAW` 只表示未解析定义，不能用于真实连接；选择 RAW 时连接按钮禁用，并显示“选择 Agent 后连接”，不得静默切换到默认 Agent。

连接成功后，调试工作区显示：连接状态与断开动作、Tools 数量和可选列表、当前 tool 描述、根据 `inputSchema` 生成的 JSON 参数、重置参数、调用动作、耗时和格式化结果。参数继续复用 `MonacoTextEditor`；非法 JSON 不发送请求，并在编辑器附近显示错误。Tool 调用属于显式真实动作，不自动重试、不在 tab 切换时自动执行。

桌面抽屉中 Tools 列表与参数/结果使用双栏；移动端按 Tools、参数、结果顺序折为单栏。列表和结果区可以内部滚动，但不得形成与抽屉主体竞争的第二个页面级纵向滚动。

## 视觉与组件规范

整体继续使用 Skills、Memory 与正式 MCP 页面的 token、圆角、边框、阴影和 Lucide icon，不引入原型专属设计系统。默认亮色；暗色与亮色共同设计，不用纯黑背景、纯白大面积正文或高饱和霓虹色。

视觉层级以中性 Zinc 表面为基础，emerald 保留主操作和成功语义。基本信息、连接、变量、Preview 可以分别使用克制的绿色、青色、琥珀色、紫色标签或左侧强调线；颜色只帮助扫描，不单独承担状态含义，也不铺满整张页面。

字体沿用应用现有字体栈，解决字号与密度问题而不引入新字体依赖：

- 页面标题 `20-24px`，抽屉标题 `18-20px`。
- 正文和表单输入不低于 `14px`，主要输入建议 `15-16px`。
- 辅助标签不低于 `12px`，只用于短标签和元数据。
- Monaco 与 Preview code 不低于 `13.5-14px`，行高约 `22px`。
- 不使用负 letter-spacing，也不随 viewport 连续缩放字号。

表单分区使用留白、细分隔线和小型语义标签建立层级，不把每个 section 包成浮动 card，也不嵌套 card。每个屏幕只保留一个明确主操作。

## 校验、错误与脏状态

字段错误显示在对应控件附近，并在抽屉 header 或 footer 提供简短错误总数；点击摘要可聚焦第一个错误。错误不能只依靠红色，需要文本或 icon。Server id 冲突、API validation 和持久化失败使用服务端返回的可行动信息，不暴露堆栈或敏感响应体。

Dirty state 分为 definition dirty 和 invalid source。二者在 UI 上可以汇总显示，但提交逻辑保持可区分。配置视图、Tools tab、列表搜索和主题切换不属于 Server dirty state。

异步失败必须记录完整错误对象并保留用户输入。重试只重试未完成 mutation；刷新 persisted state 后再合并仍有效的 draft，不能用旧响应覆盖较新的用户修改。

## 可访问性

- 抽屉使用合适的 dialog/complementary 语义、可访问名称和可预测焦点顺序。
- 打开后焦点进入标题或首个可操作字段；关闭后返回来源按钮或行。
- `Escape` 关闭无 dirty 抽屉；有 dirty 时进入确认流程。确认 dialog 不与抽屉形成失控的双重 focus trap。
- 所有 icon-only 按钮提供 `aria-label` 和 tooltip；状态不只依赖颜色。
- TargetChip、transport 分段控件、Arguments 排序和 JSON/GUI 切换均可通过键盘完成。
- 拖拽提供上移/下移键盘替代和 screen reader 状态通知。
- 正文对比度至少 `4.5:1`，边界和焦点状态在亮暗主题均可辨识。

## 实现边界

实现应优先提取并复用以下职责，而不是继续扩大单个 MCP view：

- Workbench list：筛选、行选择、来源行高亮和列表操作。
- Drawer shell：detail/editor 尺寸、动画、焦点、滚动和 dirty close guard。
- Server draft controller：canonical draft、dirty 分类、JSON parse/schema 和提交协调。
- Arguments editor 与 record editor：只负责结构化字段编辑。
- Server Preview：目标切换、格式化、syntax highlight 和变量诊断。
- Tools Debug：持久化前置条件、session 生命周期、tool 选择、参数与结果。

这些边界不要求为一次调用创建包装组件；只有在职责被 detail、create、edit 或其他页面重复使用时才提取。生产代码不得依赖 prototype/archive 目录，原型中的 fixture 和状态切换控件不进入正式页面。

## 测试与自动验证

领域与组件测试至少覆盖：

- `args` 数组在 server → GUI → JSON → GUI → submit 往返后边界和顺序不变。
- 多行粘贴、CRLF、内部空行、末尾换行、空字符串参数和拖拽排序。
- env/headers 空 value、空 key、重复 key、长 value 和 `${var}`。
- GUI 修改后 JSON 更新；合法 JSON 反向更新 GUI；非法 JSON 保留文本、锁定 GUI 编辑并禁止保存；显式丢弃恢复。
- transport 切换保留隐藏字段，detail/Preview 只展示适用字段。
- Create 默认空 targets；Edit 保留 targets；显式 target 变化独立保存且不触发 projection。
- definition 成功而 target 失败的部分成功反馈与重试。
- 抽屉 dirty close guard、焦点返回、Escape、浏览器历史和删除确认。
- Preview 默认展开、CC/CX/OC 格式、syntax highlight、变量诊断和 target 只读语义。
- Detail 直接连接已保存 Server；Edit/Create 先保存再连接；保存失败不创建 session。
- RAW 禁用 Tools 连接；CC/CX/OC 使用对应变量解析环境。
- Tools schema 参数生成、非法 JSON 阻止调用、结果与耗时展示、断开、字段变化自动断开。
- 搜索/filter 下排序禁用，宽屏列表列宽受控。
- 排序把手的鼠标拖放、触摸长按、键盘移动、成功反馈和失败回滚。

实现完成后启动项目自己的 `bun dev`，使用带独立 session 的 `playwright-cli` 自动验证：

- `1512 x 982`：16 英寸 MacBook 常见视口，detail、create、edit、长 Arguments 和展开 Preview 完整可用。
- `1440 x 900`：header/footer 可见，主体滚动，列表上下文仍可识别。
- `1280 x 800`：正确进入 overlay/full-screen 策略，无横向溢出。
- `390 x 844`：全屏抽屉、safe area、触摸命中区和键盘弹出后的表单可用性。
- 每个视口验证亮色和低眩光暗色、无重叠、无文本溢出、无意外 layout shift，并检查控制台错误。

## 验收标准

- 用户从列表点击行、Edit 或 Add server 后，入口、来源 server 和抽屉状态始终明确，没有右侧内容突然出现的感受。
- 所有表头水平、垂直居中；Targets 与操作列内容居中并与表头对齐；27 英寸宽屏上的列表不被无限拉长。
- Server 列的显式把手可完成鼠标、触摸和键盘排序；行点击仍只进入详情，搜索或筛选时不会误写全局顺序。
- TargetChip 在页面级、列表、详情、编辑和 Preview 中尺寸、颜色、状态和交互一致。
- 16 英寸 MacBook 视口可同时识别列表上下文并完整操作编辑器，抽屉 header/footer 不被裁切。
- Command 独占一行，Arguments 可编辑任意长度和数量，并以 `string[]` 无损保存。
- 完整 Server 可在 GUI 与 JSON 间双向编辑；非法 JSON 不丢文本、不污染 GUI、不允许保存。
- env、headers、targets 和 transport 专属字段遵守数据模型与业务规则，没有静默删除或意外覆盖。
- 详情和编辑的 Preview 默认展开，使用正式语法高亮和统一 target controls。
- 详情、新增和编辑都能从次级 Tools tab 进入调试；编辑和新增通过保存/创建并连接调试已持久化定义。
- 保存、删除、切换、错误、部分成功和未保存关闭都有明确反馈。
- 默认亮色；暗色不使用纯黑白高对比表面，并与 Skills、Memory 的整体视觉语言一致。
- 自动化测试和指定 Playwright 视口验证通过，生产代码不依赖原型目录。
