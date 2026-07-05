import { describe, expect, it } from 'vitest'
import {
  buildVariableReferenceGraph,
  extractVariableReferences,
  inspectVariableDelete,
  type VarsEnvironment,
} from '../src/index.js'

const typed = (entries: VarsEnvironment['entries']): VarsEnvironment => ({
  format: 'typed',
  entries,
})

describe('vars reference graph', () => {
  it('extracts direct references with stable deduplication', () => {
    expect(
      extractVariableReferences('${api.host}/${api-port:x}/${api.host}/${feature.enabled}'),
    ).toEqual(['api.host', 'api-port', 'feature.enabled'])
  })

  it('builds raw cross-environment edges for string and secret entries', () => {
    const graph = buildVariableReferenceGraph({
      base: typed({
        host: { type: 'string', value: 'localhost' },
        url: { type: 'string', value: '${host}' },
      }),
      prod: typed({
        token: { type: 'secret', value: '${url}:${host}' },
        ignored: { type: 'json', value: '${host}' },
      }),
    })
    expect(graph.edges).toEqual([
      { from: { environment: 'base', key: 'url' }, referencedKey: 'host' },
      { from: { environment: 'prod', key: 'token' }, referencedKey: 'url' },
      { from: { environment: 'prod', key: 'token' }, referencedKey: 'host' },
    ])
  })

  it('returns direct and transitive delete impact across environments', () => {
    const envs = {
      base: typed({
        host: { type: 'string', value: 'localhost' },
        url: { type: 'string', value: 'http://${host}' },
      }),
      prod: typed({ 'health-url': { type: 'string', value: '${url}/health' } }),
    }
    expect(inspectVariableDelete(envs, 'base', 'host')).toEqual({
      direct: [{ environment: 'base', key: 'url' }],
      transitive: [{ environment: 'prod', key: 'health-url' }],
      impactToken: expect.any(String),
    })
  })

  it('traverses cycles once with deterministic output', () => {
    const envs = {
      base: typed({
        a: { type: 'string', value: '${target}:${b}' },
        b: { type: 'string', value: '${a}' },
        target: { type: 'string', value: 'x' },
      }),
    }
    expect(inspectVariableDelete(envs, 'base', 'target')).toEqual({
      direct: [{ environment: 'base', key: 'a' }],
      transitive: [{ environment: 'base', key: 'b' }],
      impactToken: expect.any(String),
    })
  })

  it('uses one edge for mixed default and required references', () => {
    const graph = buildVariableReferenceGraph({
      base: typed({
        use: { type: 'string', value: '${key:fallback}/${key}/${empty:}/${many:a:b}' },
      }),
    })
    expect(graph.edges).toEqual([
      { from: { environment: 'base', key: 'use' }, referencedKey: 'key' },
      { from: { environment: 'base', key: 'use' }, referencedKey: 'empty', hasDefault: true },
      { from: { environment: 'base', key: 'use' }, referencedKey: 'many', hasDefault: true },
    ])
  })

  it('handles self cycles and produces the same impact for insertion order changes', () => {
    const first = {
      z: typed({
        target: { type: 'string', value: 'x' },
        self: { type: 'string', value: '${target}:${self}' },
      }),
      a: typed({ use: { type: 'string', value: '${self}' } }),
    }
    const second = { a: first.a, z: first.z }
    expect(inspectVariableDelete(first, 'z', 'target')).toEqual(
      inspectVariableDelete(second, 'z', 'target'),
    )
    expect(inspectVariableDelete(first, 'z', 'target').transitive).toEqual([
      { environment: 'a', key: 'use' },
    ])
  })

  it('changes the impact token when another target-key definition appears', () => {
    const initial = {
      base: typed({
        target: { type: 'string', value: 'x' },
        use: { type: 'string', value: '${target}' },
      }),
    }
    const before = inspectVariableDelete(initial, 'base', 'target').impactToken
    const after = inspectVariableDelete(
      { ...initial, prod: typed({ target: { type: 'string', value: 'override' } }) },
      'base',
      'target',
    ).impactToken
    expect(after).not.toBe(before)
  })

  it('does not expose or depend on secret and literal values', () => {
    const secret = 'do-not-leak-this-secret-fragment'
    const first = {
      base: typed({
        target: { type: 'secret', value: secret },
        use: { type: 'string', value: `prefix-1-\${target}` },
      }),
    }
    const second = {
      base: typed({
        target: { type: 'secret', value: 'different-secret' },
        use: { type: 'string', value: `prefix-2-\${target}` },
      }),
    }
    const firstToken = inspectVariableDelete(first, 'base', 'target').impactToken
    const secondToken = inspectVariableDelete(second, 'base', 'target').impactToken
    expect(secondToken).toBe(firstToken)
    expect(firstToken).not.toContain(secret)
  })

  it('changes the impact token when a related edge default mode changes', () => {
    const required = {
      base: typed({
        target: { type: 'string', value: 'x' },
        use: { type: 'string', value: '${target}' },
      }),
    }
    const defaulted = {
      base: typed({
        target: { type: 'string', value: 'y' },
        use: { type: 'string', value: '${target:fallback}' },
      }),
    }
    expect(inspectVariableDelete(defaulted, 'base', 'target').impactToken).not.toBe(
      inspectVariableDelete(required, 'base', 'target').impactToken,
    )
  })
})
