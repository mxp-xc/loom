import yaml from 'js-yaml'
import { z } from 'zod'
import {
  RESERVED_BUILTIN_PREFIX,
  VAR_KEY,
  type JsonValue,
  type VarDefinition,
  type VarEntry,
  type VarOverride,
  type VarsEnvironment,
} from './vars-types.js'

export class VarsCodecError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'VarsCodecError'
  }
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
)

export const VarEntrySchema: z.ZodType<VarEntry> = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['string', 'secret']),
    format: z.enum(['plain', 'markdown', 'json', 'yaml', 'toml', 'shell', 'path']).optional(),
    value: z.string(),
  }),
  z.object({ type: z.literal('number'), value: z.number().finite() }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  z.object({ type: z.literal('json'), value: JsonValueSchema }),
])

export const VarDefinitionSchema: z.ZodType<VarDefinition> = VarEntrySchema

export const VarOverrideSchema: z.ZodType<VarOverride> = z
  .object({ value: z.union([z.string(), z.number().finite(), z.boolean(), JsonValueSchema]) })
  .strict()

export const VarsEnvironmentSchema: z.ZodType<VarsEnvironment> = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('legacy'),
    entries: z.record(z.object({ type: z.literal('string'), value: z.string() })),
  }),
  z.object({ format: z.literal('typed'), entries: z.record(VarEntrySchema) }),
])

const VarsDocumentSchema = z.record(z.unknown())

function assertKeys(document: Record<string, unknown>): void {
  const invalidKey = Object.keys(document).find((key) => !VAR_KEY.test(key))
  if (invalidKey !== undefined) {
    throw new VarsCodecError('var_key_invalid', `invalid variable key: ${invalidKey}`)
  }
}

function assertUserDefinitionKeys(document: Record<string, unknown>): void {
  assertKeys(document)
  const reserved = Object.keys(document).find((key) => key.startsWith(RESERVED_BUILTIN_PREFIX))
  if (reserved !== undefined) {
    throw new VarsCodecError(
      'reserved_builtin_key',
      `builtin variable key is reserved: ${reserved}`,
    )
  }
}

function isTypedDocument(document: Record<string, unknown>): boolean {
  const values = Object.values(document)
  return (
    values.length === 0 ||
    values.every(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value,
    )
  )
}

function cloneWithSafeObjects<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneWithSafeObjects) as T
  if (typeof value !== 'object' || value === null) return value

  const clone = Object.create(null) as Record<string, unknown>
  for (const [key, nestedValue] of Object.entries(value)) {
    Object.defineProperty(clone, key, {
      value: cloneWithSafeObjects(nestedValue),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return clone as T
}

export function parseVarsEnvironment(source: string): VarsEnvironment {
  let loaded: unknown
  try {
    loaded = yaml.load(source) ?? {}
  } catch (error) {
    throw new VarsCodecError('yaml_invalid', 'invalid vars YAML', error)
  }

  const documentResult = VarsDocumentSchema.safeParse(loaded)
  if (!documentResult.success) {
    throw new VarsCodecError(
      'vars_document_invalid',
      'vars YAML must be an object',
      documentResult.error,
    )
  }
  const document = loaded as Record<string, unknown>
  assertKeys(document)

  if (isTypedDocument(document)) {
    const result = z.record(VarEntrySchema).safeParse(document)
    if (!result.success) {
      throw new VarsCodecError('typed_value_invalid', 'invalid typed variable value', result.error)
    }
    return { format: 'typed', entries: cloneWithSafeObjects(document) as Record<string, VarEntry> }
  }

  const entries = Object.create(null) as Record<string, VarEntry>
  for (const [key, value] of Object.entries(document)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new VarsCodecError('legacy_value_invalid', `legacy variable ${key} must be a scalar`)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new VarsCodecError('legacy_value_invalid', `legacy variable ${key} must be finite`)
    }
    Object.defineProperty(entries, key, {
      value: { type: 'string', value: String(value) },
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return { format: 'legacy', entries }
}

export function serializeVarsEnvironment(environment: VarsEnvironment): string {
  const result = VarsEnvironmentSchema.safeParse(environment)
  if (!result.success) {
    throw new VarsCodecError('vars_environment_invalid', 'invalid vars environment', result.error)
  }
  assertKeys(environment.entries)

  const document = Object.fromEntries(
    Object.entries(environment.entries).map(([key, entry]) => [
      key,
      environment.format === 'legacy' ? entry.value : cloneWithSafeObjects(entry),
    ]),
  )
  return yaml.dump(document, { noRefs: true, sortKeys: true })
}

export function parseVarsBaseDefinitions(source: string): Record<string, VarDefinition> {
  let loaded: unknown
  try {
    loaded = yaml.load(source) ?? {}
  } catch (error) {
    throw new VarsCodecError('yaml_invalid', 'invalid vars YAML', error)
  }
  const documentResult = VarsDocumentSchema.safeParse(loaded)
  if (!documentResult.success) {
    throw new VarsCodecError(
      'vars_document_invalid',
      'vars YAML must be an object',
      documentResult.error,
    )
  }
  const document = loaded as Record<string, unknown>
  assertUserDefinitionKeys(document)
  const result = z.record(VarDefinitionSchema).safeParse(document)
  if (!result.success) {
    throw new VarsCodecError('typed_value_invalid', 'invalid typed variable value', result.error)
  }
  return cloneWithSafeObjects(result.data) as Record<string, VarDefinition>
}

export function serializeVarsBaseDefinitions(definitions: Record<string, VarDefinition>): string {
  assertUserDefinitionKeys(definitions)
  const result = z.record(VarDefinitionSchema).safeParse(definitions)
  if (!result.success) {
    throw new VarsCodecError(
      'vars_environment_invalid',
      'invalid vars base definitions',
      result.error,
    )
  }
  return yaml.dump(cloneWithSafeObjects(definitions), { noRefs: true, sortKeys: true })
}

export function parseVarsOverrides(source: string): Record<string, VarOverride> {
  let loaded: unknown
  try {
    loaded = yaml.load(source) ?? {}
  } catch (error) {
    throw new VarsCodecError('yaml_invalid', 'invalid vars YAML', error)
  }
  const documentResult = VarsDocumentSchema.safeParse(loaded)
  if (!documentResult.success) {
    throw new VarsCodecError(
      'vars_document_invalid',
      'vars YAML must be an object',
      documentResult.error,
    )
  }
  const document = loaded as Record<string, unknown>
  assertKeys(document)
  const hasTypedEntry = Object.values(document).some(
    (value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value,
  )
  if (hasTypedEntry) {
    throw new VarsCodecError('override_entry_invalid', 'override entries must only contain value')
  }
  const result = z.record(VarOverrideSchema).safeParse(document)
  if (!result.success) {
    throw new VarsCodecError('override_entry_invalid', 'invalid vars override value', result.error)
  }
  return cloneWithSafeObjects(result.data) as Record<string, VarOverride>
}

export function serializeVarsOverrides(overrides: Record<string, VarOverride>): string {
  assertKeys(overrides)
  const result = z.record(VarOverrideSchema).safeParse(overrides)
  if (!result.success) {
    throw new VarsCodecError('override_entry_invalid', 'invalid vars override value', result.error)
  }
  return yaml.dump(cloneWithSafeObjects(overrides), { noRefs: true, sortKeys: true })
}
