# Settings 页面重新设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 Settings 页面,从简陋的平铺列表升级为分类 tab + 三态切换 + group cards + 丰富控件的配置管理界面。

**Architecture:** 前端定义 field schema(字段→控件类型/分组/帮助文本),重写 Settings.tsx 和 ConfigField.tsx 为按控件类型渲染。后端扩展 setConfigField 支持点号路径,GET /config 返回 profiles 列表。

**Tech Stack:** React 18 + TypeScript + Hono(vitest) + CSS 变量 + Inter/JetBrains Mono

---

## File Structure

| 文件                                          | 责任                               |
| --------------------------------------------- | ---------------------------------- |
| `packages/core/src/mutators.ts`               | 扩展 setConfigField 支持点号路径   |
| `packages/core/test/mutators.test.ts`         | 点号路径测试                       |
| `packages/server/src/api/routes/config.ts`    | GET /config 返回 profiles          |
| `packages/server/test/api/routes.test.ts`     | profiles 返回测试                  |
| `packages/web/src/views/Settings.tsx`         | 重写:分类 tab + 三态 + group cards |
| `packages/web/src/components/ConfigField.tsx` | 重写:按控件类型渲染                |
| `packages/web/src/index.css`                  | 新增 settings CSS                  |

---

### Task 1: 扩展 setConfigField 支持点号路径

**Files:**

- Modify: `packages/core/src/mutators.ts:137-150`
- Test: `packages/core/test/mutators.test.ts`

当前 `setConfigField` 只处理顶层字段。需要扩展为支持点号路径(如 `projection.strategy`、`update_check.enabled`、`proxy.http`),用于写入嵌套配置。

规则:

- 点号路径(如 `projection.strategy`):按路径深入嵌套对象,设置叶子值
- 无点号(如 `active_repo`):保持现有行为不变
- value=null 删除:按路径找到叶子并删除;删除后若父对象变空,不删父对象(保留空对象)
- changed 判断:与现有逻辑一致,值相同返回 changed=false

- [ ] **Step 1: Write failing tests for dot-path set**

在 `packages/core/test/mutators.test.ts` 的 `describe('setConfigField', ...)` 块末尾追加:

```typescript
it('sets a nested field via dot path', () => {
  const result = setConfigField({ projection: { strategy: 'link' } }, 'projection.strategy', 'copy')
  expect(result.changed).toBe(true)
  expect(result.data).toEqual({ projection: { strategy: 'copy' } })
})
it('creates intermediate objects when setting a dot path on missing parent', () => {
  const result = setConfigField({}, 'proxy.http', 'http://127.0.0.1:7890')
  expect(result.changed).toBe(true)
  expect(result.data).toEqual({ proxy: { http: 'http://127.0.0.1:7890' } })
})
it('preserves sibling keys when setting a nested field', () => {
  const result = setConfigField({ proxy: { http: 'a', https: 'b' } }, 'proxy.http', 'c')
  expect(result.data).toEqual({ proxy: { http: 'c', https: 'b' } })
})
it('deletes a nested field via dot path when value is null', () => {
  const result = setConfigField({ proxy: { http: 'a', https: 'b' } }, 'proxy.http', null)
  expect(result.changed).toBe(true)
  expect(result.data).toEqual({ proxy: { https: 'b' } })
})
it('returns changed=false when deleting a non-existent nested field', () => {
  const result = setConfigField({ proxy: { https: 'b' } }, 'proxy.http', null)
  expect(result.changed).toBe(false)
})
it('returns changed=false when setting the same nested value', () => {
  const result = setConfigField({ projection: { strategy: 'link' } }, 'projection.strategy', 'link')
  expect(result.changed).toBe(false)
})
it('still handles top-level fields (no dot)', () => {
  const result = setConfigField({ profile: 'default' }, 'active_repo', 'myrepo')
  expect(result.changed).toBe(true)
  expect(result.data.active_repo).toBe('myrepo')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run test/mutators.test.ts -t "setConfigField"`
Expected: FAIL — dot-path tests fail

