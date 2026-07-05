import { describe, expect, it } from 'vitest'
import { deleteVariable, renameVariable, setVariable, type VarsEnvironment } from '../src/index.js'

const typed = (entries: VarsEnvironment['entries']): VarsEnvironment => ({
  format: 'typed',
  entries,
})

describe('vars mutators', () => {
  it('globally renames definitions and token-aware references atomically', () => {
    const input = {
      base: typed({
        old: { type: 'string', value: 'base' },
        'old-name': { type: 'string', value: 'boundary' },
        use: { type: 'string', value: '${old}/${old:fallback}/${old-name}' },
      }),
      prod: typed({ old: { type: 'secret', value: 'prod' } }),
    }
    const result = renameVariable(input, 'base', 'old', 'new')
    expect(result.diagnostics).toEqual([])
    expect(result.changed).toEqual(['base', 'prod'])
    expect(result.environments.base.entries).toEqual({
      new: { type: 'string', value: 'base' },
      'old-name': { type: 'string', value: 'boundary' },
      use: { type: 'string', value: '${new}/${new:fallback}/${old-name}' },
    })
    expect(result.environments.prod.entries.new).toEqual({ type: 'secret', value: 'prod' })
    expect(input.base.entries.old).toEqual({ type: 'string', value: 'base' })
  })

  it('rejects rename conflicts without mutation', () => {
    const input = {
      base: typed({ old: { type: 'string', value: 'x' }, new: { type: 'string', value: 'y' } }),
    }
    const result = renameVariable(input, 'base', 'old', 'new')
    expect(result.diagnostics[0]?.code).toBe('variable_conflict')
    expect(result.changed).toEqual([])
    expect(result.environments).not.toBe(input)
    expect(result.environments.base.entries.old).not.toBe(input.base.entries.old)
  })

  it('requires confirmation before deleting a referenced definition', () => {
    const input = {
      base: typed({
        host: { type: 'string', value: 'x' },
        url: { type: 'string', value: '${host}' },
      }),
    }
    const blocked = deleteVariable(input, 'base', 'host', { confirmed: false })
    expect(blocked.diagnostics[0]?.code).toBe('delete_confirmation_required')
    expect(blocked.changed).toEqual([])
    const impactToken = blocked.deleteImpact?.impactToken
    expect(impactToken).toEqual(expect.any(String))
    const deleted = deleteVariable(input, 'base', 'host', {
      confirmed: true,
      expectedImpactToken: impactToken,
    })
    expect(deleted.changed).toEqual(['base'])
    expect(deleted.diagnostics.map((item) => item.code)).toEqual(['dangling_reference'])
    expect(deleted.environments.base.entries.host).toBeUndefined()
  })

  it('rejects a stale delete impact token and accepts a fresh inspection', () => {
    const input = {
      base: typed({
        host: { type: 'string', value: 'x' },
        url: { type: 'string', value: '${host}' },
      }),
    }
    const inspected = deleteVariable(input, 'base', 'host', { confirmed: false })
    const changed = {
      base: typed({ ...input.base.entries, health: { type: 'string' as const, value: '${url}' } }),
    }
    const stale = deleteVariable(changed, 'base', 'host', {
      confirmed: true,
      expectedImpactToken: inspected.deleteImpact?.impactToken,
    })
    expect(stale.changed).toEqual([])
    expect(stale.diagnostics[0]?.code).toBe('impact_changed')
    const refreshed = deleteVariable(changed, 'base', 'host', { confirmed: false })
    const deleted = deleteVariable(changed, 'base', 'host', {
      confirmed: true,
      expectedImpactToken: refreshed.deleteImpact?.impactToken,
    })
    expect(deleted.changed).toEqual(['base'])
  })

  it('deletes without confirmation when there are no dependents and reports not found stably', () => {
    const input = { base: typed({ host: { type: 'string', value: 'x' } }) }
    expect(deleteVariable(input, 'base', 'host', { confirmed: false }).changed).toEqual(['base'])
    expect(
      deleteVariable(input, 'base', 'missing', { confirmed: false }).diagnostics[0]?.code,
    ).toBe('not_found')
  })

  it('allows unrelated edits with existing dangling warnings and clears repaired warnings', () => {
    const input = {
      base: typed({
        use: { type: 'string', value: '${missing}' },
        other: { type: 'string', value: 'before' },
      }),
    }
    const edited = setVariable(input, 'base', 'other', { type: 'string', value: 'after' })
    expect(edited.changed).toEqual(['base'])
    expect(edited.diagnostics.map((item) => item.code)).toEqual(['dangling_reference'])
    const repaired = setVariable(edited.environments, 'base', 'missing', {
      type: 'string',
      value: 'ok',
    })
    expect(repaired.diagnostics).toEqual([])
  })

  it('rejects newly introduced dangling references but permits removing one', () => {
    const input = { base: typed({ use: { type: 'string', value: '${already-missing}' } }) }
    const expanded = setVariable(input, 'base', 'new-use', {
      type: 'string',
      value: '${new-missing}',
    })
    expect(expanded.diagnostics.some((item) => item.code === 'missing_reference')).toBe(true)
    expect(expanded.changed).toEqual([])
    const fixed = setVariable(input, 'base', 'use', { type: 'string', value: 'fixed' })
    expect(fixed.diagnostics).toEqual([])
  })

  it('does not treat a reference with a default as dangling', () => {
    const input = { base: typed({}) }
    const result = setVariable(input, 'base', 'use', {
      type: 'string',
      value: '${missing:fallback}',
    })
    expect(result.changed).toEqual(['base'])
    expect(result.diagnostics).toEqual([])
  })

  it('preserves null-prototype entries and __proto__ keys without mutating input', () => {
    const entries = Object.create(null) as VarsEnvironment['entries']
    Object.defineProperty(entries, '__proto__', {
      value: { type: 'string', value: 'safe' },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const input = Object.freeze({ base: typed(entries) })
    const result = setVariable(input, 'base', 'normal', { type: 'string', value: '${__proto__}' })
    expect(Object.getPrototypeOf(result.environments.base.entries)).toBeNull()
    expect(result.environments.base.entries.__proto__).toEqual({ type: 'string', value: 'safe' })
    expect(input.base.entries.normal).toBeUndefined()
  })

  it('deeply isolates nested JSON snapshots including arrays and __proto__', () => {
    const object = Object.create(null) as Record<string, unknown>
    Object.defineProperty(object, '__proto__', { value: { nested: ['input'] }, enumerable: true })
    const input = {
      base: typed({ config: { type: 'json', value: object } }),
    }
    const result = setVariable(input, 'base', 'name', { type: 'string', value: 'ok' })
    const output = result.environments.base.entries.config
    expect(output.type).toBe('json')
    if (
      output.type !== 'json' ||
      output.value === null ||
      Array.isArray(output.value) ||
      typeof output.value !== 'object'
    )
      return
    expect(Object.getPrototypeOf(output.value)).toBeNull()
    const protoValue = output.value.__proto__
    expect(protoValue && typeof protoValue === 'object' && !Array.isArray(protoValue)).toBe(true)
    if (!protoValue || typeof protoValue !== 'object' || Array.isArray(protoValue)) return
    ;(protoValue.nested as string[])[0] = 'result'
    expect(
      (input.base.entries.config.value as Record<string, { nested: string[] }>).__proto__.nested[0],
    ).toBe('input')
  })

  it('normalizes safe JSON input without sharing it', () => {
    const value = { list: [{ enabled: true }] }
    const input = { base: typed({}) }
    const result = setVariable(input, 'base', 'config', { type: 'json', value })
    const stored = result.environments.base.entries.config
    expect(stored.type).toBe('json')
    if (
      stored.type !== 'json' ||
      !stored.value ||
      Array.isArray(stored.value) ||
      typeof stored.value !== 'object'
    )
      return
    expect(Object.getPrototypeOf(stored.value)).toBeNull()
    value.list[0].enabled = false
    expect(stored.value).toEqual({ list: [{ enabled: true }] })
  })

  it.each([
    ['Date', new Date(0)],
    [
      'class instance',
      new (class Example {
        value = 1
      })(),
    ],
    ['function', () => undefined],
    ['symbol', Symbol('x')],
    ['bigint', 1n],
    ['infinite number', Number.POSITIVE_INFINITY],
  ])('rejects non-JSON %s values', (_label, value) => {
    const input = { base: typed({}) }
    const result = setVariable(input, 'base', 'config', { type: 'json', value } as never)
    expect(result.changed).toEqual([])
    expect(result.diagnostics[0]?.code).toBe('invalid_value')
  })

  it('rejects accessors without invoking getters', () => {
    let invoked = false
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        invoked = true
        throw new Error('must not run')
      },
    })
    const result = setVariable({ base: typed({}) }, 'base', 'config', {
      type: 'json',
      value,
    } as never)
    expect(result.diagnostics[0]?.code).toBe('invalid_value')
    expect(invoked).toBe(false)
  })

  it('rejects a top-level entry accessor without invoking it', () => {
    let invoked = false
    const entry = Object.defineProperties(
      {},
      {
        type: { enumerable: true, value: 'json' },
        value: {
          enumerable: true,
          get() {
            invoked = true
            throw new Error('must not run')
          },
        },
      },
    )
    const result = setVariable({ base: typed({}) }, 'base', 'config', entry as never)
    expect(result.diagnostics[0]?.code).toBe('invalid_value')
    expect(invoked).toBe(false)
  })

  it('rejects top-level entry extras and symbols', () => {
    const withExtra = { type: 'json', value: null, extra: true }
    const withSymbol = { type: 'json', value: null, [Symbol('extra')]: true }
    expect(
      setVariable({ base: typed({}) }, 'base', 'a', withExtra as never).diagnostics[0]?.code,
    ).toBe('invalid_value')
    expect(
      setVariable({ base: typed({}) }, 'base', 'b', withSymbol as never).diagnostics[0]?.code,
    ).toBe('invalid_value')
  })

  it('renames and deletes a __proto__ definition safely', () => {
    const entries = Object.create(null) as VarsEnvironment['entries']
    entries.__proto__ = { type: 'string', value: 'safe' }
    entries.use = { type: 'string', value: '${__proto__}' }
    const input = { base: typed(entries) }
    const renamed = renameVariable(input, 'base', '__proto__', 'prototype')
    expect(renamed.environments.base.entries.use).toEqual({ type: 'string', value: '${prototype}' })
    const inspection = deleteVariable(renamed.environments, 'base', 'prototype', {
      confirmed: false,
    })
    const deleted = deleteVariable(renamed.environments, 'base', 'prototype', {
      confirmed: true,
      expectedImpactToken: inspection.deleteImpact?.impactToken,
    })
    expect(
      Object.prototype.hasOwnProperty.call(deleted.environments.base.entries, 'prototype'),
    ).toBe(false)
  })
})
