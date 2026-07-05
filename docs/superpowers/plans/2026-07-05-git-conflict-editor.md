# Git Conflict Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Loom's YAML-aware sync merge with native Git merge semantics and resolve real Git conflicts through a CodeMirror side-by-side editor.

**Architecture:** `NodeGit` owns native merge/index operations, while `sync/pull.ts` exposes a small conflict-session service over those operations. The web client renders Git's LOCAL and REMOTE stages with `@codemirror/merge`, maintains an editable RESULT, and submits complete resolved file content back to Git.

**Tech Stack:** TypeScript, simple-git, Hono, React 18, CodeMirror 6 (`codemirror`, `@codemirror/merge`, `@codemirror/lang-yaml`), Vitest, Testing Library, playwright-cli.

---

Commit steps are intentionally omitted because repository policy requires separate user authorization for `git commit`.

## File map

- Modify `packages/server/src/ports/git.ts`: native merge/index contract.
- Modify `packages/server/src/platform/node/git.ts`: simple-git implementation.
- Replace `packages/server/src/sync/pull.ts`: Git-backed pull, conflict read/save/abort service.
- Modify `packages/server/src/api/routes/sync.ts`: conflict save and abort endpoints.
- Modify `packages/server/test/sync/pull.test.ts`: real-repository behavior tests.
- Modify `packages/web/src/lib/api.ts`: typed sync API.
- Create `packages/web/src/views/sync/conflict-markers.ts`: parse and resolve standard Git conflict marker blocks; no diff implementation.
- Create `packages/web/src/views/sync/ConflictEditor.tsx`: CodeMirror lifecycle and conflict UI.
- Modify `packages/web/src/views/Sync.tsx`: use the new conflict session UI.
- Create `packages/web/test/conflict-markers.test.ts`: marker behavior tests.
- Modify `packages/web/test/views.test.tsx`: sync view workflow tests.
- Modify `packages/web/package.json` and `bun.lock`: CodeMirror dependencies.

### Task 1: Native Git merge/index adapter

**Files:**

- Modify: `packages/server/src/ports/git.ts`
- Modify: `packages/server/src/platform/node/git.ts`
- Test: `packages/server/test/sync/pull.test.ts`

- [ ] **Step 1: Write a failing real-repository test**

Add a test that calls `syncPull` with two edits to the same line and expects Git's worktree markers and three index stages:

```ts
it('keeps native Git conflict state for competing line edits', async () => {
  const repo = await setupRepo('value: base\n', 'value: local\n', 'value: remote\n')
  const result = await syncPull(repo, new NodeGit(), new NodeFileSystem())

  expect(result.clean).toBe(false)
  expect(result.conflicts).toHaveLength(1)
  expect(result.conflicts[0]).toMatchObject({
    path: 'skills.yaml',
    base: 'value: base',
    ours: 'value: local',
    theirs: 'value: remote',
  })
  expect(result.conflicts[0].result).toContain('<<<<<<< HEAD')
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bunx vitest run packages/server/test/sync/pull.test.ts -t "keeps native Git conflict"`

Expected: FAIL because `PullResult` has no `conflicts` and the current merge does not leave Git conflict state.

- [ ] **Step 3: Extend the Git port**

Add these exact operations to `IGit`:

```ts
merge(repoPath: string, ref: string): Promise<{ clean: boolean }>
unmergedPaths(repoPath: string): Promise<string[]>
showIndexStage(repoPath: string, stage: 1 | 2 | 3, path: string): Promise<string | null>
abortMerge(repoPath: string): Promise<void>
```

Implement them through `simpleGit(...).raw(...)`. `merge` runs `git merge --no-edit FETCH_HEAD`; on failure it returns `{ clean: false }` only when `unmergedPaths()` is non-empty, otherwise it rethrows the complete error. `showIndexStage` returns `null` only when that stage is absent. `abortMerge` runs `git merge --abort`.

- [ ] **Step 4: Run adapter-focused tests**

Run: `bunx vitest run packages/server/test/sync/pull.test.ts -t "native Git conflict"`

Expected: the test still fails at the service response, but the repository contains unmerged paths and stages.

### Task 2: Git-backed conflict session service

**Files:**

- Replace: `packages/server/src/sync/pull.ts`
- Modify: `packages/server/test/sync/pull.test.ts`

- [ ] **Step 1: Add failing tests for the service contract**

Cover these behaviors with real repositories:

