# Vars Profiles UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current key-centric `/vars` page with the approved profile-first Vars UI, using the current `/vars-lab` page as the direct implementation reference.

**Architecture:** Keep the existing agent-aware vars API and add a Web view-model layer that converts one `VarsMatrixResponse` per agent into profile-first data. The production `Vars` page should directly reuse or extract the layout, density, copy, modal shape, table behavior, and CSS decisions already proven in `VarsProfileDemo`, while replacing demo state with real API calls. Monaco / VSCode editor integration is intentionally out of scope for this plan.

**Tech Stack:** React + TypeScript + Vite, existing `api.vars` client, existing `Button` / `IconButton` components, Lucide icons, Vitest + Testing Library.

## Global Constraints

- User-visible content is Chinese; code identifiers, commands, and technical terms may remain English.
- Implement against:
  - `docs/superpowers/specs/2026-07-07-agent-aware-vars-design.md`
  - `docs/superpowers/specs/2026-07-07-memory-vars-consumption-design.md`
  - `docs/superpowers/specs/2026-07-07-vars-ui-profiles-layout-design.md`
- UI implementation reference:
  - `packages/web/src/views/vars/VarsProfileDemo.tsx`
  - `packages/web/src/views/vars/vars-profile-demo.css`
- Treat `/vars-lab` as the accepted UI blueprint for this pass. Do not redesign the information architecture while implementing; port/extract the demo structure and only adjust it where production data or accessibility requires it.
- Real target is `/vars`; keep `/vars-lab` until the user asks to remove it.
- Do not add Monaco in this implementation. Use textarea + raw preview + resolved/markdown preview.
- Do not use user-facing `override`, `恢复继承`, `保存 override`, or `创建 override` copy.
- The list uses four columns: `key + type/format`, `当前值`, `Agent 专属`, `操作`.
- The list does not show `default` as an Agent 专属 chip.
- New config in non-Base profiles uses a searchable, scrollable Base key picker, not native select.
- Search focus uses a neutral ring, not strong emerald.
- Do not commit, push, reset, clean, or switch branches unless the user explicitly asks.

---

## File Structure

- Create: `packages/web/src/views/vars/profile-model.ts`
  - Pure functions for converting existing matrix API data into profile-first UI state.
- Create: `packages/web/src/views/vars/useProfileVars.ts`
  - Loads all supported agents with the existing `api.vars.getMatrix(repoPath, agent)` endpoint.
- Create: `packages/web/src/views/vars/VarsProfileList.tsx`
  - Left profile navigation.
- Create: `packages/web/src/views/vars/VarsProfileTable.tsx`
  - Four-column variable table.
- Create: `packages/web/src/views/vars/VarsConfigModal.tsx`
  - Large centered modal for new/edit/readonly/trace interactions.
- Create: `packages/web/src/views/vars/VarsResolvedView.tsx`
  - Read-only final-result view.
- Modify: `packages/web/src/views/vars/Vars.tsx`
  - Replace current key-centric orchestration with profile-first orchestration.
- Modify: `packages/web/src/views/vars/vars.css`
  - Port approved `vars-profile-demo.css` rules into production selectors; keep spacing, density, modal sizing, badges, table columns, and focus treatment aligned with the demo unless production data forces a small adjustment.
- Create: `packages/web/test/vars-profile-model.test.ts`
  - Pure view-model tests.
- Modify: `packages/web/test/vars-view.test.tsx`
  - Replace key-centric UI assertions with profile-first UI assertions.

---

### Task 1: Add profile-first view model

**Files:**

- Create: `packages/web/src/views/vars/profile-model.ts`
- Create: `packages/web/test/vars-profile-model.test.ts`

**Interfaces:**

- Consumes: `VarsMatrixResponse`, `VarEntryInput`, `VarOverride`, `VarsDiagnostic`, `VarsLayerRef`, `AgentId`.
- Produces:
  - `buildVarsProfileState(input: BuildVarsProfileStateInput): VarsProfileState`
  - `entryValuePreview(entry): string`
  - `parseVarDraft(type, value, format): VarEntryInput`
  - `parseOverrideDraft(type, value): VarOverride`
  - `jsonStringError(value): string | null`

- [ ] **Step 1: Write failing model tests**

Create `packages/web/test/vars-profile-model.test.ts` with these cases:

