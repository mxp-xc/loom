import type { VarsFile } from './types.js'

export interface VarsContext {
  env: Record<string, string>
  activeProfile: VarsFile
  defaultProfile: VarsFile
}
export class ResolveError extends Error {}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g

export function resolveVars(value: string, ctx: VarsContext): string {
  if (!value.includes('${')) return value
  return value.replace(REF, (_full, name: string, def: string | undefined) => {
    if (Object.prototype.hasOwnProperty.call(ctx.env, name)) return ctx.env[name]
    if (Object.prototype.hasOwnProperty.call(ctx.activeProfile, name))
      return ctx.activeProfile[name]
    if (Object.prototype.hasOwnProperty.call(ctx.defaultProfile, name))
      return ctx.defaultProfile[name]
    if (def !== undefined) return def
    throw new ResolveError(`undefined variable: ${name}`)
  })
}
