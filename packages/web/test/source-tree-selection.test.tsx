// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceTreeNode } from '@loom/core'
import SourceTreeSelection, {
  type SourceTreeSelectionValue,
} from '../src/views/skills/SourceTreeSelection'

const nodes: SourceTreeNode[] = [
  {
    kind: 'container',
    name: 'folder',
    path: 'folder',
    mode: '040000',
    oid: 'folder-oid',
    children: [
      {
        kind: 'bundle',
        name: 'incident-triage',
        path: 'folder/incident-triage',
        entry: 'folder/incident-triage/SKILL.md',
        description: 'Triage incidents with shared guidance.',
        mode: '040000',
        oid: 'bundle-oid',
      },
      {
        kind: 'container',
        name: 'shared',
        path: 'folder/shared',
        mode: '040000',
        oid: 'shared-oid',
        children: [
          {
            kind: 'resource',
            name: 'workflow.md',
            path: 'folder/shared/workflow.md',
            mode: '100644',
            oid: 'workflow-oid',
          },
          {
            kind: 'resource',
            name: 'severity.md',
            path: 'folder/shared/severity.md',
            mode: '100644',
            oid: 'severity-oid',
          },
        ],
      },
    ],
  },
  {
    kind: 'symlink',
    name: 'latest',
    path: 'latest',
    mode: '120000',
    oid: 'latest-oid',
  },
]

const emptyValue: SourceTreeSelectionValue = {
  memberEntries: new Set(),
  resources: { include: [], exclude: [] },
}

function Harness({ initialValue = emptyValue }: { initialValue?: SourceTreeSelectionValue }) {
  const [value, setValue] = useState(initialValue)
  return (
    <SourceTreeSelection
      nodes={nodes}
      sourceName="workflow-kit"
      value={value}
      onChange={setValue}
    />
  )
}

