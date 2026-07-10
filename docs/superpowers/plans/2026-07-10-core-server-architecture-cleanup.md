# Core Server Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收紧 `packages/core` 与 `packages/server` 中已经确认的小半径 architecture seams，同时保留较大的 Vars/Sync 深化候选给审批后的下一轮。

**Architecture:** 本计划只落地低风险、可测试的 in-process 清理：server 统一 `LoggerPort` message-first interface，skill scanning 复用一个 scanner module，core merge 使用结构等价而不是文本顺序等价。Vars application module、Sync session module、skills manifest store 属于更大的 deep module 候选，只进入报告，不在本计划中重构。

**Tech Stack:** TypeScript 5.9、Bun workspace、Vitest、Prettier、tinyglobby、gray-matter、js-yaml、zod、Hono。

## Global Constraints

- 对用户可见内容用中文；代码标识符、命令、技术名词保留原文。
- 不创建或切换分支，不提交、不 push，除非用户明确审批。
- 不改无关文件；已有用户/协作者改动必须保留。
- `packages/core` 保持无 IO；三方包只留在 codec/manifest/merge 等既有 seam 中。
- 错误处理节点必须记录完整错误对象与堆栈；不得只 log `err.message`。
- JS/TS 命令使用 `bun`；验证默认跑 `bun run test` 和 `bun run format:check`。
- 本计划执行前已检测当前目录是 linked worktree：`.git/worktrees/loom2`，不再嵌套创建 worktree。

---

## File Structure

