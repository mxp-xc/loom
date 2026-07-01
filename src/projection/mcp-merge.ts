import type { McpFragment } from '../adapters/types.js'

// Merge by id: fragment ids replace existing (type change = whole rewrite, old-type fields absent);
// fragment ids not in existing are inserted; existing ids not in fragments are removed (manifest deleted).
// This operates on the loom-managed subset only; adapter writeMcp preserves user-handwritten entries.
export function mergeMcp(existing: Record<string, McpFragment>, fragments: McpFragment[]): Record<string, McpFragment> {
  const out: Record<string, McpFragment> = {}
  const fragmentIds = new Set(fragments.map(f => f.id))
  // Keep existing entries that are still in fragments (replaced by new fragment value)
  // Remove existing entries not in fragments (manifest deleted them)
  void existing
  for (const f of fragments) {
    out[f.id] = { ...f }
  }
  void fragmentIds
  return out
}