describe('SourceTreeSelection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens the bundle view by default and updates member entries', () => {
    render(<Harness />)

    expect(screen.getByRole('tab', { name: 'Bundles' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Triage incidents with shared guidance.')).toBeDefined()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select folder/incident-triage' }))

    expect(screen.getByText('1 bundles')).toBeDefined()
    expect(screen.getByText('<agent-skills>/')).toBeDefined()
    expect(screen.getAllByText('incident-triage')).toHaveLength(2)
  })

  it('shows the bundle folder path beside its name and keeps selection separate from viewing', async () => {
    const onOpenBundle = vi.fn()
    const onChange = vi.fn()
    render(
      <SourceTreeSelection
        nodes={nodes}
        sourceName="workflow-kit"
        sourceUrl="https://github.com/example/workflow-kit.git"
        sourceRef="main"
        value={emptyValue}
        onChange={onChange}
        onOpenBundle={onOpenBundle}
      />,
    )

    expect(screen.getByText('folder/incident-triage')).toBeDefined()
    expect(screen.queryByText('folder/incident-triage/SKILL.md')).toBeNull()
    expect(screen.getByRole('link', { name: 'incident-triage' }).getAttribute('href')).toBe(
      'https://github.com/example/workflow-kit/blob/main/folder/incident-triage/SKILL.md',
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select folder/incident-triage' }))
    expect(onOpenBundle).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'View incident-triage' }))
    expect(onOpenBundle).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'folder/incident-triage/SKILL.md' }),
    )

    onOpenBundle.mockClear()
    fireEvent.click(screen.getByRole('listitem'))
    expect(onOpenBundle).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'folder/incident-triage/SKILL.md' }),
    )

    onOpenBundle.mockClear()
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    const bundleName = await screen.findByText('incident-triage')
    expect(screen.queryByRole('link', { name: 'incident-triage' })).toBeNull()
    fireEvent.click(bundleName.parentElement!)
    expect(onOpenBundle).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select folder/incident-triage' }))
    expect(onChange).toHaveBeenCalled()
  })

  it('filters bundles by description and reports no matches', () => {
    render(<Harness />)

    const search = screen.getByRole('textbox', { name: 'Search source contents' })
    fireEvent.change(search, { target: { value: 'shared guidance' } })
    expect(screen.getByText('incident-triage')).toBeDefined()

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('No bundles match')).toBeDefined()
    expect(screen.getByRole('list', { name: 'Skill bundles' }).getAttribute('data-empty')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('incident-triage')).toBeDefined()
    expect(screen.getByRole('list', { name: 'Skill bundles' }).hasAttribute('data-empty')).toBe(
      false,
    )
  })

  it('distinguishes an empty commit while keeping search-empty tree layout stable', () => {
    const { rerender } = render(
      <SourceTreeSelection
        nodes={[]}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText('No skill bundles at this commit')).toBeDefined()
    expect(screen.getByRole('list', { name: 'Skill bundles' }).getAttribute('data-empty')).toBe(
      'true',
    )

    rerender(
      <SourceTreeSelection
        nodes={nodes}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search source contents' }), {
      target: { value: 'does-not-exist' },
    })
    expect(screen.queryByText('No paths match')).toBeNull()
    expect(screen.getByText('Projection preview')).toBeDefined()
  })

  it('shares selection with Tree and exposes mixed parent state', async () => {
    render(
      <Harness
        initialValue={{
          memberEntries: new Set(),
          resources: {
            include: [{ path: 'folder/shared/workflow.md', kind: 'file' }],
            exclude: [],
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))

    const folder = await screen.findByRole('checkbox', { name: 'Select folder' })
    expect((folder as HTMLInputElement).indeterminate).toBe(true)
    expect(screen.getByText('1 resources')).toBeDefined()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search source contents' }), {
      target: { value: 'severity.md' },
    })
    expect(await screen.findByText('severity.md')).toBeDefined()
    expect(screen.getByText('folder')).toBeDefined()
  })

  it('remeasures the real tree viewport whenever the Tree view is mounted', async () => {
    const observers: Array<{
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()

        constructor() {
          observers.push(this)
        }
      },
    )

    render(<Harness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))

    await waitFor(() => expect(observers).toHaveLength(1))
    expect(observers[0].observe).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('tab', { name: 'Bundles' }))
    await waitFor(() => expect(observers[0].disconnect).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    await waitFor(() => expect(observers).toHaveLength(2))
    expect(observers[1].observe).toHaveBeenCalledOnce()
  })

  it('selects and clears all ordinary resources without selecting bundles', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Select resources' }))
    expect(screen.getByText('2 resources')).toBeDefined()
    expect(screen.getByText('0 bundles')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Clear resources' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Clear resources' }))
    await waitFor(() => expect(screen.getByText('0 resources')).toBeDefined())
  })

  it('expands and collapses all tree folders, and disables both controls while searching', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))

    const expand = await screen.findByRole('button', { name: 'Expand all' })
    const collapse = screen.getByRole('button', { name: 'Collapse all' })
    fireEvent.click(collapse)
    await waitFor(() => expect(screen.queryByText('severity.md')).toBeNull())

    fireEvent.click(expand)
    expect(await screen.findByText('severity.md')).toBeDefined()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search source contents' }), {
      target: { value: 'severity' },
    })
    expect((expand as HTMLButtonElement).disabled).toBe(true)
    expect((collapse as HTMLButtonElement).disabled).toBe(true)
  })

  it('toggles a folder from a single row click without treating checkbox clicks as row clicks', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse all' }))
    await waitFor(() => expect(screen.queryByText('incident-triage')).toBeNull())

    const folderToggle = screen.getByRole('button', { name: 'Expand folder' })
    const folderRow = folderToggle.parentElement
    expect(folderRow).not.toBeNull()
    fireEvent.click(folderRow!)
    expect(await screen.findByText('incident-triage')).toBeDefined()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select folder' }))
    expect(screen.getByText('incident-triage')).toBeDefined()

    const expandedFolderRow = screen.getByRole('button', { name: 'Collapse folder' }).parentElement
    expect(expandedFolderRow).not.toBeNull()
    fireEvent.click(expandedFolderRow!)
    await waitFor(() => expect(screen.queryByText('incident-triage')).toBeNull())
  })

  it('stores a mixed directory as one resource rule without selecting its bundles', async () => {
    const onChange = vi.fn()
    render(
      <SourceTreeSelection
        nodes={nodes}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Select resources' }))

    expect(onChange).toHaveBeenCalledWith({
      memberEntries: new Set(),
      resources: { include: [{ path: 'folder', kind: 'directory' }], exclude: [] },
    })
  })

  it('renders loading and actionable error states', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <SourceTreeSelection
        nodes={[]}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={vi.fn()}
        loading
      />,
    )
    expect(screen.getByText('Reading repository tree')).toBeDefined()

    rerender(
      <SourceTreeSelection
        nodes={[]}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={vi.fn()}
        error="The selected commit is unavailable."
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('supports a bundle rooted at the repository without an empty tree id', async () => {
    const rootBundle: SourceTreeNode = {
      kind: 'bundle',
      name: 'workflow-kit',
      path: '',
      entry: 'SKILL.md',
      mode: '040000',
      oid: 'root-oid',
    }
    render(
      <SourceTreeSelection
        nodes={[rootBundle]}
        sourceName="workflow-kit"
        value={{ memberEntries: new Set(['SKILL.md']), resources: emptyValue.resources }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText('1 projection roots')).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'Tree' }))
    expect(await screen.findByRole('checkbox', { name: 'Select SKILL.md' })).toBeDefined()
  })

  it('disables an invalid bundle reported by source tree diagnostics', () => {
    render(
      <SourceTreeSelection
        nodes={nodes}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={vi.fn()}
        diagnostics={[
          {
            code: 'bundle-symlink',
            path: 'folder/incident-triage/latest',
            relatedPaths: ['folder/incident-triage/SKILL.md'],
            message: 'The bundle contains a symlink.',
          },
        ]}
      />,
    )

    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select folder/incident-triage',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true)
    expect(screen.getByText('unavailable')).toBeDefined()
  })

  it('shows and removes persisted resource selections that are missing or changed kind', () => {
    const onChange = vi.fn()
    render(
      <SourceTreeSelection
        nodes={nodes}
        sourceName="workflow-kit"
        value={{
          memberEntries: new Set(),
          resources: {
            include: [
              { path: 'deleted.md', kind: 'file' },
              { path: 'folder/shared/workflow.md', kind: 'directory' },
            ],
            exclude: [],
          },
        }}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('region', { name: 'Unavailable resource selections' })).toBeDefined()
    expect(screen.getByText('deleted.md')).toBeDefined()
    expect(screen.getByText('folder/shared/workflow.md')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable include deleted.md' }))
    expect(onChange).toHaveBeenCalledWith({
      memberEntries: new Set(),
      resources: {
        include: [{ path: 'folder/shared/workflow.md', kind: 'directory' }],
        exclude: [],
      },
    })
  })

  it('does not disable valid descendants referenced by a nested-bundle diagnostic', () => {
    render(
      <SourceTreeSelection
        nodes={nodes}
        sourceName="workflow-kit"
        value={emptyValue}
        onChange={vi.fn()}
        diagnostics={[
          {
            code: 'invalid-nested-bundle',
            path: 'folder/SKILL.md',
            relatedPaths: ['folder/incident-triage/SKILL.md'],
            message: 'The parent candidate contains a nested bundle.',
          },
        ]}
      />,
    )

    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select folder/incident-triage',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false)
  })
})
