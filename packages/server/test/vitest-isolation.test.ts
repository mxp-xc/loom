import { describe, expect, it, vi } from 'vitest'

const envKey = 'LOOM_VITEST_ISOLATION_TEST'
const globalKey = '__loomVitestIsolationTest'
const originalEnv = process.env[envKey]
const originalGlobal = Reflect.get(globalThis, globalKey)
const mock = vi.fn()
const target = { value: () => 'original' }

describe.sequential('Vitest project isolation', () => {
  it('allows a test to stub process, global, mock, and spy state', () => {
    vi.stubEnv(envKey, 'stubbed')
    vi.stubGlobal(globalKey, 'stubbed')
    mock()
    vi.spyOn(target, 'value').mockReturnValue('stubbed')

    expect(process.env[envKey]).toBe('stubbed')
    expect(Reflect.get(globalThis, globalKey)).toBe('stubbed')
    expect(mock).toHaveBeenCalledOnce()
    expect(target.value()).toBe('stubbed')
  })

  it('restores all configured isolation state before the next test', () => {
    expect(process.env[envKey]).toBe(originalEnv)
    expect(Reflect.get(globalThis, globalKey)).toBe(originalGlobal)
    expect(mock).not.toHaveBeenCalled()
    expect(target.value()).toBe('original')
  })
})
