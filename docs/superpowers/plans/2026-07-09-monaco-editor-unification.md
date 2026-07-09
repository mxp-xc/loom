# Monaco Editor Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Loom complex text editing to a shared Monaco foundation across Memory, Vars, Skills, MCP, and Sync while preserving business semantics.

**Architecture:** Introduce a focused Monaco base component plus small helpers for theme, language, formatting, and vars completion. Normal text editors consume the base directly; Sync keeps a dedicated conflict editor that reuses the shared Monaco helpers but owns merge state, decorations, and conflict actions.

**Tech Stack:** React 18, TypeScript, Vite, Monaco via @monaco-editor/react and monaco-editor, Vitest, Testing Library, Bun, playwright-cli for browser verification when needed.

## Global Constraints

- User-visible text is Chinese; identifiers, commands, and technical names stay in English.
- Use Bun for JS/TS commands.
- Use apply_patch for file edits.
- Do not run git commit, git push, git reset --hard, or git clean unless the user explicitly approves.
- Keep business save, preview, projection, and sync semantics unchanged.
- Monaco diagnostics are editor assistance only; server/core validation remains authoritative.
- Secret values remain masked in suggestions and previews.
- Completion provider failures must not block typing or saving.
- Existing CodeGraph index is present; use CodeGraph before broad source searches during implementation.
- Default verification is tests; run browser verification with playwright-cli for changed UI interaction paths.

## File Structure

Create these focused shared editor files:

- packages/web/src/components/monaco/theme.ts: read data-theme, map Loom theme to Monaco built-in theme names, and observe theme changes.
- packages/web/src/components/monaco/languages.ts: map Loom value types and filenames to Monaco language ids.
- packages/web/src/components/monaco/varsCompletion.ts: register ${key} completion providers using existing memoryCompletion helpers.
- packages/web/src/components/monaco/MonacoTextEditor.tsx: shared React wrapper around @monaco-editor/react.
- packages/web/test/monaco-test-utils.tsx: reusable @monaco-editor/react mock and helper functions for provider assertions.
- packages/web/test/monaco-text-editor.test.tsx: focused shared editor tests.
- packages/web/test/monaco-vars-completion.test.ts: focused completion provider tests.

Modify normal editor consumers:

- packages/web/src/components/MemorySourceMarkdownEditor.tsx
- packages/web/src/views/vars/StringValueEditor.tsx
- packages/web/src/views/vars/JsonValueEditor.tsx
- packages/web/src/views/vars/VarsConfigModal.tsx
- packages/web/src/components/MarkdownPreview.tsx
- packages/web/src/views/Mcp.tsx

Modify Sync editor:

- packages/web/src/views/sync/ConflictEditor.tsx
- packages/web/src/views/sync/ConflictEditor.module.css

Modify tests:

- packages/web/test/memory-editor.test.tsx
- packages/web/test/vars-editors.test.tsx
- packages/web/test/vars-view.test.tsx
- packages/web/test/views.test.tsx
- packages/web/test/sync.test.tsx if Sync-specific coverage is easier there
- packages/web/test/css-architecture.test.ts only if a new CSS module owner is added

Modify package metadata at the end:

- packages/web/package.json
- bun.lock

### Task 1: Shared Monaco foundation and test utilities

**Files:**

- Create: packages/web/src/components/monaco/theme.ts
- Create: packages/web/src/components/monaco/languages.ts
- Create: packages/web/src/components/monaco/MonacoTextEditor.tsx
- Create: packages/web/test/monaco-test-utils.tsx
- Create: packages/web/test/monaco-text-editor.test.tsx

**Interfaces:**

- Produces: readUiTheme(): dark or light
- Produces: monacoThemeName(theme): vs-dark or vs
- Produces: useMonacoUiTheme(): dark or light
- Produces: languageForFile(path, fallback): string
- Produces: languageForVarValue(type, format): string
- Produces: MonacoTextEditor(props): JSX.Element
- Produces: createMonacoEditorMock(): MonacoEditorMockController

- [ ] **Step 1: Write failing shared editor tests**