```ts
import { describe, expect, it } from 'vitest'
import type { AgentId } from '../src/lib/agents'
import type { VarsMatrixResponse } from '../src/lib/vars'
import {
  buildVarsProfileState,
  entryValuePreview,
  jsonStringError,
  parseOverrideDraft,
  parseVarDraft,
} from '../src/views/vars/profile-model'

const agents: AgentId[] = ['claude-code', 'codex', 'opencode']

function matrix(agent: AgentId): VarsMatrixResponse {
  return {
    ok: true,
    agent,
    builtinKeys: ['LOOM_AGENT'],
    userKeys: ['agent_name', 'memory.rtk', 'memory.context'],
    snapshot: {
      base: {
        agent_name: { type: 'string', format: 'markdown', value: 'Agent' },
        'memory.rtk': { type: 'string', format: 'path', value: 'RTK.md' },
        'memory.context': { type: 'string', format: 'markdown', value: '' },
      },
      baseAgent: agent === 'codex' ? { agent_name: { value: 'Codex base' } } : {},
      local: {
        'memory.rtk': { value: 'C:/Users/10107/.codex/RTK.md' },
      },
      localAgent: agent === 'codex' ? { agent_name: { value: 'Local Codex agent' } } : {},
    },
    resolution: {
      ok: true,
      values: {
        LOOM_AGENT: { type: 'string', value: agent },
        agent_name: {
          type: 'string',
          format: 'markdown',
          value: agent === 'codex' ? 'Local Codex agent' : 'Agent',
        },
        'memory.rtk': { type: 'string', format: 'path', value: 'C:/Users/10107/.codex/RTK.md' },
        'memory.context': { type: 'string', format: 'markdown', value: '' },
      },
      sources: {
        LOOM_AGENT: { locality: 'builtin', layer: 'runtime' },
        agent_name:
          agent === 'codex'
            ? { locality: 'local', layer: 'agent', agent: 'codex' }
            : { locality: 'synced', layer: 'base' },
        'memory.rtk': { locality: 'local', layer: 'local' },
        'memory.context': { locality: 'synced', layer: 'base' },
      },
      overrideChains: {},
      dependencies: {},
      diagnostics: [],
    },
  }
}

const matricesByAgent = Object.fromEntries(agents.map((agent) => [agent, matrix(agent)])) as Record<
  AgentId,
  VarsMatrixResponse
>

describe('profile vars view model', () => {
  it('builds builtin, base, and local profile summaries', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: false,
    })
    expect(state.profiles.map((profile) => [profile.id, profile.kindBadge])).toEqual([
      ['builtin', 'runtime'],
      ['base', 'locked'],
      ['local', 'local'],
    ])
  })

  it('hides default from list slots and keeps type/format beside key', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: false,
    })
    const local = state.profiles.find((profile) => profile.id === 'local')
    expect(
      local?.entries.map((entry) => [entry.key, entry.type, entry.format, entry.agentSlots]),
    ).toEqual([
      ['agent_name', 'string', 'markdown', ['codex']],
      ['memory.rtk', 'string', 'path', []],
    ])
  })

  it('adds available Base keys only when requested', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: true,
    })
    const local = state.profiles.find((profile) => profile.id === 'local')
    expect(local?.entries.find((entry) => entry.key === 'memory.context')?.state).toBe('available')
  })

  it('builds resolved rows for the active agent', () => {
    const state = buildVarsProfileState({
      matricesByAgent,
      activeAgent: 'codex',
      showAvailable: false,
    })
    expect(state.resolvedRows.find((row) => row.key === 'agent_name')).toMatchObject({
      valuePreview: 'Local Codex agent',
      sourceLabel: 'local/codex',
    })
  })

  it('parses drafts and validates JSON text', () => {
    expect(parseVarDraft('number', '42')).toEqual({ type: 'number', value: 42 })
    expect(parseVarDraft('boolean', 'true')).toEqual({ type: 'boolean', value: true })
    expect(parseVarDraft('string', '# hi', 'markdown')).toEqual({
      type: 'string',
      format: 'markdown',
      value: '# hi',
    })
    expect(parseOverrideDraft('json', '{"a":1}')).toEqual({ value: { a: 1 } })
    expect(entryValuePreview({ value: 'hello' })).toBe('hello')
    expect(jsonStringError('{"a":1}')).toBeNull()
    expect(jsonStringError('{bad')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
bun run test packages/web/test/vars-profile-model.test.ts
```

Expected: FAIL because `profile-model.ts` does not exist.

- [ ] **Step 3: Implement `profile-model.ts`**

Create `packages/web/src/views/vars/profile-model.ts`:

