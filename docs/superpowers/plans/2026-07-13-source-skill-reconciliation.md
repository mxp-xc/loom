# Source Skill Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update remote skill content, reconcile added/updated/removed members, let users preserve selected removals as local skills, and automatically project the finalized state.

**Architecture:** Add a server-side reconciliation module that computes content-aware member changes and owns persisted prepare/finalize sessions. Route both remote updates and edited source-member saves through application services that preserve selected removals, persist one coherent `skills.yaml`, and invoke skills projection; the React client presents one reusable reconciliation dialog.

**Tech Stack:** ESM TypeScript, Bun workspace tooling, Hono, React, Radix Dialog, Vitest, Testing Library, Playwright CLI.

## Global Constraints

- Preserve selected removed skills in `assets/skills/<skill-id>` as pathless local skills.
- Preserve each converted skill's previous targets.
- Never overwrite an existing local skill directory or manifest entry.
- Removed skills default to selected for preservation; support select all, clear selection, and a dedicated do-not-preserve action.
- Reconciliation applies to remote updates and saving an edited `scan`/member selection.
- Do not report completion before manifest persistence and skills projection succeed.
- Log complete error objects at every error or fallback boundary.
- Use `bun` for JavaScript/TypeScript commands and Vitest rather than Bun test APIs.
- Do not commit, stage, switch branches, or create worktrees without explicit user approval.

---

### Task 1: Content-aware member change classification

**Files:**

- Create: `packages/server/src/skills/reconciliation.ts`
- Test: `packages/server/test/skills/reconciliation.test.ts`

**Interfaces:**

- Consumes: `IFileSystem`, `SkillMemberOverride`, and scanned members with `name` and source-relative `path`.
- Produces: `SkillMemberChange`, `SkillMemberChangeSet`, and `classifySkillMemberChanges(fs, previousRoot, nextRoot, previousMembers, nextMembers)`.

- [ ] **Step 1: Write failing classification tests**

Create fixtures through the existing server test filesystem helper and assert all four categories:

```ts
it('classifies added, removed, updated, and unchanged source members', async () => {
  const changes = await classifySkillMemberChanges(
    fs,
    oldRoot,
    newRoot,
    [member('removed'), member('changed'), member('stable'), member('moved', 'old/moved/SKILL.md')],
    [member('added'), member('changed'), member('stable'), member('moved', 'new/moved/SKILL.md')],
  )

  expect(changes.added.map(({ name }) => name)).toEqual(['added'])
  expect(changes.removed.map(({ name }) => name)).toEqual(['removed'])
  expect(changes.updated.map(({ name }) => name)).toEqual(['changed', 'moved'])
  expect(changes.unchanged.map(({ name }) => name)).toEqual(['stable'])
})
```

Add a nested-resource test proving that changing a non-`SKILL.md` file marks the member updated, and deterministic sorting assertions for every list.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun run test packages/server/test/skills/reconciliation.test.ts`

Expected: FAIL because `skills/reconciliation.js` and `classifySkillMemberChanges` do not exist.

- [ ] **Step 3: Implement deterministic directory fingerprints and classification**

Define the public types:

```ts
export interface SkillMemberSnapshot {
  name: string
  path: string
  targets?: AgentId[]
}

export interface SkillMemberChange {
  name: string
  previousPath?: string
  nextPath?: string
  targets?: AgentId[]
}

