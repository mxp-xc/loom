import { join } from 'node:path'
import yaml from 'js-yaml'
import { logger } from '../lib/logger.js'

const repoConfigLogger = logger.child('repo-config')

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class RepoConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'RepoConfigError'
    this.code = code
  }
}

function safeYamlLoad(source: string): unknown {
  try {
    return yaml.load(source) ?? null
  } catch (error) {
    throw new RepoConfigError('yaml_invalid', 'invalid YAML configuration', error)
  }
}

export async function readYaml(
  fs: { readFile: (p: string) => Promise<string> },
  filePath: string,
): Promise<any> {
  let raw: string
  try {
    raw = await fs.readFile(filePath)
  } catch (error) {
    if (isMissing(error)) return null
    repoConfigLogger.error('failed to read YAML config', { err: error, path: filePath })
    throw error
  }
  try {
    return safeYamlLoad(raw)
  } catch (error) {
    repoConfigLogger.error('failed to parse YAML config', { err: error, path: filePath })
    throw error
  }
}

export async function writeYaml(
  fs: { writeFile: (p: string, content: string) => Promise<void> },
  filePath: string,
  data: any,
): Promise<void> {
  await fs.writeFile(filePath, yaml.dump(data) + '\n')
}

export async function readRepoFiles(
  fs: {
    readFile: (p: string) => Promise<string>
    exists: (p: string) => Promise<boolean>
    readDir: (p: string) => Promise<string[]>
  },
  repoPath: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const p of ['config.yaml', 'skills.yaml', 'mcp.yaml']) {
    try {
      files[p] = await fs.readFile(join(repoPath, p))
    } catch (error) {
      if (!isMissing(error))
        repoConfigLogger.error('failed to read repository config file', {
          err: error,
          path: join(repoPath, p),
        })
    }
  }
  try {
    const varsDir = join(repoPath, 'vars')
    if (await fs.exists(varsDir)) {
      for (const f of await fs.readDir(varsDir)) {
        if (f.endsWith('.yaml')) {
          try {
            files[`vars/${f}`] = await fs.readFile(join(varsDir, f))
          } catch (error) {
            if (!isMissing(error))
              repoConfigLogger.error('failed to read vars file', {
                err: error,
                path: join(varsDir, f),
              })
          }
        }
      }
    }
  } catch (error) {
    if (!isMissing(error))
      repoConfigLogger.error('failed to read vars directory', {
        err: error,
        path: join(repoPath, 'vars'),
      })
  }
  try {
    const memDir = join(repoPath, 'memories')
    if (await fs.exists(memDir)) {
      for (const f of await fs.readDir(memDir)) {
        if (f.endsWith('.md')) {
          try {
            files[`memories/${f}`] = await fs.readFile(join(memDir, f))
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* no memories dir */
  }
  return files
}

export async function readLocalConfig(
  fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
  home: string,
): Promise<Record<string, unknown>> {
  const path = join(home, '.loom', 'config.yaml')
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch (error) {
    if (isMissing(error)) return {}
    repoConfigLogger.error('failed to read local config', { err: error, path })
    throw error
  }
  try {
    return safeYamlLoad(raw) as Record<string, unknown>
  } catch (error) {
    repoConfigLogger.error('failed to parse local config', { err: error, path })
    throw error
  }
}
