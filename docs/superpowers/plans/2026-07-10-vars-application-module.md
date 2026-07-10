# Vars Application Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the server-side Vars module by moving agent-aware Vars application logic out of the Hono route while preserving the current HTTP contract.

**Architecture:** Add `packages/server/src/vars/application.ts` as the module interface for authorized repository Vars operations. The route remains the HTTP adapter: parse request fields, authorize/serialize repo access, call the application module, and format JSON. Core Vars semantics and storage behavior remain unchanged.

**Tech Stack:** TypeScript 5.9, Bun workspace, Hono, Vitest, `@loom/core` Vars primitives, server filesystem ports.

## Global Constraints

- 对用户可见内容用中文；代码标识符、命令、技术名词保留原文。
- 不提交、不 push、不创建/切换分支，除非用户明确审批。
- 不改变 Vars HTTP contract；现有 `packages/server/test/api/vars-routes.test.ts` 必须继续通过。
- `packages/core` 保持无 IO；本轮不改变 core Vars 语义。
- `packages/server/src/api/routes/vars.ts` 保留 Hono、request parsing、repo access lock 和 response formatting。
- `packages/server/src/vars/application.ts` 接收已授权 repo path，不自行做 repo authorization。
- 允许使用三方包，但新增或替换必须优先选择社区活跃、高质量、维护稳定的包；低优先级功能不为三方包替换单独改动。
- 错误路径必须带完整错误对象日志；本轮不得新增静默 catch。

---

## File Structure

| File                                            | Responsibility                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/server/src/vars/application.ts`       | Deep module for authorized agent-aware Vars operations.                                     |
| `packages/server/src/api/routes/vars.ts`        | Thin HTTP adapter around request validation, access locking, app calls, and JSON responses. |
| `packages/server/test/vars/application.test.ts` | Tests the application module interface directly.                                            |
| `packages/server/test/api/vars-routes.test.ts`  | Existing route contract regression suite.                                                   |

### Task 1: Add Agent-Aware Vars Application Module

**Files:**

- Create: `packages/server/src/vars/application.ts`
- Test: `packages/server/test/vars/application.test.ts`

**Interfaces:**

- Consumes: `IFileSystem`, `AgentId`, `VarDefinition`, `VarOverride`, `VarsLayerKind`.
- Produces:

```ts
export class VarsApplicationError extends Error {
  readonly status: 400 | 404 | 409 | 422
  readonly code: string
  readonly diagnostics?: VarsDiagnostic[]
  readonly details?: Record<string, unknown>
}

export class VarsApplication {
  preview(repoPath: string, agent: AgentId): Promise<Extract<LayeredVarsResolution, { ok: true }>>
  matrix(repoPath: string, agent: AgentId): Promise<VarsMatrix>
  setBaseKey(repoPath: string, key: string, definition: VarDefinition): Promise<void>
  deleteBaseKey(repoPath: string, key: string): Promise<void>
  renameBaseKey(repoPath: string, oldKey: string, newKey: string): Promise<void>
  setOverride(repoPath: string, command: SetVarsOverrideCommand): Promise<void>
  clearOverride(repoPath: string, command: ClearVarsOverrideCommand): Promise<void>
}
```

- [x] **Step 1: Write direct application tests**

Cover:

- reserved `LOOM_` base key returns `reserved_builtin_key`.
- setting an override for a missing base key returns `not_found`.
- setting an override with the wrong primitive type returns `override_type_mismatch`.
- matrix returns `builtinKeys`, `userKeys`, `snapshot`, and resolution diagnostics without HTTP/Hono.

- [x] **Step 2: Implement `VarsApplication`**

Move the agent-aware orchestration currently in the route into the application module:

- resolve preview and turn resolution diagnostics into `resolution_failed`.
- build matrix from `readAgentAwareVarsWithDiagnostics()`, `resolveAgentAwareVars()`, and `builtinForAgent()`.
- enforce `LOOM_` reserved base key rule.
- validate base definitions before writing.
- map delete/rename result statuses to existing error codes.
- validate override value type against the base definition.
- write overrides through `writeAgentAwareOverride()`.

- [x] **Step 3: Verify direct application tests**

Run:

```bash
bun run test packages/server/test/vars/application.test.ts
```

Expected: PASS.

### Task 2: Rewire Route to Application Module

**Files:**

- Modify: `packages/server/src/api/routes/vars.ts`

**Interfaces:**

- Consumes: `VarsApplication` from `packages/server/src/vars/application.ts`.
- Produces: unchanged HTTP JSON and error responses.

- [x] **Step 1: Convert application errors to existing route errors**

Teach `errorResponse()` to treat `VarsApplicationError` like `ApiError` by preserving status, code, message, diagnostics, and details.

- [x] **Step 2: Replace agent-aware route bodies with application calls**

Update these endpoints only:

- `GET /vars/preview`
- `GET /vars/matrix`
- `PUT /vars/base-key`
- `DELETE /vars/base-key`
- `POST /vars/base-key/rename`
- `PUT /vars/override`
- `DELETE /vars/override`

Keep legacy environment endpoints and mutation endpoints unchanged in this task.

- [x] **Step 3: Remove route-local domain helpers that become unused**

Remove `assertOverrideMatchesDefinition()` and direct imports of agent-aware write/read helpers from the route when the application module owns them.

### Task 3: Verification

**Files:**

- No new production files beyond Task 1 and Task 2.

- [x] **Step 1: Run focused server tests**

Run:

```bash
bun run test packages/server/test/vars/application.test.ts packages/server/test/api/vars-routes.test.ts packages/server/test/projection/scan.test.ts packages/server/test/api/local-skill-status.test.ts
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

- [x] **Step 3: Stop for approval**

Do not stage, commit, push, create a branch, or start a third architecture round without explicit user approval.

## Self-Review

- Spec coverage: covers the approved `.cache` compatibility fix plus the next larger Vars application module refactor without altering public HTTP contract.
- Placeholder scan: no `TBD`, `TODO`, `implement later`, or vague test instructions remain.
- Type consistency: the new application module owns agent-aware Vars commands; route remains the HTTP adapter and repo access seam.
