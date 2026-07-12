// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Vars from '../src/views/vars/Vars'
import { useProfileVars } from '../src/views/vars/useProfileVars'
import { api } from '../src/lib/api'
import { createMonacoEditorMock } from './monaco-test-utils'

const monacoEditorMock = createMonacoEditorMock()

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

vi.mock('../src/lib/api', () => ({
  api: {
    getManifest: vi.fn(),
    vars: {
      getMatrix: vi.fn(),
      setBaseKey: vi.fn(),
      setOverride: vi.fn(),
      clearOverride: vi.fn(),
    },
  },
}))

const matrix = (agent = 'codex') => ({
  ok: true as const,
  agent,
  builtinKeys: ['LOOM_AGENT', 'LOOM_CONFIG_DIR'],
  userKeys: ['agent_name', 'json_text', 'yaml_text', 'memory.context', 'rtk_path', 'rtk'],
  snapshot: {
    base: {
      agent_name: { type: 'string' as const, format: 'markdown' as const, value: 'Agent' },
      json_text: { type: 'string' as const, format: 'json' as const, value: '{"b":2,"a":1}' },
      yaml_text: { type: 'string' as const, format: 'yaml' as const, value: 'enabled: true' },
      'memory.context': {
        type: 'string' as const,
        format: 'markdown' as const,
        value: 'Base memory',
      },
      rtk_path: {
        type: 'string' as const,
        format: 'markdown' as const,
        value: '${LOOM_CONFIG_DIR}/RTK.md',
      },
      rtk: { type: 'string' as const, format: 'markdown' as const, value: '# RTK\n\nHello' },
    },
    baseAgent: {},
    local: {},
    localAgent: agent === 'codex' ? { agent_name: { value: 'Local Codex agent' } } : {},
  },
  resolution: {
    ok: true as const,
    values: {
      LOOM_AGENT: { type: 'string' as const, value: agent },
      LOOM_CONFIG_DIR: { type: 'string' as const, format: 'path' as const, value: '/agent' },
      agent_name: {
        type: 'string' as const,
        format: 'markdown' as const,
        value: agent === 'codex' ? 'Local Codex agent' : 'Agent',
      },
      json_text: { type: 'string' as const, format: 'json' as const, value: '{"b":2,"a":1}' },
      yaml_text: { type: 'string' as const, format: 'yaml' as const, value: 'enabled: true' },
      'memory.context': {
        type: 'string' as const,
        format: 'markdown' as const,
        value: 'Base memory',
      },
      rtk_path: {
        type: 'string' as const,
        format: 'markdown' as const,
        value: '/agent/RTK.md',
      },
      rtk: { type: 'string' as const, format: 'markdown' as const, value: '# RTK\n\nHello' },
    },
    sources: {
      LOOM_AGENT: { locality: 'builtin' as const, layer: 'runtime' as const, agent },
      LOOM_CONFIG_DIR: { locality: 'builtin' as const, layer: 'runtime' as const, agent },
      agent_name:
        agent === 'codex'
          ? { locality: 'local' as const, layer: 'agent' as const, agent }
          : { locality: 'synced' as const, layer: 'base' as const },
      rtk: { locality: 'synced' as const, layer: 'base' as const },
      rtk_path: { locality: 'synced' as const, layer: 'base' as const },
      json_text: { locality: 'synced' as const, layer: 'base' as const },
      yaml_text: { locality: 'synced' as const, layer: 'base' as const },
      'memory.context': { locality: 'synced' as const, layer: 'base' as const },
    },
    overrideChains: {
      LOOM_AGENT: [{ locality: 'builtin' as const, layer: 'runtime' as const, agent }],
      LOOM_CONFIG_DIR: [{ locality: 'builtin' as const, layer: 'runtime' as const, agent }],
      agent_name:
        agent === 'codex'
          ? [
              { locality: 'synced' as const, layer: 'base' as const },
              { locality: 'local' as const, layer: 'agent' as const, agent },
            ]
          : [{ locality: 'synced' as const, layer: 'base' as const }],
      rtk: [{ locality: 'synced' as const, layer: 'base' as const }],
      rtk_path: [{ locality: 'synced' as const, layer: 'base' as const }],
      json_text: [{ locality: 'synced' as const, layer: 'base' as const }],
      yaml_text: [{ locality: 'synced' as const, layer: 'base' as const }],
      'memory.context': [{ locality: 'synced' as const, layer: 'base' as const }],
    },
    dependencies: {
      rtk: [],
      rtk_path: ['LOOM_CONFIG_DIR'],
      json_text: [],
      yaml_text: [],
      'memory.context': [],
      agent_name: [],
      LOOM_AGENT: [],
      LOOM_CONFIG_DIR: [],
    },
    diagnostics: [],
  },
})

