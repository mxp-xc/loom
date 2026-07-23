import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mcpImportResourceKeys,
  projectionResourceKeys,
} from '../../src/concurrency/resource-keys.js'

describe('resource keys', () => {
  it('shares agent-native targets while isolating repository projection state', () => {
    const home = resolve('/home/tester')
    const firstRepo = resolve('/repos/first')
    const secondRepo = resolve('/repos/second')
    const first = new Set(projectionResourceKeys(home, firstRepo, home, 'all'))
    const second = new Set(projectionResourceKeys(home, secondRepo, home, 'all'))
    const shared = [...first].filter((key) => second.has(key))
    const statePrefix = `${resolve(home, '.loom', 'state')}${sep}`

    expect(first).toContain(firstRepo)
    expect(second).toContain(secondRepo)
    expect(shared.length).toBeGreaterThan(0)
    expect(shared.every((key) => !key.startsWith(statePrefix))).toBe(true)
  })

  it('locks every native MCP source used by import together with repo and local config', () => {
    const home = resolve('/home/tester')
    const repo = resolve('/repos/default')
    const canonicalHome = resolve('/canonical/home/tester')
    const importKeys = new Set(mcpImportResourceKeys(home, repo, canonicalHome))
    const projectionKeys = projectionResourceKeys(home, repo, canonicalHome, 'mcp')
    const statePrefix = `${resolve(home, '.loom', 'state')}${sep}`

    expect(importKeys).toContain(repo)
    expect(importKeys).toContain(canonicalHome)
    for (const key of projectionKeys) {
      if (key !== repo && !key.startsWith(statePrefix)) {
        expect(importKeys).toContain(key)
      }
    }
  })

  it('normalizes lexical aliases and keeps same-basename repository keys distinct', () => {
    const home = resolve('/home/tester')
    const canonical = projectionResourceKeys(home, '/work/repos/default', home, 'skills')
    const alias = projectionResourceKeys(home, '/work/repos/../repos/default', home, 'skills')
    const other = projectionResourceKeys(home, '/other/repos/default', home, 'skills')

    expect(alias).toEqual(canonical)
    expect(other[0]).not.toBe(canonical[0])
    expect(other.slice(1).some((key) => canonical.slice(1).includes(key))).toBe(true)
  })

  it('locks distinct identity state plus the shared legacy path during MCP migration', () => {
    const home = resolve('/home/tester')
    const first = projectionResourceKeys(home, '/work/repos/default', home, 'mcp')
    const second = projectionResourceKeys(home, '/other/repos/default', home, 'mcp')
    const stateRoot = `${resolve(home, '.loom', 'state')}${sep}`
    const firstState = first.filter((key) => key.includes(stateRoot))
    const secondState = second.filter((key) => key.includes(stateRoot))

    expect(firstState).toHaveLength(2)
    expect(secondState).toHaveLength(2)
    expect(firstState.filter((key) => secondState.includes(key))).toHaveLength(1)
  })

  it('locks only the selected agent destination for agent-scoped skills projection', () => {
    const home = resolve('/home/tester')
    const keys = projectionResourceKeys(home, '/work/repos/default', home, 'skills', 'opencode')

    expect(keys).toContain(resolve(home, '.config/opencode/skills'))
    expect(keys).not.toContain(resolve(home, '.codex/skills'))
    expect(keys).not.toContain(resolve(home, '.claude/skills'))
  })
})
