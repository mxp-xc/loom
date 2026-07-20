// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  applyBlockSide,
  buildMergeModel,
  ignoreBlockSide,
  resetBlockSide,
} from '../src/views/sync/merge-model'

const base = `profile: local
agents:
  - claude-code
projection:
  strategy: link
`

const local = `profile: local
agents:
  - claude-code
  - codex
  - opencode
projection:
  strategy: link
`

const remote = `profile: local
agents: []
projection:
  strategy: link
proxy:
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
`

describe('three-way merge model', () => {
  it('automatically merges remote-only changes and leaves only overlapping edits pending', () => {
    const model = buildMergeModel(base, local, remote)

    expect(model.result).toContain('proxy:')
    expect(model.changes.remote).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'stable',
          from: remote.indexOf('proxy:'),
          to: remote.length - 1,
        }),
        expect.objectContaining({
          kind: 'conflict',
          from: remote.indexOf(' []'),
          to: remote.indexOf('\nprojection:'),
        }),
      ]),
    )
    expect(model.blocks).toHaveLength(1)
    expect(model.blocks[0]).toMatchObject({
      localText: expect.stringContaining('opencode'),
      remoteText: 'agents: []\n',
      localFrom: local.indexOf('agents:'),
      localTo: local.indexOf('\nprojection:'),
      remoteFrom: remote.indexOf('agents:'),
      remoteTo: remote.indexOf('\nprojection:'),
      localState: 'pending',
      remoteState: 'pending',
    })
  })

  it('classifies insertions and deletions at document boundaries', () => {
    const model = buildMergeModel(
      'first: base\nlast: base\n',
      'last: base\n',
      'first: base\nlast: base\nadded: remote\n',
    )

    expect(model.blocks).toEqual([])
    expect(model.changes.local).toEqual([
      expect.objectContaining({ kind: 'stable', from: 0, to: 0 }),
    ])
    expect(model.changes.remote).toEqual([
      expect.objectContaining({
        kind: 'stable',
        from: 'first: base\nlast: base\n'.length,
        to: 'first: base\nlast: base\nadded: remote'.length,
      }),
    ])
    expect(model.result).toBe('last: base\nadded: remote\n')
  })

  it('does not color an unchanged final line when both sides insert after it', () => {
    const baseWithoutNewline = 'enabled: true\ninterval: 6h'
    const localInsertion = `${baseWithoutNewline}\nactive_memory: v1\n`
    const remoteInsertion = `${baseWithoutNewline}\nproxy: enabled\n`
    const model = buildMergeModel(baseWithoutNewline, localInsertion, remoteInsertion)

    expect(model.blocks).toHaveLength(1)
    expect(
      model.changes.local.map((change) => localInsertion.slice(change.from, change.to)),
    ).toEqual(['active_memory: v1'])
    expect(
      model.changes.remote.map((change) => remoteInsertion.slice(change.from, change.to)),
    ).toEqual(['proxy: enabled'])
  })

  it('applies only exact inserted text when both sides insert after the same final line', () => {
    const baseWithoutNewline = 'enabled: true\ninterval: 6h'
    const localInsertion = `${baseWithoutNewline}\nactive_memory: v1\n`
    const remoteInsertion = `${baseWithoutNewline}\nproxy: enabled\n`
    let model = buildMergeModel(baseWithoutNewline, localInsertion, remoteInsertion)
    const block = model.blocks[0]

    expect(block.localPatches.map((patch) => patch.text)).toEqual(['\nactive_memory: v1\n'])
    expect(block.remotePatches.map((patch) => patch.text)).toEqual(['\nproxy: enabled\n'])

    model = applyBlockSide(model, block.id, 'remote')
    expect(model.result.match(/interval: 6h/g)).toHaveLength(1)
    expect(model.result).toBe(`${baseWithoutNewline}\nproxy: enabled\n`)

    model = applyBlockSide(model, block.id, 'local')
    expect(model.result.match(/interval: 6h/g)).toHaveLength(1)
    expect(model.result).toBe(`${baseWithoutNewline}\nproxy: enabled\nactive_memory: v1\n`)
  })

  it('applies one side and independently ignores the other', () => {
    let model = buildMergeModel(base, local, remote)
    const id = model.blocks[0].id

    model = applyBlockSide(model, id, 'local')
    expect(model.result).toContain('  - opencode')
    expect(model.blocks[0].localState).toBe('applied')
    expect(model.blocks[0].remoteState).toBe('pending')

    model = ignoreBlockSide(model, id, 'remote')
    expect(model.blocks[0].remoteState).toBe('ignored')
    expect(model.unresolvedCount).toBe(0)
    expect(model.result).toContain('proxy:')
  })

  it('keeps both conflict sides when both are applied', () => {
    let model = buildMergeModel('value: base\n', 'value: local\n', 'value: remote\n')
    const id = model.blocks[0].id

    model = applyBlockSide(model, id, 'local')
    model = applyBlockSide(model, id, 'remote')

    expect(model.result).toBe('value: local\nvalue: remote\n')
    expect(model.unresolvedCount).toBe(0)
  })

  it('resets an applied side and recomputes the result from the remaining decisions', () => {
    let model = buildMergeModel('value: base\n', 'value: local\n', 'value: remote\n')
    const id = model.blocks[0].id

    model = applyBlockSide(model, id, 'local')
    model = applyBlockSide(model, id, 'remote')
    model = resetBlockSide(model, id, 'local')

    expect(model.result).toBe('value: remote\n')
    expect(model.blocks[0].localState).toBe('pending')
    expect(model.blocks[0].remoteState).toBe('applied')
    expect(model.unresolvedCount).toBe(1)
  })

  it('resets an ignored side to pending without changing applied text', () => {
    let model = buildMergeModel(base, local, remote)
    const id = model.blocks[0].id

    model = applyBlockSide(model, id, 'local')
    model = ignoreBlockSide(model, id, 'remote')
    model = resetBlockSide(model, id, 'remote')

    expect(model.result).toContain('  - opencode')
    expect(model.blocks[0].localState).toBe('applied')
    expect(model.blocks[0].remoteState).toBe('pending')
    expect(model.unresolvedCount).toBe(1)
  })

  it('treats identical edits as stable', () => {
    const model = buildMergeModel('value: base\n', 'value: same\n', 'value: same\n')

    expect(model.blocks).toEqual([])
    expect(model.result).toBe('value: same\n')
  })

  it('keeps later block ranges aligned when an earlier replacement changes length', () => {
    let model = buildMergeModel(
      'first: base\nstable: one\nstable: two\nlast: base\n',
      'first: a much longer local value\nstable: one\nstable: two\nlast: local\n',
      'first: remote\nstable: one\nstable: two\nlast: remote\n',
    )
    expect(model.blocks).toHaveLength(2)

    model = applyBlockSide(model, model.blocks[0].id, 'local')
    model = applyBlockSide(model, model.blocks[1].id, 'remote')

    expect(model.result).toBe(
      'first: a much longer local value\nstable: one\nstable: two\nlast: remote\n',
    )
  })

  it('returns the same model for an unknown block id', () => {
    const model = buildMergeModel(base, local, remote)

    expect(applyBlockSide(model, 'missing', 'local')).toBe(model)
    expect(ignoreBlockSide(model, 'missing', 'remote')).toBe(model)
    expect(resetBlockSide(model, 'missing', 'remote')).toBe(model)
  })
})
