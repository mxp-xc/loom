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

function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const prototype = Object.getPrototypeOf(v)
  return prototype === Object.prototype || prototype === null
}

function ownValue(record: Record<string, unknown> | undefined, key: string): unknown {
  return record && Object.hasOwn(record, key) ? record[key] : undefined
}

function asArray<T>(value: unknown, path: string, optional = false): T[] {
  if (value === undefined && optional) return []
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value as T[]
}

function asObj(value: unknown, path: string): Record<string, unknown> {
  if (!isPlain(value)) throw new Error(`${path} must be an object`)
  return value
}

function asKeyedList(value: unknown, path: string, key: string, optional = false) {
  const items = asArray<unknown>(value, path, optional)
  const identities = new Set<string>()
  return items.map((item, index) => {
    const record = asObj(item, `${path}[${index}]`)
    const identity = record[key]
    if (typeof identity !== 'string' || !identity.trim()) {
      throw new Error(`${path}[${index}].${key} must be a non-empty string`)
    }
    if (identities.has(identity)) throw new Error(`${path} contains duplicate ${key}: ${identity}`)
    identities.add(identity)
    return record
  })
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEq(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aTag = Object.prototype.toString.call(a)
  const bTag = Object.prototype.toString.call(b)
  if (aTag !== bTag) return false
  if (aTag !== '[object Object]') return JSON.stringify(a) === JSON.stringify(b)
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.hasOwn(bObj, key) && deepEq(aObj[key], bObj[key]))
}

function mergeList(
  base: Record<string, unknown>[],
  ours: Record<string, unknown>[],
  theirs: Record<string, unknown>[],
  key: string,
  file: string,
  conflicts: Conflict[],
): Record<string, unknown>[] {
  const byKey = (arr: Record<string, unknown>[]) =>
    new Map(arr.map((i) => [String(i[key]), i] as const))
  const bk = byKey(base),
    ok = byKey(ours),
    tk = byKey(theirs)
  const allKeys = new Set([...ok.keys(), ...tk.keys()])
  const out: Record<string, unknown>[] = []
  for (const k of allKeys) {
    const o = ok.get(k),
      t = tk.get(k),
      b = bk.get(k)
    if (o && !t) {
      if (!b) out.push(o)
      else if (!deepEq(o, b)) {
        conflicts.push({ file, path: k, field: '', base: b, ours: o, theirs: undefined })
        out.push(o)
      }
      continue
    }
    if (!o && t) {
      if (!b) out.push(t)
      else if (!deepEq(t, b)) {
        conflicts.push({ file, path: k, field: '', base: b, ours: undefined, theirs: t })
      }
      continue
    }
    if (o && t) {
      const merged = Object.assign(Object.create(null) as Record<string, unknown>, o)
      for (const f of new Set([...Object.keys(o ?? {}), ...Object.keys(t ?? {})])) {
        const ov = ownValue(o, f),
          tv = ownValue(t, f),
          bv = ownValue(b, f)
        if (deepEq(ov, tv)) {
          if (ov === undefined) delete merged[f]
          else merged[f] = ov
        } else if (deepEq(ov, bv)) {
          if (tv === undefined) delete merged[f]
          else merged[f] = tv
        } else if (deepEq(tv, bv)) {
          if (ov === undefined) delete merged[f]
          else merged[f] = ov
        } else {
          conflicts.push({ file, path: k, field: f, base: bv, ours: ov, theirs: tv })
          merged[f] = ov
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
  const out = Object.create(null) as Record<string, unknown>
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const o = ownValue(ours, k),
      t = ownValue(theirs, k),
      b = ownValue(base, k)
    const path = pathPrefix ? `${pathPrefix}.${k}` : k
    if (deepEq(o, t)) {
      if (o !== undefined) out[k] = o
    } else if (deepEq(o, b)) {
      if (t !== undefined) out[k] = t
    } else if (deepEq(t, b)) {
      if (o !== undefined) out[k] = o
    } else if (isPlain(o) && isPlain(t) && isPlain(b))
      out[k] = mergeObj(b, o, t, file, path, conflicts)
    else {
      conflicts.push({ file, path, field: '', base: b, ours: o, theirs: t })
      if (o !== undefined) out[k] = o
    }
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
    merged = mergeList(
      asKeyedList(base, 'base mcp', 'id'),
      asKeyedList(ours, 'ours mcp', 'id'),
      asKeyedList(theirs, 'theirs mcp', 'id'),
      'id',
      'mcp.yaml',
      conflicts,
    )
  } else if (kind === 'vars') {
    merged = mergeObj(
      asObj(base, 'base vars'),
      asObj(ours, 'ours vars'),
      asObj(theirs, 'theirs vars'),
      'vars',
      '',
      conflicts,
    )
  } else if (kind === 'skills') {
    const bo = asObj(base, 'base skills'),
      oo = asObj(ours, 'ours skills'),
      to = asObj(theirs, 'theirs skills')
    for (const [label, value] of [
      ['base', bo.group_order],
      ['ours', oo.group_order],
      ['theirs', to.group_order],
    ] as const) {
      if (value !== undefined) asArray(value, `${label} skills.group_order`)
    }
    const sources = mergeList(
      asKeyedList(bo.sources, 'base skills.sources', 'url', true),
      asKeyedList(oo.sources, 'ours skills.sources', 'url', true),
      asKeyedList(to.sources, 'theirs skills.sources', 'url', true),
      'url',
      'skills.yaml',
      conflicts,
    )
    const skills = mergeList(
      asKeyedList(bo.skills, 'base skills.skills', 'id', true),
      asKeyedList(oo.skills, 'ours skills.skills', 'id', true),
      asKeyedList(to.skills, 'theirs skills.skills', 'id', true),
      'id',
      'skills.yaml',
      conflicts,
    )
    const { sources: _baseSources, skills: _baseSkills, ...baseMetadata } = bo
    const { sources: _ourSources, skills: _ourSkills, ...ourMetadata } = oo
    const { sources: _theirSources, skills: _theirSkills, ...theirMetadata } = to
    const metadata = mergeObj(
      baseMetadata,
      ourMetadata,
      theirMetadata,
      'skills.yaml',
      '',
      conflicts,
    )
    merged = { ...metadata, sources, skills }
  } else {
    merged = mergeObj(
      asObj(base === null ? {} : base, 'base config'),
      asObj(ours === null ? {} : ours, 'ours config'),
      asObj(theirs === null ? {} : theirs, 'theirs config'),
      'config.yaml',
      '',
      conflicts,
    )
  }
  return { merged: yaml.dump(merged, { lineWidth: -1 }), conflicts }
}
