import { describe, it, expect } from 'vitest'
import { mergeMcp } from '../../src/projection/mcp-merge'
import type { McpFragment } from '../../src/adapters/types'

describe('mergeMcp', () => {
  it('inserts new fragments not in existing', () => {
    const existing: Record<string, McpFragment> = {}
    const fragments: McpFragment[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const merged = mergeMcp(existing, fragments)
    expect(merged.a).toBeDefined()
    expect(merged.a.command).toBe('c')
  })
  it('replaces existing entry with same id', () => {
    const existing: Record<string, McpFragment> = { a: { id: 'a', type: 'stdio', command: 'old' } }
    const fragments: McpFragment[] = [{ id: 'a', type: 'stdio', command: 'new' }]
    const merged = mergeMcp(existing, fragments)
    expect(merged.a.command).toBe('new')
  })
  it('removes existing entries not in fragments (manifest deleted)', () => {
    const existing: Record<string, McpFragment> = {
      a: { id: 'a', type: 'stdio', command: 'c' },
      b: { id: 'b', type: 'stdio', command: 'd' },
    }
    const fragments: McpFragment[] = [{ id: 'a', type: 'stdio', command: 'c' }]
    const merged = mergeMcp(existing, fragments)
    expect(merged.a).toBeDefined()
    expect(merged.b).toBeUndefined()
  })
  it('type change: stdio to sse cleans old-type fields (command/args gone)', () => {
    const existing: Record<string, McpFragment> = { a: { id: 'a', type: 'stdio', command: 'c', args: ['x'] } }
    const fragments: McpFragment[] = [{ id: 'a', type: 'sse', url: 'https://x' }]
    const merged = mergeMcp(existing, fragments)
    expect(merged.a.type).toBe('sse')
    expect(merged.a.url).toBe('https://x')
    expect(merged.a.command).toBeUndefined()
    expect(merged.a.args).toBeUndefined()
  })
  it('empty fragments removes all loom-managed entries', () => {
    const existing: Record<string, McpFragment> = { a: { id: 'a', type: 'stdio', command: 'c' } }
    const merged = mergeMcp(existing, [])
    expect(Object.keys(merged)).toHaveLength(0)
  })
})
