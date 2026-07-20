// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AddSkillModal from '../src/views/skills/AddSkillModal'

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

function unreadableFile(path: string, cause: Error): File {
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    text: async () => {
      throw cause
    },
  } as unknown as File
}

function readableFile(path: string, content: string): File {
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    text: async () => content,
  } as unknown as File
}

describe('AddSkillModal directory picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    operations.addLocalSkills.mockResolvedValue({ ok: true })
  })

  it('passes nested skill resources to the external import operation', async () => {
    const onClose = vi.fn()
    render(<AddSkillModal open repoPath="/repo" onClose={onClose} />)
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!

    fireEvent.change(input, {
      target: {
        files: [
          readableFile('workspace/catalog/alpha/SKILL.md', '# Alpha'),
          readableFile('workspace/catalog/alpha/references/deep/guide.md', 'guide'),
        ],
      },
    })

    expect(await screen.findByText('alpha')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '添加 Local Skill' }))

    expect(operations.addLocalSkills).toHaveBeenCalledWith({
      skills: [{ name: 'alpha', path: 'alpha' }],
      pickedExternal: true,
      pickedFiles: new Map([
        [
          'alpha',
          [
            { path: 'SKILL.md', content: '# Alpha' },
            { path: 'references/deep/guide.md', content: 'guide' },
          ],
        ],
      ]),
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('shows and fully logs a picked file read failure', async () => {
    const cause = new Error('permission denied')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<AddSkillModal open repoPath="/repo" onClose={vi.fn()} />)
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!

    fireEvent.change(input, {
      target: { files: [unreadableFile('workspace/alpha/SKILL.md', cause)] },
    })

    expect(await screen.findByText('无法读取 alpha/SKILL.md')).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          name: 'PickedSkillFileReadError',
          path: 'alpha/SKILL.md',
          cause,
        }),
        path: 'alpha/SKILL.md',
      },
      'Failed to read picked skill directory',
    )
    expect(screen.getByRole('button', { name: '添加 Local Skill' }).hasAttribute('disabled')).toBe(
      true,
    )
  })
})
