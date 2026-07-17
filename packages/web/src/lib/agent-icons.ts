import type { AgentIcon } from '@loom/core'

const assetModules = import.meta.glob('../assets/agents/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export type ResolvedAgentIcon = { kind: 'asset'; url: string } | { kind: 'text'; text: string }

export function resolveAgentIcon(icon: AgentIcon): ResolvedAgentIcon {
  if (icon.kind === 'text') return icon
  const suffix = `/assets/agents/${icon.key}.svg`
  const entry = Object.entries(assetModules).find(([path]) =>
    path.replace(/\\/g, '/').endsWith(suffix),
  )
  if (!entry) throw new Error(`Missing agent icon asset: ${icon.key}`)
  return { kind: 'asset', url: entry[1] }
}
