# 设计系统

> 目标态规范(尚未落地)。本文档描述 2026-07-02 UI redesign 的目标值,当前代码仍为旧终端风格。实施后以代码为准。

## 色彩

> 以下为目标态 CSS 变量,将定义在 `packages/web/src/index.css` 的 `:root`(light)和 `[data-theme="dark"]`(dark)中。

### Dark mode

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0a0a0b` | 页面背景(近中性黑) |
| `--card` | `#131316` | 卡片表面 |
| `--popover` | `#1a1a1e` | 浮层(modal、dropdown) |
| `--border` | `rgba(255,255,255,0.08)` | 边框(白色 8% 透明) |
| `--text` | `#e4e4e7` | 正文 |
| `--bright` | `#fafafa` | 高亮文字(标题) |
| `--muted` | `#71717a` | 次要文字 |
| `--primary` | `#10b981` | 主色(emerald-500) |
| `--primary-fg` | `#052e1b` | 主色上的文字 |
| `--accent` | `rgba(16,185,129,0.08)` | 主色微染(hover/active 表面) |
| `--signal` | `#10b981` | 状态信号(活跃 dot) |
| `--ring` | `var(--primary)` | focus ring |

### Light mode

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#fafaf9` | 页面背景(微暖白) |
| `--card` | `#ffffff` | 卡片表面 |
| `--popover` | `#ffffff` | 浮层(与 card 一致) |
| `--border` | `#e4e4e7` | 边框 |
| `--text` | `#3f3f46` | 正文 |
| `--bright` | `#18181b` | 高亮文字 |
| `--muted` | `#a1a1aa` | 次要文字 |
| `--primary` | `#059669` | 主色(emerald-600) |
| `--primary-fg` | `#ffffff` | 主色上的文字 |
| `--accent` | `rgba(5,150,105,0.06)` | 主色微染 |
| `--signal` | `#059669` | 状态信号 |
| `--ring` | `var(--primary)` | focus ring |

### Agent 色(两套主题不变)

| 变量 | 值 | Agent |
|---|---|---|
| `--cc` | `#D97757` | Claude Code |
| `--cx` | `#06B6D4` | Codex |
| `--oc` | `#8B5CF6` | OpenCode |

### 语义色

| 变量 | Dark | Light | 用途 |
|---|---|---|---|
| `--warn` | `#fbbf24` | `#a8731a` | 警告(同步中等) |
| `--error` | `#f87171` | `#dc2626` | 错误 |
| `--info` | `#38bdf8` | `#0284c7` | 信息 |

取值依据:在各自背景上满足 WCAG AA 对比度(正文 >=4.5:1,大文字 >=3:1)。

### 废弃变量

`--nav`(旧 sidebar/statusline 背景)废弃,引用处改为 `--bg`。

## 字体

| 角色 | 字体 | 用途 |
|---|---|---|
| UI | `Inter` | nav、按钮、标签、正文、标题 |
| 代码 | `JetBrains Mono` | skill 名、配置键、文件路径、数据值 |

通过 Google Fonts 在 `index.html` 中加载。旧字体 Fira Code 和 Fira Sans 将完全移除。

| 属性 | 值 |
|---|---|
| 基准字号 | 14px |
| line-height | 1.5 |
| 标题字重 | 600 |
| 标签/nav 字重 | 500 |
| 正文字重 | 400 |
| 标题 letter-spacing | -0.01em |
| font-display | swap |
| 回退栈(UI) | `Inter, system-ui, -apple-system, sans-serif` |
| 回退栈(代码) | `'JetBrains Mono', 'Fira Code', monospace` |

## 圆角

| 变量 | 值 | 用途 |
|---|---|---|
| `--radius` | 8px | 按钮、输入框、chip |
| `--radius-card` | 10px | 卡片、面板、toast |

## 阴影

| 层级 | Dark | Light | 用途 |
|---|---|---|---|
| card | `0 1px 3px rgba(0,0,0,0.3)` | `0 1px 3px rgba(0,0,0,0.06)` | 卡片静止态 |
| card-hover | `0 2px 8px rgba(0,0,0,0.4)` | `0 2px 8px rgba(0,0,0,0.08)` | 卡片 hover |
| popover | `0 8px 24px rgba(0,0,0,0.5)` | `0 8px 24px rgba(0,0,0,0.12)` | toast、modal、dropdown |

主色按钮 hover 时叠加微辉光: `box-shadow: 0 0 12px rgba(16,185,129,0.25)`。

## 动效

| 属性 | 值 |
|---|---|
| 缓动函数 | `cubic-bezier(0.4, 0, 0.2, 1)` |
| hover 过渡 | `0.18s` |
| 视图切换 | `0.2s`(opacity + translateY 8px) |
| toast 入场 | `0.25s`(translateY + opacity) |

### pulse keyframe(状态点呼吸)

```css
@keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
/* 周期 2s, ease-in-out */
```

`prefers-reduced-motion: reduce` 时禁用所有 transform 和 opacity 动画。

## Disabled 状态

| 属性 | 值 |
|---|---|
| opacity | 0.5 |
| cursor | not-allowed |
| pointer-events | none |

## 主题切换

保留现有三态机制:`light` / `dark` / `system`。
- `system` 跟随 `prefers-color-scheme`
- no-flash 内联脚本在 `index.html` 中,读取 `localStorage` key `loom-theme`
- ThemeSwitcher 组件为三段式 segmented control
