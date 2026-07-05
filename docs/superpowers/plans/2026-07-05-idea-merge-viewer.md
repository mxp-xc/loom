# IDEA-style Three-way Merge Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the first-marker/global-button editor with an IntelliJ IDEA-style LOCAL / RESULT / REMOTE viewer that automatically merges non-overlapping edits and gives every remaining side change its own apply/ignore controls.

**Architecture:** A pure `merge-model.ts` module uses `node-diff3` with BASE, LOCAL, and REMOTE to build the initial RESULT and overlapping change blocks. `ConflictEditor.tsx` renders three CodeMirror panes and applies block decisions through targeted transactions; Git continues to own repository merge state.

**Tech Stack:** React 18, TypeScript, CodeMirror 6, `node-diff3`, Vitest, Testing Library, playwright-cli.

---

Commit steps are omitted because repository policy requires separate authorization for `git commit`.

## File map

- Modify `packages/web/package.json` and `bun.lock`: add `node-diff3`.
- Create `packages/web/src/views/sync/merge-model.ts`: pure diff3 model and block operations.
- Create `packages/web/test/merge-model.test.ts`: model behavior tests.
- Replace `packages/web/src/views/sync/ConflictEditor.tsx`: three-pane viewer and block widgets.
- Delete `packages/web/src/views/sync/conflict-markers.ts` and `packages/web/test/conflict-markers.test.ts`: remove obsolete marker-first behavior.
- Modify `packages/web/test/views.test.tsx`: integration behavior.

### Task 1: Add the diff3 dependency

**Files:**

- Modify: `packages/web/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Install with bun**

```bash
bun add --filter @loom/web node-diff3@^3.2.1
```

Expected: `packages/web/package.json` records `node-diff3` and the lockfile contains no unrelated changes.

- [ ] **Step 2: Confirm the typed API**

Use `diff3Merge(localLines, baseLines, remoteLines, { excludeFalseConflicts: true })`. Its result alternates `{ ok: T[] }` stable regions and `{ conflict: { a, o, b } }` overlapping regions.

### Task 2: Build the pure merge model with TDD

**Files:**

- Create: `packages/web/src/views/sync/merge-model.ts`
- Create: `packages/web/test/merge-model.test.ts`

- [ ] **Step 1: Write the failing refinement tests**

```ts
import { describe, expect, it } from 'vitest'
import { applyBlockSide, buildMergeModel, ignoreBlockSide } from '../src/views/sync/merge-model'

const base = 'profile: local\ntargets:\n  - claude-code\nprojection:\n  strategy: link\n'
const local =
  'profile: local\ntargets:\n  - claude-code\n  - codex\n  - opencode\nprojection:\n  strategy: link\n'
const remote =
  'profile: local\ntargets: []\nprojection:\n  strategy: link\nproxy:\n  http: http://127.0.0.1:7890\n  https: http://127.0.0.1:7890\n'

describe('three-way merge model', () => {
  it('automatically merges proxy and leaves only targets pending', () => {
    const model = buildMergeModel(base, local, remote)
    expect(model.result).toContain('proxy:')
    expect(model.blocks).toHaveLength(1)
    expect(model.blocks[0]).toMatchObject({
      localText: expect.stringContaining('opencode'),
      remoteText: 'targets: []\n',
      localState: 'pending',
      remoteState: 'pending',
    })
  })

  it('applies local and independently ignores remote', () => {
    let model = buildMergeModel(base, local, remote)
    const id = model.blocks[0].id
    model = applyBlockSide(model, id, 'local')
    model = ignoreBlockSide(model, id, 'remote')
    expect(model.result).toContain('  - opencode')
    expect(model.result).toContain('proxy:')
    expect(model.unresolvedCount).toBe(0)
  })
})
```

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run packages/web/test/merge-model.test.ts
```

Expected: FAIL because `merge-model.ts` does not exist.

- [ ] **Step 3: Implement the public model**

```ts
import { diff3Merge } from 'node-diff3'

export type BlockSide = 'local' | 'remote'
export type BlockDecision = 'pending' | 'applied' | 'ignored'

export interface MergeBlock {
  id: string
  baseText: string
  localText: string
  remoteText: string
  resultFrom: number
  resultTo: number
  localState: BlockDecision
  remoteState: BlockDecision
}

export interface MergeModel {
  result: string
  blocks: MergeBlock[]
  unresolvedCount: number
}

const splitLines = (text: string) => text.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? []
const join = (lines: string[]) => lines.join('')

export function buildMergeModel(base: string, local: string, remote: string): MergeModel {
  const regions = diff3Merge(splitLines(local), splitLines(base), splitLines(remote), {
    excludeFalseConflicts: true,
  })
  let result = ''
  const blocks: MergeBlock[] = []
  for (const [index, region] of regions.entries()) {
    if (region.ok) {
      result += join(region.ok)
    } else if (region.conflict) {
      const baseText = join(region.conflict.o)
      const resultFrom = result.length
      result += baseText
      blocks.push({
        id: `block-${index}`,
        baseText,
        localText: join(region.conflict.a),
        remoteText: join(region.conflict.b),
        resultFrom,
        resultTo: result.length,
        localState: 'pending',
        remoteState: 'pending',
      })
    }
  }
  return { result, blocks, unresolvedCount: blocks.length }
}
```

Implement `applyBlockSide(model, id, side)` as an immutable replacement of `[resultFrom, resultTo)`, mark that side `applied`, and shift later ranges by the length delta. Implement `ignoreBlockSide` without changing RESULT. Count a block unresolved while either side is `pending`.

- [ ] **Step 4: Verify GREEN**

