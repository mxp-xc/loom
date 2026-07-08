# Radix Dialog Modal Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace Loom web's hand-written Modal implementation with a Radix Dialog-backed adapter while preserving the existing ModalProps interface and all current callers.

**Architecture:** This round deepens one existing module seam: packages/web/src/components/Modal.tsx. Callers keep using the same open/onClose/title/width/minHeight/busy/children interface; Radix Dialog becomes the internal implementation adapter for focus management, ARIA, Escape handling, outside interactions, and portal behavior. ConfirmDialog, Tooltip, Toast, and VarsConfigModal are intentionally deferred to later rounds.

**Tech Stack:** React 18, TypeScript, Vitest/jsdom, Testing Library, Bun, @radix-ui/react-dialog, existing IconButton, existing CSS variables.

## Global Constraints

- User-visible content must be Chinese; code identifiers, commands, and technical names stay in English.
- Do not run git commit, git push, create/switch branch, git reset --hard, or git clean; this plan intentionally uses diff review without commits.
- Use bun for JS/TS commands.
- Use TDD or behavior-preserving characterization-first refactor discipline: add/verify tests before changing production code, then rerun focused and full verification after implementation.
- Keep ModalProps unchanged: open, onClose, title, width, minHeight, busy, children.
- Do not migrate VarsConfigModal, ConfirmDialog, Tooltip, Toast, IconButton, target chips, forms, query hooks, or any page business flow in this round.
- Do not change modal caller layout, copy, form behavior, destructive-action semantics, Desired state mutation, or Projection behavior.
- Add only @radix-ui/react-dialog as a new web dependency in this round.
- Frontend changes must be verified with automated tests; do not ask the user to manually open a browser.

---

## File Structure

- Modify: packages/web/package.json
  - Adds @radix-ui/react-dialog.
- Modify: bun.lock
  - Updated by Bun after adding the dependency.
- Modify: packages/web/test/modal.test.tsx
  - Adds explicit contract tests for busy Escape/close button/aria-busy and non-busy outside close with focus restore.
- Modify: packages/web/src/components/Modal.tsx
  - Replaces hand-written dialog implementation with Radix Dialog adapter behind the same public interface.
- Modify only if formatting demands it: no other files.

---

### Task 1: Add Radix Dialog dependency and strengthen Modal contract tests

**Files:**

- Modify: packages/web/package.json
- Modify: bun.lock
- Modify: packages/web/test/modal.test.tsx

**Interfaces:**

- Consumes:
  - Existing ModalProps interface from packages/web/src/components/Modal.tsx.
  - Existing tests in packages/web/test/modal.test.tsx.
- Produces:
  - @radix-ui/react-dialog dependency available to packages/web/src/components/Modal.tsx.
  - Additional Modal contract tests that Task 2 must keep passing.

- [ ] **Step 1: Add Radix Dialog dependency**

Run:

```bash
bun --cwd packages/web add @radix-ui/react-dialog
```

Expected:

```text
packages/web/package.json includes "@radix-ui/react-dialog"
bun.lock is updated
```

- [ ] **Step 2: Add explicit busy and outside-close contract tests**

In packages/web/test/modal.test.tsx, keep existing imports and append these tests inside describe('Modal', () => { ... }) after the current busy tests:

```tsx
it('blocks Escape and disables the close button while busy', () => {
  const onClose = vi.fn()
  render(<BusyControlled onClose={onClose} />)

  const dialog = screen.getByRole('dialog', { name: '处理中' })
  const close = screen.getByRole('button', { name: '关闭' })

  fireEvent.click(screen.getByRole('button', { name: '切换忙碌' }))

  expect(dialog.getAttribute('aria-busy')).toBe('true')
  expect((close as HTMLButtonElement).disabled).toBe(true)

  fireEvent.keyDown(window, { key: 'Escape' })

  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '处理中' })).toBeDefined()
})

it('closes from the backdrop when not busy and restores opener focus', async () => {
  const close = vi.fn()
  render(<Controlled onClose={close} />)

  const opener = screen.getByRole('button', { name: '打开' })
  opener.focus()
  fireEvent.click(opener)

  const input = screen.getByRole('textbox', { name: '名称' })
  await waitFor(() => expect(document.activeElement).toBe(input))

  const dialog = screen.getByRole('dialog', { name: '编辑环境' })
  fireEvent.click(dialog.parentElement!)

  expect(close).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(opener)
})
```

- [ ] **Step 3: Run focused Modal tests before implementation replacement**

Run:

```bash
bun run test packages/web/test/modal.test.tsx
```

Expected:

```text
PASS: all Modal tests pass against the current implementation.
```

This is a behavior-preserving adapter refactor, so these tests are characterization tests. If either new test fails before Task 2, fix the current Modal behavior first before replacing the implementation.

- [ ] **Step 4: Report dependency/test diff without committing**

Run:

```bash
git diff -- packages/web/package.json bun.lock packages/web/test/modal.test.tsx
```

Expected: diff contains only the dependency addition, lockfile update, and two new Modal tests. Do not commit.

---

### Task 2: Replace Modal implementation with Radix Dialog adapter

**Files:**

- Modify: packages/web/src/components/Modal.tsx
- Test: packages/web/test/modal.test.tsx

**Interfaces:**

- Consumes:
  - @radix-ui/react-dialog.
  - Existing IconButton close affordance.
  - Existing ModalProps contract.
- Produces:
  - Modal with the same caller-facing interface and behavior, backed internally by Radix Dialog primitives.

- [ ] **Step 1: Replace Modal.tsx implementation**

Replace the entire contents of packages/web/src/components/Modal.tsx with:

```tsx
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { IconButton } from '@/components/ui/IconButton'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  minHeight?: number
  busy?: boolean
  children: ReactNode
}

export default function Modal({
  open,
  onClose,
  title,
  width = 480,
  minHeight = 0,
  busy = false,
  children,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  const openerRef = useRef<HTMLElement | null>(null)
  const focusTimerRef = useRef<number | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    if (!open) return
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current)
      }
    }
  }, [])

  const focusPreferredElement = useCallback(() => {
    const modal = contentRef.current
    if (!modal) return
    const preferred =
      modal.querySelector<HTMLElement>(
        '[data-autofocus]:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ??
      modal.querySelector<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )
    ;(preferred ?? modal).focus()
  }, [])

  const requestClose = useCallback(() => {
    if (busyRef.current) return
    onCloseRef.current()
  }, [])

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) requestClose()
          }}
        >
          <DialogPrimitive.Content
            ref={contentRef}
            aria-busy={busy}
            onClick={(event) => event.stopPropagation()}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              if (focusTimerRef.current !== null) {
                window.clearTimeout(focusTimerRef.current)
              }
              focusTimerRef.current = window.setTimeout(() => {
                focusTimerRef.current = null
                focusPreferredElement()
              }, 0)
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (focusTimerRef.current !== null) {
                window.clearTimeout(focusTimerRef.current)
                focusTimerRef.current = null
              }
              const opener = openerRef.current
              if (opener?.isConnected) opener.focus()
              openerRef.current = null
            }}
            onEscapeKeyDown={(event) => {
              if (busyRef.current) event.preventDefault()
            }}
            onPointerDownOutside={(event) => {
              if (busyRef.current) event.preventDefault()
            }}
            onInteractOutside={(event) => {
              if (busyRef.current) event.preventDefault()
            }}
            style={{
              width: 'min(' + width + 'px, calc(100vw - 32px))',
              minHeight: minHeight || undefined,
              maxHeight: '92vh',
              overflow: 'auto',
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-popover)',
              outline: 'none',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 18px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg)',
              }}
            >
              <DialogPrimitive.Title asChild>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--bright)',
                  }}
                >
                  {title}
                </span>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <IconButton label="关闭" tooltip="关闭" disabled={busy}>
                  <X className="h-4 w-4" />
                </IconButton>
              </DialogPrimitive.Close>
            </div>
            <div style={{ padding: '18px 20px' }}>{children}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
```

- [ ] **Step 2: Run focused Modal tests**

Run:

```bash
bun run test packages/web/test/modal.test.tsx
```

Expected:

```text
PASS: all Modal tests pass.
```

If Tab trap tests fail because Radix Dialog's jsdom keyboard simulation differs from the previous manual handler, do not weaken the user-facing focus contract. Keep the tests and adjust the adapter so the existing interface behavior remains true.

- [ ] **Step 3: Run caller-focused overlay tests**

Run:

```bash
bun run test packages/web/test/views.test.tsx -t "dialog|modal|delete|Edit Source|Add Skill|MemberScanModal|MCP Server|memory|Sync view"
```

Expected:

```text
PASS: modal callers still render dialogs and preserve their business flows.
```

- [ ] **Step 4: Run format check for touched files**

Run:

```bash
bun --bun prettier --check packages/web/src/components/Modal.tsx packages/web/test/modal.test.tsx
```

Expected:

```text
All matched files use Prettier code style!
```

If formatting fails, run:

```bash
bun --bun prettier --write packages/web/src/components/Modal.tsx packages/web/test/modal.test.tsx
```

Then rerun the check command above.

- [ ] **Step 5: Report diff without committing**

Run:

```bash
git diff -- packages/web/src/components/Modal.tsx packages/web/test/modal.test.tsx
```

Expected: diff only replaces Modal implementation and adds/keeps modal contract tests. Do not commit.

---

### Task 3: Final verification and Round 2 re-analysis input

**Files:**

- No production file changes expected.
- May update only .superpowers/sdd scratch reports if using subagent-driven development.

**Interfaces:**

- Consumes:
  - Task 1 dependency/test changes.
  - Task 2 Radix Dialog-backed Modal.
- Produces:
  - Fresh verification evidence and facts for the next improve-codebase-architecture pass.

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

If the check fails only because modified files need formatting, run:

```bash
bun --bun prettier --write packages/web/src/components/Modal.tsx packages/web/test/modal.test.tsx packages/web/package.json
```

Then rerun bun run format:check and bun run test.

- [ ] **Step 3: Inspect final diff scope**

Run:

```bash
git status --short
git diff --stat
git diff -- packages/web/package.json bun.lock packages/web/src/components/Modal.tsx packages/web/test/modal.test.tsx
```

Expected:

```text
Round 2 tracked changes are limited to dependency metadata, Modal implementation, and Modal tests.
Round 1 SelectableList changes may still be present because this workflow intentionally does not commit between rounds.
No commit is created.
```

- [ ] **Step 4: Prepare re-analysis facts**

Record these facts for the controller architecture re-analysis:

```text
Round 2 implemented Radix Dialog-backed Modal adapter:
- New dependency: @radix-ui/react-dialog
- Preserved ModalProps: open/onClose/title/width/minHeight/busy/children
- Migrated implementation only: packages/web/src/components/Modal.tsx
- Strengthened tests: packages/web/test/modal.test.tsx
- Not migrated by design: ConfirmDialog, Tooltip, Toast, VarsConfigModal
- Verification: bun run test, bun run format:check
```

- [ ] **Step 5: Report status without committing**

Final task report must include:

- Commands run and exact pass/fail result.
- Any remaining architectural concerns.
- Confirmation that no commit was created.
