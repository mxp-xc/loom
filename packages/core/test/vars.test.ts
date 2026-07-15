import { describe, expect, it } from 'vitest'
import { resolveVars, resolveVarsChain } from '../src/vars'
import {
  createBuiltinVars,
  renderTextWithResolvedVars,
  resolveLayeredVars,
} from '../src/vars-agent-aware'
import {
  prepareVarsMutationPersistence,
  resolveVarsLifecycle,
  validateVarDraft,
} from '../src/vars-lifecycle'
import type { VarsEnvironment } from '../src/vars-types'

const typed = (entries: VarsEnvironment['entries']): VarsEnvironment => ({
  format: 'typed',
  entries,
})

describe('resolveVarsChain', () => {
  it('later environments override earlier environments and report the final source', () => {
    const result = resolveVarsChain(
      {
        base: typed({ HOST: { type: 'string', value: 'base.example' } }),
        prod: typed({ HOST: { type: 'string', value: 'prod.example' } }),
      },
      ['base', 'prod'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: { HOST: { type: 'string', value: 'prod.example' } },
      sources: { HOST: 'prod' },
    })
  })

  it('resolves a base string reference against the final merged values', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          URL: { type: 'string', value: 'https://${HOST}' },
          HOST: { type: 'string', value: 'dev' },
        }),
        prod: typed({ HOST: { type: 'string', value: 'prod' } }),
      },
      ['base', 'prod'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: { URL: { type: 'string', value: 'https://prod' } },
    })
  })

  it('uses defaults as literal text without recursively resolving them', () => {
    const result = resolveVarsChain(
      { base: typed({ VALUE: { type: 'string', value: '${MISSING:${OTHER}}' } }) },
      ['base'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: { VALUE: { type: 'string', value: '${OTHER}' } },
      dependencies: { VALUE: ['MISSING'] },
    })
  })

  it('stringifies references to every typed literal and preserves non-string entries', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          N: { type: 'number', value: 2 },
          B: { type: 'boolean', value: false },
          J: { type: 'json', value: { nested: ['x', 1] } },
          TEXT: { type: 'string', value: '${N}/${B}/${J}' },
        }),
      },
      ['base'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: {
        N: { type: 'number', value: 2 },
        B: { type: 'boolean', value: false },
        J: { type: 'json', value: { nested: ['x', 1] } },
        TEXT: { type: 'string', value: '2/false/{"nested":["x",1]}' },
      },
      dependencies: { TEXT: ['N', 'B', 'J'] },
    })
  })

  it('recursively resolves references including dotted and hyphenated keys', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          A: { type: 'string', value: '${service.url}' },
          'service.url': { type: 'secret', value: '${host-name}' },
          'host-name': { type: 'string', value: 'loom' },
        }),
      },
      ['base'],
    )
    expect(result).toMatchObject({
      ok: true,
      values: { A: { value: 'loom' } },
      dependencies: { A: ['service.url'], 'service.url': ['host-name'] },
    })
  })

  it('returns an error diagnostic for a missing reference and no partial values', () => {
    const result = resolveVarsChain({ base: typed({ A: { type: 'string', value: '${NOPE}' } }) }, [
      'base',
    ])
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'MISSING_REFERENCE',
          severity: 'error',
          environment: 'base',
          key: 'A',
          path: ['A', 'NOPE'],
          message: '变量 A 引用了不存在的变量 NOPE',
        },
      ],
    })
  })

  it('reports the complete cycle path', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          A: { type: 'string', value: '${B}' },
          B: { type: 'string', value: '${C}' },
          C: { type: 'string', value: '${A}' },
        }),
      },
      ['base'],
    )
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'REFERENCE_CYCLE',
          severity: 'error',
          environment: 'base',
          key: 'A',
          path: ['A', 'B', 'C', 'A'],
          message: '变量引用形成循环: A -> B -> C -> A',
        },
      ],
    })
  })

  it.each([
    { chain: [], code: 'EMPTY_CHAIN', message: '环境链不能为空' },
    {
      chain: ['base', 'base'],
      code: 'DUPLICATE_ENVIRONMENT',
      environment: 'base',
      path: ['base', 'base'],
      message: '环境链包含重复环境: base',
    },
    {
      chain: ['missing'],
      code: 'ENVIRONMENT_NOT_FOUND',
      environment: 'missing',
      path: ['missing'],
      message: '环境不存在: missing',
    },
  ])('rejects invalid chain: $code', ({ chain, ...diagnostic }) => {
    expect(resolveVarsChain({ base: typed({}) }, chain)).toEqual({
      ok: false,
      diagnostics: [{ severity: 'error', ...diagnostic }],
    })
  })

  it('never reads process.env', () => {
    const previous = process.env.LOOM_VARS_TEST
    process.env.LOOM_VARS_TEST = 'process-value'
    try {
      expect(
        resolveVarsChain(
          { base: typed({ A: { type: 'string', value: '${LOOM_VARS_TEST:fallback}' } }) },
          ['base'],
        ),
      ).toMatchObject({ ok: true, values: { A: { value: 'fallback' } } })
    } finally {
      if (previous === undefined) delete process.env.LOOM_VARS_TEST
      else process.env.LOOM_VARS_TEST = previous
    }
  })

  it('safely resolves and overrides __proto__ without polluting Object.prototype', () => {
    const baseEntries = Object.fromEntries([
      ['__proto__', { type: 'string' as const, value: 'base' }],
      ['REFERENCE', { type: 'string' as const, value: '${__proto__}' }],
    ])
    const prodEntries = Object.fromEntries([
      ['__proto__', { type: 'string' as const, value: 'prod' }],
    ])

    const result = resolveVarsChain({ base: typed(baseEntries), prod: typed(prodEntries) }, [
      'base',
      'prod',
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values['__proto__']).toEqual({ type: 'string', value: 'prod' })
    expect(result.values.REFERENCE).toEqual({ type: 'string', value: 'prod' })
    expect(result.sources['__proto__']).toBe('prod')
    expect(result.dependencies.REFERENCE).toEqual(['__proto__'])
    expect(Object.prototype).not.toHaveProperty('type')
    expect(Object.prototype).not.toHaveProperty('value')
  })

  it('deduplicates direct dependencies in first-seen order without changing output', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          A: { type: 'string', value: '${B}/${C}/${B}' },
          B: { type: 'string', value: 'b' },
          C: { type: 'string', value: 'c' },
        }),
      },
      ['base'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: { A: { type: 'string', value: 'b/c/b' } },
      dependencies: { A: ['B', 'C'] },
    })
  })

  it('preserves secret type after resolving references', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          TOKEN: { type: 'string', value: 'token' },
          SECRET: { type: 'secret', value: 'Bearer ${TOKEN}' },
        }),
      },
      ['base'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: { SECRET: { type: 'secret', value: 'Bearer token' } },
    })
  })

  it('supports empty defaults and defaults containing multiple colons', () => {
    const result = resolveVarsChain(
      {
        base: typed({
          EMPTY: { type: 'string', value: '${missing:}' },
          COLONS: { type: 'string', value: '${missing:a:b}' },
        }),
      },
      ['base'],
    )

    expect(result).toMatchObject({
      ok: true,
      values: {
        EMPTY: { type: 'string', value: '' },
        COLONS: { type: 'string', value: 'a:b' },
      },
    })
  })
})

