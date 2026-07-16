# 设计系统

全局 token 的权威实现位于 `packages/web/src/styles/global/tokens.css`。页面和组件消费这些语义变量，不复制 light/dark 原始色值。

## 色彩

`:root` 定义浅色主题，`[data-theme='dark']` 只覆盖需要变化的 token。

### Dark mode

| 变量           | 值                       | 用途                        |
| -------------- | ------------------------ | --------------------------- |
| `--bg`         | `#0a0a0b`                | 页面背景(近中性黑)          |
| `--card`       | `#131316`                | 卡片表面                    |
| `--popover`    | `#1a1a1e`                | 浮层(modal、dropdown)       |
| `--border`     | `rgba(255,255,255,0.08)` | 边框(白色 8% 透明)          |
| `--text`       | `#e4e4e7`                | 正文                        |
| `--bright`     | `#fafafa`                | 高亮文字(标题)              |
| `--muted`      | `#71717a`                | 次要文字                    |
| `--m2`         | `#8b8b94`                | 次要图标与辅助控件          |
| `--primary`    | `#10b981`                | 主色(emerald-500)           |
| `--primary-fg` | `#052e1b`                | 主色上的文字                |
| `--accent`     | `rgba(16,185,129,0.08)`  | 主色微染(hover/active 表面) |
| `--signal`     | `#10b981`                | 状态信号(活跃 dot)          |
| `--ring`       | `var(--primary)`         | focus ring                  |

### Light mode

| 变量           | 值                     | 用途               |
| -------------- | ---------------------- | ------------------ |
| `--bg`         | `#fafaf9`              | 页面背景(微暖白)   |
| `--card`       | `#ffffff`              | 卡片表面           |
| `--popover`    | `#ffffff`              | 浮层(与 card 一致) |
| `--border`     | `#e4e4e7`              | 边框               |
| `--text`       | `#3f3f46`              | 正文               |
| `--bright`     | `#18181b`              | 高亮文字           |
| `--muted`      | `#a1a1aa`              | 次要文字           |
| `--m2`         | `#71717a`              | 次要图标与辅助控件 |
| `--primary`    | `#059669`              | 主色(emerald-600)  |
| `--primary-fg` | `#ffffff`              | 主色上的文字       |
| `--accent`     | `rgba(5,150,105,0.06)` | 主色微染           |
| `--signal`     | `#059669`              | 状态信号           |
| `--ring`       | `var(--primary)`       | focus ring         |

### Agent 色(两套主题不变)

| 变量   | 值        | Agent       |
| ------ | --------- | ----------- |
| `--cc` | `#D97757` | Claude Code |
| `--cx` | `#06B6D4` | Codex       |
| `--oc` | `#8B5CF6` | OpenCode    |

### 语义色

| 变量      | Dark      | Light     | 用途           |
| --------- | --------- | --------- | -------------- |
| `--warn`  | `#fbbf24` | `#a8731a` | 警告(同步中等) |
| `--error` | `#f87171` | `#dc2626` | 错误           |
| `--info`  | `#38bdf8` | `#0284c7` | 信息           |

Token 只定义颜色来源，不保证任意前景/背景组合都满足对比度。正文组合按 WCAG AA `4.5:1` 验证，大文字与非文本 UI 按 `3:1` 验证；状态还必须有文字、图标或 accessible name，不能只依赖颜色。

## 字体

| 角色 | 字体                                          | 用途                               |
| ---- | --------------------------------------------- | ---------------------------------- |
| UI   | `Inter, system-ui, -apple-system, sans-serif` | nav、按钮、标签、正文、标题        |
| 代码 | `'JetBrains Mono', monospace`                 | skill 名、配置键、文件路径、数据值 |

不加载远程 Web Font，使用运行环境中第一个可用字体，避免网络字体改变字形和页面密度。

| 属性                    | 值                                            |
| ----------------------- | --------------------------------------------- |
| 基准字号                | 15px                                          |
| line-height             | 1.5                                           |
| 标题字重                | 600                                           |
| 标签/nav 字重           | 500                                           |
| 正文字重                | 400                                           |
| 页面标题 letter-spacing | -0.01em                                       |
| 回退栈(UI)              | `Inter, system-ui, -apple-system, sans-serif` |
| 回退栈(代码)            | `'JetBrains Mono', monospace`                 |

## 圆角

| 变量            | 值   | 用途               |
| --------------- | ---- | ------------------ |
| `--radius`      | 8px  | 按钮、输入框、chip |
| `--radius-card` | 10px | 卡片、面板、toast  |

## 阴影

| 变量                  | Dark                         | Light                         | 用途                   |
| --------------------- | ---------------------------- | ----------------------------- | ---------------------- |
| `--shadow-card`       | `0 1px 3px rgba(0,0,0,0.3)`  | `0 1px 3px rgba(0,0,0,0.06)`  | 卡片静止态             |
| `--shadow-card-hover` | `0 2px 8px rgba(0,0,0,0.4)`  | `0 2px 8px rgba(0,0,0,0.08)`  | 可交互卡片 hover       |
| `--shadow-popover`    | `0 8px 24px rgba(0,0,0,0.5)` | `0 8px 24px rgba(0,0,0,0.12)` | toast、modal、dropdown |

主色按钮 hover 时叠加微辉光: `box-shadow: 0 0 12px rgba(16,185,129,0.25)`。

## 动效

| Token    | 值                             |
| -------- | ------------------------------ |
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--dur`  | `0.18s`                        |

更新状态点可使用 `2s ease-in-out` 的 pulse；它只表达进行中，不用于装饰。`prefers-reduced-motion: reduce` 时，全局把 transition/animation 缩短为近即时并限制为单次。

## Disabled 状态

可用的原生 `button` 和 `role="button"` 控件统一使用 `pointer`；声明 `aria-roledescription="可排序项"` 的拖拽激活器使用 `grab`，按下时使用 `grabbing`。`Button` 的 disabled 状态统一使用：

| 属性           | 值   |
| -------------- | ---- |
| opacity        | 0.5  |
| pointer-events | none |

## 主题切换

主题使用 `light` / `dark` / `system` 三态，首次访问默认 `light`。

- `system` 跟随 `prefers-color-scheme`
- no-flash 内联脚本在 `packages/web/index.html` 中读取 `localStorage` key `loom-theme`
- ThemeSwitcher 使用三个带 accessible name 和 pressed state 的图标按钮
