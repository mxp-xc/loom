# Collection List Picker Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Build a small deep collection/list/picker module for searchable selectable lists, then migrate duplicated Skills source-member picker rows.

Architecture: First iteration intentionally avoids forcing every table/list into DataTable. The new module is a local UI seam for search, empty/no-match state, checkbox rows, select-all/clear-all, selected count, disabled rows, and row metadata. Domain behaviours stay in callers: source scanning, save/project operations, target bulk chips, MCP master-detail selection, and Vars table semantics do not move in this round.

Tech Stack: React 18, TypeScript, Testing Library, Vitest, existing Button primitive, existing CSS tokens, Bun test runner.

## Global Constraints

- User-visible content must be Chinese; code identifiers, commands, and technical names stay in English.
- Do not run git commit, git push, create/switch branch, git reset --hard, or git clean; this plan intentionally uses diff review without commits.
- Use TDD: write failing tests first, run them, implement, then rerun focused tests.
- Use bun for JS/TS commands.
- No new npm dependency in this round.
- Do not migrate MCP master-detail lists, SkillSourceList group rows, Vars tables, target bulk chips, overlay, query, or form framework in this round.
- Preserve current selection semantics: source member select-all/clear-all operates on all enabled members, not only filtered rows; installed/disabled rows cannot be selected by bulk action.
- Preserve existing save semantics: modals still call existing useManifestOperations methods and do not move projection or manifest mutation logic into the UI module.
- Frontend changes must be verified with automated tests; do not ask the user to manually open a browser.

---

## File Structure

- Create: packages/web/src/components/ui/selectable-list.tsx
  - Owns the reusable collection/list/picker interface and implementation.
  - Exports SelectableList, SelectableListItem, selectableItemMatchesQuery, and nextSelectableSelection.
- Create: packages/web/test/selectable-list.test.tsx
  - Component seam tests: search, no-match empty state, disabled row, select all, clear all, hidden selected preservation.
- Modify: packages/web/src/index.css
  - Adds .selectable-list-* classes using existing CSS variables.
- Modify: packages/web/src/views/skills/MemberScanModal.tsx
  - Replaces hand-written selected count, select-all button, checkbox rows, and empty row with SelectableList.
- Modify: packages/web/src/views/skills/EditSourceModal.tsx
  - Replaces search input, selected count, select-all button, checkbox rows, installed badge row rendering, empty/no-match states with SelectableList.
- Modify: packages/web/src/views/skills/AddSkillModal.tsx
  - Replaces local/source skill checkbox result lists and search controls with SelectableList while preserving scanning placeholders.
- Modify: packages/web/test/views.test.tsx
  - Adds integration coverage for source member search/selection semantics after migration.

---

### Task 1: SelectableList module and seam tests

Files:

- Create: packages/web/src/components/ui/selectable-list.tsx
- Create: packages/web/test/selectable-list.test.tsx
- Modify: packages/web/src/index.css

Interfaces:

- Produces:
  - export interface SelectableListItem { id: string; label: React.ReactNode; searchText: string; meta?: React.ReactNode; disabled?: boolean; disabledReason?: string }
  - export function selectableItemMatchesQuery(item: Pick<SelectableListItem, "searchText">, query: string): boolean
  - export function nextSelectableSelection(items: SelectableListItem[], current: ReadonlySet<string>, mode: "all" | "none"): Set<string>
  - export interface SelectableListProps { ariaLabel: string; items: SelectableListItem[]; selectedIds: ReadonlySet<string>; onSelectedIdsChange: (next: Set<string>) => void; searchPlaceholder?: string; showSearch?: boolean; showSelectionActions?: boolean; emptyMessage?: string; noMatchesMessage?: string; className?: string }
  - export function SelectableList(props: SelectableListProps): JSX.Element
- Consumes:
  - Existing Button from @/components/ui/button.
  - Existing CSS variables from index.css.

- [ ] Step 1: Write failing seam tests

Create packages/web/test/selectable-list.test.tsx:

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SelectableList,
  nextSelectableSelection,
  selectableItemMatchesQuery,
  type SelectableListItem,
} from '../src/components/ui/selectable-list'

const items: SelectableListItem[] = [
  { id: 'alpha', label: 'alpha', searchText: 'alpha first' },
  { id: 'beta', label: 'beta', searchText: 'beta second' },
  {
    id: 'installed',
    label: 'installed',
    searchText: 'installed third',
    disabled: true,
    meta: '已安装',
  },
]

