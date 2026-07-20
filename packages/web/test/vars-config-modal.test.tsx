// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import type { VarsMatrixResponse } from '../src/lib/vars'
import VarsConfigModal from '../src/views/vars/VarsConfigModal'
import type { VarsProfileEntry, VarsProfileSummary } from '../src/views/vars/profile-model'
import { deferred } from './deferred'

vi.mock('../src/lib/api', () => ({
  api: {
    vars: {
      setBaseKey: vi.fn(),
      setOverride: vi.fn(),
      clearOverride: vi.fn(),
    },
  },
}))

vi.mock('../src/views/vars/VarsMonacoValueEditor', () => ({
  default: ({
    ariaLabel,
    disabled,
    value,
    onChange,
  }: {
    ariaLabel: string
    disabled: boolean
    value: string
    onChange: (value: string) => void
  }) => (
    <textarea
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  keysFromVarsResolution: () => [],
}))

const entry: VarsProfileEntry = {
  key: 'DEMO',
  type: 'string',
  valuePreview: 'local value',
  state: 'configured',
  agentSlots: [],
  diagnostics: [],
}

const profile: VarsProfileSummary = {
  id: 'local',
  name: 'Local',
  kindBadge: 'local',
  description: '本机专属',
  configuredCount: 1,
  locked: false,
  entries: [entry],
}

const definitionMatrix: VarsMatrixResponse = {
  ok: true,
  agent: 'default',
  builtinKeys: [],
  userKeys: ['DEMO'],
  snapshot: {
    base: { DEMO: { type: 'string', value: 'base value' } },
    baseAgent: {},
    local: { DEMO: { value: 'local value' } },
    localAgent: {},
  },
  resolution: {
    ok: true,
    values: { DEMO: { type: 'string', value: 'local value' } },
    sources: { DEMO: { locality: 'local', layer: 'local' } },
    overrideChains: { DEMO: [{ locality: 'local', layer: 'local' }] },
    dependencies: { DEMO: [] },
    diagnostics: [],
  },
}

function renderModal(overrides?: {
  onClose?: () => void
  onSaved?: () => Promise<void>
  onError?: (message: string) => void
}) {
  const onClose = overrides?.onClose ?? vi.fn()
  const onSaved = overrides?.onSaved ?? vi.fn(async () => undefined)
  const onError = overrides?.onError ?? vi.fn()
  const view = render(
    <VarsConfigModal
      repoPath="/repo"
      modal={{ kind: 'edit', entry }}
      profile={profile}
      baseEntries={[entry]}
      viewScope="default"
      definitionMatrix={definitionMatrix}
      matricesByAgent={{}}
      agents={[]}
      onClose={onClose}
      onSaved={onSaved}
      onError={onError}
    />,
  )
  return { ...view, onClose, onSaved, onError }
}

describe('VarsConfigModal pending operations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.vars.setOverride).mockResolvedValue({ ok: true })
    vi.mocked(api.vars.clearOverride).mockResolvedValue({ ok: true })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('uses one lock for duplicate save, clear, and every close path', async () => {
    const saveRequest = deferred<{ ok: true }>()
    vi.mocked(api.vars.setOverride).mockReturnValue(saveRequest.promise)
    const { onClose } = renderModal()
    const dialog = screen.getByRole('dialog', { name: '编辑配置' })
    const saveButton = within(dialog).getByRole('button', { name: '保存' })

    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    expect(api.vars.setOverride).toHaveBeenCalledTimes(1)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(within(dialog).getByRole('button', { name: '清除配置' }).hasAttribute('disabled')).toBe(
      true,
    )
    fireEvent.click(within(dialog).getByRole('button', { name: '清除配置' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    const backdrop = dialog.parentElement!
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)

    expect(api.vars.clearOverride).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      saveRequest.resolve({ ok: true })
      await saveRequest.promise
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('keeps the dialog open and unlocks controls after a save failure', async () => {
    const onError = vi.fn()
    vi.mocked(api.vars.setOverride).mockRejectedValueOnce(new Error('write failed'))
    const { onClose } = renderModal({ onError })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('write failed'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '编辑配置' }).getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.vars.setOverride).toHaveBeenCalledTimes(2)
  })

  it('keeps the lock until the refreshed data has finished loading', async () => {
    const refreshed = deferred<void>()
    const { onClose } = renderModal({ onSaved: () => refreshed.promise })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.vars.setOverride).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog', { name: '编辑配置' }).getAttribute('aria-busy')).toBe('true')
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      refreshed.resolve()
      await refreshed.promise
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
