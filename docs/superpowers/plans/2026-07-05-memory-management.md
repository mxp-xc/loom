# 记忆管理(Memory Management)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 loom 中新增记忆管理:维护多份命名提示词,激活一份,投影时按工具渲染 `${VAR}` 并整文件写入 cc/cx/oc 的 `CLAUDE.md`/`AGENTS.md`;配套把全局 `repoPath` 参数整改为 `repo`(name)。

**Architecture:** 复用 loom 现有 projection / vars / manifest / git 基础设施。新增 `Memory` 实体存于 `~/.loom/repos/<repo>/memories/*.md`,`config.active_memory` 指向激活份(平行于 `profile`)。投影复用 `executeProjection`,新增 Phase D(memory)+ `scope` 参数支持单资源投影。`renderText` 在 `resolveVars` 基础上加 `\${}` 转义保护。repo name 用目录列表精准匹配校验,防路径遍历。

**Tech Stack:** TypeScript、Hono(后端)、React 18 + Vite(前端)、vitest(测试)、bun(运行/包管理)、zod(校验)、js-yaml。

**Spec:** `docs/superpowers/specs/2026-07-05-memory-management-design.md`

---

## File Structure

### 新建

- `packages/server/src/api/repo.ts` — `resolveRepoPath` + `listRepos`,目录列表精准匹配校验
- `packages/server/src/api/routes/memory.ts` — memory CRUD + 激活 + 预览路由
- `packages/web/src/views/Memory.tsx` — memory 页面(左右分栏)
- `packages/web/src/components/MemoryEditor.tsx` — 三视图编辑器(编辑默认/预览/解析预览)+ 占位符高亮
- 测试:`packages/core/test/vars-render.test.ts`、`packages/core/test/memory-manifest.test.ts`、`packages/server/test/api/repo.test.ts`、`packages/server/test/api/memory.test.ts`、`packages/server/test/projection/executor-memory.test.ts`、`packages/server/test/adapters/paths.test.ts`

### 修改

- `packages/core/src/types.ts` — `Memory`/`MemoryManifest`/`Config.active_memory`/`Manifest.memory`/`RepoManifest.memoriesFiles`
- `packages/core/src/vars.ts` — `renderText`
- `packages/core/src/manifest.ts` — `loadRepoManifest`/`buildManifest` 集成 memory
- `packages/core/src/projection.ts` — `ProjectionPlan.memoryPlan` + `planProjection`
- `packages/server/src/ports/adapter.ts` — `UndoAction` 加 `restoreMemory`
- `packages/server/src/projection/executor.ts` — Phase D + `scope` 参数 + `applyUndo` 处理 `restoreMemory`
- `packages/server/src/adapters/paths.ts` — opencode 分支修正 + `agentMemoryFile`
- `packages/server/src/api/routes/projection.ts` — `scope` 参数 + `repo`
- `packages/server/src/api/routes/{skills-yaml,mcp-yaml,config,sync,remote,health}.ts` — `repoPath`→`repo`
- `packages/server/src/api/repo-config.ts` — `readRepoFiles` 扩展读 `memories/*.md`
- `packages/server/src/api/router.ts` — 注册 memory 路由
- `packages/web/src/lib/api.ts` — `repoPath`→`repo`(~30 处)+ memory 方法 + scope
- `packages/web/src/App.tsx` — Memory 路由 + NavLink
- `packages/web/src/views/skills/Skills.tsx`、`packages/web/src/views/Mcp.tsx` — 传 `scope`

---

## Phase 1:基础设施整改

### Task 1:paths.ts opencode 修正 + agentMemoryFile

**Files:**

- Modify: `packages/server/src/adapters/paths.ts`
- Test: `packages/server/test/adapters/paths.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/test/adapters/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  agentConfigDir,
  agentSkillsDir,
  agentMcpFile,
  agentMemoryFile,
} from '../../src/adapters/paths.js'

describe('paths', () => {
  it('opencode config dir is ~/.config/opencode on darwin (not Library/Application Support)', () => {
    delete process.env.OPENCODE_CONFIG_DIR
    const dir = agentConfigDir('opencode')
    expect(dir.endsWith('.config/opencode')).toBe(true)
    expect(dir).not.toContain('Application Support')
  })

  it('agentMemoryFile: claude-code → CLAUDE.md, others → AGENTS.md', () => {
    expect(agentMemoryFile('claude-code').endsWith('CLAUDE.md')).toBe(true)
    expect(agentMemoryFile('codex').endsWith('AGENTS.md')).toBe(true)
    expect(agentMemoryFile('opencode').endsWith('AGENTS.md')).toBe(true)
  })

  it('agentMemoryFile lives under agentConfigDir', () => {
    for (const a of ['claude-code', 'codex', 'opencode'] as const) {
      const f = agentMemoryFile(a)
      const d = agentConfigDir(a)
      expect(f.startsWith(d)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/server/test/adapters/paths.test.ts`
Expected: FAIL — `agentMemoryFile` is not exported.

- [ ] **Step 3: Implement**

Replace the opencode branch and add `agentMemoryFile` in `packages/server/src/adapters/paths.ts`:

```ts
    case 'opencode': {
      if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
      const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
      return join(base, 'opencode')
    }
```

Add at end of file:

```ts
export function agentMemoryFile(agent: AgentId): string {
  const name = agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md'
  return join(agentConfigDir(agent), name)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/server/test/adapters/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/adapters/paths.ts packages/server/test/adapters/paths.test.ts
git commit -m "fix: opencode config dir path + add agentMemoryFile"
```

---

### Task 2:repo.ts resolveRepoPath + 校验

**Files:**

- Create: `packages/server/src/api/repo.ts`
- Test: `packages/server/test/api/repo.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/test/api/repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { resolveRepoPath, listRepos } from '../../src/api/repo.js'

describe('repo resolution', () => {
  let home: string
  let fs: NodeFileSystem

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-repo-'))
    fs = new NodeFileSystem()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists actual subdirectories under ~/.loom/repos', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    mkdirSync(join(home, '.loom', 'repos', 'work'), { recursive: true })
    const repos = await listRepos(fs, home)
    expect(repos.sort()).toEqual(['default', 'work'])
  })

  it('resolves valid repo name to path', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    const p = await resolveRepoPath(fs, 'default', home)
    expect(p).toBe(join(home, '.loom', 'repos', 'default'))
  })

  it('rejects unknown repo (path traversal safe)', async () => {
    mkdirSync(join(home, '.loom', 'repos', 'default'), { recursive: true })
    await expect(resolveRepoPath(fs, '../etc', home)).rejects.toThrow(/invalid repo/)
    await expect(resolveRepoPath(fs, 'nonexistent', home)).rejects.toThrow(/invalid repo/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/server/test/api/repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/server/src/api/repo.ts`:

```ts
import { join } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'

export async function listRepos(fs: IFileSystem, home: string): Promise<string[]> {
  const dir = join(home, '.loom', 'repos')
  try {
    const entries = await fs.readDir(dir)
    // ~/.loom/repos/ should contain only repo directories; filter to dirs that exist.
    const out: string[] = []
    for (const name of entries) {
      if (await fs.exists(join(dir, name))) out.push(name)
    }
    return out
  } catch {
    return []
  }
}

export async function resolveRepoPath(
  fs: IFileSystem,
  repo: string,
  home: string,
): Promise<string> {
  const repos = await listRepos(fs, home)
  if (!repos.includes(repo)) {
    throw new Error(`invalid repo: ${repo}`)
  }
  return join(home, '.loom', 'repos', repo)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/server/test/api/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/repo.ts packages/server/test/api/repo.test.ts
git commit -m "feat: resolveRepoPath with directory-listing validation"
```

