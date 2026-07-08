# App Feedback Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Move Loom web feedback from per-view Toast rendering to one app-level Feedback host so every view, including Memory, can show feedback through one interface.

**Architecture:** Deepen the existing feedback module seam without changing product semantics. Keep the current `Toast` visual implementation and single-toast replacement behavior; move the state/host to an app-level module so callers only know `showToast(message)`.

**Tech Stack:** React 18, TypeScript, Vitest/jsdom, Testing Library, Bun, existing `Toast`.

## Global Constraints

- User-visible content must be Chinese; code identifiers, commands, and technical names stay in English.
- Do not run git commit, git push, create/switch branch, git reset --hard, or git clean.
- Use bun for JS/TS commands.
- No new toast dependency in this round: do not add `sonner` or `@radix-ui/react-toast`.
- Keep current single-toast semantics: a later toast replaces the current toast.
- Do not add toast variants, queues, stacks, actions, or global error policy.
- Do not rewrite user-facing copy except where tests need existing strings.
- Do not refactor Memory, Vars, Sync, MCP, Skills business flows beyond feedback rendering/call-site cleanup.
- Frontend changes must be verified with automated tests; do not ask the user to manually open a browser.

---

## File Structure

- Modify: `packages/web/src/hooks/useToast.ts`
  - Converts feedback state from per-view local hook state to one app-level external store.
- Create: `packages/web/src/components/ToastHost.tsx`
  - Renders the current `Toast` once from the app-level feedback store.
- Modify: `packages/web/src/App.tsx`
  - Mounts `ToastHost` once next to `Shell`.
- Modify: `packages/web/src/views/skills/Skills.tsx`
  - Removes per-view `<Toast>` rendering and keeps only `showToast` calls.
- Modify: `packages/web/src/views/Mcp.tsx`
  - Removes per-view `<Toast>` rendering and keeps only `showToast` calls.
- Modify: `packages/web/src/views/Sync.tsx`
  - Removes per-view `<Toast>` rendering and keeps only `showToast` calls.
- Modify: `packages/web/src/views/Memory.tsx`
  - Keeps existing `showToast` calls; they become visible through the app-level host.
- Modify: `packages/web/src/views/vars/Vars.tsx`
  - Replaces local `toast/setToast` state with `showToast`.
- Modify: `packages/web/test/views.test.tsx`
  - Adds Memory feedback regression coverage and imports `ToastHost`.
- Create: `packages/web/test/toast.test.tsx`
  - Covers the Feedback module interface.

---

### Task 1: Add app-level Feedback store and host tests

**Files:**

- Modify: `packages/web/src/hooks/useToast.ts`
- Create: `packages/web/src/components/ToastHost.tsx`
- Create: `packages/web/test/toast.test.tsx`

**Interfaces:**

- Consumes:
  - Existing `Toast` visual module from `packages/web/src/components/Toast.tsx`.
- Produces:
  - `showToast(message: string): void`
  - `dismissToast(): void`
  - `useToast(): { toast: string | null; showToast: typeof showToast; dismiss: typeof dismissToast }`
  - `ToastHost(): JSX.Element | null`

- [ ] **Step 1: Replace `useToast.ts` with app-level external store**

Replace `packages/web/src/hooks/useToast.ts` with:

```ts
import { useCallback, useSyncExternalStore } from 'react'

type Listener = () => void

let currentToast: string | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return currentToast
}

export function showToast(message: string) {
  currentToast = message
  emit()
}

export function dismissToast() {
  currentToast = null
  emit()
}

export function useToast() {
  const toast = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const show = useCallback((message: string) => showToast(message), [])
  const dismiss = useCallback(() => dismissToast(), [])

  return { toast, showToast: show, dismiss }
}
```

- [ ] **Step 2: Add `ToastHost`**

Create `packages/web/src/components/ToastHost.tsx`:

