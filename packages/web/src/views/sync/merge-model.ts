import { Chunk } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { diff3Merge } from 'node-diff3'

export type BlockSide = 'local' | 'remote'
export type BlockDecision = 'pending' | 'applied' | 'ignored'
export type ChangeKind = 'stable' | 'conflict'

export interface MergeChange {
  from: number
  to: number
  kind: ChangeKind
}

export interface TextPatch {
  from: number
  to: number
  text: string
}

export interface MergeBlock {
  id: string
  baseText: string
  localText: string
  remoteText: string
  localFrom: number
  localTo: number
  localPatches: TextPatch[]
  remoteFrom: number
  remoteTo: number
  remotePatches: TextPatch[]
  resultFrom: number
  resultTo: number
  localState: BlockDecision
  remoteState: BlockDecision
  appliedOrder: BlockSide[]
}

export interface MergeModel {
  result: string
  blocks: MergeBlock[]
  changes: Record<BlockSide, MergeChange[]>
  unresolvedCount: number
}

const splitLines = (text: string) => text.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? []
const joinLines = (lines: string[]) => lines.join('')
const textDocument = (text: string) => Text.of(text.split('\n'))
const visibleEnd = (from: number, text: string) => from + text.replace(/\n$/, '').length

function overlaps(from: number, to: number, otherFrom: number, otherTo: number) {
  if (from === to) return from >= otherFrom && from <= otherTo
  if (otherFrom === otherTo) return otherFrom >= from && otherFrom <= to
  return from < otherTo && otherFrom < to
}

function buildChanges(base: string, side: string, conflicts: Array<[number, number]>) {
  return Chunk.build(textDocument(base), textDocument(side)).flatMap((chunk) =>
    chunk.changes.map((change) => {
      let from = chunk.fromB + change.fromB
      let to = Math.min(chunk.fromB + change.toB, side.length)
      if (from < to && side[from] === '\n') from += 1
      if (from < to && side[to - 1] === '\n') to -= 1
      return {
        from,
        to,
        kind: conflicts.some(([conflictFrom, conflictTo]) =>
          overlaps(from, to, conflictFrom, conflictTo),
        )
          ? ('conflict' as const)
          : ('stable' as const),
      }
    }),
  )
}

function buildPatches(base: string, side: string): TextPatch[] {
  return Chunk.build(textDocument(base), textDocument(side)).flatMap((chunk) =>
    chunk.changes.map((change) => ({
      from: chunk.fromA + change.fromA,
      to: chunk.fromA + change.toA,
      text: side.slice(chunk.fromB + change.fromB, chunk.fromB + change.toB),
    })),
  )
}

function patchRangesOverlap(left: TextPatch, right: TextPatch) {
  if (left.from === left.to && right.from === right.to) return false
  if (left.from === left.to) return left.from > right.from && left.from < right.to
  if (right.from === right.to) return right.from > left.from && right.from < left.to
  return left.from < right.to && right.from < left.to
}

function renderAppliedBlock(block: MergeBlock): string {
  const appliedSides = block.appliedOrder.filter((side) =>
    side === 'local' ? block.localState === 'applied' : block.remoteState === 'applied',
  )
  if (appliedSides.length === 0) return block.baseText

  const appliedPatchGroups = appliedSides.map((side) =>
    side === 'local' ? block.localPatches : block.remotePatches,
  )
  const overlappingPatch = appliedPatchGroups.some((patches, index) =>
    appliedPatchGroups
      .slice(index + 1)
      .some((otherPatches) =>
        patches.some((patch) => otherPatches.some((other) => patchRangesOverlap(patch, other))),
      ),
  )
  if (overlappingPatch) {
    return appliedSides
      .map((side) => (side === 'local' ? block.localText : block.remoteText))
      .join('')
  }

  let text = block.baseText
  const applied: TextPatch[] = []
  const mapPos = (pos: number, assoc: -1 | 1) => {
    let mapped = pos
    for (const patch of applied) {
      const replaced = patch.to - patch.from
      const delta = patch.text.length - replaced
      if (pos > patch.to || (pos === patch.to && assoc > 0)) {
        mapped += delta
      } else if (pos > patch.from || (pos === patch.from && assoc > 0 && replaced > 0)) {
        mapped = patch.from + patch.text.length
      }
    }
    return mapped
  }

  for (const side of appliedSides) {
    const patches = side === 'local' ? block.localPatches : block.remotePatches
    for (const patch of patches) {
      const from = mapPos(patch.from, 1)
      const to = mapPos(patch.to, patch.from === patch.to ? 1 : -1)
      const patchText =
        patch.from === patch.to &&
        from > 0 &&
        text[from - 1] === '\n' &&
        patch.text.startsWith('\n')
          ? patch.text.slice(1)
          : patch.text
      text = text.slice(0, from) + patchText + text.slice(to)
      applied.push({ ...patch, text: patchText })
    }
  }
  return text
}

