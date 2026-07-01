# UI 风格重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Loom 前端从终端审美(深蓝底 + Fira Code 通吃 + 小圆角)迁移到混合风格(近中性暗底 + emerald 主色 + Inter/JetBrains Mono 双字体 + shadcn/ui 设计语言)。

**Architecture:** 一次性全量替换 CSS 变量体系,不做新旧共存。先更新 `index.html` 字体加载和 `index.css` 变量/全局样式(地基),再逐组件更新(button/tabs/Modal/Toast),最后更新各页面视图的内联样式引用。所有 `--nav` 引用改为 `--bg`,所有 action 语境的 `--signal` 改为 `--primary`,所有 `Fira Code`/`Fira Sans` 改为 `JetBrains Mono`/`Inter`,所有 `0.12s` 过渡改为 `0.18s cubic-bezier(0.4, 0, 0.2, 1)`。

**Tech Stack:** React 18, Vite, Tailwind CSS v4, Radix UI, class-variance-authority

**Spec:** [docs/superpowers/specs/2026-07-02-ui-style-redesign.md](../../specs/2026-07-02-ui-style-redesign.md)
**Design system:** [docs/ui/design-system.md](../../ui/design-system.md)
**Components:** [docs/ui/components.md](../../ui/components.md)

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/web/index.html` | Google Fonts 加载 Inter + JetBrains Mono | Modify |
| `packages/web/src/index.css` | CSS 变量定义 + 全局组件样式 | Modify (全量重写) |
| `packages/web/src/components/ui/button.tsx` | 按钮组件 cva variants | Modify |
| `packages/web/src/components/ui/tabs.tsx` | Tabs 组件样式 | Modify |
| `packages/web/src/components/Modal.tsx` | 弹窗组件 | Modify |
| `packages/web/src/components/Toast.tsx` | 轻量 Toast 通知(新建) | Create |
| `packages/web/src/components/ConfigField.tsx` | 配置字段组件(仅字体引用) | Modify |
| `packages/web/src/theme.tsx` | 主题切换逻辑(纯逻辑,无样式) | 无改动 |
| `packages/web/src/App.tsx` | statusline/sidebar/ThemeSwitcher/加载态 | Modify |
| `packages/web/src/views/Skills.tsx` | Skills 页面内联样式 | Modify |
| `packages/web/src/views/Mcp.tsx` | MCP 页面内联样式 | Modify |
| `packages/web/src/views/Sync.tsx` | Sync 页面内联样式 | Modify |
| `packages/web/src/views/Settings.tsx` | Settings 页面(无内联样式变动,依赖 index.css) | 无改动 |

---

### Task 1: index.html — 加载 Google Fonts

**Files:**
- Modify: `packages/web/index.html`

- [ ] **Step 1: 添加 Google Fonts preconnect 和 stylesheet 链接**

在 `<head>` 中 `<title>` 之后、no-flash `<script>` 之前插入:

```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

完整 `index.html` 应为:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Loom</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
    <script>
      // no-flash: apply persisted/system theme before React mounts
      (function () {
        var t = localStorage.getItem('loom-theme') || 'light'
        var d = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t
        document.documentElement.setAttribute('data-theme', d)
      })()
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 验证字体加载**

Run: `pnpm --filter web dev` (如未运行)
在浏览器 DevTools Network 面板确认 `fonts.googleapis.com` 请求成功,`Inter` 和 `JetBrains Mono` 字重 400/500/600 均加载。

- [ ] **Step 3: Commit**

```bash
git add packages/web/index.html
git commit -m "feat(ui): load Inter + JetBrains Mono via Google Fonts"
```

---

### Task 2: index.css — CSS 变量与全局样式全量重写

**Files:**
- Modify: `packages/web/src/index.css` (全量替换)

这是地基任务。所有后续任务依赖此文件中的新变量定义。

- [ ] **Step 1: 替换 `:root` 变量块(light mode)**

将 `:root` 块替换为:

```css
:root {
  --bg: #fafaf9;
  --card: #ffffff;
  --popover: #ffffff;
  --border: #e4e4e7;
  --text: #3f3f46;
  --bright: #18181b;
  --muted: #a1a1aa;
  --primary: #059669;
  --primary-fg: #ffffff;
  --accent: rgba(5,150,105,0.06);
  --signal: #059669;
  --ring: var(--primary);
  --warn: #a8731a;
  --error: #dc2626;
  --info: #0284c7;
  --cc: #D97757;
  --cx: #06B6D4;
  --oc: #8B5CF6;
  --radius: 8px;
  --radius-card: 10px;
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --dur: 0.18s;
  --shadow-card: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-card-hover: 0 2px 8px rgba(0,0,0,0.08);
  --shadow-popover: 0 8px 24px rgba(0,0,0,0.12);
}
```

- [ ] **Step 2: 替换 `[data-theme="dark"]` 变量块**

将 `[data-theme="dark"]` 块替换为:

```css
[data-theme="dark"] {
  --bg: #0a0a0b;
  --card: #131316;
  --popover: #1a1a1e;
  --border: rgba(255,255,255,0.08);
  --text: #e4e4e7;
  --bright: #fafafa;
  --muted: #71717a;
  --primary: #10b981;
  --primary-fg: #052e1b;
  --accent: rgba(16,185,129,0.08);
  --signal: #10b981;
  --ring: var(--primary);
  --warn: #fbbf24;
  --error: #f87171;
  --info: #38bdf8;
  --shadow-card: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-card-hover: 0 2px 8px rgba(0,0,0,0.4);
  --shadow-popover: 0 8px 24px rgba(0,0,0,0.5);
}
```

注意: `--nav` 变量删除。Agent 色(CC/CX/OC)在两套主题中值相同,已在 `:root` 定义,dark 块不重复。

- [ ] **Step 2b: 保留 `--nav` 兼容别名**

在 `:root` 和 `[data-theme="dark"]` 块末尾各加一行,将 `--nav` 指向 `--bg`,避免 Task 5-10 中内联 `var(--nav)` 引用因变量未定义而回退为 transparent:

```css
/* :root 末尾 */
--nav: var(--bg);

/* [data-theme="dark"] 末尾 */
--nav: var(--bg);
```

此别名在 Task 12 验证阶段确认 `rg "var\(--nav\)"` 无输出后移除。

- [ ] **Step 3: 替换 body 和基础样式**

将 `body` 规则替换为:

```css
body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
```

将 `.label` 规则替换为(去掉 letter-spacing):

```css
.label { font-size: 10px; font-weight: 500; text-transform: uppercase; color: var(--muted); }
```

- [ ] **Step 4: 替换 statusline 样式**

```css
.statusline { display: flex; align-items: center; gap: 14px; height: 32px; padding: 0 18px; background: var(--bg); border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted); }
.statusline .brand { color: var(--signal); font-family: 'JetBrains Mono', monospace; font-weight: 600; }
.statusline .v { color: var(--text); font-family: 'JetBrains Mono', monospace; }
.statusline .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--signal); box-shadow: 0 0 6px var(--signal); margin-right: 5px; display: inline-block; }
.statusline .sync { margin-left: auto; display: flex; align-items: center; }
```

变更: `--nav` → `--bg`,`Fira Code` → `JetBrains Mono`。

- [ ] **Step 5: 替换 shell/sidebar/nav 样式**

```css
.shell { display: grid; grid-template-columns: 208px 1fr; height: calc(100% - 32px); }
.sidebar { background: var(--bg); border-right: 1px solid var(--border); padding: 14px 0; display: flex; flex-direction: column; gap: 2px; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 18px; color: var(--muted); font-size: 13px; font-weight: 500; border-left: 2px solid transparent; cursor: pointer; text-decoration: none; transition: all var(--dur) var(--ease); }
.nav-item .ic { font-family: 'JetBrains Mono', monospace; font-size: 14px; width: 16px; text-align: center; }
.nav-item.active { color: var(--bright); border-left-color: var(--signal); background: linear-gradient(90deg, var(--accent), transparent); }
.nav-item.active .ic { color: var(--signal); }
.nav-section { padding: 13px 18px 5px; }
```

变更: `--nav` → `--bg`,`0.12s` → `var(--dur) var(--ease)`,`rgba(52,211,153,0.06)` → `var(--accent)`。

- [ ] **Step 6: 替换 main/head/add-btn 样式**

```css
.main { padding: 20px 26px; overflow: auto; }
.head { display: flex; align-items: center; gap: 14px; }
.page-title { font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 600; color: var(--bright); letter-spacing: -0.01em; }
.page-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.add-btn { margin-left: auto; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 500; padding: 6px 12px; border-radius: var(--radius); background: var(--primary); color: var(--primary-fg); border: none; cursor: pointer; transition: all var(--dur) var(--ease); }
.add-btn:hover { transform: translateY(-1px); box-shadow: 0 0 12px rgba(16,185,129,0.25); }
.add-btn:active { transform: translateY(0); }
```

变更: `Fira Code` → `JetBrains Mono`,`Fira Sans` → `Inter`,`border-radius: 4px` → `var(--radius)`,`--signal` → `--primary`,`--bg`(text color) → `--primary-fg`,`0.12s` → `var(--dur) var(--ease)`,新增 hover translateY + glow。

- [ ] **Step 6b: 添加按钮 disabled 状态和输入框 focus 规则**

在 `.add-btn:active` 规则之后追加:

```css
.add-btn:disabled, .gbtn:disabled, .sbtn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
input:not(.cfg-input):focus, textarea:not(.cfg-textarea):focus { border-color: var(--primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 25%, transparent); outline: none; }
```

第一条规则为 CSS-class 按钮(`.add-btn`/`.gbtn`/`.sbtn`)提供 disabled 视觉态(与设计系统 Disabled 规范一致)。第二条规则为 Skills/Mcp/Sync 中使用 `inputStyle` 内联样式的 `<input>` 元素提供 focus ring(内联样式无法表达 `:focus`,用全局规则兜底)。`:not(.cfg-input)` 排除已有 focus 样式的 config 输入框,避免双重覆盖。

- [ ] **Step 7: 替换 group/group-head/gbtn 样式**

```css
.group { margin-top: 18px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--card); box-shadow: var(--shadow-card); }
.group:hover { box-shadow: var(--shadow-card-hover); }
.group-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--border); border-radius: var(--radius-card) var(--radius-card) 0 0; }
.group-head .gname { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--bright); display: flex; align-items: center; gap: 7px; }
.group-head .gname .arrow { color: var(--signal); font-size: 10px; }
.group-head .gurl { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--muted); }
.group-head .gref { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--signal); }
.group-head .gacts { margin-left: auto; display: flex; gap: 6px; }
.gbtn { font-family: 'JetBrains Mono', monospace; font-size: 10px; padding: 3px 8px; border-radius: var(--radius); background: transparent; border: 1px solid var(--border); color: var(--muted); cursor: pointer; transition: all var(--dur) var(--ease); }
.gbtn.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.gbtn:hover { color: var(--text); border-color: var(--muted); background: var(--accent); }
```

变更: `--nav` → `--bg`,`border-radius: 6px/5px/3px` → `var(--radius-card)`/`var(--radius)`,`Fira Code` → `JetBrains Mono`,`0.12s` → `var(--dur) var(--ease)`,新增 `box-shadow`,`gbtn:hover` 加 `background: var(--accent)`。

- [ ] **Step 8: 替换 skill/chip/sdot/sname/sstate 样式**