describe('resolveLayeredVars', () => {
  const baseRef = { locality: 'synced', layer: 'base' } as const
  const baseAgentRef = { locality: 'synced', layer: 'agent', agent: 'codex' } as const
  const localRef = { locality: 'local', layer: 'local' } as const
  const localAgentRef = { locality: 'local', layer: 'agent', agent: 'codex' } as const

  it('merges base, agent, local, local-agent, and builtin layers in order', () => {
    const result = resolveLayeredVars({
      agent: 'codex',
      base: {
        agent_name: { type: 'string', value: 'Agent' },
        rtk: { type: 'string', format: 'path', value: '${LOOM_CONFIG_DIR}/RTK.md' },
      },
      baseAgent: { agent_name: { value: 'Base Codex' } },
      local: { agent_name: { value: 'Local Agent' } },
      localAgent: { agent_name: { value: 'Codex Local' } },
      builtin: createBuiltinVars({
        agent: 'codex',
        configDir: 'C:/Users/10107/.codex',
        skillsDir: '',
        agentFile: 'AGENTS.md',
      }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values.agent_name).toEqual({ type: 'string', value: 'Codex Local' })
    expect(result.sources.agent_name).toEqual(localAgentRef)
    expect(result.overrideChains.agent_name).toEqual([
      baseRef,
      baseAgentRef,
      localRef,
      localAgentRef,
    ])
    expect(result.values.rtk).toEqual({
      type: 'string',
      format: 'path',
      value: 'C:/Users/10107/.codex/RTK.md',
    })
    expect(result.dependencies.rtk).toEqual(['LOOM_CONFIG_DIR'])
    expect(result.sources.LOOM_AGENT).toEqual({
      locality: 'builtin',
      layer: 'runtime',
      agent: 'codex',
    })
  })

  it('resolves the default context from base and local without agent or runtime layers', () => {
    const result = resolveLayeredVars({
      base: {
        name: { type: 'string', value: 'Base' },
        path: { type: 'string', value: '${name}/mcp' },
      },
      local: { name: { value: 'Local' } },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values.name.value).toBe('Local')
    expect(result.values.path.value).toBe('Local/mcp')
    expect(result.sources.name).toEqual(localRef)
    expect(result.values).not.toHaveProperty('LOOM_AGENT')
  })

  it('rejects unsupported defaults and json text interpolation', () => {
    const defaulted = resolveLayeredVars({
      agent: 'codex',
      base: { text: { type: 'string', value: '${missing:fallback}' } },
    })
    expect(defaulted).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'UNSUPPORTED_DEFAULT', key: 'text', path: ['text', 'missing'] }],
    })

    const json = resolveLayeredVars({
      agent: 'codex',
      base: {
        config: { type: 'json', value: { model: 'gpt-5' } },
        text: { type: 'string', value: '${config}' },
      },
    })
    expect(json).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'JSON_TEXT_INTERPOLATION', key: 'text', path: ['text', 'config'] }],
    })
  })

  it('renders text templates with escape handling and diagnostics', () => {
    const resolution = resolveLayeredVars({
      agent: 'codex',
      base: {
        name: { type: 'string', value: 'Codex' },
        count: { type: 'number', value: 2 },
      },
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(renderTextWithResolvedVars('hi ${name} ${count} \\${literal}', resolution)).toEqual({
      ok: true,
      text: 'hi Codex 2 ${literal}',
      diagnostics: [],
    })
    expect(renderTextWithResolvedVars('${missing}', resolution)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'MISSING_REFERENCE', path: ['missing'] }],
    })
  })
})

