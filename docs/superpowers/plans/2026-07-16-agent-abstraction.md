# Agent Catalog 全栈抽象实施计划

> **For agentic workers:** 按任务顺序执行，使用 checkbox（`- [ ]`）跟踪。每个任务先补失败测试，再实现，再跑该任务的 focused tests。Web 任务开始前遵循仓库要求使用 `frontend-design`；最终验证使用命名的 `playwright-cli` session。

**Goal:** 将 Loom 的内置 agent 声明收敛到 `packages/core` 的单一 Agent Catalog，使新增普通 agent 时只修改一个 Catalog definition 和可选 SVG，同时让 `config.agents` 在 Settings、Skills、MCP、Memory、Vars、projection 和 preview 中保持一致的全局可见性契约。

**Design:** [Agent 抽象设计](../specs/2026-07-16-agent-abstraction-design.md)

**Architecture:** Core 提供纯 TypeScript、零 IO 的 Catalog、派生类型/schema、capability 查询、path specs 和纯 MCP codecs。Server 解释 path/command/codec 声明并保留 IO、日志、rollback 和 ownership 责任。Web 从 Catalog 派生 display metadata、路径文案和图标，只让 Settings 展示 Registered agents；其他页面只消费 Configured/Applicable agents。

**Tech Stack:** TypeScript 5.9, Zod, smol-toml, Hono, React 18, Vite, Vitest, Testing Library, Playwright CLI

## Global Constraints

- 不引入运行时 agent 插件、用户 YAML/JSON agent 定义、代码生成或 agent-specific 页面注册表。
- Catalog 不依赖 React、Node filesystem、`process`、network 或任意 IO callback。
- 保留公共类型名 `AgentId`、现有三个 ids、规范顺序、路径、环境变量覆盖、品牌信息、manifest wire format 和 YAML 内容。
- `config.agents` 缺失和 `[]` 都是合法空集合；运行时不得回退 Catalog 全集、首项、Codex 或 Claude Code。
- Settings 是唯一的 Configured agents 编辑入口，并始终展示全部 Registered agents。Skills、MCP、Memory 和 Vars 不新增/移除 Configured agents。
- 从 Configured agents 移除 agent 只隐藏其 agent UI 和 projection eligibility；保留 per-item agents、Memory assignments、agent vars 和其他 desired state。
- Skills/MCP cleanup 只删除现有 ownership 规则能证明为 managed 的 artifacts。Memory 本轮不做 unprojection，不删除既有 agent-native memory 文件。
- Production projection dependencies 仍为所有具备 MCP capability 的 Registered agents 建 adapter，确保 agent 从配置移除后仍能清理 managed MCP entries。
- 所有新增 catch、错误分支和降级记录完整 error 对象与 agent/path context，不只记录 `err.message`。
- 不提交、不 push、不创建/切换分支，除非用户另行审批。

## Dependency Order

```text
Catalog -> manifest/planner -> codecs -> server interpreters -> MCP adapter/import
        -> Web metadata -> feature page scopes -> rules/browser verification
```

---

### Task 1: Establish the Core Agent Catalog

**Files:**

- Create: `packages/core/src/agents.ts`
- Create: `packages/core/test/agents.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/manifest.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/types.test.ts`

**Interface:**

```ts
export type AgentCapability = 'skills' | 'mcp' | 'memory' | 'vars'
export type AgentPathRoot = 'home' | 'xdg-config' | 'config'

export const AGENTS = defineAgentCatalog([... ] as const)
export const AGENT_IDS = AGENTS.map(({ id }) => id)
export type AgentId = (typeof AGENTS)[number]['id']
export const AgentIdSchema = z.enum(/* derived non-empty tuple */)

export function getAgent(id: AgentId): AgentDefinition
export function configuredAgents(agents: readonly AgentId[] | undefined): AgentId[]
export function applicableAgents(
  agents: readonly AgentId[] | undefined,
  capability: AgentCapability,
): AgentId[]
```

- [ ] **Step 1: Write failing Catalog contract tests**

Cover:

- current ids and order are `claude-code`, `codex`, `opencode`;
- `AgentId` and `AgentIdSchema` derive from the same definitions;
- lookup and capability filtering use Catalog order and deduplicate input;
- missing/empty Configured agents return `[]`;
- a test-only fourth agent proves helpers do not assume three ids;
- duplicate id/short/import suffix, invalid path segment, missing capability fields and invalid ids fail at Catalog construction;
- every production agent preserves its current command, config dir, skills, memory, MCP path/root key/codec/suffix and display metadata.

Run:

```bash
bun run test packages/core/test/agents.test.ts packages/core/test/types.test.ts
```

Expected before implementation: FAIL because `agents.ts` and the derived exports do not exist.

- [ ] **Step 2: Implement an immutable, IO-free Catalog**

Keep declarations data-only. `display.icon` must be an `asset` or `text` discriminated union. Paths contain only root + segments; environment overrides live only on `configDir`. Define the MCP codec id union at the Catalog boundary, but do not import a codec implementation into the Catalog.

- [ ] **Step 3: Derive the existing public type and schema**

Remove the literal `AgentId` union from `types.ts` and the literal Zod enum from `manifest.ts`. Re-export the derived symbols through `packages/core/src/index.ts` without requiring downstream import-path changes.

- [ ] **Step 4: Re-run the focused tests**

```bash
bun run test packages/core/test/agents.test.ts packages/core/test/types.test.ts
```

Expected: PASS.

### Task 2: Make Manifest Validation and Projection Capability-Aware

**Files:**

- Modify: `packages/core/src/manifest.ts`
- Modify: `packages/core/src/projection.ts`
- Modify: `packages/core/test/manifest.test.ts`
- Modify: `packages/core/test/projection.test.ts`
- Modify: `packages/core/test/projection-memory.test.ts`

- [ ] **Step 1: Add failing validation tests**

Assert diagnostics identify exact fields for:

- unknown `config.agents[index]` in effective config, including a local override;
- unknown or capability-incompatible local skill agent;
- unknown or capability-incompatible source member agent;
- unknown or capability-incompatible MCP agent;
- a Registered but currently unconfigured per-item agent remaining valid and unchanged.

Use a test Catalog with a fourth partial-capability agent. Do not add Hermes/Pi to the production Catalog just to test extensibility.

- [ ] **Step 2: Validate effective config and explicit per-item capabilities**

Make `buildManifest()` validate the effective merged config as well as repo desired state. Keep global capability mismatch non-errors: Configured agents are allowed to support only a subset of features. Explicit item mismatch is an error and must block projection before IO.

- [ ] **Step 3: Add failing planner tests**

Cover:

- `config.agents` missing/empty produces no desired links, MCP entries or memory agents;
- Skills/MCP/Memory each use the capability intersection;
- hidden per-item agents remain in the input manifest but not in the plan;
- partial-capability agents never reach an unsupported projection phase;
- empty agent planning remains a valid plan, not an exception.

- [ ] **Step 4: Route planner selection through Catalog helpers**

Replace the local global-agent intersection with a capability-aware helper. Preserve installed-agent filtering, `skippedAgents`, stable order and manifest immutability.

- [ ] **Step 5: Verify Core behavior**

```bash
bun run test packages/core/test/agents.test.ts packages/core/test/manifest.test.ts packages/core/test/projection.test.ts packages/core/test/projection-memory.test.ts
```

Expected: PASS.

### Task 3: Add Shared Pure MCP Codecs

**Files:**

- Create: `packages/core/src/mcp-codecs.ts`
- Create: `packages/core/test/mcp-codecs.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json`
- Modify: `bun.lock`

**Interface:**

```ts
export interface McpCodec {
  readonly id: McpCodecId
  readonly language: 'json' | 'toml'
  parse(source: string): unknown
  readEntries(document: unknown, rootKey: string): Record<string, unknown>
  writeEntries(document: unknown, rootKey: string, entries: Record<string, unknown>): unknown
  serialize(document: unknown): string
  preview(rootKey: string, id: string, entry: Record<string, unknown>): string
}
```