```css
.skill { display: grid; grid-template-columns: 12px 1fr auto 90px; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.skill:last-child { border-bottom: none; }
.skill:hover { background: var(--accent); }
.sdot { width: 8px; height: 8px; border-radius: 50%; }
.sdot.green { background: var(--signal); box-shadow: 0 0 6px color-mix(in srgb, var(--signal) 50%, transparent); }
.sdot.yellow { background: var(--warn); animation: pulse 2s ease-in-out infinite; }
.sdot.dim { background: var(--muted); opacity: 0.45; }
.sname { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text); }
.sname.clickable { cursor: pointer; transition: color var(--dur) var(--ease); }
.sname.clickable:hover { color: var(--signal); }
.sname.dim { color: var(--muted); }
.chips { display: flex; gap: 7px; }
.chip { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid transparent; border-radius: var(--radius); transition: all var(--dur) var(--ease); flex-shrink: 0; font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700; }
.chip.active { background: var(--c); color: #fff; border-color: var(--c); }
.chip.inactive { background: transparent; color: var(--c); border-color: color-mix(in srgb, var(--c) 45%, transparent); opacity: 0.5; }
.chip:hover { transform: scale(1.05); border-color: var(--c); }
.sstate { font-family: 'JetBrains Mono', monospace; font-size: 10px; }
.st-proj { color: var(--signal); } .st-upd { color: var(--warn); } .st-off { color: var(--muted); }
.local-tag { font-family: 'JetBrains Mono', monospace; font-size: 9px; padding: 1px 5px; border-radius: var(--radius); background: rgba(56,189,248,0.12); color: var(--info); border: 1px solid color-mix(in srgb, var(--info) 30%, transparent); }
```

变更: `rgba(255,255,255,0.02)` → `var(--accent)`,`border-radius: 50%` → `var(--radius)`(chip 从圆形改为圆角方形),`rgba(52,211,153,0.5)` → `color-mix(...)`,`0.12s` → `var(--dur) var(--ease)`,`chip:hover` 从 `translateY(-1px)` 改为 `scale(1.05)`,`border-radius: 2px` → `var(--radius)`。

- [ ] **Step 9: 替换 legend/hint 样式**

```css
.legend { display: flex; gap: 14px; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.lg { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.lg .sw { width: 12px; height: 12px; border-radius: var(--radius); }
.hint { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 8px; }
```

变更: `border-radius: 50%`(legend swatch)→ `var(--radius)`。

- [ ] **Step 10: 替换 MCP list/mcp/tg 样式**

```css
.mlist { border-right: 1px solid var(--border); overflow: auto; padding: 14px 0; }
.mcp { padding: 10px 16px; border-left: 2px solid transparent; cursor: pointer; transition: background var(--dur) var(--ease); }
.mcp:hover { background: var(--accent); }
.mcp.sel { background: linear-gradient(90deg, var(--accent), transparent); border-left-color: var(--signal); }
.mcp-top { display: flex; align-items: center; gap: 10px; }
.mcp .mid { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--text); }
.mcp.sel .mid { color: var(--bright); }
.mcp .mtype { font-family: 'JetBrains Mono', monospace; font-size: 9px; padding: 1px 5px; border-radius: var(--radius); background: rgba(56,189,248,0.12); color: var(--info); }
.mcp .mtype.remote { background: rgba(139,92,246,0.14); color: var(--oc); }
.mcp .mcnt { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--muted); margin-left: auto; }
.mcp-bottom { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.mcp-bottom .mcmd { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--muted); margin-right: auto; }
```

变更: `rgba(255,255,255,0.02)` → `var(--accent)`,`rgba(52,211,153,0.07)` → `var(--accent)`,`border-radius: 2px` → `var(--radius)`,`Fira Code` → `JetBrains Mono`,新增 transition。

- [ ] **Step 11: 替换 big toggle (tg) 样式**

```css
.tg { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid transparent; border-radius: var(--radius); transition: all var(--dur) var(--ease); flex-shrink: 0; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; }
.tg.on { background: var(--c); color: #fff; border-color: var(--c); }
.tg.off { background: transparent; color: var(--c); border-color: color-mix(in srgb, var(--c) 45%, transparent); opacity: 0.45; }
.tg:hover { transform: scale(1.05); border-color: var(--c); }
```

变更: `border-radius: 7px` → `var(--radius)`,`0.12s` → `var(--dur) var(--ease)`,`translateY(-1px)` → `scale(1.05)`。

- [ ] **Step 12: 替换 sync/syncbar/sbtn 样式**

```css
.syncbar { display: flex; align-items: center; gap: 14px; margin-top: 12px; padding: 11px 14px; background: var(--accent); border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent); border-radius: var(--radius-card); }
.syncbar .msg { font-size: 13px; color: var(--bright); }
.syncbar .acts { margin-left: auto; display: flex; gap: 6px; }
.sbtn { font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 5px 11px; border-radius: var(--radius); background: transparent; border: 1px solid var(--border); color: var(--muted); cursor: pointer; transition: all var(--dur) var(--ease); }
.sbtn:hover { color: var(--text); border-color: var(--muted); background: var(--accent); }
```

变更: `rgba(52,211,153,0.06)` → `var(--accent)`,`--signal` → `--primary`,`border-radius: 6px/4px` → `var(--radius-card)`/`var(--radius)`,`0.12s` → `var(--dur) var(--ease)`,`sbtn:hover` 加 `background: var(--accent)`。

- [ ] **Step 13: 替换 settings/cfg-table/cfg-* 样式**

