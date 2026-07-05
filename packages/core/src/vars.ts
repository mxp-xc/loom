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

// NUL 字节 (\0) 在正常 markdown 文本与变量值中不会出现,确保 round-trip 不冲突。
const ESC = '\0DOLLAR_BRACE\0'

export function renderText(text: string, ctx: VarsContext): string {
  let s = text.replaceAll('\\${', ESC) // 1. 保护转义 \${ → 占位符
  s = resolveVars(s, ctx) // 2. 复用现有 ${VAR} 解析
  return s.replaceAll(ESC, '${') // 3. 还原占位符为字面 ${
}
