# UI 风格重设计

> 本文档为 2026-07-02 设计决策记录。当前 token 值以 [docs/ui/design-system.md](../../ui/design-system.md) 为准(目标态,尚未落地)。

## 背景

Loom 当前使用终端审美:Fira Code 等宽字体通吃所有 UI 元素(正文用 Fira Sans),2-7px 小圆角,蓝调暗色背景 `#0b1120`,绿色信号色 `#34d399` 作为细描边和微辉光。整体观感方正、沉闷、缺乏呼吸感。

经三组 subagent 调研(Sonner/Linear/Vercel/Raycast/shadcn/ui 2025-2026 趋势)后,选定**混合风格**:保留绿色品牌基因,但采用 shadcn/ui 设计语言进行现代化重写。

## 核心决策

### 风格定调

混合风格 = 暗色基底 + 更鲜明的 emerald 主色 + shadcn/ui 三级按钮变体体系。

与三种原型风格的关系:

- 保留终端基因的部分:绿色信号色作为品牌 DNA,等宽字体用于代码/路径/数据值
- 采用现代 dev tool 的部分:sans-serif 为 UI 主字体,近中性暗背景,分层阴影
- 采用 shadcn/ui 的部分:`--radius` token 体系,default/secondary/ghost 三级按钮变体,白色低透明边框

### 色彩系统

> 以下值为决策时快照,后续以 [design-system.md](../../ui/design-system.md) 为准。

Dark mode:

```
--bg:        #0a0a0b   (近中性黑,去除蓝调)
--card:      #131316   (微亮表面)
--popover:   #1a1a1e   (浮层)
--border:    rgba(255,255,255,0.08)  (白色 8% 透明)
--text:      #e4e4e7
--bright:    #fafafa
--muted:     #71717a
--primary:   #10b981   (emerald-500)
--primary-fg: #052e1b
--accent:    rgba(16,185,129,0.08)   (主色微染,hover/active 表面)
--signal:    #10b981   (状态信号:活跃 dot、focus ring)
```

Light mode:

```
--bg:        #fafaf9   (微暖白)
--card:      #ffffff
--popover:   #ffffff   (浮层,与 card 一致)
--border:    #e4e4e7
--text:      #3f3f46
--bright:    #18181b
--muted:     #a1a1aa
--primary:   #059669   (emerald-600)
--primary-fg: #ffffff
--accent:    rgba(5,150,105,0.06)
--signal:    #059669
```

语义色(dark/light): `--warn` `#fbbf24`/`#a8731a`、`--error` `#f87171`/`#dc2626`、`--info` `#38bdf8`/`#0284c7`。取值依据:在各自背景上满足 WCAG AA 对比度(正文 >=4.5:1,大文字 >=3:1)。

Agent 色不变: `--cc #D97757`, `--cx #06B6D4`, `--oc #8B5CF6`

旧变量 `--nav`(sidebar/statusline 背景)废弃,sidebar/statusline 改用 `--bg`。

### 字体系统

从 "Fira Code/Fira Sans 通吃" 改为 "sans 为主、mono 为辅"。

```
UI 字体:    Inter (nav、按钮、标签、正文、标题)
代码字体:    JetBrains Mono (skill 名、配置键、文件路径、数据值)
基准字号:    14px (body), 标题 16-20px
字重层级:    400 body / 500 labels·nav / 600 titles
letter-spacing: 标题 -0.01em, 正文 0
font-display: swap
回退栈:      Inter, system-ui, -apple-system, sans-serif
```

Fira Code 和 Fira Sans 完全移除。JetBrains Mono 在小字号下可读性优于 Fira Code,且同样有连字。通过 Google Fonts 在 `index.html` 中加载,设 `font-display: swap` 避免 FOIT;网络不佳时回退到 `system-ui`。

### 圆角体系

用 `--radius` token 统一控制,替代当前散落的 2-7px 硬编码值。

```
--radius:       8px    (按钮、输入框、chip)
--radius-card:  10px   (卡片、面板、toast)
```

### 组件设计

> 完整组件规范见 [docs/ui/components.md](../../ui/components.md)。此处仅列决策摘要。

**按钮**(三级层次): `primary`/`secondary`/`ghost`,圆角 `var(--radius)`,hover `translateY(-1px)`

**卡片/面板**: 圆角 `var(--radius-card)`,`box-shadow` + `border`

**Agent toggle (chip)**: 圆角 `var(--radius)`(非 pill,从圆形改为圆角方形)

**Toast**: 浮动定位,毛玻璃背景,入场 `translateY(-8px) opacity:0 -> 1`,0.25s,自动消失 3s

**主题切换**: 保留现有三态(light/dark/system)机制,ThemeSwitcher 组件样式随重设计更新

### 动效

从 `0.12s linear` 升级为 `cubic-bezier(0.4, 0, 0.2, 1)`。不引入 Framer Motion,保持 CSS transitions。

- hover: `translateY(-1px)` + 背景色变化
- active: `translateY(0)` 回弹
- 视图切换: opacity + translateY 8px 淡入,200ms
- `prefers-reduced-motion` 全量尊重

## 改动范围

- `packages/web/src/index.css` — CSS 变量替换、圆角/阴影/过渡值更新
- `packages/web/src/components/ui/button.tsx` — cva variants 更新
- `packages/web/src/components/ui/tabs.tsx` — 样式更新
- `packages/web/src/components/Modal.tsx` — 样式更新
- `packages/web/src/components/ConfigField.tsx` — 样式更新
- `packages/web/src/App.tsx` — statusline/sidebar/ThemeSwitcher 样式更新
- `packages/web/src/theme.tsx` — 主题切换逻辑保留,样式适配
- 各页面组件(Skills、MCP、Sync、Settings)的 className 引用更新
- `packages/web/index.html` — Google Fonts 加载 Inter + JetBrains Mono
- 不涉及后端

## 迁移策略

一次性全量替换 CSS 变量,不做新旧共存。旧变量 `--nav` 废弃,引用处改为 `--bg`。新增变量(`--primary`、`--popover`、`--accent`、`--radius`、`--radius-card`)在 `:root` 和 `[data-theme="dark"]` 中定义后,立即更新所有引用。回滚通过 git revert 即可。

## 不做什么(截至 2026-07-02)

- 不引入 shadcn CLI(项目已有 Radix + Tailwind v4,手动迁移更可控)
- 不引入 Framer Motion(CSS transitions 足够)
- 不引入 sonner 库(自建轻量 toast,保持依赖最小)
- 不改 Agent 色系(CC/CX/OC 色值保持不变)
- 不改后端 API