- [ ] **Step 3: Implement dot-path support in setConfigField**

Replace `setConfigField` in `packages/core/src/mutators.ts` (lines 137-150) with:

```typescript
export function setConfigField(
  config: Record<string, unknown>,
  field: string,
  value: unknown,
): { changed: boolean; data: Record<string, unknown> } {
  const parts = field.split('.')
  if (parts.length === 1) {
    if (value === null) {
      if (!(field in config)) return { changed: false, data: config }
      const rest = { ...config }
      delete rest[field]
      return { changed: true, data: rest }
    }
    if (Object.is(config[field], value)) return { changed: false, data: config }
    return { changed: true, data: { ...config, [field]: value } }
  }

  const [head, ...tail] = parts
  const child = config[head]
  if (value === null) {
    if (child === undefined || typeof child !== 'object' || child === null) {
      return { changed: false, data: config }
    }
    const result = setConfigField(child as Record<string, unknown>, tail.join('.'), null)
    if (!result.changed) return { changed: false, data: config }
    return { changed: true, data: { ...config, [head]: result.data } }
  }
  const base = typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {}
  const result = setConfigField(base, tail.join('.'), value)
  if (!result.changed && head in config) return { changed: false, data: config }
  return { changed: true, data: { ...config, [head]: result.data } }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/mutators.test.ts -t "setConfigField"`
Expected: PASS

