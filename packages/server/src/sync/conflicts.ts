import type { Conflict } from '@loom/core'

export interface ConflictItem {
  path: string
  field: string
  base: unknown
  ours: unknown
  theirs: unknown
  resolution?: 'ours' | 'theirs'
}

export interface ConflictGroup {
  file: string
  items: ConflictItem[]
}

export interface TextFileConflict {
  file: string
  base: string
  ours: string
  theirs: string
}

export function groupConflicts(file: string, conflicts: Conflict[]): ConflictGroup {
  return {
    file,
    items: conflicts.map((c) => ({
      path: c.path,
      field: c.field,
      base: c.base,
      ours: c.ours,
      theirs: c.theirs,
    })),
  }
}
