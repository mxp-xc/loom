import { describe, expect, it } from 'vitest'
import {
  mapProjectionRoots,
  normalizeSourcePath,
  normalizeSourceResources,
  projectionBase,
  resourceSelectionState,
  summarizeSourceTree,
} from '../src/source-tree.js'

describe('SourceTree summary', () => {
  it('counts every node kind recursively', () => {
    expect(
      summarizeSourceTree([
        {
          kind: 'container',
          name: 'root',
          path: 'root',
          mode: '040000',
          oid: 'root',
          children: [
            {
              kind: 'bundle',
              name: 'alpha',
              path: 'root/alpha',
              entry: 'root/alpha/SKILL.md',
              mode: '040000',
              oid: 'alpha',
            },
            {
              kind: 'resource',
              name: 'prompt.md',
              path: 'root/prompt.md',
              mode: '100644',
              oid: 'prompt',
            },
            {
              kind: 'symlink',
              name: 'latest',
              path: 'root/latest',
              mode: '120000',
              oid: 'latest',
            },
            {
              kind: 'submodule',
              name: 'vendor',
              path: 'root/vendor',
              mode: '160000',
              oid: 'vendor',
            },
          ],
        },
      ]),
    ).toEqual({ bundles: 1, containers: 1, resources: 1, symlinks: 1, submodules: 1 })
  })
})

describe('source-relative paths', () => {
  it('normalizes separators while rejecting paths that escape the source', () => {
    expect(normalizeSourcePath('folder\\shared/')).toBe('folder/shared')
    expect(() => normalizeSourcePath('../shared')).toThrow('Invalid source-relative path')
    expect(() => normalizeSourcePath('/shared')).toThrow('Invalid source-relative path')
    expect(() => normalizeSourcePath('folder//shared')).toThrow('Invalid source-relative path')
  })
})

describe('resource selection', () => {
  it('sorts, deduplicates, and removes rules made redundant by an ancestor', () => {
    expect(
      normalizeSourceResources({
        include: [
          { path: 'folder/shared/file.md', kind: 'file' },
          { path: 'folder/shared', kind: 'directory' },
          { path: 'folder/shared', kind: 'directory' },
        ],
      }),
    ).toEqual({
      include: [{ path: 'folder/shared', kind: 'directory' }],
      exclude: [],
    })
  })

  it('uses the most specific rule and lets exclude win at the same path', () => {
    const resources = {
      include: [
        { path: 'folder/shared', kind: 'directory' as const },
        { path: 'folder/shared/archive/keep.md', kind: 'file' as const },
      ],
      exclude: [{ path: 'folder/shared/archive', kind: 'directory' as const }],
    }
    expect(resourceSelectionState('folder/shared/workflow.md', 'file', resources).selected).toBe(
      true,
    )
    expect(resourceSelectionState('folder/shared/archive/old.md', 'file', resources).selected).toBe(
      false,
    )
    expect(
      resourceSelectionState('folder/shared/archive/keep.md', 'file', resources).selected,
    ).toBe(true)

    expect(
      resourceSelectionState('folder/shared/exact.md', 'file', {
        include: [{ path: 'folder/shared/exact.md', kind: 'file' }],
        exclude: [{ path: 'folder/shared/exact.md', kind: 'file' }],
      }),
    ).toEqual({ selected: false, available: true })
  })

  it('marks an exact path unavailable when its persisted kind changed', () => {
    expect(
      resourceSelectionState('folder/shared', 'file', {
        include: [{ path: 'folder/shared', kind: 'directory' }],
      }),
    ).toEqual({ selected: false, available: false })
  })

  it('does not expand a persisted file rule when that path becomes a directory', () => {
    const resources = {
      include: [{ path: 'shared/item', kind: 'file' as const }],
      exclude: [],
    }

    expect(resourceSelectionState('shared/item', 'directory', resources)).toEqual({
      selected: false,
      available: false,
    })
    expect(resourceSelectionState('shared/item/child.md', 'file', resources)).toEqual({
      selected: false,
      available: true,
    })
  })
})

describe('projection root mapping', () => {
  it('removes the longest common parent while retaining each selected root name', () => {
    const roots = ['folder/skill-dir1', 'folder/skill-dir2', 'folder/shared']
    expect(projectionBase(roots)).toBe('folder')
    expect(mapProjectionRoots(roots)).toEqual([
      { sourcePath: 'folder/shared', targetPath: 'shared' },
      { sourcePath: 'folder/skill-dir1', targetPath: 'skill-dir1' },
      { sourcePath: 'folder/skill-dir2', targetPath: 'skill-dir2' },
    ])
  })

  it('retains parents when separate branches contain the same leaf name', () => {
    expect(mapProjectionRoots(['team-a/skill', 'team-b/skill'])).toEqual([
      { sourcePath: 'team-a/skill', targetPath: 'team-a/skill' },
      { sourcePath: 'team-b/skill', targetPath: 'team-b/skill' },
    ])
  })

  it('rejects destinations that differ only by case', () => {
    expect(() => mapProjectionRoots(['folder/A.md', 'folder/a.md'])).toThrow(
      /Projection destination collision:/,
    )
  })

  it('deduplicates equivalent path separators before mapping destinations', () => {
    expect(mapProjectionRoots(['folder\\shared', 'folder/shared'])).toEqual([
      { sourcePath: 'folder/shared', targetPath: 'shared' },
    ])
  })

  it('retains a single selected root name', () => {
    expect(mapProjectionRoots(['folder/shared'])).toEqual([
      { sourcePath: 'folder/shared', targetPath: 'shared' },
    ])
  })
})
