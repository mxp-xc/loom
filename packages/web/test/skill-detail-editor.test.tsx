// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SkillDetailEditor from '../src/views/skills/SkillDetailEditor'
import { api } from '../src/lib/api'
import { agentIds } from '../src/lib/agents'

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

vi.mock('../src/lib/api', () => ({
  api: {
    getSkillContent: vi.fn(),
    saveSkillContent: vi.fn(async () => ({ ok: true })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getSkillContent).mockResolvedValue({ ok: true, content: '# Skill' })
})

describe('SkillDetailEditor', () => {
  it('keeps location metadata without projected links when agents are empty', async () => {
    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-empty-agents"
        agents={[]}
        detail={{
          skillId: 'source-skill',
          source: 'https://example.test/skills.git',
          path: 'source-skill/SKILL.md',
          agents: ['codex'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'source-skill' })
    expect(within(dialog).getByText('https://example.test/skills.git')).toBeDefined()
    expect(within(dialog).getByText('source-skill/SKILL.md')).toBeDefined()
    expect(within(dialog).queryByText('Projected links')).toBeNull()
  })

  it('renders editable local skill metadata and document controls', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValue({
      ok: true,
      content: '# Production skill',
    })

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-workbench"
        agents={agentIds}
        detail={{
          skillId: 'production-skill',
          path: '/skills/production-skill/SKILL.md',
          agents: ['codex'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'production-skill' })
    expect(within(dialog).getByTestId('skill-metadata-pane')).toBeDefined()
    expect(within(dialog).getByTestId('skill-document-pane')).toBeDefined()
    expect(within(dialog).getByText('1 of 3')).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'Preview' })).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'Source' })).toBeDefined()
    expect(
      within(dialog).getByRole('button', { name: 'Save SKILL.md' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('keeps one content frame while SKILL.md is loading', async () => {
    let resolveContent!: (value: { ok: true; content: string }) => void
    vi.mocked(api.getSkillContent).mockImplementationOnce(
      () => new Promise((resolve) => (resolveContent = resolve)),
    )

    render(
      <SkillDetailEditor
        repoPath="/tmp/skills-layout"
        agents={agentIds}
        detail={{
          skillId: 'superpowers/receiving-code-review',
          source: 'https://github.com/obra/superpowers.git',
          path: 'receiving-code-review/SKILL.md',
          agents: ['codex'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', {
      name: 'superpowers/receiving-code-review',
    })
    const contentFrame = within(dialog).getByTestId('skill-detail-content-frame')
    expect(within(dialog).getByText('Loading SKILL.md')).toBeDefined()

    await act(async () => resolveContent({ ok: true, content: '# Loaded skill' }))

    const preview = (await within(dialog).findByText('Loaded skill')).closest('.md-preview')
    expect(contentFrame.contains(preview)).toBe(true)
    expect(within(dialog).queryByRole('button', { name: 'Save SKILL.md' })).toBeNull()
  })

  it('keeps source-managed skills read-only', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValue({
      ok: true,
      content: '# Managed by source',
    })

    render(
      <SkillDetailEditor
        repoPath="/tmp/source-skill"
        agents={agentIds}
        detail={{
          skillId: 'source-skill',
          source: 'https://github.com/example/skills.git',
          path: 'skills/source-skill/SKILL.md',
          agents: ['codex', 'opencode'],
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'source-skill' })
    expect(within(dialog).getByText('Read only')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Source' }))
    expect(within(dialog).getByText('# Managed by source')).toBeDefined()
    expect(within(dialog).queryByRole('textbox', { name: 'SKILL.md 内容' })).toBeNull()
  })

  it('opens an empty local skill directly into the source editor', async () => {
    vi.mocked(api.getSkillContent).mockResolvedValue({ ok: true, content: '' })

    render(
      <SkillDetailEditor
        repoPath="/tmp/empty-local-skill"
        agents={agentIds}
        detail={{ skillId: 'empty-local-skill', path: './skills/empty', agents: [] }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'empty-local-skill' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Start editing' }))
    expect(within(dialog).getByRole('textbox', { name: 'SKILL.md 内容' })).toBeDefined()
  })
})
