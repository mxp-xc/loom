# 组件规范

> 目标态规范(尚未落地)。本文档描述 2026-07-02 UI redesign 的目标组件设计。样式表达统一用 CSS 变量写法(如 `var(--primary)`),不使用 Tailwind utility class 名称。

## 按钮

三级层次,通过 cva variants 实现。redesign 后将把现有 `default`/`outline`/`ghost`/`destructive` 改为以下变体:

### 变体

| 变体 | 样式 | 用途 |
|---|---|---|
| `primary` | `background: var(--primary); color: var(--primary-fg)`,hover `background: var(--primary)` 90% 透明 + 微辉光 | 每个区域唯一的主动作 |
| `secondary` | `background: var(--card); border: 1px solid var(--border)`,hover `background: var(--accent)` | 支撑动作 |
| `ghost` | 透明底,hover `background: var(--accent)`,文字色变亮 | 低优先级动作 |

### 尺寸

| 尺寸 | 高度 | 用途 |
|---|---|---|
| default | 36px | 常规 |
| sm | 32px | 紧凑布局 |
| xs | 28px | 工具栏 |

### 交互

- hover: `translateY(-1px)` + 背景色变化
- active: `translateY(0)` 回弹
- 过渡: `0.18s cubic-bezier(0.4, 0, 0.2, 1)`(见设计系统·动效)
- focus-visible: `box-shadow: 0 0 0 2px var(--ring)` 25% 透明

### Disabled

`opacity: 0.5; cursor: not-allowed; pointer-events: none`(见设计系统·Disabled)

## 卡片

```
border-radius: var(--radius-card)
border: 1px solid var(--border)
box-shadow: card 层级(见设计系统·阴影)
```

hover 时 shadow 加深,不做 translateY。

## Agent toggle (chip)

圆角方形 agent 开关,每个 skill 行右侧显示 CC/CX/OC 三个。

| 状态 | 样式 |
|---|---|
| 激活 | `background: var(--{agent-color}); color: #fff` |
| 未激活 | 透明底 + `border: 1px solid var(--{agent-color})` 45% 透明,opacity 0.5 |
| hover | `scale(1.05)` + border 变亮 |

圆角 `var(--radius)`(非 pill,从圆形改为圆角方形)。

## Toast

浮动通知,用于操作反馈(拷贝成功、保存成功等)。

| 属性 | 值 |
|---|---|
| 定位 | `position: fixed`,top-right |
| 背景 | `rgba(19,19,22,0.85)` + `backdrop-filter: blur(12px)` |
| 边框 | `1px solid var(--border)` |
| 圆角 | `var(--radius-card)` |
| 阴影 | popover 层级(见设计系统·阴影) |
| 入场 | translateY(-8px) + opacity 0 -> 1,0.25s |
| 自动消失 | 3s |
| hover | 暂停自动消失 |

图标: 18px 圆形,`background: var(--primary)`,白色对勾。

## Modal

全屏遮罩 + 居中卡片。

| 属性 | 值 |
|---|---|
| 遮罩 | `rgba(0,0,0,0.6)` + `backdrop-filter: blur(4px)` |
| 卡片 | `background: var(--popover)`,圆角 `var(--radius-card)` |
| 阴影 | popover 层级 |
| 关闭 | 点击遮罩或 Esc |

## 输入框

| 属性 | 值 |
|---|---|
| 高度 | 36px (default), 32px (sm) |
| 圆角 | `var(--radius)` |
| 边框 | `1px solid var(--border)` |
| focus | `border-color: var(--primary)` + `box-shadow: 0 0 0 2px var(--ring)` 25% 透明 |

Disabled: 见设计系统·Disabled。

## Tabs

基于 Radix Tabs。

| 元素 | 样式 |
|---|---|
| TabsList | `background: var(--card)`,圆角 `var(--radius)`,内边距 4px |
| TabsTrigger(激活) | `background: var(--bg)` |
| TabsTrigger(未激活) | 透明,`color: var(--muted)` |
| TabsTrigger(hover) | `color: var(--text)` |
| TabsTrigger(focus-visible) | `box-shadow: 0 0 0 2px var(--ring)` 25% 透明 |
| TabsTrigger(disabled) | 见设计系统·Disabled |

## 状态点 (status dot)

| 状态 | 颜色 | 动效 |
|---|---|---|
| 活跃 | `var(--signal)` | `box-shadow: 0 0 6px` 微辉光 |
| 同步中 | `var(--warn)` | `@keyframes pulse` 2s 呼吸(见设计系统·动效) |
| 未激活 | `var(--muted)` | opacity 0.45 |

## 状态栏 (statusline)

顶部栏,高度 32px。

| 属性 | 值 |
|---|---|
| 背景 | `var(--bg)` |
| 底边框 | `1px solid var(--border)` |
| 字号 | 11px |
| 文字色 | `var(--muted)`,品牌名用 `var(--signal)` |

## 侧边栏 (sidebar)

左侧导航,宽度 208px。

| 属性 | 值 |
|---|---|
| 背景 | `var(--bg)` |
| 右边框 | `1px solid var(--border)` |

### 导航项 (nav-item)

| 状态 | 样式 |
|---|---|
| 默认 | `color: var(--muted)`,左边框 2px 透明 |
| active | `color: var(--bright)`,左边框 `var(--signal)`,`background: linear-gradient(90deg, var(--accent), transparent)` |
| hover | `color: var(--text)` |

分组标签(nav-section): 字号 10px,大写,`color: var(--muted)`。
