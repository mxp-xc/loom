// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost from '../src/components/ToastHost'
import { dismissToast } from '../src/hooks/useToast'
import Vars from '../src/views/vars/Vars'
import { ApiError, api } from '../src/lib/api'

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      getManifest: vi.fn(),
      vars: {
        getMatrix: vi.fn(),
        setBaseKey: vi.fn(),
        deleteBaseKey: vi.fn(),
        renameBaseKey: vi.fn(),
        setOverride: vi.fn(),
        clearOverride: vi.fn(),
      },
    },
  }
})

function matrix() {
  return {
    ok: true as const,
    agent: 'codex',
    builtinKeys: ['LOOM_AGENT'],
    userKeys: ['CLIENT'],
    snapshot: {
      base: { CLIENT: { type: 'string' as const, value: 'Use missing ref' } },
      baseAgent: {},
      local: {},
      localAgent: {},
    },
    resolution: {
      ok: true as const,
      values: {
        LOOM_AGENT: { type: 'string' as const, value: 'codex' },
        CLIENT: { type: 'string' as const, value: 'Use missing ref' },
      },
      sources: {
        LOOM_AGENT: { locality: 'builtin' as const, layer: 'runtime' as const, agent: 'codex' },
        CLIENT: { locality: 'synced' as const, layer: 'base' as const },
      },
      overrideChains: {
        LOOM_AGENT: [{ locality: 'builtin' as const, layer: 'runtime' as const, agent: 'codex' }],
        CLIENT: [{ locality: 'synced' as const, layer: 'base' as const }],
      },
      dependencies: { LOOM_AGENT: [], CLIENT: ['MISSING'] },
      diagnostics: [
        {
          code: 'MISSING_REFERENCE',
          severity: 'error' as const,
          key: 'CLIENT',
          referencedKey: 'MISSING',
          path: ['CLIENT', 'MISSING'],
          message: '变量不存在: MISSING',
        },
      ],
    },
  }
}

function renderVars() {
  render(
    <>
      <ToastHost />
      <Vars repoPath="/repo" />
    </>,
  )
}

describe('Vars diagnostics actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dismissToast()
    vi.mocked(api.vars.getMatrix).mockResolvedValue(matrix())
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

  it('shows resolver diagnostics with key, reference, and path context', async () => {
    renderVars()

    fireEvent.click(await screen.findByRole('button', { name: /Base/ }))
    await screen.findByText('CLIENT')
    fireEvent.click(screen.getByRole('button', { name: '编辑 CLIENT' }))

    const alert = await within(await screen.findByRole('dialog', { name: '编辑配置' })).findByRole(
      'alert',
    )
    expect(alert.textContent).toContain('变量不存在: MISSING')
    expect(alert.textContent).toContain('key=CLIENT')
    expect(alert.textContent).toContain('ref=MISSING')
    expect(alert.textContent).toContain('path=CLIENT → MISSING')
  })

  it('keeps trace rail visible for diagnosed keys', async () => {
    renderVars()

    fireEvent.click(await screen.findByRole('button', { name: /Base/ }))
    await screen.findByText('CLIENT')
    fireEvent.click(screen.getByRole('button', { name: '编辑 CLIENT' }))

    const trace = await within(
      await screen.findByRole('dialog', { name: '编辑配置' }),
    ).findByLabelText('变量追溯')
    expect(trace.textContent).toContain('Base')
    expect(trace.textContent).toContain('default')
    expect(trace.textContent).toContain('MISSING')
    expect(trace.textContent).toContain('dependency')
  })

  it('surfaces matrix load errors from the API without stale registry UI', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(api.vars.getMatrix).mockRejectedValueOnce(
      new ApiError('变量解析失败', 422, 'resolution_failed', [
        {
          code: 'MISSING_REFERENCE',
          severity: 'error',
          key: 'CLIENT',
          path: ['CLIENT', 'MISSING'],
          message: '变量不存在: MISSING',
        },
      ]),
    )

    try {
      renderVars()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('变量加载失败')
      expect(alert.textContent).toContain('变量解析失败')
      expect(screen.queryByLabelText('Profiles')).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith('Failed to load profile vars', expect.any(ApiError))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('shows save errors from layer operations as feedback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(api.vars.setOverride).mockRejectedValueOnce(
      new ApiError('覆盖值类型与 base 定义不匹配', 422, 'override_type_mismatch'),
    )
    try {
      renderVars()
      fireEvent.click(await screen.findByRole('button', { name: /Base/ }))
      await screen.findByText('CLIENT')
      fireEvent.click(screen.getByRole('button', { name: '编辑 CLIENT' }))

      const dialog = await screen.findByRole('dialog', { name: '编辑配置' })
      fireEvent.click(
        within(within(dialog).getByLabelText('配置槽位')).getByRole('button', { name: 'CX' }),
      )
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

      expect(await screen.findByText('覆盖值类型与 base 定义不匹配')).toBeDefined()
      await waitFor(() =>
        expect(api.vars.setOverride).toHaveBeenCalledWith(
          '/repo',
          'base-agent',
          'CLIENT',
          { value: '' },
          'codex',
        ),
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(ApiError) }),
        'Failed to save vars config',
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})
