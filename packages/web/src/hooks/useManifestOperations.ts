import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  sourceIdentity,
  type AgentId,
  type Manifest,
  type McpServer,
  type SkillSource,
} from '@loom/core'
import { api } from '@/lib/api'
import { AGENTS } from '@/lib/agents'
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

export interface LocalSkillCandidate {
  name: string
  path: string
}

export interface LocalSkillFileInput {
  path: string
  content: string
}

export interface SourceScanMember {
  name: string
  description?: string
  path: string
  installed?: boolean
}

export interface SourceRefreshMember {
  name: string
  path: string
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
  scanSourceMembers: (url: string) => 'source:scan:' + url,
  refreshSourceMembers: (url: string) => 'source:refresh:' + url,
  addLocalSkills: () => 'skills:add-local',
  addSource: () => 'source:add',
  saveSource: (url: string) => 'source:save:' + url,
  saveSourceMembers: (url: string) => 'source:members:' + url,
  checkSourceUpdate: (url: string) => 'source:check:' + url,
  performSourceUpdate: (url: string) => 'source:update:' + url,
  deleteSource: (url: string) => 'source:delete:' + url,
  deleteLocalSkill: (id: string) => 'skills:delete-local:' + id,
  sourceSkillTarget: (sourceUrl: string, memberName: string) =>
    'skills:target:' + sourceUrl + ':' + memberName,
  localSkillTarget: (id: string) => 'skills:local-target:' + id,
  allSkillTargets: (agent: AgentId) => 'skills:all-targets:' + agent,
  sourceSkillTargets: (sourceUrl: string, agent: AgentId) =>
    'skills:source-targets:' + sourceUrl + ':' + agent,
  addMcpServer: (id: string) => 'mcp:add:' + id,
  updateMcpServer: (id: string) => 'mcp:update:' + id,
  deleteMcpServer: (id: string) => 'mcp:delete:' + id,
  mcpTarget: (id: string) => 'mcp:target:' + id,
  allMcpTargets: (agent: AgentId) => 'mcp:all-targets:' + agent,
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

function toggleTarget(currentTargets: readonly AgentId[], agent: AgentId): AgentId[] {
  return currentTargets.includes(agent)
    ? currentTargets.filter((item) => item !== agent)
    : [...currentTargets, agent]
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
      if (pendingRef.current.has(key)) return { ok: false, skipped: true }
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

  const scanSourceMembers = useCallback(
    (url: string, options: OperationNotificationOptions = {}) =>
      run(
        pendingKey.scanSourceMembers(url),
        async () => {
          const result = (await api.scanSource(url)) as {
            ok?: boolean
            members?: SourceScanMember[]
            message?: string
            error?: string
          }
          if (Array.isArray(result.members)) result.members = sortByName(result.members)
          return result
        },
        { ...options, reload: false, failureMessage: '扫描失败' },
      ),
    [run],
  )

  const refreshSourceMembers = useCallback(
    (source: SkillSource, options: OperationNotificationOptions = {}) =>
      run(
        pendingKey.refreshSourceMembers(source.url),
        async () => {
          const result = (await api.refreshSource(repoPath, source.url, source.ref)) as {
            ok?: boolean
            members?: SourceRefreshMember[]
            message?: string
            error?: string
          }
          if (Array.isArray(result.members)) result.members = sortByName(result.members)
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
    (input: { url: string; ref: string; members: string[] }) => {
      let sourceCreated = false
      return run(
        pendingKey.addSource(),
        async () => {
          const created = (await api.addSource({
            repo: repoPath,
            url: input.url,
            ref: input.ref,
          })) as MaybeOkResponse
          if (responseFailureMessage(created, '添加 source 失败')) return created
          sourceCreated = true
          if (input.members.length > 0) {
            try {
              const memberResult = (await api.setSourceMembers({
                repo: repoPath,
                url: input.url,
                members: input.members,
              })) as MaybeOkResponse
              const memberError = responseFailureMessage(memberResult, '保存 source members 失败')
              if (memberError) {
                return {
                  ok: false,
                  message: 'source 已添加,但保存 members 失败: ' + memberError,
                  source: created,
                  members: memberResult,
                }
              }
            } catch (err) {
              const message =
                'source 已添加,但保存 members 失败: ' +
                normalizeManifestOperationError(err, '保存 source members 失败')
              throw Object.assign(new Error(message), { cause: err })
            }
          }
          return created
        },
        { failureMessage: '添加 source 失败', reloadOnFailure: () => sourceCreated },
      )
    },
    [repoPath, run],
  )

  const saveSource = useCallback(
    (input: { source: SkillSource; ref: string; type: 'branch' | 'tag'; members: string[] }) => {
      let sourceMetaUpdated = false
      return run(
        pendingKey.saveSource(input.source.url),
        async () => {
          const refChanged = input.ref !== input.source.ref
          const typeChanged = input.type !== (input.source.type ?? 'branch')
          if (refChanged || typeChanged) {
            const metaResult = (await api.updateSourceMeta({
              repo: repoPath,
              url: input.source.url,
              ref: refChanged ? input.ref : undefined,
              type: typeChanged ? input.type : undefined,
            })) as MaybeOkResponse
            if (responseFailureMessage(metaResult, '更新 source 元信息失败')) return metaResult
            sourceMetaUpdated = true
          }
          return api.setSourceMembers({
            repo: repoPath,
            url: input.source.url,
            members: input.members,
          }) as Promise<MaybeOkResponse>
        },
        {
          failureMessage: '保存失败',
          reloadOnFailure: () => sourceMetaUpdated,
          successMessage: () => sourceIdentity(input.source).repoId + ' 已更新',
        },
      )
    },
    [repoPath, run],
  )

  const projectSkillsAfterManifestUpdate = useCallback(
    async (
      saveManifest: () => Promise<MaybeOkResponse>,
      failureMessage: string,
    ): Promise<MaybeOkResponse> => {
      const saved = await saveManifest()
      if (responseFailureMessage(saved, failureMessage)) return saved
      const projected = (await api.project({ repo: repoPath, scope: 'skills' })) as MaybeOkResponse
      const projectError = responseFailureMessage(projected, '投影失败')
      return projectError ? { ok: false, message: projectError } : projected
    },
    [repoPath],
  )

  const saveSourceMembers = useCallback(
    (source: SkillSource, members: string[]) =>
      run(
        pendingKey.saveSourceMembers(source.url),
        () =>
          projectSkillsAfterManifestUpdate(
            () =>
              api.setSourceMembers({
                repo: repoPath,
                url: source.url,
                members,
              }) as Promise<MaybeOkResponse>,
            '保存失败',
          ),
        {
          failureMessage: '保存失败',
          successMessage: () => sourceIdentity(source).repoId + ': ' + members.length + ' members',
        },
      ),
    [projectSkillsAfterManifestUpdate, repoPath, run],
  )

  const checkSourceUpdate = useCallback(
    (source: SkillSource) =>
      run(
        pendingKey.checkSourceUpdate(source.url),
        async (): Promise<SourceUpdateCheck> => {
          const result = (await api.update(repoPath, [source])) as {
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
          api.performUpdate({
            source,
            newRef: update && update !== 'repair' ? (update.newRef ?? source.ref) : source.ref,
            repo: repoPath,
            sourceId: sourceIdentity(source).repoId,
            oldMembers: source.members ?? [],
          }) as Promise<MaybeOkResponse & { pinned_commit?: string }>,
        {
          failureMessage: '更新 source 失败',
          successMessage: (result) =>
            sourceIdentity(source).repoId +
            ' 已更新到 ' +
            (result.pinned_commit?.slice(0, 7) ?? source.ref),
        },
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

  const toggleSourceSkillTarget = useCallback(
    (sourceUrl: string, memberName: string, agent: AgentId, currentTargets: readonly AgentId[]) =>
      run(
        pendingKey.sourceSkillTarget(sourceUrl, memberName),
        () =>
          projectSkillsAfterManifestUpdate(
            () =>
              api.updateSkillTargets({
                repo: repoPath,
                sourceUrl,
                memberName,
                targets: toggleTarget(currentTargets, agent),
              }) as Promise<MaybeOkResponse>,
            '保存 targets 失败',
          ),
        { failureMessage: '保存 targets 失败' },
      ),
    [projectSkillsAfterManifestUpdate, repoPath, run],
  )

  const toggleLocalSkillTarget = useCallback(
    (id: string, agent: AgentId, currentTargets: readonly AgentId[]) =>
      run(
        pendingKey.localSkillTarget(id),
        () =>
          projectSkillsAfterManifestUpdate(
            () =>
              api.updateLocalSkillTargets({
                repo: repoPath,
                id,
                targets: toggleTarget(currentTargets, agent),
              }) as Promise<MaybeOkResponse>,
            '保存 targets 失败',
          ),
        { failureMessage: '保存 targets 失败' },
      ),
    [projectSkillsAfterManifestUpdate, repoPath, run],
  )

  const setAllSkillTargets = useCallback(
    (manifest: Manifest, agent: AgentId) => {
      let targetsUpdated = false
      const skills = [
        ...(manifest.skills?.sources.flatMap((source) =>
          (source.members ?? []).map((member) => ({ kind: 'source' as const, source, member })),
        ) ?? []),
        ...(manifest.skills?.skills.map((skill) => ({ kind: 'local' as const, skill })) ?? []),
      ]
      const allOn =
        skills.length > 0 &&
        skills.every((item) => {
          const targets = item.kind === 'source' ? item.member.targets : item.skill.targets
          return (targets ?? []).includes(agent)
        })
      return run(
        pendingKey.allSkillTargets(agent),
        async () => {
          for (const item of skills) {
            const targets =
              item.kind === 'source' ? (item.member.targets ?? []) : (item.skill.targets ?? [])
            const next = allOn
              ? targets.filter((target) => target !== agent)
              : AGENTS.filter((target) => target === agent || targets.includes(target))
            if (item.kind === 'source') {
              const result = (await api.updateSkillTargets({
                repo: repoPath,
                sourceUrl: item.source.url,
                memberName: item.member.name,
                targets: next,
              })) as MaybeOkResponse
              if (responseFailureMessage(result, '批量更新 targets 失败')) return result
              targetsUpdated = true
            } else {
              const result = (await api.updateLocalSkillTargets({
                repo: repoPath,
                id: item.skill.id,
                targets: next,
              })) as MaybeOkResponse
              if (responseFailureMessage(result, '批量更新 targets 失败')) return result
              targetsUpdated = true
            }
          }
          const projected = (await api.project({
            repo: repoPath,
            scope: 'skills',
          })) as MaybeOkResponse
          const projectError = responseFailureMessage(projected, '投影失败')
          return projectError ? { ok: false, message: projectError } : projected
        },
        { failureMessage: '批量更新 targets 失败', reloadOnFailure: () => targetsUpdated },
      )
    },
    [repoPath, run],
  )

  const setSourceSkillTargets = useCallback(
    (source: SkillSource, agent: AgentId) => {
      let targetsUpdated = false
      const members = (source.members ?? []).filter((member) => member.enabled !== false)
      const allOn =
        members.length > 0 && members.every((member) => (member.targets ?? []).includes(agent))
      return run(
        pendingKey.sourceSkillTargets(source.url, agent),
        async () => {
          const updates = members.map((member) => {
            const targets = member.targets ?? []
            const next = allOn
              ? targets.filter((target) => target !== agent)
              : AGENTS.filter((target) => target === agent || targets.includes(target))
            return { memberName: member.name, targets: next }
          })
          const result = (await api.updateSourceSkillTargets({
            repo: repoPath,
            sourceUrl: source.url,
            updates,
          })) as MaybeOkResponse
          if (responseFailureMessage(result, '批量更新 targets 失败')) return result
          targetsUpdated = updates.length > 0
          const projected = (await api.project({
            repo: repoPath,
            scope: 'skills',
          })) as MaybeOkResponse
          const projectError = responseFailureMessage(projected, '投影失败')
          return projectError ? { ok: false, message: projectError } : projected
        },
        { failureMessage: '批量更新 targets 失败', reloadOnFailure: () => targetsUpdated },
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

  const toggleMcpTarget = useCallback(
    (server: McpServer, agent: AgentId) =>
      run(
        pendingKey.mcpTarget(server.id),
        () =>
          api.updateMcpTargets({
            repo: repoPath,
            id: server.id,
            targets: toggleTarget(server.targets ?? [], agent),
          }) as Promise<MaybeOkResponse>,
        { failureMessage: '保存 targets 失败' },
      ),
    [repoPath, run],
  )

  const setAllMcpTargets = useCallback(
    (servers: McpServer[], agent: AgentId) => {
      let targetsUpdated = false
      const allOn = servers.every((server) => (server.targets ?? []).includes(agent))
      return run(
        pendingKey.allMcpTargets(agent),
        async () => {
          for (const server of servers) {
            const targets = server.targets ?? []
            const next = allOn
              ? targets.filter((item) => item !== agent)
              : targets.includes(agent)
                ? targets
                : [...targets, agent]
            const result = (await api.updateMcpTargets({
              repo: repoPath,
              id: server.id,
              targets: next,
            })) as MaybeOkResponse
            if (responseFailureMessage(result, '批量更新 targets 失败')) return result
            targetsUpdated = true
          }
          return { ok: true }
        },
        { failureMessage: '批量更新 targets 失败', reloadOnFailure: () => targetsUpdated },
      )
    },
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
        allTargets: (agent: AgentId) => pending.has(pendingKey.allSkillTargets(agent)),
        sourceTargets: (source: SkillSource | string, agent: AgentId) =>
          pending.has(pendingKey.sourceSkillTargets(sourceRef(source), agent)),
      },
      mcp: {
        allTargets: (agent: AgentId) => pending.has(pendingKey.allMcpTargets(agent)),
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
      scanSourceMembers,
      refreshSourceMembers,
      addLocalSkills,
      addSource,
      saveSource,
      saveSourceMembers,
      checkSourceUpdate,
      performSourceUpdate,
      deleteSource,
      deleteLocalSkill,
      toggleSourceSkillTarget,
      toggleLocalSkillTarget,
      setAllSkillTargets,
      setSourceSkillTargets,
      addMcpServer,
      updateMcpServer,
      deleteMcpServer,
      toggleMcpTarget,
      setAllMcpTargets,
    }),
    [
      pendingStatus,
      project,
      saveConfig,
      scanLocalSkills,
      loadSourceRefs,
      scanSourceMembers,
      refreshSourceMembers,
      addLocalSkills,
      addSource,
      saveSource,
      saveSourceMembers,
      checkSourceUpdate,
      performSourceUpdate,
      deleteSource,
      deleteLocalSkill,
      toggleSourceSkillTarget,
      toggleLocalSkillTarget,
      setAllSkillTargets,
      setSourceSkillTargets,
      addMcpServer,
      updateMcpServer,
      deleteMcpServer,
      toggleMcpTarget,
      setAllMcpTargets,
    ],
  )
}

export type ManifestOperations = ReturnType<typeof useManifestOperations>
