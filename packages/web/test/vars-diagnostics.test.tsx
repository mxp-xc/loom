// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Vars from '../src/views/vars/Vars'
import { ApiError, api } from '../src/lib/api'

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      vars: {
        listEnvironments: vi.fn(),
        getEnvironment: vi.fn(),
        resolve: vi.fn(),
        setVariable: vi.fn(),
        validateDraft: vi.fn(),
        revealVariable: vi.fn(),
        createEnvironment: vi.fn(),
        inspectVariableDelete: vi.fn(),
        deleteVariable: vi.fn(),
        renameVariable: vi.fn(),
      },
    },
  }
})

const detail = (entries: Record<string, any>) => ({
  ok: true as const,
  name: 'base',
  environment: { format: 'typed' as const, entries },
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('Vars diagnostics actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.vars.listEnvironments).mockResolvedValue({
      ok: true,
      environments: ['base'],
      diagnostics: [
        {
          code: 'dangling_reference',
          severity: 'warning',
          environment: 'base',
          key: 'CLIENT',
          referencedKey: 'API_URL',
          path: ['CLIENT', 'API_URL'],
          message: '变量 CLIENT 引用了不存在的变量 API_URL',
        },
      ],
    })
    vi.mocked(api.vars.getEnvironment).mockResolvedValue(
      detail({
        API_URL: { type: 'string', value: 'x' },
        CLIENT: { type: 'string', value: '${API_URL}' },
      }),
    )
    vi.mocked(api.vars.resolve).mockResolvedValue({
      ok: true,
      values: {},
      sources: {},
      dependencies: {},
      diagnostics: [],
    })
    vi.mocked(api.vars.validateDraft).mockResolvedValue({
      ok: true,
      resolution: { ok: true, values: {}, sources: {}, dependencies: {}, diagnostics: [] },
    })
    vi.mocked(api.vars.setVariable).mockResolvedValue({
      ok: true,
      changed: ['base'],
      diagnostics: [],
    })
  })

  it('shows impact and only deletes with the confirmed token', async () => {
    vi.mocked(api.vars.inspectVariableDelete).mockResolvedValue({
      ok: true,
      impact: {
        direct: [{ environment: 'base', key: 'CLIENT' }],
        transitive: [{ environment: 'prod', key: 'DEPLOY' }],
        impactToken: 'impact-v1',
      },
    })
    vi.mocked(api.vars.deleteVariable).mockResolvedValue({
      ok: true,
      changed: ['base'],
      diagnostics: [],
    })
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除变量 API_URL' }))
    await waitFor(() =>
      expect(api.vars.inspectVariableDelete).toHaveBeenCalledWith('/repo', 'base', 'API_URL'),
    )
    const dialog = await screen.findByRole(
      'dialog',
      { name: '删除变量 API_URL' },
      { timeout: 3000 },
    )
    expect(await within(dialog).findByText('直接依赖', {}, { timeout: 3000 })).toBeDefined()
    expect(within(dialog).getByText('base / CLIENT')).toBeDefined()
    expect(within(dialog).getByText('间接依赖')).toBeDefined()
    expect(within(dialog).getByText('prod / DEPLOY')).toBeDefined()
    expect(api.vars.deleteVariable).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(api.vars.deleteVariable).toHaveBeenCalledWith('/repo', 'base', 'API_URL', {
        confirmed: true,
        impactToken: 'impact-v1',
      }),
    )
  })

  it('refreshes changed impact and requires a second confirmation', async () => {
    vi.mocked(api.vars.inspectVariableDelete).mockResolvedValue({
      ok: true,
      impact: { direct: [], transitive: [], impactToken: 'v1' },
    })
    vi.mocked(api.vars.deleteVariable)
      .mockRejectedValueOnce(
        new ApiError('影响已变化', 409, 'impact_changed', undefined, {
          details: {
            deleteImpact: {
              direct: [{ environment: 'base', key: 'NEW' }],
              transitive: [],
              impactToken: 'v2',
            },
          },
        }),
      )
      .mockResolvedValueOnce({ ok: true, changed: ['base'], diagnostics: [] })
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除变量 API_URL' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('依赖已变化，请重新确认')).toBeDefined()
    expect(screen.getByText('base / NEW')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(api.vars.deleteVariable).toHaveBeenLastCalledWith('/repo', 'base', 'API_URL', {
        confirmed: true,
        impactToken: 'v2',
      }),
    )
  })

  it('renames through the variable name field and reloads the selected key', async () => {
    vi.mocked(api.vars.renameVariable).mockResolvedValue({
      ok: true,
      changed: ['base'],
      diagnostics: [],
    })
    vi.mocked(api.vars.getEnvironment)
      .mockResolvedValueOnce(detail({ API_URL: { type: 'string', value: 'x' } }))
      .mockResolvedValue(detail({ SERVICE_URL: { type: 'string', value: 'x' } }))
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑变量 API_URL' }))
    const dialog = screen.getByRole('dialog', { name: '编辑变量 API_URL' })
    fireEvent.change(within(dialog).getByLabelText('变量名'), {
      target: { value: 'SERVICE_URL' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存变量' }))
    await waitFor(() =>
      expect(api.vars.renameVariable).toHaveBeenCalledWith(
        '/repo',
        'base',
        'API_URL',
        'SERVICE_URL',
      ),
    )
    expect(api.vars.setVariable).toHaveBeenCalledWith('/repo', 'base', 'SERVICE_URL', {
      type: 'string',
      value: 'x',
    })
    expect(await screen.findByRole('button', { name: '编辑变量 SERVICE_URL' })).toBeDefined()
  })

  it('marks warning rows with icon and text and shows diagnostic detail', async () => {
    render(<Vars repoPath="/repo" />)
    const warning = await screen.findByText('引用缺失：API_URL')
    expect(warning.closest('.vars-variable')?.querySelector('svg')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑变量 CLIENT' }))
    expect(screen.getByText('缺失变量：API_URL')).toBeDefined()
    expect(screen.getByText('来源环境：base')).toBeDefined()
    expect(screen.getByText('引用路径：CLIENT → API_URL')).toBeDefined()
  })

  it('shows operation failure toast and field diagnostics for rename conflict', async () => {
    vi.mocked(api.vars.renameVariable).mockRejectedValue(
      new ApiError('冲突', 409, 'variable_conflict', [
        { code: 'variable_conflict', severity: 'error', key: 'CLIENT', message: '变量已存在' },
      ]),
    )
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑变量 API_URL' }))
    fireEvent.change(screen.getByLabelText('变量名'), { target: { value: 'CLIENT' } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    expect(await screen.findByText('重命名失败：冲突')).toBeDefined()
    expect(screen.getByText('变量已存在')).toBeDefined()
  })

  it('reloads diagnostics after delete and clears the warning after repair', async () => {
    vi.mocked(api.vars.listEnvironments)
      .mockResolvedValueOnce({ ok: true, environments: ['base'], diagnostics: [] })
      .mockResolvedValueOnce({
        ok: true,
        environments: ['base'],
        diagnostics: [
          {
            code: 'dangling_reference',
            severity: 'warning',
            environment: 'base',
            key: 'CLIENT',
            referencedKey: 'API_URL',
            path: ['CLIENT', 'API_URL'],
            message: '缺失',
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, environments: ['base'], diagnostics: [] })
    vi.mocked(api.vars.inspectVariableDelete).mockResolvedValue({
      ok: true,
      impact: { direct: [], transitive: [], impactToken: 'delete' },
    })
    vi.mocked(api.vars.deleteVariable).mockResolvedValue({
      ok: true,
      changed: ['base'],
      diagnostics: [],
    })
    vi.mocked(api.vars.getEnvironment)
      .mockResolvedValueOnce(
        detail({
          API_URL: { type: 'string', value: 'x' },
          CLIENT: { type: 'string', value: '${API_URL}' },
        }),
      )
      .mockResolvedValueOnce(detail({ CLIENT: { type: 'string', value: '${API_URL}' } }))
      .mockResolvedValue(
        detail({
          API_URL: { type: 'string', value: 'fixed' },
          CLIENT: { type: 'string', value: '${API_URL}' },
        }),
      )
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除变量 API_URL' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('引用缺失：API_URL')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '编辑变量 CLIENT' }))
    fireEvent.change(screen.getByRole('combobox', { name: '值' }), { target: { value: 'fixed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await waitFor(() => expect(screen.queryByText('引用缺失：API_URL')).toBeNull())
  })

  it('locks delete confirmation and dismissal while the mutation is pending', async () => {
    const deletion = deferred<{ ok: true; changed: string[]; diagnostics: [] }>()
    vi.mocked(api.vars.inspectVariableDelete).mockResolvedValue({
      ok: true,
      impact: { direct: [], transitive: [], impactToken: 'locked' },
    })
    vi.mocked(api.vars.deleteVariable).mockReturnValue(deletion.promise)
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除变量 API_URL' }))
    const confirm = await screen.findByRole('button', { name: '确认删除' })
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
    fireEvent.click(confirm)
    expect(await screen.findByRole('button', { name: '正在删除…' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: '删除变量 API_URL' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '正在删除…' }))
    expect(api.vars.deleteVariable).toHaveBeenCalledTimes(1)
    deletion.resolve({ ok: true, changed: ['base'], diagnostics: [] })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '删除变量 API_URL' })).toBeNull(),
    )
  })

  it('commits delete refresh diagnostics when preview resolution rejects', async () => {
    vi.mocked(api.vars.listEnvironments)
      .mockResolvedValueOnce({ ok: true, environments: ['base'], diagnostics: [] })
      .mockResolvedValueOnce({
        ok: true,
        environments: ['base'],
        diagnostics: [
          {
            code: 'dangling_reference',
            severity: 'warning',
            environment: 'base',
            key: 'CLIENT',
            referencedKey: 'API_URL',
            path: ['CLIENT', 'API_URL'],
            message: '变量 CLIENT 引用了不存在的变量 API_URL',
          },
        ],
      })
    vi.mocked(api.vars.getEnvironment)
      .mockResolvedValueOnce(
        detail({
          API_URL: { type: 'string', value: 'x' },
          CLIENT: { type: 'string', value: '${API_URL}' },
        }),
      )
      .mockResolvedValueOnce(detail({ CLIENT: { type: 'string', value: '${API_URL}' } }))
    vi.mocked(api.vars.inspectVariableDelete).mockResolvedValue({
      ok: true,
      impact: {
        direct: [{ environment: 'base', key: 'CLIENT' }],
        transitive: [],
        impactToken: 'confirmed',
      },
    })
    vi.mocked(api.vars.deleteVariable).mockResolvedValue({
      ok: true,
      changed: ['base'],
      diagnostics: [],
    })
    vi.mocked(api.vars.resolve)
      .mockResolvedValueOnce({
        ok: true,
        values: { API_URL: { type: 'string', value: 'x' } },
        sources: {},
        dependencies: {},
        diagnostics: [],
      })
      .mockRejectedValueOnce(new ApiError('存在缺失引用', 422, 'resolution_failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除变量 API_URL' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '删除变量 API_URL' })).toBeNull(),
    )
    expect(await screen.findByText('变量 API_URL 已删除')).toBeDefined()
    expect(screen.queryByRole('button', { name: '编辑变量 API_URL' })).toBeNull()
    expect(screen.getByText('引用缺失：API_URL')).toBeDefined()
    expect(api.vars.deleteVariable).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to resolve vars preview after refresh',
      expect.any(ApiError),
    )
    errorSpy.mockRestore()
  })

  it('reports rename success rather than mutation failure when preview resolution rejects', async () => {
    vi.mocked(api.vars.getEnvironment)
      .mockResolvedValueOnce(detail({ API_URL: { type: 'string', value: 'x' } }))
      .mockResolvedValueOnce(detail({ SERVICE_URL: { type: 'string', value: 'x' } }))
    vi.mocked(api.vars.renameVariable).mockResolvedValue({
      ok: true,
      changed: ['base'],
      diagnostics: [],
    })
    vi.mocked(api.vars.resolve)
      .mockResolvedValueOnce({
        ok: true,
        values: {},
        sources: {},
        dependencies: {},
        diagnostics: [],
      })
      .mockRejectedValueOnce(new ApiError('存在缺失引用', 422, 'resolution_failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑变量 API_URL' }))
    fireEvent.change(screen.getByLabelText('变量名'), { target: { value: 'SERVICE_URL' } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑变量 API_URL' })).toBeNull(),
    )
    expect(await screen.findByText('变量 API_URL 已重命名为 SERVICE_URL 并保存')).toBeDefined()
    expect(screen.queryByText(/重命名失败/)).toBeNull()
    expect(await screen.findByRole('button', { name: '编辑变量 SERVICE_URL' })).toBeDefined()
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to resolve vars preview after refresh',
      expect.any(ApiError),
    )
    errorSpy.mockRestore()
  })
})