```css
.sdot-cfg { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 1px solid #999; }
.sdot-cfg.inherit { background: transparent; }
.sdot-cfg.local { background: #3b82f6; border-color: #3b82f6; }
.sdot-cfg.fixed { background: #3b82f6; border-color: #3b82f6; }
.sdot-cfg.repo { background: #22c55e; border-color: #22c55e; }
.legend .sw.sdot-cfg { width: 12px; height: 12px; }

.cfg-table { border: 1px solid var(--border); border-radius: var(--radius-card); overflow: hidden; background: var(--card); box-shadow: var(--shadow-card); }
.cfg-table:hover { box-shadow: var(--shadow-card-hover); }
.cfg-thead { display: grid; grid-template-columns: 180px 1fr 64px 40px; align-items: center; padding: 9px 14px; background: var(--bg); border-bottom: 1px solid var(--border); }
.cfg-tbody > .cfg-row:not(:last-child) { border-bottom: 1px solid var(--border); }
.cfg-row { display: grid; grid-template-columns: 180px 1fr 64px 40px; align-items: start; padding: 8px 14px; transition: background var(--dur) var(--ease); }
.cfg-row:hover { background: var(--accent); }
.cfg-row.cfg-editing { background: var(--accent); border-left: 2px solid var(--primary); padding-left: 12px; }
.cfg-cell { min-width: 0; }
.cfg-cell.cfg-name { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
.cfg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--muted); }
.cfg-dot.src-local, .cfg-dot.src-fixed { background: #3b82f6; border-color: #3b82f6; }
.cfg-dot.src-repo { background: #22c55e; border-color: #22c55e; }
.cfg-dot.src-inherit { background: transparent; }
.cfg-name-text { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--text); word-break: break-all; }
.cfg-cell.cfg-value { padding-top: 1px; }
.cfg-scalar { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--muted); word-break: break-all; }
.cfg-scalar.cfg-null { color: var(--muted); opacity: 0.55; font-style: italic; }
.cfg-pre { font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.5; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; overflow-x: auto; white-space: pre; margin: 0; }
.cfg-cell.cfg-source { padding-top: 3px; }
.src-badge { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: var(--radius); display: inline-block; }
.src-badge.src-local, .src-badge.src-fixed { background: rgba(59,130,246,0.14); color: #60a5fa; }
.src-badge.src-repo { background: rgba(34,197,94,0.14); color: #4ade80; }
.src-badge.src-inherit { background: rgba(148,163,184,0.12); color: var(--muted); }
.cfg-cell.cfg-actions { display: flex; gap: 4px; padding-top: 2px; justify-content: flex-end; }
.cfg-edit-wrap { display: flex; flex-direction: column; gap: 5px; }
.cfg-input { width: 100%; padding: 5px 9px; font-size: 13px; font-family: 'JetBrains Mono', monospace; border: 1px solid var(--primary); border-radius: var(--radius); background: var(--bg); color: var(--text); outline: none; }
.cfg-input:focus { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 25%, transparent); }
.cfg-textarea { width: 100%; padding: 8px 10px; font-size: 12px; font-family: 'JetBrains Mono', monospace; line-height: 1.5; border: 1px solid var(--primary); border-radius: var(--radius); background: var(--bg); color: var(--text); outline: none; resize: vertical; min-height: 60px; }
.cfg-textarea:focus { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 25%, transparent); }
.cfg-err { font-size: 11px; color: var(--error); font-family: 'Inter', sans-serif; }
.cfg-hint { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 10px; }
```

变更: `--nav` → `--bg`,`--signal` → `--primary`(action 语境)或 `--ring`(focus ring),`color-mix(in srgb, var(--nav) 45%, transparent)` → `var(--accent)`,`color-mix(in srgb, var(--signal) 5%, transparent)` → `var(--accent)`,`border-radius: 6px/4px/3px` → `var(--radius-card)`/`var(--radius)`,`Fira Code` → `JetBrains Mono`,`Fira Sans` → `Inter`,`0.12s` → `var(--dur) var(--ease)`,新增 `box-shadow: var(--shadow-card)`。

- [ ] **Step 14: 替换 keyframes 和 reduced-motion**

```css
@keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
@keyframes toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) {
  .sdot.yellow { animation: none; }
  .tg:hover, .chip:hover, .add-btn:hover { transform: none; }
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}
```

变更: 新增 `toast-in` keyframe(供 Toast 组件使用),reduced-motion 覆盖范围扩大(加 `add-btn`),增加全局 transition 和 animation 禁用(`animation-duration` 确保 `toast-in` 等动画在 reduced-motion 下也禁用)。

- [ ] **Step 15: 验证 CSS 无语法错误**

Run: `pnpm --filter web build` (或 `pnpm --filter web dev` 查看控制台)
Expected: 无 CSS 编译错误,Vite 正常启动。

- [ ] **Step 16: Commit**

```bash
git add packages/web/src/index.css
git commit -m "feat(ui): replace CSS variables and global styles for hybrid design"
```

---

### Task 3: button.tsx — 三级按钮变体

**Files:**
- Modify: `packages/web/src/components/ui/button.tsx`

- [ ] **Step 1: 替换 cva variants**

将整个 `buttonVariants` 定义替换为:

```tsx
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-all duration-[var(--dur)] ease-[var(--ease)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--ring)_25%,transparent)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--primary)] text-[var(--primary-fg)] hover:-translate-y-px hover:shadow-[0_0_12px_rgba(16,185,129,0.25)]',
        secondary: 'border border-[var(--border)] bg-[var(--card)] text-[var(--text)] hover:bg-[var(--accent)]',
        ghost: 'text-[var(--muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]',
        destructive: 'bg-[var(--error)] text-white hover:opacity-90',
      },
      size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3', xs: 'h-7 px-2 text-xs', lg: 'h-10 px-6' },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
)
```

变更: `default` → `primary`(emerald 背景 + hover glow),`outline` → `secondary`(card 背景 + border),`ghost` 保持(透明 + accent hover),新增 `xs` 尺寸(28px),focus ring 从 `ring-2 ring-[var(--info)]` 改为 shadow 写法,圆角从 `rounded-md` 改为 `rounded-[var(--radius)]`,过渡从 `transition-colors` 改为 `transition-all duration-[var(--dur)] ease-[var(--ease)]`。

- [ ] **Step 2: 验证按钮渲染**