describe('SelectableList helpers', () => {
  it('matches search text case-insensitively after trimming', () => {
    expect(selectableItemMatchesQuery(items[0], '  FIRST  ')).toBe(true)
    expect(selectableItemMatchesQuery(items[0], 'missing')).toBe(false)
  })

  it('selects and clears only enabled list items while preserving external selected ids', () => {
    const current = new Set(['external', 'installed'])
    expect([...nextSelectableSelection(items, current, 'all')].sort()).toEqual([
      'alpha',
      'beta',
      'external',
      'installed',
    ])
    expect([...nextSelectableSelection(items, current, 'none')].sort()).toEqual([
      'external',
      'installed',
    ])
  })
})

describe('SelectableList', () => {
  it('filters rows and shows no-match empty state without dropping hidden selection', () => {
    const onChange = vi.fn()
    render(
      <SelectableList
        ariaLabel="skills"
        items={items}
        selectedIds={new Set(['beta'])}
        onSelectedIdsChange={onChange}
        searchPlaceholder="搜索 skill…"
        emptyMessage="没有成员"
        noMatchesMessage="无匹配"
      />,
    )

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'alpha' },
    })

    const list = screen.getByRole('list', { name: 'skills' })
    expect(within(list).getByText('alpha')).toBeDefined()
    expect(within(list).queryByText('beta')).toBeNull()

    fireEvent.click(within(list).getByRole('checkbox', { name: 'alpha' }))
    expect(onChange).toHaveBeenCalledWith(new Set(['alpha', 'beta']))

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 skill…' }), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('无匹配')).toBeDefined()
  })

  it('renders selection actions that select and clear enabled rows only', () => {
    const onChange = vi.fn()
    render(
      <SelectableList
        ariaLabel="members"
        items={items}
        selectedIds={new Set(['external'])}
        onSelectedIdsChange={onChange}
        showSearch={false}
        showSelectionActions
        emptyMessage="没有成员"
      />,
    )

    expect(screen.getByText('已选 0 / 2')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(onChange).toHaveBeenCalledWith(new Set(['external', 'alpha', 'beta']))
  })

  it('marks disabled rows and does not toggle them', () => {
    const onChange = vi.fn()
    render(
      <SelectableList
        ariaLabel="disabled demo"
        items={items}
        selectedIds={new Set()}
        onSelectedIdsChange={onChange}
      />,
    )

    const installed = screen.getByRole('checkbox', { name: 'installed' })
    expect(installed).toBeDisabled()
    expect(screen.getByText('已安装')).toBeDefined()
    fireEvent.click(installed)
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] Step 2: Run test to verify RED

Run:

```bash
bun run test packages/web/test/selectable-list.test.tsx
```

Expected: FAIL because packages/web/src/components/ui/selectable-list.tsx does not exist.

- [ ] Step 3: Implement the module

Create packages/web/src/components/ui/selectable-list.tsx:

```tsx
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SelectableListItem {
  id: string
  label: React.ReactNode
  searchText: string
  meta?: React.ReactNode
  disabled?: boolean
  disabledReason?: string
}

export function selectableItemMatchesQuery(
  item: Pick<SelectableListItem, 'searchText'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return item.searchText.toLowerCase().includes(needle)
}

export function nextSelectableSelection(
  items: SelectableListItem[],
  current: ReadonlySet<string>,
  mode: 'all' | 'none',
): Set<string> {
  const next = new Set(current)
  for (const item of items) {
    if (item.disabled) continue
    if (mode === 'all') next.add(item.id)
    else next.delete(item.id)
  }
  return next
}

export interface SelectableListProps {
  ariaLabel: string
  items: SelectableListItem[]
  selectedIds: ReadonlySet<string>
  onSelectedIdsChange: (next: Set<string>) => void
  searchPlaceholder?: string
  showSearch?: boolean
  showSelectionActions?: boolean
  emptyMessage?: string
  noMatchesMessage?: string
  className?: string
}

export function SelectableList({
  ariaLabel,
  items,
  selectedIds,
  onSelectedIdsChange,
  searchPlaceholder = '搜索…',
  showSearch = true,
  showSelectionActions = false,
  emptyMessage = '没有数据',
  noMatchesMessage = '无匹配',
  className,
}: SelectableListProps) {
  const [query, setQuery] = React.useState('')
  const visibleItems = React.useMemo(
    () => items.filter((item) => selectableItemMatchesQuery(item, query)),
    [items, query],
  )
  const enabledCount = items.filter((item) => !item.disabled).length
  const selectedEnabledCount = items.filter(
    (item) => !item.disabled && selectedIds.has(item.id),
  ).length
  const allEnabledSelected = enabledCount > 0 && selectedEnabledCount === enabledCount
  const selectionButtonLabel = allEnabledSelected ? '全不选' : '全选'

  const toggleItem = (item: SelectableListItem, checked: boolean) => {
    if (item.disabled) return
    const next = new Set(selectedIds)
    if (checked) next.add(item.id)
    else next.delete(item.id)
    onSelectedIdsChange(next)
  }

  const toggleAll = () => {
    onSelectedIdsChange(
      nextSelectableSelection(items, selectedIds, allEnabledSelected ? 'none' : 'all'),
    )
  }

  return (
    <section className={cn('selectable-list', className)} aria-label={ariaLabel}>
      {showSearch && (
        <label className="selectable-list-search">
          <span className="sr-only">{searchPlaceholder}</span>
          <input
            type="search"
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {showSelectionActions && items.length > 0 && (
        <div className="selectable-list-actions">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={toggleAll}
            disabled={enabledCount === 0}
          >
            {selectionButtonLabel}
          </Button>
          <span>
            已选 {selectedEnabledCount} / {enabledCount}
          </span>
        </div>
      )}
      <div className="selectable-list-rows" role="list" aria-label={ariaLabel}>
        {items.length === 0 ? (
          <div className="selectable-list-empty">{emptyMessage}</div>
        ) : visibleItems.length === 0 ? (
          <div className="selectable-list-empty">{noMatchesMessage}</div>
        ) : (
          visibleItems.map((item) => (
            <label
              key={item.id}
              className={cn('selectable-list-row', item.disabled && 'is-disabled')}
              title={item.disabledReason}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(item.id)}
                disabled={item.disabled}
                onChange={(event) => toggleItem(item, event.target.checked)}
              />
              <span className="selectable-list-label">{item.label}</span>
              {item.meta && <span className="selectable-list-meta">{item.meta}</span>}
            </label>
          ))
        )}
      </div>
    </section>
  )
}
```

Add CSS to packages/web/src/index.css near existing shared UI classes:

```css
.selectable-list {
  display: grid;
  gap: 8px;
}

.selectable-list-search {
  display: block;
}

.selectable-list-search input {
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  font-family: 'JetBrains Mono', monospace;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  outline: none;
}

.selectable-list-search input:focus {
  border-color: var(--primary);
}

.selectable-list-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
}

.selectable-list-rows {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-height: 280px;
  overflow: auto;
}

.selectable-list-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.selectable-list-row:last-child {
  border-bottom: 0;
}

.selectable-list-row.is-disabled {
  cursor: default;
  opacity: 0.5;
}

.selectable-list-label {
  flex: 1;
  min-width: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

.selectable-list-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
}

.selectable-list-empty {
  padding: 12px 10px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--muted);
}
```

- [ ] Step 4: Run focused test to verify GREEN

Run:

```bash
bun run test packages/web/test/selectable-list.test.tsx
```

Expected: PASS, all SelectableList tests pass.

- [ ] Step 5: Report diff without committing

Run:

```bash
git diff -- packages/web/src/components/ui/selectable-list.tsx packages/web/test/selectable-list.test.tsx packages/web/src/index.css
```

Expected: diff contains only Task 1 files. Do not commit.

---

### Task 2: Migrate MemberScanModal and EditSourceModal

Files:

- Modify: packages/web/src/views/skills/MemberScanModal.tsx
- Modify: packages/web/src/views/skills/EditSourceModal.tsx
- Modify: packages/web/test/views.test.tsx

Interfaces:

- Consumes from Task 1:
  - SelectableList
  - SelectableListItem
- Produces:
  - Member scan modal still calls saveSourceMembers(source, selectedNames).
  - Edit source modal still calls saveSource({ source, ref, type, members: [...selected] }).
  - Search/filter and selection UI now live behind SelectableList.

- [ ] Step 1: Write failing integration tests

In packages/web/test/views.test.tsx, add this import next to the other Skills imports:

```tsx
import MemberScanModal from '../src/views/skills/MemberScanModal'
```

Add this harness near EditSourceSwitchHarness:

```tsx
function MemberScanModalHarness({ source, repoPath }: { source: any; repoPath: string }) {
  const operations = useManifestOperations(repoPath)
  return (
    <MemberScanModal
      source={source}
      operations={operations}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
}
```

Then add tests near existing edit/source modal tests.

Test A, hidden selection survives filtering in EditSourceModal:

```tsx
it('keeps hidden selected source members while filtering Edit Source members', async () => {
  vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
    ok: true,
    branches: ['main'],
    tags: [],
  } as never)
  vi.mocked(api.scanSource).mockResolvedValueOnce({
    ok: true,
    members: [
      { name: 'alpha', path: 'alpha/SKILL.md', installed: false },
      { name: 'beta', path: 'beta/SKILL.md', installed: false },
    ],
  } as never)

  render(<EditSourceSwitchHarness />)

  fireEvent.click(screen.getByRole('button', { name: 'open alpha' }))
  const dialog = await screen.findByRole('dialog', { name: /Edit Source/ })

  fireEvent.change(within(dialog).getByRole('searchbox', { name: '搜索 skill…' }), {
    target: { value: 'alpha' },
  })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'alpha' }))
  fireEvent.change(within(dialog).getByRole('searchbox', { name: '搜索 skill…' }), {
    target: { value: 'beta' },
  })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'beta' }))
  fireEvent.click(within(dialog).getByRole('button', { name: /保存/ }))

  await waitFor(() =>
    expect(api.setSourceMembers).toHaveBeenCalledWith({
      repo: '/tmp/edit-switch',
      url: 'https://example.test/alpha.git',
      members: ['alpha', 'beta'],
    }),
  )
})
```

Test B, scan modal select all and clear all use shared list:

```tsx
it('selects and clears all scanned members in MemberScanModal through the shared list', async () => {
  const source = {
    url: 'https://example.test/source.git',
    ref: 'main',
    members: [{ name: 'alpha', targets: ['codex'] }],
  } as any
  vi.mocked(api.refreshSource).mockResolvedValueOnce({
    ok: true,
    members: [
      { name: 'alpha', path: 'alpha/SKILL.md' },
      { name: 'beta', path: 'beta/SKILL.md' },
    ],
  } as never)

  render(<MemberScanModalHarness source={source} repoPath="/tmp/member-scan-shared-list" />)

  const dialog = await screen.findByRole('dialog', { name: 'Scan · example.test/source' })
  expect(within(dialog).getByText('已选 1 / 2')).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: '全选' }))
  expect(within(dialog).getByText('已选 2 / 2')).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: '全不选' }))
  expect(within(dialog).getByText('已选 0 / 2')).toBeDefined()
})
```

- [ ] Step 2: Run tests to verify RED

Run:

```bash
bun run test packages/web/test/views.test.tsx -t "hidden selected source members|selects and clears all scanned members"
```

Expected: FAIL until the shared list search/selection controls are available in these modals.

- [ ] Step 3: Migrate MemberScanModal

Import:

```tsx
import { SelectableList, type SelectableListItem } from '@/components/ui/selectable-list'
```

Create items and render:

```tsx
const listItems: SelectableListItem[] = members.map((member) => ({
  id: member.name,
  label: member.name,
  searchText: member.name,
}))

<SelectableList
  ariaLabel={'Scan · ' + (source ? sourceIdentity(source).repoId : '')}
  items={listItems}
  selectedIds={selected}
  onSelectedIdsChange={setSelected}
  showSearch={false}
  showSelectionActions
  emptyMessage="未发现任何 SKILL.md"
/>
```

Keep Modal, scan lifecycle, saving state, and footer buttons unchanged.

- [ ] Step 4: Migrate EditSourceModal

Import SelectableList and build items:

```tsx
const listItems: SelectableListItem[] = members.map((member) => ({
  id: member.name,
  label: member.name,
  searchText: member.name,
  disabled: member.installed,
  meta: member.installed ? '已安装' : undefined,
}))
```

Render:

```tsx
<SelectableList
  ariaLabel={'Edit Source · ' + repoId}
  items={listItems}
  selectedIds={selected}
  onSelectedIdsChange={setSelected}
  searchPlaceholder="搜索 skill…"
  showSearch={members.length > 0}
  showSelectionActions={members.length > 0}
  emptyMessage="未发现 SKILL.md"
  noMatchesMessage="无匹配"
/>
```

Keep saveSource unchanged. Preserve members sorting and pre-selection.

- [ ] Step 5: Run focused tests to verify GREEN

Run:

```bash
bun run test packages/web/test/selectable-list.test.tsx packages/web/test/views.test.tsx -t "SelectableList|hidden selected source members|selects and clears all scanned members|selects all source members|clears selected source members"
```

Expected: PASS.

- [ ] Step 6: Report diff without committing

Run:

```bash
git diff -- packages/web/src/views/skills/MemberScanModal.tsx packages/web/src/views/skills/EditSourceModal.tsx packages/web/test/views.test.tsx
```

Expected: diff contains only Task 2 files plus imports/usages. Do not commit.

---

### Task 3: Migrate AddSkillModal local/source result lists

Files:

- Modify: packages/web/src/views/skills/AddSkillModal.tsx
- Modify: packages/web/test/views.test.tsx

Interfaces:

- Consumes from Task 1:
  - SelectableList
  - SelectableListItem
- Produces:
  - Local scan selected names still feed handleAddLocal.
  - Source scan selected names still feed handleAddSource.
  - Installed source members remain disabled and cannot be selected.

- [ ] Step 1: Write failing integration tests

Add tests for AddSkillModal:

Add these methods to the vi.mock('../src/lib/api') block before writing the tests:

```tsx
importLocalSkills: vi.fn(async () => ({ ok: true, count: 1 })),
writeLocalSkills: vi.fn(async () => ({ ok: true, count: 1 })),
```

```tsx
it('filters local skill scan results through the shared selectable list', async () => {
  vi.mocked(api.scanLocalSkills).mockResolvedValueOnce({
    ok: true,
    skills: [
      { name: 'alpha-skill', path: '/skills/alpha/SKILL.md' },
      { name: 'beta-skill', path: '/skills/beta/SKILL.md' },
    ],
  } as never)

  render(<AddSkillModal open repoPath="/tmp/add-local-filter" onClose={vi.fn()} />)

  await screen.findByText('alpha-skill')
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索 skill…' }), {
    target: { value: 'beta' },
  })

  expect(screen.queryByText('alpha-skill')).toBeNull()
  expect(screen.getByText('beta-skill')).toBeDefined()
  fireEvent.click(screen.getByRole('checkbox', { name: 'beta-skill' }))
  fireEvent.click(screen.getByRole('button', { name: '添加 Local Skill' }))

  await waitFor(() =>
    expect(api.importLocalSkills).toHaveBeenCalledWith({
      repo: '/tmp/add-local-filter',
      skills: [{ name: 'beta-skill', path: '/skills/beta/SKILL.md' }],
      mode: 'ref',
    }),
  )
})

it('keeps installed source members disabled in Add Source scan results', async () => {
  vi.mocked(api.getSourceRefs).mockResolvedValueOnce({
    ok: true,
    branches: ['main'],
    tags: [],
  } as never)
  vi.mocked(api.scanSource).mockResolvedValueOnce({
    ok: true,
    members: [
      { name: 'fresh', description: '', path: 'fresh/SKILL.md', installed: false },
      { name: 'installed', description: '', path: 'installed/SKILL.md', installed: true },
    ],
  } as never)

  render(<AddSkillModal open repoPath="/tmp/add-source-disabled" onClose={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: 'Source' }))
  fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
    target: { value: 'https://example.test/source.git' },
  })
  fireEvent.blur(screen.getByPlaceholderText('https://github.com/org/repo'))
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }))

  await screen.findByText('fresh')
  const installed = screen.getByRole('checkbox', { name: 'installed' })
  expect(installed).toBeDisabled()
})
```

- [ ] Step 2: Run tests to verify RED

Run:

```bash
bun run test packages/web/test/views.test.tsx -t "filters local skill scan results|installed source members disabled"
```

Expected: FAIL until AddSkillModal uses the shared list with accessible searchbox and disabled row semantics.

- [ ] Step 3: Migrate local skills list

Import SelectableList and build items:

```tsx
const localListItems: SelectableListItem[] = localSkills.map((skill) => ({
  id: skill.name,
  label: skill.name,
  searchText: skill.name,
  meta: 'SKILL.md',
}))
```

Replace local SearchInput, filteredLocal, and hand-written rows with:

```tsx
<SelectableList
  ariaLabel="Local Skill"
  items={localListItems}
  selectedIds={localSelected}
  onSelectedIdsChange={setLocalSelected}
  searchPlaceholder="搜索 skill…"
  showSearch={localSkills.length > 0}
  emptyMessage="未发现 SKILL.md"
  noMatchesMessage="无匹配"
/>
```

Keep scanning placeholder outside when localScanning is true. Preserve pickedExternal, handleBrowsePick, and handleAddLocal.

- [ ] Step 4: Migrate source members list

Build items:

```tsx
const sourceListItems: SelectableListItem[] = srcMembers.map((member) => ({
  id: member.name,
  label: member.name,
  searchText: member.name,
  disabled: member.installed,
  meta: member.installed ? '已安装' : undefined,
}))
```

Replace SearchInput, filteredSrc, and hand-written rows with:

```tsx
<SelectableList
  ariaLabel="Source members"
  items={sourceListItems}
  selectedIds={srcSelected}
  onSelectedIdsChange={setSrcSelected}
  searchPlaceholder="搜索 skill…"
  showSearch={srcMembers.length > 0}
  emptyMessage="未发现 SKILL.md"
  noMatchesMessage="无匹配"
/>
```

Keep scan button, ref selector, and final Add Source button unchanged.

- [ ] Step 5: Run focused tests to verify GREEN

Run:

```bash
bun run test packages/web/test/views.test.tsx -t "Add Skill|filters local skill scan results|installed source members disabled"
```

Expected: PASS for Add Skill modal behaviours.

- [ ] Step 6: Run full web test suite

Run:

```bash
bun run test packages/web/test
```

Expected: PASS. If any existing Testing Library test fails due accessible label changes, preserve old accessible names unless the new test explicitly requires the new list seam.

- [ ] Step 7: Report diff without committing

Run:

```bash
git diff -- packages/web/src/views/skills/AddSkillModal.tsx packages/web/test/views.test.tsx
```

Expected: diff contains only AddSkillModal migration and tests. Do not commit.

---

### Task 4: Final verification and architecture re-analysis input

Files:

- Modify only if needed after verification: packages/web/test/views.test.tsx, packages/web/test/selectable-list.test.tsx, packages/web/src/components/ui/selectable-list.tsx, packages/web/src/index.css, packages/web/src/views/skills/*.tsx

Interfaces:

- Consumes all previous task outputs.
- Produces fresh verification evidence and concise facts for the next improve-codebase-architecture pass.

- [ ] Step 1: Run full test suite

Run:

```bash
bun run test
```

Expected: PASS with all test files passing and no new warnings from this change.

- [ ] Step 2: Run format check

Run:

```bash
bun run format:check
```

Expected: PASS. If it fails only because modified files need formatting, run bun run format, then rerun bun run format:check.

- [ ] Step 3: Inspect final diff

Run:

```bash
git status --short
git diff --stat
git diff -- packages/web/src/components/ui/selectable-list.tsx packages/web/src/index.css packages/web/src/views/skills/MemberScanModal.tsx packages/web/src/views/skills/EditSourceModal.tsx packages/web/src/views/skills/AddSkillModal.tsx packages/web/test/selectable-list.test.tsx packages/web/test/views.test.tsx
```

Expected: changed files are limited to the planned files. No commit.

- [ ] Step 4: Prepare re-analysis facts

Record these facts for the controller architecture re-analysis:

```text
Round 1 implemented collection/list/picker seam:
- New module: packages/web/src/components/ui/selectable-list.tsx
- Migrated: MemberScanModal, EditSourceModal, AddSkillModal
- Not migrated by design: DataTable, MCP master-detail, SkillSourceList grouped rows, Vars tables, target bulk chips
- Verification: bun run test, bun run format:check
```

- [ ] Step 5: Report status without committing

Final task report must include:

- Commands run and exact pass/fail result.
- Any remaining architectural concerns.
- Confirmation that no commit was created.