```ts
import type { AgentId } from '../../lib/agents'
import type {
  VarEntryInput,
  VarOverride,
  VarsDiagnostic,
  VarsLayerRef,
  VarsMatrixResponse,
} from '../../lib/vars'

export type VarsProfileId = 'builtin' | 'base' | 'local'
export type VarsProfileKindBadge = 'runtime' | 'locked' | 'local'
export type VarsProfileEntryState = 'readonly' | 'configured' | 'available'

export type VarsProfileEntry = {
  key: string
  type: VarEntryInput['type']
  format?: string
  valuePreview: string
  state: VarsProfileEntryState
  agentSlots: AgentId[]
  diagnostics: VarsDiagnostic[]
}

export type VarsProfileSummary = {
  id: VarsProfileId
  name: 'Builtin' | 'Base' | 'Local'
  kindBadge: VarsProfileKindBadge
  description: string
  configuredCount: number
  locked: boolean
  entries: VarsProfileEntry[]
}

export type VarsResolvedRow = {
  key: string
  type: VarEntryInput['type']
  format?: string
  valuePreview: string
  sourceLabel: string
  diagnostics: VarsDiagnostic[]
}

export type VarsProfileState = {
  profiles: VarsProfileSummary[]
  resolvedRows: VarsResolvedRow[]
  activeMatrix: VarsMatrixResponse
}

export type BuildVarsProfileStateInput = {
  matricesByAgent: Record<AgentId, VarsMatrixResponse>
  activeAgent: AgentId
  showAvailable: boolean
}

const agents: AgentId[] = ['claude-code', 'codex', 'opencode']

export function entryValuePreview(entry: VarEntryInput | VarOverride | undefined): string {
  if (!entry) return ''
  if (typeof entry.value === 'string') return entry.value
  if (typeof entry.value === 'number' || typeof entry.value === 'boolean')
    return String(entry.value)
  return JSON.stringify(entry.value, null, 2)
}

export function parseVarDraft(
  type: VarEntryInput['type'],
  value: string,
  format?: string,
): VarEntryInput {
  if (type === 'number') return { type, value: Number(value) }
  if (type === 'boolean') return { type, value: value === 'true' }
  if (type === 'json') return { type, value: JSON.parse(value) }
  return format && format !== 'plain' ? { type, format: format as never, value } : { type, value }
}

export function parseOverrideDraft(type: VarEntryInput['type'], value: string): VarOverride {
  if (type === 'number') return { value: Number(value) }
  if (type === 'boolean') return { value: value === 'true' }
  if (type === 'json') return { value: JSON.parse(value) }
  return { value }
}

export function jsonStringError(value: string): string | null {
  try {
    JSON.parse(value)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'JSON 格式无效'
  }
}

function sourceLabel(source: VarsLayerRef | undefined): string {
  if (!source) return '—'
  if (source.locality === 'builtin') return 'builtin/runtime'
  if (source.locality === 'synced' && !source.agent) return 'base'
  if (source.locality === 'synced') return 'base/' + source.agent
  if (source.layer === 'local' && !source.agent) return 'local'
  return 'local/' + source.agent
}

function definitionFor(matrix: VarsMatrixResponse, key: string): VarEntryInput {
  return matrix.snapshot.base[key] ?? { type: 'string', value: '' }
}

function diagnosticsFor(matrix: VarsMatrixResponse, key: string): VarsDiagnostic[] {
  const diagnostics = matrix.resolution.ok
    ? matrix.resolution.diagnostics
    : matrix.resolution.diagnostics
  return diagnostics.filter((diagnostic) => diagnostic.key === key)
}

function agentSlotsFor(
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  layer: 'baseAgent' | 'localAgent',
  key: string,
): AgentId[] {
  return agents.filter((agent) => Boolean(matricesByAgent[agent].snapshot[layer][key]))
}

function buildBuiltinEntries(activeMatrix: VarsMatrixResponse): VarsProfileEntry[] {
  return activeMatrix.builtinKeys.map((key) => {
    const value = activeMatrix.resolution.ok ? activeMatrix.resolution.values[key] : undefined
    return {
      key,
      type: value?.type ?? 'string',
      format: value?.type === 'string' ? value.format : undefined,
      valuePreview: entryValuePreview(value),
      state: 'readonly',
      agentSlots: [],
      diagnostics: diagnosticsFor(activeMatrix, key),
    }
  })
}

function buildBaseEntries(
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  activeMatrix: VarsMatrixResponse,
): VarsProfileEntry[] {
  return activeMatrix.userKeys.map((key) => {
    const definition = definitionFor(activeMatrix, key)
    return {
      key,
      type: definition.type,
      format: definition.type === 'string' ? definition.format : undefined,
      valuePreview: entryValuePreview(definition),
      state: 'configured',
      agentSlots: agentSlotsFor(matricesByAgent, 'baseAgent', key),
      diagnostics: diagnosticsFor(activeMatrix, key),
    }
  })
}

function buildLocalEntries(
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  activeMatrix: VarsMatrixResponse,
  showAvailable: boolean,
): VarsProfileEntry[] {
  const configuredKeys = new Set<string>(Object.keys(activeMatrix.snapshot.local))
  for (const agent of agents) {
    for (const key of Object.keys(matricesByAgent[agent].snapshot.localAgent))
      configuredKeys.add(key)
  }
  const configured = Array.from(configuredKeys)
    .sort()
    .map((key) => {
      const definition = definitionFor(activeMatrix, key)
      const localValue = activeMatrix.snapshot.local[key]
      const localAgentValue = activeMatrix.snapshot.localAgent[key]
      return {
        key,
        type: definition.type,
        format: definition.type === 'string' ? definition.format : undefined,
        valuePreview: entryValuePreview(localAgentValue ?? localValue),
        state: 'configured' as const,
        agentSlots: agentSlotsFor(matricesByAgent, 'localAgent', key),
        diagnostics: diagnosticsFor(activeMatrix, key),
      }
    })
  if (!showAvailable) return configured
  const available = activeMatrix.userKeys
    .filter((key) => !configuredKeys.has(key))
    .map((key) => {
      const definition = definitionFor(activeMatrix, key)
      return {
        key,
        type: definition.type,
        format: definition.type === 'string' ? definition.format : undefined,
        valuePreview: '未配置',
        state: 'available' as const,
        agentSlots: [],
        diagnostics: diagnosticsFor(activeMatrix, key),
      }
    })
  return [...configured, ...available]
}

function buildResolvedRows(activeMatrix: VarsMatrixResponse): VarsResolvedRow[] {
  if (!activeMatrix.resolution.ok) return []
  return [...activeMatrix.builtinKeys, ...activeMatrix.userKeys].map((key) => {
    const value = activeMatrix.resolution.ok ? activeMatrix.resolution.values[key] : undefined
    const source = activeMatrix.resolution.ok ? activeMatrix.resolution.sources[key] : undefined
    return {
      key,
      type: value?.type ?? 'string',
      format: value?.type === 'string' ? value.format : undefined,
      valuePreview: entryValuePreview(value),
      sourceLabel: sourceLabel(source),
      diagnostics: diagnosticsFor(activeMatrix, key),
    }
  })
}

export function buildVarsProfileState(input: BuildVarsProfileStateInput): VarsProfileState {
  const activeMatrix = input.matricesByAgent[input.activeAgent]
  const builtinEntries = buildBuiltinEntries(activeMatrix)
  const baseEntries = buildBaseEntries(input.matricesByAgent, activeMatrix)
  const localEntries = buildLocalEntries(input.matricesByAgent, activeMatrix, input.showAvailable)
  return {
    activeMatrix,
    resolvedRows: buildResolvedRows(activeMatrix),
    profiles: [
      {
        id: 'builtin',
        name: 'Builtin',
        kindBadge: 'runtime',
        description: '运行时内置 · 只读',
        configuredCount: builtinEntries.length,
        locked: true,
        entries: builtinEntries,
      },
      {
        id: 'base',
        name: 'Base',
        kindBadge: 'locked',
        description: '变量定义 registry',
        configuredCount: baseEntries.length,
        locked: true,
        entries: baseEntries,
      },
      {
        id: 'local',
        name: 'Local',
        kindBadge: 'local',
        description: '本机专属',
        configuredCount: localEntries.filter((entry) => entry.state === 'configured').length,
        locked: false,
        entries: localEntries,
      },
    ],
  }
}
```

