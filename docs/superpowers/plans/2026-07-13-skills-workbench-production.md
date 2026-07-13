# Skills Workbench Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认的 Skills Workbench 高保真原型迁入正式 Web 应用，同时保持现有扫描、选择、保存和投影行为。

**Architecture:** 以共享 `SkillWorkbench` 承载 modal 的标题、响应式双栏与移动端 pane 切换，以共享 `Dropdown` 取代 Skills 页面中的原生 select。现有页面继续拥有业务状态与 API 调用，只重排 render 和样式，避免改变 domain contract。

**Tech Stack:** React, TypeScript, CSS Modules, Radix Dialog, Vitest, Testing Library, Playwright CLI

## Global Constraints

- 保留 Add Skill、Edit Source、Edit Skill 的现有 API 调用和错误处理。
- Edit Source 保存后继续执行 reconciliation 和 projection。
- Source member 顺序及 scan pattern/ref 行为不变。
- 输入焦点由圆角外层表达，不显示内部方形 outline 或默认外发光。
- 不删除独立 `MemberScanModal`。

---

### Task 1: Shared Workbench and Dropdown

**Files:**

- Create: `packages/web/src/views/skills/SkillWorkbench.tsx`
- Create: `packages/web/src/views/skills/SkillWorkbench.module.css`
- Create: `packages/web/src/components/ui/dropdown.tsx`
- Create: `packages/web/src/components/ui/dropdown.module.css`
- Modify: `packages/web/src/components/Modal.tsx`
- Test: `packages/web/test/views.test.tsx`

- [x] Add failing structural tests for workbench panes and custom listbox dropdowns.
- [x] Run `bun run test packages/web/test/views.test.tsx` and confirm the new assertions fail.
- [x] Implement the shared responsive shell and accessible dropdown.
- [x] Run the focused tests and confirm they pass.

### Task 2: Add Skills and Add Source

**Files:**

- Modify: `packages/web/src/views/skills/AddSkillModal.tsx`
- Modify: `packages/web/src/views/skills/AddSkillModal.module.css`
- Test: `packages/web/test/views.test.tsx`

- [x] Add failing tests for the Add Skills/Source pane labels, scan action names, and source ref dropdown.
- [x] Recompose the existing local/source state into the shared workbench without changing API payloads.
- [x] Verify the existing Add Skill behavior tests and new layout tests pass.

### Task 3: Edit Source

**Files:**

- Modify: `packages/web/src/views/skills/EditSourceModal.tsx`
- Modify: `packages/web/src/views/skills/EditSourceModal.module.css`
- Test: `packages/web/test/views.test.tsx`

- [x] Add failing tests for two panes, `Scan members`, and absence of the redundant status banner.
- [x] Recompose source fields and member selection into the shared workbench.
- [x] Verify member filtering, scan, save, reconciliation, and stale request tests pass.

### Task 4: Edit Skill

**Files:**

- Modify: `packages/web/src/views/skills/SkillDetailEditor.tsx`
- Modify: `packages/web/src/views/skills/SkillDetailEditor.module.css`
- Test: `packages/web/test/views.test.tsx`

- [x] Add a failing test for metadata/content panes.
- [x] Move metadata and projected links to the left pane and Markdown preview/editor to the right pane.
- [x] Verify loading, copy, local save, and refresh behavior tests pass.

### Task 5: Verification

**Files:**

- Modify only files required by verification findings.

- [x] Run `bun run test packages/web/test/views.test.tsx`.
- [x] Run `bun run test packages/web/test/css-architecture.test.ts`.
- [x] Run `bun run format:check` and format only touched files if needed.
- [x] Start `bun dev`, capture the selected URL, and verify desktop/mobile layout, dropdown keyboard behavior, focus outlines, overflow, and console output with a named Playwright session.