export interface SkillMemberChangeSet {
  added: SkillMemberChange[]
  updated: SkillMemberChange[]
  removed: SkillMemberChange[]
  unchanged: SkillMemberChange[]
}
```

Normalize `path` as a source-relative `SKILL.md` path, reject absolute and `..` paths, recursively enumerate member directory files in lexical order, and hash a stable sequence of relative path plus file content using `node:crypto`. Compare both normalized source-relative paths and fingerprints for same-name members. Keep helpers private unless a test requires a product contract.

- [ ] **Step 4: Run focused tests and format check**

Run: `bun run test packages/server/test/skills/reconciliation.test.ts`

Expected: PASS with added, removed, updated, unchanged, nested file, and sort cases green.

Run: `bun run format:check`

Expected: PASS; if it fails only on touched files, run `bun run format` and repeat the focused test.

- [ ] **Step 5: Review checkpoint**

Inspect `git diff -- packages/server/src/skills/reconciliation.ts packages/server/test/skills/reconciliation.test.ts`. Do not stage or commit without user approval.

---

### Task 2: Prepare and finalize remote update sessions

**Files:**

- Modify: `packages/server/src/remote/update.ts`
- Create: `packages/server/src/skills/update-sessions.ts`
- Modify: `packages/server/src/api/routes/remote.ts`
- Modify: `packages/server/src/api/router.ts`
- Modify: `packages/web/src/lib/api.ts`
- Test: `packages/server/test/remote/update.test.ts`
- Test: `packages/server/test/api/routes-fixes.test.ts`

**Interfaces:**

- Consumes: `classifySkillMemberChanges` from Task 1, existing `IGit`, `IFileSystem`, `scanSourceMembers`, `readYaml`, `writeYaml`, and `projectRepository`.
- Produces: `SourceUpdateSessionStore`, `prepareSourceUpdate(...)`, `finalizeSourceUpdate(...)`, `POST /update/prepare`, and `POST /update/finalize`.

- [ ] **Step 1: Write failing prepare tests**

Extend `remote/update.test.ts` so the old cache contains a removed member with an extra resource file. Assert prepare stages the complete old directory before `resetHard`, scans the new cache, and returns structured changes:

```ts
expect(result).toMatchObject({
  pinned_commit: 'new-commit',
  changes: {
    added: [{ name: 'new-skill' }],
    updated: [{ name: 'changed-skill' }],
    removed: [{ name: 'removed-skill', targets: ['codex'] }],
  },
})
expect(await fs.readFile(join(result.stagingDir, 'removed-skill', 'reference.md'))).toBe('old')
```

Add a repair test proving a missing/corrupt cache still produces a session with no preservable old content rather than silently claiming removed content was staged.

- [ ] **Step 2: Run update tests and verify RED**

Run: `bun run test packages/server/test/remote/update.test.ts`

Expected: FAIL because prepare returns the old `UpdateResult` and does not stage directories or expose changes.

- [ ] **Step 3: Implement the in-memory session store with repository staging**

Create a process-owned store injected through `RouteDeps`:

```ts
export interface SourceUpdateSession {
  id: string
  repoPath: string
  sourceUrl: string
  source: SkillSource
  newRef: string
  pinnedCommit: string
  stagingDir: string
  nextMembers: ScannedMember[]
  changes: SkillMemberChangeSet
  expiresAt: number
}

export class SourceUpdateSessionStore {
  create(input: Omit<SourceUpdateSession, 'id' | 'expiresAt'>): SourceUpdateSession
  get(id: string): SourceUpdateSession | undefined
  delete(id: string): void
  take(id: string): SourceUpdateSession | undefined
  prune(now?: number): Promise<void>
}
```

Use `randomUUID()` for ids and persist session metadata under `temp/source-updates/` in the managed repository. Staged content remains recoverable across server restarts and is removed only after finalize succeeds, because it may be the only copy of a remotely deleted skill.

- [ ] **Step 4: Implement prepare without losing removed content**

Rename the existing operation to `prepareSourceUpdate`. Before fetch/reset, copy each saved old member directory into the session staging root using its saved runtime path. Then update the cache, scan new members, classify against staged old content, create the session, and return only serializable client data:

```ts
export interface PrepareSourceUpdateResult {
  sessionId: string
  pinned_commit: string
  changes: Omit<SkillMemberChangeSet, 'unchanged'>
}
```

Do not persist `pinned_commit` during prepare. On prepare failure, remove the newly created staging directory and log the complete error before rethrowing.

- [ ] **Step 5: Write failing finalize route tests**

In `routes-fixes.test.ts`, cover:

```ts
await request('/update/finalize', {
  sessionId: prepared.id,
  preserve: ['removed-skill'],
})

