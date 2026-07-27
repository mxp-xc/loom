// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SkillDetailEditor from '../src/views/skills/SkillDetailEditor'
import { api } from '../src/lib/api'
import { agentIds } from '../src/lib/agents'
import type { ManifestOperations } from '../src/hooks/useManifestOperations'

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

const operations = {
  pending: { skills: { assignments: false } },
  toggleSourceSkillAgent: vi.fn(async () => ({ ok: true })),
  toggleSourceSkillShared: vi.fn(async () => ({ ok: true })),
  toggleLocalSkillAgent: vi.fn(async () => ({ ok: true })),
  toggleLocalSkillShared: vi.fn(async () => ({ ok: true })),
} as unknown as ManifestOperations

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
        operations={operations}
        detail={{
          skillId: 'source-skill',
          source: 'https://example.test/skills.git',
          memberEntry: 'source-skill/SKILL.md',
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
        operations={operations}
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
    expect(within(dialog).getAllByText('1 of 4')).toHaveLength(2)
    expect(within(dialog).getByRole('tab', { name: 'Preview' })).toBeDefined()
    expect(within(dialog).getByRole('tab', { name: 'Source' })).toBeDefined()
    expect(
      within(dialog).getByRole('button', { name: 'Save SKILL.md' }).hasAttribute('disabled'),
    ).toBe(true)
  })

  it('toggles the shared destination with the complete current assignment', async () => {
    render(
      <SkillDetailEditor
        repoPath="/tmp/shared-detail"
        agents={agentIds}
        operations={operations}
        detail={{
          skillId: 'production-skill',
          path: '/skills/production-skill/SKILL.md',
          agents: ['codex'],
          shared: false,
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'production-skill' })
    expect(within(dialog).getByText('~/.agents/skills/production-skill')).toBeDefined()
    const shared = within(dialog).getByRole('button', { name: '通用：未选择' })
    expect(shared.hasAttribute('data-agent')).toBe(false)

    fireEvent.click(shared)

    expect(operations.toggleLocalSkillShared).toHaveBeenCalledWith('production-skill', {
      agents: ['codex'],
      shared: false,
    })
  })

  it('counts the shared destination in shared-only projected links', async () => {
    render(
      <SkillDetailEditor
        repoPath="/tmp/shared-only-detail"
        agents={[]}
        operations={operations}
        detail={{
          skillId: 'shared-only',
          path: '/skills/shared-only/SKILL.md',
          agents: [],
          shared: true,
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'shared-only' })
    const projectedLinks = within(dialog).getByText('Projected links').closest('section')!
    expect(within(projectedLinks).getByText('1 of 1')).toBeDefined()
    expect(within(projectedLinks).getByText('linked')).toBeDefined()
  })

  it('counts Agent and shared destinations together in mixed projected links', async () => {
    render(
      <SkillDetailEditor
        repoPath="/tmp/mixed-detail"
        agents={agentIds}
        operations={operations}
        detail={{
          skillId: 'mixed-skill',
          path: '/skills/mixed-skill/SKILL.md',
          agents: ['codex'],
          shared: true,
        }}
        showToast={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'mixed-skill' })
    const projectedLinks = within(dialog).getByText('Projected links').closest('section')!
    expect(within(projectedLinks).getByText('2 of 4')).toBeDefined()
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
        operations={operations}
        detail={{
          skillId: 'superpowers/receiving-code-review',
          source: 'https://github.com/obra/superpowers.git',
          memberEntry: 'receiving-code-review/SKILL.md',
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
        operations={operations}
        detail={{
          skillId: 'source-skill',
          source: 'https://github.com/example/skills.git',
          memberEntry: 'skills/source-skill/SKILL.md',
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
        operations={operations}
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
