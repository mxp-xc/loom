import { z } from 'zod'

export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const LocalSkillIdSchema = z
  .string()
  .regex(SKILL_NAME_REGEX, 'must be a lowercase, hyphen-separated path segment')

export function assertLocalSkillId(value: unknown): asserts value is string {
  if (LocalSkillIdSchema.safeParse(value).success) return
  throw new Error(`Invalid local skill id: ${String(value)}`)
}