```ts
expect((await syncPull(cleanRepo, git, fs)).clean).toBe(true)

const conflicted = await syncPull(conflictRepo, git, fs)
expect(conflicted.conflicts[0]).toEqual(
  expect.objectContaining({
    path: 'skills.yaml',
    base: expect.any(String),
    ours: expect.any(String),
    theirs: expect.any(String),
    result: expect.stringContaining('<<<<<<<'),
  }),
)

await expect(saveConflict(conflictRepo, git, fs, 'skills.yaml', '<<<<<<< HEAD\n')).rejects.toThrow(
  '仍包含未解决的冲突标记',
)

const saved = await saveConflict(conflictRepo, git, fs, 'skills.yaml', 'value: chosen\n')
expect(saved).toEqual({ clean: true, remaining: [] })

await abortConflictMerge(otherConflictRepo, git)
expect(await readFile(join(otherConflictRepo, 'skills.yaml'), 'utf8')).toBe('value: local\n')
```

Also assert the resolved commit has exactly two parents with `git rev-list --parents -n 1 HEAD`.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run packages/server/test/sync/pull.test.ts`

Expected: FAIL because `saveConflict`, `abortConflictMerge`, and the new result shape do not exist.

- [ ] **Step 3: Implement the minimal service**

Define:

```ts
export interface GitConflictFile {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string | null
  binary: boolean
}

export interface PullResult {
  clean: boolean
  conflicts: GitConflictFile[]
}
```

`syncPull` preserves the existing pre-pull auto-commit, fetches, then calls `git.merge(repoPath, 'FETCH_HEAD')`. For conflicts, build the response exclusively from `git.unmergedPaths`, `git.showIndexStage`, and the worktree file. Missing text or NUL bytes set `binary: true`.

`saveConflict` must verify the path is currently unmerged, reject marker lines matching `/^(<{7}|={7}|>{7}|\|{7})(?: |$)/m`, write the complete result, and `git.add` that file. If no unmerged paths remain, call `git.commit(repoPath, 'merge: resolve conflicts')`.

`abortConflictMerge` delegates to `git.abortMerge`.

- [ ] **Step 4: Run server tests and verify GREEN**

Run: `bunx vitest run packages/server/test/sync/pull.test.ts`

Expected: PASS, including automatic Git merge, conflict stages, save, two-parent commit, and abort.

### Task 3: Conflict HTTP API

**Files:**

- Modify: `packages/server/src/api/routes/sync.ts`
- Modify: `packages/web/src/lib/api.ts`
- Test: `packages/server/test/api.test.ts`

- [ ] **Step 1: Write failing route tests**

Add API tests for:

```ts
await app.request('/api/sync/conflicts/save', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoPath, path: 'skills.yaml', result: 'resolved\n' }),
})

await app.request('/api/sync/conflicts/abort', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoPath }),
})
```

Assert `{ ok: true, clean, remaining }`, and assert marker validation returns `{ ok: false, error: 'unresolved_markers' }`.

- [ ] **Step 2: Run route tests and verify RED**

Run: `bunx vitest run packages/server/test/api.test.ts -t "sync conflict"`

Expected: FAIL with 404 responses.

- [ ] **Step 3: Add routes and typed client methods**

Add `POST /sync/conflicts/save` and `POST /sync/conflicts/abort`. Every catch branch logs `{ err, repoPath, path }` through `syncLogger.error` before returning the structured error.

Add shared client types and:

```ts
saveSyncConflict: (body: { repoPath: string; path: string; result: string }) =>
  post('/sync/conflicts/save', body).then(json),
abortSyncMerge: (repoPath: string) =>
  post('/sync/conflicts/abort', { repoPath }).then(json),