- [ ] **Step 1: Freeze JSON/TOML compatibility with failing contract tests**

Run the same contract against `json-object` and `toml-table`:

- parse native document;
- read only the configured root key;
- replace MCP entries while preserving unrelated top-level content;
- serialize and parse again without losing unrelated content;
- render a one-entry preview with the same native root/container semantics;
- omit Loom-only `agents` from native entries;
- preserve existing stdio/remote field behavior and current preview output.

- [ ] **Step 2: Move the pure TOML dependency to Core ownership**

```bash
bun --cwd packages/core add smol-toml@^1.7.0
```

This parser is pure data conversion; no filesystem/process behavior enters Core.

- [ ] **Step 3: Implement the codec registry**

The registry is keyed by the Catalog codec id union. Add a contract assertion that every codec referenced by a production agent resolves, while codecs themselves remain agent-agnostic.

- [ ] **Step 4: Verify codec contracts**

```bash
bun run test packages/core/test/mcp-codecs.test.ts packages/core/test/agents.test.ts
```

Expected: PASS.

### Task 4: Replace Agent-Specific Paths with a Contextual Resolver

**Files:**

- Modify: `packages/server/src/adapters/paths.ts`
- Modify: `packages/server/src/projection/deps.ts`
- Modify: `packages/server/src/projection/executor.ts`
- Modify: `packages/server/src/vars/agent-aware.ts`
- Modify: `packages/server/test/adapters/paths.test.ts`
- Modify: `packages/server/test/projection/executor.test.ts`
- Modify: `packages/server/test/projection/executor-memory.test.ts`
- Modify: `packages/server/test/api/vars-routes.test.ts`

**Interface:**

```ts
export interface AgentPathContext {
  home: string
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
}

export function resolveAgentConfigDir(agent: AgentId, context: AgentPathContext): string
export function resolveAgentPath(
  agent: AgentId,
  capability: 'skills' | 'mcp' | 'memory',
  context: AgentPathContext,
): string
```

- [ ] **Step 1: Rewrite path tests as parameterized Catalog golden tests**

Test injected home/env/platform, every environment override, `home`, `xdg-config`, `config`, and all three current output paths. Tests must not depend on the test runner's actual `HOME` or `process.env`.

- [ ] **Step 2: Implement one path interpreter**

Resolve config dir first, then capability paths. Reject calls for unsupported capabilities instead of inventing a fallback. Keep path primitives small; do not put callbacks into definitions.

- [ ] **Step 3: Thread the resolver through projection dependencies**

Executor uses dependency-provided paths for Skills and Memory. MCP will use adapter-owned resolved paths in Task 6. Cleanup loops must filter installed agents by capability before asking for a path.

- [ ] **Step 4: Derive agent-aware builtin paths from Catalog**

`LOOM_CONFIG_DIR`, `LOOM_SKILLS_DIR` and `LOOM_AGENT_FILE` use the same resolver/definition as projection. Remove the Claude-specific filename branch from vars and executor.

- [ ] **Step 5: Verify path and projection compatibility**

```bash
bun run test packages/server/test/adapters/paths.test.ts packages/server/test/projection/executor.test.ts packages/server/test/projection/executor-memory.test.ts packages/server/test/api/vars-routes.test.ts
```

Expected: PASS.

### Task 5: Derive Install Detection and Initial Config from Catalog

**Files:**

- Modify: `packages/server/src/ports/process.ts`
- Modify: `packages/server/src/platform/node/proc.ts`
- Modify: `packages/server/src/projection/workflow.ts`
- Modify: `packages/server/src/platform/node/init.ts`
- Create: `packages/server/test/platform/node/proc.test.ts`
- Modify: `packages/server/test/projection/scan.test.ts`
- Modify: `packages/server/test/platform/node/init.test.ts`

- [ ] **Step 1: Add failing command-oriented process tests**

Prove the Node adapter receives executable commands, including a test-only fourth command, and contains no agent-id map. Test workflow error handling still logs the full error + agent and applies the existing “assume installed” fallback.

- [ ] **Step 2: Change `IProcess` to command detection**