function withCount(model: Omit<MergeModel, 'unresolvedCount'>): MergeModel {
  return {
    ...model,
    unresolvedCount: model.blocks.filter(
      (block) => block.localState === 'pending' || block.remoteState === 'pending',
    ).length,
  }
}

function withBlockResult(model: MergeModel, target: MergeBlock, nextTarget: MergeBlock) {
  const replacement = renderAppliedBlock(nextTarget)
  const delta = replacement.length - (target.resultTo - target.resultFrom)
  const result =
    model.result.slice(0, target.resultFrom) + replacement + model.result.slice(target.resultTo)
  const blocks = model.blocks.map((block) => {
    if (block.id === target.id) {
      return {
        ...nextTarget,
        resultTo: target.resultFrom + replacement.length,
      }
    }
    if (block.resultFrom >= target.resultTo) {
      return {
        ...block,
        resultFrom: block.resultFrom + delta,
        resultTo: block.resultTo + delta,
      }
    }
    return block
  })

  return withCount({ result, blocks, changes: model.changes })
}

export function buildMergeModel(base: string, local: string, remote: string): MergeModel {
  const localLines = splitLines(local)
  const remoteLines = splitLines(remote)
  const regions = diff3Merge(localLines, splitLines(base), remoteLines, {
    excludeFalseConflicts: true,
  })
  let result = ''
  const blocks: MergeBlock[] = []

  for (const [index, region] of regions.entries()) {
    if (region.ok) {
      result += joinLines(region.ok)
      continue
    }
    if (!region.conflict) continue

    const baseText = joinLines(region.conflict.o)
    const localText = joinLines(region.conflict.a)
    const remoteText = joinLines(region.conflict.b)
    const localFrom = joinLines(localLines.slice(0, region.conflict.aIndex)).length
    const remoteFrom = joinLines(remoteLines.slice(0, region.conflict.bIndex)).length
    const resultFrom = result.length
    result += baseText
    blocks.push({
      id: `block-${index}`,
      baseText,
      localText,
      remoteText,
      localFrom,
      localTo: visibleEnd(localFrom, localText),
      localPatches: buildPatches(baseText, localText),
      remoteFrom,
      remoteTo: visibleEnd(remoteFrom, remoteText),
      remotePatches: buildPatches(baseText, remoteText),
      resultFrom,
      resultTo: result.length,
      localState: 'pending',
      remoteState: 'pending',
      appliedOrder: [],
    })
  }

  return withCount({
    result,
    blocks,
    changes: {
      local: buildChanges(
        base,
        local,
        blocks.map((block) => [block.localFrom, block.localTo]),
      ),
      remote: buildChanges(
        base,
        remote,
        blocks.map((block) => [block.remoteFrom, block.remoteTo]),
      ),
    },
  })
}

export function applyBlockSide(model: MergeModel, id: string, side: BlockSide): MergeModel {
  const target = model.blocks.find((block) => block.id === id)
  if (!target) return model

  const nextTarget = {
    ...target,
    [`${side}State`]: 'applied',
    appliedOrder: target.appliedOrder.includes(side)
      ? target.appliedOrder
      : [...target.appliedOrder, side],
  } as MergeBlock
  return withBlockResult(model, target, nextTarget)
}

export function ignoreBlockSide(model: MergeModel, id: string, side: BlockSide): MergeModel {
  const target = model.blocks.find((block) => block.id === id)
  if (!target) return model

  return withBlockResult(model, target, {
    ...target,
    [`${side}State`]: 'ignored',
    appliedOrder: target.appliedOrder.filter((appliedSide) => appliedSide !== side),
  } as MergeBlock)
}

export function resetBlockSide(model: MergeModel, id: string, side: BlockSide): MergeModel {
  const target = model.blocks.find((block) => block.id === id)
  if (!target) return model

  return withBlockResult(model, target, {
    ...target,
    [`${side}State`]: 'pending',
    appliedOrder: target.appliedOrder.filter((appliedSide) => appliedSide !== side),
  } as MergeBlock)
}
