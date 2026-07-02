import { join } from 'node:path'
import yaml from 'js-yaml'

export async function readYaml(
  fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
  filePath: string,
): Promise<any> {
  if (!(await fs.exists(filePath))) return null
  const raw = await fs.readFile(filePath)
  return yaml.load(raw) ?? null
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
    } catch {
      /* missing */
    }
  }
  try {
    const varsDir = join(repoPath, 'vars')
    if (await fs.exists(varsDir)) {
      for (const f of await fs.readDir(varsDir)) {
        if (f.endsWith('.yaml')) {
          try {
            files[`vars/${f}`] = await fs.readFile(join(varsDir, f))
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* no vars dir */
  }
  return files
}

export async function readLocalConfig(
  fs: { readFile: (p: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
  home: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(join(home, '.loom', 'config.yaml'))
    return yaml.load(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