expect(saved.skills).toContainEqual({ id: 'removed-skill', targets: ['codex'] })
expect(saved.sources[0].members.map(({ name }) => name)).toEqual(['changed-skill', 'new-skill'])
expect(projectRepository).toHaveBeenCalledWith(expect.anything(), repoPath, { scope: 'skills' })
```

Also assert `invalid_update_session`, rejection of a preserve name outside `changes.removed`, collision with existing `assets/skills/<id>`, collision with an existing local manifest id, projection failure response, and automatic finalize behavior when `removed` is empty.

- [ ] **Step 6: Run route tests and verify RED**

Run: `bun run test packages/server/test/api/routes-fixes.test.ts`

Expected: FAIL because `/update/prepare`, `/update/finalize`, and session validation are absent.

- [ ] **Step 7: Implement prepare/finalize routes and coherent persistence**

Replace `/update/perform` with:

```ts
const PrepareUpdateBody = z.object({
  repo: NonEmptyString,
  source: SkillSource,
  newRef: NonEmptyString,
})

const FinalizeUpdateBody = z.object({
  sessionId: NonEmptyString,
  preserve: z.array(NonEmptyString),
})
```

Finalize validates the session and preserve subset before mutation. It preflights every destination collision, copies selected staged directories to `assets/skills/<name>`, builds one next `skills.yaml` value that updates `pinned_commit`, optional ref, complete scanned members, and local entries with previous targets, then writes it once. Invoke `projectRepository(deps, repoPath, { scope: 'skills' })`; return `ok: false` with the projection failure when projection fails. Remove the session staging directory only after successful finalize. Every `catch` logs `{ err, sessionId, source }`.

Register one `SourceUpdateSessionStore` in router composition so prepare and finalize share process state. Update `api.ts` with exact typed methods:

```ts
prepareSourceUpdate(body: PrepareSourceUpdateRequest): Promise<PrepareSourceUpdateResponse>
finalizeSourceUpdate(body: { sessionId: string; preserve: string[] }): Promise<FinalizeSourceUpdateResponse>
```

- [ ] **Step 8: Run server update and route tests**

Run: `bun run test packages/server/test/remote/update.test.ts packages/server/test/api/routes-fixes.test.ts`

Expected: PASS, including staging order, validation, persistence, collision, and projection cases.

- [ ] **Step 9: Review checkpoint**

Inspect the Task 2 diff and confirm `/update/perform` has no remaining callers with `rg -n "performUpdate|update/perform" packages`. Do not stage or commit without user approval.

---

### Task 3: Reconcile edited scan/member selections through the server

**Files:**

- Modify: `packages/server/src/skills/application.ts`
- Modify: `packages/server/src/api/routes/skills-yaml.ts`
- Modify: `packages/web/src/lib/api.ts`
- Test: `packages/server/test/skills/application.test.ts`
- Test: `packages/server/test/api/routes-fixes.test.ts`

**Interfaces:**

- Consumes: Task 1 change types and the preservation/collision helpers established by Task 2.
- Produces: `prepareSourceMemberSave(...)`, `finalizeSourceMemberSave(...)`, `POST /sources/reconcile`, and a session compatible with the same finalize choice shape used by remote updates.

- [ ] **Step 1: Write failing application tests for edited member removal**

Test a source whose selected members change from `['keep', 'removed-a', 'removed-b']` to `['keep', 'added']`. Assert prepare reports added and removed names, then finalize with `preserve: ['removed-a']` copies only `removed-a`, retains its targets, removes `removed-b`, saves source metadata and members, and projects skills.

Add tests for a scan-only change, no removals (immediate finalize), an existing local collision, and preserving a nested skill directory.

- [ ] **Step 2: Run application tests and verify RED**

Run: `bun run test packages/server/test/skills/application.test.ts`

Expected: FAIL because source edits currently call metadata and member endpoints independently and drop omitted members without confirmation.

- [ ] **Step 3: Implement one application-level source edit operation**

Add command and result types:

```ts
export interface ReconcileSourceCommand extends UpdateSourceMetaCommand {
  members: Array<{ name: string; path: string }>
}

