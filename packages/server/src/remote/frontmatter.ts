import matter from 'gray-matter'

export interface SkillMeta {
  name: string
  description: string
  path: string
}

const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function parseSkillMeta(content: string, dirName: string, skillPath: string): SkillMeta | null {
  const { data } = matter(content)
  const name = (data.name as string) ?? dirName
  if (!NAME_REGEX.test(name)) return null
  return {
    name,
    description: (data.description as string) ?? '',
    path: skillPath,
  }
}
