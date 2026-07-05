import { join } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'

export async function listRepos(fs: IFileSystem, home: string): Promise<string[]> {
  const dir = join(home, '.loom', 'repos')
  try {
    const entries = await fs.readDir(dir)
    const out: string[] = []
    for (const name of entries) {
      if (await fs.exists(join(dir, name))) out.push(name)
    }
    return out
  } catch {
    return []
  }
}

export async function resolveRepoPath(
  fs: IFileSystem,
  repo: string,
  home: string,
): Promise<string> {
  const repos = await listRepos(fs, home)
  if (!repos.includes(repo)) {
    throw new Error(`invalid repo: ${repo}`)
  }
  return join(home, '.loom', 'repos', repo)
}