export interface PrepareSourceReconciliationResult {
  sessionId?: string
  changes: Pick<SkillMemberChangeSet, 'added' | 'updated' | 'removed'>
  finalized: boolean
}
```

Load the current manifest source, scan or validate the submitted new member paths against the current cache, compute changes, and create a reconciliation session when removals exist. With no removals, persist metadata/member changes and project immediately. Finalize reuses the Task 2 preservation helper, writes source metadata plus members in one manifest write, and projects skills.

- [ ] **Step 4: Add and validate the route contract**

Add `POST /sources/reconcile` accepting `repo`, `url`, optional source metadata, and scanned member `{ name, path }[]`. Use the existing finalize endpoint for its returned session id, or a shared `/sources/reconcile/finalize` only if the session store discriminates operation kinds; keep the client choice payload exactly `{ sessionId, preserve }` in either case.

Reject member paths that are absolute, traverse parents, do not end in `SKILL.md`, or were not present in the current scan result. Log route errors with the complete error and source URL.

- [ ] **Step 5: Update API types and run focused server tests**

Run: `bun run test packages/server/test/skills/application.test.ts packages/server/test/api/routes-fixes.test.ts`

Expected: PASS for remote-update and edited-scan reconciliation through the shared preservation behavior.

- [ ] **Step 6: Review checkpoint**

Inspect the Task 3 diff and verify old multi-request source saving is still available only where needed for source creation, not edit reconciliation. Do not stage or commit without user approval.

---

### Task 4: Reusable reconciliation dialog and hook flow

**Files:**

- Create: `packages/web/src/views/skills/SkillReconciliationDialog.tsx`
- Create: `packages/web/src/views/skills/SkillReconciliationDialog.module.css`
- Modify: `packages/web/src/hooks/useManifestOperations.ts`
- Modify: `packages/web/src/views/skills/SkillSourceList.tsx`
- Modify: `packages/web/src/views/skills/EditSourceModal.tsx`
- Modify: `packages/web/src/views/skills/Skills.tsx`
- Test: `packages/web/test/manifest-operations.test.tsx`
- Test: `packages/web/test/views.test.tsx`

**Interfaces:**

- Consumes: typed prepare/finalize API methods from Tasks 2 and 3 and the existing `Modal` component.
- Produces: `SkillReconciliationState`, `SkillReconciliationDialog`, `prepareSourceUpdate`, `prepareSourceSave`, and `finalizeSourceReconciliation` hook operations.

- [ ] **Step 1: Write failing hook tests for prepare/finalize sequencing**

Replace old `performSourceUpdate` expectations with:

```ts
const prepared = await result.current.prepareSourceUpdate(source, update)
expect(prepared.result).toMatchObject({ sessionId: 'session-1', changes: { removed: [...] } })
expect(refreshManifest).not.toHaveBeenCalled()

