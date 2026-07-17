import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { McpServer } from './types.js'
import type { McpCodecId } from './agents.js'

export interface McpCodec {
  readonly id: McpCodecId
  readonly language: 'json' | 'toml'
  parse(source: string): unknown
  readEntries(document: unknown, rootKey: string): Record<string, unknown>
  writeEntries(
    document: unknown,
    rootKey: string,
    entries: Record<string, unknown>,
  ): Record<string, unknown>
  serialize(document: unknown): string
  preview(rootKey: string, id: string, entry: Record<string, unknown>): string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function createCodec(
  id: McpCodecId,
  language: McpCodec['language'],
  parse: (source: string) => unknown,
  serialize: (document: unknown) => string,
): McpCodec {
  return {
    id,
    language,
    parse,
    readEntries(document, rootKey) {
      return asRecord(asRecord(document)[rootKey])
    },
    writeEntries(document, rootKey, entries) {
      return { ...asRecord(document), [rootKey]: entries }
    },
    serialize,
    preview(rootKey, entryId, entry) {
      return serialize({ [rootKey]: { [entryId]: entry } })
    },
  }
}

const JSON_CODEC = createCodec(
  'json-object',
  'json',
  (source) => JSON.parse(source) as unknown,
  (document) => JSON.stringify(asRecord(document), null, 2),
)

const TOML_CODEC = createCodec(
  'toml-table',
  'toml',
  (source) => parseToml(source) as unknown,
  (document) => stringifyToml(asRecord(document)),
)

const MCP_CODECS: Record<McpCodecId, McpCodec> = {
  'json-object': JSON_CODEC,
  'toml-table': TOML_CODEC,
}

export function getMcpCodec(id: McpCodecId): McpCodec {
  return MCP_CODECS[id]
}

export function toNativeMcpEntry(server: McpServer): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: server.type }
  if (server.command !== undefined) entry.command = server.command
  if (server.args !== undefined) entry.args = server.args
  if (server.env !== undefined) entry.env = server.env
  if (server.url !== undefined) entry.url = server.url
  if (server.headers !== undefined) entry.headers = server.headers
  return entry
}
