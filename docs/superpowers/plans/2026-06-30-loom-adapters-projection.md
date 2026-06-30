# Loom Adapters + Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 3 个 agent adapter(Claude Code/Codex/OpenCode)的配置生成与投影执行:消费 Plan 1 的 ProjectionPlan,scan source member(含未列出 member 全启用),建软链/copy 到各 agent 落点,写 MCP 配置(按 id 合并、type 整块替换),事务化(任一失败逆序回滚,不留半成品)。

**Architecture:** Adapter 层每 agent 一个 adapter,实现 IAgentAdapter(skills 落点 + MCP 读写合并);投影执行器消费 ProjectionPlan,串行落点 + journal 记录 + catch 逆序回滚。Core 层(Plan 1)产 IR + resolveVars,本 plan 执行 IO。TDD,vitest。

**Tech Stack:** Node.js, TypeScript (strict), vitest, smol-toml(Codex TOML), tinyglobby(scan), xdg-basedir(OpenCode 路径), Plan 1 的 IFileSystem/IGit/planProjection/resolveVars

## Global Constraints

- 继承 Plan 1 Global Constraints(snake_case 字段、ESM 实现 import 带 .js / 测试不带、pnpm vitest run、Core 零平台依赖、日志 catch 带完整对象与堆栈不静默)
- Adapter/执行层属 Platform 层,可用三方包:smol-toml(Codex config.toml)、tinyglobby(scan SKILL.md)、xdg-basedir(OpenCode 路径);JSON 读写用原生 JSON.parse/stringify(Claude .claude.json / OpenCode opencode.json)
- 投影事务:journal 数组 + catch 逆序回滚(自写,无合适库);remote-cache clone 不进 journal(保留可重建);回滚本身 best-effort,单步失败记日志继续
- IFileSystem.copyDir(Task 0 扩展 Plan 1 接口:NodeFileSystem.copyDir 改 public 并入):strategy:'copy' 时主动 copy;事务两阶段保持投影前状态(spec 行 234):阶段 A 建 enabled 链(全成功后才进阶段 B),阶段 B 清 enabled:false/陈旧旧链——建链失败时旧链保持原状;copy 产物回滚因 IFileSystem 无 removeDir、覆盖旧链因无 readlink 不可逆,均抛错计入 rollbackFailures(spec 234 部分偏离)
- Codex config.toml 经 smol-toml parse/stringify 往返:非 mcp_servers 段保留,但 TOML 往返不保形(数组表/多层嵌套结构可能重排),MVP 接受
- removeLink 只删链接禁止递归(继承 Plan 1 IFileSystem 硬约束,禁用 fs-extra.remove)
- MCP 合并按 id(loom id 作 server name 对齐):有就替换、没有就插入、manifest 删了就移除;type 变更(stdio↔sse↔http)整块重写,清理旧 type 独有字段;agent 配置里 id 不在 manifest 的条目不碰(保护用户手写)
- 变量解析在投影时由 Core 层完成(Plan 1 resolveVars),写入 agent 配置前解析为明文,未定义变量标记该条目失败不写入
- agent 未安装跳过(Plan 1 planProjection 已标 skippedAgents);enabled:false member 不建链且清理已有软链
- 跨平台路径:Claude Code/Codex/Loom 用 os.homedir() 拼 .<agent>;OpenCode 用平台分支自写(Win %APPDATA%\opencode、Mac ~/Library/Application Support/opencode、Linux $XDG_CONFIG_HOME/opencode,不引 xdg-basedir);尊重 env 覆盖(CLAUDE_CONFIG_DIR/CODEX_HOME/OPENCODE_CONFIG_DIR)
- Codex skills 落点(~/.codex/skills/)需实测验证:调研发现 Codex 无原生 skills 概念(规则在 AGENTS.md/rules/),若 Codex 不读 skills 目录则该 adapter skills 投影无效,需映射到 AGENTS.md——本 plan 按 spec 路径实现并标注风险,实测后调整

---

## File Structure

- `src/adapters/paths.ts` — 各 agent 配置目录/文件定位(homedir + xdg-basedir + env 覆盖)
- `src/adapters/types.ts` — IAgentAdapter 接口、McpFragment、ProjectionJournal 类型
- `src/adapters/claude-code.ts` — Claude Code adapter(skills 链 + .claude.json MCP 合并)
- `src/adapters/codex.ts` — Codex adapter(skills 链 + config.toml MCP 合并,smol-toml)
- `src/adapters/opencode.ts` — OpenCode adapter(skills 链 + opencode.json MCP 合并)
- `src/projection/scan.ts` — skill scanner(tinyglobby **/SKILL.md)+ source member 完整列表(scan 后注入「未列出 member 全启用」)
- `src/projection/executor.ts` — 投影执行器(消费 ProjectionPlan + 事务 journal + 逆序回滚)
- `src/projection/mcp-merge.ts` — MCP 按 id 合并通用逻辑(读已有 → 合并 → 写回,type 整块替换)
- `tests/adapters/*.test.ts` / `tests/projection/*.test.ts` — 对应单测
- `package.json` 加 dependencies: smol-toml, tinyglobby(OpenCode 路径用平台分支自写,不引 xdg-basedir——其在 Windows 解析为 <home>/.config 而非 %APPDATA%,与真实 OpenCode 落点不符)

---

## Task 0: 安装依赖 + 扩展 IFileSystem.copyDir

**Files:** Modify `package.json`、`src/platform/interfaces.ts` (Plan 1)、`src/platform/node/fs.ts` (Plan 1)、`tests/platform/node/fs.test.ts` (Plan 1)

- [ ] **Step 1: 安装三方包**

Run: `pnpm add smol-toml tinyglobby`
Expected: package.json dependencies 出现 smol-toml、tinyglobby

- [ ] **Step 2: 扩展 Plan 1 IFileSystem 加 copyDir(strategy:copy 用)**

Plan 1 `NodeFileSystem.copyDir` 已有 `private` 实现(createLink 跨卷降级用,行 672),但未并入 `IFileSystem` 接口。本 plan executor 的 `strategy:'copy'` 分支需经接口调用,否则 tsc 报 `Property 'copyDir' does not exist on type 'IFileSystem'`。修改 Plan 1 两处 + 补测试:

`src/platform/interfaces.ts` 的 `IFileSystem` 接口加方法声明:
```typescript
copyDir(src: string, dest: string): Promise<void>
```

`src/platform/node/fs.ts` 的 `NodeFileSystem.copyDir` 从 `private` 改为 `public`(实现体不变)。

`tests/platform/node/fs.test.ts` 补一条用例:copyDir 递归复制嵌套目录(含子目录 + 文件),dest 与 src 内容一致。

- [ ] **Step 3: 提交**