---

### Task 3:后端路由 repoPath → repo(批量)

**Files:**

- Modify: `packages/server/src/api/routes/{projection,skills-yaml,mcp-yaml,config,sync,remote,health}.ts`
- Modify: `packages/server/src/api/repo-config.ts`

**模式(所有路由统一应用)**:

1. `body.repoPath` → `body.repo`;`c.req.query('repoPath')` → `c.req.query('repo')`
2. 路由入口首先 `const repoPath = await resolveRepoPath(deps.fs, body.repo, deps.home)`(query 版同理),try/catch 捕获 `invalid repo` 返回 400
3. 内部函数 `readRepoFiles(fs, repoPath)` 等仍用解析后的 `repoPath` 变量(只是来源从 `repo` name 解析)

- [ ] **Step 1: 改造 projection.ts 路由作为模式示例**

In `packages/server/src/api/routes/projection.ts`, top of file add import:

```ts
import { resolveRepoPath } from '../repo.js'
```

In `app.post('/project', ...)` and `app.get('/manifest', ...)`, replace `const repoPath = body.repoPath` / `c.req.query('repoPath')` with:

```ts
const repo = body.repo
let repoPath: string
try {
  repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
} catch (e) {
  return c.json({ ok: false, error: 'invalid_repo', message: String((e as Error).message) }, 400)
}
```

(query 版:`const repo = c.req.query('repo')!`)

- [ ] **Step 2: 应用到其余路由**

Apply the same pattern to: `skills-yaml.ts`(所有 `body.repoPath` → `body.repo` + 入口解析)、`mcp-yaml.ts`、`config.ts`、`sync.ts`、`remote.ts`、`health.ts`(`/init`、`/status` 若用 repoPath 同改)。

`repo-config.ts` 的 `readRepoFiles`/`readLocalConfig` 参数名保持 `repoPath`(它是已解析路径,不是 name),不改。

- [ ] **Step 3: Run all server tests**

Run: `bunx vitest run packages/server/test`
Expected: 现有测试若用 `repoPath` 字段需同步改为 `repo`。修复测试中的字段名。PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/api/
git commit -m "refactor: rename repoPath to repo across server routes"
```

---

### Task 4:前端 api.ts + views repoPath → repo

**Files:**

- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/views/{skills/Skills,Mcp,Sync,Settings}.tsx`

- [ ] **Step 1: api.ts 参数重命名**

In `packages/web/src/lib/api.ts`, rename all `repoPath: string` params → `repo: string`, and all `body.repoPath` / query `repoPath=` → `repo` / `repo=`. Example:

```ts
  syncPull: (repo: string) => post('/sync/pull', { repo }).then(json),
  getConfig: (repo: string) =>
    fetch(`${base}/config?repo=${encodeURIComponent(repo)}`).then(json),
  getManifest: (repo: string) =>
    fetch(`${base}/manifest?repo=${encodeURIComponent(repo)}`).then(json),
```

Apply to every method currently taking `repoPath`.

- [ ] **Step 2: views 调用更新**

In each view, the `repoPath` prop comes from `App.tsx` (`<Skills repoPath={repoPath} />`). Two options:

- (a) Rename the prop to `repo` end-to-end, or
- (b) Keep prop name `repoPath` in views but pass `repo` to api calls: `api.getManifest(repoPath)` still works since it's just a variable name.

Choose (b) for minimal churn: views keep their `repoPath` prop variable, only `api.ts` method signatures change to `repo`. Calls like `api.getManifest(repoPath)` still compile (param name is positional).

Verify: `cd packages/web && bunx tsc --noEmit`. Fix any type errors.

- [ ] **Step 3: Run dev server smoke test**

Run: `bun dev` (in another shell, or background). Open http://localhost:5173, verify Skills/MCP/Sync/Settings pages load and manifest fetches succeed (check network tab: requests use `?repo=default`).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/views/
git commit -m "refactor: rename repoPath to repo in web api client"
```

---

## Phase 2:memory 功能

### Task 5:core types — Memory / MemoryManifest

**Files:**

- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/memory-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Memory, MemoryManifest, Manifest, Config, RepoManifest } from '../src/types.js'

describe('memory types', () => {
  it('Memory has name and optional content', () => {
    const m: Memory = { name: 'v1' }
    expect(m.name).toBe('v1')
    const m2: Memory = { name: 'v2', content: '...' }
    expect(m2.content).toBe('...')
  })

  it('MemoryManifest has memories, active, activeContent', () => {
    const mm: MemoryManifest = {
      memories: [{ name: 'v1' }],
      active: { name: 'v1' },
      activeContent: 'text',
    }
    expect(mm.active?.name).toBe('v1')
  })

  it('Config has active_memory', () => {
    const c: Config = { active_memory: 'v1' }
    expect(c.active_memory).toBe('v1')
  })

  it('Manifest has memory field', () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [], active: null, activeContent: '' },
      vars: { default: {}, active: {} },
      config: {},
      errors: [],
    }
    expect(mf.memory.active).toBeNull()
  })

  it('RepoManifest has memoriesFiles', () => {
    const rm: RepoManifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      varsFiles: {},
      repoConfig: {},
      memoriesFiles: {},
    }
    expect(rm.memoriesFiles).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/memory-types.test.ts`
Expected: FAIL — types missing.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add:

```ts
export interface Memory {
  name: string
  content?: string
}

export interface MemoryManifest {
  memories: Memory[]
  active: Memory | null
  activeContent: string
}
```

Add to `Config`:

```ts
  active_memory?: string
```

Add to `Manifest`:

```ts
memory: MemoryManifest
```

Add to `RepoManifest`:

```ts
memoriesFiles: Record<string, string> // name -> raw markdown content
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/memory-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/memory-types.test.ts
git commit -m "feat(core): add Memory types"
```

---

### Task 6:core vars.ts renderText(转义 + 解析)

**Files:**

- Modify: `packages/core/src/vars.ts`
- Test: `packages/core/test/vars-render.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/vars-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderText, type VarsContext } from '../src/vars.js'

const ctx: VarsContext = {
  env: { LOOM_AGENT: 'codex', LOOM_CONFIG_DIR: '/home/u/.codex' },
  activeProfile: { PROFILE_VAR: 'active' },
  defaultProfile: { DEFAULT_VAR: 'def' },
}

describe('renderText', () => {
  it('resolves ${VAR} from env first', () => {
    expect(renderText('${LOOM_AGENT}', ctx)).toBe('codex')
  })

  it('resolves ${VAR:fallback} when undefined', () => {
    expect(renderText('${MISSING:fallback}', ctx)).toBe('fallback')
  })

  it('embeds in surrounding text', () => {
    expect(renderText('@${LOOM_CONFIG_DIR}/RTK.md', ctx)).toBe('@/home/u/.codex/RTK.md')
  })

  it('escaped \\${} stays literal', () => {
    expect(renderText('use \\${HOME} for dir', ctx)).toBe('use ${HOME} for dir')
  })

  it('escaped \\${} is NOT resolved', () => {
    expect(renderText('\\${LOOM_AGENT}', ctx)).toBe('${LOOM_AGENT}')
  })

  it('mixed escape and resolve', () => {
    expect(renderText('\\${literal} and ${LOOM_AGENT}', ctx)).toBe('${literal} and codex')
  })

  it('multiline markdown resolves throughout', () => {
    const md = '# Title\n@${LOOM_CONFIG_DIR}/x\nuse \\${HOME}\n'
    expect(renderText(md, ctx)).toBe('# Title\n@/home/u/.codex/x\nuse ${HOME}\n')
  })

  it('throws on undefined var without fallback', () => {
    expect(() => renderText('${NOPE}', ctx)).toThrow(/NOPE/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/vars-render.test.ts`
