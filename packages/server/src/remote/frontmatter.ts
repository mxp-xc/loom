import matter from 'gray-matter'

export interface SkillMeta {
  name: string
  description: string
  path: string
  frontmatterName?: string
}

const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function parseSkillMeta(
  content: string,
  dirName: string,
  skillPath: string,
): SkillMeta | null {
  const { data } = matter(content)
  if (!NAME_REGEX.test(dirName)) return null
  const description =
    typeof data.description === 'string'
      ? data.description
      : typeof data.desc === 'string'
        ? data.desc
        : ''
  return {
    name: dirName,
    description,
    path: skillPath,
    ...(typeof data.name === 'string' ? { frontmatterName: data.name } : {}),
  }
}

export function parseSkillFrontmatterName(content: string): string | null {
  const { data } = matter(content)
  return typeof data.name === 'string' ? data.name : null
}
