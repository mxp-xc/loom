// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '@loom/core'
import { useManifest, refreshManifest } from '../src/hooks/useManifest'
import { api } from '../src/lib/api'
import { deferred } from './deferred'

vi.mock('../src/lib/api', () => ({
  api: {
    getManifest: vi.fn(),
  },
}))

function manifest(label: string): Manifest {
  return {
    skills: { sources: [], skills: [] },
    mcp: [],
    memory: { memories: [], active: null, activeContent: label },
    vars: { default: {}, active: {} },
    config: {},
    errors: [],
  }
}

function ManifestConsumer({
  repoPath,
  label = 'manifest',
  onError,
}: {
  repoPath: string
  label?: string
  onError?: (error: unknown) => void
}) {
  const result = useManifest(repoPath, { onError })
  return (
    <div>
      <span>{`${label}:${result.loading ? 'loading' : (result.manifest?.memory.activeContent ?? 'empty')}`}</span>
      <button type="button" onClick={result.reload}>
        reload
      </button>
    </div>
  )
}

describe('useManifest', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('shares one initial request across consumers and StrictMode effect replay', async () => {
    const request = deferred<Manifest>()
    vi.mocked(api.getManifest).mockReturnValue(request.promise)

    render(
      <StrictMode>
        <ManifestConsumer repoPath="/strict-mode" label="shell" />
        <ManifestConsumer repoPath="/strict-mode" label="page" />
      </StrictMode>,
    )

    await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(1))
    request.resolve(manifest('ready'))

    expect(await screen.findByText('shell:ready')).toBeDefined()
    expect(screen.getByText('page:ready')).toBeDefined()
  })

  it('ignores a previous repository response after switching repositories', async () => {
    const repoA = deferred<Manifest>()
    const repoB = deferred<Manifest>()
    vi.mocked(api.getManifest).mockImplementation((repoPath) =>
      repoPath === '/repo-a' ? repoA.promise : repoB.promise,
    )
    const view = render(<ManifestConsumer repoPath="/repo-a" />)

    view.rerender(<ManifestConsumer repoPath="/repo-b" />)
    repoB.resolve(manifest('repo-b'))
    expect(await screen.findByText('manifest:repo-b')).toBeDefined()

    repoA.resolve(manifest('repo-a'))
    await act(async () => undefined)
    expect(screen.getByText('manifest:repo-b')).toBeDefined()
  })

  it('keeps a refresh result when an older initial request resolves later', async () => {
    const initial = deferred<Manifest>()
    const refresh = deferred<Manifest>()
    vi.mocked(api.getManifest)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise)
    render(<ManifestConsumer repoPath="/initial-refresh" />)
    await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(1))

    const refreshing = refreshManifest('/initial-refresh')
    await act(async () => {
      refresh.resolve(manifest('refreshed'))
      await refreshing
    })
    expect(await screen.findByText('manifest:refreshed')).toBeDefined()

    initial.resolve(manifest('initial'))
    await act(async () => undefined)
    expect(screen.getByText('manifest:refreshed')).toBeDefined()
  })

  it('commits an older pending success after a newer refresh fails', async () => {
    const initial = deferred<Manifest>()
    const refresh = deferred<Manifest>()
    vi.mocked(api.getManifest)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise)
    render(<ManifestConsumer repoPath="/failed-refresh" />)
    await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(1))

    const refreshing = refreshManifest('/failed-refresh').catch((error: unknown) => error)
    const refreshError = new Error('refresh failed')
    refresh.reject(refreshError)
    expect(await refreshing).toBe(refreshError)

    initial.resolve(manifest('initial'))
    expect(await screen.findByText('manifest:initial')).toBeDefined()
  })

  it('commits only the latest reload when responses arrive out of order', async () => {
    const initial = deferred<Manifest>()
    const firstReload = deferred<Manifest>()
    const secondReload = deferred<Manifest>()
    vi.mocked(api.getManifest)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(firstReload.promise)
      .mockReturnValueOnce(secondReload.promise)
    render(<ManifestConsumer repoPath="/reload-race" />)
    initial.resolve(manifest('initial'))
    expect(await screen.findByText('manifest:initial')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    secondReload.resolve(manifest('second'))
    expect(await screen.findByText('manifest:second')).toBeDefined()

    firstReload.resolve(manifest('first'))
    await act(async () => undefined)
    expect(screen.getByText('manifest:second')).toBeDefined()
  })

  it('does not report a reload failure after unmount', async () => {
    const initial = deferred<Manifest>()
    const reload = deferred<Manifest>()
    const onError = vi.fn()
    vi.mocked(api.getManifest)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(reload.promise)
    const view = render(<ManifestConsumer repoPath="/unmount" onError={onError} />)
    initial.resolve(manifest('initial'))
    expect(await screen.findByText('manifest:initial')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))
    view.unmount()
    reload.reject(new Error('late failure'))
    await act(async () => undefined)

    expect(onError).not.toHaveBeenCalled()
  })
})