```bash
bunx vitest run packages/web/test/merge-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add regression coverage**

Add tests for identical edits producing no block, two conflict regions where the first replacement changes length, and unknown block ids leaving the original model unchanged.

- [ ] **Step 6: Re-run focused tests**

```bash
bunx vitest run packages/web/test/merge-model.test.ts
```

Expected: all merge-model tests PASS.

### Task 3: Replace the UI with a three-pane viewer

**Files:**

- Replace: `packages/web/src/views/sync/ConflictEditor.tsx`
- Delete: `packages/web/src/views/sync/conflict-markers.ts`
- Delete: `packages/web/test/conflict-markers.test.ts`
- Modify: `packages/web/test/views.test.tsx`

- [ ] **Step 1: Write a failing workflow test**

Use the BASE / LOCAL / REMOTE fixture from Task 2 and assert:

```ts
expect(await screen.findByText('config.yaml')).toBeDefined()
expect(screen.getByText('RESULT')).toBeDefined()
expect(screen.getByText('1 个待处理冲突')).toBeDefined()
expect(screen.getAllByRole('button', { name: /应用到结果/ })).toHaveLength(2)
expect(screen.getAllByRole('button', { name: /忽略变更/ })).toHaveLength(2)
expect(screen.queryByRole('button', { name: '接受两者' })).toBeNull()
```

Click “本地变更 1：应用到结果” and “远程变更 1：忽略变更”, then save. Assert `api.saveSyncConflict` receives local `targets`, remote `proxy`, and no marker lines.

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run packages/web/test/views.test.tsx -t "native Git conflicts"
```

Expected: FAIL because the current editor has two input panes and global accept buttons.

- [ ] **Step 3: Switch to MergeModel state**

Initialize from `buildMergeModel(conflict.base ?? '', conflict.ours ?? '', conflict.theirs ?? '')` and rebuild when `conflict` changes. Create read-only LOCAL and REMOTE CodeMirror views plus an editable RESULT view initialized from `model.result`. Remove `choose`, marker parsing, and every global “接受…” button.

- [ ] **Step 4: Add per-side CodeMirror widgets**

For every pending LOCAL and REMOTE block, add a `Decoration.widget` through a `StateField`. Each widget renders:

```tsx
<div className="merge-block-actions" data-side={side} data-block-id={block.id}>
  <button aria-label={`${label}变更 ${number}：应用到结果`}>{side === 'local' ? '→' : '←'}</button>
  <button aria-label={`${label}变更 ${number}：忽略变更`}>×</button>
</div>
```

Widget callbacks call `applyBlockSide` or `ignoreBlockSide`. Applying dispatches only the affected RESULT range; ignoring changes state only. Use CodeMirror transaction mapping to shift later block ranges after direct RESULT edits. If a range cannot be mapped safely, leave it pending for manual resolution instead of guessing.

- [ ] **Step 5: Gate save on side decisions**

Show `${model.unresolvedCount} 个待处理冲突`. Disable save while nonzero. Submit `resultView.current.state.doc.toString()` once all sides are applied or ignored; server marker rejection remains a safety fallback.

- [ ] **Step 6: Verify GREEN**

```bash
bunx vitest run packages/web/test/merge-model.test.ts packages/web/test/views.test.tsx
```

Expected: PASS; RESULT contains local `targets` and remote `proxy`.

### Task 4: Responsive behavior and visual states

**Files:**

- Modify: `packages/web/src/views/sync/ConflictEditor.tsx`
- Modify: `packages/web/test/views.test.tsx`

- [ ] **Step 1: Add failing reset/mobile tests**

Assert that changing `conflict.path` rebuilds the model, and mobile markup exposes LOCAL / RESULT / REMOTE tabs while keeping the same action accessible names.

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run packages/web/test/views.test.tsx -t "merge viewer"
```

Expected: FAIL until three-tab mobile behavior exists.

- [ ] **Step 3: Implement layout**

Use a three-column CSS grid on desktop. Below `760px`, show LOCAL / RESULT / REMOTE tabs and only the active pane while keeping the model in React state. Use existing tokens only: amber for pending, green for applied, reduced opacity plus “已忽略” for ignored.

- [ ] **Step 4: Verify focused suite and build**

```bash
bunx vitest run packages/web/test/merge-model.test.ts packages/web/test/views.test.tsx
bun --filter @loom/web build
```

Expected: tests PASS and Vite build succeeds.

### Task 5: Full regression and browser verification

**Files:** verification only.

- [ ] **Step 1: Run the full suite**

```bash
bun run test
```

Expected: all suites PASS, including server native Git merge/save/abort tests.

- [ ] **Step 2: Run formatting and diff checks**

```bash
bunx prettier --check packages/web/src/views/sync/ConflictEditor.tsx packages/web/src/views/sync/merge-model.ts packages/web/test/merge-model.test.ts packages/web/test/views.test.tsx
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 3: Verify with playwright-cli**

Generate one named session and reuse it:

```bash
SESSION="merge-viewer-$(uv run python -c 'import uuid; print(uuid.uuid4().hex[:8])')"
playwright-cli -s "$SESSION" open http://localhost:5173/sync
```

Using the real `config.yaml` conflict, verify: three desktop panes; `proxy` already in RESULT; only `targets` pending; both side blocks have arrow and ×; applying LOCAL plus ignoring REMOTE enables save without losing `proxy`; direct RESULT edits survive another block action; mobile has three tabs; abort still restores state. Save the screenshot under `temp/` and close only this session.

- [ ] **Step 4: Inspect scope**

```bash
git status --short
git diff -- packages/web/package.json packages/web/src/views/sync packages/web/test bun.lock
```

Expected: only task-related files and existing native Git conflict work are changed; no temporary browser artifacts are tracked.
