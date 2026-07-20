import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'

type ValidationErrorCode = string | ((issues: z.ZodIssue[]) => string)
type ValidationErrorMessage = string | ((issues: z.ZodIssue[]) => string)

export interface ValidationOptions {
  error: ValidationErrorCode
  message?: ValidationErrorMessage
  body?: (error: string, issues: z.ZodIssue[]) => unknown
}

type ValidationErrorBody = {
  ok: false
  error: string
  message: string
}

const DEFAULT_VALIDATION_MESSAGE = 'request validation failed'

export function requestValidator<T extends z.ZodTypeAny, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
  options: ValidationOptions,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const error = resolveErrorCode(options.error, result.error.issues)
      const body = options.body
        ? options.body(error, result.error.issues)
        : defaultErrorBody(error, options.message, result.error.issues)
      return c.json(body, 400)
    }
  })
}

export function jsonValidator<T extends z.ZodTypeAny>(schema: T, options: ValidationOptions) {
  return requestValidator('json', schema, options)
}

export function queryValidator<T extends z.ZodTypeAny>(schema: T, options: ValidationOptions) {
  return requestValidator('query', schema, options)
}

export function paramValidator<T extends z.ZodTypeAny>(schema: T, options: ValidationOptions) {
  return requestValidator('param', schema, options)
}

function resolveErrorCode(error: ValidationErrorCode, issues: z.ZodIssue[]): string {
  return typeof error === 'function' ? error(issues) : error
}

function defaultErrorBody(
  error: string,
  message: ValidationErrorMessage | undefined,
  issues: z.ZodIssue[],
): ValidationErrorBody {
  const resolvedMessage = typeof message === 'function' ? message(issues) : message
  return { ok: false, error, message: resolvedMessage || DEFAULT_VALIDATION_MESSAGE }
}
