# MCP Application Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第 3 轮 loop：把 MCP YAML mutation use cases 从 `mcp-yaml` Hono route 下沉到 server-side MCP application module，同时保持 HTTP contract 不变。

**Architecture:** `packages/server/src/api/routes/mcp-yaml.ts` 保留 HTTP adapter 责任：request parsing、repo authorization、status code 和 JSON response。`packages/server/src/mcp/application.ts` 成为 MCP module 的主要 interface，封装 `mcp.yaml` load/save、core MCP mutators、update validation 和 not-found mapping。`packages/core` 继续只提供无 IO mutators。

**Tech Stack:** TypeScript 5.9, Bun workspace, Hono, Vitest, `@loom/core` MCP mutators, existing `js-yaml` repo-config helpers.

## Global Constraints

- 对用户可见内容用中文；代码标识符、命令、技术名词保留原文。
- 本轮是用户澄清后的 loop 第 3 轮；第 1、2 轮已完成并验证。
- 不提交、不 push、不创建/切换分支，除非用户明确审批。
- 不新增三方依赖；本轮收益来自 module depth，不来自换包。
- 不改变 MCP HTTP contract；现有 `packages/server/test/api/routes-fixes.test.ts` 必须继续通过。
- `packages/core` 保持无 IO；不改变 core MCP mutator 语义。
- `packages/server/src/api/routes/mcp-yaml.ts` 接收 request 并解析 repo；`McpApplication` 接收已授权 repo path，不自行做 repo authorization。
- 错误路径必须保留完整错误对象日志；不得新增静默 catch。

---

## Third-Party Package Analysis

本轮不新增或替换三方包。

| Package   | Current role                                                        | Decision                                                    |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `hono`    | Route adapter in `packages/server/src/api/routes/mcp-yaml.ts`       | 保留。成熟且已稳定承载 HTTP routing；本轮只让 route 变薄。  |
| `js-yaml` | Indirectly through `readYaml()` / `writeYaml()` in `repo-config.ts` | 保留。已有统一 YAML helper；换包会扩大 serialization 风险。 |

结论：MCP path 的架构收益来自隐藏 YAML persistence 和 validation，不来自三方包替换。

## File Structure

| File                                            | Responsibility                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/server/src/mcp/application.ts`        | Deep module for authorized MCP manifest use cases.                                           |
| `packages/server/src/api/routes/mcp-yaml.ts`    | Thin HTTP adapter around request validation, repo resolution, app calls, and JSON responses. |
| `packages/server/test/mcp/application.test.ts`  | Direct interface tests for add, update validation, remove, targets, and not-found mapping.   |
| `packages/server/test/api/routes-fixes.test.ts` | Existing HTTP contract regression suite.                                                     |

### Task 1: Add McpApplication Interface

**Files:**

- Create: `packages/server/src/mcp/application.ts`
- Create: `packages/server/test/mcp/application.test.ts`

**Interfaces:**

- Consumes: `IFileSystem`, `McpServer`, `AgentId`, core MCP mutators.
- Produces:

```ts
export class McpApplicationError extends Error {
  readonly status: 400 | 404
  readonly code: string
}

export class McpApplication {
  addServer(repoPath: string, server: McpServer): Promise<{ server: McpServer }>
  removeServer(repoPath: string, id: string): Promise<void>
  updateServer(repoPath: string, id: string, server: unknown): Promise<{ server: McpServer }>
  setTargets(repoPath: string, id: string, targets: AgentId[]): Promise<void>
}
```

- [x] **Step 1: Write failing application tests**

Add tests that import `McpApplication` and prove the desired interface:

```ts
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { McpApplication } from '../../src/mcp/application.js'
```

Cover:

- `addServer()` creates `mcp.yaml` when missing.
- `updateServer()` validates transport fields and preserves the route `id`.
- `updateServer()` rejects `stdio` without `command` with `invalid_server`.
- `setTargets()` maps missing server to `not_found`.
- `removeServer()` removes existing entries without failing when absent.

Run:

```bash
bun run test packages/server/test/mcp/application.test.ts
```

Expected before implementation: FAIL because `packages/server/src/mcp/application.ts` does not exist.

- [x] **Step 2: Implement minimal application module**

Create `packages/server/src/mcp/application.ts` with:

- `McpApplicationError` for `invalid_server` and `not_found`.
- Private `mcpYamlPath(repoPath)`, `readServers(repoPath)`, `writeServers(repoPath, servers)` helpers.
- Methods listed in the interface.
- Existing update validation rule:
  - type is `stdio`, `sse`, or `http`
  - `stdio` requires non-empty `command`
  - non-`stdio` requires non-empty `url`
  - persisted server id is always the route `id`

Run:

```bash
bun run test packages/server/test/mcp/application.test.ts
```

Expected after implementation: PASS.

### Task 2: Rewire MCP Route to Application Module

**Files:**

- Modify: `packages/server/src/api/routes/mcp-yaml.ts`

**Interfaces:**

- Consumes: `McpApplication` and `McpApplicationError`.
- Produces: unchanged HTTP JSON and status codes.

- [x] **Step 1: Instantiate the application once per route factory**

At the top of `createMcpYamlRoutes()`:

```ts
const mcp = new McpApplication(deps.fs)
```

- [x] **Step 2: Replace route-local YAML mutation bodies**

Rewrite these handlers to call `McpApplication`:

- `POST /mcp`
- `DELETE /mcp`
- `PUT /mcp`
- `POST /mcp/targets`

Preserve existing success response bodies, invalid request status codes, and `not_found` response behavior.

- [x] **Step 3: Remove route-local implementation imports**

Remove from `mcp-yaml.ts` when unused:

- `join`
- `addMcpServer`
- `removeMcpServer`
- `updateMcpServer`
- `setMcpTargets`
- `readYaml`
- `writeYaml`

### Task 3: Verification

**Files:**

- No additional production files.

- [x] **Step 1: Run focused tests**

Run:

```bash
bun run test packages/server/test/mcp/application.test.ts packages/server/test/api/routes-fixes.test.ts
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

Stop after round 3. Do not stage, commit, push, create a branch, or continue a fourth architecture round without explicit user approval.

Decision: loop 3x is complete. Stop for user approval before any further architecture round or VCS action.

## Self-Review

- Spec coverage: covers loop round 3 with architecture deepening, code simplification, third-party package analysis, plan, execution, and self-test.
- Placeholder scan: no `TBD`, `TODO`, or “implement later” placeholders remain.
- Type consistency: route receives HTTP input and repo resolution; `McpApplication` receives authorized repo paths and owns MCP YAML implementation details.
