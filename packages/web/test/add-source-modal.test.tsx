// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AddSkillModal from '../src/views/skills/AddSkillModal'
import { ApiError } from '../src/lib/api'

const operations = vi.hoisted(() => ({
  scanLocalSkills: vi.fn(async () => ({ ok: true, result: { skills: [] } })),
  loadSourceRefs: vi.fn(),
  scanSourceTree: vi.fn(),
  addLocalSkills: vi.fn(),
  addSource: vi.fn(),
}))

vi.mock('../src/hooks/useManifestOperations', () => ({
  useManifestOperations: () => operations,
}))

const sourceTree = {
  commit: 'abc123',
  diagnostics: [],
  nodes: [
    {
      kind: 'bundle' as const,
      name: 'apple-design',
      path: 'skills/apple-design',
      entry: 'skills/apple-design/SKILL.md',
      mode: '100644',
      oid: 'def456',
      description: 'Apple design guidance',
    },
  ],
}

describe('AddSkillModal source failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    operations.scanLocalSkills.mockResolvedValue({ ok: true, result: { skills: [] } })
    operations.scanSourceTree.mockResolvedValue({
      ok: true,
      result: { ok: true, tree: sourceTree },
    })
  })

  it('explains a source cache id conflict instead of the generic state conflict', async () => {
    operations.addSource.mockResolvedValue({
      ok: false,
      message: 'Skills state conflict',
      error: new ApiError('Skills state conflict', 409, 'source_cache_exists', [], {
        details: {
          cacheId: 'mattpocock/skills',
          sourceUrl: 'https://github.com/emilkowski/skills',
          conflictUrl: 'https://github.com/mattpocock/skills',
          conflictName: 'mattpocock-skills',
        },
      }),
    })
    render(<AddSkillModal open repoPath="/repo" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://github.com/emilkowski/skills' },
    })
    expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('skills')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))

    const addButton = await screen.findByRole('button', { name: '添加 Source' })
    await waitFor(() => expect((addButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(addButton)

    expect(
      await screen.findByText(
        '缓存目录 mattpocock/skills 已属于 mattpocock-skills（https://github.com/mattpocock/skills）；同一个仓库不能重复添加',
      ),
    ).toBeDefined()
    expect(screen.queryByText('Skills state conflict')).toBeNull()
  })

  it('normalizes the derived name and rejects an invalid manual name', async () => {
    operations.addSource.mockResolvedValue({ ok: true })
    render(<AddSkillModal open repoPath="/repo" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(screen.getByPlaceholderText('https://host.example/org/repo.git'), {
      target: { value: 'https://github.com/jackwener/OpenCLI' },
    })
    await waitFor(() =>
      expect((screen.getByLabelText('source name') as HTMLInputElement).value).toBe('opencli'),
    )

    fireEvent.change(screen.getByLabelText('source name'), { target: { value: 'OpenCLI' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh repository tree' }))
    const addButton = await screen.findByRole('button', { name: '添加 Source' })
    await waitFor(() => expect((addButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(addButton)

    expect(await screen.findByText('Source name 只能包含小写字母、数字和连字符（-）')).toBeDefined()
    expect(operations.addSource).not.toHaveBeenCalled()
  })
})