- [ ] **Step 4: Run model tests**

Run:

```powershell
bun run test packages/web/test/vars-profile-model.test.ts
```

Expected: PASS.

---

### Task 2: Add all-agent loading hook

**Files:**

- Create: `packages/web/src/views/vars/useProfileVars.ts`
- Modify: `packages/web/test/vars-view.test.tsx`

**Interfaces:**

- Consumes: `api.vars.getMatrix(repoPath, agent)`, `buildVarsProfileState()`.
- Produces: `useProfileVars(repoPath: string)`.

- [ ] **Step 1: Update test setup to expect all-agent loading**

In `packages/web/test/vars-view.test.tsx`, make the `getMatrix` mock return a matrix based on the requested agent and add this assertion to the page-load test:

```ts
await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledTimes(3))
expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'claude-code')
expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex')
expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'opencode')
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
bun run test packages/web/test/vars-view.test.tsx -t "loads"
```

Expected: FAIL because current `Vars.tsx` loads only one agent.

- [ ] **Step 3: Implement hook**

Create `packages/web/src/views/vars/useProfileVars.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { AgentId } from '../../lib/agents'
import type { VarsMatrixResponse } from '../../lib/vars'
import { buildVarsProfileState } from './profile-model'

const agents: AgentId[] = ['claude-code', 'codex', 'opencode']

export function useProfileVars(repoPath: string) {
  const [activeAgent, setActiveAgent] = useState<AgentId>('codex')
  const [showAvailable, setShowAvailable] = useState(false)
  const [matricesByAgent, setMatricesByAgent] = useState<Record<
    AgentId,
    VarsMatrixResponse
  > | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const entries = await Promise.all(
        agents.map(async (agent) => [agent, await api.vars.getMatrix(repoPath, agent)] as const),
      )
      setMatricesByAgent(Object.fromEntries(entries) as Record<AgentId, VarsMatrixResponse>)
    } catch (cause) {
      console.error('Failed to load profile vars', cause)
      setError(cause instanceof Error ? cause.message : '变量加载失败')
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    void reload()
  }, [reload])

  const state = useMemo(
    () =>
      matricesByAgent
        ? buildVarsProfileState({ matricesByAgent, activeAgent, showAvailable })
        : null,
    [activeAgent, matricesByAgent, showAvailable],
  )

  return {
    activeAgent,
    setActiveAgent,
    showAvailable,
    setShowAvailable,
    state,
    matricesByAgent,
    loading,
    pending,
    setPending,
    error,
    reload,
  }
}
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
bun run test packages/web/test/vars-profile-model.test.ts packages/web/test/vars-view.test.tsx
```