注意: `Button` 组件当前在项目中未被任何页面引用(所有按钮使用 CSS 类 `.add-btn`),此 Task 为前向准备。验证方式: `pnpm --filter web build` 确认 cva variants 编译无错。实际按钮样式验证归 Task 2 Step 6 的 `.add-btn` CSS 规则。

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/ui/button.tsx
git commit -m "feat(ui): update button variants to primary/secondary/ghost"
```

---

### Task 4: tabs.tsx — 更新样式

**Files:**
- Modify: `packages/web/src/components/ui/tabs.tsx`

- [ ] **Step 1: 更新 TabsList 和 TabsTrigger**

将 `TabsList` 组件替换为:

```tsx
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('inline-flex h-9 items-center gap-1 rounded-[var(--radius)] border p-1', className)}
    style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
    {...props}
  />
))
```

将 `TabsTrigger` 组件替换为:

```tsx
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius)] px-3 py-1 text-sm font-medium transition-all duration-[var(--dur)] ease-[var(--ease)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--ring)_25%,transparent)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[var(--bg)] data-[state=active]:text-[var(--bright)] text-[var(--muted)] hover:text-[var(--text)]',
      className,
    )}
    {...props}
  />
))
```

变更: `rounded-md`/`rounded-sm` → `rounded-[var(--radius)]`,新增 `background: var(--card)` 给 TabsList,未激活 trigger 加 `text-[var(--muted)] hover:text-[var(--text)]`,focus ring 改为 shadow 写法,过渡改为 `transition-all duration-[var(--dur)] ease-[var(--ease)]`。

- [ ] **Step 2: 验证 tabs 渲染**

在浏览器打开 Settings 页面,确认三个 tab(最终结果/仓库级/本地级)显示为 card 背景容器内可切换的 pill,激活态为 `var(--bg)` 背景 + `var(--bright)` 文字。

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/ui/tabs.tsx
git commit -m "feat(ui): update tabs to use design tokens"
```

---

### Task 5: Modal.tsx — 更新弹窗样式

**Files:**
- Modify: `packages/web/src/components/Modal.tsx`

- [ ] **Step 1: 更新遮罩和卡片样式**

完整修改后的 Modal 组件:

```tsx
import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  children: ReactNode
}

export default function Modal({ open, onClose, title, width = 480, children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={ref}
        style={{
          width, maxHeight: '80vh', overflow: 'auto',
          background: 'var(--popover)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-popover)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          background: 'var(--bg)',
        }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, color: 'var(--bright)' }}>{title}</span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 2,
            }}
          >
            &times;
          </button>
        </div>
        <div style={{ padding: '18px 20px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
```

变更: 遮罩透明度 0.45→0.6 + 加 `backdrop-filter: blur(4px)`,卡片背景 `--card` → `--popover`,圆角 `8px` → `var(--radius-card)`,阴影改为 `var(--shadow-popover)`,头部背景 `--nav` → `--bg`,字体 `Fira Code` → `JetBrains Mono`。

- [ ] **Step 2: 验证弹窗渲染**

在 Skills 页面点击任意 skill 名打开详情弹窗,确认遮罩有模糊效果,卡片背景为 `--popover`,圆角为 10px。

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/Modal.tsx
git commit -m "feat(ui): update modal with popover bg, blur backdrop, radius tokens"
```

---

### Task 6: Toast.tsx — 轻量 Toast 通知组件

**Files:**
- Create: `packages/web/src/components/Toast.tsx`

当前 Skills.tsx 和 Mcp.tsx 各自内联实现了 toast。此任务创建共享组件,后续两个页面任务中接入。

- [ ] **Step 1: 创建 Toast 组件**

```tsx
import { useEffect, useState, type ReactNode } from 'react'

interface ToastProps {
  message: string
  onClose: () => void
  duration?: number
  icon?: ReactNode
}

