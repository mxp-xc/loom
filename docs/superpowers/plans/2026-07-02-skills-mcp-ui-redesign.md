# Skills & MCP UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Skills and MCP pages with unified buttons, improved typography, collapsible groups, refactored Add Skill modal with auto-scan/search, configurable skill naming, and source type/version support.

**Architecture:** Backend-first: extend core types, add git ls-remote branches API, local skill scan/import APIs. Then frontend: install lucide-react, unify all buttons to Button component, refactor AddSkillModal, add EditSourceModal, make groups collapsible, implement configurable skillId format.

**Tech Stack:** React 18, Hono, pnpm workspaces, Tailwind CSS v4, class-variance-authority, lucide-react (new), simple-git, tinyglobby, vitest

**Spec:** `docs/superpowers/specs/2026-07-02-skills-mcp-ui-redesign-design.md`

---

## File Structure

### Core

- Modify `types.ts` — Add `type` to `SkillSource`, `skill_naming` to `Config`
- Modify `projection.ts` — `planProjection` reads `config.skill_naming` to format skillId
- Modify `mutators.ts` — `addSource` accepts optional `type` field

### Server

- Modify `ports/git.ts` — `lsRemote` returns `branches` array
- Modify `platform/node/git.ts` — Parse `refs/heads/` in lsRemote output
- Modify `ports/fs.ts` — Add `move(src, dest)` method
- Modify `platform/node/fs.ts` — Implement `move` via `fs.rename`
- Modify `api/routes/remote.ts` — Add `POST /sources/refs` endpoint
- Modify `api/routes/skills-yaml.ts` — Add `POST /skills/local/scan` and `POST /skills/local/import`
- Modify `projection/scan.ts` — `resolveFullLinks` reads `config.skill_naming`
- Modify `api/routes/projection.ts` — Skill content path uses `~/.agents/skills`

### Web

- Modify `lib/api.ts` — Add `getSourceRefs`, `scanLocalSkills`, `importLocalSkills`
- Modify `views/skills/Skills.tsx` — Replace `add-btn` with `Button`, pass edit state
- Modify `views/skills/SkillSourceList.tsx` — Collapsible groups, skill name only, type badge, Edit, ref badge
- Modify `views/skills/AddSkillModal.tsx` — Full rewrite: Local tab + Source tab
- Create `views/skills/EditSourceModal.tsx` — Edit source metadata
- Modify `views/Mcp.tsx` — Replace inline buttons with `Button`
- Modify `index.css` — Font size/color fixes, new classes
- Modify `views/skills/types.ts` — Add scan result types

### Tests

- Modify `packages/core/test/projection.test.ts` — skill_naming config tests
- Modify `packages/core/test/types.test.ts` — Test new type fields
- Modify `packages/server/test/platform/node/git.test.ts` — lsRemote branches test

---

### Task 1: Core types — add `type` to SkillSource, `skill_naming` to Config

**Files:**

- Modify: `packages/core/src/types.ts`
- Test: `packages/core/test/types.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { SkillSource, Config } from '../src/types'

describe('SkillSource type field', () => {
  it('accepts type: "branch"', () => {
+    const src: SkillSource = { url: 'https://github.com/org/repo', ref: 'main', type: 'branch' }
+    expect(src.type).toBe('branch')
+  })
+  it('accepts type: "tag"', () => {
+    const src: SkillSource = { url: 'https://github.com/org/repo', ref: 'v1.0', type: 'tag' }
+    expect(src.type).toBe('tag')
+  })
+  it('type is optional', () => {
+    const src: SkillSource = { url: 'https://github.com/org/repo', ref: 'main' }
+    expect(src.type).toBeUndefined()
+  })
+})
+
+describe('Config skill_naming field', () => {
+  it('accepts skill_naming: "dir"', () => {
+    const cfg: Config = { skill_naming: 'dir' }
+    expect(cfg.skill_naming).toBe('dir')
+  })
+  it('accepts skill_naming: "hyphen"', () => {
+    const cfg: Config = { skill_naming: 'hyphen' }
+    expect(cfg.skill_naming).toBe('hyphen')
+  })
+})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loom/core test -- --run types.test`
Expected: FAIL

- [ ] **Step 3: Add fields to types**