Expected: model tests pass; view tests that depend on the old page may still fail until Task 3.

---

### Task 3: Replace `Vars.tsx` with profile-first shell

**Files:**

- Create: `packages/web/src/views/vars/VarsProfileList.tsx`
- Create: `packages/web/src/views/vars/VarsProfileTable.tsx`
- Modify: `packages/web/src/views/vars/Vars.tsx`
- Modify: `packages/web/src/views/vars/vars.css`
- Modify: `packages/web/test/vars-view.test.tsx`

**Interfaces:**

- Consumes: `useProfileVars()`, `VarsProfileSummary`, `VarsProfileEntry`.
- Produces: profile-first page shell with `配置管理`, `最终结果`, profiles list, toolbar, and 4-column table.
- UI source: copy/extract the shell, left profile list, toolbar, four-column table, badges, and modal trigger patterns from `packages/web/src/views/vars/VarsProfileDemo.tsx`; replace mock arrays with `useProfileVars` output.

- [ ] **Step 1: Replace key-centric tests**

In `packages/web/test/vars-view.test.tsx`, replace old key-centric assertions with:

```ts
it('loads Vars in profile-first configuration view', async () => {
  render(<Vars repoPath="/repo" />)
  expect(await screen.findByRole('button', { name: /Local/ })).toBeDefined()
  expect(screen.getByRole('button', { name: '配置管理' })).toBeDefined()
  expect(screen.getByRole('button', { name: '最终结果' })).toBeDefined()
  expect(screen.getByText('runtime')).toBeDefined()
  expect(screen.getByText('locked')).toBeDefined()
  expect(screen.getByText('local')).toBeDefined()
  expect(screen.getByText('agent_name')).toBeDefined()
  expect(screen.getByText('Local Codex agent')).toBeDefined()
})

it('renders type beside key and hides default from agent-specific slots', async () => {
  render(<Vars repoPath="/repo" />)
  await screen.findByText('agent_name')
  const row = screen.getByRole('row', { name: /agent_name/ })
  expect(row.textContent).toContain('string')
  expect(row.textContent).toContain('markdown')
  expect(row.textContent).toContain('CX')
  expect(row.textContent).not.toContain('default')
})
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```powershell
bun run test packages/web/test/vars-view.test.tsx -t "profile-first|type beside key"
```

Expected: FAIL because the page is still key-centric.

- [ ] **Step 3: Create `VarsProfileList.tsx`**

Implement a focused component by porting the left sidebar from `VarsProfileDemo.tsx`. Keep the demo\'s accepted visual hierarchy: profile name first, English metadata badge second, icon actions to the right. It must render:

```tsx
<aside className="vars-profiles" aria-label="Profiles">
  <div className="vars-pane-head">配置范围 + 新建 profile icon button</div>
  <div className="vars-profile-list">Builtin / Base / Local buttons</div>
  <section className="vars-profile-card">profile 操作</section>
