import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deriveRepoId,
  sourceIdentity,
  AGENT_IDS,
  type AgentId,
  type Manifest,
  type McpServer,
  type SourceResources,
  type SourceTree,
  type SkillSource,
} from '@loom/core'
import { api } from '@/lib/api'
import { refreshManifest } from './useManifest'

type MaybeOkResponse = {
  ok?: boolean
  message?: string
  error?: string
}

export interface OperationResult<T> {
  ok: boolean
  result?: T
  message?: string
  error?: unknown
  skipped?: boolean
}

export interface OperationNotificationOptions {
  notify?: boolean
  shouldNotify?: () => boolean
  allowConcurrent?: boolean
}

export interface SourceScanOptions extends OperationNotificationOptions {
  name?: string
  ref?: string
  type?: 'branch' | 'tag'
}

interface RunOptions<T> extends OperationNotificationOptions {
  reload?: boolean
  reloadOnFailure?: boolean | (() => boolean)
  failureMessage?: string
  successMessage?: string | ((result: T) => string | undefined)
}

export interface ManifestOperationCallbacks {
  onError?: (error: string) => void
  onSuccess?: () => void
  onToast?: (message: string) => void
}

export type SourceUpdateState = 'repair' | { label: string; newRef?: string }

export interface SkillMemberChanges {
  added: Array<{ name: string }>
  updated: Array<{ name: string }>
  removed: Array<{ name: string; agents?: string[] }>
}

export interface ResourceBoundaryChange {
  name: string
  entry: string
  path: string
}

export interface PreparedSkillReconciliation {
  sessionId: string
  pinned_commit: string
  changes: SkillMemberChanges
  resourceBoundaryChanges: ResourceBoundaryChange[]
  pathMoves?: Array<{
    agent: AgentId
    kind: 'bundle' | 'resource-file' | 'resource-directory'
    sourcePath: string
    previousTargetPath?: string
    nextTargetPath?: string
  }>
}

export interface LocalSkillCandidate {
  name: string
  path: string
}

export interface LocalSkillFileInput {
  path: string
  content: string
}

export interface SourceUpdateCheck {
  kind: 'none' | 'repair' | 'update'
  message: string
  update?: SourceUpdateState
}

type ProjectScope = 'skills' | 'mcp' | 'memory' | 'all'

const pendingKey = {
  project: (scope: ProjectScope) => 'project:' + scope,
  config: (level: 'repo' | 'local', field: string) => 'config:' + level + ':' + field,
  scanLocalSkills: (dir: string) => 'skills:scan-local:' + dir,
  loadSourceRefs: (url: string) => 'source:refs:' + url,
  loadCachedSourceTree: (url: string) => 'source:tree:' + url,
  scanSourceTree: (
    url: string,
    name: string | undefined,
    ref: string | undefined,
    type: string | undefined,
  ) => 'source:scan:' + JSON.stringify([url, name ?? '', type ?? '', ref ?? 'HEAD']),
  refreshSourceTree: (url: string) => 'source:refresh:' + url,
  addLocalSkills: () => 'skills:add-local',
  addSource: () => 'source:add',
  saveSource: (url: string) => 'source:save:' + url,
  checkSourceUpdate: (url: string) => 'source:check:' + url,
  performSourceUpdate: (url: string) => 'source:update:' + url,
  cancelSourceUpdate: (sessionId: string) => 'source:update-cancel:' + sessionId,
  deleteSource: (url: string) => 'source:delete:' + url,
  deleteLocalSkill: (id: string) => 'skills:delete-local:' + id,
  sourceSkillAgent: (sourceUrl: string, memberEntry: string) =>
    'skills:agent:' + sourceUrl + ':' + memberEntry,
  localSkillAgent: (id: string) => 'skills:local-agent:' + id,
  allSkillAgents: (agent: AgentId) => 'skills:all-agents:' + agent,
  sourceSkillAgents: (sourceUrl: string, agent: AgentId) =>
    'skills:source-agents:' + sourceUrl + ':' + agent,
  addMcpServer: (id: string) => 'mcp:add:' + id,
  updateMcpServer: (id: string) => 'mcp:update:' + id,
  deleteMcpServer: (id: string) => 'mcp:delete:' + id,
  mcpAgent: (id: string) => 'mcp:agent:' + id,
  allMcpAgents: (agent: AgentId) => 'mcp:all-agents:' + agent,
  scanMcpImports: () => 'mcp:import:scan',
  applyMcpImports: () => 'mcp:import:apply',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function responseFailureMessage(result: unknown, fallback: string): string | null {
  if (!isRecord(result) || result.ok !== false) return null
  return (
    (typeof result.message === 'string' && result.message) ||
    (typeof result.error === 'string' && result.error) ||
    fallback
  )
}

export function normalizeManifestOperationError(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message
    if (typeof error.error === 'string') return error.error
  }
  return String(error || fallback)
}

