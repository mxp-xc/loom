# Skills Application Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第 2 轮 loop：把 `skills.yaml` manifest/local skill use cases 从 `skills-yaml` Hono route 下沉到 server-side Skills application module，同时保持 HTTP contract 不变。

**Architecture:** `packages/server/src/api/routes/skills-yaml.ts` 保留 HTTP adapter 责任：request parsing、repo authorization、status code 和 JSON response。`packages/server/src/skills/application.ts` 成为 Skills module 的主要 interface，封装 YAML load/save、本地 skill scan/import/write/delete、source manifest mutation 和 add-source auto-install 降级日志。`packages/core` 继续只提供无 IO mutators。

**Tech Stack:** TypeScript 5.9, Bun workspace, Hono, Vitest, `@loom/core` skill mutators, existing `js-yaml` repo-config helpers, existing `tinyglobby` scan helper.

## Global Constraints

- 对用户可见内容用中文；代码标识符、命令、技术名词保留原文。
- 本轮是用户澄清后的 loop 第 2 轮；第 1 轮已完成并验证。
- 不提交、不 push、不创建/切换分支，除非用户明确审批。
- 不新增三方依赖；本轮收益来自 module depth，不来自换包。
- 不改变 Skills HTTP contract；现有 `packages/server/test/api/routes-fixes.test.ts` 和 `packages/server/test/api/local-skill-status.test.ts` 必须继续通过。
- `packages/core` 保持无 IO；不改变 core skill mutator 语义。
- `packages/server/src/api/routes/skills-yaml.ts` 接收 request 并解析 repo；`SkillsApplication` 接收已授权 repo path，不自行做 repo authorization。
- 错误路径必须保留完整错误对象日志；不得新增静默 catch。

---

## Third-Party Package Analysis

本轮不新增或替换三方包。

| Package      | Current role                                                        | Decision                                                              |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `hono`       | Route adapter in `packages/server/src/api/routes/skills-yaml.ts`    | 保留。社区稳定且已是现有 HTTP seam；本轮只让 route 变薄。             |
| `js-yaml`    | Indirectly through `readYaml()` / `writeYaml()` in `repo-config.ts` | 保留。已有 codec helper；换包收益低且会扩大 YAML serialization 风险。 |
| `tinyglobby` | Indirectly through `scanLocalSkills()`                              | 保留。已支持 `dot` 和 `ignore` 选项；本轮继续沿用 `.cache` 兼容修复。 |
| `simple-git` | Indirectly through `installSkill()` auto-cache                      | 保留。只从 route 移入 application use case，不改 git adapter。        |

结论：三方包质量和活跃度足够支撑当前功能；低优先级 frontmatter/scan 能力不为换包单独改动。

## File Structure

| File                                                  | Responsibility                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/skills/application.ts`           | Deep module for authorized Skills manifest and local-skill use cases.                                                   |
| `packages/server/src/api/routes/skills-yaml.ts`       | Thin HTTP adapter around request validation, repo resolution, app calls, and JSON responses.                            |
| `packages/server/test/skills/application.test.ts`     | Direct interface tests for local scan/import/write/delete, source mutation, targets, and auto-install fallback logging. |
| `packages/server/test/api/routes-fixes.test.ts`       | Existing HTTP contract regression suite.                                                                                |
| `packages/server/test/api/local-skill-status.test.ts` | Existing local scan and source target route regression suite.                                                           |

### Task 1: Add SkillsApplication Interface

**Files:**

- Create: `packages/server/src/skills/application.ts`
- Create: `packages/server/test/skills/application.test.ts`

**Interfaces:**

- Consumes: `IFileSystem`, `IGit`, `LoggerPort`, `LocalSkill`, `AgentId`, core skill mutators.
- Produces:

```ts
export class SkillsApplicationError extends Error {
  readonly status: 400 | 404 | 409
  readonly code: string
}