</aside>
```

Use these exact semantics:

```ts
profile.kindBadge === 'runtime' // blue-ish metadata
profile.kindBadge === 'locked' // muted metadata
profile.kindBadge === 'local' // emerald metadata
```

- [ ] **Step 4: Create `VarsProfileTable.tsx`**

Implement the 4-column table by porting the table structure from `VarsProfileDemo.tsx`. The table header and data rows must share exactly the same grid template so columns align:

```tsx
<section className="vars-table" aria-label="变量列表">
  <div className="vars-table-row head" role="row">
    <span>key</span>
    <span>当前值</span>
    <span>Agent 专属</span>
    <span>操作</span>
  </div>
  {entries.map((entry) => (
    <div className="vars-table-row" role="row" key={entry.key}>
      <span className="vars-key-cell">
        <span className="vars-key">{entry.key}</span>
        <span className="vars-type-stack">type / format badges</span>
      </span>
      <span className="vars-value">{entry.valuePreview}</span>
      <span className="vars-slots">only CC / CX / OC chips, or dash</span>
      <span className="vars-row-actions">icon buttons</span>
    </div>
  ))}
</section>
```

Rules:

```text
readonly entry -> view details button only
available entry -> new config button only
configured entry -> edit + delete/clear + more
default slot -> never render in Agent 专属 column
empty agent slots -> render muted dash
```

- [ ] **Step 5: Replace `Vars.tsx` orchestration**

Rewrite `Vars.tsx` so it:

```tsx
const vars = useProfileVars(repoPath)
const [activeProfileId, setActiveProfileId] = useState('local')
const [view, setView] = useState('definitions')
const [search, setSearch] = useState('')
const [modal, setModal] = useState(null)

// loading and error states stay explicit
// 配置管理 renders VarsProfileList + VarsProfileTable
// 最终结果 renders VarsResolvedView from Task 5
// modal renders VarsConfigModal from Task 4
```

Do not keep the old key-centric layer grid in `Vars.tsx`.

- [ ] **Step 6: Port CSS from demo**

Modify `packages/web/src/views/vars/vars.css` by porting the approved visual system from `vars-profile-demo.css`:

```css
.vars-shell {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 284px minmax(0, 1fr);
}

.vars-table-row {
  display: grid;
  grid-template-columns: minmax(260px, 1.3fr) minmax(260px, 1.45fr) 132px 112px;
  min-height: 54px;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}

.vars-search:focus-within {
  border-color: color-mix(in srgb, var(--muted) 46%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--muted) 12%, transparent);
}
```

Also port:

```text
profile list/card styles
kind badge runtime/locked/local styles
key/type badge styles
slot chip and dash styles
modal shell/body/editor/inspector styles
key picker styles
preview styles
responsive and reduced-motion rules
```

Do not reintroduce the old key-centric layer grid styles. Preserve these demo decisions in production CSS:

```text
profile badges: English labels with subtle metadata colors
search focus: neutral, low-emphasis ring
table: four aligned columns, type/format beside key
modal: centered large editor, internally scrolling body
picker: searchable custom list, not native select
```

- [ ] **Step 7: Run tests**

Run:

```powershell
bun run test packages/web/test/vars-profile-model.test.ts packages/web/test/vars-view.test.tsx
```

Expected: profile shell tests pass; modal/final-result tests may still fail until Tasks 4 and 5.

---

### Task 4: Wire real edit/new modal

**Files:**

- Create: `packages/web/src/views/vars/VarsConfigModal.tsx`
- Modify: `packages/web/test/vars-view.test.tsx`

**Interfaces:**

- Consumes: `api.vars.setBaseKey`, `api.vars.setOverride`, `api.vars.clearOverride`, `parseVarDraft`, `parseOverrideDraft`.
- Produces: `VarsModalState` and `VarsConfigModal`.
- UI source: adapt the approved `VarsProfileDemo` modal. Keep the large centered dialog, left editor/preview column, right metadata/trace column, custom Base key picker, and mutually exclusive edit/raw/resolved modes.

- [ ] **Step 1: Add modal tests**

Add these tests:

```ts
it('opens edit modal and saves a local agent config', async () => {
  render(<Vars repoPath="/repo" />)
  await screen.findByText('agent_name')
  await userEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
  expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
  const textarea = screen.getByRole('textbox', { name: /配置值/ })
  await userEvent.clear(textarea)
  await userEvent.type(textarea, 'Local Codex v2')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(api.vars.setOverride).toHaveBeenCalledWith('/repo', 'local-agent', 'agent_name', { value: 'Local Codex v2' }, 'codex'),
  )
})