| File                                                                           | Responsibility                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/server/src/ports/logger.ts`                                          | 定义 server 内部 message-first logger interface。                          |
| `packages/server/src/vars/store.ts`                                            | 使用统一 `LoggerPort`，保持 VarsStore 原子写与 symlink 校验实现。          |
| `packages/server/src/api/routes/vars.ts`                                       | 直接注入 `apiLogger`，删除参数翻转 adapter。                               |
| `packages/server/src/projection/executor.ts`                                   | 使用统一 logger seam，保留 projection rollback 和 var render 日志语义。    |
| `packages/server/src/projection/deps.ts`                                       | 直接把 `projectionLogger` 作为 projection deps logger。                    |
| `packages/server/src/sync/pull.ts`                                             | 旧 sync helper 改为 message-first logger seam，行为不变。                  |
| `packages/server/src/projection/scan.ts`                                       | 承载 source/local skill scanning、ignore、ordering、frontmatter metadata。 |
| `packages/server/src/api/routes/skills-yaml.ts`                                | Local skill scan route 只做 HTTP 和路径解析，scanner 细节下沉。            |
| `packages/server/src/remote/frontmatter.ts`                                    | `SkillMeta` 暴露 `frontmatterName`，避免 discover 二次读取文件。           |
| `packages/server/src/remote/discover.ts`                                       | 复用 `scanSourceMembers` metadata，保留 mismatch warning。                 |
| `packages/core/src/merge.ts`                                                   | `threeWayMerge` 内部结构等价比较，忽略 object key order。                  |
| `packages/core/test/merge.test.ts`                                             | 覆盖 key order 不造成冲突。                                                |
| `packages/server/test/*`                                                       | 锁定 logger ordering、scanner behavior、frontmatter metadata。             |
| `C:/Users/10107/AppData/Local/Temp/architecture-review-2026-07-10_160752.html` | 临时架构报告，不进入 repo。                                                |

### Task 1: Normalize Server Logger Seam

**Files:**

- Create: `packages/server/src/ports/logger.ts`
- Modify: `packages/server/src/vars/store.ts`
- Modify: `packages/server/src/api/routes/vars.ts`
- Modify: `packages/server/src/projection/executor.ts`
- Modify: `packages/server/src/projection/deps.ts`
- Modify: `packages/server/src/sync/pull.ts`
- Test: `packages/server/test/vars/store.test.ts`
- Test: `packages/server/test/projection/executor.test.ts`

**Interfaces:**

- Consumes: existing logger shape from `packages/server/src/lib/logger.ts`: `error(message, context?)`, `warn(message, context?)`, `info(message, context?)`.
- Produces:

```ts
export type LogContext = Record<string, unknown>

export interface LoggerPort {
  error(message: string, context?: LogContext): void
  warn?(message: string, context?: LogContext): void
  info?(message: string, context?: LogContext): void
}
```

- [x] **Step 1: Write/adjust logger ordering tests**

Update assertions in `packages/server/test/vars/store.test.ts` so failed atomic writes expect message first and full error object second:

```ts
expect(logger.error).toHaveBeenCalledWith(
  'vars atomic write failed',
  expect.objectContaining({ err: expect.any(Error), files: ['a', 'b'] }),
)
```

Update `packages/server/test/projection/executor.test.ts` fake logger to capture the second argument:

```ts
logger: {
  error: (_message, context) => logs.push(JSON.stringify(context)),
  warn: () => {},
}
```

- [x] **Step 2: Run targeted tests to verify current behavior fails before implementation**

Run:

```bash
bun run test packages/server/test/vars/store.test.ts packages/server/test/projection/executor.test.ts
```

Expected before implementation: FAIL because `VarsStore` and `ProjectionDeps` still call `logger.error(context, message)`.

- [x] **Step 3: Add LoggerPort and update implementations**

Create `packages/server/src/ports/logger.ts` with the `LoggerPort` interface above. Change `VarsStore`, projection deps/executor, and `sync/pull.ts` to call:

```ts
logger?.error('vars atomic write failed', { err: error, files: environments })
logger?.warn?.('conflict worktree file unavailable', { err, repoPath, path })
```

Change `storeFor()` in `packages/server/src/api/routes/vars.ts` to pass `apiLogger` directly:

```ts
function storeFor(deps: RouteDeps, repoPath: string): VarsStore {
  return new VarsStore(repoPath, deps.fs, apiLogger)
}
```

- [x] **Step 4: Verify task**

Run:

```bash
bun run test packages/server/test/vars/store.test.ts packages/server/test/projection/executor.test.ts packages/server/test/sync/pull.test.ts
```

Expected after implementation: PASS.

### Task 2: Reuse One Skill Scanner Module

**Files:**

- Modify: `packages/server/src/projection/scan.ts`
- Modify: `packages/server/src/api/routes/skills-yaml.ts`
- Modify: `packages/server/src/remote/frontmatter.ts`
- Modify: `packages/server/src/remote/discover.ts`
- Test: `packages/server/test/projection/scan.test.ts`
- Test: `packages/server/test/remote/frontmatter.test.ts`
- Test: `packages/server/test/remote/discover.test.ts`

**Interfaces:**

- Consumes: existing `scanSourceMembers(repoPath, source)` and `parseSkillMeta(content, dirName, skillPath)`.
- Produces:

```ts
export interface ScannedLocalSkill {
  name: string
  path: string
}

export async function scanLocalSkills(rootDir: string): Promise<ScannedLocalSkill[]>
```

`ScannedMember` also produces optional `frontmatterName?: string`.

- [x] **Step 1: Write scanner behavior tests**

Add local scan coverage in `packages/server/test/projection/scan.test.ts`:

```ts
await expect(scanLocalSkills(root)).resolves.toEqual([
  { name: 'brainstorming', path: join(root, 'brainstorming') },
  { name: 'tdd', path: join(root, 'engineering', 'tdd') },
])
```

Add frontmatter metadata coverage in `packages/server/test/remote/frontmatter.test.ts`:

```ts
expect(parseSkillMeta('---\nname: other-skill\n---\n', 'my-skill', '/p')!.frontmatterName).toBe(
  'other-skill',
)
```

- [x] **Step 2: Run targeted tests to verify current behavior fails before implementation**

Run:

```bash
bun run test packages/server/test/projection/scan.test.ts packages/server/test/remote/frontmatter.test.ts packages/server/test/remote/discover.test.ts
```

Expected before implementation: FAIL because `scanLocalSkills` and `frontmatterName` do not exist.

- [x] **Step 3: Implement scanner reuse**

In `packages/server/src/projection/scan.ts`, add `scanLocalSkills()` using the same `DEFAULT_SOURCE_SCAN` and `DEFAULT_IGNORE` as source scan:

```ts
export async function scanLocalSkills(rootDir: string): Promise<ScannedLocalSkill[]> {
  const matches = await glob(DEFAULT_SOURCE_SCAN, {
    cwd: rootDir,
    ignore: DEFAULT_IGNORE,
    onlyFiles: true,
  })
  return matches
    .map((match) => {
      const dir = dirname(match)
      return { name: basename(dir), path: join(rootDir, dir) }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
```

Keep `mergeLocalSkills()` responsible for deduping pathless local skills:

```ts
for (const name of [...new Set(scanned.map((skill) => skill.name))]) {
  if (!have.has(name)) out.push({ id: name })
}
```

- [x] **Step 4: Remove duplicate route scanner implementation**

In `packages/server/src/api/routes/skills-yaml.ts`, replace the inline `tinyglobby` dynamic import with:

```ts
return c.json({ ok: true, skills: await scanLocalSkills(resolvedDir) })
```

- [x] **Step 5: Avoid duplicate SKILL.md IO in discover**

Expose `frontmatterName` from `parseSkillMeta()` and pass it through `scanSourceMembers()`. In `discoverSkills()`, use `member.frontmatterName` for mismatch warning instead of rereading the file:

```ts
if (member.frontmatterName && member.frontmatterName !== member.name) {
  discoverLogger.warn('source skill frontmatter name differs from path member name', {
    url: source.url,
    path: relativePath,
    frontmatterName: member.frontmatterName,
    memberName: member.name,
  })
}
```

- [x] **Step 6: Verify task**

Run:

```bash
bun run test packages/server/test/projection/scan.test.ts packages/server/test/remote/frontmatter.test.ts packages/server/test/remote/discover.test.ts
```

Expected after implementation: PASS.

### Task 3: Make Core Merge Equality Structural

**Files:**

- Modify: `packages/core/src/merge.ts`
- Modify: `packages/core/test/merge.test.ts`

**Interfaces:**

- Consumes: existing `threeWayMerge(baseText, oursText, theirsText, kind)`.
- Produces: same public interface; only internal equality semantics change.

- [x] **Step 1: Write key-order regression test**

Add to `packages/core/test/merge.test.ts`:

```ts
it('config: object key order alone is not a conflict', () => {
  const r = threeWayMerge(
    'settings:\n  a: 1\n  b: 2\n',
    'settings:\n  b: 2\n  a: 1\n',
    'settings:\n  a: 1\n  b: 2\n',
    'config',
  )

  expect(r.conflicts).toHaveLength(0)
  expect(r.merged).toContain('settings:')
})
```

- [x] **Step 2: Run test to verify current behavior fails before implementation**

Run:

```bash
bun run test packages/core/test/merge.test.ts
```

Expected before implementation: FAIL because `deepEq()` uses `JSON.stringify()` and treats object key order as different.

- [x] **Step 3: Implement structural equality**

Replace `deepEq()` with recursive array/object comparison:

```ts
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEq(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aTag = Object.prototype.toString.call(a)
  const bTag = Object.prototype.toString.call(b)
  if (aTag !== bTag) return false
  if (aTag !== '[object Object]') return JSON.stringify(a) === JSON.stringify(b)
  const aObj = asObj(a)
  const bObj = asObj(b)
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.hasOwn(bObj, key) && deepEq(aObj[key], bObj[key]))
}
```

- [x] **Step 4: Verify task**

Run:

```bash
bun run test packages/core/test/merge.test.ts
```

Expected after implementation: PASS.

### Task 4: Generate Architecture Report and Verify

**Files:**

- Create outside repo: `C:/Users/10107/AppData/Local/Temp/architecture-review-2026-07-10_160752.html`
- No repo docs updated for the report.

**Interfaces:**

- Consumes: findings from coordinator research over core/server modules.
- Produces: visual HTML report with before/after diagrams and top recommendation.

- [x] **Step 1: Write report to OS temp directory**

Create an HTML file using Tailwind CDN and Mermaid CDN. Include these candidates:

```text
1. Deepen the Vars application module
2. Make skill scanning one module
3. Normalize the logger seam
4. Choose the Sync deep module
5. Keep merge semantic, not textual
```

- [x] **Step 2: Open report**

Run:

```powershell
Start-Process "C:\Users\10107\AppData\Local\Temp\architecture-review-2026-07-10_160752.html"
```

Expected: report opens in the default browser.

- [x] **Step 3: Run targeted tests**

Run:

```bash
bun run test packages/core/test/merge.test.ts packages/server/test/vars/store.test.ts packages/server/test/projection/scan.test.ts packages/server/test/projection/executor.test.ts packages/server/test/remote/discover.test.ts packages/server/test/remote/frontmatter.test.ts packages/server/test/sync/pull.test.ts
```

Expected: `7 passed`, `65 passed`.

- [x] **Step 4: Run full test suite**

Run:

```bash
bun run test
```

Expected: `72 passed`, `662 passed | 1 skipped`.

- [x] **Step 5: Run format check**

Run:

```bash
bun run format:check
```

Expected: `All matched files use Prettier code style!`

- [x] **Step 6: User approval checkpoint**

Stop and ask for user approval before any commit, branch operation, PR, larger refactor, or additional architecture cleanup.

### Task 5: Optional Commit After Approval

**Files:**

- Stage only files changed by this plan.

**Interfaces:**

- Consumes: explicit user approval text.
- Produces: one focused Conventional Commit.

- [ ] **Step 1: Check status and diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only this plan's files are modified, no whitespace errors.

- [ ] **Step 2: Stage only approved files**

Run only after approval:

```bash
git add docs/superpowers/plans/2026-07-10-core-server-architecture-cleanup.md \
  packages/core/src/merge.ts \
  packages/core/test/merge.test.ts \
  packages/server/src/ports/logger.ts \
  packages/server/src/vars/store.ts \
  packages/server/src/api/routes/vars.ts \
  packages/server/src/projection/executor.ts \
  packages/server/src/projection/deps.ts \
  packages/server/src/sync/pull.ts \
  packages/server/src/projection/scan.ts \
  packages/server/src/remote/frontmatter.ts \
  packages/server/src/remote/discover.ts \
  packages/server/src/api/routes/skills-yaml.ts \
  packages/server/test/vars/store.test.ts \
  packages/server/test/projection/executor.test.ts \
  packages/server/test/projection/scan.test.ts \
  packages/server/test/remote/frontmatter.test.ts
```

- [ ] **Step 3: Commit only after approval**

Run only after approval:

```bash
git commit -m "refactor: tighten core server architecture seams"
```

Expected: commit succeeds and contains only approved files.

## Self-Review

- Spec coverage: covers `core/*` and `server/*` small architecture cleanup, third-party package placement, HTML report, self-test, and approval stop. Larger Vars/Sync architecture work is deliberately report-only.
- Placeholder scan: no `TBD`, `TODO`, or “implement later” placeholders remain.
- Type consistency: `LoggerPort` is message-first and matches `lib/logger.ts`; `scanLocalSkills()` returns `{ name, path }`; `SkillMeta.frontmatterName` is optional and passed through scanner/discover.
