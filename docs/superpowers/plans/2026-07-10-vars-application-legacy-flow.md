# Vars Application Legacy Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第 1 轮 loop：继续 deepen `VarsApplication`，把 legacy vars environments/mutations/resolve/validate/reveal flow 从 Hono route 下沉到 server-side Vars module。

**Architecture:** `packages/server/src/api/routes/vars.ts` 保留 HTTP adapter 责任：request parsing、repo authorization、per-repo access queue、JSON response。`packages/server/src/vars/application.ts` 成为 Vars application module 的主要 interface，封装 storage load/write、core mutation lifecycle、secret masking、delete impact、resolve/validate/reveal error mapping。`packages/core` 仍保持无 IO。

**Tech Stack:** TypeScript 5.9, Bun workspace, Hono, Vitest, `@loom/core` Vars primitives, existing `VarsStore`.

## Global Constraints

- 对用户可见内容用中文；代码标识符、命令、技术名词保留原文。
- 本轮是用户澄清后的 loop 第 1 轮；之前改动不计入 3x。
- 不提交、不 push、不创建/切换分支，除非用户明确审批。
- 不新增三方依赖；本轮三方包策略是保留高质量既有包，并通过 module seam 限制调用面。
- 不改变 Vars HTTP contract；`packages/server/test/api/vars-routes.test.ts` 必须继续通过。
- `packages/core` 保持无 IO；不改变 core Vars 语义。
- 错误路径必须保留完整错误对象日志；不得新增静默 catch。

---

## Third-Party Package Analysis

本轮不新增或替换三方包。当前 server 依赖中与本轮相关的包：

| Package           | Current evidence                                                                                               | Decision                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hono`            | npm metadata: `4.12.27`, modified `2026-06-23`, MIT, `honojs/hono`                                             | 保留。HTTP adapter 已经清晰，不需要替换。                                                                 |
| `tinyglobby`      | npm metadata: `0.2.17`, modified `2026-05-30`, MIT, `SuperchupuDev/tinyglobby`; ctx7 docs confirm `dot` option | 保留。用于 scan seam；本轮不涉及。                                                                        |
| `simple-git`      | npm metadata: `3.36.0`, modified `2026-04-12`, MIT, `steveukx/git-js`                                          | 保留。Sync seam 后续可评估，不在本轮动。                                                                  |
| `proper-lockfile` | npm metadata: `4.1.2`, modified `2025-12-06`, MIT                                                              | 保留。Sync lock seam 后续可评估，不在本轮动。                                                             |
| `js-yaml`         | npm metadata: `5.2.0`, modified `2026-06-26`, MIT, `nodeca/js-yaml`                                            | 保留。YAML codec 已有 seam，不需要替换。                                                                  |
| `gray-matter`     | npm metadata: `4.0.3`, modified `2023-07-27`, MIT, `jonschlinkert/gray-matter`                                 | 暂不替换。它只在 frontmatter seam 内使用，功能优先级不高；若后续扩展 frontmatter 能力，再评估更活跃替代。 |
| `smol-toml`       | npm metadata: `1.7.0`, modified `2026-06-21`, BSD-3-Clause, `squirrelchat/smol-toml`                           | 保留。小而活跃，适合现有 TOML codec seam。                                                                |

结论：本轮架构收益来自 module depth，不来自包替换。若后续要换包，先验证社区活跃度、维护质量、迁移风险和功能优先级。

## File Structure

| File                                            | Responsibility                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/server/src/vars/application.ts`       | Add legacy Vars operations behind the application interface.                                      |
| `packages/server/src/api/routes/vars.ts`        | Thin HTTP adapter around request validation, access locking, app calls, and JSON responses.       |
| `packages/server/test/vars/application.test.ts` | Direct interface tests for masking, mutation persistence, delete impact, resolve/validate/reveal. |
| `packages/server/test/api/vars-routes.test.ts`  | Existing HTTP contract regression suite.                                                          |

### Task 1: Extend VarsApplication Legacy Interface

**Files:**

- Modify: `packages/server/src/vars/application.ts`
- Modify: `packages/server/test/vars/application.test.ts`

**Interfaces:**

