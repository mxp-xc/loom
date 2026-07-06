import matter from 'gray-matter'

export interface SkillMeta {
  name: string
  description: string
  path: string
}

const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function parseSkillMeta(
  content: string,
  dirName: string,
  skillPath: string,
): SkillMeta | null {
  const { data } = matter(content)
  if (!NAME_REGEX.test(dirName)) return null
  return {
    name: dirName,
    description: (data.description as string) ?? '',
    path: skillPath,
  }
}

export function parseSkillFrontmatterName(content: string): string | null {
  const { data } = matter(content)
  return typeof data.name === 'string' ? data.name : null
}