it('opens new local config with searchable Base key picker', async () => {
  render(<Vars repoPath="/repo" />)
  await screen.findByText('Local')
  await userEvent.click(screen.getByRole('button', { name: '显示可配置项' }))
  await userEvent.click(screen.getByRole('button', { name: '新建 memory.context 配置' }))
  expect(await screen.findByRole('dialog', { name: '新建配置' })).toBeDefined()
  expect(screen.getByPlaceholderText('搜索 key / format')).toBeDefined()
  expect(screen.getByRole('option', { name: /memory\.context/ })).toBeDefined()
})

it('switches edit, raw preview, and resolved preview mutually', async () => {
  render(<Vars repoPath="/repo" />)
  await screen.findByText('agent_name')
  await userEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
  expect(screen.getByRole('textbox', { name: /配置值/ })).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: '原始预览' }))
  expect(screen.queryByRole('textbox', { name: /配置值/ })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('textbox', { name: /配置值/ })).toBeDefined()
})
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
bun run test packages/web/test/vars-view.test.tsx -t "modal|picker|preview"
```

Expected: FAIL because modal is not implemented.

- [ ] **Step 3: Implement modal**

Create `VarsConfigModal.tsx` by adapting the current `VarsProfileDemo` modal. This is a production wiring task, not a new design task: keep the demo modal layout and replace demo state with real props/API handlers. Required behavior:

```text
mode=readonly -> no save button, builtin only
mode=edit + profile=base + slot=default -> api.vars.setBaseKey
mode=edit + profile=base + slot=agent -> api.vars.setOverride layer base-agent
mode=edit + profile=local + slot=default -> api.vars.setOverride layer local
mode=edit + profile=local + slot=agent -> api.vars.setOverride layer local-agent
mode=new + profile=local -> show Base key picker and write chosen key
clear config -> api.vars.clearOverride for local/base-agent/local-agent only
```

Required UI structure:

```tsx
<div className="vars-modal-backdrop">
  <section className="vars-modal" role="dialog" aria-modal="true">
    <header className="vars-modal-head">key, profile, slot chips, close</header>
    <div className="vars-modal-body">
      <div className="vars-editor-column">key picker when needed + editor card</div>
      <aside className="vars-inspector-column">metadata + trace + diagnostics</aside>
    </div>
    <footer className="vars-modal-footer">取消 / 清除配置 / 保存</footer>
  </section>
</div>
```

Required preview logic:

```text
编辑 -> show textarea only
原始预览 -> show preformatted raw text only
解析预览 -> show markdown preview if format=markdown, otherwise preformatted resolved text
```

Do not render Monaco. Do not render textarea and preview simultaneously.

- [ ] **Step 4: Run modal tests**

Run:

```powershell
bun run test packages/web/test/vars-view.test.tsx -t "modal|picker|preview"
```

Expected: PASS.

---

### Task 5: Add final-result view

**Files:**

- Create: `packages/web/src/views/vars/VarsResolvedView.tsx`
- Modify: `packages/web/test/vars-view.test.tsx`

**Interfaces:**

- Consumes: `VarsResolvedRow[]`, `AgentId`.
- Produces: read-only final-result table.

- [ ] **Step 1: Add final-result test**

Add:

```ts
it('shows final resolved values for the selected agent', async () => {
  render(<Vars repoPath="/repo" />)
  await screen.findByText('agent_name')
  await userEvent.click(screen.getByRole('button', { name: '最终结果' }))
  expect(screen.getByText('当前 agent 的最终变量')).toBeDefined()
  expect(screen.getByText('Local Codex agent')).toBeDefined()
  expect(screen.getByText('local/codex')).toBeDefined()
})
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```powershell
bun run test packages/web/test/vars-view.test.tsx -t "final resolved"
```

