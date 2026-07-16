# 组件规范

本文件记录当前共享组件的语义、状态与可访问性契约。样式使用 [设计系统](design-system.md) token；页面不复制组件内部的颜色和交互状态。

## 按钮

`Button` 使用 cva variants，当前提供四种语义变体：

### 变体

| 变体          | 样式                                                                                         | 用途                 |
| ------------- | -------------------------------------------------------------------------------------------- | -------------------- |
| `primary`     | `background: var(--primary); color: var(--primary-fg)`，hover 上移 1px 并增加微辉光          | 每个区域唯一的主动作 |
| `secondary`   | `background: var(--card); border: 1px solid var(--border)`,hover `background: var(--accent)` | 支撑动作             |
| `ghost`       | 透明底,hover `background: var(--accent)`,文字色变亮                                          | 低优先级动作         |
| `destructive` | `background: var(--error); color: #fff`，hover 降低 opacity                                  | 确认破坏性操作       |

### 尺寸

| 尺寸    | 高度 | 用途                 |
| ------- | ---- | -------------------- |
| default | 36px | 常规                 |
| sm      | 32px | 紧凑布局             |
| xs      | 28px | 工具栏               |
| lg      | 40px | 需要更大触区的主动作 |

### 交互

- Primary hover 使用 `translateY(-1px)`；其他变体只改变表面或文字色，避免所有按钮都跳动。
- 过渡使用 `var(--dur) var(--ease)`。
- focus-visible 使用基于 `var(--ring)` 的 2px ring。

### Disabled

`opacity: 0.5; pointer-events: none`（见设计系统·Disabled）。

## Icon action button / Tooltip

Utility、toolbar、row action 默认使用 `IconButton`：只显示 lucide 图标，通过 `label` 提供 accessible name，并在 hover/focus-visible 时把 tooltip 挂到 `document.body`，避免被滚动容器裁切。

- 主 CTA、表单提交、确认删除、冲突解决等高语义动作保留文字按钮。
- 图标按钮默认 28px dense 尺寸,需要更大的工具栏触区时用 32px。
- 必须提供明确 `label`,不要只依赖 `title` 或图标本身。
- 危险/警告/成功状态使用 `tone="danger" | "warning" | "success"`,不在调用处散写颜色。
- pressed/selected 状态用 `aria-pressed`,tooltip 文案描述动作或状态,例如 “编辑”、“删除”、“部分已选择”。

### 投影动作

- 空闲态统一使用 lucide `Send`,执行中切换为旋转的 `LoaderCircle`;不要与检查更新共用 `RefreshCw`。
- 页面头部使用带“投影”文字的 `secondary` 按钮;紧凑工具栏可使用带明确 accessible name 和 tooltip 的 `IconButton`。
- 使用中性 `secondary` 表面,不添加主色背景、彩色边框或发光效果;投影不是成功状态,执行结果由 toast 或错误反馈表达。

## 卡片与面板

需要边界的卡片/面板使用 `var(--card)`、`1px solid var(--border)` 和 `var(--radius-card)`。只有整个表面可交互时才使用 `--shadow-card-hover`；普通页面 section 不应为了分组而层层套卡片。

## Target chip

`TargetChip` 用于 Claude Code、Codex、OpenCode target，也可承载 `default` 等非 agent scope。Agent chip 使用 26px 圆形轮廓和品牌 mask icon；完整名称来自 `aria-label`/tooltip，不能只靠颜色或缩写识别。

| 状态    | 语义与样式                                                             |
| ------- | ---------------------------------------------------------------------- |
| `on`    | agent 色图标 + 轻度 agent 色表面，表示当前 item/scope 已选择           |
| `off`   | 中性低对比表面，表示未选择                                             |
| `mixed` | agent 色文字、淡色表面和边框，表示 bulk scope 仅部分选择；可附 `count` |

交互 chip 使用原生 `button`，以 `aria-pressed=true/false/mixed` 暴露状态；只读 chip 渲染为 `span`。需要避免 row click 时使用 `stopPropagation`，而不是在父组件依赖 DOM 文本判断。

## Toast

浮动通知,用于不阻断当前页面的操作反馈。成功与错误使用同一全局宿主和队列，不允许在调用处自行定位 Toast。

| 属性     | 值                                                                                    |
| -------- | ------------------------------------------------------------------------------------- |
| 定位     | `position: fixed`，top-right                                                          |
| 背景     | `color-mix(in srgb, var(--popover) 92%, transparent)` + `backdrop-filter: blur(12px)` |
| 边框     | `1px solid var(--border)`                                                             |
| 圆角     | `var(--radius-card)`                                                                  |
| 阴影     | popover 层级(见设计系统·阴影)                                                         |
| 自动消失 | 成功 3s；无操作的错误使用更长停留时间                                                 |
| hover    | 暂停自动消失                                                                          |

成功反馈使用 `var(--primary)` 和对勾图标。错误反馈使用 `var(--error)` 和错误图标，同时显示简短标题与解决建议，不只依赖颜色表达状态。

错误 Toast 可包含一个明确的恢复操作和默认折叠的技术详情。存在恢复操作时不自动关闭；相同错误短时间内合并计数，不连续堆叠。Toast 不抢占当前焦点，关闭、展开和恢复控件必须支持键盘操作。

