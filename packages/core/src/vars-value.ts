import { STRING_FORMATS, type JsonValue, type VarEntry } from './vars-types.js'

const stringFormats = new Set<string>(STRING_FORMATS)

function cloneUnknownJsonValue(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object' || ancestors.has(value)) return undefined

  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.some(
        (key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
      )
    )
      return undefined
    if (keys.length !== value.length + 1) return undefined
    ancestors.add(value)
    const clone: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        ancestors.delete(value)
        return undefined
      }
      const item = cloneUnknownJsonValue(descriptor.value, ancestors)
      if (item === undefined) {
        ancestors.delete(value)
        return undefined
      }
      clone.push(item)
    }
    ancestors.delete(value)
    return clone
  }

  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) return undefined
  ancestors.add(value)
  const clone = Object.create(null) as Record<string, JsonValue>
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) {
      ancestors.delete(value)
      return undefined
    }
    const item = cloneUnknownJsonValue(descriptor.value, ancestors)
    if (item === undefined) {
      ancestors.delete(value)
      return undefined
    }
    clone[key] = item
  }
  ancestors.delete(value)
  return clone
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  const clone = cloneUnknownJsonValue(value, new Set())
  if (clone === undefined) throw new TypeError('Invalid JSON value')
  return clone
}

export function normalizeVarEntry(entry: unknown): VarEntry | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const prototype = Object.getPrototypeOf(entry)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(entry)
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    !keys.includes('type') ||
    !keys.includes('value')
  )
    return undefined
  const typeDescriptor = descriptors.type
  const valueDescriptor = descriptors.value
  if (
    !typeDescriptor?.enumerable ||
    !valueDescriptor?.enumerable ||
    !('value' in typeDescriptor) ||
    !('value' in valueDescriptor)
  )
    return undefined
  const type = typeDescriptor.value
  const rawValue = valueDescriptor.value

  if ((type === 'string' || type === 'secret') && typeof rawValue === 'string') {
    const hasFormat = keys.includes('format')
    if (keys.length !== (hasFormat ? 3 : 2)) return undefined
    if (!hasFormat) return { type, value: rawValue }
    const formatDescriptor = descriptors.format
    if (
      !formatDescriptor?.enumerable ||
      !('value' in formatDescriptor) ||
      !stringFormats.has(formatDescriptor.value)
    )
      return undefined
    return { type, value: rawValue, format: formatDescriptor.value }
  }
  if (keys.length !== 2) return undefined
  if (type === 'number' && typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return { type: 'number', value: rawValue }
  }
  if (type === 'boolean' && typeof rawValue === 'boolean') {
    return { type: 'boolean', value: rawValue }
  }
  if (type === 'json') {
    const value = cloneUnknownJsonValue(rawValue, new Set())
    if (value !== undefined) return { type: 'json', value }
  }
  return undefined
}