Expected: FAIL because final-result component is not implemented.

- [ ] **Step 3: Implement `VarsResolvedView.tsx`**

Create component with this structure:

```tsx
<main className="vars-main" aria-label="最终结果">
  <section className="vars-section-head">
    <h2>当前 agent 的最终变量</h2>
    <div className="cfg-chips vars-agent-chips">CC / CX / OC</div>
  </section>
  <section className="vars-table resolved" aria-label="解析结果">
    <div className="vars-table-row head">
      <span>key</span>
      <span>最终值</span>
      <span>来源</span>
      <span>操作</span>
    </div>
    rows map to four-column readonly rows
  </section>
</main>
```

CSS override:

```css
.vars-table.resolved .vars-table-row {
  grid-template-columns: minmax(260px, 1.3fr) minmax(300px, 1.5fr) 150px 112px;
}
```

- [ ] **Step 4: Run final-result test**

Run:

```powershell
bun run test packages/web/test/vars-view.test.tsx -t "final resolved"
```

Expected: PASS.

---

### Task 6: Final copy cleanup and verification

**Files:**

- Modify: `packages/web/src/views/vars/Vars.tsx`
- Modify: `packages/web/src/views/vars/VarsConfigModal.tsx`
- Modify: `packages/web/src/views/vars/vars.css`
- Modify: `packages/web/test/vars-view.test.tsx`

**Interfaces:**

- Consumes all components from Tasks 1-5.
- Produces a production `/vars` page matching the current `/vars-lab` design.

- [ ] **Step 1: Add no-legacy-copy test**

Add:

```ts
it('does not show override or restore inheritance copy', async () => {
  render(<Vars repoPath="/repo" />)
  await screen.findByText('agent_name')
  expect(screen.queryByText(/override/i)).toBeNull()
  expect(screen.queryByText('恢复继承')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '编辑 agent_name' }))
  expect(await screen.findByRole('dialog', { name: '编辑配置' })).toBeDefined()
  expect(screen.queryByText(/override/i)).toBeNull()
  expect(screen.queryByText('恢复继承')).toBeNull()
})
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
bun run test packages/web/test/vars-profile-model.test.ts packages/web/test/vars-view.test.tsx packages/web/test/button.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run formatting**

Run:

```powershell
bun run format:check
```

Expected:

```text
Checking formatting...
All matched files use Prettier code style!
```

- [ ] **Step 4: Browser verification**

Default project rule is automated front-end verification with `playwright-cli`. If the user explicitly waives browser automation for this implementation run, record that waiver in the final handoff.

Minimum checks:

```text
1. /vars opens without console errors.
2. 配置管理 is default.
3. Builtin/Base/Local profiles show runtime/locked/local badges.
4. Local table has four aligned columns.
5. string/markdown badges sit beside key.
6. default is not shown in Agent 专属.
7. 显示可配置项 shows available Base keys.
8. 新建配置 opens searchable key picker with internal scroll.
9. 编辑配置 opens large modal.
10. 编辑 / 原始预览 / 解析预览 are mutually exclusive.
11. 最终结果 switches agents and shows resolved values.
12. Search focus is neutral.
```

---

## Self-Review Notes

- Spec coverage:
  - Profile-first layout: Tasks 3 and 6.
  - Current `/vars-lab` visual baseline: Tasks 3, 4, 5.
  - 4-column table: Tasks 1 and 3.
  - Hide `default` in list Agent 专属 column: Tasks 1 and 3.
  - Searchable Base key picker: Task 4.
  - Edit/preview mutual exclusion: Task 4.
  - No Monaco for first version: Global Constraints and Task 4.
  - Final-result view: Task 5.
  - No override/inheritance copy: Task 6.
- Placeholder scan:
  - No unfinished-marker steps or unspecified “handle edge cases” steps are present.
  - Custom profile CRUD is intentionally out of first implementation scope because current backend/profile storage does not expose it yet.
- Type consistency:
  - `VarsProfileEntry`, `VarsProfileState`, and `VarsResolvedRow` are defined in Task 1 and consumed by Tasks 3-5.
  - `VarsModalState` is defined in Task 4 and consumed by `Vars.tsx`.

## Execution Handoff

Plan complete. Recommended execution mode: Subagent-Driven, one implementation subagent per task, followed by review before continuing.