- [ ] **Step 5: Run full core test suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mutators.ts packages/core/test/mutators.test.ts
git commit -m "feat(core): setConfigField supports dot-path for nested config fields"
```

---

### Task 2: GET /config 返回 profiles 列表

**Files:**

- Modify: `packages/server/src/api/routes/config.ts:10-17`
- Test: `packages/server/test/api/routes.test.ts`

前端 profile select 下拉需要可用 profile 列表。GET /config 已调用 `loadRepoManifest(files)` 返回 `repoManifest.varsFiles`,其中 keys 就是 profile 名。

- [ ] **Step 1: Write failing test for profiles in config response**

在 `packages/server/test/api/routes.test.ts` 中 config 相关测试块追加:

```typescript
it('GET /config returns profiles list from vars files', async () => {
  const res = await app.request('/config?repoPath=' + encodeURIComponent(repoPath))
  const json = await res.json()
  expect(json.profiles).toBeDefined()
  expect(Array.isArray(json.profiles)).toBe(true)
  expect(json.profiles).toContain('default')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run test/api/routes.test.ts -t "profiles list"`
Expected: FAIL — `json.profiles` is undefined

- [ ] **Step 3: Add profiles to GET /config response**

在 `packages/server/src/api/routes/config.ts` 的 `app.get('/config', ...)` 中修改 return:

```typescript
  app.get('/config', async (c) => {
    const repoPath = c.req.query('repoPath')!
+   const files = await readRepoFiles(deps.fs, repoPath)
+   const repoManifest = loadRepoManifest(files)
+   const localConfig = await readLocalConfig(deps.fs, deps.home)
+   const effective = mergeConfig(repoManifest.repoConfig, localConfig as any)
+   const profiles = Object.keys(repoManifest.varsFiles)
+   return c.json({ effective, repo: repoManifest.repoConfig, local: localConfig, profiles })
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx vitest run test/api/routes.test.ts -t "profiles list"`
Expected: PASS

- [ ] **Step 5: Run full server test suite**

Run: `cd packages/server && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/api/routes/config.ts packages/server/test/api/routes.test.ts
git commit -m "feat(server): GET /config returns available profiles list"
```

---

### Task 3: 新增 Settings CSS 样式

**Files:**

- Modify: `packages/web/src/index.css`

在 index.css 中追加 settings v2 所需的 CSS 类。保留旧类(其他文件可能引用),新增 `.cfg-cat-tabs`、`.cfg-group`、`.cfg-field`、`.help-ico`、`.sdot2` 等。

- [ ] **Step 1: Add new CSS classes**

在 `packages/web/src/index.css` 的 `/* settings */` 块后追加:

```css
/* settings v2 — group cards + rich controls */
.cfg-cat-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  margin-top: 16px;
}
.cfg-cat-tab {
  padding: 9px 18px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  margin-bottom: -1px;
  transition: all var(--dur) var(--ease);
}
.cfg-cat-tab:hover:not(.on) {
  color: var(--text);
}
.cfg-cat-tab.on {
  color: var(--signal);
  border-bottom-color: var(--signal);
}
.cfg-lvl-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
}
.cfg-lvl-label {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.cfg-lvl-sw {
  display: inline-flex;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 3px;
}
.cfg-lvl-opt {
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 7px;
  transition: all var(--dur) var(--ease);
}
.cfg-lvl-opt .dotc {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.cfg-lvl-opt[data-l='merged'] .dotc {
  background: var(--bright);
}
.cfg-lvl-opt[data-l='repo'] .dotc {
  background: #22c55e;
}
.cfg-lvl-opt[data-l='local'] .dotc {
  background: #3b82f6;
}
.cfg-lvl-opt.on {
  background: var(--bg);
  color: var(--bright);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.cfg-lvl-hint {
  font-size: 11px;
  color: var(--muted);
  margin-left: auto;
}
.cfg-group {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow: hidden;
  background: var(--card);
  box-shadow: var(--shadow-card);
}
.cfg-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.cfg-group-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--bright);
}
.cfg-group-desc {
  font-size: 11px;
  color: var(--muted);
}
.cfg-group-body {
  padding: 4px 16px;
}
.cfg-field {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.cfg-field:last-child {
  border-bottom: none;
}
.cfg-field-row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 36px;
}
.cfg-field-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
  min-width: 130px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cfg-field-ctrl {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.help-ico {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--border);
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  cursor: help;
  flex-shrink: 0;
  transition: all var(--dur) var(--ease);
}
.help-ico:hover {
  background: var(--info);
  color: #fff;
}
.help-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--popover);
  color: var(--bright);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.5;
  white-space: normal;
  width: 220px;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.15s,
    visibility 0.15s;
  pointer-events: none;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.help-ico:hover .help-tip {
  opacity: 1;
  visibility: visible;
}
.sdot2 {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
  cursor: default;
  border: 2px solid;
  box-sizing: border-box;
  transition: all 0.12s;
}
.sdot2.repo {
  border-color: #22c55e;
  background: #22c55e;
}
.sdot2.local {
  border-color: #3b82f6;
  background: #3b82f6;
}
.sdot2.inherit {
  border-color: var(--muted);
  background: transparent;
  opacity: 0.5;
}
.sdot2.fixed {
  border-color: #3b82f6;
  background: #3b82f6;
  opacity: 0.6;
}
.cfg-lvl-pane[data-l='local'] .sdot2:not(.fixed) {
  cursor: pointer;
}
.cfg-lvl-pane[data-l='local'] .sdot2.inherit:hover {
  opacity: 1;
  border-color: #3b82f6;
}
.cfg-lvl-pane[data-l='local'] .sdot2.local:hover {
  box-shadow: 0 0 7px #3b82f6;
}
.cfg-ctrl-disabled {
  opacity: 0.5;
  pointer-events: none;
}
.cfg-ctrl-inherited {
  color: var(--muted);
  font-style: italic;
}
.cfg-select {
  flex: 0 1 auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 7px 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  min-width: 0;
  max-width: 200px;
  gap: 8px;
  transition: border-color var(--dur) var(--ease);
}
.cfg-select:hover:not(.cfg-ctrl-disabled) {
  border-color: var(--muted);
}
.cfg-select .caret {
  color: var(--muted);
  font-size: 10px;
}
.cfg-seg {
  display: inline-flex;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2px;
}
.cfg-seg-opt {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  padding: 5px 14px;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.cfg-seg:hover:not(.cfg-ctrl-disabled) .cfg-seg-opt:hover:not(.on) {
  color: var(--text);
}
.cfg-seg-opt.on {
  background: var(--primary);
  color: var(--primary-fg);
  font-weight: 600;
}
.cfg-toggle {
  width: 38px;
  height: 22px;
  border-radius: 11px;
  background: var(--border);
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}
.cfg-toggle.on {
  background: var(--primary);
}
.cfg-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
.cfg-toggle.on::after {
  transform: translateX(16px);
}
.cfg-input {
  flex: 1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 7px 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  min-width: 0;
  max-width: 420px;
  outline: none;
  transition: border-color var(--dur) var(--ease);
}
.cfg-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent);
}
.cfg-input.with-unit {
  max-width: 80px;
  flex: 0 0 auto;
}
.cfg-unit {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--muted);
}
.cfg-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.cfg-chips .achip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  border: 1px solid;
  transition: all var(--dur) var(--ease);
}
.cfg-chips .achip.on {
  color: #fff;
  border-color: transparent;
}
.cfg-chips .achip.off {
  opacity: 0.45;
  background: transparent;
}
.cfg-chips .achip.off:hover {
  opacity: 0.8;
}
.cfg-chips .achip[data-a='cc'].on {
  background: var(--cc);
  border-color: var(--cc);
}
.cfg-chips .achip[data-a='cx'].on {
  background: var(--cx);
  border-color: var(--cx);
}
.cfg-chips .achip[data-a='oc'].on {
  background: var(--oc);
  border-color: var(--oc);
}
.cfg-chips .achip[data-a='cc'].off {
  color: var(--cc);
  border-color: color-mix(in srgb, var(--cc) 45%, transparent);
}
.cfg-chips .achip[data-a='cx'].off {
  color: var(--cx);
  border-color: color-mix(in srgb, var(--cx) 45%, transparent);
}
.cfg-chips .achip[data-a='oc'].off {
  color: var(--oc);
  border-color: color-mix(in srgb, var(--oc) 45%, transparent);
}
.cfg-save-bar {
  position: sticky;
  bottom: 0;
  margin-top: 20px;
  margin-left: -26px;
  margin-right: -26px;
  padding: 14px 26px;
  background: linear-gradient(180deg, transparent, var(--bg) 35%);
  display: flex;
  align-items: center;
  gap: 12px;
}
.cfg-dirty {
  font-size: 11px;
  color: var(--warn);
  display: flex;
  align-items: center;
  gap: 6px;
}
.cfg-dirty .d {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
}
```

- [ ] **Step 2: Verify CSS compiles**

Run: `cd packages/web && npx vite build --mode development 2>&1 | head -5`
Expected: No CSS errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/index.css
git commit -m "style(web): add settings v2 CSS (group cards, rich controls, tooltips)"
```