```bash
git add package.json pnpm-lock.yaml src/platform/interfaces.ts src/platform/node/fs.ts tests/platform/node/fs.test.ts
git commit -m "chore: add smol-toml + tinyglobby deps; expose IFileSystem.copyDir for strategy:copy"
```

---

## Task 1: Agent 路径定位与 IAgentAdapter 接口

**Files:**
- Create: `src/adapters/paths.ts`, `src/adapters/types.ts`
- Test: `tests/adapters/paths.test.ts`

**Interfaces:**
- Consumes: `AgentId` from `src/core/types.js` (Plan 1)
- Produces: `agentConfigDir(agent): string`、`agentSkillsDir(agent): string`、`agentMcpFile(agent): string`、`IAgentAdapter` 接口(skillsLinkTargets / readMcp / writeMcp)、`McpFragment`、`ProjectionJournal`/`UndoAction`。被 Task 2-7 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/adapters/paths.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentConfigDir, agentSkillsDir, agentMcpFile } from '../../src/adapters/paths'

// stub HOME+USERPROFILE 为同一 tmp,避免本机 Git Bash(HOME 已设)与 os.homedir()(Windows 读 USERPROFILE)不一致
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'home-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

describe('agent paths', () => {
  it('claude-code: <home>/.claude, CLAUDE_CONFIG_DIR 覆盖', () => {
    expect(agentConfigDir('claude-code')).toBe(join(home, '.claude'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/custom/claude')
    expect(agentConfigDir('claude-code')).toBe('/custom/claude')
  })
  it('codex: <home>/.codex, CODEX_HOME 覆盖', () => {
    expect(agentConfigDir('codex')).toBe(join(home, '.codex'))
    vi.stubEnv('CODEX_HOME', '/custom/codex')
    expect(agentConfigDir('codex')).toBe('/custom/codex')
  })
  it('opencode: OPENCODE_CONFIG_DIR 覆盖(直接返回 env 值)', () => {
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/custom/opencode')
    expect(agentConfigDir('opencode')).toBe('/custom/opencode')
  })
  it('skills dir = configDir/skills', () => {
    expect(agentSkillsDir('claude-code')).toBe(join(home, '.claude', 'skills'))
    expect(agentSkillsDir('codex')).toBe(join(home, '.codex', 'skills'))
  })
  it('mcp file: claude ~/.claude.json, codex config.toml, opencode <configDir>/opencode.json', () => {
    expect(agentMcpFile('claude-code')).toBe(join(home, '.claude.json'))
    expect(agentMcpFile('codex')).toBe(join(home, '.codex', 'config.toml'))
    // OPENCODE_CONFIG_DIR=home(已 stub)→ agentConfigDir 返回 home → mcp file = home/opencode.json
    expect(agentMcpFile('opencode')).toBe(join(home, 'opencode.json'))
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/adapters/paths.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/adapters/paths.ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentId } from '../core/types.js'

// Claude Code/Codex/Loom 用 <home>/.<agent>;OpenCode 按平台分支(Win %APPDATA%、Mac Library/Application Support、Linux XDG)
export function agentConfigDir(agent: AgentId): string {
  switch (agent) {
    case 'claude-code': return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    case 'codex': return process.env.CODEX_HOME ?? join(homedir(), '.codex')
    case 'opencode': {
      // OPENCODE_CONFIG_DIR 存在时直接返回该值(与 CLAUDE_CONFIG_DIR/CODEX_HOME 语义对齐:env 即完整配置目录,不再拼 'opencode')
      if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
      const base = process.platform === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
      return join(base, 'opencode')
    }
  }
}

export function agentSkillsDir(agent: AgentId): string {
  return join(agentConfigDir(agent), 'skills')
}

export function agentMcpFile(agent: AgentId): string {
  // Claude Code MCP 写 ~/.claude.json(home 根,非 .claude/ 内);Codex 写 config.toml;OpenCode 写 opencode.json
  switch (agent) {
    case 'claude-code': return join(homedir(), '.claude.json')
    case 'codex': return join(agentConfigDir('codex'), 'config.toml')
    case 'opencode': return join(agentConfigDir('opencode'), 'opencode.json')
  }
}
```

```typescript
// src/adapters/types.ts
import type { AgentId, McpServer } from '../core/types.js'

// 投影到 agent 的 MCP 片段(变量已解析为明文,type 整块)
export interface McpFragment {
  id: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  targets?: AgentId[] // read 路径恒为占位(merge 不依赖);write 不含(loom 概念)
}

// 投影事务回滚动作(journal 记录,失败时逆序消费)
export type UndoAction =
  | { kind: 'unlink'; path: string }                            // 本次新建软链/junction -> removeLink;copy 产物(非链接)回滚抛错计入 rollbackFailures(IFileSystem 无 removeDir,spec 234 偏离)
  | { kind: 'restoreMcp'; path: string; backup: string | null } // MCP 写入前备份;backup=null(原文件不存在)回滚抛错计入 rollbackFailures(IFileSystem 无 removeFile,spec 234 偏离)

export interface ProjectionJournal { undos: UndoAction[] }

export interface ProjectionFailure {
  failedStep: string
  originalError: unknown
  rollbackReport: { undone: number; rollbackFailures: { path: string; err: unknown }[] }
}

// 每个 agent 一个 adapter:skills 落点由 executor 用 IFileSystem 建链;adapter 负责 MCP 读写合并
export interface IAgentAdapter {
  readonly agent: AgentId
  // 读已有 agent MCP 配置(解析为 id -> fragment 映射,无 id 字段时用 server name 作 id)
  readMcp(fs: import('../platform/interfaces.js').IFileSystem): Promise<Record<string, McpFragment>>
  // 合并后写回(整文件;调用方负责 backup)
  writeMcp(fs: import('../platform/interfaces.js').IFileSystem, merged: Record<string, McpFragment>): Promise<void>
}

// 共享:fragment → agent 配置项(不含 loom 的 id/targets;type 保留,各 type 独有字段按需写)。放此避免 codex/opencode 反向依赖 claude-code
export function toAgentEntry(f: McpFragment): Record<string, unknown> {
  const e: Record<string, unknown> = { type: f.type }
  if (f.command !== undefined) e.command = f.command
  if (f.args !== undefined) e.args = f.args
  if (f.env !== undefined) e.env = f.env
  if (f.url !== undefined) e.url = f.url
  if (f.headers !== undefined) e.headers = f.headers
  return e
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/adapters/paths.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/paths.ts src/adapters/types.ts tests/adapters/paths.test.ts
git commit -m "feat(adapters): agent path resolution + IAgentAdapter/MCP fragment/journal types"
```

---

## Task 2: Skill scanner + source member 完整投影

**Files:**
- Create: `src/projection/scan.ts`
- Test: `tests/projection/scan.test.ts`

**Interfaces:**
- Consumes: `IFileSystem`、`SkillSource`、`Manifest`、`planProjection`/`ProjectionPlan`/`LinkPlan` (Plan 1)
- Produces: `scanSourceMembers(fs, repoPath, src): Promise<ScannedMember[]>`(tinyglobly **/SKILL.md,排除 .git/node_modules/.cache)、`resolveFullLinks(manifest, scanResults, effectiveConfig, installedAgents): ProjectionPlan`(scan 后注入「未列出 member 全启用」,override 覆盖)。补全 Plan 1 planProjection 留的 source member 完整列表

- [ ] **Step 1: 写失败测试**

```typescript
// tests/projection/scan.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSourceMembers, resolveFullLinks } from '../../src/projection/scan'
import { NodeFileSystem } from '../../src/platform/node/fs'
import type { Manifest } from '../../src/core/types'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scan-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('scanSourceMembers', () => {
  it('finds SKILL.md, member name = parent dir, excludes .git/node_modules/.cache', async () => {
    await mkdir(join(root, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(join(root, 'skills', 'brainstorming', 'SKILL.md'), 'x')
    await mkdir(join(root, '.git', 'foo'), { recursive: true })
    await writeFile(join(root, '.git', 'foo', 'SKILL.md'), 'x') // 排除
    await mkdir(join(root, 'node_modules', 'bar'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'bar', 'SKILL.md'), 'x') // 排除
    const members = await scanSourceMembers(new NodeFileSystem(), root, { url: 'github:obra/superpowers', ref: 'v1' })
    expect(members.map(m => m.name)).toEqual(['brainstorming'])
    expect(members[0].path).toBe(join(root, 'skills', 'brainstorming'))
  })
})

describe('resolveFullLinks', () => {
  const mk = (sources: any[]): Manifest => ({
    skills: { sources, skills: [{ id: 'frontend-design' }] },
    mcp: [], vars: { default: {}, active: {} }, config: { targets: ['claude-code', 'codex'] }, errors: [],
  })
  it('source 无 members: scanned members 全启用走全局(spec 行 158)', () => {
    const manifest = mk([{ url: 'github:obra/superpowers', ref: 'v1' }])
    const scan = new Map([['github:obra/superpowers', [{ name: 'brainstorming', path: '/p' }, { name: 'tdd', path: '/p2' }]]])
    const p = resolveFullLinks(manifest, scan, manifest.config, new Set(['claude-code', 'codex']))
    expect(p.links.find(l => l.skillId === 'superpowers-brainstorming')!.targets).toEqual(['claude-code', 'codex'])
    expect(p.links.find(l => l.skillId === 'superpowers-tdd')!.targets).toEqual(['claude-code', 'codex'])
  })
  it('source 有 members override: override 生效,未列出 member 仍全启用', () => {
    const manifest = mk([{ url: 'github:obra/superpowers', ref: 'v1', members: [{ name: 'tdd', enabled: false }] }])
    const scan = new Map([['github:obra/superpowers', [{ name: 'brainstorming', path: '/p' }, { name: 'tdd', path: '/p2' }]]])
    const p = resolveFullLinks(manifest, scan, manifest.config, new Set(['claude-code', 'codex']))
    expect(p.links.find(l => l.skillId === 'superpowers-tdd')!.targets).toEqual([]) // override enabled:false
    expect(p.links.find(l => l.skillId === 'superpowers-brainstorming')!.targets).toEqual(['claude-code', 'codex']) // 未列出全启用
  })
  it('local skill 仍投影', () => {
    const manifest = mk([{ url: 'github:obra/superpowers', ref: 'v1' }])
    const scan = new Map()
    const p = resolveFullLinks(manifest, scan, manifest.config, new Set(['claude-code', 'codex']))
    expect(p.links.some(l => l.skillId === 'frontend-design')).toBe(true)
  })
  it('未装 agent 进 skippedAgents 且从 link targets 过滤(spec 237)', () => {
    const manifest = mk([{ url: 'github:obra/superpowers', ref: 'v1' }])
    const scan = new Map([['github:obra/superpowers', [{ name: 'brainstorming', path: '/p' }]]])
    // global targets 含 opencode 但仅装 claude-code
    const p = resolveFullLinks(manifest, scan, { targets: ['claude-code', 'opencode'] } as any, new Set(['claude-code']))
    expect(p.skippedAgents).toContain('opencode')
    expect(p.links.find(l => l.skillId === 'superpowers-brainstorming')!.targets).toEqual(['claude-code']) // opencode 过滤掉
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/projection/scan.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/projection/scan.ts
import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import type { IFileSystem } from '../platform/interfaces.js'
import type { SkillSource, AgentId, Manifest } from '../core/types.js'
import { planProjection, type ProjectionPlan, type LinkPlan } from '../core/projection.js'

const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']

export interface ScannedMember { name: string; path: string }

export async function scanSourceMembers(fs: IFileSystem, repoPath: string, src: SkillSource): Promise<ScannedMember[]> {
  const pattern = src.scan ?? '**/SKILL.md'
  // tinyglobby 直接读文件系统(scan 属 Platform 层,不经 IFileSystem 注入;IFileSystem 参数保留供未来抽象)
  void fs
  const matches = await glob(pattern, { cwd: repoPath, ignore: DEFAULT_IGNORE, onlyFiles: true })
  return matches.map(m => ({ name: basename(dirname(m)), path: join(repoPath, dirname(m)) }))
}

// scan 后构造完整 source member link 列表:未列出 member 全启用走全局,override 覆盖(spec 行 158)
export function resolveFullLinks(
  manifest: Manifest,
  scanResults: Map<string, ScannedMember[]>, // src.url -> scanned members
  effectiveConfig: Manifest['config'],
  installedAgents: Set<AgentId>,
): ProjectionPlan {
  const base = planProjection(manifest, effectiveConfig, installedAgents) // local skill + override member + mcp + skipped
  const globalTargets = effectiveConfig.targets ?? []
  const skipped: AgentId[] = []
  const activeTargets = (ts: AgentId[]): AgentId[] => {
    const out: AgentId[] = []
    for (const a of ts) { if (installedAgents.has(a)) out.push(a); else skipped.push(a) }
    return out
  }
  const links: LinkPlan[] = base.links.filter(l => l.source === 'local') // 保留 local skill;source member 由本函数重算
  for (const src of manifest.skills.sources) {
    const repoId = deriveRepoId(src.url)
    const scanned = scanResults.get(src.url) ?? []
    const overrideByName = new Map((src.members ?? []).map(m => [m.name, m]))
    for (const m of scanned) {
      const ov = overrideByName.get(m.name)
      const enabled = ov?.enabled ?? true
      const ts = activeTargets(enabled === false ? [] : (ov?.targets ?? globalTargets))
      links.push({ skillId: `${repoId}-${m.name}`, source: { repoId, memberName: m.name }, targets: ts })
    }
  }
  return {
    links,
    mcpEntries: base.mcpEntries,
    skippedAgents: [...new Set([...base.skippedAgents, ...skipped])],
    strategy: base.strategy,
  }
}

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  const path = parts[parts.length - 1]
  return path.split('/').pop()!.replace(/\.git$/, '')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/projection/scan.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/projection/scan.ts tests/projection/scan.test.ts
git commit -m "feat(projection): skill scanner + full source member links (unlisted members all-enabled)"
```

---

## Task 3: MCP 合并通用逻辑

**Files:**
- Create: `src/projection/mcp-merge.ts`
- Test: `tests/projection/mcp-merge.test.ts`

**Interfaces:**
- Consumes: `McpFragment` from `adapters/types.js` (Task 1)
- Produces: `mergeMcp(existing, manifestFragments): Record<string, McpFragment>`(按 id 替换/插入;type 变更整块重写;existing 中 manifest 无的 id 保留不碰,spec 行 244)。被各 adapter(Task 4-6)消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/projection/mcp-merge.test.ts
import { describe, it, expect } from 'vitest'
import { mergeMcp } from '../../src/projection/mcp-merge'
import type { McpFragment } from '../../src/adapters/types'

describe('mergeMcp', () => {
  it('insert new + replace existing by id', () => {
    const existing: Record<string, McpFragment> = { a: { id: 'a', type: 'stdio', command: 'old', targets: ['claude-code'] } }
    const manifest = [
      { id: 'a', type: 'stdio', command: 'new', targets: ['claude-code'] },
      { id: 'b', type: 'sse', url: 'https://b', targets: ['claude-code'] },
    ]
    const merged = mergeMcp(existing, manifest)
    expect(merged.a.command).toBe('new') // 替换
    expect(merged.b.url).toBe('https://b') // 插入
  })
  it('type 变更(stdio->sse)整块重写,清理旧 type 独有字段', () => {
    const existing: Record<string, McpFragment> = { a: { id: 'a', type: 'stdio', command: 'c', args: ['x'], targets: ['claude-code'] } }
    const manifest = [{ id: 'a', type: 'sse', url: 'https://a', targets: ['claude-code'] }]
    const merged = mergeMcp(existing, manifest)
    expect(merged.a.type).toBe('sse')
    expect(merged.a.url).toBe('https://a')
    expect(merged.a.command).toBeUndefined() // 旧 stdio 字段清理
    expect(merged.a.args).toBeUndefined()
  })
  it('existing 中 manifest 无的 id 保留不碰(保护用户手写,spec 行 244)', () => {
    const existing: Record<string, McpFragment> = { 'user handwritten': { id: 'user', type: 'stdio', command: 'u', targets: ['claude-code'] } }
    const merged = mergeMcp(existing, [{ id: 'a', type: 'stdio', command: 'c', targets: ['claude-code'] }])
    expect(merged['user handwritten']).toBeDefined() // 不删
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/projection/mcp-merge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/projection/mcp-merge.ts
import type { McpFragment } from '../adapters/types.js'

// 按 id 合并:manifest 有的替换/插入(整块重写,旧 type 字段不保留);existing 中 manifest 无的保留(保护用户手写)
// 注:spec 行 242「manifest 删了就移除」需持久化 loom 写过的 id 才能区分 loom 旧写 vs 用户手写,MVP 不主动删,留后续
export function mergeMcp(existing: Record<string, McpFragment>, manifestFragments: McpFragment[]): Record<string, McpFragment> {
  const merged: Record<string, McpFragment> = { ...existing }
  for (const f of manifestFragments) {
    merged[f.id] = f // 整块覆盖:type 变更自动清理旧字段(new fragment 只含新 type 字段)
  }
  return merged
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/projection/mcp-merge.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/projection/mcp-merge.ts tests/projection/mcp-merge.test.ts
git commit -m "feat(projection): MCP merge by id (replace/insert, type rewrite, preserve user entries)"
```

---

## Task 4: Claude Code adapter

**Files:**
- Create: `src/adapters/claude-code.ts`
- Test: `tests/adapters/claude-code.test.ts`

**Interfaces:**
- Consumes: `IAgentAdapter`、`McpFragment` (Task 1)、`agentMcpFile` (Task 1)、`IFileSystem` (Plan 1)
- Produces: `ClaudeCodeAdapter implements IAgentAdapter`(读写 ~/.claude.json 的 mcpServers 字段)+ 共享 `toAgentEntry(f): Record<string, unknown>`(fragment → agent 配置项,不含 loom 的 id/targets)。被 Task 5/6 复用 toAgentEntry,被 Task 7 executor 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/adapters/claude-code.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code'
import { NodeFileSystem } from '../../src/platform/node/fs'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'home-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

describe('ClaudeCodeAdapter', () => {
  it('readMcp parses mcpServers, id = server name, absent file => {}', async () => {
    const fs = new NodeFileSystem()
    expect(await new ClaudeCodeAdapter().readMcp(fs)).toEqual({})
    await fs.writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['p'] } } }))
    const m = await new ClaudeCodeAdapter().readMcp(fs)
    expect(m.playwright.id).toBe('playwright')
    expect(m.playwright.type).toBe('stdio')
    expect(m.playwright.command).toBe('npx')
  })
  it('writeMcp writes mcpServers, preserves other top-level keys', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(join(home, '.claude.json'), JSON.stringify({ otherKey: 'keep', mcpServers: { old: { type: 'stdio', command: 'o' } } }))
    await new ClaudeCodeAdapter().writeMcp(fs, {
      new: { id: 'new', type: 'sse', url: 'https://x', targets: ['claude-code'] },
    })
    const raw = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(raw.otherKey).toBe('keep')
    expect(raw.mcpServers.new.type).toBe('sse')
    expect(raw.mcpServers.new.url).toBe('https://x')
    expect(raw.mcpServers.old).toBeUndefined() // merged 全量写,old 不在 merged 则移除
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/adapters/claude-code.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/adapters/claude-code.ts
import { type IAgentAdapter, type McpFragment, toAgentEntry } from './types.js'
import type { IFileSystem } from '../platform/interfaces.js'
import { agentMcpFile } from './paths.js'
import type { AgentId } from '../core/types.js'

export class ClaudeCodeAdapter implements IAgentAdapter {
  readonly agent: AgentId = 'claude-code'

  async readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>> {
    const file = agentMcpFile('claude-code')
    if (!(await fs.exists(file))) return {}
    const raw = JSON.parse(await fs.readFile(file)) as { mcpServers?: Record<string, any> }
    const out: Record<string, McpFragment> = {}
    for (const [name, s] of Object.entries(raw.mcpServers ?? {})) {
      out[name] = { id: name, type: s.type ?? 'stdio', command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers, targets: [] }
    }
    return out
  }

  async writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> {
    const file = agentMcpFile('claude-code')
    let config: Record<string, unknown> = {}
    if (await fs.exists(file)) config = JSON.parse(await fs.readFile(file)) as Record<string, unknown>
    const mcpServers: Record<string, unknown> = {}
    for (const [name, f] of Object.entries(merged)) mcpServers[name] = toAgentEntry(f)
    config.mcpServers = mcpServers
    await fs.writeFile(file, JSON.stringify(config, null, 2))
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/adapters/claude-code.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/claude-code.ts tests/adapters/claude-code.test.ts
git commit -m "feat(adapters): Claude Code adapter (.claude.json mcpServers read/write + shared toAgentEntry)"
```

---

## Task 5: Codex adapter(smol-toml)

**Files:**
- Create: `src/adapters/codex.ts`
- Test: `tests/adapters/codex.test.ts`

**Interfaces:**
- Consumes: `IAgentAdapter`、`McpFragment` (Task 1)、`agentMcpFile`、`toAgentEntry` (Task 4)、`IFileSystem` (Plan 1)、smol-toml
- Produces: `CodexAdapter implements IAgentAdapter`(读写 ~/.codex/config.toml 的 [mcp_servers.*] 段,smol-toml parse/stringify)。被 Task 7 executor 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/adapters/codex.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter } from '../../src/adapters/codex'
import { NodeFileSystem } from '../../src/platform/node/fs'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'home-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

describe('CodexAdapter', () => {
  it('readMcp parses [mcp_servers.*], absent file => {}', async () => {
    const fs = new NodeFileSystem()
    expect(await new CodexAdapter().readMcp(fs)).toEqual({})
    await mkdir(join(home, '.codex'), { recursive: true })
    await fs.writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.playwright]\ntype = "stdio"\ncommand = "npx"\nargs = ["p"]\n')
    const m = await new CodexAdapter().readMcp(fs)
    expect(m.playwright.id).toBe('playwright')
    expect(m.playwright.command).toBe('npx')
    expect(m.playwright.args).toEqual(['p'])
  })
  it('writeMcp writes [mcp_servers.*], preserves other tables', async () => {
    const fs = new NodeFileSystem()
    await mkdir(join(home, '.codex'), { recursive: true })
    await fs.writeFile(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n[mcp_servers.old]\ntype = "stdio"\ncommand = "o"\n')
    await new CodexAdapter().writeMcp(fs, { new: { id: 'new', type: 'sse', url: 'https://x', targets: ['codex'] } })
    const raw = await fs.readFile(join(home, '.codex', 'config.toml'))
    expect(raw).toContain('model = "gpt-5"') // 保留其他顶层
    expect(raw).toContain('[mcp_servers.new]')
    expect(raw).toContain('url = "https://x"')
    expect(raw).not.toContain('mcp_servers.old') // merged 全量写
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/adapters/codex.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/adapters/codex.ts
import { parse, stringify } from 'smol-toml'
import { type IAgentAdapter, type McpFragment, toAgentEntry } from './types.js'
import type { IFileSystem } from '../platform/interfaces.js'
import { agentMcpFile } from './paths.js'
import type { AgentId } from '../core/types.js'

export class CodexAdapter implements IAgentAdapter {
  readonly agent: AgentId = 'codex'

  async readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>> {
    const file = agentMcpFile('codex')
    if (!(await fs.exists(file))) return {}
    const raw = parse(await fs.readFile(file)) as Record<string, any>
    const out: Record<string, McpFragment> = {}
    for (const [name, s] of Object.entries(raw.mcp_servers ?? {})) {
      out[name] = { id: name, type: s.type ?? 'stdio', command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers, targets: [] }
    }
    return out
  }

  async writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> {
    const file = agentMcpFile('codex')
    let config: Record<string, unknown> = {}
    if (await fs.exists(file)) config = parse(await fs.readFile(file)) as Record<string, unknown>
    const mcpServers: Record<string, unknown> = {}
    for (const [name, f] of Object.entries(merged)) mcpServers[name] = toAgentEntry(f)
    config.mcp_servers = mcpServers
    await fs.writeFile(file, stringify(config))
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/adapters/codex.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/codex.ts tests/adapters/codex.test.ts
git commit -m "feat(adapters): Codex adapter (config.toml mcp_servers via smol-toml)"
```

---

## Task 6: OpenCode adapter

**Files:**
- Create: `src/adapters/opencode.ts`
- Test: `tests/adapters/opencode.test.ts`

**Interfaces:**
- Consumes: `IAgentAdapter`、`McpFragment`、`agentMcpFile`、`toAgentEntry` (Task 4)、`IFileSystem`、xdg-basedir(Task 1 paths)
- Produces: `OpenCodeAdapter implements IAgentAdapter`(读写 opencode.json 的 mcp 字段)。被 Task 7 executor 消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/adapters/opencode.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeAdapter } from '../../src/adapters/opencode'
import { NodeFileSystem } from '../../src/platform/node/fs'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'home-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('OPENCODE_CONFIG_DIR', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

describe('OpenCodeAdapter', () => {
  it('readMcp parses mcp field, absent file => {}', async () => {
    const fs = new NodeFileSystem()
    expect(await new OpenCodeAdapter().readMcp(fs)).toEqual({})
    await fs.writeFile(join(home, 'opencode.json'), JSON.stringify({ mcp: { zhipu: { type: 'sse', url: 'https://x' } } }))
    const m = await new OpenCodeAdapter().readMcp(fs)
    expect(m.zhipu.id).toBe('zhipu')
    expect(m.zhipu.type).toBe('sse')
    expect(m.zhipu.url).toBe('https://x')
  })
  it('writeMcp writes mcp field, preserves other keys', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(join(home, 'opencode.json'), JSON.stringify({ theme: 'dark', mcp: { old: { type: 'stdio', command: 'o' } } }))
    await new OpenCodeAdapter().writeMcp(fs, { new: { id: 'new', type: 'stdio', command: 'npx', targets: ['opencode'] } })
    const raw = JSON.parse(await fs.readFile(join(home, 'opencode.json')))
    expect(raw.theme).toBe('dark')
    expect(raw.mcp.new.command).toBe('npx')
    expect(raw.mcp.old).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/adapters/opencode.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/adapters/opencode.ts
import { type IAgentAdapter, type McpFragment, toAgentEntry } from './types.js'
import type { IFileSystem } from '../platform/interfaces.js'
import { agentMcpFile } from './paths.js'
import type { AgentId } from '../core/types.js'

export class OpenCodeAdapter implements IAgentAdapter {
  readonly agent: AgentId = 'opencode'

  async readMcp(fs: IFileSystem): Promise<Record<string, McpFragment>> {
    const file = agentMcpFile('opencode')
    if (!(await fs.exists(file))) return {}
    const raw = JSON.parse(await fs.readFile(file)) as { mcp?: Record<string, any> }
    const out: Record<string, McpFragment> = {}
    for (const [name, s] of Object.entries(raw.mcp ?? {})) {
      out[name] = { id: name, type: s.type ?? 'stdio', command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers, targets: [] }
    }
    return out
  }

  async writeMcp(fs: IFileSystem, merged: Record<string, McpFragment>): Promise<void> {
    const file = agentMcpFile('opencode')
    let config: Record<string, unknown> = {}
    if (await fs.exists(file)) config = JSON.parse(await fs.readFile(file)) as Record<string, unknown>
    const mcp: Record<string, unknown> = {}
    for (const [name, f] of Object.entries(merged)) mcp[name] = toAgentEntry(f)
    config.mcp = mcp
    await fs.writeFile(file, JSON.stringify(config, null, 2))
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/adapters/opencode.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/opencode.ts tests/adapters/opencode.test.ts
git commit -m "feat(adapters): OpenCode adapter (opencode.json mcp field)"
```

---

## Task 7: 投影执行器(事务 journal + 逆序回滚)

**Files:**
- Create: `src/projection/executor.ts`
- Test: `tests/projection/executor.test.ts`

**Interfaces:**
- Consumes: `ProjectionPlan`(Plan 1)、`Manifest`、`McpServer`(Plan 1)、`resolveVars`/`VarsContext`(Plan 1)、`IAgentAdapter`(Task 1)、`agentMcpFile`/`agentSkillsDir`(Task 1)、`mergeMcp`(Task 3)、`IFileSystem`(Plan 1)
- Produces: `executeProjection(plan, manifest, varsCtx, deps): Promise<{ok:true}|{ok:false,failure}>` — 串行建 skill 链 + 写 MCP 配置(变量解析→合并→backup→write),任一失败逆序回滚 journal(removeLink / restoreMcp backup),失败信息回传

- [ ] **Step 1: 写失败测试**

```typescript
// tests/projection/executor.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeProjection } from '../../src/projection/executor'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code'
import type { ProjectionPlan } from '../../src/core/projection'
import type { Manifest } from '../../src/core/types'

let home: string
let srcDir: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'home-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
  srcDir = await mkdtemp(join(tmpdir(), 'src-'))
  await mkdir(join(srcDir, 'frontend-design'), { recursive: true })
  await writeFile(join(srcDir, 'frontend-design', 'SKILL.md'), 'x')
})
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all([rm(home, { recursive: true, force: true }), rm(srcDir, { recursive: true, force: true })]) })

const plan: ProjectionPlan = {
  links: [{ skillId: 'frontend-design', source: 'local', targets: ['claude-code'] }],
  mcpEntries: [{ id: 'playwright', targets: ['claude-code'] }],
  skippedAgents: [], strategy: 'link',
}
const manifest: Manifest = {
  skills: { sources: [], skills: [{ id: 'frontend-design' }] },
  mcp: [{ id: 'playwright', type: 'stdio', command: 'npx', args: ['p'], targets: ['claude-code'] }],
  vars: { default: {}, active: {} }, config: { targets: ['claude-code'] }, errors: [],
}
const varsCtx = { env: {}, activeProfile: {}, defaultProfile: {} }
const installed = new Set(['claude-code'])

describe('executeProjection', () => {
  it('success: builds skill links + writes MCP', async () => {
    const fs = new NodeFileSystem()
    const res = await executeProjection(plan, manifest, varsCtx, {
      fs, adapters: { 'claude-code': new ClaudeCodeAdapter() }, installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(true)
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(true)
    expect(JSON.parse(await fs.readFile(join(home, '.claude.json'))).mcpServers.playwright.command).toBe('npx')
  })
  it('failure rolls back: removes built links + restores MCP backup', async () => {
    const fs = new NodeFileSystem()
    await fs.writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'old' } } }))
    const failing = new ClaudeCodeAdapter()
    failing.writeMcp = async () => { throw new Error('simulated write failure') }
    const res = await executeProjection(plan, manifest, varsCtx, {
      fs, adapters: { 'claude-code': failing }, installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(false)
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(false) // 链回滚
    const mcp = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(mcp.mcpServers.existing.command).toBe('old') // backup 恢复
    expect(mcp.mcpServers.playwright).toBeUndefined() // 本次写的被回滚
  })
  it('enabled:false member: cleans pre-existing link, does not build (spec 行 236)', async () => {
    const fs = new NodeFileSystem()
    await fs.mkdir(join(home, '.claude', 'skills'), true)
    await fs.createLink(join(srcDir, 'frontend-design'), join(home, '.claude', 'skills', 'frontend-design')) // 预建旧链
    expect(await fs.isLink(join(home, '.claude', 'skills', 'frontend-design'))).toBe(true)
    const disabledPlan: ProjectionPlan = {
      links: [{ skillId: 'frontend-design', source: 'local', targets: [] }], mcpEntries: [], skippedAgents: [], strategy: 'link',
    }
    const res = await executeProjection(disabledPlan, { ...manifest, mcp: [] }, varsCtx, {
      fs, adapters: { 'claude-code': new ClaudeCodeAdapter() }, installedAgents: installed,
      resolveSkillSrc: () => null, // enabled:false
    })
    expect(res.ok).toBe(true)
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(false) // 旧链被清理
  })
  it('mcp var resolve failure: skip that entry, others written, ok:true (spec 行 190)', async () => {
    const fs = new NodeFileSystem()
    const manifestUndef: Manifest = {
      ...manifest,
      mcp: [
        { id: 'broken', type: 'stdio', command: '${NOPE}', targets: ['claude-code'] },
        { id: 'ok', type: 'stdio', command: 'npx', targets: ['claude-code'] },
      ],
    }
    const planUndef: ProjectionPlan = {
      links: [], mcpEntries: [{ id: 'broken', targets: ['claude-code'] }, { id: 'ok', targets: ['claude-code'] }], skippedAgents: [], strategy: 'link',
    }
    const logs: string[] = []
    const res = await executeProjection(planUndef, manifestUndef, varsCtx, {
      fs, adapters: { 'claude-code': new ClaudeCodeAdapter() }, installedAgents: installed,
      resolveSkillSrc: () => null,
      logger: { error: (o) => logs.push(JSON.stringify(o)), warn: () => {} },
    })
    expect(res.ok).toBe(true)
    const mcp = JSON.parse(await fs.readFile(join(home, '.claude.json')))
    expect(mcp.mcpServers.broken).toBeUndefined()
    expect(mcp.mcpServers.ok.command).toBe('npx')
    expect(logs.some(l => l.includes('broken'))).toBe(true)
  })
  it('manifest errors: rejects projection before any IO (spec 行 190)', async () => {
    const fs = new NodeFileSystem()
    const badManifest: Manifest = { ...manifest, errors: ['mcp[0].command: required'] }
    const res = await executeProjection(plan, badManifest, varsCtx, {
      fs, adapters: { 'claude-code': new ClaudeCodeAdapter() }, installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure.failedStep).toBe('manifest-invalid')
    expect(await fs.exists(join(home, '.claude', 'skills', 'frontend-design'))).toBe(false) // 无 IO
  })
  it('strategy:copy copies skill dir (real dir, not link)', async () => {
    const fs = new NodeFileSystem()
    const copyPlan: ProjectionPlan = { ...plan, strategy: 'copy' }
    const res = await executeProjection(copyPlan, manifest, varsCtx, {
      fs, adapters: { 'claude-code': new ClaudeCodeAdapter() }, installedAgents: installed,
      resolveSkillSrc: (l) => join(srcDir, 'frontend-design'),
    })
    expect(res.ok).toBe(true)
    const dest = join(home, '.claude', 'skills', 'frontend-design')
    expect(await fs.isLink(dest)).toBe(false) // 真实目录非链接
    expect(await fs.exists(join(dest, 'SKILL.md'))).toBe(true) // 内容已 copy
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/projection/executor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/projection/executor.ts
import { join } from 'node:path'
import type { IFileSystem } from '../platform/interfaces.js'
import type { IAgentAdapter, McpFragment, ProjectionJournal, UndoAction, ProjectionFailure } from '../adapters/types.js'
import type { ProjectionPlan, McpPlanEntry } from '../core/projection.js'
import type { Manifest, AgentId, McpServer } from '../core/types.js'
import { resolveVars, type VarsContext } from '../core/vars.js'
import { agentMcpFile, agentSkillsDir } from '../adapters/paths.js'
import { mergeMcp } from './mcp-merge.js'

export interface ProjectionDeps {
  fs: IFileSystem
  adapters: Record<AgentId, IAgentAdapter>
  installedAgents: Set<AgentId> // 用于清理 enabled:false member 的已有软链(spec 行 236)
  // skill 资产根:local skill = assets/skills/<id>,source member = remote-cache/<repoId>/<memberPath>
  resolveSkillSrc: (link: ProjectionPlan['links'][number]) => string | null
  logger?: { error: (obj: unknown, msg: string) => void; warn?: (obj: unknown, msg: string) => void }
}

export type ProjectionResult = { ok: true } | { ok: false; failure: ProjectionFailure }

export async function executeProjection(
  plan: ProjectionPlan,
  manifest: Manifest,
  varsCtx: VarsContext,
  deps: ProjectionDeps,
): Promise<ProjectionResult> {
  // manifest 校验错误(zod,buildManifest 填充)则不投影(spec 行 190 投影前校验失败)
  if (manifest.errors.length > 0) {
    return { ok: false, failure: { failedStep: 'manifest-invalid', originalError: new Error(manifest.errors.join('; ')), rollbackReport: { undone: 0, rollbackFailures: [] } } }
  }
  const journal: ProjectionJournal = { undos: [] }
  const { fs, adapters, installedAgents } = deps
  try {
    // 1. skill 软链/copy(两阶段,保持投影前状态 spec 行 234):
    //    阶段 A 建 enabled link(targets 非空 + 有 src):覆盖 targets 旧链 + 建新链(记 undo)
    //    阶段 B 清所有 installedAgents 落点旧链中"非本次新建"的(enabled:false + 陈旧链 spec 235/236)
    //    阶段 B 在阶段 A 全成功后——建链失败时旧链保持原状(仅 targets 覆盖旧链因 IFileSystem 无 readlink 不可逆,spec 234 部分偏离,Global Constraints 标注)
    const builtDests = new Set<string>()
    for (const link of plan.links) {
      const src = deps.resolveSkillSrc(link)
      if (!src || link.targets.length === 0) continue // enabled:false/无 src:不建,旧链留阶段 B 清
      for (const agent of link.targets) {
        const skillsDir = agentSkillsDir(agent)
        await fs.mkdir(skillsDir, true)
        const dest = join(skillsDir, link.skillId)
        if (await fs.isLink(dest)) { await fs.removeLink(dest) } // 覆盖旧链(无 readlink 无法回滚,spec 234 部分偏离)
        else if (await fs.exists(dest)) { deps.logger?.warn?.({ dest, skillId: link.skillId }, 'skip cleanup: target is real file/dir (spec 行 236)'); continue }
        if (plan.strategy === 'copy') {
          await fs.copyDir(src, dest) // IFileSystem 需 copyDir(Plan 1 扩展,见 Task 0);copy 产物回滚残留(无 removeDir)
        } else {
          await fs.createLink(src, dest)
        }
        journal.undos.push({ kind: 'unlink', path: dest })
        builtDests.add(dest)
      }
    }
    for (const link of plan.links) { // 阶段 B:清非本次新建的旧链(enabled:false + 陈旧链)
      for (const agent of installedAgents) {
        const dest = join(agentSkillsDir(agent), link.skillId)
        if (builtDests.has(dest)) continue
        if (await fs.isLink(dest)) { await fs.removeLink(dest) }
        else if (await fs.exists(dest)) { deps.logger?.warn?.({ dest, skillId: link.skillId }, 'skip cleanup: target is real file/dir (spec 行 236)') }
      }
    }
    // 2. MCP 配置(按 agent:fragments 空 则跳过——保护用户手写 + 避免误触 mtime/git status;否则 readMcp → mergeMcp → backup → writeMcp)
    for (const agent of Object.keys(adapters) as AgentId[]) {
      const adapter = adapters[agent]
      const file = agentMcpFile(agent)
      const fragments = resolveMcpFragments(plan.mcpEntries, manifest.mcp, agent, varsCtx, deps.logger)
      if (fragments.length === 0) continue // 该 agent 无 manifest MCP 条目:不碰配置文件(防 git status 误报 dirty)
      const backup = await fs.exists(file) ? await fs.readFile(file) : null
      journal.undos.push({ kind: 'restoreMcp', path: file, backup }) // 先记 undo 再写
      const existing = await adapter.readMcp(fs)
      const merged = mergeMcp(existing, fragments)
      await adapter.writeMcp(fs, merged)
    }
    return { ok: true }
  } catch (originalError) {
    const rollbackFailures: { path: string; err: unknown }[] = []
    let undone = 0
    for (const u of [...journal.undos].reverse()) {
      try { await applyUndo(u, fs); undone++ }
      catch (e) { rollbackFailures.push({ path: u.path, err: e }); deps.logger?.error({ err: e, undo: u }, 'projection rollback step failed') }
    }
    deps.logger?.error({ err: originalError, rollbackReport: { undone, rollbackFailures } }, 'projection failed, rolled back')
    return { ok: false, failure: { failedStep: 'projection', originalError, rollbackReport: { undone, rollbackFailures } } }
  }
}

// plan.mcpEntries(已解析 targets,含回退全局)+ manifest.mcp(字段)→ 该 agent 的 fragment(变量解析;失败条目跳过,spec 行 190)
function resolveMcpFragments(entries: McpPlanEntry[], mcp: McpServer[], agent: AgentId, ctx: VarsContext, logger?: ProjectionDeps['logger']): McpFragment[] {
  const byId = new Map(mcp.map(s => [s.id, s]))
  const out: McpFragment[] = []
  for (const e of entries) {
    if (!e.targets.includes(agent)) continue
    const s = byId.get(e.id)
    if (!s) continue
    try {
      const rv = (v: string | undefined) => v === undefined ? undefined : resolveVars(v, ctx)
      const rva = (v: string[] | undefined) => v?.map(a => resolveVars(a, ctx))
      const rvm = (v: Record<string, string> | undefined) => v && Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveVars(x, ctx)]))
      out.push({ id: s.id, type: s.type, targets: e.targets, command: rv(s.command), args: rva(s.args), env: rvm(s.env), url: rv(s.url), headers: rvm(s.headers) })
    } catch (e) {
      logger?.error({ err: e, mcpId: s.id, agent }, 'mcp var resolve failed, skip this entry')
    }
  }
  return out
}

async function applyUndo(u: UndoAction, fs: IFileSystem): Promise<void> {
  if (u.kind === 'unlink') {
    if (await fs.isLink(u.path)) { await fs.removeLink(u.path) }
    else { throw new Error(`cannot rollback copy artifact (not a link): ${u.path} — IFileSystem has no removeDir (spec 234 偏离)`) }
  } else { // restoreMcp
    if (u.backup === null) {
      throw new Error(`cannot rollback newly created MCP file: ${u.path} — IFileSystem has no removeFile (spec 234 偏离)`)
    } else {
      await fs.writeFile(u.path, u.backup)
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/projection/executor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/projection/executor.ts tests/projection/executor.test.ts
git commit -m "feat(projection): executor with transactional journal + rollback (skill links + MCP backup/restore)"
```

---

## Self-Review

**1. Spec coverage** (Plan 2 覆盖范围):
- 3 adapter 配置生成(Claude .claude.json / Codex config.toml / OpenCode opencode.json)→ Task 4/5/6 ✓
- 投影策略:软链/copy(strategy 分支,Task 7 按 plan.strategy 调 createLink/copyDir)、事务回滚、已有软链先解链再重建、enabled:false 不建链**且清理已有软链**(spec 行 236,Task 7 先清 installedAgents 落点旧链再建)、未装 agent 跳过 → Task 7 ✓
- MCP 投影:按 id 合并(替换/插入)、type 整块替换清理旧字段、agent 原生配置无 id 用 server name 对齐(readMcp)、变量解析在投影时(resolveMcpFragments 消费 plan.mcpEntries 已含回退全局的 targets)、不碰用户手写 → Task 3 + Task 7 ✓
- source member 完整列表(scan 后「未列出 member 全启用」,spec 行 158)→ Task 2 ✓(补 Plan 1 planProjection 留的缺口)
- skill scan(**/SKILL.md 递归、排除 .git/node_modules/.cache、自定义 scan 字段)→ Task 2 ✓
- 跨平台 agent 路径(homedir + 平台分支:Win %APPDATA%/Mac Library/Linux XDG + env 覆盖)→ Task 1 ✓
- manifest 校验错误拦截(spec 行 190 投影前校验失败)→ Task 7 检查 manifest.errors ✓
- 变量未定义标记条目失败不写入(spec 行 190)→ Task 7 resolveMcpFragments catch 跳过 + 记日志 ✓

**2. Placeholder scan**: 无 TBD/TODO/占位。toAgentEntry 下沉 types.ts(消除 codex/opencode 反向依赖 claude-code);deleteFile 死代码已删;copy 降级/strategy:copy 产物 + backup=null 新建 MCP 文件回滚残留(IFileSystem 无 removeDir/removeFile,spec 行 234 已知偏离,Global Constraints 标注);Codex skills 落点风险标注。实现代码完整可跑。

**3. Type consistency**: `IAgentAdapter`/`McpFragment`(targets 可选)/`ProjectionJournal`/`UndoAction`(删 deleteFile)/`ProjectionFailure`(Task 1)跨 task 一致;`toAgentEntry`(Task 1 types.ts)三 adapter 共享 import;`mergeMcp`(Task 3)被 Task 7 用;`resolveMcpFragments(entries, mcp, agent, ctx, logger)` 消费 `McpPlanEntry`(Plan 1 export);`executeProjection` 消费 `ProjectionPlan`+`Manifest`(含 errors)+`ProjectionDeps`(含 installedAgents)。snake_case 继承 Plan 1。

**4. 三方包调研结论**: smol-toml(Codex TOML)、tinyglobby(scan)引入;xdg-basedir **未引入**(Windows 解析为 <home>/.config 非 %APPDATA%,与真实 OpenCode 落点不符,改平台分支自写);JSON 读写原生;事务回滚自写(journal+逆序,无合适库);toAgentEntry 下沉共享。Adapter/执行层属 Platform,Core 层(Plan 1)仍零平台依赖。

**5. 第 2 轮 review 修复**: Task 0 扩展 IFileSystem.copyDir(blocker,4 reviewer 共识跨 plan 缺口)、`user handwritten` 裸键加引号(blocker 语法错)、opencode env 覆盖直接返回 env 值(测试 FAIL)、paths.test stub HOME+USERPROFILE(Git Bash 本机红)、executor mkdir 传 boolean(原传对象 tsc 挂)、事务两阶段建链保持投影前状态(spec 234 high)、MCP fragments 空 跳过 write(防 git status dirty)、applyUndo 残留 case 抛错计入 rollbackFailures(报告诚实)、补 strategy:copy + skippedAgents 测试、Codex TOML 往返失真 Global Constraints 标注。
   第 1 轮修复: Task 0 安装依赖、xdgConfig 改平台分支、strategy:copy 实现、enabled:false 清理旧链、resolveMcpFragments 消费 plan.mcpEntries、变量失败跳过 + manifest errors 拦截补测试、deleteFile 死代码删除、toAgentEntry 下沉、McpFragment.targets 可选。

**未覆盖(留给后续 plan)**: git 同步流程编排(Plan 3)、远程 skill 发现/安装/更新(Plan 3)、API+WebUI(Plan 4)、MCP「manifest 删了移除」(spec 行 242,需持久化 loom 写过的 id 区分 loom 旧写 vs 用户手写,留后续)、IFileSystem.removeDir/removeFile(回滚 copy 产物/新建 MCP 文件,spec 行 234 偏离,现抛错计入 rollbackFailures)、Codex skills 机制实测(若 Codex 不读 ~/.codex/skills/ 需映射 AGENTS.md)。
