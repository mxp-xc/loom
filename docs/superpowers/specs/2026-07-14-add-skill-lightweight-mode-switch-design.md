# Add Skill 轻量模式切换

## 目标

保留单一添加入口和现有双栏 workbench，在配置栏顶部提供 `Local skill` 与 `Source` 模式切换。减少亮色主题中的嵌套边框和表面层级，不改变扫描、选择或导入行为。

## 设计

- Skills 页面使用 `Plus + 添加` 主按钮打开添加流程，通过 accessible name 明确“添加 Skill 或 Source”，避免 `Add skill` 的范围误导，并与相邻文字操作保持一致。
- 页面级投影操作保留“投影”文字，使用无彩色底的中性次级按钮；空闲态使用 `Send` 图标，执行中使用 `LoaderCircle`，与 Source 更新使用的 `RefreshCw` 区分。
- 删除 Skill 列表下方不承载交互的 agent 图例和 source 操作说明。
- 窄视口下页面标题与操作区上下排列，三个页面操作保持在同一行，不让单个操作孤立换行。
- 移除模式切换外层的边框、圆角和背景。
- 两个模式使用 lucide 图标、sans-serif 文本和底部状态线；激活项使用正文色与 2px emerald 状态线，未激活项使用 muted 色。
- hover 只改变文字与浅色背景，focus-visible 使用现有 ring token；不使用阴影或主色实心填充。
- 控件保持 `aria-pressed` 状态和按钮语义，切换后继续更新弹窗标题、配置表单、结果列表与提交动作。
- 窄视口允许模式标签等宽分布，不改变 workbench 的 Configuration / Skills 移动端 pane 切换。

## 范围

修改 Skills 页面动作、`AddSkillModal` 的模式切换标记及其局部 CSS。通用 `Segmented` 仍用于 branch / tag，不改变其他调用方。

## 验证

- 组件测试覆盖两个模式按钮的 pressed 状态与切换行为。
- 运行相关 Vitest 与格式检查。
- 使用 Playwright 验证亮色、暗色以及窄视口下的边框层级、可见状态、溢出和控制台错误。
