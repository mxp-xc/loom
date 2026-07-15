// @vitest-environment jsdom
import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import { useManifest } from '../src/hooks/useManifest'

vi.mock('../src/lib/api', () => ({
  api: {
    getManifest: vi.fn(),
  },
}))

function ManifestConsumer({ label }: { label: string }) {
  const { manifest, loading } = useManifest('/tmp/shared')
  return <span>{loading ? `${label}:loading` : `${label}:${manifest ? 'ready' : 'empty'}`}</span>
}

describe('useManifest', () => {
  it('shares one initial request across consumers and StrictMode effect replay', async () => {
    let resolveManifest!: (value: unknown) => void
    const pendingManifest = new Promise((resolve) => {
      resolveManifest = resolve
    })
    vi.mocked(api.getManifest).mockReturnValue(pendingManifest)

    render(
      <StrictMode>
        <ManifestConsumer label="shell" />
        <ManifestConsumer label="page" />
      </StrictMode>,
    )

    await waitFor(() => expect(api.getManifest).toHaveBeenCalledTimes(1))
    resolveManifest({
      skills: { sources: [], skills: [] },
      mcp: [],
      memory: { memories: [], active: null, activeContent: '' },
      vars: { default: {}, active: {} },
      config: {},
      errors: [],
    })

    expect(await screen.findByText('shell:ready')).toBeDefined()
    expect(screen.getByText('page:ready')).toBeDefined()
  })
})