---

### Task 4: 重写 ConfigField.tsx 为按控件类型渲染

**Files:**

- Modify: `packages/web/src/components/ConfigField.tsx` (complete rewrite)

重写 ConfigField 为接收 field schema 定义、按控件类型渲染的组件。field schema 定义在同文件中导出。

- [ ] **Step 1: Write the new ConfigField.tsx**

Replace entire contents of `packages/web/src/components/ConfigField.tsx` with the following. Key design:

- `FieldSchema` interface defines each field: key (dot path), label, group, control type, options, help text per level
- `FIELD_SCHEMA` array exports all 9 fields with their metadata
- `ConfigField` component renders status dot + label (+ help icon) + control based on type
- Controls: select (display value), segmented (link/copy), toggle (on/off), chips (CC/CX/OC), input, input-unit
- Click-to-save: toggle/segmented/chips call handleSave immediately on click
- Dot click: in local pane, inherit→local creates override, local→inherit deletes override

```tsx
import { useState } from 'react'
import { api } from '@/lib/api'
import { AGENTS, agentShort } from '@/lib/agents'
+import type { AgentId } from '@loom/core'

export type ConfigLevel = 'effective' | 'repo' | 'local'
export type ControlType = 'select' | 'segmented' | 'toggle' | 'chips' | 'input' | 'input-unit'

export interface FieldSchema {
  key: string
  label: string
  group: string
  control: ControlType
  fixed?: boolean
  options?: string[]
  unit?: string
  helpByLevel?: Partial<Record<ConfigLevel, string>>
}

export const FIELD_SCHEMA: FieldSchema[] = [
  { key: 'active_repo', label: 'Active repo', group: 'Workspace', control: 'select', fixed: true,
    helpByLevel: { effective: '本机当前操作的 repo。固定存本地级,不随 git 同步,切换会重建投影', repo: '此字段固定本地级,不进仓库级 config.yaml', local: '切换 repo 会清空当前投影再重建。切换前会弹确认' } },
  { key: 'profile', label: 'Profile', group: 'Workspace', control: 'select',
    helpByLevel: { effective: 'vars profile 覆盖档。投影时从 vars/ 目录取对应 profile 的变量文件', repo: '团队默认 profile。各成员可在本地级覆盖为不同值', local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖' } },
  { key: 'projection.strategy', label: 'Strategy', group: 'Projection', control: 'segmented', options: ['link', 'copy'],
    helpByLevel: { effective: 'link=创建软链到 agent skills 目录(节省空间); copy=复制文件(跨文件系统兼容)', local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖' } },
  { key: 'targets', label: 'Targets', group: 'Projection', control: 'chips',
    helpByLevel: { effective: '投影目标 agent。CC=Claude Code, CX=Codex, OC=OpenCode', local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖' } },
  { key: 'update_check.enabled', label: 'Auto check', group: 'Updates', control: 'toggle',
    helpByLevel: { effective: '开启后按间隔自动检查远程 skill 仓库是否有新版本', repo: '团队默认开关。各成员可在本地级覆盖', local: '当前继承仓库级值。点左圆点可创建本地覆盖' } },
  { key: 'update_check.interval', label: 'Interval', group: 'Updates', control: 'input-unit', unit: 'hours',
    helpByLevel: { effective: '两次检查之间的时间间隔', local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖' } },
  { key: 'proxy.http', label: 'HTTP', group: 'Proxy', control: 'input',
    helpByLevel: { effective: '拉取远程 skill 仓库时使用的 HTTP 代理' } },
  { key: 'proxy.https', label: 'HTTPS', group: 'Proxy', control: 'input',
    helpByLevel: { effective: '拉取远程 skill 仓库时使用的 HTTPS 代理' } },
  { key: 'proxy.no_proxy', label: 'No proxy', group: 'Proxy', control: 'input',
    helpByLevel: { effective: '不走代理的地址列表,逗号分隔', local: '逗号分隔的地址列表,匹配的地址不走代理' } },
]

function dotState(level: ConfigLevel, fixed: boolean, inRepo: boolean, inLocal: boolean): string {
  if (fixed) return 'fixed'
  if (level === 'effective') return inLocal ? 'local' : inRepo ? 'repo' : 'inherit'
  if (level === 'repo') return inRepo ? 'repo' : 'inherit'
  return inLocal ? 'local' : 'inherit'
}

function dotTitle(s: string): string {
  return { fixed: '固定本地级', repo: '仓库级已设', local: '本地级已覆盖 · 点此删除回退', inherit: '继承仓库级 · 点此覆盖' }[s] ?? ''
}

export function ConfigField({ field, level, value, inRepo, inLocal, repoPath, onSaved }: {
  field: FieldSchema; level: ConfigLevel; value: unknown; inRepo: boolean; inLocal: boolean; repoPath: string; onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isFixed = field.fixed === true
  const isReadonly = level === 'effective'
  const isDisabled = isReadonly || (level === 'repo' && isFixed)
  const isInherited = (level === 'local' && !inLocal && !isFixed) || (level === 'repo' && !inRepo && isFixed)
  const ds = dotState(level, isFixed, inRepo, inLocal)
  const help = field.helpByLevel?.[level]
  const canEdit = !isDisabled && !isInherited

  const save = async (v: unknown) => {
    if (level === 'effective') return
    setSaving(true); setErr(null)
    try { await api.putConfig({ repoPath, level: level as 'repo' | 'local', field: field.key, value: v }); setEditing(false); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  const delOverride = async () => {
    setSaving(true); setErr(null)
    try { await api.putConfig({ repoPath, level: 'local', field: field.key, value: null }); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  const dotClick = () => {
    if (level !== 'local' || isFixed) return
    if (ds === 'inherit') save(value)
    else if (ds === 'local') delOverride()
  }

  const ctrlDisabled = isDisabled || isInherited
  const inheritedCls = isInherited ? ' cfg-ctrl-inherited' : ''

  const startEdit = () => { setEditing(true); setEditValue(value != null ? String(value) : '') }

  // Click-to-save for interactive controls
  const onControlClick = (newValue: unknown) => { if (canEdit) save(newValue) }
  const toggleChip = (agent: string) => {
    const cur = Array.isArray(value) ? value as string[] : []
    onControlClick(cur.includes(agent) ? cur.filter(a => a !== agent) : [...cur, agent])
  }

  return (
    <div className="cfg-field">
      <div className="cfg-field-row">
        <span className={'sdot2 ' + ds} title={dotTitle(ds)} onClick={dotClick} />
        <span className="cfg-field-label">
          {field.label}
          {help && <span className="help-ico">?<span className="help-tip">{help}</span></span>}
        </span>
        <div className={'cfg-field-ctrl' + (ctrlDisabled ? ' cfg-ctrl-disabled' : '')}>
          {field.control === 'select' && (
            <div className={'cfg-select' + (ctrlDisabled ? ' cfg-ctrl-disabled' : '') + inheritedCls}>
              {(value as string) || '— 未设置'} <span className="caret">▼</span>
            </div>
          )}
          {field.control === 'segmented' && (
            <div className={'cfg-seg' + (ctrlDisabled ? ' cfg-ctrl-disabled' : '')}>
              {(field.options ?? []).map(opt => (
                <div key={opt} className={'cfg-seg-opt' + (value === opt ? ' on' : '')} onClick={() => onControlClick(opt)}>{opt}</div>
              ))}
            </div>
          )}
          {field.control === 'toggle' && (
            <div className={'cfg-toggle' + (value === true ? ' on' : '') + (ctrlDisabled ? ' cfg-ctrl-disabled' : '')} onClick={() => onControlClick(!value)} />
          )}
          {field.control === 'chips' && (
            <div className={'cfg-chips' + (ctrlDisabled ? ' cfg-ctrl-disabled' : '')}>
              {AGENTS.map(agent => {
                const on = Array.isArray(value) && (value as string[]).includes(agent)
                const da = agent === 'claude-code' ? 'cc' : agent === 'codex' ? 'cx' : 'oc'
                return <span key={agent} className={'achip ' + (on ? 'on' : 'off')} data-a={da} onClick={() => toggleChip(agent)}>{agentShort[agent]}</span>
              })}
            </div>
          )}
          {field.control === 'input-unit' && (editing ? (
            <>
              <input className="cfg-input with-unit" value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus />
              <span className="cfg-unit">{field.unit}</span>
              <button className="gbtn" onClick={() => save(editValue || null)} disabled={saving}>{saving ? '...' : '✓'}</button>
              <button className="gbtn" onClick={() => { setEditing(false); setErr(null) }}>✕</button>
              {err && <span style={{ fontSize: 11, color: 'var(--error)' }}>{err}</span>}
            </>
          ) : (
            <>
              <span className={'cfg-input with-unit' + inheritedCls} style={{ border: 'none', cursor: canEdit ? 'pointer' : 'default' }} onClick={canEdit ? startEdit : undefined}>{value != null ? String(value) : '—'}</span>
              <span className="cfg-unit">{field.unit}</span>
            </>
          ))}
          {field.control === 'input' && (editing ? (
            <>
              <input className="cfg-input" value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus />
              <button className="gbtn" onClick={() => save(editValue || null)} disabled={saving}>{saving ? '...' : '✓'}</button>
              <button className="gbtn" onClick={() => { setEditing(false); setErr(null) }}>✕</button>
              {err && <span style={{ fontSize: 11, color: 'var(--error)' }}>{err}</span>}
            </>
          ) : (
            <span className={'cfg-input' + inheritedCls} style={{ border: 'none', cursor: canEdit ? 'pointer' : 'default', maxWidth: '420px' }} onClick={canEdit ? startEdit : undefined}>
              {value != null ? String(value) : (isInherited ? '' : '— 未设置')}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors in ConfigField.tsx

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/ConfigField.tsx
git commit -m "feat(web): rewrite ConfigField with typed controls (select/seg/toggle/chips/input)"
```