Rename the port method to `isCommandInstalled(command)` (or an equally explicit name). Workflow iterates Registered agent definitions and passes `definition.command`; it must not recreate `DEFAULT_AGENTS`.

- [ ] **Step 3: Generate new-repo `config.agents` from `AGENT_IDS`**

Keep initialization explicit: a newly initialized repo writes all agents registered at that build time. Existing repos remain untouched, so later Catalog additions do not auto-enable themselves.

- [ ] **Step 4: Verify workflow and initialization**

```bash
bun run test packages/server/test/platform/node/proc.test.ts packages/server/test/projection/scan.test.ts packages/server/test/platform/node/init.test.ts
```

Expected: PASS.

### Task 6: Consolidate MCP Projection into One Generic Adapter

**Files:**

- Create: `packages/server/src/adapters/mcp.ts`
- Create: `packages/server/test/adapters/mcp.test.ts`
- Modify: `packages/server/src/ports/adapter.ts`
- Modify: `packages/server/src/projection/deps.ts`
- Modify: `packages/server/src/projection/executor.ts`
- Modify: `packages/server/test/projection/executor.test.ts`
- Delete: `packages/server/src/adapters/claude-code.ts`
- Delete: `packages/server/src/adapters/codex.ts`
- Delete: `packages/server/src/adapters/opencode.ts`
- Delete: `packages/server/src/adapters/types.ts`
- Delete: `packages/server/test/adapters/claude-code.test.ts`
- Delete: `packages/server/test/adapters/codex.test.ts`
- Delete: `packages/server/test/adapters/opencode.test.ts`

- [ ] **Step 1: Add a parameterized generic-adapter test suite**

For every MCP-capable Catalog agent, verify missing-file read, native parse, merged write, unrelated document preservation, parent creation and exact resolved path. Retain a separately injected failure adapter test for executor rollback.

- [ ] **Step 2: Keep `IAgentAdapter` as the IO seam**

The production implementation receives agent definition, resolved file path and codec. Give the adapter an explicit `path` so executor backup/undo and adapter IO cannot resolve different files.

- [ ] **Step 3: Build adapter dependencies from Catalog**

`createProjectionDeps()` iterates all Registered MCP-capable definitions, not current Configured agents. This is required so an empty/subset config can remove previously managed MCP ids without touching user-owned entries.

- [ ] **Step 4: Preserve rollback and ownership state**

Keep `projected-mcp.json`, `mergeMcp`, journal backups, managed-id updates and failure logging behavior unchanged. An empty fragment set must still remove managed entries when managed ids exist.

- [ ] **Step 5: Verify adapter and executor behavior**

```bash
bun run test packages/server/test/adapters/mcp.test.ts packages/server/test/projection/mcp-merge.test.ts packages/server/test/projection/executor.test.ts
```

Expected: PASS.

### Task 7: Make MCP Import Catalog- and Config-Driven

**Files:**