describe('Vars view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    monacoEditorMock.reset()
    localStorage.clear()
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => matrix(agent))
    vi.mocked(api.vars.setBaseKey).mockResolvedValue({ ok: true })
    vi.mocked(api.vars.setOverride).mockResolvedValue({ ok: true })
    vi.mocked(api.vars.clearOverride).mockResolvedValue({ ok: true })
    vi.mocked(api.getManifest).mockResolvedValue({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex'] },
      errors: [],
    } as never)
  })

  it('loads Vars in profile-first configuration view', async () => {
    render(<Vars repoPath="/repo" />)

    expect(await screen.findByRole('button', { name: /Local/ })).toBeDefined()
    expect(screen.getByRole('button', { name: '配置管理' })).toBeDefined()
    expect(screen.getByRole('button', { name: '最终结果' })).toBeDefined()
    expect(screen.getByText('runtime')).toBeDefined()
    expect(screen.getAllByText('locked').length).toBeGreaterThan(0)
    expect(screen.getByText('local')).toBeDefined()
    expect(screen.getByRole('button', { name: /Base/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByText('agent_name')).toBeDefined()
    expect(screen.getByText('Agent')).toBeDefined()
  })

  it('shows default configuration values while listing only Settings targets', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    const defaultScope = screen.getByRole('button', { name: 'default' })
    expect(defaultScope.getAttribute('data-state')).toBe('on')
    const targetChips = screen.getByLabelText('目标 agent')
    expect(within(targetChips).getByRole('button', { name: 'CX' })).toBeDefined()
    expect(within(targetChips).queryByRole('button', { name: 'CC' })).toBeNull()
    expect(within(targetChips).queryByRole('button', { name: 'OC' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Local/ }))
    await waitFor(() => {
      const row = screen.getByRole('row', { name: /agent_name/ })
      expect(row.textContent).toContain('未配置')
      expect(row.textContent).toContain('CX')
      expect(row.textContent).not.toContain('Local Codex agent')
    })
  })

  it('switches configuration current values by target without leaving the current tab', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex', 'opencode'] },
      errors: [],
    } as never)
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent)
      if (agent === 'opencode')
        return {
          ...response,
          snapshot: {
            ...response.snapshot,
            localAgent: { agent_name: { value: 'Local OC agent' } },
          },
        }
      return response
    })

    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))

    await waitFor(() => {
      const row = screen.getByRole('row', { name: /agent_name/ })
      expect(row.textContent).toContain('未配置')
      expect(row.textContent).toContain('OC')
    })

    fireEvent.click(within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'OC' }))

    expect(screen.getByRole('button', { name: '配置管理' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    await waitFor(() => {
      const row = screen.getByRole('row', { name: /agent_name/ })
      expect(row.textContent).toContain('Local OC agent')
      expect(row.textContent).not.toContain('未配置')
    })
  })

  it('defaults to Base when no profile was previously selected', async () => {
    render(<Vars repoPath="/repo" />)

    const baseProfile = await screen.findByRole('button', { name: /Base/ })

    expect(baseProfile.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('heading', { level: 2, name: 'Base' })).toBeDefined()
  })

  it('restores the last selected profile for the repo', async () => {
    const { unmount } = render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))

    unmount()
    render(<Vars repoPath="/repo" />)

    const localProfile = await screen.findByRole('button', { name: /Local/ })
    expect(localProfile.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('heading', { level: 2, name: 'Local' })).toBeDefined()
  })

  it('renders type beside key and hides default from agent-specific slots', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))
    await screen.findByText('agent_name')

    const row = screen.getByRole('row', { name: /agent_name/ })
    expect(row.textContent).toContain('string')
    expect(row.textContent).toContain('markdown')
    expect(row.textContent).toContain('CX')
    expect(row.textContent).not.toContain('default')
  })

  it('loads all agent matrices through the profile vars hook', async () => {
    function ProfileVarsHarness() {
      const { loading } = useProfileVars('/repo')
      return <div>{loading ? 'loading' : 'loaded'}</div>
    }

    render(<ProfileVarsHarness />)

    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledTimes(3))
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'claude-code')
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex')
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'opencode')
  })

  it('shows final resolved values for the selected agent', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    expect(screen.getByText('当前 agent 的最终变量')).toBeDefined()
    const resolvedTable = screen.getByRole('region', { name: '解析结果' })
    const agentNameRow = within(resolvedTable).getByRole('row', { name: /agent_name/ })
    expect(agentNameRow.textContent).toContain('Local Codex agent')
    expect(agentNameRow.textContent).toContain('local/codex')
    expect(
      within(agentNameRow)
        .getByRole('button', { name: 'agent_name 详情稍后接入' })
        .hasAttribute('disabled'),
    ).toBe(true)
  })

  it('uses the first Settings target as the initial resolved-result agent', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['claude-code'] },
      errors: [],
    } as never)

    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    expect(screen.getByRole('button', { name: 'default' }).getAttribute('data-state')).toBe('on')
    const targetChips = screen.getByLabelText('目标 agent')
    expect(within(targetChips).getByRole('button', { name: 'CC' })).toBeDefined()
    expect(within(targetChips).queryByRole('button', { name: 'CX' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    expect(screen.getByRole('button', { name: 'default' }).getAttribute('data-state')).toBe('on')
    expect(within(targetChips).getByRole('button', { name: 'CC' }).getAttribute('data-state')).toBe(
      'off',
    )
  })

  it('keeps the active tab when changing the view scope chips', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex', 'opencode'] },
      errors: [],
    } as never)

    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))
    fireEvent.click(screen.getByRole('button', { name: 'default' }))
    expect(screen.getByRole('button', { name: '最终结果' }).getAttribute('aria-pressed')).toBe(
      'true',
    )

    fireEvent.click(within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'OC' }))
    expect(screen.getByRole('button', { name: '最终结果' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('keeps agent switching in one top-level control on the resolved view', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    expect(screen.getByLabelText('目标 agent')).toBeDefined()
    expect(screen.queryByLabelText('最终结果 agent')).toBeNull()
  })

  it('uses clearer column names and centers the actions column', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    expect(screen.getByRole('columnheader', { name: /^专属/ })).toBeDefined()
    const actionsHeader = screen.getByRole('columnheader', { name: /^操作/ })
    expect(actionsHeader.className).toContain('vars-col-actions')
  })

  it('refreshes final resolved values when switching agent', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex', 'claude-code'] },
      errors: [],
    } as never)
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')
    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    fireEvent.click(within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'CC' }))

    const resolvedTable = screen.getByRole('region', { name: '解析结果' })
    const agentNameRow = within(resolvedTable).getByRole('row', { name: /agent_name/ })
    expect(agentNameRow.textContent).toContain('Agent')
    expect(agentNameRow.textContent).toContain('base')
    expect(agentNameRow.textContent).not.toContain('Local Codex agent')
  })

  it('returns final resolved values to the default target when selecting default scope', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { targets: ['codex', 'opencode'] },
      errors: [],
    } as never)
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')
    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    fireEvent.click(within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'OC' }))
    fireEvent.click(screen.getByRole('button', { name: 'default' }))

    const resolvedTable = screen.getByRole('region', { name: '解析结果' })
    const agentNameRow = within(resolvedTable).getByRole('row', { name: /agent_name/ })
    expect(agentNameRow.textContent).toContain('Local Codex agent')
    expect(agentNameRow.textContent).toContain('local/codex')
  })

  it('opens edit modal and saves a local agent config', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))
    await screen.findByText('agent_name')
    fireEvent.click(within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'CX' }))

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))

    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
    const editor = screen.getByRole('textbox', { name: /配置值/ })
    fireEvent.change(editor, { target: { value: 'Local Codex v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.vars.setOverride).toHaveBeenCalledWith(
        '/repo',
        'local-agent',
        'agent_name',
        { value: 'Local Codex v2' },
        'codex',
      ),
    )
  })

  it('chooses Monaco language by markdown, json, and yaml config formats', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
    expect(monacoEditorMock.props.at(-1)?.language).toBe('markdown')
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑配置' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '编辑 json_text' }))
    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
    expect(monacoEditorMock.props.at(-1)?.language).toBe('json')
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑配置' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '编辑 yaml_text' }))
    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
    expect(monacoEditorMock.props.at(-1)?.language).toBe('yaml')
  })

  it('reads and saves a non-active agent slot from that agent matrix', async () => {
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent)
      if (agent === 'codex')
        return {
          ...response,
          snapshot: {
            ...response.snapshot,
            localAgent: {},
          },
        }
      if (agent === 'claude-code')
        return {
          ...response,
          snapshot: {
            ...response.snapshot,
            localAgent: { agent_name: { value: 'Local CC agent' } },
          },
        }
      return response
    })

    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    fireEvent.click(
      within(within(dialog).getByLabelText('配置槽位')).getByRole('button', { name: 'CC' }),
    )

    expect((screen.getByRole('textbox', { name: /配置值/ }) as HTMLTextAreaElement).value).toBe(
      'Local CC agent',
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.vars.setOverride).toHaveBeenCalledWith(
        '/repo',
        'local-agent',
        'agent_name',
        { value: 'Local CC agent' },
        'claude-code',
      ),
    )
  })

  it('opens new local config with searchable Base key picker', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))

    fireEvent.click(screen.getByRole('button', { name: '显示可配置项' }))
    fireEvent.click(screen.getByRole('button', { name: '新建 memory.context 配置' }))

    expect(await screen.findByRole('dialog', { name: '新建配置' })).toBeDefined()
    expect(screen.getByPlaceholderText('搜索 key / format')).toBeDefined()
    expect(screen.getByRole('option', { name: /memory\.context/ })).toBeDefined()
  })

  it('creates a new Base key with a selectable type', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByRole('button', { name: /Base/ })

    fireEvent.click(screen.getByRole('button', { name: /Base/ }))
    fireEvent.click(screen.getByRole('button', { name: '新建变量' }))

    const dialog = await screen.findByRole('dialog', { name: '新建配置' })
    fireEvent.change(within(dialog).getByLabelText('key'), { target: { value: 'max_items' } })
    fireEvent.change(within(dialog).getByLabelText('类型'), { target: { value: 'number' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /配置值/ }), {
      target: { value: '42' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.vars.setBaseKey).toHaveBeenCalledWith('/repo', 'max_items', {
        type: 'number',
        value: 42,
      }),
    )
  })

  it('keeps a new Base secret on password input and saves without Monaco', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByRole('button', { name: /Base/ })

    fireEvent.click(screen.getByRole('button', { name: /Base/ }))
    fireEvent.click(screen.getByRole('button', { name: '新建变量' }))

    const dialog = await screen.findByRole('dialog', { name: '新建配置' })
    fireEvent.change(within(dialog).getByLabelText('key'), { target: { value: 'api_secret' } })
    fireEvent.change(within(dialog).getByLabelText('类型'), { target: { value: 'secret' } })
    const secretInput = within(dialog).getByLabelText(/配置值/) as HTMLInputElement
    expect(secretInput.type).toBe('password')
    expect(within(dialog).queryByRole('textbox', { name: /配置值/ })).toBeNull()

    fireEvent.change(secretInput, { target: { value: 'new-secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '原始预览' }))
    expect(within(dialog).queryByText('new-secret')).toBeNull()
    expect(within(dialog).getByText('••••••••')).toBeDefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))
    expect(within(dialog).queryByText('new-secret')).toBeNull()
    expect(within(dialog).getByText('••••••••')).toBeDefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '编辑' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.vars.setBaseKey).toHaveBeenCalledWith('/repo', 'api_secret', {
        type: 'secret',
        value: 'new-secret',
      }),
    )
  })

  it('keeps an edited secret config on password input and saves without Monaco', async () => {
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent)
      return {
        ...response,
        userKeys: [...response.userKeys, 'api_secret'],
        snapshot: {
          ...response.snapshot,
          base: {
            ...response.snapshot.base,
            api_secret: { type: 'secret' as const, value: 'existing-secret' },
          },
        },
        resolution: {
          ...response.resolution,
          values: {
            ...response.resolution.values,
            api_secret: { type: 'secret' as const, value: 'existing-secret' },
          },
          sources: {
            ...response.resolution.sources,
            api_secret: { locality: 'synced' as const, layer: 'base' as const },
          },
          overrideChains: {
            ...response.resolution.overrideChains,
            api_secret: [{ locality: 'synced' as const, layer: 'base' as const }],
          },
          dependencies: {
            ...response.resolution.dependencies,
            api_secret: [],
          },
        },
      }
    })

    render(<Vars repoPath="/repo" />)
    await screen.findByText('api_secret')

    fireEvent.click(screen.getByRole('button', { name: '编辑 api_secret' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    const secretInput = within(dialog).getByLabelText(/配置值/) as HTMLInputElement
    expect(secretInput.type).toBe('password')
    expect(within(dialog).queryByRole('textbox', { name: /配置值/ })).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: '原始预览' }))
    expect(within(dialog).queryByText('existing-secret')).toBeNull()
    expect(within(dialog).getByText('••••••••')).toBeDefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '编辑' }))
    const editedSecretInput = within(dialog).getByLabelText(/配置值/) as HTMLInputElement
    fireEvent.change(editedSecretInput, { target: { value: 'edited-secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))
    expect(within(dialog).queryByText('existing-secret')).toBeNull()
    expect(within(dialog).queryByText('edited-secret')).toBeNull()
    expect(within(dialog).getByText('••••••••')).toBeDefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '编辑' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(api.vars.setBaseKey).toHaveBeenCalledWith('/repo', 'api_secret', {
        type: 'secret',
        value: 'edited-secret',
      }),
    )
  })

  it('keeps the new profile entry disabled until custom profiles are implemented', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByRole('button', { name: /Local/ })

    const createProfile = screen.getByRole('button', { name: '新建 profile（稍后接入）' })
    expect(createProfile.hasAttribute('disabled')).toBe(true)
    fireEvent.click(createProfile)

    expect(screen.queryByRole('dialog', { name: '新建配置' })).toBeNull()
  })

  it('does not render a separate profile action card', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByRole('button', { name: /Base/ })

    expect(screen.queryByLabelText('profile 操作')).toBeNull()
    expect(screen.queryByText('profile 操作')).toBeNull()
  })

  it('switches edit, raw preview, and resolved preview mutually', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))

    expect(screen.getByRole('textbox', { name: /配置值/ })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '原始预览' }))
    expect(screen.queryByRole('textbox', { name: /配置值/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('textbox', { name: /配置值/ })).toBeDefined()
  })

  it('shows resolved markdown content in resolved preview', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('rtk_path')

    fireEvent.click(screen.getByRole('button', { name: '编辑 rtk_path' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))

    expect(within(dialog).getByText('/agent/RTK.md')).toBeDefined()
    expect(within(dialog).queryByText('${LOOM_CONFIG_DIR}/RTK.md')).toBeNull()
  })

  it('renders resolved preview from the selected slot matrix when the raw value has references', async () => {
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent)
      return {
        ...response,
        resolution: {
          ...response.resolution,
          values: {
            ...response.resolution.values,
            LOOM_CONFIG_DIR: {
              type: 'string' as const,
              format: 'path' as const,
              value: agent === 'claude-code' ? '/cc-config' : '/cx-config',
            },
            rtk_path: {
              type: 'string' as const,
              format: 'markdown' as const,
              value: '${LOOM_CONFIG_DIR}/RTK.md',
            },
          },
        },
      }
    })

    render(<Vars repoPath="/repo" />)
    await screen.findByText('rtk_path')

    fireEvent.click(screen.getByRole('button', { name: '编辑 rtk_path' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    fireEvent.click(
      within(within(dialog).getByLabelText('配置槽位')).getByRole('button', { name: 'CC' }),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))

    expect(within(dialog).getByText('/cc-config/RTK.md')).toBeDefined()
    expect(within(dialog).queryByText('${LOOM_CONFIG_DIR}/RTK.md')).toBeNull()
  })

  it('keeps escaped var references literal in resolved preview', async () => {
    const escapedPath = '\\' + '$' + '{LOOM_CONFIG_DIR}/RTK.md'
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent)
      return {
        ...response,
        snapshot: {
          ...response.snapshot,
          base: {
            ...response.snapshot.base,
            rtk_path: {
              type: 'string' as const,
              format: 'markdown' as const,
              value: escapedPath,
            },
          },
        },
      }
    })

    render(<Vars repoPath="/repo" />)
    await screen.findByText('rtk_path')

    fireEvent.click(screen.getByRole('button', { name: '编辑 rtk_path' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))

    expect(within(dialog).getByText('$' + '{LOOM_CONFIG_DIR}/RTK.md')).toBeDefined()
    expect(within(dialog).queryByText(/agent\/RTK\.md/)).toBeNull()
  })

  it('closes the config modal with Escape', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑配置' })).toBeNull())
  })

  it('closes the config modal from the backdrop', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    const backdrop = dialog.parentElement!

    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑配置' })).toBeNull())
  })

  it('does not show override or restore inheritance copy', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')
    expect(screen.queryByText(/override/i)).toBeNull()
    expect(screen.queryByText('恢复继承')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
    expect(screen.queryByText(/override/i)).toBeNull()
    expect(screen.queryByText('恢复继承')).toBeNull()
  })
})