Expected: FAIL — `renderText` not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/vars.ts`:

```ts
const ESC = '��DOLLAR_BRACE��'

export function renderText(text: string, ctx: VarsContext): string {
  let s = text.replaceAll('\\${', ESC)
  s = resolveVars(s, ctx)
  return s.replaceAll(ESC, '${')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/vars-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/vars.ts packages/core/test/vars-render.test.ts
git commit -m "feat(core): renderText with escape protection"
```

---

### Task 7:core manifest 集成 memory

**Files:**

- Modify: `packages/core/src/manifest.ts`
- Modify: `packages/server/src/api/repo-config.ts`
- Test: `packages/core/test/memory-manifest.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/memory-manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadRepoManifest, buildManifest } from '../src/manifest.js'

describe('memory manifest', () => {
  it('loadRepoManifest reads memories/*.md into memoriesFiles', () => {
    const files = {
      'config.yaml': 'active_memory: v2\n',
      'memories/v1.md': '# v1 content',
      'memories/v2.md': '# v2 content',
    }
    const rm = loadRepoManifest(files)
    expect(Object.keys(rm.memoriesFiles).sort()).toEqual(['v1', 'v2'])
    expect(rm.memoriesFiles['v2']).toBe('# v2 content')
    expect((rm.repoConfig as any).active_memory).toBe('v2')
  })

  it('buildManifest sets memory.memories, active, activeContent', () => {
    const rm = loadRepoManifest({
      'config.yaml': 'active_memory: v2\n',
      'memories/v1.md': '# v1',
      'memories/v2.md': '# v2 ${LOOM_AGENT}',
    })
    const mf = buildManifest(rm, {})
    expect(mf.memory.memories.map((m) => m.name).sort()).toEqual(['v1', 'v2'])
    expect(mf.memory.active?.name).toBe('v2')
    expect(mf.memory.activeContent).toBe('# v2 ${LOOM_AGENT}')
  })

  it('active_memory pointing to missing memory: active=null, error recorded', () => {
    const rm = loadRepoManifest({ 'config.yaml': 'active_memory: nope\n', 'memories/v1.md': 'x' })
    const mf = buildManifest(rm, {})
    expect(mf.memory.active).toBeNull()
    expect(mf.errors.some((e) => e.includes('active_memory'))).toBe(true)
  })

  it('no memories dir: empty list, active=null, no error', () => {
    const rm = loadRepoManifest({ 'config.yaml': '' })
    const mf = buildManifest(rm, {})
    expect(mf.memory.memories).toEqual([])
    expect(mf.memory.active).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/memory-manifest.test.ts`
Expected: FAIL — `memoriesFiles` undefined.

- [ ] **Step 3: Implement loadRepoManifest + buildManifest**

In `packages/core/src/manifest.ts`, extend `loadRepoManifest`:

```ts
const memoriesFiles: Record<string, string> = {}
for (const path of Object.keys(files)) {
  if (path.startsWith('memories/') && path.endsWith('.md')) {
    const name = path.slice('memories/'.length, -'.md'.length)
    memoriesFiles[name] = files[path]
  }
}
const repoConfig = parse('config.yaml', {})
return { skills, mcp, varsFiles, memoriesFiles, repoConfig } as RepoManifest
```

Extend `buildManifest`:

```ts
export function buildManifest(repo: RepoManifest, localConfig: Config): Manifest {
  const effective = mergeConfig(repo.repoConfig, localConfig)
  const profileName = effective.profile ?? 'default'
  const defaultVars = repo.varsFiles['default'] ?? {}
  const memories: Memory[] = Object.keys(repo.memoriesFiles)
    .sort()
    .map((name) => ({ name, content: repo.memoriesFiles[name] }))
  const activeName = effective.active_memory
  const active =
    activeName && repo.memoriesFiles[activeName] !== undefined
      ? { name: activeName, content: repo.memoriesFiles[activeName] }
      : null
  const errors = validateManifest(repo)
  if (activeName && !active) {
    errors.push(`active_memory references unknown memory: ${activeName}`)
  }
  return {
    skills: repo.skills,
    mcp: repo.mcp,
    memory: {
      memories,
      active,
      activeContent: active?.content ?? '',
    },
    vars: { default: defaultVars, active: repo.varsFiles[profileName] ?? defaultVars },
    config: effective,
    errors,
  }
}
```

Add `Memory` to the type import at top:

```ts
import type { Config, RepoManifest, Manifest, Memory } from './types.js'
```

- [ ] **Step 4: Extend readRepoFiles to read memories/**

In `packages/server/src/api/repo-config.ts`, add to `readRepoFiles` (after the vars block):

```ts
try {
  const memDir = join(repoPath, 'memories')
  if (await fs.exists(memDir)) {
    for (const f of await fs.readDir(memDir)) {
      if (f.endsWith('.md')) {
        try {
          files[`memories/${f}`] = await fs.readFile(join(memDir, f))
        } catch {
          /* skip */
        }
      }
    }
  }
} catch {
  /* no memories dir */
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bunx vitest run packages/core/test/memory-manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/test/memory-manifest.test.ts packages/server/src/api/repo-config.ts
git commit -m "feat(core): integrate memory into manifest"
```

---

### Task 8:core projection.ts — memoryPlan + planProjection

**Files:**

- Modify: `packages/core/src/projection.ts`
- Test: `packages/core/test/projection-memory.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/projection-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planProjection } from '../src/projection.js'
import type { Manifest, Config } from '../src/types.js'

const baseManifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  skills: { sources: [], skills: [] },
  mcp: [],
  memory: { memories: [], active: null, activeContent: '' },
  vars: { default: {}, active: {} },
  config: {},
  errors: [],
  ...overrides,
})

describe('planProjection memory', () => {
  it('memoryPlan.active null when no active memory', () => {
    const mf = baseManifest()
    const cfg: Config = { targets: ['claude-code'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code']))
    expect(plan.memoryPlan.active).toBeNull()
    expect(plan.memoryPlan.content).toBeNull()
  })

  it('memoryPlan carries active memory + content + global targets', () => {
    const mf = baseManifest({
      memory: {
        memories: [{ name: 'v1' }],
        active: { name: 'v1' },
        activeContent: '# hi ${LOOM_AGENT}',
      },
    })
    const cfg: Config = { targets: ['claude-code', 'codex'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code', 'codex']))
    expect(plan.memoryPlan.active?.name).toBe('v1')
    expect(plan.memoryPlan.content).toBe('# hi ${LOOM_AGENT}')
    expect(plan.memoryPlan.targets).toEqual(['claude-code', 'codex'])
  })

  it('memoryPlan.targets filters to installed agents', () => {
    const mf = baseManifest({
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: 'x' },
    })
    const cfg: Config = { targets: ['claude-code', 'codex', 'opencode'] }
    const plan = planProjection(mf, cfg, new Set(['claude-code']))
    expect(plan.memoryPlan.targets).toEqual(['claude-code'])
    expect(plan.skippedAgents).toContain('codex')
    expect(plan.skippedAgents).toContain('opencode')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/projection-memory.test.ts`
Expected: FAIL — `memoryPlan` undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/projection.ts`, add to `ProjectionPlan` and `planProjection`:

```ts
export interface MemoryPlan {
  active: Memory | null
  content: string | null
  targets: AgentId[]
}

export interface ProjectionPlan {
  links: LinkPlan[]
  mcpEntries: McpPlanEntry[]
  skippedAgents: AgentId[]
  strategy: 'link' | 'copy'
  memoryPlan: MemoryPlan
}
```

Add `Memory` to the import from `./types.js`. In `planProjection`, before `return`:

```ts
const memActive = manifest.memory.active
const memoryTargets = activeTargets(globalTargets)
const memoryPlan: MemoryPlan = {
  active: memActive,
  content: memActive ? manifest.memory.activeContent : null,
  targets: memoryTargets,
}
```

Add `memoryPlan` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/projection-memory.test.ts`
Expected: PASS. Also run existing projection tests to ensure no regression: `bunx vitest run packages/core/test/projection.test.ts` (if exists) — fix the expected plan shape (now includes `memoryPlan`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection.ts packages/core/test/projection-memory.test.ts
git commit -m "feat(core): memoryPlan in planProjection"
```

---

### Task 9:UndoAction restoreMemory + applyUndo

**Files:**

- Modify: `packages/server/src/ports/adapter.ts`
- Modify: `packages/server/src/projection/executor.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/test/projection/undo-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyUndo } from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('applyUndo restoreMemory', () => {
  let fs: NodeFileSystem
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-undo-'))
    fs = new NodeFileSystem()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('restoreMemory with backup writes backup back', async () => {
    const f = join(dir, 'CLAUDE.md')
    await fs.writeFile(f, 'original')
    await applyUndo({ kind: 'restoreMemory', path: f, backup: 'original' }, fs)
    expect(readFileSync(f, 'utf8')).toBe('original')
  })

  it('restoreMemory with null backup deletes newly created file', async () => {
    const f = join(dir, 'AGENTS.md')
    await fs.writeFile(f, 'projected')
    await applyUndo({ kind: 'restoreMemory', path: f, backup: null }, fs)
    expect(existsSync(f)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/server/test/projection/undo-memory.test.ts`
Expected: FAIL — `restoreMemory` not a valid kind / applyUndo doesn't handle it.

- [ ] **Step 3: Implement**

In `packages/server/src/ports/adapter.ts`, extend `UndoAction`:

```ts
export type UndoAction =
  | { kind: 'unlink'; path: string }
  | { kind: 'restoreMcp'; path: string; backup: string | null }
  | { kind: 'restoreMemory'; path: string; backup: string | null }
```

In `packages/server/src/projection/executor.ts`, extend `applyUndo`:

```ts
async function applyUndo(u: UndoAction, fs: IFileSystem): Promise<void> {
  if (u.kind === 'unlink') {
    if (await fs.isLink(u.path)) {
      await fs.removeLink(u.path)
    } else {
      throw new Error(`cannot rollback copy artifact (not a link): ${u.path}`)
    }
  } else if (u.kind === 'restoreMemory') {
    if (u.backup === null) {
      await fs.removeDir(u.path).catch(() => {
        /* file may be gone; best-effort delete */
      })
      // removeDir is for dirs; for a single file use a fallback: re-write empty then nothing.
      // Prefer: if file still exists, delete via overwrite is not clean — see note below.
    } else {
      await fs.writeFile(u.path, u.backup)
    }
  } else {
    if (u.backup === null) {
      throw new Error(`cannot rollback newly created MCP file: ${u.path}`)
    } else {
      await fs.writeFile(u.path, u.backup)
    }
  }
}
```

**Note:** `IFileSystem` lacks a `removeFile`. Add `removeFile(path: string): Promise<void>` to `IFileSystem` (`packages/server/src/ports/fs.ts`) and implement in `packages/server/src/platform/node/fs.ts` (use `fs.promises.unlink`). Then `restoreMemory` null-backup calls `await fs.removeFile(u.path)`. Update the test accordingly (it should pass with `removeFile`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/server/test/projection/undo-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ports/adapter.ts packages/server/src/ports/fs.ts packages/server/src/platform/node/fs.ts packages/server/src/projection/executor.ts packages/server/test/projection/undo-memory.test.ts
git commit -m "feat(server): restoreMemory undo + removeFile port"
```

---

### Task 10:executor Phase D + scope 参数

**Files:**

- Modify: `packages/server/src/projection/executor.ts`
- Test: `packages/server/test/projection/executor-memory.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/test/projection/executor-memory.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeProjection } from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { planProjection } from '@loom/core'
import type { Manifest, AgentId } from '@loom/core'

describe('executeProjection memory phase', () => {
  let fs: NodeFileSystem
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-exec-'))
    fs = new NodeFileSystem()
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
    process.env.CODEX_HOME = join(home, 'codex')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CODEX_HOME
  })

  const buildPlan = (mf: Manifest, agents: AgentId[]) =>
    planProjection(mf, mf.config, new Set(agents))

  it('scope=memory writes rendered memory to agent files', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: {
        memories: [{ name: 'v1' }],
        active: { name: 'v1' },
        activeContent: 'agent=${LOOM_AGENT} file=${LOOM_AGENT_FILE} dir=${LOOM_CONFIG_DIR}',
      },
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code', 'codex'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code', 'codex'])
    const varsCtx = {
      env: { LOOM_AGENT: 'x', LOOM_CONFIG_DIR: 'x', LOOM_SKILLS_DIR: 'x', LOOM_AGENT_FILE: 'x' },
      activeProfile: {},
      defaultProfile: {},
    }
    // per-agent env injection happens in executor; pass base ctx, executor overrides env per agent
    const res = await executeProjection(
      plan,
      mf,
      varsCtx,
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code', 'codex']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )
    expect(res.ok).toBe(true)
    const cc = readFileSync(join(home, 'claude', 'CLAUDE.md'), 'utf8')
    const cx = readFileSync(join(home, 'codex', 'AGENTS.md'), 'utf8')
    expect(cc).toContain('agent=claude-code file=CLAUDE.md')
    expect(cx).toContain('agent=codex file=AGENTS.md')
  })

  it('scope=memory skips when no active memory', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [], active: null, activeContent: '' },
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code'])
    const res = await executeProjection(
      plan,
      mf,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code']),
        resolveSkillSrc: () => null,
      },
      'memory',
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(home, 'claude', 'CLAUDE.md'))).toBe(false)
  })

  it('scope=skills does NOT write memory files', async () => {
    const mf: Manifest = {
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [{ name: 'v1' }], active: { name: 'v1' }, activeContent: 'x' },
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code'] },
      errors: [],
    }
    const plan = buildPlan(mf, ['claude-code'])
    const res = await executeProjection(
      plan,
      mf,
      { env: {}, activeProfile: {}, defaultProfile: {} },
      {
        fs,
        adapters: {},
        installedAgents: new Set(['claude-code']),
        resolveSkillSrc: () => null,
      },
      'skills',
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(home, 'claude', 'CLAUDE.md'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/server/test/projection/executor-memory.test.ts`
Expected: FAIL — `executeProjection` doesn't accept scope / no memory phase.

- [ ] **Step 3: Implement**

In `packages/server/src/projection/executor.ts`:

1. Add `scope` param and `renderText` import:

```ts
import { resolveVars, renderText, type VarsContext } from '@loom/core'
import { agentMcpFile, agentSkillsDir, agentMemoryFile } from '../adapters/paths.js'

export type ProjectionScope = 'skills' | 'mcp' | 'memory' | 'all'

export async function executeProjection(
  plan: ProjectionPlan,
  manifest: Manifest,
  varsCtx: VarsContext,
  deps: ProjectionDeps,
  scope: ProjectionScope = 'all',
): Promise<ProjectionResult> {
```

2. Wrap Phase A-C (skills) in `if (scope === 'skills' || scope === 'all')`.
3. Wrap MCP block in `if (scope === 'mcp' || scope === 'all')`.
4. Add Phase D before `return { ok: true }`:

```ts
// Phase D: memory projection
if (scope === 'memory' || scope === 'all') {
  const mp = plan.memoryPlan
  if (mp.active && mp.content !== null) {
    for (const agent of mp.targets) {
      const ctx: VarsContext = {
        env: {
          ...varsCtx.env,
          LOOM_AGENT: agent,
          LOOM_CONFIG_DIR: agentConfigDir(agent),
          LOOM_SKILLS_DIR: agentSkillsDir(agent),
          LOOM_AGENT_FILE: agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
        },
        activeProfile: varsCtx.activeProfile,
        defaultProfile: varsCtx.defaultProfile,
      }
      let rendered: string
      try {
        rendered = renderText(mp.content, ctx)
      } catch (e) {
        deps.logger?.error({ err: e, agent }, 'memory var resolve failed')
        throw e
      }
      const path = agentMemoryFile(agent)
      await deps.fs.mkdir(join(path, '..'), true).catch(() => {})
      const backup = (await fs.exists(path)) ? await fs.readFile(path) : null
      journal.undos.push({ kind: 'restoreMemory', path, backup })
      await fs.writeFile(path, rendered)
    }
  } else {
    deps.logger?.warn?.({}, 'no active memory, skip memory phase')
  }
}
```

5. Import `agentConfigDir` from paths.ts too.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/server/test/projection/executor-memory.test.ts`
Expected: PASS. Also run `bunx vitest run packages/server/test/projection/executor.test.ts` — existing tests call `executeProjection` without scope (defaults 'all'), should still pass; if they break due to memory phase, ensure test manifests include `memory` field (they may use `varsCtx` without `memory` — add `memory: { memories: [], active: null, activeContent: '' }` to test manifests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/projection/executor.ts packages/server/test/projection/executor-memory.test.ts packages/server/test/projection/executor.test.ts
git commit -m "feat(server): memory projection Phase D + scope param"
```

---

### Task 11:projection.ts 路由 scope 参数

**Files:**

- Modify: `packages/server/src/api/routes/projection.ts`

- [ ] **Step 1: Update route to pass scope**

In `app.post('/project', ...)`, after `const varsCtx = ...`:

```ts
const scope = (body.scope ?? 'all') as 'skills' | 'mcp' | 'memory' | 'all'
const res = await executeProjection(plan, mf, varsCtx, projDeps, scope)
```

- [ ] **Step 2: Run server tests**

Run: `bunx vitest run packages/server/test/api/routes.test.ts`
Expected: PASS (existing test calls without scope → defaults 'all'). If a test asserts only skills/mcp projected, it still works under 'all'.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api/routes/projection.ts
git commit -m "feat(server): accept scope in POST /project"
```

---

### Task 12:memory.ts 路由(CRUD + active + preview)

**Files:**

- Create: `packages/server/src/api/routes/memory.ts`
- Test: `packages/server/test/api/memory.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/test/api/memory.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMemoryRoutes } from '../../src/api/routes/memory.js'
import { registerRoutes } from '../../src/api/router.js'

describe('memory routes', () => {
  let home: string
  let app: ReturnType<typeof registerRoutes>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-mem-'))
    mkdirSync(join(home, '.loom', 'repos', 'default', 'memories'), { recursive: true })
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), '')
    // mock home for router
    process.env.HOME = home
    app = registerRoutes()
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })

  it('GET /memory lists memories + active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), '# v1')
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'memories', 'v2.md'),
      '# v2 ${LOOM_AGENT}',
    )
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v2\n')
    const res = await req('GET', '/api/memory?repo=default')
    const j = await res.json()
    expect(j.memories.map((m: any) => m.name).sort()).toEqual(['v1', 'v2'])
    expect(j.active).toBe('v2')
    expect(j.activeContent).toContain('${LOOM_AGENT}')
  })

  it('GET /memory?name= returns single memory raw content', async () => {
    writeFileSync(
      join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'),
      '# raw ${LOOM_AGENT}',
    )
    const res = await req('GET', '/api/memory?repo=default&name=v1')
    const j = await res.json()
    expect(j.content).toBe('# raw ${LOOM_AGENT}')
  })

  it('POST /memory creates new memory', async () => {
    const res = await req('POST', '/api/memory', { repo: 'default', name: 'v3' })
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v3.md'), 'utf8')).toBe(
      '',
    )
  })

  it('POST /memory rejects duplicate name (409)', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    const res = await req('POST', '/api/memory', { repo: 'default', name: 'v1' })
    expect(res.status).toBe(409)
  })

  it('POST /memory rejects path-traversal name', async () => {
    const res = await req('POST', '/api/memory', { repo: 'default', name: '../etc' })
    expect(res.status).toBe(400)
  })

  it('PUT /memory/content writes content', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'old')
    await req('PUT', '/api/memory/content', { repo: 'default', name: 'v1', content: 'new content' })
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'utf8')).toBe(
      'new content',
    )
  })

  it('POST /memory/active sets active_memory in config.yaml', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    await req('POST', '/api/memory/active', { repo: 'default', name: 'v1' })
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).toContain('active_memory: v1')
  })

  it('DELETE /memory removes file + clears active if active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'x')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    await req('DELETE', '/api/memory?repo=default&name=v1')
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).not.toContain('active_memory: v1')
  })

  it('POST /memory/rename renames + syncs active', async () => {
    writeFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v1.md'), 'content')
    writeFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'active_memory: v1\n')
    await req('POST', '/api/memory/rename', { repo: 'default', name: 'v1', newName: 'v2' })
    expect(readFileSync(join(home, '.loom', 'repos', 'default', 'memories', 'v2.md'), 'utf8')).toBe(
      'content',
    )
    const cfg = readFileSync(join(home, '.loom', 'repos', 'default', 'config.yaml'), 'utf8')
    expect(cfg).toContain('active_memory: v2')
  })

  it('POST /memory/preview renders ${VAR} for agent', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
    const res = await req('POST', '/api/memory/preview', {
      repo: 'default',
      content: 'agent=${LOOM_AGENT} file=${LOOM_AGENT_FILE}',
      agent: 'claude-code',
    })
    const j = await res.json()
    expect(j.rendered).toBe('agent=claude-code file=CLAUDE.md')
    delete process.env.CLAUDE_CONFIG_DIR
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/server/test/api/memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/server/src/api/routes/memory.ts`:

```ts
import { Hono } from 'hono'
import { join, sep } from 'node:path'
import yaml from 'js-yaml'
import { resolveRepoPath } from '../repo.js'
import { renderText } from '@loom/core'
import { agentConfigDir, agentSkillsDir } from '../../adapters/paths.js'
import { readYaml, writeYaml } from '../repo-config.js'
import type { RouteDeps } from '../router.js'
import type { AgentId } from '@loom/core'

const NAME_RE = /^[A-Za-z0-9_-]+$/

function memoriesDir(repoPath: string) {
  return join(repoPath, 'memories')
}

function validName(name: string): boolean {
  return NAME_RE.test(name)
}

async function readConfig(fs: any, repoPath: string): Promise<Record<string, any>> {
  return (await readYaml(fs, join(repoPath, 'config.yaml'))) ?? {}
}

export function createMemoryRoutes(deps: RouteDeps): Hono {
  const app = new Hono()

  app.get('/memory', async (c) => {
    try {
      const repo = c.req.query('repo')!
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      // ?name=<n> returns a single memory's raw content (for editing non-active memories)
      const nameQuery = c.req.query('name')
      if (nameQuery) {
        if (!validName(nameQuery)) return c.json({ ok: false, error: 'invalid_name' }, 400)
        const file = join(memoriesDir(repoPath), `${nameQuery}.md`)
        if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
        return c.json({ content: await deps.fs.readFile(file) })
      }
      const dir = memoriesDir(repoPath)
      const names: string[] = []
      if (await deps.fs.exists(dir)) {
        for (const f of await deps.fs.readDir(dir)) {
          if (f.endsWith('.md')) names.push(f.slice(0, -'.md'.length))
        }
      }
      names.sort()
      const cfg = await readConfig(deps.fs, repoPath)
      const active = typeof cfg.active_memory === 'string' ? cfg.active_memory : null
      let activeContent = ''
      if (active && names.includes(active)) {
        activeContent = await deps.fs.readFile(join(dir, `${active}.md`))
      }
      return c.json({ memories: names.map((n) => ({ name: n })), active, activeContent })
    } catch (e) {
      return c.json({ ok: false, error: 'read_failed', message: String((e as Error).message) }, 400)
    }
  })

  app.post('/memory', async (c) => {
    try {
      const { repo, name } = await c.req.json()
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const dir = memoriesDir(repoPath)
      await deps.fs.mkdir(dir, true)
      const file = join(dir, `${name}.md`)
      if (await deps.fs.exists(file)) return c.json({ ok: false, error: 'exists' }, 409)
      // path-traversal defense (name already restricted, but double-check resolved path)
      if (!file.startsWith(dir + sep)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      await deps.fs.writeFile(file, '')
      return c.json({ ok: true, name })
    } catch (e) {
      return c.json(
        { ok: false, error: 'create_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.delete('/memory', async (c) => {
    try {
      const repo = c.req.query('repo')!
      const name = c.req.query('name')!
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const file = join(memoriesDir(repoPath), `${name}.md`)
      if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
      await deps.fs.removeFile(file)
      // clear active if it was active
      const cfg = await readConfig(deps.fs, repoPath)
      if (cfg.active_memory === name) {
        delete cfg.active_memory
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json(
        { ok: false, error: 'delete_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.put('/memory/content', async (c) => {
    try {
      const { repo, name, content } = await c.req.json()
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const file = join(memoriesDir(repoPath), `${name}.md`)
      if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
      await deps.fs.writeFile(file, content)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(
        { ok: false, error: 'write_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.post('/memory/rename', async (c) => {
    try {
      const { repo, name, newName } = await c.req.json()
      if (!validName(name) || !validName(newName))
        return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const dir = memoriesDir(repoPath)
      const oldFile = join(dir, `${name}.md`)
      const newFile = join(dir, `${newName}.md`)
      if (!(await deps.fs.exists(oldFile))) return c.json({ ok: false, error: 'not_found' }, 404)
      if (await deps.fs.exists(newFile)) return c.json({ ok: false, error: 'exists' }, 409)
      if (!newFile.startsWith(dir + sep)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      await deps.fs.move(oldFile, newFile)
      const cfg = await readConfig(deps.fs, repoPath)
      if (cfg.active_memory === name) {
        cfg.active_memory = newName
        await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      }
      return c.json({ ok: true, name: newName })
    } catch (e) {
      return c.json(
        { ok: false, error: 'rename_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.post('/memory/active', async (c) => {
    try {
      const { repo, name } = await c.req.json()
      if (!validName(name)) return c.json({ ok: false, error: 'invalid_name' }, 400)
      const repoPath = await resolveRepoPath(deps.fs, repo, deps.home)
      const file = join(memoriesDir(repoPath), `${name}.md`)
      if (!(await deps.fs.exists(file))) return c.json({ ok: false, error: 'not_found' }, 404)
      const cfg = await readConfig(deps.fs, repoPath)
      cfg.active_memory = name
      await writeYaml(deps.fs, join(repoPath, 'config.yaml'), cfg)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(
        { ok: false, error: 'activate_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  app.post('/memory/preview', async (c) => {
    try {
      const { content, agent } = await c.req.json()
      const a = agent as AgentId
      const ctx = {
        env: {
          LOOM_AGENT: a,
          LOOM_CONFIG_DIR: agentConfigDir(a),
          LOOM_SKILLS_DIR: agentSkillsDir(a),
          LOOM_AGENT_FILE: a === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
        },
        activeProfile: {},
        defaultProfile: {},
      }
      const rendered = renderText(content, ctx)
      return c.json({ rendered })
    } catch (e) {
      return c.json(
        { ok: false, error: 'render_failed', message: String((e as Error).message) },
        400,
      )
    }
  })

  return app
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/server/test/api/memory.test.ts`
Expected: PASS. (If `removeFile` not on `IFileSystem` — added in Task 9 — ensure it's implemented.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/routes/memory.ts packages/server/test/api/memory.test.ts
git commit -m "feat(server): memory CRUD + active + preview routes"
```

---

### Task 13:router 注册 memory 路由

**Files:**

- Modify: `packages/server/src/api/router.ts`

- [ ] **Step 1: Register route**

In `packages/server/src/api/router.ts`:

```ts
import { createMemoryRoutes } from './routes/memory.js'
// ...
app.route('/', createMemoryRoutes(deps))
```

- [ ] **Step 2: Run server smoke test**

Run: `bunx vitest run packages/server/test`. Then `bun dev` and `curl 'http://localhost:3000/api/memory?repo=default'` → expect JSON `{memories:[],active:null,activeContent:''}`.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api/router.ts
git commit -m "feat(server): register memory routes"
```

---

### Task 14:web api.ts memory 方法

**Files:**

- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add memory methods + scope**

Append to `api` object in `packages/web/src/lib/api.ts`:

```ts
  getMemory: (repo: string) =>
    fetch(`${base}/memory?repo=${encodeURIComponent(repo)}`).then(json) as Promise<{
      memories: Array<{ name: string }>
      active: string | null
      activeContent: string
    }>,
  createMemory: (body: { repo: string; name: string }) => post('/memory', body).then(json),
  deleteMemory: (repo: string, name: string) =>
    fetch(`${base}/memory?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }).then(json),
  saveMemoryContent: (body: { repo: string; name: string; content: string }) =>
    fetch(`${base}/memory/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),
  renameMemory: (body: { repo: string; name: string; newName: string }) =>
    post('/memory/rename', body).then(json),
  setMemoryActive: (body: { repo: string; name: string }) => post('/memory/active', body).then(json),
  previewMemory: (body: { repo: string; content: string; agent: string }) =>
    post('/memory/preview', body).then(json) as Promise<{ rendered?: string; error?: string; message?: string }>,
  project: (body: { repo: string; scope?: 'skills' | 'mcp' | 'memory' | 'all' }) =>
    post('/project', body).then(json),
```

(Replace the existing `project` line with the typed version above.)

- [ ] **Step 2: Type check**

Run: `cd packages/web && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(web): memory api methods + typed project scope"
```

---

### Task 15:MemoryEditor 组件(三视图 + 占位符高亮)

**Files:**

- Create: `packages/web/src/components/MemoryEditor.tsx`
- Reference: `docs/superpowers/plans/2026-07-05-memory-management-frontend.md`(**优化版完整代码,以此为准** — 由 ui-ux-pro-max + frontend-design 产出,复用 loom 现有 class + 占位符高亮 CSS)

- [ ] **Step 1: Implement component**

Create `packages/web/src/components/MemoryEditor.tsx`:

```tsx
import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { AGENTS, agentShort, type AgentId } from '@/lib/agents'

type View = 'edit' | 'preview' | 'resolved'

interface Props {
  repo: string
  name: string
  content: string
  onSave: (content: string) => Promise<void>
}

// Highlight ${VAR} and \${} in text for the overlay layer.
function highlight(text: string): string {
  // escape HTML first
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/\\\$\{[^}]*\}/g, (m) => `<span class="ph-esc">${m}</span>`)
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}/g, (m) => `<span class="ph-var">${m}</span>`)
}

export default function MemoryEditor({ repo, name, content, onSave }: Props) {
  const [view, setView] = useState<View>('edit')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewAgent, setPreviewAgent] = useState<AgentId>('claude-code')
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setEdit(content)
    setDirty(false)
  }, [content, name])

  // sync scroll between textarea and overlay
  const onScroll = () => {
    if (taRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = taRef.current.scrollTop
      overlayRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }

  const loadResolved = async () => {
    setResolveErr(null)
    try {
      const res = await api.previewMemory({ repo, content: edit, agent: previewAgent })
      if (res.rendered !== undefined) setResolved(res.rendered)
      else setResolveErr(res.message ?? res.error ?? '解析失败')
    } catch (e) {
      setResolveErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (view === 'resolved') loadResolved()
  }, [view, previewAgent, edit])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(edit)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 'var(--radius)',
    border: '1px solid',
    borderColor: active ? 'var(--primary)' : 'var(--border)',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? 'var(--primary)' : 'var(--muted)',
    cursor: 'pointer',
  })

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <button style={tabStyle(view === 'edit')} onClick={() => setView('edit')}>
          编辑
        </button>
        <button style={tabStyle(view === 'preview')} onClick={() => setView('preview')}>
          预览
        </button>
        <button style={tabStyle(view === 'resolved')} onClick={() => setView('resolved')}>
          解析预览
        </button>
        {view === 'resolved' && (
          <select
            value={previewAgent}
            onChange={(e) => setPreviewAgent(e.target.value as AgentId)}
            style={{ marginLeft: 'auto', fontSize: 11 }}
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {agentShort[a]}
              </option>
            ))}
          </select>
        )}
        {view === 'edit' && dirty && (
          <>
            <button
              style={{
                ...tabStyle(false),
                marginLeft: 'auto',
                borderColor: 'var(--primary)',
                color: 'var(--primary)',
              }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        )}
      </div>

      {view === 'edit' && (
        <div style={{ position: 'relative' }}>
          <pre
            ref={overlayRef}
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              margin: 0,
              padding: 12,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              pointerEvents: 'none',
              color: 'transparent',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
            }}
            dangerouslySetInnerHTML={{ __html: highlight(edit) + '\n' }}
          />
          <textarea
            ref={taRef}
            value={edit}
            onChange={(e) => {
              setEdit(e.target.value)
              setDirty(true)
            }}
            onScroll={onScroll}
            spellCheck={false}
            style={{
              position: 'relative',
              width: '100%',
              minHeight: 360,
              padding: 12,
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--text)',
              resize: 'vertical',
              outline: 'none',
              caretColor: 'var(--text)',
            }}
          />
        </div>
      )}

      {view === 'preview' && (
        <div
          className="md-preview"
          style={{
            padding: 14,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            minHeight: 360,
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{edit}</ReactMarkdown>
        </div>
      )}

      {view === 'resolved' && (
        <div>
          {resolveErr && (
            <div
              style={{
                marginBottom: 8,
                fontSize: 11,
                color: 'var(--error)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {resolveErr}
            </div>
          )}
          <div
            className="md-preview"
            style={{
              padding: 14,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              minHeight: 360,
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{resolved}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add highlight CSS**

Append to global CSS (e.g. `packages/web/src/index.css` or wherever `.md-preview` is defined):

```css
.ph-var {
  background: var(--accent);
  color: var(--primary);
  border-radius: 2px;
  padding: 0 1px;
}
.ph-esc {
  background: var(--muted);
  color: var(--bg);
  border-radius: 2px;
  padding: 0 1px;
  opacity: 0.7;
}
```

- [ ] **Step 3: Type check**

Run: `cd packages/web && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/MemoryEditor.tsx packages/web/src/index.css
git commit -m "feat(web): MemoryEditor with 3 views + placeholder highlight"
```

---

### Task 16:Memory.tsx 页面

**Files:**

- Create: `packages/web/src/views/Memory.tsx`
- Reference: `docs/superpowers/plans/2026-07-05-memory-management-frontend.md`(**优化版完整代码,以此为准**)

- [ ] **Step 1: Implement page**

Create `packages/web/src/views/Memory.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import MemoryEditor from '@/components/MemoryEditor'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/useToast'

interface Props {
  repoPath: string
}

export default function Memory({ repoPath }: Props) {
  const [memories, setMemories] = useState<Array<{ name: string }>>([])
  const [active, setActive] = useState<string | null>(null)
  const [activeContent, setActiveContent] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedContent, setSelectedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [projecting, setProjecting] = useState(false)
  const { showToast } = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.getMemory(repoPath)
      setMemories(res.memories)
      setActive(res.active)
      setActiveContent(res.activeContent)
      if (res.active && !selected) {
        setSelected(res.active)
        setSelectedContent(res.activeContent)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [repoPath])

  const select = async (name: string) => {
    setSelected(name)
    if (name === active) {
      setSelectedContent(activeContent)
    } else {
      // load content for non-active memory via preview trick or a dedicated read.
      // Reuse getMemory? No — only active has content. Fetch via preview with agent=claude-code returns rendered; we want raw.
      // Simpler: store all contents client-side is heavy. Add a tiny fetch: PUT path? No.
      // Workaround: GET /memory returns only activeContent. For non-active, we read via preview? That renders.
      // Decision: extend GET /memory?name=<n> to return that memory's raw content. (Add to Task 12 if not present.)
      // For this plan: assume GET /memory?repo=&name=<n> returns {content}. Add that query support.
      try {
        const res = await fetch(
          `/api/memory?repo=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}`,
        ).then((r) => r.json())
        setSelectedContent(res.content ?? '')
      } catch {
        setSelectedContent('')
      }
    }
  }

  const project = async () => {
    setProjecting(true)
    try {
      const res = (await api.project({ repo: repoPath, scope: 'memory' })) as any
      if (res.ok) showToast('投影完成')
      else showToast(res.message || '投影失败')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setProjecting(false)
    }
  }

  const create = async () => {
    if (!newName.trim()) return
    try {
      await api.createMemory({ repo: repoPath, name: newName.trim() })
      setCreating(false)
      setNewName('')
      await load()
      showToast('已创建')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doRename = async () => {
    if (!renaming || !newName.trim()) return
    try {
      await api.renameMemory({ repo: repoPath, name: renaming, newName: newName.trim() })
      setRenaming(null)
      setNewName('')
      await load()
      showToast('已重命名')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async (name: string) => {
    if (!confirm(`删除 ${name}?`)) return
    try {
      await api.deleteMemory(repoPath, name)
      if (selected === name) {
        setSelected(null)
        setSelectedContent('')
      }
      await load()
      showToast('已删除')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const activate = async (name: string) => {
    try {
      await api.setMemoryActive({ repo: repoPath, name })
      await load()
      showToast(`已激活 ${name}`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const save = async (content: string) => {
    if (!selected) return
    await api.saveMemoryContent({ repo: repoPath, name: selected, content })
    if (selected === active) setActiveContent(content)
    showToast('已保存')
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, height: '100%' }}>
      <div style={{ borderRight: '1px solid var(--border)', paddingRight: 12 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <span className="label">memories</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setCreating(true)
              setNewName('')
            }}
          >
            + 新建
          </Button>
        </div>
        {loading && <div style={{ fontSize: 12, color: 'var(--muted)' }}>加载中…</div>}
        {memories.map((m) => (
          <div
            key={m.name}
            onClick={() => select(m.name)}
            style={{
              padding: '6px 8px',
              borderRadius: 'var(--radius)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: selected === m.name ? 'var(--accent)' : 'transparent',
              borderLeft: active === m.name ? '3px solid var(--primary)' : '3px solid transparent',
            }}
          >
            <span style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
              {m.name}
            </span>
            {active === m.name && (
              <span style={{ fontSize: 10, color: 'var(--primary)' }}>激活</span>
            )}
            <span style={{ display: 'flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
              {active !== m.name && (
                <Button variant="ghost" size="xs" onClick={() => activate(m.name)}>
                  激活
                </Button>
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setRenaming(m.name)
                  setNewName(m.name)
                }}
              >
                改名
              </Button>
              <Button variant="ghost" size="xs" onClick={() => del(m.name)}>
                删
              </Button>
            </span>
          </div>
        ))}
        {!loading && memories.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>无 memory,点"新建"创建</div>
        )}
      </div>

      <div>
        {selected ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>
                {selected}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {AGENTS.map((a) => (
                  <span
                    key={a}
                    className="chip active"
                    style={{ ['--c' as string]: agentColor[a] }}
                  >
                    {agentShort[a]}
                  </span>
                ))}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={project}
                disabled={projecting}
                style={{ marginLeft: 'auto' }}
              >
                {projecting ? '投影中…' : '投影'}
              </Button>
            </div>
            <MemoryEditor repo={repoPath} name={selected} content={selectedContent} onSave={save} />
          </>
        ) : (
          <div
            style={{
              display: 'flex',
              height: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
            }}
          >
            选择或新建一份 memory
          </div>
        )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建 memory" width={360}>
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="name (v1, v2, ...)"
          style={{
            width: '100%',
            padding: 8,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
            取消
          </Button>
          <Button variant="secondary" size="sm" onClick={create}>
            创建
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={`重命名 ${renaming ?? ''}`}
        width={360}
      >
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{
            width: '100%',
            padding: 8,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
            取消
          </Button>
          <Button variant="secondary" size="sm" onClick={doRename}>
            重命名
          </Button>
        </div>
      </Modal>
    </div>
  )
}
```

**Note:** non-active memory content is fetched via `GET /memory?repo=&name=<n>`(Task 12 已支持该查询)。

- [ ] **Step 2: Type check + run**

Run: `cd packages/web && bunx tsc --noEmit`. Then `bun dev`, navigate to `/memory`, verify: list loads, create/rename/delete work, editor shows, 3 views switch, highlight visible, projection button calls scope=memory.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/views/Memory.tsx packages/server/src/api/routes/memory.ts
git commit -m "feat(web): Memory page with list + editor + projection"
```

---

### Task 17:App.tsx 路由 + Skills/Mcp scope

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/views/skills/Skills.tsx`
- Modify: `packages/web/src/views/Mcp.tsx`

- [ ] **Step 1: Add Memory route + NavLink**

In `packages/web/src/App.tsx`:

```ts
import Memory from './views/Memory'
// in sidebar workspace section, after MCP:
          <NavLink to="/memory" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ic">✦</span>Memory
          </NavLink>
// in <Routes>:
            <Route path="memory" element={<Memory repoPath={repoPath} />} />
```

- [ ] **Step 2: Skills/Mcp pass scope**

In `packages/web/src/views/skills/Skills.tsx` `project`:

```ts
const res = (await api.project({ repo: repoPath, scope: 'skills' })) as any
```

In `packages/web/src/views/Mcp.tsx` `project`:

```ts
await api.project({ repo: repoPath, scope: 'mcp' })
```

- [ ] **Step 3: Run + verify**

Run: `bun dev`. Verify: sidebar has Memory link; Skills 投影 only writes skills (check `~/.claude/skills/` updated, `CLAUDE.md` untouched); MCP 投影 only writes mcp config; Memory 投影 only writes `CLAUDE.md`/`AGENTS.md`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/views/skills/Skills.tsx packages/web/src/views/Mcp.tsx
git commit -m "feat(web): Memory route + per-page projection scope"
```

---

## Self-Review

**Spec coverage:**

- §1 数据模型(Task 5 types + Task 7 manifest + Task 12 路由存储)✓
- §2 vars 渲染 + 转义(Task 6 renderText + Task 10/12 内置变量注入)✓
- §2 paths.ts opencode 修正 + agentMemoryFile(Task 1)✓
- §3 scope 参数(Task 10 executor + Task 11 路由 + Task 17 前端)✓
- §3 memory 投影 Phase D(Task 10)✓
- §4 前端页面 + API(Task 12 路由 + Task 14 api + Task 15 editor + Task 16 page + Task 17 routing)✓
- §4 三视图 + 高亮(Task 15)✓
- §5 Git 同步(memories/*.md 已在 repo 内,readRepoFiles Task 7 扩展;走文本合并 — 复用现有 assets 文本冲突检测,无需新 merge kind)✓
- §5 边界(空/不存在/删除激活/重命名/未定义变量 — Task 7/10/12 覆盖)✓
- §6 repoPath→repo 整改(Task 2 resolveRepoPath + Task 3 后端 + Task 4 前端)✓
- §6 路径攻击防护(Task 2 目录列表 + Task 12 name 校验 + startsWith)✓

**Placeholder scan:** 无 TBD/TODO;所有代码步骤含完整代码。Task 3 批量替换用"模式 + 文件清单"(机械重命名,非逻辑实现),已给完整模式示例。Task 16 的 Note 引用 Task 12 已实现的 `?name=` 查询,非占位符。

**Type consistency:** `Memory`、`MemoryManifest`、`MemoryPlan`、`ProjectionScope`、`restoreMemory`、`agentMemoryFile`、`renderText`、`resolveRepoPath` 在各 task 中名称一致。`api.project` 在 Task 14 重定义为带 scope 类型,Task 16/17 调用一致。

**Gaps fixed inline:**

- Task 9 发现 `IFileSystem` 缺 `removeFile`,已在该 task 内补 port + 实现。
- Task 16 发现 `GET /memory` 需支持 `name` 查询返回单条内容 → 已回填 Task 12(实现 + 测试用例),Task 16 Note 简化为引用。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-05-memory-management.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 task 派一个 fresh subagent,task 间 review,快速迭代。

**2. Inline Execution** - 在当前会话用 executing-plans 批量执行,带 checkpoint 审查。

哪种方式?