- Modify: `packages/server/src/mcp/importer.ts`
- Modify: `packages/server/src/api/routes/mcp-import.ts`
- Modify: `packages/server/src/api/repo-config.ts` only if a focused effective-config loader is needed
- Modify: `packages/server/test/mcp/importer.test.ts`
- Modify: `packages/server/test/api/mcp-import-routes.test.ts`
- Modify: `packages/server/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add failing source-scope tests**

Cover all three distinct calls:

| Request shape     | Expected sources                                    |
| ----------------- | --------------------------------------------------- |
| `sources` omitted | current Applicable MCP agents from effective config |
| `sources: []`     | zero sources, zero native reads                     |
| explicit subset   | that canonical subset only                          |

Also prove apply uses the same source set as scan, stale preview protection remains, and hidden/unconfigured agents are not imported.

- [ ] **Step 2: Remove importer-owned agent facts**

Delete local `AGENTS`, suffix map and agent-specific JSON/TOML branches. Resolve source order, import suffix, native path, codec and root key from the Catalog. Keep importer-owned validation, ignored-field diagnostics, conflict grouping and desired-state writes.

- [ ] **Step 3: Move omitted-source defaulting to the application/route boundary**

The importer receives an explicit source array and never interprets empty as all. The route loads effective config only when the client omits `sources`; it must preserve the distinction between omitted and explicit empty.

- [ ] **Step 4: Remove Server's direct TOML dependency after all imports migrate**

```bash
bun --cwd packages/server remove smol-toml
```

Do this only after production Server code and Server tests no longer import the parser directly.

- [ ] **Step 5: Verify import behavior**

```bash
bun run test packages/server/test/mcp/importer.test.ts packages/server/test/api/mcp-import-routes.test.ts
```

Expected: PASS.

### Task 8: Remove the Codex Sentinel from Vars Mutations

**Files:**

- Modify: `packages/server/src/vars/application.ts`
- Modify: `packages/server/src/vars/agent-aware.ts`
- Modify: `packages/server/test/vars/application.test.ts`
- Modify: `packages/server/test/api/vars-routes.test.ts`

- [ ] **Step 1: Add failing default-context mutation tests**

Create different Codex agent overrides, then prove base/local set/clear validation reads the explicit Default snapshot and cannot be influenced by Codex. Cover an empty Configured agents repo; non-agent Vars operations must still work.

- [ ] **Step 2: Introduce an explicit default/no-agent read path**

Use the existing Default layer semantics (Base -> Local) or a discriminated mutation context. Delete every `'codex'` argument used only to satisfy an agent-shaped API. Agent-specific commands continue requiring a real `AgentId`.

- [ ] **Step 3: Verify Vars application behavior**

```bash
bun run test packages/server/test/vars/application.test.ts packages/server/test/api/vars-routes.test.ts
```

Expected: PASS.

### Task 9: Derive Web Metadata, Paths, Icons and Settings from Catalog

**Files:**

- Create: `packages/web/src/lib/agent-icons.ts`
- Create: `packages/web/test/agent-catalog.test.tsx`
- Modify: `packages/web/src/lib/agents.ts`
- Modify: `packages/web/src/components/ui/AgentChip.tsx`
- Modify: `packages/web/src/components/ConfigField.tsx`
- Modify: `packages/web/src/styles/shared/agent-chips.css`
- Modify: `packages/web/src/styles/global/tokens.css`
- Modify: `packages/web/src/views/mcp/McpWorkbench.module.css`
- Modify: `packages/web/src/views/skills/SkillSourceList.module.css`
- Modify: `packages/web/src/views/vars/VarsProfileDemo.module.css`
- Modify: `packages/web/test/agent-chip.test.tsx`
- Modify: `packages/web/test/settings.test.tsx`
- Modify: `packages/web/test/css-architecture.test.ts`

- [ ] **Step 1: Add failing Catalog-to-Web contract tests**

Iterate all Registered agents and verify name, short name, color, fallback paths, asset/text icon rendering, accessible name, tooltip, on/off/mixed states and count. Add a text-icon test fixture. Verify every production `asset` key resolves to an SVG URL.

- [ ] **Step 2: Turn `agents.ts` into a derived Web adapter**

It may retain compatibility exports for existing call sites, but contains no literal id list or metadata map. All lists/maps/functions derive from `AGENTS`/`AGENT_IDS`. Web path text formats Catalog fallbacks only and never reads server environment variables.

- [ ] **Step 3: Implement the asset resolver**

Use Vite's static asset graph (for example `import.meta.glob`) or an equivalent exhaustive resolver. `AgentChip` sets generic `--agent-icon`; CSS must contain no `[data-agent='...']` selector. Missing asset references fail tests rather than rendering an empty icon.

- [ ] **Step 4: Keep color ownership in the Catalog**

Pass Catalog color through `--c`. Rename any existing `--cc`/`--cx`/`--oc` uses that are actually transport/group/demo semantic colors, preserving their visual values, then remove agent-named color tokens as a second metadata source.

- [ ] **Step 5: Keep Settings on Registered agents**

Settings agent chips iterate all `AGENT_IDS`, including when effective `config.agents` is empty. Writes remain canonical Catalog order and continue refreshing the shared manifest.

- [ ] **Step 6: Verify Web primitives**

```bash
bun run test packages/web/test/agent-catalog.test.tsx packages/web/test/agent-chip.test.tsx packages/web/test/settings.test.tsx packages/web/test/css-architecture.test.ts
```

Expected: PASS.

### Task 10: Apply Configured/Applicable Scope to Skills and Memory

**Files:**

- Modify: `packages/web/src/views/skills/Skills.tsx`
- Modify: `packages/web/src/views/skills/GlobalAgentsBar.tsx`
- Modify: `packages/web/src/views/skills/SkillSourceList.tsx`
- Modify: `packages/web/src/views/skills/SkillDetailEditor.tsx`
- Modify: `packages/web/src/views/skills/types.ts`
- Modify: `packages/web/src/views/Memory.tsx`
- Modify: `packages/web/src/components/MemoryEditor.tsx`
- Modify: `packages/web/src/hooks/useManifestOperations.ts` to separate Memory assignment from Configured-agent mutation
- Modify: `packages/web/test/views.test.tsx`
- Modify: `packages/web/test/memory-editor.test.tsx`
- Modify: `packages/web/test/manifest-operations.test.tsx`

- [ ] **Step 1: Add failing Skills scope tests**

With config `[claude-code, opencode]`, every global/source/item/detail control shows only applicable CC/OC. A saved Codex selection remains in mocked manifest data, stays hidden, is not removed by CC/OC operations, and reappears selected after Codex is restored. With `[]`, skill content/source management remains available and no agent controls render.

- [ ] **Step 2: Pass one Applicable Skills collection through the component tree**

Do not let `SkillDetailEditor` or a nested component rediscover Registered agents. Bulk state/counts operate only on visible applicable items/agents while mutation helpers preserve hidden agent ids.

- [ ] **Step 3: Scope Memory assignment editing to Applicable agents**

Remove the page action that writes `config.agents`; Settings remains the only place to change that set. Keep per-memory assignment controls for Applicable Memory agents, preserve hidden assignments, and auto-project after a successful assignment update. When Applicable agents are empty, hide the agent region entirely.

- [ ] **Step 4: Make Memory preview agent nullable**

Use `AgentId | null`. If the selected agent disappears, choose the first remaining applicable agent or `null`. With `null`, do not request an agent matrix or memory preview, and do not show the agent-resolved tab/control. Editing, activation, ordering, save and explicit Project remain available.

- [ ] **Step 5: Replace conflicting tests**

Cover Memory assignment updates, immediate projection reconciliation, Applicable-agent filtering, hidden assignment preservation, and the empty state. Keep skill agent mutation auto-reconcile tests because per-item agents are still edited on Skills.

- [ ] **Step 6: Verify Skills and Memory**

```bash
bun run test packages/web/test/views.test.tsx packages/web/test/memory-editor.test.tsx packages/web/test/manifest-operations.test.tsx
```

Expected: PASS.

### Task 11: Apply Configured/Applicable Scope and Shared Codecs to MCP Web

**Files:**

- Modify: `packages/web/src/views/Mcp.tsx`
- Modify: `packages/web/src/views/mcp/McpImportDialog.tsx`
- Modify: `packages/web/src/views/mcp/mcp-preview.ts`
- Modify: `packages/web/src/views/mcp/useMcpPreviewVars.ts`
- Modify: `packages/web/src/lib/api.ts` only if source/context types need narrowing
- Modify: `packages/web/src/hooks/useManifestOperations.ts`
- Modify: `packages/web/test/mcp-preview.test.ts`
- Modify: `packages/web/test/mcp-view.test.tsx`

- [ ] **Step 1: Replace the current all-agent test with subset/empty tests**

Remove the expectation that MCP agent controls ignore global config. Cover:

- configured CC/OC shows only CC/OC row chips, Apply all, preview tabs and import sources;
- saved Codex agents remain untouched and reappear when reconfigured;
- empty config keeps server CRUD, RAW, Default and Default Tools context;
- empty config has no agent preview tabs, agent chips or agent-specific debug context;
- only the Default vars matrix is requested when empty.

- [ ] **Step 2: Remove all agent fallback state**

`PreviewAgentSwitch` maps exactly the supplied applicable agents. Model preview as `'raw' | 'default' | AgentId`; any selected agent removed from config transitions to `default`. Helpers that only resolve variables accept Default explicitly or no agent, not a fake Codex/OpenCode parameter.

- [ ] **Step 3: Build native preview from Catalog + shared codec**

Select definition, root key, path label, language and `preview()` through the Catalog/codec. Delete agent-id formatting branches and the Web TOML formatter. Keep variable resolution and diagnostics in Web, then pass the resolved native entry to the codec.

- [ ] **Step 4: Scope import to Applicable MCP agents**

Pass the current source array into the dialog for both scan and apply. Explicit empty remains `[]`; do not omit it. Render a stable zero-source empty state without native reads or fallback pills.

- [ ] **Step 5: Preserve MCP desired-state semantics**

Create still saves `agents: []`; edit preserves all saved agents including hidden ones; visible agent toggles do not project; Project changes remains explicit.

- [ ] **Step 6: Verify MCP Web behavior**

```bash
bun run test packages/web/test/mcp-preview.test.ts packages/web/test/mcp-view.test.tsx packages/web/test/manifest-operations.test.tsx
```

Expected: PASS.

### Task 12: Give Vars an Explicit Default Context and Configured Agent Matrices

**Files:**

- Modify: `packages/web/src/views/vars/useProfileVars.ts`
- Modify: `packages/web/src/views/vars/profile-model.ts`
- Modify: `packages/web/src/views/vars/Vars.tsx`
- Modify: `packages/web/src/views/vars/VarsConfigModal.tsx`
- Modify: `packages/web/src/views/vars/VarsProfileTable.tsx` only if slot input must be explicit
- Modify: `packages/web/test/vars-view.test.tsx`
- Modify: `packages/web/test/vars-profile-model.test.ts`

- [ ] **Step 1: Add failing request-scope tests**

Replace `loads all agent matrices through the profile vars hook` with:

- Default + configured subset are the only matrix requests;
- empty config requests Default only;
- no agent chips/slots/modal options render when empty;
- Base and Local Default values remain editable and resolvable;
- removing/readding a agent hides then restores its already-saved agent slots.

- [ ] **Step 2: Separate Default matrix from agent matrices**

Use `defaultMatrix` plus `Partial<Record<AgentId, VarsMatrixResponse>>`. `activeAgent` is nullable; `viewScope` remains explicit `'default' | AgentId`. Delete `defaultAgent` and every `agents[0] ?? 'codex'` path.

- [ ] **Step 3: Parameterize the profile model by Configured agents**

Slot aggregation iterates only the supplied Configured agents and tolerates absent matrices. It never imports or recreates an all-agent list. Hidden files remain server-side desired state and become visible after reconfiguration.

- [ ] **Step 4: Scope modal choices**

Vars configuration choices are `Default + Configured agents`. Empty config still supports Default local/base operations without manufacturing an agent selection.

- [ ] **Step 5: Verify Vars Web behavior**

```bash
bun run test packages/web/test/vars-profile-model.test.ts packages/web/test/vars-view.test.tsx packages/web/test/vars-editors.test.tsx
```

Expected: PASS.

### Task 13: Update Rules, Audit Boundaries and Verify End-to-End

**Files:**

- Modify: `docs/rules/cross-cutting.md`
- Modify: `docs/rules/skills.md`
- Modify: `docs/rules/mcp.md`
- Modify: `docs/rules/memory.md`
- Modify: `docs/rules/vars.md`
- Modify: `docs/rules/projection.md`
- Verify: `CONTEXT.md`

- [ ] **Step 1: Update rules to current product facts**

Record Registered / Configured / Applicable agent semantics once in cross-cutting rules, then update feature implications:

- remove product-agent fallback from R-CROSS-001;
- separate Memory assignment mutation from Configured-agent mutation in R-CROSS-002 and R-MEMORY-003;
- make Skills controls use Applicable agents;
- make MCP preview/import enumerate Applicable agents and distinguish omitted/empty sources;
- make Vars Default context independent from a real agent;
- make projection empty-set cleanup obey managed ownership and explicitly exclude Memory unprojection.

Keep CC/CX/OC only as examples, not a closed set. Do not rewrite historical specs/plans.

- [ ] **Step 2: Audit production agent facts**

Run focused searches and inspect every result:

```bash
rg -n --glob '!archive/**' --glob '!docs/superpowers/**' "\['claude-code', 'codex', 'opencode'\]|DEFAULT_AGENTS|SOURCE_SUFFIX|return AGENTS|agents\[0\] \?\?|'codex' : command\.agent" packages
rg -n --glob '!archive/**' "case 'claude-code'|case 'codex'|case 'opencode'|data-agent='" packages
rg -n -- "--cc|--cx|--oc" packages/web/src
```

Allowed agent-specific production occurrences are limited to:

- Catalog definitions;
- codec implementation facts keyed by codec id, not agent id;
- SVG asset filenames/import graph;
- user-facing examples/fixtures that do not control behavior.

- [ ] **Step 3: Run all focused contract groups**

```bash
bun run test packages/core/test/agents.test.ts packages/core/test/mcp-codecs.test.ts packages/core/test/manifest.test.ts packages/core/test/projection.test.ts
bun run test packages/server/test/adapters/paths.test.ts packages/server/test/adapters/mcp.test.ts packages/server/test/mcp/importer.test.ts packages/server/test/api/mcp-import-routes.test.ts packages/server/test/projection/executor.test.ts packages/server/test/vars/application.test.ts
bun run test packages/web/test/agent-catalog.test.tsx packages/web/test/settings.test.tsx packages/web/test/mcp-view.test.tsx packages/web/test/memory-editor.test.tsx packages/web/test/vars-view.test.tsx packages/web/test/views.test.tsx
```

- [ ] **Step 4: Run full repository verification**

```bash
bun run test
bun run format:check
git diff --check
```

Expected: all pass. Use `format:check`; do not run a broad formatter that rewrites unrelated user files.

- [ ] **Step 5: Start the app and verify with Playwright CLI**

Start only this worktree's services:

```bash
bun dev
```

Generate one session suffix and reuse the named session, for example `agent-catalog-<8hex>`. Verify desktop and `390x844`:

1. Settings with `config.agents: []` still shows all Registered agents.
2. Skills retains content/source actions and has no agent controls.
3. MCP retains CRUD, RAW, Default and Default Tools; no agent controls/import sources.
4. Memory retains create/edit/activate/order; no agent region or agent preview call.
5. Vars retains Base/Local Default context and requests no agent matrices.
6. Set CC/OC in Settings; all four feature pages show only their applicable CC/OC controls.
7. Remove and re-add one agent; saved MCP/Skill selections, Memory assignment and Vars slots reappear.
8. Agent SVGs, tooltips, counts and narrow layout render without overlap.
9. Browser console has no runtime errors and no failed asset requests.

Store any screenshots/logs under `temp/agent-catalog/`; do not commit them. Stop only the dev server/session started for this task.

## Acceptance Criteria

- `AgentId`, `AgentIdSchema`, order, metadata, commands, path specs, capabilities and MCP format facts all derive from one Core Catalog.
- A test-only fourth agent flows through Core helpers, Server interpreters and Web primitives without adding agent-id branches.
- A real agent reusing existing primitives requires one Catalog definition and an optional SVG; a new native format adds only a codec/contract test plus that definition/asset.
- `config.agents: []` produces no Agent controls or implicit agent-specific API calls on Skills, MCP, Memory or Vars.
- Settings remains usable in the empty state and is the sole Configured agent editor.
- Hidden per-item agent selections, Memory assignments and Vars overrides survive remove/re-add.
- Skills/MCP cleanup preserves user-owned artifacts; Memory does not unproject without a future ownership design.
- Current three agents retain paths, native MCP content/import semantics, projection rollback, icons, accessibility and non-empty configured behavior.
- Full Vitest, Prettier check, `git diff --check` and automated browser verification pass.