## Modal

全屏遮罩 + 居中卡片。

| 属性 | 值                                                     |
| ---- | ------------------------------------------------------ |
| 遮罩 | `rgba(0,0,0,0.6)` + `backdrop-filter: blur(4px)`       |
| 卡片 | `background: var(--popover)`,圆角 `var(--radius-card)` |
| 阴影 | popover 层级                                           |
| 关闭 | 点击遮罩或 Esc                                         |

错误 Modal 只用于当前流程无法继续或需要用户作出决定的场景。普通保存、刷新、复制或后台请求失败使用错误 Toast，不得为了突出错误而升级为 Modal。Modal 管理初始焦点、焦点循环和关闭后的焦点返回；`busy` 时阻止 Esc、遮罩和关闭按钮中断操作。

## 错误反馈

错误按影响范围使用以下组件，不得直接把未知 `error`、`error.message`、响应体或堆栈插入 JSX：

| 组件          | 使用场景                                     |
| ------------- | -------------------------------------------- |
| `FieldError`  | 用户可通过修改当前字段解决的校验问题         |
| `ErrorToast`  | 不阻断页面，可重试或可继续其他操作的失败     |
| `ErrorDialog` | 当前流程无法继续或需要用户决策的阻断错误     |
| `ErrorState`  | 页面、列表或局部工具因加载失败而无法提供内容 |

主文案使用中文说明发生了什么以及下一步，必要技术名词保留原文。错误码、原始消息和诊断信息仅进入默认折叠且经过脱敏的技术详情；密钥、token、秘密变量值和认证头不得显示。错误处理节点仍需记录完整错误对象。

字段错误通过 `aria-describedby` 关联控件并在修正后清除。错误 Toast 使用 live region 且不抢焦点。错误 Dialog 提供可访问名称、描述及完整键盘操作。ErrorState 在具备恢复能力时提供明确的“重试”操作，恢复成功后回到正常内容。

## 输入框

| 属性  | 值                                      |
| ----- | --------------------------------------- |
| 高度  | 36px (default), 32px (sm)               |
| 圆角  | `var(--radius)`                         |
| 边框  | `1px solid var(--border)`               |
| focus | `border-color: var(--primary)`,无外发光 |

Disabled: 见设计系统·Disabled。

同一表单中的普通输入、搜索和扫描字段应复用同一控件契约，不混用旧内联样式。字段标签使用正常大小写和 semibold；大写仅用于 section kicker。

复合输入框由外层表达圆角与焦点态，内部 `input:focus` 必须显式清除 `border`、`outline` 和 `box-shadow`，避免全局输入样式重新产生方形光圈。

搜索框仅在快捷键真实可用时显示快捷键提示。

## Tabs

基于 Radix Tabs。

| 元素                       | 样式                                                      |
| -------------------------- | --------------------------------------------------------- |
| TabsList                   | `background: var(--card)`,圆角 `var(--radius)`,内边距 4px |
| TabsTrigger(激活)          | `background: var(--bg)`                                   |
| TabsTrigger(未激活)        | 透明,`color: var(--muted)`                                |
| TabsTrigger(hover)         | `color: var(--text)`                                      |
| TabsTrigger(focus-visible) | `box-shadow: 0 0 0 2px var(--ring)` 25% 透明              |
| TabsTrigger(disabled)      | 见设计系统·Disabled                                       |

## 状态点 (status dot)

| 状态   | 颜色            | 动效                                        |
| ------ | --------------- | ------------------------------------------- |
| 活跃   | `var(--signal)` | `box-shadow: 0 0 6px` 微辉光                |
| 同步中 | `var(--warn)`   | `@keyframes pulse` 2s 呼吸(见设计系统·动效) |
| 未激活 | `var(--muted)`  | opacity 0.45                                |

## 状态栏 (statusline)

顶部栏,高度 32px。

| 属性   | 值                                      |
| ------ | --------------------------------------- |
| 背景   | `var(--bg)`                             |
| 底边框 | `1px solid var(--border)`               |
| 字号   | 11px                                    |
| 文字色 | `var(--muted)`,品牌名用 `var(--signal)` |

## 侧边栏 (sidebar)

桌面侧边栏默认 176px，可在 176px 到 `min(360px, 30vw)` 间拖拽或用键盘调整，并可收起为 64px。宽度与收起状态分别保存在 `loom-sidebar-width`、`loom-sidebar-collapsed`；窄屏切换为顶部可换行导航，不应用桌面收起状态。

| 属性   | 值                        |
| ------ | ------------------------- |
| 背景   | `var(--card)`             |
| 右边框 | `1px solid var(--border)` |

### 导航项 (nav-item)

| 状态   | 样式                                                            |
| ------ | --------------------------------------------------------------- |
| 默认   | `color: var(--muted)`，圆角 6px                                 |
| active | `color: var(--bright)`，emerald 淡色表面和左侧 2px inset signal |
| hover  | `color: var(--text)`，中性 hover surface                        |

分组标签(nav-section)使用 10px 大写 muted 文本。收起时隐藏标签与 nav 文本，但保留图标按钮的 accessible name 和 `title`。