In `packages/core/src/types.ts`, add `type?: 'branch' | 'tag'` to `SkillSource` (after `ref`).
Add `skill_naming?: 'dir' | 'hyphen'` to `Config` (after `proxy`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @loom/core test -- --run types.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/types.test.ts
git commit -m "feat(core): add type to SkillSource, skill_naming to Config"
```

---

### Task 2: Core projection — skillId format based on config.skill_naming

**Files:**

- Modify: `packages/core/src/projection.ts`
- Test: `packages/core/test/projection.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/projection.test.ts`:

```typescript
describe('planProjection skill_naming', () => {
  it('dir format produces repoId/memberName skillId', () => {
+    const m = { ...manifest, config: { ...manifest.config, skill_naming: 'dir' as const } }
+    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
+    const link = p.links.find((l) => l.source !== 'local' && (l.source as any).memberName === 'brainstorming')
+    expect(link!.skillId).toBe('superpowers/brainstorming')
+  })
+  it('hyphen format produces repoId-memberName skillId', () => {
+    const m = { ...manifest, config: { ...manifest.config, skill_naming: 'hyphen' as const } }
+    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
+    const link = p.links.find((l) => l.source !== 'local' && (l.source as any).memberName === 'brainstorming')
+    expect(link!.skillId).toBe('superpowers-brainstorming')
+  })
+  it('defaults to dir format when unset', () => {
+    const m = { ...manifest, config: { ...manifest.config } }
+    delete (m.config as any).skill_naming
+    const p = planProjection(m, m.config, new Set(['claude-code', 'codex', 'opencode']))
+    const link = p.links.find((l) => l.source !== 'local' && (l.source as any).memberName === 'brainstorming')
+    expect(link!.skillId).toBe('superpowers/brainstorming')
+  })
+})
```

Also update the existing manifest at the top of the test file to include `skill_naming: 'hyphen'` in config so existing tests still pass:

```typescript
config: { targets: ['claude-code', 'codex', 'opencode'], projection: { strategy: 'link' }, skill_naming: 'hyphen' },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @loom/core test -- --run projection.test`
Expected: FAIL

- [ ] **Step 3: Update planProjection**

In `packages/core/src/projection.ts`, in `planProjection`, add `const naming = effectiveConfig.skill_naming ?? 'dir'` at the top, then change the skillId line in the source member loop from:

```typescript
skillId: `${repoId}-${m.name}`,
```

to:

```typescript
skillId: naming === 'hyphen' ? `${repoId}-${m.name}` : `${repoId}/${m.name}`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @loom/core test -- --run projection.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection.ts packages/core/test/projection.test.ts
git commit -m "feat(core): skillId format based on config.skill_naming"
```

---

### Task 3: Server — lsRemote returns branches

**Files:**

- Modify: `packages/server/src/ports/git.ts`
- Modify: `packages/server/src/platform/node/git.ts`
- Test: `packages/server/test/platform/node/git.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/platform/node/git.test.ts`:

```typescript
  it('lsRemote returns branches and tags', async () => {
+    const git = new NodeGit()
+    const result = await git.lsRemote(bare)
+    expect(result.head).toBeTruthy()
+    expect(result.branches).toContain('main')
+    expect(result.tags['v1.0.0']).toBeTruthy()
+  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @loom/server test -- --run git.test`
Expected: FAIL — `branches` undefined

- [ ] **Step 3: Update IGit interface**

In `packages/server/src/ports/git.ts`, change lsRemote return type to:

```typescript
lsRemote(url: string): Promise<{ tags: Record<string, string>; head: string; branches: string[] }>
```

- [ ] **Step 4: Update NodeGit.lsRemote**

In `packages/server/src/platform/node/git.ts`, add `branches` parsing. After the `head` check and before the `tags` check, add:

```typescript
else if (ref?.startsWith('refs/heads/')) {
  branches.push(ref.slice('refs/heads/'.length))
}
```

Add `const branches: string[] = []` at the top of the method, and include `branches` in the return object.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @loom/server test -- --run git.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ports/git.ts packages/server/src/platform/node/git.ts packages/server/test/platform/node/git.test.ts
git commit -m "feat(server): lsRemote returns branches array"
```

---

### Task 4: Server — POST /sources/refs endpoint + frontend API

**Files:**

- Modify: `packages/server/src/api/routes/remote.ts`
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add the endpoint**

In `packages/server/src/api/routes/remote.ts`, add after the `/sources/refresh` route inside `createRemoteRoutes`:

```typescript
  app.post('/sources/refs', async (c) => {
+    try {
+      const { url } = await c.req.json()
+      if (!url || typeof url !== 'string') return c.json({ ok: false, error: 'invalid_url' }, 400)
+      const result = await deps.git.lsRemote(url)
+      return c.json({ ok: true, branches: result.branches, tags: Object.keys(result.tags).sort().reverse() })
+    } catch (e) {
+      return c.json({ ok: false, error: 'refs_failed', message: String((e as Error)?.message ?? e) })
+    }
+  })
```

- [ ] **Step 2: Add frontend API method**

In `packages/web/src/lib/api.ts`, add to the `api` object after `scanSource`:

```typescript
  getSourceRefs: (url: string) =>
+    post('/sources/refs', { url }).then(json) as Promise<{
+      ok: boolean; branches: string[]; tags: string[]; error?: string; message?: string
+    }>,
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @loom/server build && pnpm --filter @loom/web build`

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/api/routes/remote.ts packages/web/src/lib/api.ts
git commit -m "feat(server): POST /sources/refs lists branches and tags"
```

---

### Task 5: Server — IFileSystem.move + local scan/import APIs

**Files:**

- Modify: `packages/server/src/ports/fs.ts`
- Modify: `packages/server/src/platform/node/fs.ts`
- Modify: `packages/server/src/api/routes/skills-yaml.ts`
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add `move` to IFileSystem**

In `packages/server/src/ports/fs.ts`, add: `move(src: string, dest: string): Promise<void>`

- [ ] **Step 2: Implement `move` in NodeFileSystem**

In `packages/server/src/platform/node/fs.ts`, add method (ensure `rename` and `mkdir` imported from `node:fs/promises`, `dirname` from `node:path`):

```typescript
async move(src: string, dest: string): Promise<void> {
+  await mkdir(dirname(dest), { recursive: true })
+  await rename(src, dest)
+}
```

- [ ] **Step 3: Add /skills/local/scan endpoint**

In `packages/server/src/api/routes/skills-yaml.ts`, add inside `createSkillsYamlRoutes`:

```typescript
  app.post('/skills/local/scan', async (c) => {
+    try {
+      const { dir } = await c.req.json()
+      if (!dir) return c.json({ ok: false, error: 'invalid_dir' }, 400)
+      const { glob } = await import('tinyglobby')
+      const { basename, dirname, join } = await import('node:path')
+      const resolvedDir = dir.replace(/^~/, deps.home)
+      if (!(await deps.fs.exists(resolvedDir))) return c.json({ ok: true, skills: [] })
+      const matches = await glob('**/SKILL.md', { cwd: resolvedDir, ignore: ['**/.git/**', '**/node_modules/**'], onlyFiles: true })
+      const skills = matches.map((m) => ({ name: basename(dirname(m)), path: join(resolvedDir, dirname(m)) })).sort((a, b) => a.name.localeCompare(b.name))
+      return c.json({ ok: true, skills })
+    } catch (e) {
+      return c.json({ ok: false, error: 'scan_failed', message: String((e as Error)?.message ?? e) })
+    }
+  })
```

- [ ] **Step 4: Add /skills/local/import endpoint**

In the same file, add:

```typescript
  app.post('/skills/local/import', async (c) => {
+    try {
+      const { repoPath, skills, mode } = await c.req.json()
+      if (!Array.isArray(skills)) return c.json({ ok: false, error: 'invalid_skills' }, 400)
+      const agentsSkillsDir = join(deps.home, '.agents', 'skills')
+      const filePath = join(repoPath, 'skills.yaml')
+      const data = (await readYaml(deps.fs, filePath)) ?? { sources: [], skills: [] }
+      for (const skill of skills) {
+        if (mode === 'move') {
+          const dest = join(agentsSkillsDir, skill.name)
+          await deps.fs.move(skill.path, dest)
+          const result = addLocalSkill(data, { id: skill.name })
+          if (result.changed) Object.assign(data, result.data)
+        } else {
+          const result = addLocalSkill(data, { id: skill.name, path: skill.path })
+          if (result.changed) Object.assign(data, result.data)
+        }
+      }
+      await writeYaml(deps.fs, filePath, data)
+      return c.json({ ok: true, count: skills.length })
+    } catch (e) {
+      return c.json({ ok: false, error: 'import_failed', message: String((e as Error)?.message ?? e) })
+    }
+  })
```

- [ ] **Step 5: Add frontend API methods**

In `packages/web/src/lib/api.ts`, add to `api` object:

```typescript
  scanLocalSkills: (dir: string) =>
+    post('/skills/local/scan', { dir }).then(json) as Promise<{
+      ok: boolean; skills: Array<{ name: string; path: string }>; error?: string; message?: string
+    }>,
+  importLocalSkills: (body: { repoPath: string; skills: Array<{ name: string; path: string }>; mode: 'move' | 'ref' }) =>
+    post('/skills/local/import', body).then(json) as Promise<{ ok: boolean; count?: number }>,
```

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @loom/server build && pnpm --filter @loom/web build`

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/ports/fs.ts packages/server/src/platform/node/fs.ts packages/server/src/api/routes/skills-yaml.ts packages/web/src/lib/api.ts
git commit -m "feat(server): local skill scan/import APIs + IFileSystem.move"
```

---

### Task 6: Server — scan.ts resolveFullLinks skillId format

**Files:**

- Modify: `packages/server/src/projection/scan.ts`

- [ ] **Step 1: Update resolveFullLinks**

In `packages/server/src/projection/scan.ts`, in `resolveFullLinks`, add `const naming = effectiveConfig.skill_naming ?? 'dir'` near the top, then change the skillId line from:

```typescript
skillId: `${repoId}-${m.name}`,
```

to:

```typescript
skillId: naming === 'hyphen' ? `${repoId}-${m.name}` : `${repoId}/${m.name}`,
```

- [ ] **Step 2: Run existing scan tests**

Run: `pnpm --filter @loom/server test -- --run scan.test`
Expected: PASS (update test config to include `skill_naming: 'hyphen'` if any test checks skillId format)

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/projection/scan.ts
git commit -m "feat(server): resolveFullLinks uses skill_naming config"
```

---

### Task 7: Server — projection routes local skill path

**Files:**

- Modify: `packages/server/src/api/routes/projection.ts`

- [ ] **Step 1: Update skill content path resolution**

In `packages/server/src/api/routes/projection.ts`, in both `GET /skill/content` and `PUT /skill/content` handlers, change the local skill fallback from:

```typescript
skillDir = join(repoPath, 'assets', 'skills', skillId)
```

to:

```typescript
const agentsDir = join(deps.home, '.agents', 'skills', skillId)
if (await deps.fs.exists(agentsDir)) {
  skillDir = agentsDir
} else {
  skillDir = join(repoPath, 'assets', 'skills', skillId)
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @loom/server build`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api/routes/projection.ts
git commit -m "feat(server): skill content resolves from ~/.agents/skills"
```

---

### Task 8: Web — Install lucide-react + update types

**Files:**

- Modify: `packages/web/package.json`
- Modify: `packages/web/src/views/skills/types.ts`

- [ ] **Step 1: Install lucide-react**

Run: `pnpm --filter @loom/web add lucide-react`

- [ ] **Step 2: Update types.ts**

Add `LocalScanResult` and `SourceRef` interfaces to `packages/web/src/views/skills/types.ts`:

```typescript
export interface LocalScanResult {
  name: string
  path: string
}

export interface SourceRef {
  url: string
  type: 'branch' | 'tag'
  ref: string
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @loom/web build`

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json packages/web/src/views/skills/types.ts
git commit -m "feat(web): install lucide-react, add scan result types"
```

---

### Task 9: Web — CSS font size and color fixes

**Files:**

- Modify: `packages/web/src/index.css`

- [ ] **Step 1: Add --m2 variable and fix font sizes**

In `packages/web/src/index.css`:

1. Add `--m2: #71717a;` to `:root` and `--m2: #8b8b94;` to `[data-theme='dark']`

2. Change these font sizes/colors:

- `.sname`: `font-size: 12px` -> `13px`
- `.sstate`: `font-size: 10px` -> `11px`
- `.gbtn`: `font-size: 10px` -> `11px`, `color: var(--muted)` -> `var(--m2)`
- `.hint`: `font-size: 11px` -> `12px`, `color: var(--muted)` -> `var(--m2)`
- `.legend .lg`: `font-size: 11px` -> `12px`, `color: var(--muted)` -> `var(--m2)`
- `.page-sub`: `color: var(--muted)` -> `var(--m2)`

3. Add new classes:

```css
.ref-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--radius);
  background: rgba(251, 191, 36, 0.1);
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
}
.skill-missing-path {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--warn);
  opacity: 0.8;
  padding: 0 14px 6px 36px;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @loom/web build`

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/index.css
git commit -m "style(web): fix font sizes and colors for readability"
```

---

### Task 10: Web — Skills page Button unification + SkillSourceList refactor

**Files:**

- Modify: `packages/web/src/views/skills/Skills.tsx`
- Modify: `packages/web/src/views/skills/SkillSourceList.tsx`

This is the largest task. Key changes:

1. Replace all `add-btn`/`gbtn` buttons with `Button` component + lucide icons
2. Make groups collapsible (chevron rotation, click group head)
3. Show only skill member name (not `repoId-` prefix)
4. Add type badge (branch/tag) in group head
5. Add Edit button in group head
6. Add ref badge + path display for local skills with path
7. Remove `./assets/skills` from local group head

- [ ] **Step 1: Update Skills.tsx**

Add imports: `import { Button } from '@/components/ui/button'`, `import { Plus, RefreshCw } from 'lucide-react'`, `import EditSourceModal from './EditSourceModal'`

Add state: `const [editSource, setEditSource] = useState<SkillSource | null>(null)`

Replace header buttons with:

```tsx
<Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
  <Plus className="h-3.5 w-3.5" />Add skill
</Button>
<Button variant="secondary" size="sm" onClick={project} disabled={projecting}>
  <RefreshCw className="h-3.5 w-3.5" />{projecting ? '投影中…' : '投影'}
</Button>
```

Pass `onOpenEdit={setEditSource}` to SkillSourceList.

Render `<EditSourceModal>` at bottom.

- [ ] **Step 2: Rewrite SkillSourceList.tsx**

Key changes to the component:

- Add `onOpenEdit: (src: SkillSource) => void` to Props
- Add `const [collapsed, setCollapsed] = useState<Set<string>>(new Set())`
- Add `toggleCollapse(key)` function
- Replace `<span className="arrow">▼</span>` with `<ChevronDown>` icon with rotation transform based on collapsed state
- Replace `<button className="gbtn">` with `<Button variant="ghost" size="sm">`
- Replace `<button className="gbtn">⋯</button>` with `<Button variant="ghost" size="sm"><MoreHorizontal /></Button>`
- Change skill name from `${repoId}-${m.name}` to just `m.name`
- Pass `skillId: m.name` (not `${repoId}-${m.name}`) to onOpenDetail
- Add type badge next to repo name: if `src.type === 'tag'` show purple badge, else blue 'branch' badge
- Add `<Button variant="ghost" size="sm"><Pencil /></Button>` Edit button calling `onOpenEdit(src)`
- Wrap group head onClick with toggleCollapse, stopPropagation on action buttons
- For local skills: if `s.path` is set, show `<span className="ref-badge">ref</span>` and `<div className="skill-missing-path">→ {s.path}</div>` below the row
- Remove `./assets/skills` from local group head

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @loom/web build`
Note: EditSourceModal doesn't exist yet. Create a minimal placeholder:

```tsx
export default function EditSourceModal({ source, onClose }: any) {
  if (!source) return null
  return null // placeholder, implemented in Task 12
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/skills/Skills.tsx packages/web/src/views/skills/SkillSourceList.tsx packages/web/src/views/skills/EditSourceModal.tsx
git commit -m "feat(web): Button unification, collapsible groups, skill name only, type badge, Edit button"
```

---

### Task 11: Web — Rewrite AddSkillModal (Local tab + Source tab)

**Files:**

- Modify: `packages/web/src/views/skills/AddSkillModal.tsx`

Full rewrite. See spec section 4 and 5 for detailed UI. Key implementation points:

**Local tab:**

- Path input (default `~/.agents/skills/`) + Browse button
- Auto-scan on open and on path change (blur)
- Search box filtering scan results
- Checkbox list of discovered skills
- Import mode radio (move/ref) — only shown when path is NOT `~/.agents/skills/`
- When path IS `~/.agents/skills/`, import mode is always 'ref' (no move needed)
- Submit calls `api.importLocalSkills({ repoPath, skills, mode })`

**Source tab:**

- URL input, auto-fetch refs on blur
- Type segmented control (branch/tag)
- Ref dropdown populated from `api.getSourceRefs(url)` — branches or tags depending on type
- Scan button calls `api.scanSource(url)`
- Search box + checkbox list
- Submit calls `api.addSource({ repoPath, url, ref })`

- [ ] **Step 1: Rewrite AddSkillModal.tsx**

Replace entire file. Use `api.scanLocalSkills`, `api.importLocalSkills`, `api.getSourceRefs`, `api.scanSource`, `api.addSource`. Import `Search`, `FolderOpen`, `RefreshCw` from lucide-react. Use `Button` component for all buttons.

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @loom/web build`

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/skills/AddSkillModal.tsx
git commit -m "feat(web): rewrite AddSkillModal with Local scan + Source ref dropdown"
```

---

### Task 12: Web — Create EditSourceModal

**Files:**

- Create: `packages/web/src/views/skills/EditSourceModal.tsx` (replace placeholder)

- [ ] **Step 1: Implement EditSourceModal**

Full implementation replacing the placeholder from Task 10. The modal:

- Opens when `source` is not null
- Pre-fills url/type/ref from source
- Fetches refs on open via `api.getSourceRefs(source.url)`
- Scans members on open via `api.scanSource(source.url)`
- Allows editing type (branch/tag), ref (dropdown), and selecting members
- Save calls `api.setSourceMembers({ repoPath, url, members })`
- Uses `Button` component, lucide icons (`RefreshCw`, `Search`)

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @loom/web build`

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/skills/EditSourceModal.tsx
git commit -m "feat(web): implement EditSourceModal for editing source metadata"
```

---

### Task 13: Web — MCP page Button unification

**Files:**

- Modify: `packages/web/src/views/Mcp.tsx`

- [ ] **Step 1: Replace inline buttons with Button component**

Add imports: `import { Button } from '@/components/ui/button'`, `import { Plus, RefreshCw, Trash2, Copy, Check } from 'lucide-react'`

Replace:

- Header `+ Add server` and `投影` buttons with `<Button variant="primary" size="sm">` and `<Button variant="secondary" size="sm">`
- Copy button: `<Button variant="ghost" size="sm">` with `Copy`/`Check` icons
- Delete button: `<Button variant="ghost" size="sm" style={{ color: 'var(--error)' }}>` with `Trash2` icon
- Modal submit: `<Button variant="primary" style={{ width: '100%' }}>`
- Remove inline `ClipboardIcon` and `CheckIcon` SVG components

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @loom/web build`

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/Mcp.tsx
git commit -m "feat(web): MCP page Button unification with lucide-react icons"
```

---

### Task 14: Verify — Build, test, and manual check

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass. Fix any projection test that expects hyphen format by adding `skill_naming: 'hyphen'` to test config.

- [ ] **Step 2: Build all packages**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 3: Start dev server and manual check**

Run: `pnpm dev`

Verify in browser:

1. Skills page: buttons use Button component with lucide icons
2. Skills page: skill names show only member name (no prefix)
3. Skills page: groups are collapsible (click group head)
4. Skills page: source type badge visible (branch/tag)
5. Skills page: Edit button opens EditSourceModal
6. Skills page: local skills with path show ref badge and path below
7. Add Skill Local tab: auto-scans ~/.agents/skills/, shows checkbox list, search works
8. Add Skill Source tab: type toggle, ref dropdown populated, Scan works, search works
9. MCP page: buttons use Button component
10. Font sizes are readable (13px skill names, 11px status)

- [ ] **Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "fix: test adjustments for skill_naming default"
```

---

## Self-Review Notes

**Spec coverage:**

- Problem 1+2 (buttons + fonts): Task 9 (CSS), Task 10 (Skills), Task 13 (MCP)
- Problem 1 (skill name only): Task 10
- Problem 3 (Add Local): Task 5 (APIs), Task 8 (types), Task 11 (AddSkillModal)
- Problem 4 (naming config): Task 1 (types), Task 2 (projection), Task 6 (scan.ts)
- Problem 5 (collapsible): Task 10
- Problem 6 (Source ref dropdown): Task 3 (lsRemote), Task 4 (API), Task 11 (AddSkillModal)
- Edit Source: Task 12
- Local skill move/ref: Task 5 (import API), Task 11 (UI)
- Missing path display: Task 10

**Placeholder scan:** No TBD/TODO. All steps have concrete code or specific instructions.

**Type consistency:** `skill_naming` used consistently in types.ts, projection.ts, scan.ts. `type: 'branch' | 'tag'` in SkillSource, AddSkillModal, EditSourceModal. API method names match between api.ts and routes.
