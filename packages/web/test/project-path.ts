import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const cwd = process.cwd()
const packageRoot = existsSync(resolve(cwd, 'src/index.css')) ? cwd : resolve(cwd, 'packages/web')

export function webPackagePath(...segments: string[]): string {
  return resolve(packageRoot, ...segments)
}

export function webSourcePath(...segments: string[]): string {
  return webPackagePath('src', ...segments)
}