- Consumes: `VarsStore`, `IFileSystem`, `VarEntry`, `VarsEnvironment`, `VarsMutationResult`.
- Produces:

```ts
listEnvironments(repoPath: string): Promise<{ environments: string[]; diagnostics: VarsDiagnostic[] }>
getEnvironment(repoPath: string, environment: string): Promise<{ name: string; environment: MaskedVarsEnvironment }>
createEnvironment(repoPath: string, environment: string): Promise<void>
deleteEnvironment(repoPath: string, environment: string): Promise<void>
setVariable(repoPath: string, command: VarsSetVariableCommand): Promise<VarsMutationResponse>
renameVariable(repoPath: string, command: VarsRenameVariableCommand): Promise<VarsMutationResponse>
deleteVariable(repoPath: string, command: VarsDeleteVariableCommand): Promise<VarsMutationResponse>
deleteImpact(repoPath: string, environment: string, key: string): Promise<DeleteImpact>
resolve(repoPath: string, chain: string[]): Promise<PresentedVarsResolution>
validateDraft(repoPath: string, command: VarsDraftCommand): Promise<{ resolution: PresentedVarsResolution }>
revealVariable(repoPath: string, environment: string, key: string): Promise<VarEntry>
```

- [x] **Step 1: Add direct application tests**

Cover:

- list/get masks environment secrets.
- set/rename/resolve persists mutations and masks secret values.
- validateDraft masks resolved secret values without writing.
- revealVariable returns only the requested raw entry.
- deleteImpact/deleteVariable preserve stale impact token diagnostics.

- [x] **Step 2: Move legacy helpers into application module**

Move from route into `application.ts`:

- `maskEntry()`
- `maskEnvironment()`
- `presentResolvedValues()`
- `presentResolution()`
- `loadAll()`
- `mutationError()`
- `persistMutation()`

Use `VarsApplicationError` for core mutation persistence failures so route error formatting stays uniform.

- [x] **Step 3: Implement legacy application methods**

Implement methods listed above using `VarsStore` and `@loom/core` primitives. Preserve existing observable behavior and error codes.

### Task 2: Rewire Vars Route Legacy Endpoints

**Files:**

- Modify: `packages/server/src/api/routes/vars.ts`

**Interfaces:**

- Consumes: `VarsApplication` legacy methods.
- Produces: unchanged HTTP JSON and status codes.

- [x] **Step 1: Replace environment endpoints**

Update:

- `GET /vars/environments`
- `GET /vars/environments/:environment`
- `POST /vars/environments`
- `DELETE /vars/environments`

- [x] **Step 2: Replace variable mutation endpoints**

Update:

- `PUT /vars/variables`
- `POST /vars/variables/rename`
- `POST /vars/variables/delete-impact`
- `DELETE /vars/variables`

- [x] **Step 3: Replace resolve/validate/reveal endpoints**

Update:

- `POST /vars/resolve`
- `POST /vars/validate`
- `POST /vars/variables/reveal`

- [x] **Step 4: Remove route-local imports/helpers that become unused**

Route should no longer import `VarsStore`, `danglingDiagnostics`, core mutation functions, lifecycle resolution helpers, or `VarsEnvironment` unless still needed for request parsing.

### Task 3: Verification

**Files:**

- No additional production files.

- [x] **Step 1: Run focused tests**

Run:

```bash
bun run test packages/server/test/vars/application.test.ts packages/server/test/api/vars-routes.test.ts
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

Stop and decide whether to enter loop round 2 or pause because further optimization cost exceeds benefit. Do not stage, commit, push, create a branch, or continue round 2 without making this decision explicit.

Decision: enter loop round 2 with a narrower `SkillsApplication` seam around `packages/server/src/api/routes/skills-yaml.ts`. Do not touch sync manager internals in this round.

## Self-Review

- Spec coverage: satisfies loop round 1 with architecture deepening, code simplification, third-party package analysis, plan, execution, and self-test.
- Placeholder scan: no `TBD`, `TODO`, or “implement later” placeholders remain.
- Type consistency: legacy Vars commands are parsed in the route and executed through `VarsApplication`; route remains the HTTP adapter.
