export interface PickedSkillFile {
  path: string
  content: string
}

export interface PickedSkillDirectory {
  skills: Array<{ name: string; path: string }>
  filesBySkill: Map<string, PickedSkillFile[]>
}

export class PickedSkillFileReadError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`无法读取 ${path}`, { cause })
    this.name = 'PickedSkillFileReadError'
  }
}

interface BrowserFile {
  file: File
  path: string
}

interface SkillRoot {
  name: string
  path: string
}

function browserFiles(files: readonly File[]): { rootName: string; files: BrowserFile[] } {
  let rootName = ''
  const normalized = files.flatMap((file) => {
    const rawPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const parts = rawPath.split('/').filter(Boolean)
    if (parts.length === 0) return []
    if (parts.length > 1) rootName ||= parts[0]!
    const path = (parts.length > 1 ? parts.slice(1) : parts).join('/')
    return path ? [{ file, path }] : []
  })
  return { rootName, files: normalized }
}

function findSkillRoots(files: readonly BrowserFile[], rootName: string): SkillRoot[] {
  const roots = files
    .filter(({ path }) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
    .map(({ path }) => {
      const parts = path.split('/')
      const parentParts = parts.slice(0, -1)
      return {
        name: parentParts.at(-1) ?? rootName,
        path: parentParts.join('/'),
      }
    })
  const names = new Set<string>()
  for (const root of roots) {
    if (!root.name) throw new Error('无法确定根目录 skill 名称')
    if (names.has(root.name)) throw new Error(`目录中存在重名 skill: ${root.name}`)
    names.add(root.name)
  }
  return roots
}

function owningRoot(path: string, roots: readonly SkillRoot[]): SkillRoot | undefined {
  return roots
    .filter((root) => !root.path || path === root.path || path.startsWith(`${root.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0]
}

export async function readPickedSkillDirectory(
  files: readonly File[],
): Promise<PickedSkillDirectory> {
  const picked = browserFiles(files)
  const roots = findSkillRoots(picked.files, picked.rootName)
  const assigned = new Map<string, BrowserFile[]>()
  for (const root of roots) assigned.set(root.name, [])
  for (const file of picked.files) {
    const root = owningRoot(file.path, roots)
    if (root) assigned.get(root.name)!.push(file)
  }

  const entries = await Promise.all(
    roots.map(async (root) => {
      const skillFiles = await Promise.all(
        assigned
          .get(root.name)!
          .sort((left, right) => {
            const leftIsSkill = left.path.endsWith('/SKILL.md') || left.path === 'SKILL.md'
            const rightIsSkill = right.path.endsWith('/SKILL.md') || right.path === 'SKILL.md'
            if (leftIsSkill !== rightIsSkill) return leftIsSkill ? -1 : 1
            return left.path.localeCompare(right.path)
          })
          .map(async ({ file, path }) => {
            const relativePath = root.path ? path.slice(root.path.length + 1) : path
            try {
              return { path: relativePath, content: await file.text() }
            } catch (cause) {
              throw new PickedSkillFileReadError(path, cause)
            }
          }),
      )
      return [root.name, skillFiles] as const
    }),
  )
  entries.sort(([left], [right]) => left.localeCompare(right))
  return {
    skills: entries.map(([name]) => ({ name, path: name })),
    filesBySkill: new Map(entries),
  }
}