describe('vars lifecycle', () => {
  it('validates a draft through an overlay without mutating the source environments', () => {
    const environments = {
      dev: typed({
        API_KEY: { type: 'secret', value: 'top-secret' },
        HOST: { type: 'string', value: 'localhost' },
      }),
    }

    const result = validateVarDraft(environments, {
      environment: 'dev',
      key: 'DRAFT',
      entry: { type: 'string', value: 'token=${API_KEY}' },
      chain: ['dev'],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolution.values.DRAFT).toEqual({
      type: 'string',
      value: 'token=top-secret',
    })
    expect(result.resolution.secretTaintedKeys).toEqual(['API_KEY', 'DRAFT'])
    expect(environments.dev.entries.DRAFT).toBeUndefined()
  })

  it('validates drafts by resolving a tolerated missing-reference overlay afterward', () => {
    const result = validateVarDraft(
      { dev: typed({}) },
      {
        environment: 'dev',
        key: 'DRAFT',
        entry: { type: 'string', value: '${MISSING}' },
        chain: ['dev'],
      },
    )

    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'MISSING_REFERENCE',
          severity: 'error',
          environment: 'dev',
          key: 'DRAFT',
          path: ['DRAFT', 'MISSING'],
          message: '变量 DRAFT 引用了不存在的变量 MISSING',
        },
      ],
    })
  })

  it('reports every resolved value transitively tainted by a secret without masking values', () => {
    const result = resolveVarsLifecycle(
      {
        dev: typed({
          API_KEY: { type: 'secret', value: 'top-secret' },
          DIRECT: { type: 'string', value: '${API_KEY}' },
          MIDDLE: { type: 'string', value: 'prefix-${DIRECT}-suffix' },
          MULTI_HOP: { type: 'string', value: '${MIDDLE}' },
          HOST: { type: 'string', value: 'localhost' },
          URL: { type: 'string', value: 'https://${HOST}' },
        }),
      },
      ['dev'],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values.MIDDLE).toEqual({
      type: 'string',
      value: 'prefix-top-secret-suffix',
    })
    expect(result.secretTaintedKeys).toEqual(['API_KEY', 'DIRECT', 'MIDDLE', 'MULTI_HOP'])
    expect(result.values.URL).toEqual({ type: 'string', value: 'https://localhost' })
  })

  it('prepares mutation persistence from the mutation result semantics', () => {
    const changed = prepareVarsMutationPersistence({
      environments: {
        dev: typed({ NEXT: { type: 'string', value: 'ok' } }),
      },
      changed: ['dev'],
      diagnostics: [],
    })

    expect(changed).toEqual({
      ok: true,
      environments: {
        dev: typed({ NEXT: { type: 'string', value: 'ok' } }),
      },
    })

    const failed = prepareVarsMutationPersistence({
      environments: { dev: typed({}) },
      changed: [],
      diagnostics: [
        {
          code: 'missing_reference',
          severity: 'error',
          environment: 'dev',
          key: 'NEXT',
          message: '变量 NEXT 引用了不存在的变量 MISSING',
        },
      ],
    })

    expect(failed).toEqual({
      ok: false,
      diagnostic: {
        code: 'missing_reference',
        severity: 'error',
        environment: 'dev',
        key: 'NEXT',
        message: '变量 NEXT 引用了不存在的变量 MISSING',
      },
      diagnostics: [
        {
          code: 'missing_reference',
          severity: 'error',
          environment: 'dev',
          key: 'NEXT',
          message: '变量 NEXT 引用了不存在的变量 MISSING',
        },
      ],
    })
  })
})

describe('resolveVars compatibility wrapper', () => {
  const ctx = {
    env: { TOKEN: 'env-tok' },
    activeProfile: { TOKEN: 'active-tok', ONLY_ACTIVE: 'a' },
    defaultProfile: { ONLY_DEFAULT: 'd' },
  }

  it('ignores env and prefers active profile over default', () => {
    expect(resolveVars('${TOKEN}', ctx)).toBe('active-tok')
  })
  it('falls back to default profile and template defaults', () => {
    expect(resolveVars('${ONLY_DEFAULT}/${MISSING:fallback}', ctx)).toBe('d/fallback')
  })
  it('throws on an undefined variable', () => {
    expect(() => resolveVars('${NOPE}', ctx)).toThrow(/NOPE/)
  })
  it('accepts a context that omits deprecated env', () => {
    expect(
      resolveVars('${TOKEN}', {
        activeProfile: { TOKEN: 'active-tok' },
        defaultProfile: {},
      }),
    ).toBe('active-tok')
  })
})