```tsx
import Toast from './Toast'
import { useToast } from '@/hooks/useToast'

export default function ToastHost() {
  const { toast, dismiss } = useToast()
  return toast ? <Toast message={toast} onClose={dismiss} /> : null
}
```

- [ ] **Step 3: Add Feedback module tests**

Create `packages/web/test/toast.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ToastHost from '../src/components/ToastHost'
import { dismissToast, showToast } from '../src/hooks/useToast'

describe('ToastHost', () => {
  afterEach(() => {
    act(() => dismissToast())
  })

  it('renders app-level feedback and replaces the current toast', () => {
    render(<ToastHost />)

    act(() => showToast('已创建'))
    expect(screen.getByText('已创建')).toBeDefined()

    act(() => showToast('已保存'))
    expect(screen.queryByText('已创建')).toBeNull()
    expect(screen.getByText('已保存')).toBeDefined()

    act(() => dismissToast())
    expect(screen.queryByText('已保存')).toBeNull()
  })
})
```

- [ ] **Step 4: Run focused Feedback tests**

Run:

```bash
bun run test packages/web/test/toast.test.tsx
```

Expected:

```text
PASS: ToastHost tests pass.
```

- [ ] **Step 5: Report without committing**

Report changed files and command output. Do not commit.

---

### Task 2: Mount app-level host and migrate feedback callers

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/views/skills/Skills.tsx`
- Modify: `packages/web/src/views/Mcp.tsx`
- Modify: `packages/web/src/views/Sync.tsx`
- Modify: `packages/web/src/views/Memory.tsx`
- Modify: `packages/web/src/views/vars/Vars.tsx`
- Modify: `packages/web/test/views.test.tsx`

**Interfaces:**

- Consumes:
  - `ToastHost` from Task 1.
  - `useToast().showToast` from Task 1.
- Produces:
  - One app-level Toast host mounted in `App`.
  - Views no longer render their own `<Toast>`.

- [ ] **Step 1: Mount `ToastHost` in `App`**

In `packages/web/src/App.tsx`, add:

```tsx
import ToastHost from './components/ToastHost'
```

Change the final return from:

```tsx
return <Shell repoPath={repoPath} activeRepo={activeRepo} />
```

to:

```tsx
return (
  <>
    <Shell repoPath={repoPath} activeRepo={activeRepo} />
    <ToastHost />
  </>
)
```

- [ ] **Step 2: Migrate `Skills`**

In `packages/web/src/views/skills/Skills.tsx`:

- Remove `Toast` import.
- Change `const { toast, showToast, dismiss } = useToast()` to `const { showToast } = useToast()`.
- Remove `{toast && <Toast message={toast} onClose={dismiss} />}`.
- Keep all `showToast` prop/callback usage unchanged.

- [ ] **Step 3: Migrate `Mcp`**

In `packages/web/src/views/Mcp.tsx`:

- Remove `Toast` import.
- Change `const { toast, showToast, dismiss } = useToast()` to `const { showToast } = useToast()`.
- Remove `{toast && <Toast message={toast} onClose={dismiss} />}`.
- Keep `onToast: showToast` and clipboard feedback unchanged.

- [ ] **Step 4: Migrate `Sync`**

In `packages/web/src/views/Sync.tsx`:

- Remove `Toast` import.
- Change `const { toast, showToast, dismiss } = useToast()` to `const { showToast } = useToast()`.
- Remove `{toast && <Toast message={toast} onClose={dismiss} />}`.
- Keep all sync success feedback strings unchanged.

- [ ] **Step 5: Keep `Memory` on the small interface**

In `packages/web/src/views/Memory.tsx`, keep:

```tsx
const { showToast } = useToast()
```

No business-flow changes are needed.

- [ ] **Step 6: Migrate `Vars`**

In `packages/web/src/views/vars/Vars.tsx`:

- Remove `Toast` import.
- Add `import { useToast } from '@/hooks/useToast'`.
- Remove `const [toast, setToast] = useState<string | null>(null)`.
- Add `const { showToast } = useToast()`.
- Change `onError={setToast}` to `onError={showToast}`.
- Remove `{toast && <Toast message={toast} onClose={() => setToast(null)} />}`.

- [ ] **Step 7: Add Memory feedback regression test**

In `packages/web/test/views.test.tsx`:

- Add `import ToastHost from '../src/components/ToastHost'`.
- In the existing `Memory view` describe block, append:

```tsx
it('shows Memory feedback through the app-level toast host', async () => {
  vi.mocked(api.getMemory).mockResolvedValue({
    memories: [{ name: 'v1' }],
    active: 'v1',
    activeContent: '# v1',
  } as never)
  vi.mocked(api.project).mockResolvedValueOnce({ ok: true } as never)

  render(
    <>
      <ToastHost />
      <Memory repoPath="/tmp/memory-feedback" />
    </>,
  )

  fireEvent.click(await screen.findByRole('button', { name: '投影 memory' }))

  await waitFor(() =>
    expect(api.project).toHaveBeenCalledWith({ repo: '/tmp/memory-feedback', scope: 'memory' }),
  )
  expect(await screen.findByText('投影完成')).toBeDefined()
})
```

- [ ] **Step 8: Run focused caller tests**

Run:

```bash
bun run test packages/web/test/views.test.tsx -t "Memory feedback|Memory view|MCP view|Sync view|Skills view|Vars"
```

Expected:

```text
PASS: selected caller tests pass.
```

- [ ] **Step 9: Check remaining old Toast render imports**

Run:

```bash
rg -n "import Toast|<Toast|toast &&|setToast|dismiss" packages/web/src packages/web/test
```

Expected:

```text
No per-view Toast rendering remains. Matches in Toast.tsx, ToastHost.tsx, toast.test.tsx, and unrelated non-feedback identifiers are acceptable.
```

- [ ] **Step 10: Report without committing**

Report changed files, command output, and any grep exceptions. Do not commit.

---

### Task 3: Final verification and Round 3 re-analysis facts

**Files:**

- No production file changes expected.
- May update only `.superpowers/sdd` scratch reports.

**Interfaces:**

- Consumes:
  - Task 1 app-level Feedback store/host.
  - Task 2 migrated callers.
- Produces:
  - Fresh verification evidence and facts for the final architecture summary.

- [ ] **Step 1: Run full test suite**

Run:

```bash
bun run test
```

Expected:

```text
PASS: all test files pass with the existing skipped tests unchanged.
```

- [ ] **Step 2: Run format check**

Run:

```bash
bun run format:check
```

Expected:

```text
All matched files use Prettier code style!
```

- [ ] **Step 3: Inspect final diff scope**

Run:

```bash
git status --short
git diff --stat
git diff -- packages/web/src/hooks/useToast.ts packages/web/src/components/ToastHost.tsx packages/web/src/App.tsx packages/web/src/views/Memory.tsx packages/web/src/views/Mcp.tsx packages/web/src/views/Sync.tsx packages/web/src/views/skills/Skills.tsx packages/web/src/views/vars/Vars.tsx packages/web/test/toast.test.tsx packages/web/test/views.test.tsx
```

Expected:

```text
Round 3 changes are limited to feedback host/store, caller cleanup, and feedback tests.
Round 1 and Round 2 changes may still be present because this workflow intentionally does not commit between rounds.
No commit is created.
```

- [ ] **Step 4: Prepare final facts**

Record:

```text
Round 3 implemented app-level Feedback host:
- New dependency: none
- Preserved caller feedback interface: showToast(message)
- Single ToastHost mounted once in App
- Existing Toast visual retained
- Memory feedback is now visible through ToastHost
- Per-view Toast rendering removed from Skills/Mcp/Sync/Vars
- Verification: bun run test, bun run format:check
```

- [ ] **Step 5: Report status without committing**

Final task report must include:

- Commands run and exact pass/fail result.
- Any remaining architectural concerns.
- Confirmation that no commit was created.