Add packages/web/test/monaco-text-editor.test.tsx with tests named:

    renders a labelled Monaco textarea through the test mock
    keeps the Monaco theme synced with document data-theme
    forwards readOnly, language, height, value, and onChange
    disposes resources registered by onMount when the editor is disposed

The tests should import createMonacoEditorMock from packages/web/test/monaco-test-utils.tsx and mock @monaco-editor/react once at the top of the file. Assert the rendered textbox has aria-label 配置值, changing it calls onChange with the new string, dark theme maps to vs-dark, light theme maps to vs, and disposing the mock editor calls the disposable returned from onEditorMount.

- [ ] **Step 2: Run the failing tests**

Run: bun run test -- packages/web/test/monaco-text-editor.test.tsx

Expected: FAIL because monaco test utilities and shared Monaco files do not exist.

- [ ] **Step 3: Create theme helpers**

Create packages/web/src/components/monaco/theme.ts with these exported functions: readUiTheme, monacoThemeName, useMonacoUiTheme.

Implementation requirements:

- readUiTheme returns light when document is unavailable.
- readUiTheme returns dark only when document.documentElement data-theme is dark.
- useMonacoUiTheme uses useState and MutationObserver to track data-theme changes.

- [ ] **Step 4: Create language helpers**

Create packages/web/src/components/monaco/languages.ts with languageForFile and languageForVarValue.

Mappings:

- .md and .markdown -> markdown
- .json -> json
- .yaml and .yml -> yaml
- .toml -> plaintext
- .sh, .bash, .zsh -> shell
- type json -> json
- string format markdown/json/yaml/shell -> matching language
- string format toml/path/plain or unknown -> plaintext

- [ ] **Step 5: Create MonacoTextEditor**

Create packages/web/src/components/monaco/MonacoTextEditor.tsx. Props must include value, onChange, language, ariaLabel, height, readOnly, className, options, and onEditorMount.

Behavior:

- Render @monaco-editor/react Editor.
- Use language default plaintext.
- Use theme from useMonacoUiTheme and monacoThemeName.
- Pass value and call onChange with next when defined, otherwise with an empty string.
- Set automaticLayout true, minimap disabled, JetBrains Mono, lineHeight 22, fontSize 12.5, wordWrap on, scrollBeyondLastLine false, tabSize 2.
- If readOnly is true, set readOnly true and domReadOnly true.
- On mount, set aria-label on editor.getDomNode() when available.
- Call onEditorMount and dispose returned disposables when editor onDidDispose fires.

- [ ] **Step 6: Create reusable Monaco test mock**

Create packages/web/test/monaco-test-utils.tsx. It should export createMonacoEditorMock. The controller must expose props, providers, setTheme, disposeCallbacks, lastTextarea(), disposeLast(), reset(), and module().

The mock Editor component should render a textarea with aria-label from props, call props.onMount(editor, monaco), and call props.onChange on textarea change. The mock monaco object must include editor.setTheme, languages.registerCompletionItemProvider, languages.CompletionItemKind.Variable, and Range.

- [ ] **Step 7: Run shared editor tests**

Run: bun run test -- packages/web/test/monaco-text-editor.test.tsx

Expected: PASS.

- [ ] **Step 8: Checkpoint without commit**

Run: git status --short

Expected: only Task 1 files are changed. Do not commit unless the user has explicitly approved commits.

### Task 2: Shared vars completion provider

**Files:**

- Create: packages/web/src/components/monaco/varsCompletion.ts
- Create: packages/web/test/monaco-vars-completion.test.ts
- Modify: packages/web/src/components/memoryCompletion.ts only if a reusable export is missing

**Interfaces:**

- Consumes: completionAt(value, cursor), filterCompletionKeys(keys, query), placeholderForKey(key)
- Produces: registerVarsCompletionProvider(monaco, language, getKeys): disposable
- Produces: varsCompletionSuggestions(monaco, model, position, keys): suggestions result

- [ ] **Step 1: Write failing completion tests**

Add packages/web/test/monaco-vars-completion.test.ts with tests named:

    suggests matching vars for an open placeholder
    replaces an auto-closed closing brace
    returns no suggestions for escaped placeholders
    disposes the registered Monaco provider

