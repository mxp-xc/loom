import { describe, expect, it } from 'vitest'
import {
  VarsCodecError,
  parseVarsBaseDefinitions,
  parseVarsEnvironment,
  parseVarsOverrides,
  serializeVarsBaseDefinitions,
  serializeVarsEnvironment,
  serializeVarsOverrides,
} from '../src/vars-codec'
import type { VarsEnvironment } from '../src/vars-types'

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining({ code }))
}

describe('parseVarsEnvironment', () => {
  it('parses all five explicit typed entries', () => {
    expect(
      parseVarsEnvironment(`
TEXT: { type: string, format: path, value: hello }
TOKEN: { type: secret, format: markdown, value: hidden }
COUNT: { type: number, value: 3.5 }
ENABLED: { type: boolean, value: true }
CONFIG:
  type: json
  value: { nested: [null, false, 2, ok] }
`),
    ).toEqual({
      format: 'typed',
      entries: {
        TEXT: { type: 'string', format: 'path', value: 'hello' },
        TOKEN: { type: 'secret', format: 'markdown', value: 'hidden' },
        COUNT: { type: 'number', value: 3.5 },
        ENABLED: { type: 'boolean', value: true },
        CONFIG: { type: 'json', value: { nested: [null, false, 2, 'ok'] } },
      },
    })
  })

  it('rejects an invalid variable key', () => {
    expect(() => parseVarsEnvironment('bad key: value\n')).toThrowError(
      expect.objectContaining({ code: 'var_key_invalid' }),
    )
  })

  it.each(['.nan', '.inf', '-.inf'])('rejects non-finite number %s', (value) => {
    expect(() => parseVarsEnvironment(`NUMBER:\n  type: number\n  value: ${value}\n`)).toThrowError(
      expect.objectContaining({ code: 'typed_value_invalid' }),
    )
  })

  it('converts every legacy scalar to a string', () => {
    expect(parseVarsEnvironment('TEXT: hello\nCOUNT: 12\nENABLED: false\n')).toEqual({
      format: 'legacy',
      entries: {
        TEXT: { type: 'string', value: 'hello' },
        COUNT: { type: 'string', value: '12' },
        ENABLED: { type: 'string', value: 'false' },
      },
    })
  })

  it.each(['VALUE: null\n', 'VALUE: [one, two]\n', 'VALUE: { nested: true }\n'])(
    'rejects a non-scalar legacy value',
    (source) => {
      expect(() => parseVarsEnvironment(source)).toThrowError(
        expect.objectContaining({ code: 'legacy_value_invalid' }),
      )
    },
  )

  it('preserves own __proto__ keys at the root and inside JSON without pollution', () => {
    const environment = parseVarsEnvironment(`
"__proto__": { type: string, value: root }
CONFIG:
  type: json
  value:
    "__proto__": { polluted: true }
`)

    expect(Object.hasOwn(environment.entries, '__proto__')).toBe(true)
    expect(environment.entries['__proto__']).toEqual({ type: 'string', value: 'root' })
    const config = environment.entries.CONFIG
    expect(config.type).toBe('json')
    if (
      config.type === 'json' &&
      typeof config.value === 'object' &&
      config.value !== null &&
      !Array.isArray(config.value)
    ) {
      expect(Object.hasOwn(config.value, '__proto__')).toBe(true)
      expect(config.value['__proto__']).toEqual({ polluted: true })
    }
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()

    const roundTripped = parseVarsEnvironment(serializeVarsEnvironment(environment))
    expect(Object.hasOwn(roundTripped.entries, '__proto__')).toBe(true)
    expect(roundTripped.entries['__proto__']).toEqual({ type: 'string', value: 'root' })
    const roundTrippedConfig = roundTripped.entries.CONFIG
    if (
      roundTrippedConfig.type === 'json' &&
      typeof roundTrippedConfig.value === 'object' &&
      roundTrippedConfig.value !== null &&
      !Array.isArray(roundTrippedConfig.value)
    ) {
      expect(Object.hasOwn(roundTrippedConfig.value, '__proto__')).toBe(true)
      expect(roundTrippedConfig.value['__proto__']).toEqual({ polluted: true })
    }
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('uses stable error codes for parser failures', () => {
    expectCode(() => parseVarsEnvironment('VALUE: ['), 'yaml_invalid')
    expectCode(() => parseVarsEnvironment('[one, two]'), 'vars_document_invalid')
    expectCode(
      () => parseVarsEnvironment('VALUE: { type: boolean, value: nope }'),
      'typed_value_invalid',
    )
    expectCode(() => parseVarsEnvironment('VALUE: { nested: true }'), 'legacy_value_invalid')
  })

  it('rejects unknown fields instead of preserving or stripping them', () => {
    expectCode(
      () => parseVarsEnvironment('VALUE: { type: string, value: ok, future: true }'),
      'typed_value_invalid',
    )
    expectCode(
      () => parseVarsBaseDefinitions('VALUE: { type: string, value: ok, future: true }'),
      'typed_value_invalid',
    )
    expectCode(
      () =>
        serializeVarsEnvironment({
          format: 'typed',
          entries: { VALUE: { type: 'string', value: 'ok', future: true } },
        } as never),
      'vars_environment_invalid',
    )
  })

  it('keeps parser causes without exposing YAML source in the wrapper message or stack', () => {
    const secret = 'top-secret-parser-payload'
    let captured: unknown
    try {
      parseVarsEnvironment(`API_KEY: [${secret}`)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(VarsCodecError)
    expect(captured).toMatchObject({ code: 'yaml_invalid', cause: expect.any(Error) })
    expect(String(captured)).not.toContain(secret)
    expect((captured as Error).stack).not.toContain(secret)
  })
})

describe('serializeVarsEnvironment', () => {
  it('round-trips a typed environment', () => {
    const environment = parseVarsEnvironment(`
TEXT: { type: string, format: path, value: hello }
TOKEN: { type: secret, format: markdown, value: hidden }
COUNT: { type: number, value: 3.5 }
ENABLED: { type: boolean, value: true }
CONFIG: { type: json, value: { nested: [null, false, 2, ok] } }
`)

    expect(parseVarsEnvironment(serializeVarsEnvironment(environment))).toEqual(environment)
  })

  it('round-trips an empty typed environment', () => {
    const environment: VarsEnvironment = { format: 'typed', entries: {} }
    expect(parseVarsEnvironment(serializeVarsEnvironment(environment))).toEqual(environment)
  })

  it('rejects non-string entries in a legacy environment', () => {
    const invalid = {
      format: 'legacy',
      entries: { COUNT: { type: 'number', value: 2 } },
    } as VarsEnvironment
    expectCode(() => serializeVarsEnvironment(invalid), 'vars_environment_invalid')
  })
})

describe('agent-aware vars codecs', () => {
  it('parses and serializes base definitions with string formats', () => {
    const definitions = parseVarsBaseDefinitions(`
rtk:
  type: string
  format: path
  value: \${LOOM_CONFIG_DIR}/RTK.md
rules:
  type: string
  format: markdown
  value: ''
model:
  type: json
  value: { name: gpt-5, temperature: 0.2 }
`)

    expect(definitions).toEqual({
      rtk: { type: 'string', format: 'path', value: '${LOOM_CONFIG_DIR}/RTK.md' },
      rules: { type: 'string', format: 'markdown', value: '' },
      model: { type: 'json', value: { name: 'gpt-5', temperature: 0.2 } },
    })
    expect(parseVarsBaseDefinitions(serializeVarsBaseDefinitions(definitions))).toEqual(definitions)
  })

  it('parses and serializes value-only overrides', () => {
    const overrides = parseVarsOverrides(`
agent_name:
  value: Codex
enabled:
  value: true
`)

    expect(overrides).toEqual({
      agent_name: { value: 'Codex' },
      enabled: { value: true },
    })
    expect(parseVarsOverrides(serializeVarsOverrides(overrides))).toEqual(overrides)
  })

  it('rejects user LOOM_ definitions, invalid formats, and typed override entries', () => {
    expect(() =>
      parseVarsBaseDefinitions('LOOM_AGENT: { type: string, value: nope }'),
    ).toThrowError(expect.objectContaining({ code: 'reserved_builtin_key' }))
    expect(() =>
      parseVarsBaseDefinitions('text: { type: string, format: html, value: nope }'),
    ).toThrowError(expect.objectContaining({ code: 'typed_value_invalid' }))
    expect(() => parseVarsOverrides('agent_name: { type: string, value: Codex }')).toThrowError(
      expect.objectContaining({ code: 'override_entry_invalid' }),
    )
  })
})