---

### Task 5: 重写 Settings.tsx

**Files:**

- Modify: `packages/web/src/views/Settings.tsx` (complete rewrite)

重写 Settings 页面:分类 tab(通用/网络) + 三态切换 + group cards + field schema 渲染。

- [ ] **Step 1: Write the new Settings.tsx**

Replace entire contents of `packages/web/src/views/Settings.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { ConfigField, FIELD_SCHEMA, type ConfigLevel } from '@/components/ConfigField'
import { useViewError } from '@/hooks/useViewError'

type Config = Record<string, unknown>
interface ConfigResponse {
  effective: Config
  repo: Config
  local: Config
  profiles?: string[]
}

const CATEGORY_TABS = [
  { id: 'general', label: '通用', groups: ['Workspace', 'Projection', 'Updates'] },
  { id: 'network', label: '网络', groups: ['Proxy'] },
] as const

const LEVEL_HINTS: Record<ConfigLevel, string> = {
  effective: '生效值 + 来源;改值请切到对应级',
  repo: '编辑团队共享默认(随 git 同步);无值的字段占位',
  local: '编辑本机覆盖(不同步);未覆盖字段继承 repo,编辑即覆盖',
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function hasPath(obj: Record<string, unknown>, path: string): boolean {
  return getPath(obj, path) !== undefined
}

export default function Settings({ repoPath }: { repoPath: string }) {
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  const { error, setError } = useViewError()
  const [level, setLevel] = useState<ConfigLevel>('effective')
  const [catTab, setCatTab] = useState<string>('general')

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .getConfig(repoPath)
      .then((c) => {
        if (!cancelled) setCfg(c as ConfigResponse)
      })
      .catch((e) => {
        if (!cancelled) setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const reload = () => {
    api
      .getConfig(repoPath)
      .then((c) => setCfg(c as ConfigResponse))
      .catch((e) => setError(e))
  }

  if (error)
    return (
      <div className="p-4" style={{ color: 'var(--error)' }}>
        配置加载失败:{error}
      </div>
    )
  if (!cfg) return <div className="p-4">加载中…</div>

  const activeCat = CATEGORY_TABS.find((t) => t.id === catTab)!
  const fieldsInTab = FIELD_SCHEMA.filter((f) => activeCat.groups.includes(f.group))
  const levelData = level === 'effective' ? cfg.effective : level === 'repo' ? cfg.repo : cfg.local
  const groupDesc =
    level === 'effective'
      ? '最终结果 · 生效值'
      : level === 'repo'
        ? '仓库级 · 随 git 同步'
        : '本地级 · 优先级最高 · 编辑或点左圆点覆盖'

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">
          仓库级 &lt;repo&gt;/config.yaml(同步) + 本地级 ~/.loom/config.yaml(不同步,覆盖)
        </p>
      </div>
      <div className="cfg-cat-tabs">
        {CATEGORY_TABS.map((tab) => (
          <div
            key={tab.id}
            className={'cfg-cat-tab' + (catTab === tab.id ? ' on' : '')}
            onClick={() => setCatTab(tab.id)}
          >
            {tab.label}
          </div>
        ))}
      </div>
      <div className="cfg-lvl-bar">
        <span className="cfg-lvl-label">view</span>
        <div className="cfg-lvl-sw">
          {(['effective', 'repo', 'local'] as ConfigLevel[]).map((l) => (
            <div
              key={l}
              className={'cfg-lvl-opt' + (level === l ? ' on' : '')}
              data-l={l === 'effective' ? 'merged' : l}
              onClick={() => setLevel(l)}
            >
              <span className="dotc" />
              {l === 'effective' ? '最终结果' : l === 'repo' ? '仓库级' : '本地级'}
            </div>
          ))}
        </div>
        <span className="cfg-lvl-hint">{LEVEL_HINTS[level]}</span>
      </div>
      <div className="cfg-lvl-pane" data-l={level === 'effective' ? 'merged' : level}>
        {activeCat.groups.map((gName) => {
          const gFields = fieldsInTab.filter((f) => f.group === gName)
          if (!gFields.length) return null
          return (
            <div key={gName} className="cfg-group">
              <div className="cfg-group-head">
                <span className="cfg-group-title">{gName}</span>
                <span className="cfg-group-desc">{groupDesc}</span>
              </div>
              <div className="cfg-group-body">
                {gFields.map((field) => (
                  <ConfigField
                    key={field.key}
                    field={field}
                    level={level}
                    value={getPath(levelData, field.key)}
                    inRepo={hasPath(cfg.repo, field.key)}
                    inLocal={hasPath(cfg.local, field.key)}
                    repoPath={repoPath}
                    onSaved={reload}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div className="cfg-save-bar">
        <span className="cfg-dirty">
          <span className="d" />
          仓库级改动会随下次上传同步
        </span>
        <button
          className="btn btn-ghost"
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '7px 16px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          放弃
        </button>
        <button
          className="btn btn-primary"
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '7px 16px',
            borderRadius: 'var(--radius)',
            border: 'none',
            background: 'var(--primary)',
            color: 'var(--primary-fg)',
            cursor: 'pointer',
            marginLeft: 'auto',
          }}
        >
          保存
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Run dev server and visually verify**

Run: `pnpm dev`
Open http://localhost:5173/settings
Expected: Settings page renders with category tabs, level switch, group cards, rich controls

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/Settings.tsx
git commit -m "feat(web): rewrite Settings with category tabs, level switch, group cards"
```

