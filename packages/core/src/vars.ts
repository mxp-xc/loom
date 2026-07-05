import type { VarsFile } from './types.js'
import type { VarEntry, VarsDiagnostic, VarsEnvironment } from './vars-types.js'

export interface VarsContext {
  /** Caller-supplied runtime tokens for text rendering; never read from process.env here. */
  env?: Record<string, string>
  activeProfile: VarsFile
  defaultProfile: VarsFile
}
export class ResolveError extends Error {}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_.-]*)(?::([^}]*))?\}/g

export type VarsResolutionResult =
  | {
      ok: true
      values: Record<string, VarEntry>
      sources: Record<string, string>
      dependencies: Record<string, string[]>
      diagnostics: VarsDiagnostic[]
    }
  | { ok: false; diagnostics: VarsDiagnostic[] }

class ResolutionFailure extends Error {
  constructor(readonly diagnostic: VarsDiagnostic) {
    super(diagnostic.message)
  }
}

function errorDiagnostic(
  code: string,
  message: string,
  details: Pick<VarsDiagnostic, 'environment' | 'key' | 'path'> = {},
): VarsDiagnostic {
  return { code, severity: 'error', ...details, message }
}

function stringifyEntry(entry: VarEntry): string {
  return entry.type === 'json' ? JSON.stringify(entry.value) : String(entry.value)
}

function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

export function resolveVarsChain(
  environments: Record<string, VarsEnvironment>,
  chain: string[],
): VarsResolutionResult {
  if (chain.length === 0) {
    return { ok: false, diagnostics: [errorDiagnostic('EMPTY_CHAIN', '环境链不能为空')] }
  }

  const seen = new Set<string>()
  for (const environment of chain) {
    if (seen.has(environment)) {
      return {
        ok: false,
        diagnostics: [
          errorDiagnostic('DUPLICATE_ENVIRONMENT', `环境链包含重复环境: ${environment}`, {
            environment,
            path: chain.filter((name) => name === environment),
          }),
        ],
      }
    }
    seen.add(environment)
    if (!Object.prototype.hasOwnProperty.call(environments, environment)) {
      return {
        ok: false,
        diagnostics: [
          errorDiagnostic('ENVIRONMENT_NOT_FOUND', `环境不存在: ${environment}`, {
            environment,
            path: [environment],
          }),
        ],
      }
    }
  }

  const merged = createRecord<VarEntry>()
  const sources = createRecord<string>()
  for (const environment of chain) {
    for (const [key, entry] of Object.entries(environments[environment].entries)) {
      merged[key] = entry
      sources[key] = environment
    }
  }

  const values = createRecord<VarEntry>()
  const dependencies = createRecord<string[]>()
  const stack: string[] = []
  const visiting = new Set<string>()

  const resolveEntry = (key: string): VarEntry => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key]
    const entry = merged[key]
    if (entry.type !== 'string' && entry.type !== 'secret') {
      values[key] = entry
      return entry
    }

    if (visiting.has(key)) {
      const cycleStart = stack.indexOf(key)
      const path = [...stack.slice(cycleStart), key]
      throw new ResolutionFailure(
        errorDiagnostic('REFERENCE_CYCLE', `变量引用形成循环: ${path.join(' -> ')}`, {
          environment: sources[path[0]],
          key: path[0],
          path,
        }),
      )
    }

    visiting.add(key)
    stack.push(key)
    dependencies[key] = []
    try {
      const resolvedValue = entry.value.replace(
        REF,
        (_full, referencedKey: string, defaultValue: string | undefined) => {
          if (!dependencies[key].includes(referencedKey)) dependencies[key].push(referencedKey)
          if (!Object.prototype.hasOwnProperty.call(merged, referencedKey)) {
            if (defaultValue !== undefined) return defaultValue
            throw new ResolutionFailure(
              errorDiagnostic(
                'MISSING_REFERENCE',
                `变量 ${key} 引用了不存在的变量 ${referencedKey}`,
                { environment: sources[key], key, path: [...stack, referencedKey] },
              ),
            )
          }
          return stringifyEntry(resolveEntry(referencedKey))
        },
      )
      const resolved: VarEntry = { type: entry.type, value: resolvedValue }
      values[key] = resolved
      return resolved
    } finally {
      stack.pop()
      visiting.delete(key)
    }
  }

  try {
    for (const key of Object.keys(merged)) resolveEntry(key)
  } catch (error) {
    if (error instanceof ResolutionFailure) {
      return { ok: false, diagnostics: [error.diagnostic] }
    }
    throw error
  }

  return { ok: true, values, sources, dependencies, diagnostics: [] }
}

/** @deprecated Use resolveVarsChain for typed environment resolution. */
export function resolveVars(value: string, ctx: VarsContext): string {
  if (!value.includes('${')) return value
  return value.replace(REF, (_full, name: string, def: string | undefined) => {
    if (Object.prototype.hasOwnProperty.call(ctx.activeProfile, name))
      return ctx.activeProfile[name]
    if (Object.prototype.hasOwnProperty.call(ctx.defaultProfile, name))
      return ctx.defaultProfile[name]
    if (def !== undefined) return def
    throw new ResolveError(`undefined variable: ${name}`)
  })
}

function resolveRenderVars(value: string, ctx: VarsContext): string {
  if (!value.includes('${')) return value
  return value.replace(REF, (_full, name: string, def: string | undefined) => {
    if (ctx.env && Object.prototype.hasOwnProperty.call(ctx.env, name)) return ctx.env[name]
    if (Object.prototype.hasOwnProperty.call(ctx.activeProfile, name))
      return ctx.activeProfile[name]
    if (Object.prototype.hasOwnProperty.call(ctx.defaultProfile, name))
      return ctx.defaultProfile[name]
    if (def !== undefined) return def
    throw new ResolveError(`undefined variable: ${name}`)
  })
}

// NUL 字节 (\0) 在正常 markdown 文本与变量值中不会出现,确保 round-trip 不冲突。
const ESC = '\0DOLLAR_BRACE\0'

export function renderText(text: string, ctx: VarsContext): string {
  let s = text.replaceAll('\\${', ESC) // 1. 保护转义 \${ → 占位符
  s = resolveRenderVars(s, ctx) // 2. 解析调用方显式提供的 runtime tokens 与 vars
  return s.replaceAll(ESC, '${') // 3. 还原占位符为字面 ${
}