export default function Toast({ message, onClose, duration = 3000, icon }: ToastProps) {
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (hovered) return
    const t = setTimeout(onClose, duration)
    return () => clearTimeout(t)
  }, [hovered, duration, onClose])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'fixed', top: 48, right: 24, zIndex: 999,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 16px',
        borderRadius: 'var(--radius-card)',
        background: 'rgba(19,19,22,0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-popover)',
        fontFamily: "'Inter', sans-serif",
        fontSize: 12, fontWeight: 500,
        color: 'var(--bright)',
        animation: 'toast-in 0.25s var(--ease)',
      }}
    >
      {icon ?? (
        <span style={{
          width: 18, height: 18, borderRadius: '50%',
          background: 'var(--primary)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      )}
      {message}
    </div>
  )
}
```

`toast-in` keyframe 已在 Task 2 Step 14 的 `index.css` 中定义。

- [ ] **Step 2: 验证组件编译**

Run: `pnpm --filter web build`
Expected: 无 TS 编译错误。

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/Toast.tsx
git commit -m "feat(ui): add shared Toast component with frosted glass"
```

---

### Task 7: App.tsx — ThemeSwitcher 与 statusline 样式

**Files:**
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: 更新 ThemeSwitcher 内联样式**

将 `ThemeSwitcher` 函数中 button 的 `style` 对象替换为:

```tsx
style={{
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  fontWeight: 700,
  padding: '3px 8px',
  borderRadius: 'var(--radius)',
  border: '1px solid transparent',
  cursor: 'pointer',
  transition: 'all var(--dur) var(--ease)',
  ...(theme === m
    ? { background: 'var(--primary)', color: 'var(--primary-fg)', borderColor: 'var(--primary)' }
    : { background: 'transparent', color: 'var(--muted)', borderColor: 'var(--border)', opacity: 0.65 }),
}}
```

变更: `borderRadius: 4` → `var(--radius)`,`--signal` → `--primary`,`color: '#fff'` → `var(--primary-fg)`,`0.12s` → `var(--dur) var(--ease)`,`Fira Code` → `JetBrains Mono`。

- [ ] **Step 2: 更新加载/错误状态字体**

将加载状态 `span` 的 `style` 中 `fontFamily` 从 `"'Fira Code', monospace"` 改为 `"'JetBrains Mono', monospace"`。
将错误状态 `span` 的 `style` 中 `fontFamily` 从 `"'Fira Code', monospace"` 改为 `"'JetBrains Mono', monospace"`。

- [ ] **Step 3: 验证 App 渲染**

在浏览器中确认: statusline 品牌名为 emerald 色 + JetBrains Mono 字体,sidebar 底部 ThemeSwitcher 三段按钮激活态为 emerald 背景。

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/App.tsx
git commit -m "feat(ui): update App ThemeSwitcher and statusline styles"
```

---

### Task 8: Skills.tsx — 字体与变量引用更新

**Files:**
- Modify: `packages/web/src/views/Skills.tsx`

此文件有 18 处 `Fira` 引用和多处 `--signal`/`--nav`/`rgba(52,211,153,...)` 引用。

- [ ] **Step 1: 替换全局常量中的字体和圆角引用**

将 `inputStyle` 对象中:
```tsx
fontFamily: "'Fira Code', monospace", borderRadius: 4,
```
改为:
```tsx
fontFamily: "'JetBrains Mono', monospace", borderRadius: 'var(--radius)',
```

将 `menuBtnStyle` 中 `fontFamily` 从 `"'Fira Code', monospace"` 改为 `"'JetBrains Mono', monospace"`。

将 `menuStyle` 中 `borderRadius: 4` 改为 `'var(--radius)'`。

将 `refreshBtnStyle` 中 `fontFamily` 从 `"'Fira Code', monospace"` 改为 `"'JetBrains Mono', monospace"`,`borderRadius: 4` 改为 `'var(--radius)'`。

将 `copyBtnStyle` 中 `fontFamily` 从 `"'Fira Code', monospace"` 改为 `"'JetBrains Mono', monospace"`,`borderRadius: 3` 改为 `'var(--radius)'`。

- [ ] **Step 2: 替换 toast 内联样式为 Toast 组件**

在文件顶部 import 区添加:
```tsx
import Toast from '@/components/Toast'
```

将 `showToast` 函数保留(管理 toast 状态),将 toast 渲染从:
→ 替换 `showToast` 定义,移除冗余 `setTimeout`(Toast 组件已内置自动消失 + hover 暂停):

```tsx
const showToast = (msg: string) => setToast(msg)
```

将 toast 渲染从:
```tsx
{toast && (
  <div style={{ marginTop: 12, padding: '8px 14px', border: '1px solid var(--signal)', borderRadius: 6, background: 'rgba(52,211,153,0.08)', fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--signal)' }}>{toast}</div>
)}
```
替换为:
```tsx
{toast && <Toast message={toast} onClose={() => setToast(null)} />}
```

- [ ] **Step 3: 替换所有内联 `Fira Code` → `JetBrains Mono` 和 `Fira Sans` → `Inter`**

全文件搜索 `'Fira Code'` 替换为 `'JetBrains Mono'`,`'Fira Sans'` 替换为 `'Inter'`。涉及位置(逐一确认):
- `derivedLocalId` 显示: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- error div: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- errors div: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- empty state hint: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- `srcRef` onBlur 后 id 显示: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- scanMembers label: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- Add Modal tab buttons: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- Add Modal error: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- detail modal source/path: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- detail modal SKILL.md pre: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- detail modal projected links path: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- `var(--signal)` 在 `derivedLocalId` 的 color 中保持不变(它是状态色,不是 action 色)。

- [ ] **Step 4: 替换 `--nav` 引用**

将 Add Modal tab button 的 `background` 中:
```tsx
background: addTab === tab ? 'var(--nav)' : 'transparent',
```
改为:
```tsx
background: addTab === tab ? 'var(--bg)' : 'transparent',
```

- [ ] **Step 5: 替换内联 `borderRadius` 硬编码值**

将以下内联 `borderRadius` 改为 token:
- error div `borderRadius: 6` → `'var(--radius-card)'`
- errors div `borderRadius: 6` → `'var(--radius-card)'`
- empty state `borderRadius: 6` → `'var(--radius-card)'`
- scanMembers list `borderRadius: 4` → `'var(--radius)'`
- Add Modal error `borderRadius: 4` → `'var(--radius)'`
- detail modal SKILL.md pre `borderRadius: 4` → `'var(--radius)'`
- Add Modal tab button `borderRadius: 4` → `'var(--radius)'`

- [ ] **Step 6: 验证 Skills 页面渲染**

在浏览器打开 Skills 页面,确认:
- 标题 "Skills" 为 JetBrains Mono 字体
- skill 名为 JetBrains Mono
- chip 为圆角方形(非圆形)
- 点击 skill 名打开弹窗,SKILL.md 内容为 JetBrains Mono
- toast 通知为右上角浮动毛玻璃样式
- `+ Add skill` 按钮为 emerald 主色

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/views/Skills.tsx
git commit -m "feat(ui): update Skills view fonts, vars, and Toast integration"
```

---

### Task 9: Mcp.tsx — 字体与变量引用更新

**Files:**
- Modify: `packages/web/src/views/Mcp.tsx`

此文件有 11 处 `Fira` 引用和 `--nav`/`--signal` 引用。

- [ ] **Step 1: 替换全局常量中的字体引用**

将 `inputStyle` 对象中:
```tsx
fontFamily: "'Fira Code', monospace", borderRadius: 4,
```
改为:
```tsx
fontFamily: "'JetBrains Mono', monospace", borderRadius: 'var(--radius)',
```

- [ ] **Step 2: 替换 toast 内联实现为 Toast 组件**

在文件顶部 import 区添加:
```tsx
import Toast from '@/components/Toast'
```

删除 `showToast` 函数中的 `window.clearTimeout(showToast._t)` 和 `showToast._t = window.setTimeout(...)` 逻辑,简化为:
```tsx
const showToast = (msg: string) => setToastMsg(msg)
```

删除 `showToast._t = 0` 行。

将文件底部 toast 渲染从整个 `<div>` + `<style>` 块替换为:
```tsx
{toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg(null)} />}
```

删除底部的 `<style>{`@keyframes mcp-toast-in ...`}</style>`。

- [ ] **Step 3: 替换所有内联 `Fira Code` → `JetBrains Mono` 和 `Fira Sans` → `Inter`**

全文件搜索 `'Fira Code'` 替换为 `'JetBrains Mono'`。涉及位置:
- error div: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- empty state hint: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- command/args/url/env/headers 显示: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- Add Modal type buttons: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`
- Add Modal error: `fontFamily: "'Fira Code', monospace"` → `"'JetBrains Mono', monospace"`

- [ ] **Step 4: 替换 `--nav` 引用**

将 Add Modal type button 的 `background` 中:
```tsx
background: srvType === t ? 'var(--nav)' : 'transparent',
```
改为:
```tsx
background: srvType === t ? 'var(--bg)' : 'transparent',
```

- [ ] **Step 5: 替换内联 `borderRadius` 硬编码值**

将以下 `borderRadius` 改为 token:
- error div `borderRadius: 6` → `'var(--radius-card)'`
- empty state `borderRadius: 6` → `'var(--radius-card)'`
- MCP list/detail grid container `borderRadius: 6` → `'var(--radius-card)'`
- scanMembers list `borderRadius: 4` → `'var(--radius)'`
- Add Modal error `borderRadius: 4` → `'var(--radius)'`
- Add Modal type button `borderRadius: 4` → `'var(--radius)'`

- [ ] **Step 6: 验证 MCP 页面渲染**

在浏览器打开 MCP 页面,确认:
- 服务器列表项为 JetBrains Mono
- 点击拷贝按钮后 toast 为右上角浮动毛玻璃样式
- type 标签为圆角方形
- Add Server 弹窗中 type 按钮激活态为 `var(--bg)` 背景

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/views/Mcp.tsx
git commit -m "feat(ui): update Mcp view fonts, vars, and Toast integration"
```

---

### Task 10: Sync.tsx — 字体与变量引用更新

**Files:**
- Modify: `packages/web/src/views/Sync.tsx`

此文件有 14 处 `Fira` 引用和 `--nav`/`--signal` 引用。

- [ ] **Step 1: 替换所有内联 `Fira Code` → `JetBrains Mono`**

全文件搜索 `'Fira Code'` 替换为 `'JetBrains Mono'`。涉及位置:
- remote input `fontFamily`
- remote display `fontFamily`
- error div `fontFamily`
- conflict header `fontFamily`
- conflict LOCAL/BASE/REMOTE values `fontFamily`
- textConflicts `fontFamily`
- pushResult `fontFamily`
- "请先配置 remote URL" hint `fontFamily`

- [ ] **Step 2: 替换 `--nav` 引用**

将两处 `background: 'var(--nav)'` 改为 `background: 'var(--bg)'`:
- 冲突卡片 header: `background: 'var(--nav)'` → `'var(--bg)'`
- 冲突卡片底部操作栏: `background: 'var(--nav)'` → `'var(--bg)'`

- [ ] **Step 3: 替换 `--signal` action 语境为 `--primary`**

将以下 `var(--signal)` 改为 `var(--primary)`:
- conflict resolution button active state: `borderColor: 'var(--signal)', color: 'var(--signal)'` → `borderColor: 'var(--primary)', color: 'var(--primary)'`
- pushResult border: `1px solid ${pushResult.ok ? 'var(--signal)' : 'var(--error)'}` → `1px solid ${pushResult.ok ? 'var(--primary)' : 'var(--error)'}`
- pushResult text color: `pushResult.ok ? 'var(--signal)' : 'var(--error)'` → `pushResult.ok ? 'var(--primary)' : 'var(--error)'`

- [ ] **Step 4: 替换内联 `borderRadius` 硬编码值**

将以下 `borderRadius` 改为 token:
- remote config card: `borderRadius: 6` → `'var(--radius-card)'`
- error div: `borderRadius: 6` → `'var(--radius-card)'`
- conflict card: `borderRadius: 6` → `'var(--radius-card)'`
- conflict badge: `borderRadius: 3` → `'var(--radius)'`
- pushResult: `borderRadius: 6` → `'var(--radius-card)'`
- remote input: `borderRadius: 4` → `'var(--radius)'`

- [ ] **Step 5: 验证 Sync 页面渲染**

在浏览器打开 Sync 页面,确认:
- remote URL 输入框为 JetBrains Mono + 圆角 8px
- 冲突卡片 header 背景为 `var(--bg)`
- 冲突解决按钮激活态为 emerald 边框 + 文字
- pushResult 成功状态为 emerald 色

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/views/Sync.tsx
git commit -m "feat(ui): update Sync view fonts and variable references"
```

---

### Task 11: ConfigField.tsx — 字体引用更新

**Files:**
- Modify: `packages/web/src/components/ConfigField.tsx`

ConfigField 的样式主要依赖 CSS 类(已在 Task 2 处理),仅有 `cfg-err` 的 `font-family` 需确认。

- [ ] **Step 1: 确认无内联字体引用**

检查 ConfigField.tsx 中是否有内联 `fontFamily`。如有 `'Fira Sans'` 或 `'Fira Code'`,替换为 `'Inter'` 或 `'JetBrains Mono'`。

当前文件中 `cfg-err` 使用 CSS 类(非内联),CSS 类已在 Task 2 Step 13 中将 `font-family: 'Fira Sans', sans-serif` 改为 `font-family: 'Inter', sans-serif`。

如文件中无内联 `fontFamily` 引用,此任务无需代码改动,跳过 commit。

- [ ] **Step 2: 验证 ConfigField 渲染**

在浏览器打开 Settings 页面,进入编辑模式,确认:
- 字段名为 JetBrains Mono
- 值为 JetBrains Mono
- 错误信息为 Inter 字体
- 输入框/textarea 边框为 emerald 主色,focus ring 为 emerald 25% 透明

- [ ] **Step 3: Commit(如有改动)**

```bash
git add packages/web/src/components/ConfigField.tsx
git commit -m "feat(ui): update ConfigField font references"
```

---

### Task 12: 全量视觉验证

**Files:**
- 无文件修改

- [ ] **Step 1: 启动 dev server**

Run: `pnpm dev`
Expected: 前端 `localhost:5173` 和后端 `localhost:3000` 正常启动。

- [ ] **Step 2: 使用 playwright-cli 截图所有页面(dark mode)**

使用 playwright-cli 打开 `http://localhost:5173`,在 dark mode 下截图。session ID: `ui-verify-dark`。

```bash
playwright-cli open -s ui-verify-dark http://localhost:5173/skills
playwright-cli eval -s ui-verify-dark "document.documentElement.setAttribute('data-theme','dark')"
playwright-cli screenshot -s ui-verify-dark --path temp/screenshots/skills-dark.png
playwright-cli open -s ui-verify-dark http://localhost:5173/mcp
playwright-cli screenshot -s ui-verify-dark --path temp/screenshots/mcp-dark.png
playwright-cli open -s ui-verify-dark http://localhost:5173/sync
playwright-cli screenshot -s ui-verify-dark --path temp/screenshots/sync-dark.png
playwright-cli open -s ui-verify-dark http://localhost:5173/settings
playwright-cli screenshot -s ui-verify-dark --path temp/screenshots/settings-dark.png
```

截图确认:
- `/skills` — 确认 chip 为圆角方形,按钮为 emerald,字体为 Inter/JetBrains Mono
- `/mcp` — 确认服务器列表、detail 面板、toast 样式
- `/sync` — 确认 syncbar、冲突卡片样式
- `/settings` — 确认 tabs、config table、编辑态样式

确认点:
- 背景为 `#0a0a0b`(近中性黑,无蓝调)
- 主色为 `#10b981`(emerald-500)
- 圆角: 按钮/输入框/chip 为 8px,卡片为 10px
- 字体: 正文 Inter,代码/路径 JetBrains Mono
- 过渡: hover 有 translateY/scale 效果,缓动为 `cubic-bezier(0.4, 0, 0.2, 1)`
- 无残留 `Fira Code`/`Fira Sans`/`--nav`/`rgba(52,211,153,...)` 引用

- [ ] **Step 3: 切换 light mode 截图**

点击 sidebar 底部 ThemeSwitcher 切换到 light mode,重复 Step 2 的截图。

确认点:
- 背景为 `#fafaf9`(微暖白)
- 主色为 `#059669`(emerald-600)
- 边框为 `#e4e4e7`(实色,非透明)

- [ ] **Step 4: 检查残留旧引用**

Run: `rg -n "Fira|var\(--nav\)|rgba\(52,211,153" packages/web/src/`
Expected: 无输出(所有旧引用已清除)。

Run: `rg -n "0\.12s" packages/web/src/`
Expected: 无输出。

Run: `rg -n "borderRadius: [0-9]" packages/web/src/`
Expected: 无输出(所有 borderRadius 均使用 `var(--radius)` / `var(--radius-card)`)。

- [ ] **Step 5: 最终 commit(如有修复)**

如验证中发现遗漏,修复后 commit:

```bash
git add -A
git commit -m "fix(ui): clean up remaining old style references"
```

如无遗漏,此步骤跳过。

- [ ] **Step 6: 移除 `--nav` 兼容别名**

确认 Step 4 的 `rg "var\(--nav\)"` 无输出后,从 `index.css` 的 `:root` 和 `[data-theme="dark"]` 块中删除 `--nav: var(--bg);` 别名行(在 Task 2 Step 2b 中添加的)。

```bash
git add packages/web/src/index.css
git commit -m "refactor(ui): remove --nav compatibility alias"
```

---

## Self-Review

### Spec coverage

- 色彩系统(dark/light + agent 色 + 语义色 + 废弃 `--nav`)→ Task 2 Steps 1-2
- 字体系统(Inter + JetBrains Mono + Google Fonts)→ Task 1 + Task 2 Step 3
- 圆角体系(`--radius`/`--radius-card`)→ Task 2 Steps 1-2(定义)+ 各组件步骤(使用)
- 按钮三级变体 → Task 3
- 卡片/面板(含 hover shadow 加深)→ Task 2 Step 7(group + `:hover`),Task 2 Step 13(cfg-table + `:hover`)
- Agent toggle (chip) → Task 2 Step 8(chip 从圆形改为圆角方形)
- Toast(毛玻璃 + 浮动 + 自动消失)→ Task 6(组件)+ Task 8 Step 2(Skills 接入)+ Task 9 Step 2(Mcp 接入)
- Modal(遮罩模糊 + popover 背景)→ Task 5
- 动效(cubic-bezier + translateY/scale + reduced-motion)→ Task 2 Step 14 + Task 2 各步骤 transition
- 主题切换(三态保留)→ Task 7(ThemeSwitcher 样式更新,逻辑不变)
- 迁移策略(一次性全量,`--nav` 废弃)→ Task 2 全量重写 + 各 Task 中 `--nav` → `--bg`;`--nav` 保留为 `var(--bg)` 别名(Task 2 Step 2b)直到 Task 12 Step 6 移除,避免中间提交态视觉破损
- 改动范围(11 个文件,含 1 个新建)→ File Structure 表覆盖
- 不做什么(shadcn CLI/Framer Motion/sonner/Agent 色/后端)→ 全部遵守

### Placeholder scan

- 无 TBD/TODO/"implement later"
- 每个步骤含完整代码块或确切替换指令
- 无 "similar to Task N" — 各 Task 独立完整

### Type consistency

- `--primary`/`--primary-fg` 在 Task 2 定义,Task 3(button)/Task 7(ThemeSwitcher)/Task 8-10(views)一致使用
- `--radius`/`--radius-card` 在 Task 2 定义,后续所有组件一致使用
- `--ease`/`--dur` 在 Task 2 定义,后续所有 transition 一致使用
- `--shadow-card`/`--shadow-card-hover`/`--shadow-popover` 在 Task 2 定义,Task 5(Modal)/Task 6(Toast)/Task 2 Step 7(group + `:hover`)/Step 13(cfg-table + `:hover`)一致使用
- `--popover` 在 Task 2 定义,Task 5(Modal)/Task 6(Toast)一致使用
- `--accent` 在 Task 2 定义,各 hover 态一致使用
- `--ring` 在 Task 2 定义,Task 3(button)/Task 4(tabs)/Task 2 Step 13(cfg-input/textarea focus)一致使用

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-ui-style-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
