# Loom Core + Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Loom 纯 TS 核心层(数据模型/manifest 校验/变量解析/结构化三向 merge/version compare/projection IR)与 Platform 层可替换接口(IFileSystem/IGit/IProcess)的 Node 实现 + 首次初始化(platform 层编排),全单测覆盖。

**Architecture:** Core 层纯 TS 零平台依赖,所有平台 API 经 Platform 层接口注入;Node 实现内部处理 symlink/junction/copy 降级与 git/proc。TDD,vitest 单测。

**Tech Stack:** Node.js, TypeScript (strict), vitest, js-yaml, simple-git

## Global Constraints

- Core 层纯 TS 零平台依赖:不 import `node:fs` / `node:child_process` / `node:path` / `simple-git`,只依赖 Platform 接口(initLoom 编排 fs+git,放 platform/node 层)
- TS 字段名一律 snake_case 对齐 spec/config.yaml 产物(`active_repo`/`update_check`/`no_proxy`/`pinned_commit`),loadRepoManifest 不做键名转换
- 实现(.ts)import 带 `.js` 扩展名(ESM);测试 import 不带 `.js`(走 vitest Bundler 解析),二者约定不混用
- 包管理用 pnpm;跑测试用 `pnpm vitest run <file>`(若因 ignored builds 报错,先 `pnpm approve-builds` 或用 `pnpm exec vitest run <file>`)
- 变量插值 `${VAR}` / `${VAR:default}`,解析失败不静默(投影前校验失败)
- Windows junction 仅本地绝对路径目录、不可跨卷、跨卷降级 copy 并返回 fallback 提示;removeLink 只删链接禁止递归删目标
- 配置两级:仓库级 `<repo>/config.yaml`(同步)+ 本地级 `~/.loom/config.yaml`(不同步,覆盖),嵌套对象深合并,数组整体替换
- manifest = skills.yaml + mcp.yaml + vars/*.yaml + 仓库级 config.yaml 聚合(本地级 config 不属于 manifest)
- 时间格式:文档到日,日志到秒,中国时区(+08:00 不标注)
- 日志:错误处理节点(catch/错误分支/降级)必须记日志带完整对象与堆栈,不得静默吞错

---

## File Structure

- `src/core/types.ts` — manifest 与 config 的 TS 类型定义(零依赖,字段 snake_case 对齐 YAML)
- `src/core/manifest.ts` — manifest 加载、校验、config 两级合并、RepoManifest→Manifest 聚合
- `src/core/vars.ts` — 变量解析(环境变量 > active profile > default profile > default 字面 > 报错)
- `src/core/merge.ts` — 结构化三向 merge(按文件类型选 key,嵌套对象递归深合并)
- `src/core/version.ts` — 远程 skill version compare
- `src/core/projection.ts` — projection IR(投影计划,不执行 IO)
- `src/platform/interfaces.ts` — IFileSystem / IGit / IProcess 接口
- `src/platform/node/fs.ts` — Node fs 实现(symlink/junction/copy 降级、removeLink 不递归)
- `src/platform/node/git.ts` — Node git 实现(基于 simple-git)
- `src/platform/node/proc.ts` — Node proc 实现(agent 安装检测)
- `src/platform/node/init.ts` — 首次初始化骨架(编排 fs+git,属平台层;Core 零 node: import)
- `src/platform/node/index.ts` — 装配:返回 Node 平台实现对象
- `tests/core/*.test.ts` / `tests/platform/node/*.test.ts` — 对应单测
- `package.json` / `tsconfig.json` / `vitest.config.ts` — 脚手架

---

## Task 1: 脚手架与类型定义

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/types.ts`
- Test: `tests/core/types.test.ts`

**Interfaces:**
- Produces: `AgentId`, `SkillSource`, `LocalSkill`, `SkillMemberOverride`, `McpServer`, `McpType`, `ProjectionConfig`, `UpdateCheckConfig`, `ProxyConfig`, `Config`, `Manifest`, `RepoManifest` (被后续所有 task 消费)

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/types.test.ts
import { describe, it, expectTypeOf } from 'vitest'
import type { AgentId, Manifest, McpServer, Config, SkillSource } from '../../src/core/types'

describe('types', () => {
  it('AgentId is the three supported agents', () => {
    expectTypeOf<AgentId>().toEqualTypeOf<'claude-code' | 'codex' | 'opencode'>()
  })
  it('McpServer stdio has command/args/env, targets optional', () => {
    const m: McpServer = { id: 'x', type: 'stdio', command: 'npx', args: ['p'], env: {}, targets: ['claude-code'] }
    expectTypeOf(m).toMatchTypeOf<McpServer>()
    const m2: McpServer = { id: 'y', type: 'stdio', command: 'npx' } // targets 可缺(外部手写 YAML)
    expectTypeOf(m2).toMatchTypeOf<McpServer>()
  })
  it('Config fields are snake_case to align with YAML', () => {
    const c: Config = { profile: 'local', targets: ['claude-code'], projection: { strategy: 'link' }, update_check: { enabled: true, interval: '6h' }, active_repo: 'default', proxy: { http: '', https: '', no_proxy: '' } }
    expectTypeOf(c).toMatchTypeOf<Config>()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/core/types.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/types'`

- [ ] **Step 3: 写脚手架与类型**

```json
// package.json
{
  "name": "loom",
  "version": "0.1.0",
  "type": "module",
  "scripts": { "test": "vitest run", "test:watch": "vitest" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^22.0.0", "js-yaml": "^4.1.0", "@types/js-yaml": "^4.0.9", "simple-git": "^3.25.0" },
  "dependencies": { "zod": "^3.23.0" }
}
```

```json
// tsconfig.json
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "esModuleInterop": true, "types": ["node"], "outDir": "dist", "rootDir": ".", "skipLibCheck": true },
  "include": ["src", "tests"]
}
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node' } })
```

```typescript
// src/core/types.ts
// 字段名一律 snake_case 对齐 spec/config.yaml 产物(loadRepoManifest 不做键名转换)
export type AgentId = 'claude-code' | 'codex' | 'opencode'
export type McpType = 'stdio' | 'sse' | 'http'

export interface SkillMemberOverride {
  name: string
  enabled?: boolean
  targets?: AgentId[]
}

export interface SkillSource {
  url: string
  ref: string
  pinned_commit?: string // spec: pinned_commit(hash),兑现可复现(tag mutable)
  scan?: string
  members?: SkillMemberOverride[]
}

export interface LocalSkill {
  id: string
  path?: string
}

export interface SkillsManifest {
  sources: SkillSource[]
  skills: LocalSkill[]
}

export interface McpServer {
  id: string
  type: McpType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  targets?: AgentId[] // 外部手写 YAML 可缺,由 validateManifest 校验
}

export interface ProjectionConfig { strategy: 'link' | 'copy' }
export interface UpdateCheckConfig { enabled: boolean; interval: string }
export interface ProxyConfig { http?: string; https?: string; no_proxy?: string } // 字段可选,贴合 spec「本地级只写某子字段」深合并

export interface Config {
  profile?: string
  targets?: AgentId[]
  projection?: ProjectionConfig
  update_check?: UpdateCheckConfig
  active_repo?: string
  proxy?: ProxyConfig
}

export interface VarsFile { [key: string]: string }

export interface Manifest {
  skills: SkillsManifest
  mcp: McpServer[]
  vars: { default: VarsFile; active: VarsFile }
  config: Config // 仓库级 config(已与本地级合并后的有效值由 caller 传)
  errors: string[] // manifest 校验错误(投影前检查,spec 行 190);空数组表示合法
}

// 配置仓内加载到的原始数据(未合并)
export interface RepoManifest {
  skills: SkillsManifest
  mcp: McpServer[]
  varsFiles: Record<string, VarsFile> // profile 名 -> vars
  repoConfig: Config // 仓库级 config.yaml
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/core/types.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add package.json tsconfig.json vitest.config.ts src/core/types.ts tests/core/types.test.ts
git commit -m "feat(core): scaffold + manifest/config types"
```

---

## Task 2: Manifest 加载、校验、config 两级合并

**Files:**
- Create: `src/core/manifest.ts`
- Test: `tests/core/manifest.test.ts`

**Interfaces:**
- Consumes: `RepoManifest`, `Config`, `Manifest` from `types.ts`; IFileSystem (Task 4) — 此 task 先用一个最小 `readFile` 抽象注入,避免依赖 Platform
- Produces: `loadRepoManifest(files: Record<string, string>): RepoManifest`, `validateManifest(m: RepoManifest): string[]`, `mergeConfig(repo: Config, local: Config): Config`(被 Task 7 planProjection / Plan 3 sync 消费;调用方 `planProjection(manifest, mergeConfig(repoConfig, localConfig), agents)`), `buildManifest(repo: RepoManifest, localConfig: Config): Manifest`(RepoManifest→Manifest 聚合:effectiveConfig=mergeConfig、active profile=varsFiles[config.profile ?? 'default'])

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/manifest.test.ts
import { describe, it, expect } from 'vitest'
import { loadRepoManifest, validateManifest, mergeConfig, buildManifest } from '../../src/core/manifest'
import type { RepoManifest, Config } from '../../src/core/types'

const files = {
  'skills.yaml': 'sources:\n  - url: github:obra/superpowers\n    ref: v5.1.4\nskills:\n  - id: frontend-design\n',
  'mcp.yaml': '- id: playwright\n  type: stdio\n  command: npx\n  args: ["p"]\n  targets: [claude-code]\n',
  'vars/default.yaml': 'browsers_path: ~/.cache/ms-playwright\n',
  'config.yaml': 'profile: local\ntargets: [claude-code, codex]\nprojection:\n  strategy: link\n',
}

describe('loadRepoManifest', () => {
  it('parses skills/mcp/vars/config from file map', () => {
    const m = loadRepoManifest(files)
    expect(m.skills.sources[0].url).toBe('github:obra/superpowers')
    expect(m.mcp[0].id).toBe('playwright')
    expect(m.varsFiles.default.browsers_path).toBe('~/.cache/ms-playwright')
    expect(m.repoConfig.targets).toEqual(['claude-code', 'codex'])
  })
})

describe('validateManifest (zod discriminatedUnion)', () => {
  it('flags mcp stdio missing command', () => {
    const m = loadRepoManifest({ 'mcp.yaml': '- id: x\n  type: stdio\n', 'skills.yaml': 'sources: []\nskills: []\n' })
    expect(validateManifest(m).some(e => e.includes('mcp[0]') && e.includes('command'))).toBe(true)
  })
  it('flags mcp sse missing url', () => {
    const m = loadRepoManifest({ 'mcp.yaml': '- id: x\n  type: sse\n', 'skills.yaml': 'sources: []\nskills: []\n' })
    expect(validateManifest(m).some(e => e.includes('url'))).toBe(true)
  })
  it('accepts mcp without targets (回退全局,spec 行 174)', () => {
    const m = loadRepoManifest({ 'mcp.yaml': '- id: x\n  type: stdio\n  command: c\n', 'skills.yaml': 'sources: []\nskills: []\n' })
    expect(validateManifest(m)).toHaveLength(0)
  })
  it('flags source missing ref', () => {
    const m = loadRepoManifest({ 'skills.yaml': 'sources:\n  - url: github:x/y\nskills: []\n', 'mcp.yaml': '[]\n' })
    expect(validateManifest(m).some(e => e.includes('source[0]') && e.includes('ref'))).toBe(true)
  })
  it('flags source missing url (spec 行 138/155)', () => {
    const m = loadRepoManifest({ 'skills.yaml': 'sources:\n  - ref: v1\nskills: []\n', 'mcp.yaml': '[]\n' })
    expect(validateManifest(m).some(e => e.includes('source[0]') && e.includes('url'))).toBe(true)
  })
})

describe('mergeConfig (two-level, deep merge)', () => {
  it('local overrides repo top-level field', () => {
    expect(mergeConfig({ profile: 'a', targets: ['claude-code'] }, { profile: 'b' }).profile).toBe('b')
  })
  it('local deep-merges nested object, keeps repo sibling fields (snake_case)', () => {
    const r = mergeConfig({ proxy: { http: 'r', https: 'r', no_proxy: 'n' } }, { proxy: { http: 'L' } })
    expect(r.proxy).toEqual({ http: 'L', https: 'r', no_proxy: 'n' })
  })
  it('array is replaced wholesale, not element-merged', () => {
    expect(mergeConfig({ targets: ['claude-code'] }, { targets: ['codex'] }).targets).toEqual(['codex'])
  })
  it('local omits a key => inherits repo (删行回退,非设空字符串)', () => {
    expect(mergeConfig({ active_repo: 'r', profile: 'r' }, { active_repo: 'L' }).profile).toBe('r')
  })
  it('local explicit null overrides as null (null 是显式值,不回退)', () => {
    expect(mergeConfig({ profile: 'repo' }, { profile: null as unknown as string } as Config).profile).toBe(null)
  })
})

describe('buildManifest (RepoManifest -> Manifest)', () => {
  it('effective config = mergeConfig(repo, local); active profile from config.profile', () => {
    const repo: RepoManifest = {
      skills: { sources: [], skills: [] }, mcp: [],
      varsFiles: { default: { a: 'd' }, local: { a: 'l', b: 'x' } },
      repoConfig: { profile: 'local', targets: ['claude-code'] },
    }
    const m = buildManifest(repo, { targets: ['codex'] })
    expect(m.config.targets).toEqual(['codex']) // local 覆盖
    expect(m.config.profile).toBe('local') // 继承 repo
    expect(m.vars.default).toEqual({ a: 'd' })
    expect(m.vars.active).toEqual({ a: 'l', b: 'x' }) // active = varsFiles[profile]
  })
  it('profile 缺省时 active 回退 default', () => {
    const repo: RepoManifest = { skills: { sources: [], skills: [] }, mcp: [], varsFiles: { default: { a: 'd' } }, repoConfig: {} }
    const m = buildManifest(repo, {})
    expect(m.vars.active).toEqual({ a: 'd' })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/core/manifest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/core/manifest.ts
import yaml from 'js-yaml'
import { z } from 'zod'
import type { Config, RepoManifest, Manifest, VarsFile } from './types.js'

export function loadRepoManifest(files: Record<string, string>): RepoManifest {
  const parse = <T>(p: string, fallback: T): T => {
    const raw = files[p]
    if (raw === undefined) return fallback
    return yaml.load(raw) as T
  }
  const skills = parse('skills.yaml', { sources: [], skills: [] })
  const mcp = parse('mcp.yaml', [])
  const varsFiles: Record<string, VarsFile> = {}
  for (const path of Object.keys(files)) {
    if (path.startsWith('vars/') && path.endsWith('.yaml')) {
      const profile = path.slice('vars/'.length, -'.yaml'.length)
      varsFiles[profile] = parse(path, {})
    }
  }
  const repoConfig = parse('config.yaml', {})
  return { skills, mcp, varsFiles, repoConfig }
}

const AgentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
// MCP server 按 type 判别,字段互斥(spec 行 165):stdio 需 command,sse/http 需 url;targets 可缺(回退全局,spec 行 174)
const McpServerSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), targets: z.array(AgentIdSchema).optional() }),
  z.object({ id: z.string().min(1), type: z.literal('sse'), url: z.string().min(1), headers: z.record(z.string()).optional(), env: z.record(z.string()).optional(), targets: z.array(AgentIdSchema).optional() }),
  z.object({ id: z.string().min(1), type: z.literal('http'), url: z.string().min(1), headers: z.record(z.string()).optional(), env: z.record(z.string()).optional(), targets: z.array(AgentIdSchema).optional() }),
])
const SkillSourceSchema = z.object({
  url: z.string().min(1), ref: z.string().min(1), pinned_commit: z.string().optional(), scan: z.string().optional(),
  members: z.array(z.object({ name: z.string().min(1), enabled: z.boolean().optional(), targets: z.array(AgentIdSchema).optional() })).optional(),
})

export function validateManifest(m: RepoManifest): string[] {
  const errs: string[] = []
  m.skills.sources.forEach((s, i) => {
    const r = SkillSourceSchema.safeParse(s)
    if (!r.success) for (const iss of r.error.issues) errs.push(`source[${i}].${iss.path.join('.')}: ${iss.message}`)
  })
  m.mcp.forEach((s, i) => {
    const r = McpServerSchema.safeParse(s)
    if (!r.success) for (const iss of r.error.issues) errs.push(`mcp[${i}].${iss.path.join('.')}: ${iss.message}`)
  })
  return errs
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(repo: T, local: unknown): T {
  if (!isPlainObject(repo) || !isPlainObject(local)) return (local === undefined ? repo : local) as T
  const out: Record<string, unknown> = { ...repo }
  for (const k of Object.keys(local)) {
    out[k] = deepMerge(repo[k], (local as Record<string, unknown>)[k])
  }
  return out as T
}

export function mergeConfig(repo: Config, local: Config): Config {
  return deepMerge(repo, local)
}

export function buildManifest(repo: RepoManifest, localConfig: Config): Manifest {
  const effective = mergeConfig(repo.repoConfig, localConfig)
  const profileName = effective.profile ?? 'default'
  const defaultVars = repo.varsFiles['default'] ?? {}
  return {
    skills: repo.skills,
    mcp: repo.mcp,
    vars: { default: defaultVars, active: repo.varsFiles[profileName] ?? defaultVars },
    config: effective,
    errors: validateManifest(repo), // 投影前校验入口(spec 行 190);Plan 2 执行层据 errors 决定是否跳过投影
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/core/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/manifest.ts tests/core/manifest.test.ts
git commit -m "feat(core): manifest load/validate + two-level config deep merge"
```

---

## Task 3: 变量解析

**Files:**
- Create: `src/core/vars.ts`
- Test: `tests/core/vars.test.ts`

**Interfaces:**
- Consumes: `VarsFile` from `types.ts`
- Produces: `resolveVars(value, ctx)`, `ResolveError`; ctx = `{ env, activeProfile, defaultProfile }`. 被 projection (Task 7 / Plan 2) 消费,投影前解析 `${VAR}` 为明文

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/vars.test.ts
import { describe, it, expect } from 'vitest'
import { resolveVars } from '../../src/core/vars'

const ctx = { env: { TOKEN: 'env-tok' }, activeProfile: { TOKEN: 'active-tok', ONLY_ACTIVE: 'a' }, defaultProfile: { ONLY_DEFAULT: 'd', browsers_path: '/p' } }

describe('resolveVars', () => {
  it('env beats profile', () => {
    expect(resolveVars('${TOKEN}', ctx)).toBe('env-tok')
  })
  it('active profile beats default', () => {
    expect(resolveVars('${ONLY_ACTIVE}', ctx)).toBe('a')
  })
  it('falls back to default profile', () => {
    expect(resolveVars('${ONLY_DEFAULT}', ctx)).toBe('d')
  })
  it('default value syntax when unset', () => {
    expect(resolveVars('${MISSING:fallback}', ctx)).toBe('fallback')
  })
  it('literal passthrough', () => {
    expect(resolveVars('plain text', ctx)).toBe('plain text')
  })
  it('mixed literal + ref concatenates', () => {
    expect(resolveVars('Bearer ${TOKEN}', ctx)).toBe('Bearer env-tok')
  })
  it('throws on undefined var with no default', () => {
    expect(() => resolveVars('${NOPE}', ctx)).toThrow(/NOPE/)
  })
  it('undefined var in mixed value fails whole value (不部分替换)', () => {
    expect(() => resolveVars('Bearer ${NOPE}', ctx)).toThrow(/NOPE/)
  })
  it('empty default ${VAR:} resolves to empty string', () => {
    expect(resolveVars('${MISSING:}', ctx)).toBe('')
  })
  it('env empty string still wins, no fallback to profile', () => {
    expect(resolveVars('${TOKEN}', { ...ctx, env: { TOKEN: '' } })).toBe('')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/core/vars.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/core/vars.ts
import type { VarsFile } from './types.js'

export interface VarsContext { env: Record<string, string>; activeProfile: VarsFile; defaultProfile: VarsFile }
export class ResolveError extends Error {}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g

export function resolveVars(value: string, ctx: VarsContext): string {
  if (!value.includes('${')) return value
  return value.replace(REF, (full, name: string, def: string | undefined) => {
    if (Object.prototype.hasOwnProperty.call(ctx.env, name)) return ctx.env[name]
    if (Object.prototype.hasOwnProperty.call(ctx.activeProfile, name)) return ctx.activeProfile[name]
    if (Object.prototype.hasOwnProperty.call(ctx.defaultProfile, name)) return ctx.defaultProfile[name]
    if (def !== undefined) return def
    throw new ResolveError(`undefined variable: ${name}`)
  })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/core/vars.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/vars.ts tests/core/vars.test.ts
git commit -m "feat(core): variable resolution with priority chain + default syntax"
```

---

## Task 4: Platform 接口与 Node fs 实现

**Files:**
- Create: `src/platform/interfaces.ts`, `src/platform/node/fs.ts`, `src/platform/node/proc.ts`
- Test: `tests/platform/node/fs.test.ts`

**Interfaces:**
- Produces: `IFileSystem` (createLink 返回 `{fallback:'copy'|null}` 供调用方提示降级 /removeLink/readFile/writeFile/exists/mkdir/readDir/isLink), `IProcess` (isInstalled), `IGit` (含 init); Node fs 实现内部处理 symlink/junction/copy 降级、removeLink 只删链接不递归。被 init(Task 8)/projection(Plan 2) 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/platform/node/fs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../../src/platform/node/fs'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'loom-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('NodeFileSystem', () => {
  it('createLink makes a link to a dir target, returns fallback null', async () => {
    const target = join(root, 'target'); await mkdir(target)
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    const res = await fs.createLink(target, link)
    expect(res.fallback).toBe(null)
    expect(await fs.exists(link)).toBe(true)
  })
  it('removeLink removes only the link, not target contents (数据丢失级风险守护)', async () => {
    const target = join(root, 'target'); await mkdir(target); await writeFile(join(target, 'f.txt'), 'data')
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    await fs.createLink(target, link)
    expect(await fs.isLink(link)).toBe(true)
    await fs.removeLink(link)
    expect(await fs.exists(link)).toBe(false)
    expect(await fs.exists(join(target, 'f.txt'))).toBe(true) // target 内容还在
  })
  it('createLink refuses to overwrite a real file', async () => {
    const target = join(root, 'target'); await mkdir(target)
    const link = join(root, 'link'); await writeFile(link, 'real')
    await expect(new NodeFileSystem().createLink(target, link)).rejects.toThrow(/refuse|exists/)
  })
  it('createLink falls back to copy (fallback:"copy") when symlink throws EXDEV/EPERM', async () => {
    const target = join(root, 't'); await mkdir(target); await writeFile(join(target, 'f'), 'x')
    const link = join(root, 'link')
    const fs = new NodeFileSystem({ forceLinkError: 'EXDEV' } as any)
    const res = await fs.createLink(target, link)
    expect(res.fallback).toBe('copy') // 降级发生,调用方据此外报 UI(spec:跨卷降级并提示)
    expect(await fs.exists(join(link, 'f'))).toBe(true)
    expect(await fs.isLink(link)).toBe(false) // copy 结果不是链接
  })
  it.skipIf(platform() !== 'win32')('Windows junction: removeLink 不递归删目标真实内容', async () => {
    // 仅 win32 实跑;junction 由 createLink 内部对目录使用。非 win32 跳过(CI 跑不到此路径)
    const target = join(root, 'target'); await mkdir(target); await writeFile(join(target, 'f.txt'), 'keep')
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    await fs.createLink(target, link) // win32 下建 junction
    await fs.removeLink(link)
    expect(await fs.exists(join(target, 'f.txt'))).toBe(true) // junction 删除不波及目标
  })
  it('createLink replaces existing link to new target (spec 行 235 先解链再重建)', async () => {
    const targetA = join(root, 'a'); await mkdir(targetA); await writeFile(join(targetA, 'f'), 'A')
    const targetB = join(root, 'b'); await mkdir(targetB); await writeFile(join(targetB, 'f'), 'B')
    const link = join(root, 'link')
    const fs = new NodeFileSystem()
    await fs.createLink(targetA, link)
    await fs.createLink(targetB, link) // 已有链接 -> 先解链再重建指向 B
    expect(await fs.isLink(link)).toBe(true)
    expect(await fs.exists(join(link, 'f'))).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/platform/node/fs.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/platform/interfaces.ts
export interface IFileSystem {
  createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  removeLink(linkPath: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  mkdir(path: string, recursive?: boolean): Promise<void>
  readDir(path: string): Promise<string[]>
  isLink(path: string): Promise<boolean>
}
export interface IProcess {
  isInstalled(agentId: string): Promise<boolean>
}
export interface IGit {
  init(repoPath: string): Promise<void>
  fetch(repoPath: string): Promise<void>
  mergeBase(repoPath: string, a: string, b: string): Promise<string>
  lsRemote(url: string): Promise<{ tags: Record<string, string>; head: string }>
  clone(url: string, dest: string, shallow?: boolean): Promise<void>
  checkout(repoPath: string, ref: string): Promise<void>
  add(repoPath: string, paths: string[]): Promise<void>
  commit(repoPath: string, msg: string): Promise<void>
  push(repoPath: string): Promise<{ ok: boolean; nonFastForward?: boolean }>
  status(repoPath: string): Promise<{ dirty: boolean }>
}
```

```typescript
// src/platform/node/proc.ts
import { execFileSync } from 'node:child_process'
import type { IProcess } from '../interfaces.js'

export class NodeProcess implements IProcess {
  async isInstalled(agentId: string): Promise<boolean> {
    const map: Record<string, string> = { 'claude-code': 'claude', 'codex': 'codex', 'opencode': 'opencode' }
    const bin = map[agentId]
    if (!bin) return false
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true }
    catch { return false }
  }
}
```

```typescript
// src/platform/node/fs.ts
import { symlink, rm, readFile, writeFile as fsWriteFile, mkdir as fsMkdir, readdir, stat, lstat, copyFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { IFileSystem } from '../interfaces.js'

export interface FsOptions { forceLinkError?: string | null } // 测试用:模拟 symlink 失败码

export class NodeFileSystem implements IFileSystem {
  constructor(private opts: FsOptions = {}) {}

  async createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }> {
    if (await this.exists(linkPath)) {
      if (await this.isLink(linkPath)) { await this.removeLink(linkPath) }
      else throw new Error(`refuse to overwrite real file: ${linkPath}`)
    }
    const absTarget = resolveAbs(targetDir), absLink = resolveAbs(linkPath)
    try {
      if (this.opts.forceLinkError) throw Object.assign(new Error('simulated'), { code: this.opts.forceLinkError })
      if (process.platform === 'win32') {
        // Windows:目录用 junction(无权限要求);跨卷会抛 EXDEV -> catch 降级 copy
        await symlink(absTarget, absLink, 'junction')
      } else {
        await symlink(absTarget, absLink, 'dir')
      }
      return { fallback: null }
    } catch (e: any) {
      if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'ENOSYS') {
        await this.copyDir(absTarget, absLink) // 降级 copy
        return { fallback: 'copy' } // 外报 UI:已降级(spec:跨卷降级并提示)
      } else throw e
    }
  }

  async removeLink(linkPath: string): Promise<void> {
    // 只删链接本身,禁止递归删目标(junction 用 rm -rf 会删目标真实内容)
    if (!await this.isLink(linkPath)) return
    await rm(linkPath, { recursive: false, force: true })
  }

  async isLink(path: string): Promise<boolean> {
    try { const s = await lstat(path); return s.isSymbolicLink() } catch { return false }
  }
  async exists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }
  async readFile(path: string): Promise<string> { return readFile(path, 'utf8') }
  async writeFile(path: string, content: string): Promise<void> { await fsWriteFile(path, content, 'utf8') }
  async mkdir(path: string, recursive = true): Promise<void> { await fsMkdir(path, { recursive }) }
  async readDir(path: string): Promise<string[]> { return readdir(path) }

  private async copyDir(src: string, dest: string): Promise<void> {
    await fsMkdir(dest, { recursive: true })
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const s = join(src, entry.name), d = join(dest, entry.name)
      if (entry.isDirectory()) await this.copyDir(s, d)
      else await copyFile(s, d)
    }
  }
}

function resolveAbs(p: string): string {
  // junction 需绝对路径;已是绝对直接返回,否则相对 cwd 解析(ESM 下不能用 require)
  return isAbsolute(p) ? p : join(process.cwd(), p)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/platform/node/fs.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/platform/interfaces.ts src/platform/node/fs.ts src/platform/node/proc.ts tests/platform/node/fs.test.ts
git commit -m "feat(platform): IFileSystem/IProcess + Node fs (junction/copy fallback, safe removeLink)"
```

---

## Task 5: Node git 实现

**Files:**
- Create: `src/platform/node/git.ts`
- Test: `tests/platform/node/git.test.ts`

**Interfaces:**
- Consumes: `IGit` from `interfaces.ts` (Task 4)
- Produces: `NodeGit implements IGit` — init/fetch/mergeBase/lsRemote/clone/checkout/add/commit/push(返回 nonFastForward)/status。被 sync/remote(Plan 3) 与 init(Task 8) 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/platform/node/git.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../../src/platform/node/git'

async function makeBareWithCommit(): Promise<string> {
  const bare = await mkdtemp(join(tmpdir(), 'bare-'))
  // -b main 统一默认分支,避免 bare HEAD 指向不存在的 master 导致 clone/push refspec 失败
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
  const work = await mkdtemp(join(tmpdir(), 'work-'))
  const wg = simpleGit(work)
  await wg.raw(['init', '-b', 'main'])
  await wg.addConfig('user.email', 't@t.t'); await wg.addConfig('user.name', 't')
  await writeFile(join(work, 'a.txt'), 'x'); await wg.add('.'); await wg.commit('init')
  await wg.addRemote('origin', bare); await wg.push('origin', 'HEAD:main')
  await wg.addTag('v1.0.0'); await wg.pushTags('origin') // 打 tag,覆盖 lsRemote 的 tags 解析分支
  return bare
}

describe('NodeGit', () => {
  let bare: string
  const created: string[] = []
  beforeAll(async () => { bare = await makeBareWithCommit() })
  afterAll(async () => { await Promise.all(created.map(p => rm(p, { recursive: true, force: true }))) })

  it('init creates a git repo at path', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'init-')); created.push(dest)
    await new NodeGit().init(dest)
    expect(await simpleGit(dest).checkIsRepo()).toBe(true)
  })
  it('clone fetches the repo', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'clone-')); created.push(dest)
    await new NodeGit().clone(bare, dest, true)
    const log = await simpleGit(dest).log()
    expect(log.total).toBe(1)
  })
  it('lsRemote returns tags and head', async () => {
    const r = await new NodeGit().lsRemote(bare)
    expect(r.head).toBeTruthy()
    expect(r.tags['v1.0.0']).toBeTruthy() // tags 解析分支有覆盖
  })
  it('push reports nonFastForward when remote ahead', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'push-')); created.push(dest)
    const git = new NodeGit()
    await git.clone(bare, dest, false)
    // 远程追加提交:另起 work 推新 commit,使本地 dest 落后
    const work2 = await mkdtemp(join(tmpdir(), 'w2-')); created.push(work2)
    const w2 = simpleGit(work2); await w2.clone(bare, '.')
    await w2.addConfig('user.email', 't@t.t'); await w2.addConfig('user.name', 't')
    await writeFile(join(work2, 'b.txt'), 'y'); await w2.add('.'); await w2.commit('c2'); await w2.push('origin', 'main:main')
    // 本地 dest 旧提交 push -> non-fast-forward
    const res = await git.push(dest)
    expect(res.ok).toBe(false)
    expect(res.nonFastForward).toBe(true)
  })
  it('push succeeds when local ahead, returns ok:true', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'pushok-')); created.push(dest)
    const git = new NodeGit()
    await git.clone(bare, dest, false)
    const wg = simpleGit(dest)
    await wg.addConfig('user.email', 't@t.t'); await wg.addConfig('user.name', 't')
    await writeFile(join(dest, 'c.txt'), 'z'); await wg.add('.'); await wg.commit('c3')
    const res = await git.push(dest) // 本地领先 -> fast-forward 成功
    expect(res.ok).toBe(true); expect(res.nonFastForward).not.toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/platform/node/git.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/platform/node/git.ts
import { simpleGit, type SimpleGit } from 'simple-git'
import type { IGit } from '../interfaces.js'

export class NodeGit implements IGit {
  private git(path?: string): SimpleGit { return simpleGit(path) } // path 可选:lsRemote/clone 零参用 cwd

  async init(repoPath: string): Promise<void> { await this.git(repoPath).raw(['init', '-b', 'main']) }
  async fetch(repoPath: string): Promise<void> { await this.git(repoPath).fetch(['--tags']) }
  async mergeBase(repoPath: string, a: string, b: string): Promise<string> {
    const r = await this.git(repoPath).raw(['merge-base', a, b])
    return r.trim()
  }
  async lsRemote(url: string): Promise<{ tags: Record<string, string>; head: string }> {
    // 不加 --heads/--tags 过滤:git ls-remote 默认输出 HEAD 行,过滤会丢 HEAD
    const out = await this.git().listRemote([url])
    const tags: Record<string, string> = {}; let head = ''
    for (const line of out.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(/\s+/)
      if (ref === 'HEAD') head = sha
      else if (ref?.startsWith('refs/tags/')) tags[ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')] = sha
    }
    return { tags, head }
  }
  async clone(url: string, dest: string, shallow = false): Promise<void> {
    const args = shallow ? ['--depth', '1'] : []
    await this.git().clone(url, dest, args.length ? args : undefined)
  }
  async checkout(repoPath: string, ref: string): Promise<void> { await this.git(repoPath).checkout(ref) }
  async add(repoPath: string, paths: string[]): Promise<void> { await this.git(repoPath).add(paths) }
  async commit(repoPath: string, msg: string): Promise<void> { await this.git(repoPath).commit(msg) }
  async push(repoPath: string): Promise<{ ok: boolean; nonFastForward?: boolean }> {
    // 显式 refspec:新克隆仓无 upstream,无参 push 会失败;推 HEAD 到 origin
    try { await this.git(repoPath).push('origin', 'HEAD'); return { ok: true } }
    catch (e: any) {
      const msg = String(e?.message ?? e)
      const nonFastForward = /non-fast-forward|rejected|fetch first/i.test(msg)
      return { ok: false, nonFastForward }
    }
  }
  async status(repoPath: string): Promise<{ dirty: boolean }> {
    const s = await this.git(repoPath).status()
    return { dirty: !s.isClean() }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/platform/node/git.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/platform/node/git.ts tests/platform/node/git.test.ts
git commit -m "feat(platform): Node git impl (fetch/mergeBase/lsRemote/clone/checkout/push with non-ff)"
```

---

## Task 6: 结构化三向 merge

**Files:**
- Create: `src/core/merge.ts`
- Test: `tests/core/merge.test.ts`

**Interfaces:**
- Consumes: YAML 解析(js-yaml);文件类型决定 merge key
- Produces: `threeWayMerge(base, ours, theirs, kind): { merged: string; conflicts: Conflict[] }`、`export type Kind` ∈ 'skills' | 'mcp' | 'vars' | 'config';config/vars 嵌套对象递归深合并(spec 行 264)。被 sync(Plan 3) 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/merge.test.ts
import { describe, it, expect } from 'vitest'
import { threeWayMerge } from '../../src/core/merge'

describe('threeWayMerge', () => {
  it('both add different mcp servers -> auto merge both', () => {
    const base = '[]'
    const ours = '- id: a\n  type: stdio\n  command: c\n  targets: [claude-code]\n'
    const theirs = '- id: b\n  type: stdio\n  command: c\n  targets: [claude-code]\n'
    const r = threeWayMerge(base, ours, theirs, 'mcp')
    expect(r.merged).toContain('id: a'); expect(r.merged).toContain('id: b')
    expect(r.conflicts).toHaveLength(0)
  })
  it('both change same mcp id same field -> conflict', () => {
    const base = '- id: a\n  type: stdio\n  command: old\n  targets: [claude-code]\n'
    const ours = '- id: a\n  type: stdio\n  command: ours\n  targets: [claude-code]\n'
    const theirs = '- id: a\n  type: stdio\n  command: theirs\n  targets: [claude-code]\n'
    const r = threeWayMerge(base, ours, theirs, 'mcp')
    expect(r.conflicts.length).toBeGreaterThan(0)
    expect(r.conflicts[0].path).toContain('a')
    expect(r.conflicts[0].field).toBe('command')
  })
  it('vars top-level key merge', () => {
    const base = 'a: 1\n'
    const ours = 'a: 1\nb: 2\n'
    const theirs = 'a: 1\nc: 3\n'
    const r = threeWayMerge(base, ours, theirs, 'vars')
    expect(r.merged).toContain('b: 2'); expect(r.merged).toContain('c: 3')
    expect(r.conflicts).toHaveLength(0)
  })
  it('skills sources merge by url', () => {
    const base = 'sources: []\nskills: []\n'
    const ours = 'sources:\n  - url: github:x/y\n    ref: v1\nskills: []\n'
    const theirs = 'sources:\n  - url: github:z/w\n    ref: v1\nskills: []\n'
    const r = threeWayMerge(base, ours, theirs, 'skills')
    expect(r.merged).toContain('github:x/y'); expect(r.merged).toContain('github:z/w')
  })
  it('config: both add different top-level fields -> auto merge', () => {
    const r = threeWayMerge('profile: local\n', 'profile: local\ntargets: [claude-code]\n', 'profile: local\nupdate_check:\n  enabled: true\n', 'config')
    expect(r.merged).toContain('targets'); expect(r.merged).toContain('update_check')
    expect(r.conflicts).toHaveLength(0)
  })
  it('config: both change same top-level field -> conflict', () => {
    const r = threeWayMerge('targets: [claude-code]\n', 'targets: [codex]\n', 'targets: [opencode]\n', 'config')
    expect(r.conflicts.length).toBeGreaterThan(0)
    expect(r.conflicts[0].path).toBe('targets')
  })
  it('config: nested object deep merge, sibling subfield no conflict', () => {
    const base = 'proxy:\n  http: r\n  https: r\n'
    const r = threeWayMerge(base, 'proxy:\n  http: L\n  https: r\n', 'proxy:\n  http: r\n  https: L2\n', 'config')
    expect(r.merged).toContain('http: L'); expect(r.merged).toContain('https: L2')
    expect(r.conflicts).toHaveLength(0)
  })
  it('mcp: both delete same id -> not in merged', () => {
    const r = threeWayMerge('- id: x\n  type: stdio\n  command: c\n  targets: [claude-code]\n', '[]', '[]', 'mcp')
    expect(r.merged).not.toContain('id: x')
  })
  it('skills: same url both change ref differently -> conflict on ref', () => {
    const base = 'sources:\n  - url: github:x/y\n    ref: v1\nskills: []\n'
    const ours = 'sources:\n  - url: github:x/y\n    ref: v2\nskills: []\n'
    const theirs = 'sources:\n  - url: github:x/y\n    ref: v3\nskills: []\n'
    const r = threeWayMerge(base, ours, theirs, 'skills')
    expect(r.conflicts.some(c => c.path.includes('github:x/y') && c.field === 'ref')).toBe(true)
  })
  it('vars: one side delete, other side modify -> modify wins (delete-vs-modify 契约)', () => {
    const base = 'a: 1\nb: 2\n'
    const ours = 'a: 1\n' // 删 b
    const theirs = 'a: 1\nb: 22\n' // 改 b
    const r = threeWayMerge(base, ours, theirs, 'vars')
    expect(r.merged).toContain('b: 22') // 改方胜出(Loom 结构化合并取改方,不标记冲突)
    expect(r.conflicts).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/core/merge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/core/merge.ts
import yaml from 'js-yaml'

export interface Conflict { file: string; path: string; field: string; base: unknown; ours: unknown; theirs: unknown }
export interface MergeResult { merged: string; conflicts: Conflict[] }

export type Kind = 'skills' | 'mcp' | 'vars' | 'config'

function parse(text: string): unknown { return yaml.load(text) ?? (text.trim() === '' ? null : text) }

function asArray<T>(v: unknown): T[] { return Array.isArray(v) ? v as T[] : [] }
function asObj(v: unknown): Record<string, unknown> { return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {} }
function isPlain(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function mergeList<T extends Record<string, unknown>>(base: T[], ours: T[], theirs: T[], key: string, file: string, conflicts: Conflict[]): T[] {
  const byKey = (arr: T[]) => new Map(arr.map(i => [String(i[key]), i] as const))
  const bk = byKey(base), ok = byKey(ours), tk = byKey(theirs)
  const allKeys = new Set([...ok.keys(), ...tk.keys()])
  const out: T[] = []
  for (const k of allKeys) {
    const o = ok.get(k), t = tk.get(k), b = bk.get(k)
    if (o && !t) { out.push(o); continue }
    if (!o && t) { out.push(t); continue }
    if (o && t) {
      // 同 key 两边都改:逐字段比较
      const merged = { ...o }
      for (const f of new Set([...Object.keys(o ?? {}), ...Object.keys(t ?? {})])) {
        const ov = (o as any)[f], tv = (t as any)[f], bv = (b as any)?.[f]
        if (ov === tv) { (merged as any)[f] = ov }
        else if (bv !== undefined && ov === bv) { (merged as any)[f] = tv } // ours 未改 -> 取 theirs
        else if (bv !== undefined && tv === bv) { (merged as any)[f] = ov } // theirs 未改 -> 取 ours
        else { conflicts.push({ file, path: k, field: f, base: bv, ours: ov, theirs: tv }); (merged as any)[f] = ov } // 都改且不同 -> 冲突
      }
      out.push(merged)
    }
  }
  return out
}

// 嵌套对象递归三向深合并:子字段冲突标记到 conflicts(vars/config 共用)
function mergeObj(base: Record<string, unknown>, ours: Record<string, unknown>, theirs: Record<string, unknown>, file: string, pathPrefix: string, conflicts: Conflict[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const o = ours[k], t = theirs[k], b = base[k]
    const path = pathPrefix ? `${pathPrefix}.${k}` : k
    if (o === t || (b !== undefined && o === b)) out[k] = t === undefined ? o : t
    else if (b !== undefined && t === b) out[k] = o
    else if (isPlain(o) && isPlain(t) && isPlain(b)) out[k] = mergeObj(b, o, t, file, path, conflicts) // 嵌套对象递归
    else if (o !== undefined && t !== undefined) { conflicts.push({ file, path, field: '', base: b, ours: o, theirs: t }); out[k] = o }
    else out[k] = o ?? t
  }
  return out
}

export function threeWayMerge(baseText: string, oursText: string, theirsText: string, kind: Kind): MergeResult {
  const base = parse(baseText), ours = parse(oursText), theirs = parse(theirsText)
  const conflicts: Conflict[] = []
  let merged: unknown
  if (kind === 'mcp') {
    merged = mergeList<any>(asArray(base), asArray(ours), asArray(theirs), 'id', 'mcp.yaml', conflicts)
  } else if (kind === 'vars') {
    merged = mergeObj(asObj(base), asObj(ours), asObj(theirs), 'vars', '', conflicts)
  } else if (kind === 'skills') {
    const bo = asObj(base), oo = asObj(ours), to = asObj(theirs)
    const sources = mergeList<any>(asArray(bo.sources), asArray(oo.sources), asArray(to.sources), 'url', 'skills.yaml', conflicts)
    const skills = mergeList<any>(asArray(bo.skills), asArray(oo.skills), asArray(to.skills), 'id', 'skills.yaml', conflicts)
    merged = { sources, skills }
  } else { // config:顶层字段 + 嵌套对象递归深合并(冲突标记)
    merged = mergeObj(asObj(base), asObj(ours), asObj(theirs), 'config.yaml', '', conflicts)
  }
  return { merged: yaml.dump(merged, { lineWidth: -1 }), conflicts }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/core/merge.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/merge.ts tests/core/merge.test.ts
git commit -m "feat(core): structured 3-way merge per file kind (skills/mcp/vars/config)"
```

---

## Task 7: Version compare + Projection IR

**Files:**
- Create: `src/core/version.ts`, `src/core/projection.ts`
- Test: `tests/core/version.test.ts`, `tests/core/projection.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `SkillSource`, `AgentId` from `types.ts`; `IGit` (Task 4 interfaces,不在此实现)
- Produces: `compareVersion(local, remote)` -> `VersionStatus`(tag 移动也判更新);`planProjection(manifest, effectiveConfig, installedAgents)` -> `ProjectionPlan`(IR,不执行 IO;effectiveConfig=mergeConfig 结果;source member 仅处理显式 override,完整列表留 Plan 2 scan)。被 Plan 2(投影执行)/Plan 3(更新检测) 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/version.test.ts
import { describe, it, expect } from 'vitest'
import { compareVersion } from '../../src/core/version'

describe('compareVersion', () => {
  it('hasUpdate when remote has newer tag', () => {
    const r = compareVersion({ ref: 'v5.1.4', pinned_commit: 'aaa' }, { tags: { 'v5.1.4': 'aaa', 'v5.1.5': 'bbb' }, head: 'bbb' })
    expect(r.hasUpdate).toBe(true); expect(r.latestTag).toBe('v5.1.5'); expect(r.latestCommit).toBe('bbb')
  })
  it('no update when pinned commit matches latest tag commit', () => {
    const r = compareVersion({ ref: 'v5.1.4', pinned_commit: 'aaa' }, { tags: { 'v5.1.4': 'aaa' }, head: 'aaa' })
    expect(r.hasUpdate).toBe(false); expect(r.latestTag).toBe('v5.1.4'); expect(r.latestCommit).toBe('aaa')
  })
  it('tag moved to new commit (mutable tag) => hasUpdate', () => {
    // spec 行 292:tag mutable,同名 tag 被移到新 commit 应判更新
    const r = compareVersion({ ref: 'v5.1.4', pinned_commit: 'aaa' }, { tags: { 'v5.1.4': 'bbb' }, head: 'bbb' })
    expect(r.hasUpdate).toBe(true)
  })
  it('no-tag repo: head mismatch => update', () => {
    const r = compareVersion({ ref: 'main', pinned_commit: 'aaa' }, { tags: {}, head: 'bbb' })
    expect(r.hasUpdate).toBe(true); expect(r.latestCommit).toBe('bbb')
  })
  it('no-tag repo: head matches pinned => no update', () => {
    const r = compareVersion({ ref: 'main', pinned_commit: 'aaa' }, { tags: {}, head: 'aaa' })
    expect(r.hasUpdate).toBe(false)
  })
})
```

```typescript
// tests/core/projection.test.ts
import { describe, it, expect } from 'vitest'
import { planProjection } from '../../src/core/projection'
import type { Manifest } from '../../src/core/types'

const manifest: Manifest = {
  skills: {
    sources: [{ url: 'github:obra/superpowers', ref: 'v5.1.4', pinned_commit: 'aaa', members: [{ name: 'brainstorming' }, { name: 'tdd', enabled: false }, { name: 'writing', targets: ['codex'] }] }],
    skills: [{ id: 'frontend-design' }],
  },
  mcp: [
    { id: 'playwright', type: 'stdio', command: 'npx', args: ['p'], targets: ['claude-code', 'codex'] },
    { id: 'zhipu', type: 'sse', url: 'https://x' }, // 无 targets,回退全局
  ],
  vars: { default: {}, active: {} },
  config: { targets: ['claude-code', 'codex', 'opencode'], projection: { strategy: 'link' } },
  errors: [],
}

describe('planProjection', () => {
  it('local skill projected to all global targets', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const fd = p.links.find(l => l.skillId === 'frontend-design')!
    expect(fd.targets).toEqual(['claude-code', 'codex', 'opencode'])
  })
  it('source member (显式 members override) gets namespace prefix', () => {
    // planProjection 只处理 manifest 显式列出的 members override;完整 member 列表由 Plan 2 scan 后注入
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    expect(p.links.some(l => l.skillId === 'superpowers-brainstorming')).toBe(true)
  })
  it('enabled:false member -> empty targets (不建软链,spec 行 236)', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const tdd = p.links.find(l => l.skillId === 'superpowers-tdd')!
    expect(tdd.targets).toEqual([])
  })
  it('member override targets 生效(不走全局)', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const writing = p.links.find(l => l.skillId === 'superpowers-writing')!
    expect(writing.targets).toEqual(['codex'])
  })
  it('mcp server projected to its own targets, not global', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex']))
    const m = p.mcpEntries.find(m => m.id === 'playwright')!
    expect(m.targets).toEqual(['claude-code', 'codex'])
  })
  it('mcp server without targets falls back to global', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code', 'codex', 'opencode']))
    const z = p.mcpEntries.find(m => m.id === 'zhipu')!
    expect(z.targets).toEqual(['claude-code', 'codex', 'opencode'])
  })
  it('uninstalled agent skipped, marked in skipped', () => {
    const p = planProjection(manifest, manifest.config, new Set(['claude-code'])) // codex/opencode 未装
    expect(p.skippedAgents).toContain('codex')
    const fd = p.links.find(l => l.skillId === 'frontend-design')!
    expect(fd.targets).toEqual(['claude-code']) // local skill 也不含未装 agent
  })
  it('strategy: copy 透传;无 projection 默认 link', () => {
    const pCopy = planProjection(manifest, { targets: ['claude-code'], projection: { strategy: 'copy' } }, new Set(['claude-code']))
    expect(pCopy.strategy).toBe('copy')
    const pDefault = planProjection(manifest, { targets: ['claude-code'] }, new Set(['claude-code']))
    expect(pDefault.strategy).toBe('link')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/core/version.test.ts tests/core/projection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/core/version.ts
import type { SkillSource } from './types.js'

// RemoteRef 对应 IGit.lsRemote 的返回结构(见 platform/interfaces.ts)
export interface RemoteRef { tags: Record<string, string>; head: string }
export interface VersionStatus { hasUpdate: boolean; latestTag?: string; latestCommit: string }

export function compareVersion(local: Pick<SkillSource, 'ref' | 'pinned_commit'>, remote: RemoteRef): VersionStatus {
  const tagKeys = Object.keys(remote.tags)
  if (tagKeys.length === 0) {
    // 无 tag 仓库:比对本地 pinned_commit 与远程 HEAD
    return { hasUpdate: remote.head !== local.pinned_commit, latestCommit: remote.head }
  }
  // 有 tag:pinned_commit 与最新 tag 的 commit 不一致即判更新(spec 行 292:tag mutable,只看 commit)
  const pinnedCommit = local.pinned_commit
  const latestTag = tagKeys.sort(semverCompare).at(-1)!
  const latestCommit = remote.tags[latestTag]
  const hasUpdate = latestCommit !== pinnedCommit
  return { hasUpdate, latestTag, latestCommit }
}

function semverCompare(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d }
  return 0
}
```

```typescript
// src/core/projection.ts
import type { Manifest, AgentId, Config, SkillSource } from './types.js'

export interface LinkPlan { skillId: string; source: 'local' | { repoId: string; memberName: string }; targets: AgentId[] }
export interface McpPlanEntry { id: string; targets: AgentId[] }
export interface ProjectionPlan { links: LinkPlan[]; mcpEntries: McpPlanEntry[]; skippedAgents: AgentId[]; strategy: 'link' | 'copy' }

// effectiveConfig 由 caller 用 mergeConfig(repoConfig, localConfig) 算出后传入(Task 2)
// source member:本函数仅处理 manifest 显式列出的 members override;「未列出的 member 仍全启用」(spec 行 158)
//   需 scan 得完整 member 列表,由 Plan 2 scan 后注入,本 IR 阶段不产出未列出 member 的 link
export function planProjection(manifest: Manifest, effectiveConfig: Config, installedAgents: Set<AgentId>): ProjectionPlan {
  const globalTargets = effectiveConfig.targets ?? []
  const skippedAgents: AgentId[] = []
  const activeTargets = (ts: AgentId[]): AgentId[] => {
    const out: AgentId[] = []
    for (const a of ts) { if (installedAgents.has(a)) out.push(a); else skippedAgents.push(a) }
    return out
  }

  const links: LinkPlan[] = []
  // local skill:id 即 skillId,落点不带前缀
  for (const s of manifest.skills.skills) {
    links.push({ skillId: s.id, source: 'local', targets: activeTargets(globalTargets) })
  }
  // source member:只处理显式 members override;enabled:false -> targets=[](执行层不建链,spec 行 236)
  for (const src of manifest.skills.sources) {
    const repoId = deriveRepoId(src)
    const members = src.members?.length ? src.members : []
    for (const m of members) {
      const ts = activeTargets(m.enabled === false ? [] : (m.targets ?? globalTargets))
      links.push({ skillId: `${repoId}-${m.name}`, source: { repoId, memberName: m.name }, targets: ts })
    }
  }

  const mcpEntries: McpPlanEntry[] = manifest.mcp.map(m => ({
    id: m.id, targets: activeTargets(m.targets ?? globalTargets),
  }))

  return { links, mcpEntries, skippedAgents: [...new Set(skippedAgents)], strategy: effectiveConfig.projection?.strategy ?? 'link' }
}

function deriveRepoId(src: SkillSource): string {
  // github:obra/superpowers -> superpowers
  const parts = src.url.split(':')
  const path = parts[parts.length - 1]
  return path.split('/').pop()!.replace(/\.git$/, '')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/core/version.test.ts tests/core/projection.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/version.ts src/core/projection.ts tests/core/version.test.ts tests/core/projection.test.ts
git commit -m "feat(core): version compare + projection IR (namespace prefix, target resolution, skip uninstalled)"
```

---

## Task 8: 首次初始化

**Files:**
- Create: `src/platform/node/init.ts`, `src/platform/node/index.ts`
- Test: `tests/platform/node/init.test.ts`

**Interfaces:**
- Consumes: `IFileSystem` (Task 4)、`IGit` (Task 4)
- Produces: `initLoom(homePath, fs, git)` — 创建 ~/.loom 骨架(config.yaml 本地级 + repos/default/(git repo + .gitignore) + 空 skills.yaml/mcp.yaml + vars/default.yaml + 仓库级 config.yaml)。被 CLI/API 启动(Plan 4) 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/platform/node/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeFileSystem } from '../../../src/platform/node/fs'
import { NodeGit } from '../../../src/platform/node/git'
import { initLoom } from '../../../src/platform/node/init'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'home-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('initLoom', () => {
  it('creates ~/.loom skeleton with default repo (git repo + .gitignore)', async () => {
    const fs = new NodeFileSystem(), git = new NodeGit()
    await initLoom(home, fs, git)
    expect(await fs.exists(join(home, '.loom', 'config.yaml'))).toBe(true)
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'skills.yaml'))).toBe(true)
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'mcp.yaml'))).toBe(true)
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', 'vars', 'default.yaml'))).toBe(true)
    expect(await fs.exists(join(home, '.loom', 'repos', 'default', '.gitignore'))).toBe(true)
    expect(await simpleGit(join(home, '.loom', 'repos', 'default')).checkIsRepo()).toBe(true) // spec 行 312:空 git repo
  })
  it('local config.yaml defaults active_repo=default', async () => {
    const fs = new NodeFileSystem(), git = new NodeGit()
    await initLoom(home, fs, git)
    expect(await fs.readFile(join(home, '.loom', 'config.yaml'))).toContain('active_repo: default')
  })
  it('repo config.yaml has profile:local + targets + projection (spec 行 108-115)', async () => {
    const fs = new NodeFileSystem(), git = new NodeGit()
    await initLoom(home, fs, git)
    const c = await fs.readFile(join(home, '.loom', 'repos', 'default', 'config.yaml'))
    expect(c).toContain('profile: local')
    expect(c).toContain('targets:')
    expect(c).toContain('projection:')
  })
  it('skills.yaml is valid empty (sources: [], skills: [])', async () => {
    const fs = new NodeFileSystem(), git = new NodeGit()
    await initLoom(home, fs, git)
    const s = await fs.readFile(join(home, '.loom', 'repos', 'default', 'skills.yaml'))
    expect(s).toContain('sources: []'); expect(s).toContain('skills: []')
  })
  it('idempotent: running twice does not overwrite existing config or skills', async () => {
    const fs = new NodeFileSystem(), git = new NodeGit()
    await initLoom(home, fs, git)
    await fs.writeFile(join(home, '.loom', 'config.yaml'), 'active_repo: custom\n')
    await fs.writeFile(join(home, '.loom', 'repos', 'default', 'skills.yaml'), 'sources: []\nskills: [{ id: mine }]\n')
    await initLoom(home, fs, git)
    expect(await fs.readFile(join(home, '.loom', 'config.yaml'))).toContain('custom')
    expect(await fs.readFile(join(home, '.loom', 'repos', 'default', 'skills.yaml'))).toContain('mine') // 不覆盖
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/platform/node/init.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/platform/node/init.ts
import type { IFileSystem, IGit } from '../interfaces.js'
import { join } from 'node:path'

const SKELETON = {
  configLocal: `active_repo: default\n`,
  gitignore: `remote-cache/\n`,
  skills: `sources: []\nskills: []\n`,
  mcp: `[]\n`,
  varsDefault: `# default profile vars (入 git 兜底,用户后填)\n# browsers_path: ~/.cache/ms-playwright\n# work_root: ~/projects\n`,
  repoConfig: `# 仓库级 config(随 git 同步)\nprofile: local\ntargets: [claude-code, codex]\nprojection:\n  strategy: link\nupdate_check:\n  enabled: true\n  interval: 6h\n`,
}

export async function initLoom(homePath: string, fs: IFileSystem, git: IGit): Promise<void> {
  const loom = join(homePath, '.loom')
  const repo = join(loom, 'repos', 'default')
  await fs.mkdir(loom, true) // 先建 .loom 根;writeFile 不自动建父目录,否则 ENOENT
  // 本地级 config
  const localConfig = join(loom, 'config.yaml')
  if (!(await fs.exists(localConfig))) await fs.writeFile(localConfig, SKELETON.configLocal)
  // default repo 骨架
  await fs.mkdir(join(repo, 'vars'), true)
  await fs.mkdir(join(repo, 'assets', 'skills'), true)
  await fs.mkdir(join(repo, 'remote-cache'), true)
  const ensure = async (p: string, content: string) => { if (!(await fs.exists(p))) await fs.writeFile(p, content) }
  await ensure(join(repo, '.gitignore'), SKELETON.gitignore)
  await ensure(join(repo, 'skills.yaml'), SKELETON.skills)
  await ensure(join(repo, 'mcp.yaml'), SKELETON.mcp)
  await ensure(join(repo, 'vars', 'default.yaml'), SKELETON.varsDefault)
  await ensure(join(repo, 'config.yaml'), SKELETON.repoConfig)
  // repos/default 为 git repo(spec 行 312);幂等:已 init 不重复
  if (!(await fs.exists(join(repo, '.git')))) await git.init(repo)
}
```

```typescript
// src/platform/node/index.ts
import { NodeFileSystem } from './fs.js'
import { NodeGit } from './git.js'
import { NodeProcess } from './proc.js'

export interface NodePlatform { fs: NodeFileSystem; git: NodeGit; proc: NodeProcess }
export function createNodePlatform(): NodePlatform {
  return { fs: new NodeFileSystem(), git: new NodeGit(), proc: new NodeProcess() }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/platform/node/init.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/platform/node/init.ts src/platform/node/index.ts tests/platform/node/init.test.ts
git commit -m "feat(core): first-run init skeleton + Node platform assembly"
```

---

## Self-Review

**1. Spec coverage** (Plan 1 覆盖范围):
- Core 层 Manifest 模型与校验(zod discriminatedUnion 处理 stdio/sse/http 互斥 + buildManifest→errors 接入主流程,spec 行 190)→ Task 2 ✓
- mcp targets 可缺(回退全局,spec 行 174)+ source.url/ref 必填(spec 行 138/155)→ Task 2 zod ✓
- Core Projection IR(含 enabled:false / member override / mcp 回退 / 未装 agent 跳过 / strategy 透传)→ Task 7 ✓ (执行在 Plan 2)
- Core Merge Logic(config/vars 嵌套递归深合并 + skills/mcp 列表按 key + 冲突 + delete-vs-modify 改方胜出契约)→ Task 6 ✓
- Core Version Compare(tag 移动也判更新 + latestCommit/latestTag 守护)→ Task 7 ✓
- Core Registry Index(scan 缓存)→ 部分在 Task 7(deriveRepoId),完整 scan 在 Plan 2(需 fs)
- Platform 层 IFileSystem/IGit/IProcess → Task 4/5 ✓
- 变量系统(优先级、默认值、混合值未定义整值失败、env 空串)→ Task 3 ✓
- config 两级合并(深合并、数组替换、删行回退、null 覆盖)→ Task 2 ✓
- 首次初始化(~/.loom 骨架 + repos/default 空 git repo + 仓库级 config + vars 占位)→ Task 8 ✓
- Windows junction 约束 + removeLink 不递归 + 跨卷降级提示 + 既有链接先解链再重建(spec 行 235)→ Task 4 ✓
- 首次运行不崩、空 repo 引导 → Task 8(idempotent + 空骨架)

**2. Placeholder scan**: 无 TBD/TODO/占位。Task 4 `fs_createLink` 占位/`afterEach?: undefined` 非法语法/writeFile 双写/resolveAbs require 已删修;Task 7 source member 测试直接给 members;Task 8 路径全统一到 platform/node(注释/命令/git add 一致);merge mcp 分支补 `<any>`(tsc 通过);ProxyConfig 字段改可选(tsc 通过 + 贴合 spec 部分覆盖)。实现代码完整可跑。

**3. Type consistency**: `Manifest`/`Config`/`SkillSource` 跨 task 一致(snake_case: `active_repo`/`update_check`/`no_proxy`/`pinned_commit`);`Manifest.errors: string[]` 新增(buildManifest 填充,Plan 2 执行层消费);`ProxyConfig` 字段可选;`planProjection` 返回 `ProjectionPlan` 被 Plan 2 消费(effectiveConfig=mergeConfig 结果);`threeWayMerge` 返回 `MergeResult` + `export Kind` 被 Plan 3 消费;`IFileSystem.createLink` 返回 `{fallback:'copy'|null}`、`removeLink` 签名一致;`IGit.init` 已加;validateManifest 用 zod safeParse 返回错误字符串数组(带 path)。

**4. 三方包调研结论(优先引入优秀轮子)**: YAML 解析用 js-yaml(维持,确认最优)、Git 封装用 simple-git(维持,确认最优,无更强替代)、manifest 校验引入 zod(discriminatedUnion 解决 type 互斥,Plan 2-4 复用);三向 merge/变量插值/semver/深合并/fs/链接/which 均自写(语义特殊或库不简化/removeLink 硬约束与 fs-extra.remove 冲突)。Core 层零平台依赖(zod 纯 JS 无平台依赖)。

**未覆盖(留给后续 plan)**: adapter 投影执行(Plan 2)、source member 完整列表(scan 后「未列出 member 仍全启用」语义,Plan 2)、git 同步流程编排(Plan 3)、远程 skill scan/clone(Plan 3)、API+WebUI(Plan 4)。