function shouldNotify(options: OperationNotificationOptions): boolean {
  return options.notify !== false && (!options.shouldNotify || options.shouldNotify())
}

function logOperationFailure(key: string, result: unknown, message: string) {
  console.error({ key, result, message }, 'Manifest operation returned ok:false')
}

function logOperationError(key: string, err: unknown, message: string) {
  console.error({ key, err, message }, 'Manifest operation failed')
}

function sourceRef(source: SkillSource | string): string {
  return typeof source === 'string' ? source : source.url
}

function persistedSourceDto(source: SkillSource): SkillSource {
  return {
    ...(source.name ? { name: source.name } : {}),
    url: source.url,
    ref: source.ref,
    ...(source.type ? { type: source.type } : {}),
    ...(source.pinned_commit ? { pinned_commit: source.pinned_commit } : {}),
    ...(source.members
      ? {
          members: source.members.map(({ name, entry, agents }) => ({
            name,
            entry,
            ...(agents ? { agents } : {}),
          })),
        }
      : {}),
    ...(source.resources ? { resources: source.resources } : {}),
  }
}

function sourceScanDto(source: SkillSource): Pick<SkillSource, 'name' | 'url' | 'ref' | 'type'> {
  return {
    ...(source.name?.trim() ? { name: source.name.trim() } : {}),
    url: source.url,
    ref: source.ref,
    ...(source.type ? { type: source.type } : {}),
  }
}

function successMessageFor<T>(
  option: RunOptions<T>['successMessage'],
  result: T,
): string | undefined {
  return typeof option === 'function' ? option(result) : option
}

function shouldReloadOnFailure<T>(options: RunOptions<T>): boolean {
  const reloadOnFailure = options.reloadOnFailure
  return typeof reloadOnFailure === 'function' ? reloadOnFailure() : reloadOnFailure === true
}

async function refreshAfterFailure<T>(
  key: string,
  repoPath: string,
  options: RunOptions<T>,
): Promise<void> {
  if (!shouldReloadOnFailure(options)) return
  try {
    await refreshManifest(repoPath)
  } catch (error) {
    logOperationError(key, error, 'Manifest refresh after failed operation failed')
  }
}

function toggleAgent(currentAgents: readonly AgentId[], agent: AgentId): AgentId[] {
  return currentAgents.includes(agent)
    ? currentAgents.filter((item) => item !== agent)
    : [...currentAgents, agent]
}

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