```

Remove the old `syncApply` client and `/sync/apply` route.

- [ ] **Step 4: Run route tests and verify GREEN**

Run: `bunx vitest run packages/server/test/api.test.ts`

Expected: PASS with structured validation and logged error branches.

### Task 4: Conflict marker model

**Files:**

- Create: `packages/web/src/views/sync/conflict-markers.ts`
- Create: `packages/web/test/conflict-markers.test.ts`

- [ ] **Step 1: Write failing marker tests**

```ts
const input = 'before\n<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> FETCH_HEAD\nafter\n'
const blocks = parseConflictMarkers(input)
expect(blocks).toHaveLength(1)
expect(blocks[0]).toMatchObject({ ours: 'local\n', theirs: 'remote\n' })
expect(resolveConflictBlock(input, blocks[0], 'ours')).toBe('before\nlocal\nafter\n')
expect(resolveConflictBlock(input, blocks[0], 'theirs')).toBe('before\nremote\nafter\n')
expect(resolveConflictBlock(input, blocks[0], 'both')).toBe('before\nlocal\nremote\nafter\n')
```

Add cases for multiple blocks and malformed/unclosed markers.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run packages/web/test/conflict-markers.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the marker-only parser**

Implement a single-pass line scanner that records exact string offsets and the `ours`/`theirs` slices. This module must not compute diffs or decide whether a conflict exists; it only transforms standard markers already emitted by Git. Malformed markers return no actionable block and remain visible for manual editing.

- [ ] **Step 4: Run marker tests and verify GREEN**

Run: `bunx vitest run packages/web/test/conflict-markers.test.ts`

Expected: PASS.

### Task 5: CodeMirror conflict editor and Sync integration

**Files:**

- Modify: `packages/web/package.json`
- Modify: `bun.lock`
- Create: `packages/web/src/views/sync/ConflictEditor.tsx`
- Modify: `packages/web/src/views/Sync.tsx`
- Modify: `packages/web/test/views.test.tsx`

- [ ] **Step 1: Install maintained editor packages**

Run:

```bash
bun add --filter @loom/web codemirror @codemirror/merge @codemirror/lang-yaml
```

Expected: package manifest and lockfile include CodeMirror 6 packages.

- [ ] **Step 2: Write failing view tests**

Mock `syncPull` with one `GitConflictFile`, then assert:

```ts
expect(await screen.findByText('skills.yaml')).toBeDefined()
expect(screen.getByText('LOCAL')).toBeDefined()
expect(screen.getByText('REMOTE')).toBeDefined()
expect(screen.queryByText('[object Object]')).toBeNull()
fireEvent.click(screen.getByRole('button', { name: '放弃合并' }))
await waitFor(() => expect(api.abortSyncMerge).toHaveBeenCalledWith('/tmp/r'))
```

Mock the editor boundary in jsdom so the test verifies React workflow rather than CodeMirror internals. Add a save test asserting `saveSyncConflict({ repoPath, path, result })` and advancement to the next file.

- [ ] **Step 3: Run view tests and verify RED**

Run: `bunx vitest run packages/web/test/views.test.tsx -t "Sync view"`

Expected: FAIL because the new editor and API methods do not exist.

- [ ] **Step 4: Implement `ConflictEditor`**

Mount `MergeView` in a `useEffect`, with `a.doc = ours ?? ''`, `b.doc = theirs ?? ''`, both read-only, `collapseUnchanged: { margin: 3, minSize: 4 }`, and YAML language support for `.yaml`/`.yml`. Destroy the view in effect cleanup.

Maintain RESULT as a separate editable CodeMirror `EditorView`, initialized from `result`. Parse marker blocks with `parseConflictMarkers`; buttons replace one block with ours, theirs, or both and move focus to the next block. Expose `onSave(path, result)` and `onAbort()` callbacks. Binary conflicts show whole-file LOCAL/REMOTE selection without text editors.

Use existing Loom colors, typography, button components, and responsive breakpoints. At narrow widths, replace the side-by-side input view with LOCAL/REMOTE tabs; RESULT remains visible.

- [ ] **Step 5: Replace field conflict cards in `Sync.tsx`**

Use typed `PullResult`, render `ConflictEditor` when `conflicts.length > 0`, call `saveSyncConflict` per file, and call `abortSyncMerge` for “放弃合并”. Remove `resolutions`, `String(c.ours)`, old totals, old field cards, and `textConflicts` rendering.

- [ ] **Step 6: Run view tests and verify GREEN**

Run: `bunx vitest run packages/web/test/views.test.tsx packages/web/test/conflict-markers.test.ts`

Expected: PASS without React act warnings or `[object Object]` output.

### Task 6: Full verification and browser validation

**Files:**

- Modify only files required by failures found in this task.

- [ ] **Step 1: Run all tests**

Run: `bun run test`

Expected: all suites PASS.

- [ ] **Step 2: Run production build and formatting check**

Run: `bun build && bun run format:check`

Expected: both commands exit 0.

- [ ] **Step 3: Validate the real conflict flow with playwright-cli**

Use a named session. Open `/sync`, trigger a pull against a disposable divergent repository, and verify:

- Git-clean merge shows “合并成功，无冲突”.
- Git conflict opens the LOCAL/REMOTE CodeMirror diff.
- Block choice updates RESULT.
- Saving advances the conflict count and eventually completes the merge.
- “放弃合并” restores the pre-pull state.
- No `[object Object]` appears.
- Narrow viewport switches LOCAL/REMOTE to tabs.

- [ ] **Step 4: Inspect final changes**

Run: `git status --short && git diff --check && git diff --stat`

Expected: only the files listed in this plan plus the approved design/plan documents are changed; `git diff --check` is clean.
