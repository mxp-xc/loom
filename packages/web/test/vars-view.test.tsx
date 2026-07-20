// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Vars from '../src/views/vars/Vars'
import { api } from '../src/lib/api'
import type { VarsMatrixResponse } from '../src/lib/vars'
import { createMonacoEditorMock } from './monaco-test-utils'

const monacoEditorMock = createMonacoEditorMock()

type SuccessfulVarsMatrixResponse = Omit<VarsMatrixResponse, 'resolution'> & {
  resolution: Extract<VarsMatrixResponse['resolution'], { ok: true }>
}

const matrixKeyGroups = {
  builtinResult: ['LOOM_AGENT'],
  formats: ['json_text', 'yaml_text'],
  memoryPicker: ['memory.context'],
  pathPreview: ['LOOM_CONFIG_DIR', 'rtk_path'],
} as const

function selectKeys<T>(record: Record<string, T>, includedKeys: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => includedKeys.has(key)),
  ) as Record<string, T>
}

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

const matrix = (
  agent = 'codex',
  extraKeys: readonly string[] = [],
): SuccessfulVarsMatrixResponse => {
  const response: SuccessfulVarsMatrixResponse = {
    ok: true,
    agent,
    builtinKeys: ['LOOM_AGENT', 'LOOM_CONFIG_DIR'],
    userKeys: ['agent_name', 'json_text', 'yaml_text', 'memory.context', 'rtk_path'],
    snapshot: {
      base: {
        agent_name: { type: 'string', format: 'markdown', value: 'Agent' },
        json_text: { type: 'string', format: 'json', value: '{"b":2,"a":1}' },
        yaml_text: { type: 'string', format: 'yaml', value: 'enabled: true' },
        'memory.context': {
          type: 'string',
          format: 'markdown',
          value: 'Base memory',
        },
        rtk_path: {
          type: 'string',
          format: 'markdown',
          value: '${LOOM_CONFIG_DIR}/RTK.md',
        },
      },
      baseAgent: {},
      local: {},
      localAgent: agent === 'codex' ? { agent_name: { value: 'Local Codex agent' } } : {},
    },
    resolution: {
      ok: true,
      values: {
        LOOM_AGENT: { type: 'string', value: agent },
        LOOM_CONFIG_DIR: { type: 'string', format: 'path', value: '/agent' },
        agent_name: {
          type: 'string',
          format: 'markdown',
          value: agent === 'codex' ? 'Local Codex agent' : 'Agent',
        },
        json_text: { type: 'string', format: 'json', value: '{"b":2,"a":1}' },
        yaml_text: { type: 'string', format: 'yaml', value: 'enabled: true' },
        'memory.context': {
          type: 'string',
          format: 'markdown',
          value: 'Base memory',
        },
        rtk_path: {
          type: 'string',
          format: 'markdown',
          value: agent === 'default' ? '${LOOM_CONFIG_DIR}/RTK.md' : '/agent/RTK.md',
        },
      },
      sources: {
        LOOM_AGENT: { locality: 'builtin', layer: 'runtime', agent },
        LOOM_CONFIG_DIR: { locality: 'builtin', layer: 'runtime', agent },
        agent_name:
          agent === 'codex'
            ? { locality: 'local', layer: 'agent', agent }
            : { locality: 'synced', layer: 'base' },
        rtk_path: { locality: 'synced', layer: 'base' },
        json_text: { locality: 'synced', layer: 'base' },
        yaml_text: { locality: 'synced', layer: 'base' },
        'memory.context': { locality: 'synced', layer: 'base' },
      },
      overrideChains: {
        LOOM_AGENT: [{ locality: 'builtin', layer: 'runtime', agent }],
        LOOM_CONFIG_DIR: [{ locality: 'builtin', layer: 'runtime', agent }],
        agent_name:
          agent === 'codex'
            ? [
                { locality: 'synced', layer: 'base' },
                { locality: 'local', layer: 'agent', agent },
              ]
            : [{ locality: 'synced', layer: 'base' }],
        rtk_path: [{ locality: 'synced', layer: 'base' }],
        json_text: [{ locality: 'synced', layer: 'base' }],
        yaml_text: [{ locality: 'synced', layer: 'base' }],
        'memory.context': [{ locality: 'synced', layer: 'base' }],
      },
      dependencies: {
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
  }
  const includedKeys = new Set(['agent_name', ...extraKeys])
  if (agent === 'default') {
    includedKeys.delete('LOOM_AGENT')
    includedKeys.delete('LOOM_CONFIG_DIR')
  }

  return {
    ...response,
    builtinKeys: response.builtinKeys.filter((key) => includedKeys.has(key)),
    userKeys: response.userKeys.filter((key) => includedKeys.has(key)),
    snapshot: {
      base: selectKeys(response.snapshot.base, includedKeys),
      baseAgent: selectKeys(response.snapshot.baseAgent, includedKeys),
      local: selectKeys(response.snapshot.local, includedKeys),
      localAgent: selectKeys(response.snapshot.localAgent, includedKeys),
    },
    resolution: {
      ...response.resolution,
      values: selectKeys(response.resolution.values, includedKeys),
      sources: selectKeys(response.resolution.sources, includedKeys),
      overrideChains: selectKeys(response.resolution.overrideChains, includedKeys),
      dependencies: selectKeys(response.resolution.dependencies, includedKeys),
    },
  }
}

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
      config: { agents: ['codex'] },
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

  it('shows default configuration values while listing only Settings agents', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    const defaultScope = screen.getByRole('button', { name: 'default' })
    expect(defaultScope.getAttribute('data-state')).toBe('on')
    const agentChips = screen.getByLabelText('目标 agent')
    expect(within(agentChips).getByRole('button', { name: 'Codex' })).toBeDefined()
    expect(within(agentChips).queryByRole('button', { name: 'CC' })).toBeNull()
    expect(within(agentChips).queryByRole('button', { name: 'OC' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Local/ }))
    await waitFor(() => {
      const row = screen.getByRole('row', { name: /agent_name/ })
      expect(row.textContent).toContain('未配置')
      const codexAgent = within(row).getByLabelText('Codex')
      expect(codexAgent.textContent).toBe('')
      expect(codexAgent.querySelector('.agent-chip-icon')).not.toBeNull()
      expect(row.textContent).not.toContain('Local Codex agent')
    })
  })

  it('switches configuration current values by agent without leaving the current tab', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
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
      expect(within(row).getByLabelText('OpenCode')).toBeDefined()
    })

    fireEvent.click(
      within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'OpenCode' }),
    )

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
    expect(within(row).getByLabelText('Codex')).toBeDefined()
    expect(row.textContent).not.toContain('default')
  })

  it('loads only Default and keeps Default editing when configured agents are empty', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: [] },
      errors: [],
    } as never)

    render(<Vars repoPath="/empty" />)

    await screen.findByText('agent_name')
    expect(api.vars.getMatrix).toHaveBeenCalledTimes(1)
    expect(api.vars.getMatrix).toHaveBeenCalledWith('/empty', 'default')
    expect(screen.queryByRole('columnheader', { name: /^专属/ })).toBeNull()
    expect(within(screen.getByLabelText('目标 agent')).queryAllByRole('button')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    expect(within(dialog).getByRole('button', { name: 'default' })).toBeDefined()
    expect(within(dialog).queryByRole('button', { name: 'Codex' })).toBeNull()
  })

  it('shows final resolved values for the selected agent', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(
      within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'Codex' }),
    )
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

  it('uses the first Settings agent as the initial resolved-result agent', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['claude-code'] },
      errors: [],
    } as never)

    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    expect(screen.getByRole('button', { name: 'default' }).getAttribute('data-state')).toBe('on')
    const agentChips = screen.getByLabelText('目标 agent')
    expect(within(agentChips).getByRole('button', { name: 'Claude Code' })).toBeDefined()
    expect(within(agentChips).queryByRole('button', { name: 'CX' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    expect(screen.getByRole('button', { name: 'default' }).getAttribute('data-state')).toBe('on')
    expect(
      within(agentChips).getByRole('button', { name: 'Claude Code' }).getAttribute('data-state'),
    ).toBe('off')
  })

  it('keeps the active tab when changing the view scope chips', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    } as never)

    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))
    fireEvent.click(screen.getByRole('button', { name: 'default' }))
    expect(screen.getByRole('button', { name: '最终结果' }).getAttribute('aria-pressed')).toBe(
      'true',
    )

    fireEvent.click(
      within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'OpenCode' }),
    )
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

  it('uses clear semantic column names', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')

    expect(screen.getByRole('columnheader', { name: /^专属/ })).toBeDefined()
    expect(screen.getByRole('columnheader', { name: /^操作/ })).toBeDefined()
  })

  it('refreshes final resolved values when switching agent', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'claude-code'] },
      errors: [],
    } as never)
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) =>
      matrix(agent, matrixKeyGroups.builtinResult),
    )
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')
    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    fireEvent.click(
      within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'Claude Code' }),
    )

    const resolvedTable = screen.getByRole('region', { name: '解析结果' })
    const agentNameRow = within(resolvedTable).getByRole('row', { name: /agent_name/ })
    expect(agentNameRow.textContent).toContain('Agent')
    expect(agentNameRow.textContent).toContain('base')
    expect(agentNameRow.textContent).not.toContain('Local Codex agent')
    const runtimeAgentRow = within(resolvedTable).getByRole('row', { name: /LOOM_AGENT/ })
    expect(runtimeAgentRow.textContent).toContain('claude-code')
    expect(runtimeAgentRow.textContent).toContain('builtin')
    expect(runtimeAgentRow.textContent).toContain('runtime')
  })

  it('returns final resolved values to the default context when selecting default scope', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'opencode'] },
      errors: [],
    } as never)
    render(<Vars repoPath="/repo" />)
    await screen.findByText('agent_name')
    fireEvent.click(screen.getByRole('button', { name: '最终结果' }))

    fireEvent.click(
      within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'OpenCode' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'default' }))

    const resolvedTable = screen.getByRole('region', { name: '解析结果' })
    const agentNameRow = within(resolvedTable).getByRole('row', { name: /agent_name/ })
    expect(agentNameRow.textContent).toContain('Agent')
    expect(agentNameRow.textContent).toContain('base')
  })

  it('opens edit modal and saves a local agent config', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: /Local/ }))
    await screen.findByText('agent_name')
    fireEvent.click(
      within(screen.getByLabelText('目标 agent')).getByRole('button', { name: 'Codex' }),
    )

    fireEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))

    expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
    const editor = screen.getByRole('textbox', { name: /配置值/ })
    expect(editor.closest('label')).toBeNull()
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
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) =>
      matrix(agent, matrixKeyGroups.formats),
    )
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
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'claude-code'] },
      errors: [],
    } as never)
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
      within(within(dialog).getByLabelText('配置槽位')).getByRole('button', {
        name: 'Claude Code',
      }),
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
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) =>
      matrix(agent, matrixKeyGroups.memoryPicker),
    )
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

  it('does not overwrite an existing masked secret when saved unchanged', async () => {
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent)
      return {
        ...response,
        userKeys: [...response.userKeys, 'api_secret'],
        snapshot: {
          ...response.snapshot,
          base: {
            ...response.snapshot.base,
            api_secret: { type: 'secret' as const, value: '••••••••' as const, masked: true },
          },
        },
        resolution: {
          ...response.resolution,
          values: {
            ...response.resolution.values,
            api_secret: { type: 'secret' as const, value: '••••••••' as const, masked: true },
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
    expect((within(dialog).getByLabelText(/配置值/) as HTMLInputElement).value).toBe('••••••••')

    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑配置' })).toBeNull())
    expect(api.vars.setBaseKey).not.toHaveBeenCalled()
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
            api_secret: { type: 'secret' as const, value: '••••••••' as const, masked: true },
          },
        },
        resolution: {
          ...response.resolution,
          values: {
            ...response.resolution.values,
            api_secret: { type: 'secret' as const, value: '••••••••' as const, masked: true },
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
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) =>
      matrix(agent, matrixKeyGroups.pathPreview),
    )
    render(<Vars repoPath="/repo" />)
    await screen.findByText('rtk_path')

    fireEvent.click(screen.getByRole('button', { name: '编辑 rtk_path' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    fireEvent.click(
      within(within(dialog).getByLabelText('配置槽位')).getByRole('button', { name: 'Codex' }),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))

    const resolvedValue = within(dialog).getByText('/agent/RTK.md')
    expect(resolvedValue.closest('.md-preview')?.tagName).toBe('ARTICLE')
    expect(within(dialog).queryByText('${LOOM_CONFIG_DIR}/RTK.md')).toBeNull()
  })

  it('renders resolved preview from the selected slot matrix when the raw value has references', async () => {
    vi.mocked(api.getManifest).mockResolvedValueOnce({
      skills: { sources: [], skills: [] },
      mcp: [],
      vars: { default: {}, active: {} },
      config: { agents: ['codex', 'claude-code'] },
      errors: [],
    } as never)
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent, matrixKeyGroups.pathPreview)
      if (agent === 'default') return response
      const configDir = agent === 'claude-code' ? '/cc-config' : '/cx-config'
      return {
        ...response,
        snapshot: {
          ...response.snapshot,
          baseAgent: {
            ...response.snapshot.baseAgent,
            rtk_path: { value: '${LOOM_CONFIG_DIR}/RTK.md' },
          },
        },
        resolution: {
          ...response.resolution,
          values: {
            ...response.resolution.values,
            LOOM_CONFIG_DIR: {
              type: 'string' as const,
              format: 'path' as const,
              value: configDir,
            },
            rtk_path: {
              type: 'string' as const,
              format: 'markdown' as const,
              value: `${configDir}/RTK.md`,
            },
          },
          sources: {
            ...response.resolution.sources,
            rtk_path: { locality: 'synced' as const, layer: 'agent' as const, agent },
          },
          overrideChains: {
            ...response.resolution.overrideChains,
            rtk_path: [
              { locality: 'synced' as const, layer: 'base' as const },
              { locality: 'synced' as const, layer: 'agent' as const, agent },
            ],
          },
        },
      }
    })

    render(<Vars repoPath="/repo" />)
    await screen.findByText('rtk_path')

    fireEvent.click(screen.getByRole('button', { name: '编辑 rtk_path' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
    fireEvent.click(
      within(within(dialog).getByLabelText('配置槽位')).getByRole('button', {
        name: 'Claude Code',
      }),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: '解析预览' }))

    expect(within(dialog).getByText('/cc-config/RTK.md')).toBeDefined()
    expect(within(dialog).queryByText('${LOOM_CONFIG_DIR}/RTK.md')).toBeNull()
  })

  it('keeps escaped var references literal in resolved preview', async () => {
    const escapedPath = '\\' + '$' + '{LOOM_CONFIG_DIR}/RTK.md'
    vi.mocked(api.vars.getMatrix).mockImplementation(async (_repo, agent) => {
      const response = matrix(agent, matrixKeyGroups.pathPreview)
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
        resolution: {
          ...response.resolution,
          values: {
            ...response.resolution.values,
            rtk_path: {
              type: 'string' as const,
              format: 'markdown' as const,
              value: '${LOOM_CONFIG_DIR}/RTK.md',
            },
          },
          dependencies: {
            ...response.resolution.dependencies,
            rtk_path: [],
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
})