---

### Task 6: 最终集成验证与清理

**Files:**

- Verify: all changed files
- Clean up: remove old unused CSS

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript check across all packages**

Run: `pnpm -r exec tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run dev server and verify full page**

Run: `pnpm dev`
Open http://localhost:5173/settings
Verify:

- 分类 tab 切换(通用/网络)正常
- 三态切换(最终结果/仓库级/本地级)正常,行高不跳
- 最终结果:所有控件 disabled,圆点显示来源
- 仓库级:可编辑,active_repo 显示"仅本地级"
- 本地级:可编辑,继承字段置灰,点圆点切换覆盖/继承
- 帮助 tooltip hover 正常显示
- 亮色/暗色都正常

- [ ] **Step 4: Remove old unused CSS**

在 `packages/web/src/index.css` 中,用 `rg "sdot-cfg|cfg-table|cfg-thead|cfg-row|cfg-cell|cfg-name|cfg-dot|src-badge|cfg-edit-wrap|cfg-textarea|cfg-err\b|cfg-hint\b" packages/web/src/**/*.tsx` 确认这些旧类不再被引用。

如果无引用,删除旧的 `/* settings */` 块中被新 CSS 完全替代的类:

- `.sdot-cfg` 及变体(被 `.sdot2` 替代)
- `.cfg-table`、`.cfg-thead`、`.cfg-tbody`、`.cfg-row`(被 `.cfg-group` 等替代)
- `.cfg-cell`、`.cfg-name`、`.cfg-dot`、`.cfg-value`(被新组件结构替代)
- `.cfg-source`、`.src-badge`(不再使用)
- `.cfg-edit-wrap`、`.cfg-textarea`、`.cfg-err`、`.cfg-hint`(不再使用)

保留仍在使用的类(如 `.gbtn`、`.add-btn`、`.label` 等)。

- [ ] **Step 5: Final commit**

```bash
git add packages/web/src/index.css
git commit -m "chore(web): remove old settings CSS replaced by v2 styles"
```