Use a fake model with getValueInRange. Assert ${AP gives API_URL, ${AP} replacement range consumes the closing brace, and escaped placeholders give an empty suggestions array.

- [ ] **Step 2: Run failing completion tests**

Run: bun run test -- packages/web/test/monaco-vars-completion.test.ts

Expected: FAIL because varsCompletion.ts does not exist.

- [ ] **Step 3: Implement varsCompletion.ts**

Create varsCompletion.ts with varsCompletionSuggestions and registerVarsCompletionProvider.

Implementation requirements:

- Read the current line prefix from column 1 to position.column.
- Call completionAt(linePrefix, linePrefix.length).
- If there is no completion, return { suggestions: [] }.
- If the next character is } and the completion token does not already end with }, extend endColumn by 1.
- Return CompletionItemKind.Variable suggestions with label key, filterText completion.token, insertText placeholderForKey(key), and the calculated Range.
- registerVarsCompletionProvider delegates to monaco.languages.registerCompletionItemProvider(language, provider) with triggerCharacters [{].

- [ ] **Step 4: Run completion tests**

Run: bun run test -- packages/web/test/monaco-vars-completion.test.ts

Expected: PASS.

- [ ] **Step 5: Checkpoint without commit**

Run: git status --short

Expected: Task 2 files plus earlier files are changed. Do not commit unless the user has explicitly approved commits.

### Task 3: Migrate Memory source editor to shared Monaco

**Files:**

- Modify: packages/web/src/components/MemorySourceMarkdownEditor.tsx
- Modify: packages/web/test/memory-editor.test.tsx

**Interfaces:**

- Consumes: MonacoTextEditor
- Consumes: registerVarsCompletionProvider
- Keeps: MemorySourceMarkdownEditor({ value, onChange, varsKeys })

- [ ] **Step 1: Update Memory tests to use shared mock**

In packages/web/test/memory-editor.test.tsx, replace the inline @monaco-editor/react mock with createMonacoEditorMock. Keep existing test names and assertions for source editing, completion, provider disposal, and theme sync. Keep data-testid memory-source-monaco available through the mock controller or query by role textbox name Memory 内容.

- [ ] **Step 2: Run Memory tests to verify current migration fails**

Run: bun run test -- packages/web/test/memory-editor.test.tsx

Expected: FAIL until MemorySourceMarkdownEditor uses the shared component and mock expectations are aligned.

- [ ] **Step 3: Replace local Monaco wiring in MemorySourceMarkdownEditor**

Modify packages/web/src/components/MemorySourceMarkdownEditor.tsx:

- Remove local readUiTheme and monacoThemeName.
- Remove local providerRef and monacoRef theme wiring.
- Import MonacoTextEditor and registerVarsCompletionProvider.
- Keep varsKeysRef synchronized with props.
- Render MonacoTextEditor with ariaLabel Memory 内容, language markdown, height 100%, value, onChange.
- In onEditorMount, register vars completion for markdown and return the disposable.

- [ ] **Step 4: Run Memory tests**

Run: bun run test -- packages/web/test/memory-editor.test.tsx

Expected: PASS.

- [ ] **Step 5: Checkpoint without commit**

Run: git status --short

Expected: MemorySourceMarkdownEditor and memory test changes are included. Do not commit unless explicitly approved.

### Task 4: Migrate Vars string, JSON, and config value editors

**Files:**

- Create: packages/web/src/views/vars/VarsMonacoValueEditor.tsx
- Modify: packages/web/src/views/vars/StringValueEditor.tsx
- Modify: packages/web/src/views/vars/JsonValueEditor.tsx
- Modify: packages/web/src/views/vars/VarsConfigModal.tsx
- Modify: packages/web/test/vars-editors.test.tsx
- Modify: packages/web/test/vars-view.test.tsx

**Interfaces:**

- Consumes: MonacoTextEditor
- Consumes: languageForVarValue
- Consumes: registerVarsCompletionProvider
- Produces: keysFromVarsResolution(resolution): string[]
- Produces: VarsMonacoValueEditor(props): JSX.Element

- [ ] **Step 1: Write failing Vars Monaco tests**

Update packages/web/test/vars-editors.test.tsx:

- The string completion test should interact with the Monaco mock textbox labelled 值 and assert Enter-selected insertion still produces ${PORT}.
- The secret test should keep using a password input and should not render a Monaco textbox for secret values.
- The JSON format test should use the Monaco mock textbox labelled JSON 值 and keep the same format success and format failure assertions.
- Add a test that JsonValueEditor passes language json to MonacoTextEditor.

Update packages/web/test/vars-view.test.tsx:

- The VarsConfigModal edit test should edit the textbox labelled 配置值 through the Monaco mock and assert the same save API call as before.
- Add a test that markdown/json/yaml formats choose the expected language when opening the modal.

- [ ] **Step 2: Run Vars tests to verify they fail**

Run: bun run test -- packages/web/test/vars-editors.test.tsx packages/web/test/vars-view.test.tsx

Expected: FAIL because Vars still uses textarea and CodeMirror.

- [ ] **Step 3: Create VarsMonacoValueEditor**

Create packages/web/src/views/vars/VarsMonacoValueEditor.tsx with props value, onChange, type, format, disabled, ariaLabel, varsKeys, error, onError, and height.

Behavior:

- Compute language with languageForVarValue(type, format).
- Render MonacoTextEditor with readOnly disabled, ariaLabel, value, language, and height default 190px.
- If varsKeys is non-empty, register vars completion for the selected language.
- On change, call onChange(next) and clear error through onError(null) when error exists.

- [ ] **Step 4: Add keysFromVarsResolution helper**

In VarsMonacoValueEditor.tsx or a small local helper file, export keysFromVarsResolution. It should return sorted unique keys from resolution.values when resolution.ok is true or when the legacy VarsResolution shape exposes values. It must return [] for null or failed resolution.

- [ ] **Step 5: Migrate StringValueEditor non-secret branch**

Modify StringValueEditor:

- Keep secret branch as input type password/text.
- Replace textarea branch with VarsMonacoValueEditor type string format plain, ariaLabel 值, varsKeys from resolution values.
- Remove the custom listbox for non-secret Monaco editing after Monaco completion covers insertion.
- Keep masked suggestions out of visible text by using key-only Monaco labels or masked detail values.

- [ ] **Step 6: Migrate JsonValueEditor**

Modify JsonValueEditor:

- Remove @uiw/react-codemirror and @codemirror imports.
- Keep the toolbar and 格式化 JSON button.
- Render VarsMonacoValueEditor with type json, ariaLabel JSON 值, disabled, value, onChange, error, onError.
- Keep format implementation as JSON.stringify(JSON.parse(value), null, 2).
- On catch, call console.error({ err: cause }, JSON format failed) and onError with JSON 语法错误：message.

- [ ] **Step 7: Migrate VarsConfigModal value field**

Modify VarsConfigModal:

- Replace the textarea inside previewMode edit with VarsMonacoValueEditor.
- Pass type and format from the selected/new entry.
- Compute varsKeys from previewMatrix.resolution when ok.
- Preserve raw preview and resolved preview branches.
- Preserve readOnly behavior for view mode and builtin profile.

- [ ] **Step 8: Run Vars tests**

Run: bun run test -- packages/web/test/vars-editors.test.tsx packages/web/test/vars-view.test.tsx

Expected: PASS.

- [ ] **Step 9: Checkpoint without commit**

Run: git status --short

Expected: Vars files and tests are changed. Do not commit unless explicitly approved.

### Task 5: Migrate SKILL.md and MCP env/headers editors

**Files:**

- Modify: packages/web/src/components/MarkdownPreview.tsx
- Modify: packages/web/src/views/Mcp.tsx
- Modify: packages/web/test/views.test.tsx

**Interfaces:**

- Consumes: MonacoTextEditor
- Consumes: registerVarsCompletionProvider
- Consumes: api.vars.getMatrix(repoPath, agent)
- Keeps: MarkdownPreview props unchanged
- Keeps: RecordField mode, rows, value, onTextChange, onRowsChange semantics

- [ ] **Step 1: Write failing Skill and MCP tests**

Update packages/web/test/views.test.tsx:

- In SkillDetailEditor editable local skill tests, edit the Monaco mock textbox for SKILL.md content and assert api.saveSkillContent receives the new content.
- In the MCP edit modal test, edit env file through the Monaco mock textbox labelled env file and assert updateMcpServer receives env { FOO: baz }.
- Add an MCP headers test for a remote server that edits headers file through Monaco and asserts headers { Authorization: Bearer ${API_TOKEN} }.
- Add an MCP vars completion test that opens an MCP modal, waits for api.vars.getMatrix to be called for the selected target agent, and asserts the provider suggests API_URL for ${AP.

- [ ] **Step 2: Run tests to verify failure**

Run: bun run test -- packages/web/test/views.test.tsx

Expected: FAIL until MarkdownPreview and Mcp use Monaco.

- [ ] **Step 3: Migrate MarkdownPreview editable source mode**

Modify packages/web/src/components/MarkdownPreview.tsx:

- Import MonacoTextEditor.
- Replace the editable source textarea with MonacoTextEditor language markdown, ariaLabel SKILL.md 内容, height var(--skill-detail-panel-height), value editContent.
- On change, setEditContent(next) and setDirty(true).
- Preserve saveErr, 保存, 取消, preview/source tab behavior, and non-editable source pre rendering.

- [ ] **Step 4: Pass repo and agent context into McpServerModal**

Modify Mcp.tsx:

- Pass repoPath and visibleAgents into McpServerModal.
- Add props repoPath: string and visibleAgents: AgentId[] to McpServerModal.
- Keep existing open, mode, initialServer, busy, error, onClose, and onSubmit props unchanged.

- [ ] **Step 5: Load MCP vars completion keys**

Inside McpServerModal:

- Add state mcpVarsKeyState with cacheKey and keys.
- Compute completionAgents as form.targets when non-empty; otherwise visibleAgents.slice(0, 1).
- Fetch api.vars.getMatrix(repoPath, agent) for each completion agent.
- Merge userKeys and builtinKeys from each matrix, sort unique, and store keys.
- On catch, console.error({ err }, Failed to load MCP variable suggestions) and set keys to [].

- [ ] **Step 6: Migrate RecordField file mode**

Modify RecordField props to accept varsKeys?: string[]. In file mode, replace textarea with MonacoTextEditor:

- ariaLabel is `${name} file`
- language plaintext
- value is value
- height 150px
- onChange is onTextChange
- onEditorMount registers vars completion when varsKeys length is positive

Preserve pairs mode exactly: rowsFromLines, rowsToLines, add row, delete row, syncRows.

- [ ] **Step 7: Run views tests**

Run: bun run test -- packages/web/test/views.test.tsx

Expected: PASS.

- [ ] **Step 8: Checkpoint without commit**

Run: git status --short

Expected: MarkdownPreview, Mcp, and views tests are changed. Do not commit unless explicitly approved.

### Task 6: Migrate Sync conflict editor from CodeMirror to Monaco

**Files:**

- Modify: packages/web/src/views/sync/ConflictEditor.tsx
- Modify: packages/web/src/views/sync/merge-model.ts
- Create: packages/web/src/views/sync/text-diff.ts
- Modify: packages/web/src/views/sync/ConflictEditor.module.css
- Modify: packages/web/test/views.test.tsx
- Modify: packages/web/test/sync.test.tsx if conflict tests move out of views.test.tsx

**Interfaces:**

- Keeps: ConflictEditor({ conflict, index, total, saving, onSave, onAbort })
- Consumes: buildMergeModel, applyBlockSide, ignoreBlockSide, resetBlockSide
- Consumes: languageForFile
- Produces: diffTextPatches(base: string, side: string): TextPatch[]
- Produces: diffTextChanges(base: string, side: string): Array<{ from: number; to: number }>
- Produces no new public API outside the component

- [ ] **Step 1: Update Sync tests away from CodeMirror DOM assumptions**

In conflict tests, remove assertions that require cm-line, cm-gutters-after, cm-gutters-before, cm-lineNumbers, or cm-gutterElement. Keep merge-model tests unchanged so the local diff replacement must preserve current merge behavior. Replace DOM assertions with product semantics:

- LOCAL, RESULT, REMOTE panes render.
- Action buttons with aria-label 本地变更 1：应用到结果 and 远程变更 1：忽略变更 render.
- Applying local change makes opencode appear in RESULT text.
- Undoing local apply returns unresolved count to 1.
- 保留远程 sets unresolved count to 0.
- 保留两者 restores automatic merge and unresolved count.
- Saving sends result matching targets plus proxy.

- [ ] **Step 2: Run Sync tests to verify failure**

Run: bun run test -- packages/web/test/views.test.tsx

Expected: FAIL because ConflictEditor still uses CodeMirror-specific DOM or Monaco mock is not wired for Sync.

- [ ] **Step 3: Replace CodeMirror diff helpers in merge-model**

Create packages/web/src/views/sync/text-diff.ts and modify merge-model.ts:

- Remove imports from @codemirror/merge and @codemirror/state.
- Implement diffTextPatches(base, side) returning TextPatch[] with from, to, and replacement text.
- Implement diffTextChanges(base, side) returning changed ranges in side coordinates.
- Use a line-oriented LCS algorithm over splitLines(base) and splitLines(side), then convert line offsets back to character offsets.
- Preserve buildPatches and buildChanges behavior by delegating to the new helper.
- Run merge-model tests after this step before touching ConflictEditor.

Run: bun run test -- packages/web/test/merge-model.test.ts

Expected: PASS.

- [ ] **Step 4: Replace CodeMirror imports and lifecycle**

Modify ConflictEditor.tsx:

- Remove imports from codemirror, @codemirror/state, @codemirror/view, and @codemirror/lang-yaml.
- Import MonacoTextEditor or @monaco-editor/react Editor through the shared base.
- Keep model state and mobileSide state.
- Replace EditorView refs with Monaco editor refs or MonacoTextEditor onEditorMount refs.

- [ ] **Step 5: Render three Monaco panes**

Render non-binary conflicts as:

- LOCAL MonacoTextEditor readOnly true, value conflict.ours when defined otherwise empty string, language languageForFile(conflict.path, yaml), ariaLabel Sync LOCAL.
- RESULT MonacoTextEditor readOnly false, value model.result, same language, ariaLabel Sync RESULT, onChange updates model.result and maps block result ranges conservatively.
- REMOTE MonacoTextEditor readOnly true, value conflict.theirs when defined otherwise empty string, same language, ariaLabel Sync REMOTE.

Keep binary conflict branch unchanged.

- [ ] **Step 6: Preserve conflict actions in React-owned action rail**

Render action buttons outside Monaco editor DOM in a pane action rail with class merge-action-rail. Each pending/applied/ignored block should produce the same aria-labels as today:

- 本地变更 N：应用到结果
- 本地变更 N：忽略变更
- 本地变更 N：撤回应用
- 本地变更 N：撤回忽略
- 远程变更 N：应用到结果
- 远程变更 N：忽略变更
- 远程变更 N：撤回应用
- 远程变更 N：撤回忽略

Button callbacks must call applySide, ignoreSide, or resetSide exactly as the current CodeMirror gutter callbacks do.

- [ ] **Step 7: Add Monaco decorations for changed lines**

Use Monaco editor.deltaDecorations for LOCAL, RESULT, and REMOTE panes. Decoration classes must keep semantic names used by tests and CSS:

- merge-change-stable
- merge-change-conflict
- merge-change-applied
- merge-change-ignored

If line-range mapping is uncertain after direct RESULT edits, keep affected block pending and rely on unresolvedCount to block save.

- [ ] **Step 8: Keep save and top-level actions unchanged**

Ensure:

- keepAutomaticMerge rebuilds from buildMergeModel.
- keepWholeSide local/remote sets result to conflict.ours or conflict.theirs and unresolvedCount 0.
- Save button calls onSave(conflict.path, model.result or latest RESULT editor value).
- Save button is disabled when saving or model.unresolvedCount > 0.
- onAbort remains unchanged.

- [ ] **Step 9: Run Sync tests**

Run: bun run test -- packages/web/test/views.test.tsx packages/web/test/merge-model.test.ts

Expected: PASS.

- [ ] **Step 10: Checkpoint without commit**

Run: git status --short

Expected: ConflictEditor, CSS, and tests are changed. Do not commit unless explicitly approved.

### Task 7: Remove CodeMirror dependencies and run full verification

**Files:**

- Modify: packages/web/package.json
- Modify: bun.lock
- Modify: docs/superpowers/specs/2026-07-09-monaco-editor-unification-design.md only if implementation uncovers a design correction

**Interfaces:**

- Consumes: all previous tasks
- Produces: no @codemirror or @uiw/react-codemirror product dependency remains

- [ ] **Step 1: Verify CodeMirror references are gone from source**

Run: rg -n "CodeMirror|@uiw/react-codemirror|codemirror|@codemirror" packages/web/src packages/web/test packages/web/package.json

Expected: no product src or test imports. Historical docs may still mention CodeMirror.

- [ ] **Step 2: Remove CodeMirror packages**

Run:

    bun remove --cwd packages/web @uiw/react-codemirror codemirror @codemirror/autocomplete @codemirror/lang-json @codemirror/lang-yaml @codemirror/lint @codemirror/merge @codemirror/state @codemirror/view

Expected: packages/web/package.json and bun.lock update; monaco-editor and @monaco-editor/react remain.

- [ ] **Step 3: Run targeted web tests**

Run:

    bun run test -- packages/web/test/monaco-text-editor.test.tsx
    bun run test -- packages/web/test/monaco-vars-completion.test.ts
    bun run test -- packages/web/test/memory-editor.test.tsx
    bun run test -- packages/web/test/vars-editors.test.tsx
    bun run test -- packages/web/test/vars-view.test.tsx
    bun run test -- packages/web/test/views.test.tsx
    bun run test -- packages/web/test/merge-model.test.ts

Expected: PASS for every command.

- [ ] **Step 4: Run full test suite**

Run: bun run test

Expected: PASS.

- [ ] **Step 5: Run format check**

Run: bun run format:check

Expected: PASS. If formatting fails, run bun run format and re-run bun run format:check.

- [ ] **Step 6: Browser verification for changed UI paths**

Run: bun dev

Expected: dev server prints an API URL and Web URL. Use that Web URL with playwright-cli. Verify these paths:

- Memory source tab shows Monaco-backed editor and can save draft content.
- Vars edit modal shows Monaco-backed configuration value editor.
- SKILL.md editable source mode shows Monaco-backed source editor.
- MCP env file mode shows Monaco-backed editor and can switch to key/value mode.
- Sync conflict page renders LOCAL, RESULT, REMOTE panes and conflict action buttons.

Do not ask the user to open the browser manually.

- [ ] **Step 7: Final status check**

Run: git status --short

Expected: only files from this plan are changed. Report changed files, tests run, and any browser verification evidence. Do not commit unless the user explicitly approves.

## Self-Review Notes

Spec coverage:

- Shared Monaco foundation is covered by Task 1.
- Vars/Memory/MCP variable completion is covered by Task 2, Task 3, Task 4, and Task 5.
- Memory source migration is covered by Task 3.
- Vars string, config, and JSON migration is covered by Task 4.
- SKILL.md and MCP env/headers migration is covered by Task 5.
- Sync CodeMirror migration is covered by Task 6.
- CodeMirror dependency removal and verification are covered by Task 7.
- Error handling and accessibility are covered in Task 1 shared props plus per-feature tests in Tasks 3 through 6.

Placeholder scan:

- This plan intentionally avoids unresolved placeholder language and open-ended implementation steps.
- Commit steps are replaced with status checkpoints because repository instructions require explicit user approval before commits.

Type consistency:

- Shared editor props are introduced in Task 1 and consumed by Tasks 3 through 6.
- registerVarsCompletionProvider is introduced in Task 2 and consumed by Memory, Vars, and MCP tasks.
- ConflictEditor public props remain unchanged so Sync integration does not need API changes.
