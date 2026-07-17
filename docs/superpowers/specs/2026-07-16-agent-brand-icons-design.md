# Agent 品牌图标设计

## 目标

将 Loom 中 `Claude Code`、`Codex`、`OpenCode` agent 的 `CC`、`CX`、`OC` 文字缩写替换为可离线使用的高清品牌图标，提升快速识别能力，同时保留现有 agent 三态行为。

## 设计

- 从可信的官方项目或品牌资源下载 SVG，并作为 Web 静态资产随 Loom 分发，不在运行时请求第三方资源。
- `AgentChip` 继续作为共享入口，按 `AgentId` 渲染对应图标；自定义 label、children 和 count 的现有用法保持不变。
- Agent 控件默认使用 26px 圆形容器和 14px 图标；Settings 的 Agents 控件使用 28px 容器和 16px 图标，便于在配置表单中识别和点击。
- `on` 使用品牌色图标和同色浅底；`off` 使用中性灰图标和透明或中性浅底；`mixed` 使用品牌色浅底，并继续显示现有计数。
- 可点击 agent 保留现有 `button` 和 `aria-pressed`，不依赖图标传达可访问名称。
- Agent tooltip 可以保留范围和状态描述，但不显示 `CC`、`CX`、`OC` 等文字缩写；其他操作按钮的 tooltip 不受影响。
- Agent 的 `aria-label` 使用 `Claude Code`、`Codex`、`OpenCode` 完整名称，并按需附加范围和状态。
- Skills、MCP、Memory、Vars 等所有 Agent 控件（包括 Vars 表格中的只读 slot）复用 `AgentChip` 并获得一致外观；不修改 agent 数据、投影逻辑或三态规则。
- 容器空间不足时允许按页面调整 tooltip 对齐方式；Memory 侧栏从 agent 左边缘向右展开，避免被侧栏裁剪。

## 资产约束

- SVG 必须有清晰来源，保持原始矢量轮廓，不使用低分辨率截图或 base64 内嵌位图。
- 资产保存在 `packages/web` 内，由 Vite 本地打包；页面离线可用。
- 不新增仅为三个图标服务的运行依赖。

## 验证

- 增补组件测试，确认每个 agent 渲染正确图标、完整可访问名称与三态属性，且 agent tooltip 不包含文字缩写。
- 运行相关 Web 测试与 `bun run format:check`。
- 启动 `bun dev`，使用命名 Playwright session 验证 `/skills`、`/vars`、`/memory`、`/settings` 的图标、tooltip 边界、桌面与窄屏布局及控制台错误。

## 非目标

- 不改变 agent 选择、批量应用或 projection 行为。
- 不重新设计 Skills 页面其他控件。
- 不修改 agent 名称或增加新的 agent。