export function useManifestOperations(
  repoPath: string,
  callbacks: ManifestOperationCallbacks = {},
) {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const mountedRef = useRef(true)
  const pendingRef = useRef(new Set<string>())
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setPendingKey = useCallback((key: string, value: boolean) => {
    const next = new Set(pendingRef.current)
    if (value) next.add(key)
    else next.delete(key)
    pendingRef.current = next
    if (mountedRef.current) setPending(next)
  }, [])

  const notifyError = useCallback((message: string) => {
    if (mountedRef.current) callbacksRef.current.onError?.(message)
  }, [])

  const notifySuccess = useCallback(() => {
    if (mountedRef.current) callbacksRef.current.onSuccess?.()
  }, [])

  const notifyToast = useCallback((message: string) => {
    if (mountedRef.current) callbacksRef.current.onToast?.(message)
  }, [])

  const run = useCallback(
    async <T>(
      key: string,
      mutate: () => Promise<T>,
      options: RunOptions<T> = {},
    ): Promise<OperationResult<T>> => {
      if (!options.allowConcurrent && pendingRef.current.has(key))
        return { ok: false, skipped: true }
      setPendingKey(key, true)
      try {
        const result = await mutate()
        const notify = shouldNotify(options)
        const fallback = options.failureMessage ?? '操作失败'
        const failureMessage = responseFailureMessage(result, fallback)
        if (failureMessage) {
          logOperationFailure(key, result, failureMessage)
          if (notify) notifyError(failureMessage)
          await refreshAfterFailure(key, repoPath, options)
          return { ok: false, result, message: failureMessage }
        }
        if (options.reload !== false) await refreshManifest(repoPath)
        if (notify) notifySuccess()
        const toast = successMessageFor(options.successMessage, result)
        if (toast && notify) notifyToast(toast)
        return { ok: true, result }
      } catch (error) {
        const message = normalizeManifestOperationError(error, options.failureMessage)
        logOperationError(key, error, message)
        if (shouldNotify(options)) notifyError(message)
        await refreshAfterFailure(key, repoPath, options)
        return { ok: false, error, message }
      } finally {
        setPendingKey(key, false)
      }
    },
    [notifyError, notifySuccess, notifyToast, repoPath, setPendingKey],
  )

  const project = useCallback(
    (scope: ProjectScope) =>
      run(
        pendingKey.project(scope),
        () => api.project({ repo: repoPath, scope }) as Promise<MaybeOkResponse>,
        {
          failureMessage: '投影失败',
          successMessage: '投影完成',
        },
      ),
    [repoPath, run],
  )

  const saveConfig = useCallback(
    (input: { level: 'repo' | 'local'; field: string; value: unknown }) =>
      run(
        pendingKey.config(input.level, input.field),
        () =>
          api.putConfig({
            repo: repoPath,
            level: input.level,
            field: input.field,
            value: input.value,
          }) as Promise<MaybeOkResponse>,
        { failureMessage: '保存配置失败' },
      ),
    [repoPath, run],
  )

  const scanLocalSkills = useCallback(
    (dir: string) =>
      run(
        pendingKey.scanLocalSkills(dir),
        () =>
          api.scanLocalSkills(dir, repoPath) as Promise<{
            ok?: boolean
            skills?: LocalSkillCandidate[]
            message?: string
            error?: string
          }>,
        { reload: false, failureMessage: '扫描失败' },
      ),
    [repoPath, run],
  )

  const loadSourceRefs = useCallback(
    (url: string, options: OperationNotificationOptions = {}) =>
      run(
        pendingKey.loadSourceRefs(url),
        () =>
          api.getSourceRefs(url) as Promise<{
            ok?: boolean
            branches?: string[]
            tags?: string[]
            message?: string
            error?: string
          }>,
        { ...options, reload: false, failureMessage: '获取 refs 失败' },
      ),
    [run],
  )

  const scanSourceTree = useCallback(
    (url: string, options: SourceScanOptions = {}) => {
      const name = options.name?.trim()
      const ref = options.ref?.trim()
      return run(
        pendingKey.scanSourceTree(url, name, ref, options.type),
        async () => {
          const result = (await api.scanSource({
            ...(name ? { name } : {}),
            url,
            ...(ref ? { ref } : {}),
            ...(options.type ? { type: options.type } : {}),
          })) as {
            ok?: boolean
            tree?: SourceTree
            message?: string
            error?: string
          }
          return result
        },
        { ...options, reload: false, failureMessage: '扫描失败' },
      )
    },
    [run],
  )

  const loadCachedSourceTree = useCallback(
    (source: SkillSource, options: OperationNotificationOptions = {}) =>
      run(
        pendingKey.loadCachedSourceTree(source.url),
        () =>
          api.getCachedSourceTree({
            repo: repoPath,
            ...(source.name?.trim() ? { name: source.name.trim() } : {}),
            url: source.url,
            pinned_commit: source.pinned_commit?.trim() || source.ref,
          }) as Promise<{
            ok?: boolean
            tree?: SourceTree
            message?: string
            error?: string
          }>,
        { ...options, reload: false, failureMessage: '读取 source 缓存失败' },
      ),
    [repoPath, run],
  )

  const refreshSourceTree = useCallback(
    (source: SkillSource, options: OperationNotificationOptions = {}) =>
      run(
        pendingKey.refreshSourceTree(source.url),
        async () => {
          const result = (await api.refreshSource(repoPath, sourceScanDto(source))) as {
            ok?: boolean
            tree?: SourceTree
            message?: string
            error?: string
          }
          return result
        },
        { ...options, reload: false, failureMessage: '扫描失败' },
      ),
    [repoPath, run],
  )

  const addLocalSkills = useCallback(
    (input: {
      skills: LocalSkillCandidate[]
      pickedExternal: boolean
      pickedFiles?: Map<string, LocalSkillFileInput[]>
    }) =>
      run(
        pendingKey.addLocalSkills(),
        () => {
          if (input.pickedExternal) {
            return api.writeLocalSkills({
              repo: repoPath,
              skills: input.skills.map((skill) => ({
                name: skill.name,
                files: input.pickedFiles?.get(skill.name) ?? [],
              })),
            }) as Promise<MaybeOkResponse>
          }
          return api.importLocalSkills({
            repo: repoPath,
            skills: input.skills.map((skill) => ({ name: skill.name, path: skill.path })),
            mode: 'ref',
          }) as Promise<MaybeOkResponse>
        },
        { failureMessage: '导入失败' },
      ),
    [repoPath, run],
  )

  const addSource = useCallback(
    (input: {
      name?: string
      url: string
      ref: string
      type?: 'branch' | 'tag'
      members: Array<{ name: string; entry: string }>
      resources: SourceResources
    }) => {
      return run(
        pendingKey.addSource(),
        async () => {
          const created = (await api.addSource({
            repo: repoPath,
            name: input.name?.trim() || deriveRepoId(input.url),
            url: input.url,
            ref: input.ref,
            ...(input.type ? { type: input.type } : {}),
            members: input.members,
            resources: input.resources,
          })) as MaybeOkResponse
          return created
        },
        { failureMessage: '添加 source 失败' },
      )
    },
    [repoPath, run],
  )

  const saveSource = useCallback(
    (input: {
      source: SkillSource
      name?: string
      ref: string
      type: 'branch' | 'tag'
      expectedCommit?: string
      members: Array<{ name: string; entry: string }>
      resources: SourceResources
      preserve?: string[]
    }) => {
      let sourceMetaUpdated = false
      return run(
        pendingKey.saveSource(input.source.url),
        async () => {
          const result = await api.reconcileSource({
            repo: repoPath,
            url: input.source.url,
            name: input.name?.trim() || sourceIdentity(input.source).repoId,
            ref: input.ref,
            type: input.type,
            ...(input.expectedCommit ? { expected_commit: input.expectedCommit } : {}),
            members: input.members,
            resources: input.resources,
            ...(input.preserve !== undefined ? { preserve: input.preserve } : {}),
          })
          if (result.finalized) {
            sourceMetaUpdated = true
            await refreshManifest(repoPath)
          }
          return result
        },
        {
          reload: false,
          failureMessage: '保存失败',
          reloadOnFailure: () => sourceMetaUpdated,
          successMessage: (result) =>
            (result as { finalized?: boolean }).finalized
              ? (input.name?.trim() || sourceIdentity(input.source).repoId) + ' 已更新'
              : undefined,
        },
      )
    },
    [repoPath, run],
  )

  const projectSkillsAfterManifestUpdate = useCallback(
    async (
      saveManifest: () => Promise<MaybeOkResponse>,
      failureMessage: string,
      agent: AgentId,
    ): Promise<MaybeOkResponse> => {
      const saved = await saveManifest()
      if (responseFailureMessage(saved, failureMessage)) return saved
      const projected = (await api.project({
        repo: repoPath,
        scope: 'skills',
        agent,
      })) as MaybeOkResponse
      const projectError = responseFailureMessage(projected, '投影失败')
      return projectError ? { ok: false, message: projectError } : projected
    },
    [repoPath],
  )

  const checkSourceUpdate = useCallback(
    (source: SkillSource) =>
      run(
        pendingKey.checkSourceUpdate(source.url),
        async (): Promise<SourceUpdateCheck> => {
          const result = (await api.update(repoPath, [persistedSourceDto(source)])) as {
            updates?: Array<{
              hasUpdate?: boolean
              needsRepair?: boolean
              latestTag?: string
              latestCommit?: string
            }>
          }
          const update = result.updates?.[0]
          const repoId = sourceIdentity(source).repoId
          if (!update?.hasUpdate) return { kind: 'none', message: repoId + ' 已是最新' }
          if (update.needsRepair) {
            return {
              kind: 'repair',
              message: repoId + ' 缓存损坏,请点击 update 修复',
              update: 'repair',
            }
          }
          const latest =
            update.latestTag ?? (update.latestCommit ? update.latestCommit.slice(0, 7) : 'unknown')
          return {
            kind: 'update',
            message: repoId + ' 有更新: ' + source.ref + ' -> ' + latest,
            update: { label: latest, newRef: update.latestTag },
          }
        },
        {
          reload: false,
          failureMessage: '检查更新失败',
          successMessage: (result) => result.message,
        },
      ),
    [repoPath, run],
  )

  const performSourceUpdate = useCallback(
    (source: SkillSource, update: SourceUpdateState | undefined) =>
      run(
        pendingKey.performSourceUpdate(source.url),
        () =>
          api.prepareSourceUpdate({
            source: persistedSourceDto(source),
            newRef: update && update !== 'repair' ? (update.newRef ?? source.ref) : source.ref,
            repo: repoPath,
          }) as Promise<MaybeOkResponse & PreparedSkillReconciliation>,
        {
          reload: false,
          failureMessage: '更新 source 失败',
        },
      ),
    [repoPath, run],
  )

  const finalizeSourceUpdate = useCallback(
    (
      sessionId: string,
      preserve: string[],
      resourceBoundaryDecisions: Array<{ entry: string; action: 'enable' | 'exclude' }>,
    ) =>
      run(
        `source:update-finalize:${sessionId}`,
        () =>
          api.finalizeSourceUpdate({
            repo: repoPath,
            sessionId,
            preserve,
            resourceBoundaryDecisions,
          }),
        { failureMessage: '完成 source 更新失败', successMessage: 'source 已更新并完成投影' },
      ),
    [repoPath, run],
  )

  const cancelSourceUpdate = useCallback(
    (sessionId: string) =>
      run(
        pendingKey.cancelSourceUpdate(sessionId),
        () => api.cancelSourceUpdate({ repo: repoPath, sessionId }),
        { reload: false, failureMessage: '取消 source 更新失败' },
      ),
    [repoPath, run],
  )

  const deleteSource = useCallback(
    (url: string) =>
      run(
        pendingKey.deleteSource(url),
        () => api.deleteSource({ repo: repoPath, url }) as Promise<MaybeOkResponse>,
        { failureMessage: '删除 source 失败', successMessage: '已删除 source' },
      ),
    [repoPath, run],
  )

  const deleteLocalSkill = useCallback(
    (id: string) =>
      run(
        pendingKey.deleteLocalSkill(id),
        () => api.deleteLocalSkill({ repo: repoPath, id }) as Promise<MaybeOkResponse>,
        { failureMessage: '删除 local skill 失败', successMessage: '已删除 local skill' },
      ),
    [repoPath, run],
  )

  const toggleSourceSkillAgent = useCallback(
    (sourceUrl: string, memberEntry: string, agent: AgentId, currentAgents: readonly AgentId[]) =>
      run(
        pendingKey.sourceSkillAgent(sourceUrl, memberEntry),
        () =>
          projectSkillsAfterManifestUpdate(
            () =>
              api.updateSkillAgents({
                repo: repoPath,
                sourceUrl,
                memberEntry,
                agents: toggleAgent(currentAgents, agent),
              }) as Promise<MaybeOkResponse>,
            '保存 agents 失败',
            agent,
          ),
        { failureMessage: '保存 agents 失败' },
      ),
    [projectSkillsAfterManifestUpdate, repoPath, run],
  )

  const toggleLocalSkillAgent = useCallback(
    (id: string, agent: AgentId, currentAgents: readonly AgentId[]) =>
      run(
        pendingKey.localSkillAgent(id),
        () =>
          projectSkillsAfterManifestUpdate(
            () =>
              api.updateLocalSkillAgents({
                repo: repoPath,
                id,
                agents: toggleAgent(currentAgents, agent),
              }) as Promise<MaybeOkResponse>,
            '保存 agents 失败',
            agent,
          ),
        { failureMessage: '保存 agents 失败' },
      ),
    [projectSkillsAfterManifestUpdate, repoPath, run],
  )

  const setAllSkillAgents = useCallback(
    (manifest: Manifest, agent: AgentId) => {
      let agentsUpdated = false
      const skills = [
        ...(manifest.skills?.sources.flatMap((source) =>
          (source.members ?? []).map((member) => ({ kind: 'source' as const, source, member })),
        ) ?? []),
        ...(manifest.skills?.skills.map((skill) => ({ kind: 'local' as const, skill })) ?? []),
      ]
      const allOn =
        skills.length > 0 &&
        skills.every((item) => {
          const agents = item.kind === 'source' ? item.member.agents : item.skill.agents
          return (agents ?? []).includes(agent)
        })
      return run(
        pendingKey.allSkillAgents(agent),
        async () => {
          for (const item of skills) {
            const agents =
              item.kind === 'source' ? (item.member.agents ?? []) : (item.skill.agents ?? [])
            const next = allOn
              ? agents.filter((candidate) => candidate !== agent)
              : AGENT_IDS.filter((candidate) => candidate === agent || agents.includes(candidate))
            if (item.kind === 'source') {
              const result = (await api.updateSkillAgents({
                repo: repoPath,
                sourceUrl: item.source.url,
                memberEntry: item.member.entry,
                agents: next,
              })) as MaybeOkResponse
              if (responseFailureMessage(result, '批量更新 agents 失败')) return result
              agentsUpdated = true
            } else {
              const result = (await api.updateLocalSkillAgents({
                repo: repoPath,
                id: item.skill.id,
                agents: next,
              })) as MaybeOkResponse
              if (responseFailureMessage(result, '批量更新 agents 失败')) return result
              agentsUpdated = true
            }
          }
          const projected = (await api.project({
            repo: repoPath,
            scope: 'skills',
            agent,
          })) as MaybeOkResponse
          const projectError = responseFailureMessage(projected, '投影失败')
          return projectError ? { ok: false, message: projectError } : projected
        },
        { failureMessage: '批量更新 agents 失败', reloadOnFailure: () => agentsUpdated },
      )
    },
    [repoPath, run],
  )

  const setSourceSkillAgents = useCallback(
    (source: SkillSource, agent: AgentId) => {
      let agentsUpdated = false
      const members = source.members ?? []
      const allOn =
        members.length > 0 && members.every((member) => (member.agents ?? []).includes(agent))
      return run(
        pendingKey.sourceSkillAgents(source.url, agent),
        async () => {
          const updates = members.map((member) => {
            const agents = member.agents ?? []
            const next = allOn
              ? agents.filter((candidate) => candidate !== agent)
              : AGENT_IDS.filter((candidate) => candidate === agent || agents.includes(candidate))
            return { memberEntry: member.entry, agents: next }
          })
          const result = (await api.updateSourceSkillAgents({
            repo: repoPath,
            sourceUrl: source.url,
            updates,
          })) as MaybeOkResponse
          if (responseFailureMessage(result, '批量更新 agents 失败')) return result
          agentsUpdated = updates.length > 0
          const projected = (await api.project({
            repo: repoPath,
            scope: 'skills',
            agent,
          })) as MaybeOkResponse
          const projectError = responseFailureMessage(projected, '投影失败')
          return projectError ? { ok: false, message: projectError } : projected
        },
        { failureMessage: '批量更新 agents 失败', reloadOnFailure: () => agentsUpdated },
      )
    },
    [repoPath, run],
  )

  const addMcpServer = useCallback(
    (server: McpServer) =>
      run(
        pendingKey.addMcpServer(server.id),
        () => api.addMcpServer({ repo: repoPath, server }) as Promise<MaybeOkResponse>,
        { failureMessage: '添加 MCP Server 失败' },
      ),
    [repoPath, run],
  )

  const updateMcpServer = useCallback(
    (id: string, server: McpServer) =>
      run(
        pendingKey.updateMcpServer(id),
        () => api.updateMcpServer({ repo: repoPath, id, server }) as Promise<MaybeOkResponse>,
        { failureMessage: '保存 MCP Server 失败', successMessage: 'MCP Server 已保存' },
      ),
    [repoPath, run],
  )

  const deleteMcpServer = useCallback(
    (id: string) =>
      run(
        pendingKey.deleteMcpServer(id),
        () => api.deleteMcpServer({ repo: repoPath, id }) as Promise<MaybeOkResponse>,
        { failureMessage: '删除 MCP Server 失败' },
      ),
    [repoPath, run],
  )

  const toggleMcpAgent = useCallback(
    (server: McpServer, agent: AgentId) =>
      run(
        pendingKey.mcpAgent(server.id),
        () =>
          api.updateMcpAgents({
            repo: repoPath,
            id: server.id,
            agents: toggleAgent(server.agents ?? [], agent),
          }) as Promise<MaybeOkResponse>,
        { failureMessage: '保存 agents 失败' },
      ),
    [repoPath, run],
  )

  const setAllMcpAgents = useCallback(
    (servers: McpServer[], agent: AgentId) => {
      let agentsUpdated = false
      const allOn = servers.every((server) => (server.agents ?? []).includes(agent))
      return run(
        pendingKey.allMcpAgents(agent),
        async () => {
          for (const server of servers) {
            const agents = server.agents ?? []
            const next = allOn
              ? agents.filter((item) => item !== agent)
              : agents.includes(agent)
                ? agents
                : [...agents, agent]
            const result = (await api.updateMcpAgents({
              repo: repoPath,
              id: server.id,
              agents: next,
            })) as MaybeOkResponse
            if (responseFailureMessage(result, '批量更新 agents 失败')) return result
            agentsUpdated = true
          }
          return { ok: true }
        },
        { failureMessage: '批量更新 agents 失败', reloadOnFailure: () => agentsUpdated },
      )
    },
    [repoPath, run],
  )

  const scanMcpImports = useCallback(
    (sources: AgentId[]) =>
      run(pendingKey.scanMcpImports(), () => api.scanMcpImports({ repo: repoPath, sources }), {
        reload: false,
        failureMessage: '扫描 MCP 配置失败',
      }),
    [repoPath, run],
  )

  const applyMcpImports = useCallback(
    (keys: string[], sources: AgentId[]) =>
      run(
        pendingKey.applyMcpImports(),
        () => api.applyMcpImports({ repo: repoPath, sources, keys }),
        {
          failureMessage: '导入 MCP Server 失败',
          successMessage: '已导入到 desired state',
        },
      ),
    [repoPath, run],
  )

  const pendingStatus = useMemo(
    () => ({
      project: (scope: ProjectScope) => pending.has(pendingKey.project(scope)),
      source: {
        check: (source: SkillSource | string) =>
          pending.has(pendingKey.checkSourceUpdate(sourceRef(source))),
        update: (source: SkillSource | string) =>
          pending.has(pendingKey.performSourceUpdate(sourceRef(source))),
        delete: (source: SkillSource | string) =>
          pending.has(pendingKey.deleteSource(sourceRef(source))),
      },
      skills: {
        deleteLocal: (id: string) => pending.has(pendingKey.deleteLocalSkill(id)),
        allAgents: (agent: AgentId) => pending.has(pendingKey.allSkillAgents(agent)),
        sourceAgents: (source: SkillSource | string, agent: AgentId) =>
          pending.has(pendingKey.sourceSkillAgents(sourceRef(source), agent)),
      },
      mcp: {
        allAgents: (agent: AgentId) => pending.has(pendingKey.allMcpAgents(agent)),
        importScan: pending.has(pendingKey.scanMcpImports()),
        importApply: pending.has(pendingKey.applyMcpImports()),
      },
    }),
    [pending],
  )

  return useMemo(
    () => ({
      pending: pendingStatus,
      project,
      saveConfig,
      scanLocalSkills,
      loadSourceRefs,
      loadCachedSourceTree,
      scanSourceTree,
      refreshSourceTree,
      addLocalSkills,
      addSource,
      saveSource,
      checkSourceUpdate,
      performSourceUpdate,
      finalizeSourceUpdate,
      cancelSourceUpdate,
      deleteSource,
      deleteLocalSkill,
      toggleSourceSkillAgent,
      toggleLocalSkillAgent,
      setAllSkillAgents,
      setSourceSkillAgents,
      addMcpServer,
      updateMcpServer,
      deleteMcpServer,
      scanMcpImports,
      applyMcpImports,
      toggleMcpAgent,
      setAllMcpAgents,
    }),
    [
      pendingStatus,
      project,
      saveConfig,
      scanLocalSkills,
      loadSourceRefs,
      loadCachedSourceTree,
      scanSourceTree,
      refreshSourceTree,
      addLocalSkills,
      addSource,
      saveSource,
      checkSourceUpdate,
      performSourceUpdate,
      finalizeSourceUpdate,
      cancelSourceUpdate,
      deleteSource,
      deleteLocalSkill,
      toggleSourceSkillAgent,
      toggleLocalSkillAgent,
      setAllSkillAgents,
      setSourceSkillAgents,
      addMcpServer,
      updateMcpServer,
      deleteMcpServer,
      scanMcpImports,
      applyMcpImports,
      toggleMcpAgent,
      setAllMcpAgents,
    ],
  )
}

export type ManifestOperations = ReturnType<typeof useManifestOperations>
