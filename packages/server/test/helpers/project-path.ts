import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const serverPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function serverPackagePath(...segments: string[]): string {
  return resolve(serverPackageRoot, ...segments)
}

export function bunExecutable(): string {
  const executable = process.env.npm_execpath
  if (!executable) throw new Error('Bun executable is unavailable; run tests through bun run')
  return executable
}