await result.current.finalizeSourceReconciliation('session-1', ['removed-a'])
expect(api.finalizeSourceUpdate).toHaveBeenCalledWith({
  sessionId: 'session-1',
  preserve: ['removed-a'],
})
expect(refreshManifest).toHaveBeenCalledWith(repoPath)
```

Add no-removal automatic-finalize, edited-source prepare, finalize failure, double-submit pending guard, and notification summary tests.

- [ ] **Step 2: Run hook tests and verify RED**

Run: `bun run test packages/web/test/manifest-operations.test.tsx`

Expected: FAIL because the hook exposes one-step update/save operations.

- [ ] **Step 3: Implement typed hook operations**

Define UI-facing types:

```ts
export interface SkillReconciliationState {
  sessionId: string
  sourceLabel: string
  changes: {
    added: SkillMemberChange[]
    updated: SkillMemberChange[]
    removed: SkillMemberChange[]
  }
}
```

Prepare operations use `{ reload: false }`. If prepare returns `finalized: true` or no removed items, reload and show the result immediately; otherwise return state without success notification. Finalize reloads only after success and reports counts for added, updated, preserved, and deleted skills.

- [ ] **Step 4: Write failing dialog interaction tests**

Render the dialog with three removed members and assert:

```ts
expect(screen.getAllByRole('checkbox')).toSatisfyAll((box) => box.checked)
await user.click(screen.getByRole('button', { name: '取消全选' }))
expect(screen.getAllByRole('checkbox')).toSatisfyAll((box) => !box.checked)
await user.click(screen.getByRole('button', { name: '全选' }))
await user.click(screen.getByLabelText('保留 removed-b'))
await user.click(screen.getByRole('button', { name: '保留所选并继续' }))
expect(onConfirm).toHaveBeenCalledWith(['removed-a', 'removed-c'])
```

Add assertions for Added and Updated informational sections, the dedicated `不保留` action submitting `[]`, busy state, finalize error remaining open, and keyboard-accessible labels.

- [ ] **Step 5: Run view tests and verify RED**

Run: `bun run test packages/web/test/views.test.tsx`

Expected: FAIL because `SkillReconciliationDialog` does not exist and current update immediately closes.

- [ ] **Step 6: Implement the dialog with existing design primitives**

Use the repository `Modal`, existing button classes, and `lucide-react` icons. Render compact full-width sections rather than nested cards. Removed rows use native checkboxes; initialize selection from all removed names whenever `sessionId` changes. Provide `全选`, `取消全选`, `不保留`, and primary `保留所选并继续` controls. `不保留` sets selection to empty and calls the same explicit finalize callback; it must not silently finalize on selection clear alone.

Keep text within responsive bounds and set stable modal/list dimensions. Use an inline error region with `role="alert"`; log the full caught error object before displaying its normalized message.

- [ ] **Step 7: Wire both entry points to the shared dialog**

Lift reconciliation state to `Skills.tsx` so `SkillSourceList` remote updates and `EditSourceModal` saves share one dialog. Remote update opens it from prepare results. Edited source save closes the edit modal only after either immediate finalize or successful reconciliation finalize; a failed finalize keeps the reconciliation dialog open.

- [ ] **Step 8: Run focused web tests**

Run: `bun run test packages/web/test/manifest-operations.test.tsx packages/web/test/views.test.tsx`

Expected: PASS for update, edited scan, default preservation, select all, clear, do-not-preserve, partial preserve, pending, and error behavior.

- [ ] **Step 9: Review checkpoint**

Inspect all Task 4 diffs, check visible Chinese copy for consistency, and ensure no source-update success toast fires before finalize. Do not stage or commit without user approval.

---

### Task 5: Rules, regression tests, formatting, and browser verification

**Files:**

- Modify: `docs/rules/skills.md`
- Modify only if required by test setup: `packages/web/test/views.test.tsx`
- Create screenshots under: `temp/source-skill-reconciliation/`

**Interfaces:**

- Consumes: completed server and web flows from Tasks 1-4.
- Produces: documented `R-SKILLS-007` contract and end-to-end verification evidence.

- [ ] **Step 1: Add the current product rule**

Append `R-SKILLS-007 Source member 缺失必须确认 reconcile` documenting:

```md
Rule:
远端更新或 source scan/member 选择变化导致已保存 member 缺失时，Loom 必须展示缺失项并让用户决定删除或保留为 local skill。缺失项默认选择保留，保留项复制到 assets/skills/<id> 并继承原 targets。
```

Include implications for added/updated/removed summaries and automatic projection, safety clauses for local collisions and no overwrite, examples for update and edited scan, and exact new test paths.

- [ ] **Step 2: Run the complete test suite**

Run: `bun run test`

Expected: all Vitest projects PASS with no unhandled errors or warnings introduced by this feature.

- [ ] **Step 3: Run formatting verification**

Run: `bun run format:check`

Expected: PASS. If it fails on touched files, run `bun run format`, inspect the resulting diff to ensure unrelated files were not changed, then rerun `bun run test` and `bun run format:check`.

- [ ] **Step 4: Start the development server**

Run: `bun dev`

Expected: API and Vite URLs are printed on automatically selected ports. Keep this session running and record the printed web URL; manage only this process.

- [ ] **Step 5: Verify the UI with Playwright CLI**

Generate a session id once:

```powershell
$suffix = uv run python -c "import uuid; print(uuid.uuid4().hex[:8])"
$session = "skill-reconcile-$suffix"
```

Open the recorded URL with `playwright-cli open -s $session <url>`. Exercise a fixture/source state containing added, updated, and removed members. Verify:

- All three sections render.
- Removed members start selected.
- `取消全选` clears every row and `全选` restores every row.
- Selecting a subset preserves only that subset.
- `不保留` submits deletion for all removed members.
- The dialog has no overlapping or clipped text at desktop and mobile widths.
- The final source/local lists and projected state match the submitted choice.

Save desktop and mobile screenshots under `temp/source-skill-reconciliation/`. Do not ask the user to perform browser verification.

- [ ] **Step 6: Final diff and status audit**

Run: `git status --short` and `git diff --check`.

Expected: only the design, plan, source, test, rule, and intentional temp screenshot files from this feature are present; `git diff --check` is silent. Do not stage or commit without user approval.
