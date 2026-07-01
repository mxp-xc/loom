import type { McpFragment } from '../ports/adapter.js'

// Merge by id with loom-managed tracking:
// - fragment ids replace existing (type change = whole rewrite, old-type fields absent)
// - fragment ids not in existing are inserted
// - existing ids in managedIds but NOT in fragments are removed (manifest deleted them)
// - existing ids NOT in managedIds are preserved verbatim (user-handwritten, untouched)
// managedIds is the set of mcp ids loom projected last time (persisted in state file).
// If managedIds is empty/absent (first run / state lost), nothing is removed (safe degradation).
export function mergeMcp(
  existing: Record<string, McpFragment>,
  fragments: McpFragment[],
  managedIds?: Set<string>,
): Record<string, McpFragment> {
  const out: Record<string, McpFragment> = {}
  const fragmentIds = new Set(fragments.map((f) => f.id))
  const managed = managedIds ?? new Set<string>()
  // Preserve user-handwritten entries: existing ids loom never managed.
  for (const [id, f] of Object.entries(existing)) {
    if (fragmentIds.has(id)) continue // will be replaced below
    if (managed.has(id)) continue // loom-managed but removed from manifest -> drop
    out[id] = { ...f }
  }
  // Insert/replace loom-managed entries from this projection.
  for (const f of fragments) {
    out[f.id] = { ...f }
  }
  void fragmentIds
  return out
}
