// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import Vars from '../src/views/vars/Vars'
import { api } from '../src/lib/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

vi.mock('../src/lib/api', () => ({
  api: {
    vars: {
      listEnvironments: vi.fn(),
      getEnvironment: vi.fn(),
      resolve: vi.fn(),
      createEnvironment: vi.fn(),
      setVariable: vi.fn(),
      revealVariable: vi.fn(),
      validateDraft: vi.fn(),
      renameVariable: vi.fn(),
      inspectVariableDelete: vi.fn(),
      deleteVariable: vi.fn(),
    },
  },
}))

const environment = (entries: Record<string, unknown>) => ({
  ok: true as const,
  name: 'base',
  environment: { format: 'typed' as const, entries },
})

const previewChainNames = () =>
  Array.from(screen.getByLabelText('预览环境链').querySelectorAll('.vars-chain-name')).map(
    (node) => node.textContent,
  )

describe('Vars view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.vars.listEnvironments).mockResolvedValue({
      ok: true,
      environments: ['base', 'local', 'prod'],
    })
    vi.mocked(api.vars.getEnvironment).mockImplementation(async (_repo, name) => ({
      ...environment(
        name === 'base'
          ? {
              API_URL: { type: 'string', value: 'https://example.test' },
              API_TOKEN: { type: 'secret', value: '••••••••', masked: true },
            }
          : { DEBUG: { type: 'boolean', value: true } },
      ),
      name,
    }))
    vi.mocked(api.vars.resolve).mockResolvedValue({
      ok: true,
      values: {},
      sources: {},
      dependencies: {},
      diagnostics: [],
    })
    vi.mocked(api.vars.setVariable).mockResolvedValue({ ok: true, changed: [], diagnostics: [] })
    vi.mocked(api.vars.renameVariable).mockResolvedValue({ ok: true, changed: [], diagnostics: [] })
    vi.mocked(api.vars.inspectVariableDelete).mockResolvedValue({
      ok: true,
      impact: { direct: [], transitive: [], impactToken: 'delete-token' },
    })
    vi.mocked(api.vars.deleteVariable).mockResolvedValue({ ok: true, changed: [], diagnostics: [] })
    vi.mocked(api.vars.validateDraft).mockResolvedValue({
      ok: true,
      resolution: { ok: true, values: {}, sources: {}, dependencies: {}, diagnostics: [] },
    })
  })

  it('loads the first environment and never displays a secret value', async () => {
    render(<Vars repoPath="/repo" />)

    const environments = await screen.findByLabelText('变量环境')
    expect(
      within(environments)
        .getAllByRole('button')
        .find((button) => button.getAttribute('aria-current'))?.textContent,
    ).toContain('base')
    expect(await screen.findByText('API_URL')).toBeDefined()
    expect(screen.getByText('API_TOKEN')).toBeDefined()
    expect(screen.queryByText('••••••••')).toBeNull()
  })

  it('shows variable types as badges without redundant preview copy', async () => {
    render(<Vars repoPath="/repo" />)

    await screen.findByText('API_URL')
    const row = screen.getByText('API_URL').closest('.vars-variable') as HTMLElement
    expect(within(row).queryByText('可预览')).toBeNull()
    expect(row.querySelector('.vars-variable-type')?.textContent).toBe('string')
    expect(row.querySelector('.vars-variable-title')?.textContent).toContain('API_URL')
  })

  it('selects environments and builds an ordered preview chain', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('API_URL')

    fireEvent.click(screen.getByRole('button', { name: /local/ }))

    expect(await screen.findByText('DEBUG')).toBeDefined()
    expect(previewChainNames()).toEqual(['base', 'local'])
    await waitFor(() =>
      expect(api.vars.resolve).toHaveBeenLastCalledWith('/repo', ['base', 'local']),
    )
  })

  it('filters variables by key', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('API_URL')

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索变量' }), {
      target: { value: 'token' },
    })

    expect(screen.queryByText('API_URL')).toBeNull()
    expect(screen.getByText('API_TOKEN')).toBeDefined()
  })

  it('shows an empty state', async () => {
    vi.mocked(api.vars.listEnvironments).mockResolvedValueOnce({ ok: true, environments: [] })
    render(<Vars repoPath="/repo" />)
    expect(await screen.findByText('还没有变量环境')).toBeDefined()
    expect(screen.getByRole('button', { name: '新建环境' })).toBeDefined()
  })

  it('recovers from a loading error with retry', async () => {
    vi.mocked(api.vars.listEnvironments)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, environments: ['base'] })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Vars repoPath="/repo" />)

    expect((await screen.findAllByText('变量环境加载失败')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('API_URL')).toBeDefined()
    expect(errorSpy).toHaveBeenCalledWith('Failed to load vars', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('validates and creates an environment from the modal', async () => {
    vi.mocked(api.vars.listEnvironments).mockResolvedValueOnce({ ok: true, environments: [] })
    const creation = deferred<{ ok: true; environment: string }>()
    vi.mocked(api.vars.createEnvironment).mockReturnValueOnce(creation.promise)
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '新建环境' }))
    const input = screen.getByRole('textbox', { name: '环境名称' })
    fireEvent.change(input, { target: { value: '../bad' } })
    fireEvent.click(screen.getByRole('button', { name: '创建环境' }))
    expect(screen.getByText('环境名称格式无效')).toBeDefined()
    expect(api.vars.createEnvironment).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'staging' } })
    fireEvent.click(screen.getByRole('button', { name: '创建环境' }))
    expect(screen.getByRole('dialog', { name: '新建变量环境' }).getAttribute('aria-busy')).toBe(
      'true',
    )
    expect(screen.getByText('正在创建环境…').getAttribute('aria-live')).toBe('polite')
    creation.resolve({ ok: true, environment: 'staging' })
    expect(await screen.findByText('环境 staging 已创建')).toBeDefined()
    expect(await screen.findByText('当前环境')).toBeDefined()
  })

  it('rolls back selection and detail when selecting an environment fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Vars repoPath="/repo" />)
    await screen.findByText('API_URL')
    const failed = deferred<Awaited<ReturnType<typeof api.vars.getEnvironment>>>()
    vi.mocked(api.vars.getEnvironment).mockReturnValueOnce(failed.promise)
    fireEvent.click(screen.getByRole('button', { name: /^local$/ }))
    expect(screen.getByLabelText('变量环境').getAttribute('aria-busy')).toBe('true')
    failed.reject(new Error('failed'))
    expect(await screen.findByText('变量环境加载失败')).toBeDefined()
    expect(screen.getByText('API_URL')).toBeDefined()
    const current = within(screen.getByLabelText('变量环境'))
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current'))
    expect(current?.textContent).toContain('base')
    expect(screen.queryByLabelText('预览环境链')).toBeNull()
    errorSpy.mockRestore()
  })

  it('keeps a created environment when loading its detail fails', async () => {
    vi.mocked(api.vars.listEnvironments)
      .mockResolvedValueOnce({ ok: true, environments: [] })
      .mockResolvedValueOnce({ ok: true, environments: ['staging'] })
    vi.mocked(api.vars.createEnvironment).mockResolvedValueOnce({
      ok: true,
      environment: 'staging',
    })
    vi.mocked(api.vars.getEnvironment).mockRejectedValueOnce(new Error('detail failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '新建环境' }))
    fireEvent.change(screen.getByRole('textbox', { name: '环境名称' }), {
      target: { value: 'staging' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建环境' }))
    expect(await screen.findByText('环境已创建，但详情加载失败')).toBeDefined()
    expect(screen.getAllByText('staging').length).toBeGreaterThan(0)
    expect(screen.getByText('环境 staging 已创建')).toBeDefined()
    errorSpy.mockRestore()
  })

  it('keeps click order when detail responses finish out of order', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('API_URL')
    const local = deferred<Awaited<ReturnType<typeof api.vars.getEnvironment>>>()
    const prod = deferred<Awaited<ReturnType<typeof api.vars.getEnvironment>>>()
    vi.mocked(api.vars.getEnvironment)
      .mockReturnValueOnce(local.promise)
      .mockReturnValueOnce(prod.promise)
    fireEvent.click(screen.getByRole('button', { name: /^local$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^prod$/ }))
    expect(previewChainNames()).toEqual(['base', 'local', 'prod'])
    prod.resolve({ ...environment({ PROD: { type: 'string', value: 'yes' } }), name: 'prod' })
    local.resolve({ ...environment({ LOCAL: { type: 'string', value: 'yes' } }), name: 'local' })
    expect(await screen.findByText('PROD')).toBeDefined()
    expect(screen.queryByText('LOCAL')).toBeNull()
  })

  it('keeps the preview chain anchored to the last selected environment', async () => {
    render(<Vars repoPath="/repo" />)
    await screen.findByText('API_URL')

    expect(screen.queryByLabelText('预览环境链')).toBeNull()
    expect(screen.queryByRole('button', { name: '从预览链移除 base' })).toBeNull()
  })

  it('does not apply a stale resolution after removing a preview layer', async () => {
    const initial = deferred<Awaited<ReturnType<typeof api.vars.resolve>>>()
    const withLocal = deferred<Awaited<ReturnType<typeof api.vars.resolve>>>()
    vi.mocked(api.vars.resolve)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(withLocal.promise)
    render(<Vars repoPath="/repo" />)
    await screen.findByText('API_URL')

    fireEvent.click(screen.getByRole('button', { name: /^local$/ }))
    await screen.findByText('DEBUG')
    expect(previewChainNames()).toEqual(['base', 'local'])

    fireEvent.click(screen.getByRole('button', { name: '从预览链移除 local' }))
    withLocal.resolve({
      ok: true,
      values: { OLD: { type: 'string', value: 'old' } },
      sources: {},
      dependencies: {},
      diagnostics: [],
    })
    await waitFor(() => expect(screen.queryByLabelText('预览环境链')).toBeNull())
    expect(screen.queryByText('OLD')).toBeNull()
  })

  it('does not update state when deferred loading finishes after unmount', async () => {
    const loading = deferred<Awaited<ReturnType<typeof api.vars.listEnvironments>>>()
    vi.mocked(api.vars.listEnvironments).mockReturnValueOnce(loading.promise)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<Vars repoPath="/repo" />)

    view.unmount()
    loading.resolve({ ok: true, environments: ['stale'] })
    await loading.promise
    await Promise.resolve()

    expect(api.vars.getEnvironment).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('ignores deferred create work after the repository changes', async () => {
    vi.mocked(api.vars.listEnvironments)
      .mockResolvedValueOnce({ ok: true, environments: [] })
      .mockRejectedValueOnce(new Error('new repo unavailable'))
    const creation = deferred<{ ok: true; environment: string }>()
    vi.mocked(api.vars.createEnvironment).mockReturnValueOnce(creation.promise)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<Vars repoPath="/old" />)
    fireEvent.click(await screen.findByRole('button', { name: '新建环境' }))
    fireEvent.change(screen.getByRole('textbox', { name: '环境名称' }), {
      target: { value: 'stale' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建环境' }))

    view.rerender(<Vars repoPath="/new" />)
    const oldRepoCalls = vi
      .mocked(api.vars.listEnvironments)
      .mock.calls.filter(([repo]) => repo === '/old').length
    creation.resolve({ ok: true, environment: 'stale' })
    expect((await screen.findAllByText('变量环境加载失败')).length).toBeGreaterThan(0)

    expect(
      vi.mocked(api.vars.listEnvironments).mock.calls.filter(([repo]) => repo === '/old'),
    ).toHaveLength(oldRepoCalls)
    expect(screen.queryByText('环境 stale 已创建')).toBeNull()
    expect(screen.getByRole('dialog', { name: '新建变量环境' }).getAttribute('aria-busy')).toBe(
      'false',
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog', { name: '新建变量环境' })).toBeNull()
    errorSpy.mockRestore()
  })

  it('clears a pending selection and old repository data when the new load fails', async () => {
    const selection = deferred<Awaited<ReturnType<typeof api.vars.getEnvironment>>>()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<Vars repoPath="/old" />)
    await screen.findByText('API_URL')
    vi.mocked(api.vars.getEnvironment).mockReturnValueOnce(selection.promise)
    fireEvent.click(screen.getByRole('button', { name: /^local$/ }))
    expect(screen.getByLabelText('变量环境').getAttribute('aria-busy')).toBe('true')
    vi.mocked(api.vars.listEnvironments).mockRejectedValueOnce(new Error('new repo unavailable'))

    view.rerender(<Vars repoPath="/new" />)

    expect(await screen.findByText('变量环境加载失败')).toBeDefined()
    expect(screen.queryByText('API_URL')).toBeNull()
    expect(screen.queryByLabelText('变量环境')).toBeNull()
    selection.resolve({
      ...environment({ STALE: { type: 'string', value: 'old' } }),
      name: 'local',
    })
    await selection.promise
    await Promise.resolve()
    expect(screen.queryByText('STALE')).toBeNull()
    errorSpy.mockRestore()
  })

  it('opens variable details from an explicit edit action and clears them on environment change', async () => {
    render(<Vars repoPath="/repo" />)
    const variables = await screen.findByRole('region', { name: '当前环境' })
    expect(within(variables).getByRole('button', { name: '新建变量' })).toBeDefined()
    expect(screen.queryByRole('region', { name: '变量配置' })).toBeNull()

    fireEvent.click(await screen.findByText('API_URL'))
    expect(screen.queryByRole('dialog', { name: '编辑变量 API_URL' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑变量 API_URL' }))
    expect(screen.getByRole('dialog', { name: '编辑变量 API_URL' }).textContent).toContain(
      'API_URL',
    )
    expect(screen.getByRole('dialog', { name: '编辑变量 API_URL' }).textContent).toContain('string')
    fireEvent.click(screen.getByRole('button', { name: /^local$/ }))
    expect(await screen.findByText('DEBUG')).toBeDefined()
    expect(screen.queryByRole('dialog', { name: '编辑变量 API_URL' })).toBeNull()
  })

  it('renames variables through the variable name field', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑变量 API_URL' }))
    const dialog = screen.getByRole('dialog', { name: '编辑变量 API_URL' })

    expect(within(dialog).queryByRole('button', { name: '重命名' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '删除变量' })).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('变量名'), { target: { value: 'API_BASE_URL' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存变量' }))

    await waitFor(() =>
      expect(api.vars.renameVariable).toHaveBeenCalledWith(
        '/repo',
        'base',
        'API_URL',
        'API_BASE_URL',
      ),
    )
    expect(api.vars.setVariable).toHaveBeenCalledWith('/repo', 'base', 'API_BASE_URL', {
      type: 'string',
      value: 'https://example.test',
    })
  })

  it('deletes variables from the variable list', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除变量 API_URL' }))

    expect(api.vars.inspectVariableDelete).toHaveBeenCalledWith('/repo', 'base', 'API_URL')
    const dialog = screen.getByRole('dialog', { name: '删除变量 API_URL' })
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: '确认删除' }).hasAttribute('disabled'),
      ).toBe(false),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(api.vars.deleteVariable).toHaveBeenCalledWith('/repo', 'base', 'API_URL', {
        confirmed: true,
        impactToken: 'delete-token',
      }),
    )
  })

  it('saves a typed variable, reloads detail and resolution, then shows a toast', async () => {
    render(<Vars repoPath="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: '新建变量' }))
    expect(screen.getByRole('dialog', { name: '新建变量' })).toBeDefined()
    fireEvent.change(screen.getByLabelText('变量名'), { target: { value: 'PORT' } })
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'number' } })
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '8080' } })
    fireEvent.click(screen.getByRole('button', { name: '保存变量' }))
    await waitFor(() =>
      expect(api.vars.setVariable).toHaveBeenCalledWith('/repo', 'base', 'PORT', {
        type: 'number',
        value: 8080,
      }),
    )
    expect(api.vars.validateDraft).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.vars.validateDraft).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.vars.setVariable).mock.invocationCallOrder[0],
    )
    expect(await screen.findByText('变量 PORT 已保存')).toBeDefined()
    expect(vi.mocked(api.vars.getEnvironment).mock.calls.length).toBeGreaterThan(1)
    expect(api.vars.resolve).toHaveBeenLastCalledWith('/repo', ['base'])
  })
})