export class SkillsApplication {
  scanLocalSkills(command: { dir: string; repoPath?: string }): Promise<ScannedLocalSkill[]>
  addLocalSkill(repoPath: string, skill: LocalSkill): Promise<{ skill: LocalSkill }>
  importLocalSkills(
    repoPath: string,
    command: { skills: LocalSkillImport[]; mode: 'move' | 'ref' },
  ): Promise<{ count: number }>
  writeLocalSkills(
    repoPath: string,
    command: { skills: LocalSkillWrite[] },
  ): Promise<{ count: number }>
  addSource(repoPath: string, command: AddSourceCommand): Promise<{ source: SkillSource }>
  setSourceMembers(repoPath: string, url: string, members: unknown): Promise<void>
  removeSource(repoPath: string, url: string): Promise<void>
  updateSourceMeta(repoPath: string, command: UpdateSourceMetaCommand): Promise<void>
  removeLocalSkill(repoPath: string, id: string): Promise<void>
  setSkillTargets(repoPath: string, command: SetSkillTargetsCommand): Promise<void>
  setSourceMemberTargets(repoPath: string, sourceUrl: string, updates: unknown[]): Promise<void>
  setLocalSkillTargets(repoPath: string, id: string, targets: AgentId[]): Promise<void>
}
```

- [x] **Step 1: Write failing application tests**

Add tests that import `SkillsApplication` and prove the desired interface:

```ts
import { describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { SkillsApplication } from '../../src/skills/application.js'
```

Cover:

- `scanLocalSkills()` expands `~`, resolves relative paths against `repoPath`, returns `[]` for missing dirs, and includes `.cache` skills while ignoring `node_modules`.
- `importLocalSkills()` stores repo `assets/skills/<name>` refs as pathless local skills.
- `writeLocalSkills()` writes safe relative file paths and rejects existing destinations with `already_exists`.
- `removeLocalSkill()` deletes `assets/skills/<id>` only for pathless skills.
- `setSourceMemberTargets()` writes all target changes through one YAML write.
- `addSource()` keeps manifest write success when auto-install fails and logs `{ err }`.

Run:

```bash
bun run test packages/server/test/skills/application.test.ts
```

Expected before implementation: FAIL because `packages/server/src/skills/application.ts` does not exist.

- [x] **Step 2: Implement minimal application module**

Create `packages/server/src/skills/application.ts` with:

- `SkillsApplicationError` for application-level `already_exists` and `not_found`.
- Private `skillsYamlPath(repoPath)`, `assetsSkillsDir(repoPath)`, `readManifest(repoPath)`, `writeManifest(repoPath, manifest)` helpers.
- Methods listed in the interface.
- Existing `scanLocalSkills(resolvedDir, { dot: true, ignore: LOCAL_SKILL_SCAN_IGNORE })` behavior.
- Existing `installSkill()` auto-install fallback behavior with `logger.error('auto-install failed for source', { err, url })`.

Run:

```bash
bun run test packages/server/test/skills/application.test.ts
```

Expected after implementation: PASS.

### Task 2: Rewire Skills Route to Application Module

**Files:**

- Modify: `packages/server/src/api/routes/skills-yaml.ts`

**Interfaces:**

- Consumes: `SkillsApplication` and `SkillsApplicationError`.
- Produces: unchanged HTTP JSON and status codes.

- [x] **Step 1: Instantiate the application once per route factory**

At the top of `createSkillsYamlRoutes()`:

```ts
const skills = new SkillsApplication(deps.fs, deps.git, deps.home)
```

Route remains responsible for:

- `await c.req.json()`
- validating required request fields that determine `400` responses
- `resolveRepoPath(deps.fs, repo, deps.home)`
- converting application errors to existing JSON shapes

- [x] **Step 2: Replace manifest/local-skill route bodies**

Rewrite these handlers to call `SkillsApplication`:

- `POST /skills/local`
- `POST /skills/local/scan`
- `POST /skills/local/import`
- `POST /skills/local/write`
- `POST /sources`
- `POST /sources/members`
- `DELETE /sources`
- `POST /sources/update`
- `DELETE /skills/local`
- `POST /skills/targets`
- `POST /skills/source-targets`
- `POST /skills/local/targets`

Preserve existing `error` codes, messages, and success response bodies.

- [x] **Step 3: Remove route-local implementation imports**

Remove from `skills-yaml.ts` when unused:

- `deriveRepoId`
- `addLocalSkill`
- `removeLocalSkill`
- `addSource`
- `removeSource`
- `setSourceMembers`
- `setSourceMemberTargets`
- `updateSourceMeta`
- `setSkillTargets`
- `setLocalSkillTargets`
- `installSkill`
- `LOCAL_SKILL_SCAN_IGNORE`
- `scanLocalSkills`
- `readYaml`
- `writeYaml`
- `logger`
- `join`, `isAbsolute`, `dirname` if no longer used

### Task 3: Verification

**Files:**

- No additional production files.

- [x] **Step 1: Run focused tests**

Run:

```bash
bun run test packages/server/test/skills/application.test.ts packages/server/test/api/routes-fixes.test.ts packages/server/test/api/local-skill-status.test.ts
```

Expected: PASS.

- [x] **Step 2: Run full verification**

Run:

```bash
bun run test
bun run format:check
git diff --check
```

Expected: all pass.

- [x] **Step 3: Loop decision checkpoint**

Stop and decide whether to enter loop round 3 or pause because further optimization cost exceeds benefit. Do not stage, commit, push, create a branch, or continue round 3 without making this decision explicit.

Decision: enter loop round 3 with a narrow `McpApplication` seam around `packages/server/src/api/routes/mcp-yaml.ts`. Defer `memory` and sync-state refactors until after review because their behavior surface is broader.

## Self-Review

- Spec coverage: covers loop round 2 with architecture deepening, code simplification, third-party package analysis, plan, execution, and self-test.
- Placeholder scan: no `TBD`, `TODO`, or “implement later” placeholders remain.
- Type consistency: route receives HTTP input and repo resolution; `SkillsApplication` receives authorized repo paths and owns manifest/local skill implementation details.
