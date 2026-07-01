import yaml from 'js-yaml'

export interface Conflict {
  file: string
  path: string
  field: string
  base: unknown
  ours: unknown
  theirs: unknown
}
export interface MergeResult {
  merged: string
  conflicts: Conflict[]
}

export type Kind = 'skills' | 'mcp' | 'vars' | 'config'

function parse(text: string): unknown {
  return yaml.load(text) ?? (text.trim() === '' ? null : text)
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function mergeList<T extends Record<string, unknown>>(
  base: T[],
  ours: T[],
  theirs: T[],
  key: string,
  file: string,
  conflicts: Conflict[],
): T[] {
  const byKey = (arr: T[]) => new Map(arr.map((i) => [String(i[key]), i] as const))
  const bk = byKey(base),
    ok = byKey(ours),
    tk = byKey(theirs)
  const allKeys = new Set([...ok.keys(), ...tk.keys()])
  const out: T[] = []
  for (const k of allKeys) {
    const o = ok.get(k),
      t = tk.get(k),
      b = bk.get(k)
    if (o && !t) {
      out.push(o)
      continue
    }
    if (!o && t) {
      out.push(t)
      continue
    }
    if (o && t) {
      const merged = { ...o }
      for (const f of new Set([...Object.keys(o ?? {}), ...Object.keys(t ?? {})])) {
        const ov = (o as any)[f],
          tv = (t as any)[f],
          bv = (b as any)?.[f]
        if (deepEq(ov, tv)) {
          ;(merged as any)[f] = ov
        } else if (bv !== undefined && deepEq(ov, bv)) {
          ;(merged as any)[f] = tv
        } else if (bv !== undefined && deepEq(tv, bv)) {
          ;(merged as any)[f] = ov
        } else {
          conflicts.push({ file, path: k, field: f, base: bv, ours: ov, theirs: tv })
          ;(merged as any)[f] = ov
        }
      }
      out.push(merged)
    }
  }
  return out
}

function mergeObj(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  file: string,
  pathPrefix: string,
  conflicts: Conflict[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const o = ours[k],
      t = theirs[k],
      b = base[k]
    const path = pathPrefix ? `${pathPrefix}.${k}` : k
    if (deepEq(o, t) || (b !== undefined && deepEq(o, b))) out[k] = t === undefined ? o : t
    else if (b !== undefined && deepEq(t, b)) out[k] = o
    else if (isPlain(o) && isPlain(t) && isPlain(b))
      out[k] = mergeObj(b, o, t, file, path, conflicts)
    else if (o !== undefined && t !== undefined && !deepEq(o, t)) {
      conflicts.push({ file, path, field: '', base: b, ours: o, theirs: t })
      out[k] = o
    } else out[k] = o ?? t
  }
  return out
}

export function threeWayMerge(
  baseText: string,
  oursText: string,
  theirsText: string,
  kind: Kind,
): MergeResult {
  const base = parse(baseText),
    ours = parse(oursText),
    theirs = parse(theirsText)
  const conflicts: Conflict[] = []
  let merged: unknown
  if (kind === 'mcp') {
    merged = mergeList<any>(
      asArray(base),
      asArray(ours),
      asArray(theirs),
      'id',
      'mcp.yaml',
      conflicts,
    )
  } else if (kind === 'vars') {
    merged = mergeObj(asObj(base), asObj(ours), asObj(theirs), 'vars', '', conflicts)
  } else if (kind === 'skills') {
    const bo = asObj(base),
      oo = asObj(ours),
      to = asObj(theirs)
    const sources = mergeList<any>(
      asArray(bo.sources),
      asArray(oo.sources),
      asArray(to.sources),
      'url',
      'skills.yaml',
      conflicts,
    )
    const skills = mergeList<any>(
      asArray(bo.skills),
      asArray(oo.skills),
      asArray(to.skills),
      'id',
      'skills.yaml',
      conflicts,
    )
    merged = { sources, skills }
  } else {
    merged = mergeObj(asObj(base), asObj(ours), asObj(theirs), 'config.yaml', '', conflicts)
  }
  return { merged: yaml.dump(merged, { lineWidth: -1 }), conflicts }
}
