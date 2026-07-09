export interface TextPatch {
  from: number
  to: number
  text: string
}

const splitLines = (text: string) => text.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? []

function lineOffsets(lines: string[]) {
  const offsets = [0]
  let offset = 0
  for (const line of lines) {
    offset += line.length
    offsets.push(offset)
  }
  return offsets
}

function commonPrefixLength(left: string, right: string) {
  const max = Math.min(left.length, right.length)
  let index = 0
  while (index < max && left[index] === right[index]) index += 1
  return index
}

function commonSuffixLength(left: string, right: string, prefixLength: number) {
  const max = Math.min(left.length, right.length) - prefixLength
  let length = 0
  while (length < max && left[left.length - length - 1] === right[right.length - length - 1]) {
    length += 1
  }
  return length
}

function matchingLinePairs(baseLines: string[], sideLines: string[]) {
  const width = sideLines.length + 1
  const scores = Array.from({ length: (baseLines.length + 1) * width }, () => 0)

  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let sideIndex = sideLines.length - 1; sideIndex >= 0; sideIndex -= 1) {
      const offset = baseIndex * width + sideIndex
      scores[offset] =
        baseLines[baseIndex] === sideLines[sideIndex]
          ? scores[(baseIndex + 1) * width + sideIndex + 1] + 1
          : Math.max(
              scores[(baseIndex + 1) * width + sideIndex],
              scores[baseIndex * width + sideIndex + 1],
            )
    }
  }

  const pairs: Array<[number, number]> = []
  let baseIndex = 0
  let sideIndex = 0
  while (baseIndex < baseLines.length && sideIndex < sideLines.length) {
    if (baseLines[baseIndex] === sideLines[sideIndex]) {
      pairs.push([baseIndex, sideIndex])
      baseIndex += 1
      sideIndex += 1
    } else if (
      scores[(baseIndex + 1) * width + sideIndex] >= scores[baseIndex * width + sideIndex + 1]
    ) {
      baseIndex += 1
    } else {
      sideIndex += 1
    }
  }
  return pairs
}

interface DiffHunk {
  patch: TextPatch
  sideFrom: number
  sideTo: number
}

function diffHunks(base: string, side: string): DiffHunk[] {
  const baseLines = splitLines(base)
  const sideLines = splitLines(side)
  const baseOffsets = lineOffsets(baseLines)
  const sideOffsets = lineOffsets(sideLines)
  const pairs = matchingLinePairs(baseLines, sideLines)
  const hunks: DiffHunk[] = []

  let baseLine = 0
  let sideLine = 0
  for (const [nextBaseLine, nextSideLine] of [...pairs, [baseLines.length, sideLines.length]]) {
    if (baseLine !== nextBaseLine || sideLine !== nextSideLine) {
      let from = baseOffsets[baseLine]
      let to = baseOffsets[nextBaseLine]
      let sideFrom = sideOffsets[sideLine]
      let sideTo = sideOffsets[nextSideLine]

      const baseText = base.slice(from, to)
      const sideText = side.slice(sideFrom, sideTo)
      const prefixLength = commonPrefixLength(baseText, sideText)
      const suffixLength = commonSuffixLength(baseText, sideText, prefixLength)

      from += prefixLength
      sideFrom += prefixLength
      to -= suffixLength
      sideTo -= suffixLength

      hunks.push({
        patch: { from, to, text: side.slice(sideFrom, sideTo) },
        sideFrom,
        sideTo,
      })
    }
    baseLine = nextBaseLine + 1
    sideLine = nextSideLine + 1
  }

  return hunks
}

export function diffTextPatches(base: string, side: string): TextPatch[] {
  return diffHunks(base, side).map((hunk) => hunk.patch)
}

export function diffTextChanges(base: string, side: string): Array<{ from: number; to: number }> {
  return diffHunks(base, side).map((hunk) => {
    let from = hunk.sideFrom
    let to = hunk.sideTo
    if (from < to && side[from] === '\n') from += 1
    if (from < to && side[to - 1] === '\n') to -= 1
    return { from, to }
  })
}
