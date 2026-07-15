import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { agentShort, type AgentId } from '@/lib/agents'
import { inferRepositoryFileWebUrl, inferRepositoryWebUrl } from '@/lib/repository-links'
import {
  formatSourceMemberSkillId,
  normalizeSkillGroupOrder,
  sourceIdentity,
  type SkillSource,
  type Manifest,
} from '@loom/core'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { TargetChip } from '@/components/ui/TargetChip'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  File,
  FileMinus,
  Folder,
  FolderMinus,
  PackageCheck,
  RefreshCw,
  Pencil,
  Trash2,
  ScanLine,
} from 'lucide-react'
import { sortSkillMembers, type SkillDetail } from './types'
import type {
  ManifestOperations,
  PreparedSkillReconciliation,
  SourceUpdateState,
} from '@/hooks/useManifestOperations'
import SkillReconciliationDialog from './SkillReconciliationDialog'
import { skillFolderDisplayPath } from './source-paths'
import styles from './SkillSourceList.module.css'

interface Props {
  manifest: Manifest
  operations: ManifestOperations
  onOpenDetail: (d: SkillDetail) => void
  onOpenScan: (src: SkillSource) => void
  onOpenEdit: (src: SkillSource) => void
  expandedGroups: Set<string>
  onToggleGroup: (key: string) => void
  groupOrder?: string[]
  onReorderGroups?: (ids: string[]) => Promise<void> | void
}

type DeleteTarget =
  { kind: 'source'; url: string; label: string } | { kind: 'local'; id: string; label: string }

const GROUP_INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [contenteditable="true"]'

interface SkillSortState {
  disabled: boolean
  suppressClick: MutableRefObject<boolean>
}

const SkillSortContext = createContext<SkillSortState | null>(null)

function SortableSkillGroups({
  ids,
  labels,
  onReorder,
  children,
}: {
  ids: string[]
  labels: Map<string, string>
  onReorder: (ids: string[]) => Promise<void> | void
  children: ReactNode
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overlayWidth, setOverlayWidth] = useState<number | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [saving, setSaving] = useState(false)
  const suppressClick = useRef(false)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const disabled = saving || ids.length < 2
  const itemLabel = (id: string | number) => labels.get(String(id)) ?? String(id)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const orderedChildren = Children.toArray(children).sort((left, right) => {
    const leftId = isValidElement<{ id?: string }>(left) ? left.props.id : undefined
    const rightId = isValidElement<{ id?: string }>(right) ? right.props.id : undefined
    return ids.indexOf(leftId ?? '') - ids.indexOf(rightId ?? '')
  })
  const finishDrag = async ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    setOverlayWidth(null)
    suppressClick.current = true
    window.setTimeout(() => {
      suppressClick.current = false
    }, 0)
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    setSaving(true)
    try {
      await onReorder(arrayMove(ids, from, to))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `已拾取 ${itemLabel(active.id)}`,
          onDragOver: ({ over }) => (over ? `移动到 ${itemLabel(over.id)}` : '移出排序列表'),
          onDragEnd: ({ over }) => (over ? `已放置到 ${itemLabel(over.id)}` : '排序已取消'),
          onDragCancel: () => '排序已取消',
        },
      }}
      onDragStart={(event: DragStartEvent) => {
        setActiveId(String(event.active.id))
        setOverlayWidth(event.active.rect.current.initial?.width ?? null)
      }}
      onDragCancel={() => {
        setActiveId(null)
        setOverlayWidth(null)
      }}
      onDragEnd={(event) => void finishDrag(event)}
    >
      <SkillSortContext.Provider value={{ disabled, suppressClick }}>
        <div className={styles['skill-groups']} data-saving={saving || undefined}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {orderedChildren}
          </SortableContext>
        </div>
      </SkillSortContext.Provider>
      <DragOverlay
        dropAnimation={
          reducedMotion ? null : { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
        }
      >
        {activeId ? (
          <div
            className={cn(styles.group, styles['group-overlay'])}
            style={{ width: overlayWidth ?? undefined }}
            aria-hidden="true"
          >
            <div className={styles['group-head']}>
              <span className={styles.gname}>{labels.get(activeId) ?? activeId}</span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function SortableSkillGroup({ id, children }: { id: string; children: ReactNode }) {
  const context = useContext(SkillSortContext)
  if (!context) throw new Error('SortableSkillGroup must be inside SortableSkillGroups')
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id, disabled: context.disabled })
  const filteredListeners = Object.fromEntries(
    Object.entries(listeners ?? {}).map(([name, listener]) => [
      name,
      (event: SyntheticEvent<HTMLElement>) => {
        const target = event.target as Element | null
        if (target !== event.currentTarget) {
          if (!target?.closest('[data-sort-activator="true"]')) return
          if (target.closest(GROUP_INTERACTIVE_SELECTOR)) return
        }
        listener(event as never)
      },
    ]),
  )

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        setActivatorNodeRef(node)
      }}
      className={styles['sortable-group']}
      data-dragging={isDragging || undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      onClickCapture={(event) => {
        if (!context.suppressClick.current) return
        event.preventDefault()
        event.stopPropagation()
      }}
      {...attributes}
      {...filteredListeners}
      aria-label={`调整 ${id} 顺序`}
      aria-roledescription="可排序项"
    >
      {children}
    </div>
  )
}

const chevronStyle = (isCollapsed: boolean): React.CSSProperties => ({
  color: 'var(--signal)',
  transition: 'transform var(--dur) var(--ease)',
  transform: isCollapsed ? 'rotate(-90deg)' : 'none',
})

const renderChip = (agent: AgentId, active: boolean, onClick?: () => void) => (
  <TargetChip
    key={agent}
    agent={agent}
    className={styles.chip}
    state={active ? 'on' : 'off'}
    label={agentShort[agent]}
    tooltip={`${agentShort[agent]} ${active ? '已启用' : '未启用'}`}
    onClick={onClick}
  />
)

function sourceTargetState(src: SkillSource, agent: AgentId) {
  const members = src.members ?? []
  const count = members.filter((member) => (member.targets ?? []).includes(agent)).length
  const state: 'off' | 'on' | 'mixed' =
    count === 0 ? 'off' : count === members.length ? 'on' : 'mixed'
  return { count, total: members.length, state }
}

type SourceSkillMember = NonNullable<SkillSource['members']>[number]
type LocalSkillItem = Manifest['skills']['skills'][number]

function sourceSkillRelativePath(member: SourceSkillMember): string {
  const rawPath = member.entry?.replace(/\\/g, '/') ?? member.path?.replace(/\\/g, '/')
  if (!rawPath) return `skills/${member.name}/SKILL.md`
  const relativePath = rawPath.replace(/^\.\/+/, '').replace(/^\/+/, '')
  return relativePath.endsWith('/SKILL.md')
    ? relativePath
    : relativePath.replace(/\/+$/, '') + '/SKILL.md'
}

function localSkillFilePath(skill: LocalSkillItem): string {
  if (skill.skillFilePath) return skill.skillFilePath
  const rawPath = skill.path?.replace(/\\/g, '/') ?? `assets/skills/${skill.id}`
  const relativePath = rawPath.replace(/^\.\/+/, '').replace(/\/+$/, '')
  return relativePath.endsWith('/SKILL.md') ? relativePath : relativePath + '/SKILL.md'
}

function localSkillDisplayPath(skillFilePath: string): string {
  const folderPath = skillFolderDisplayPath(skillFilePath).replace(/^\.\/+/, '')
  return folderPath.startsWith('assets/skills/')
    ? folderPath.slice('assets/skills/'.length)
    : folderPath
}

export default function SkillSourceList({
  manifest,
  operations,
  onOpenDetail,
  onOpenScan,
  onOpenEdit,
  expandedGroups,
  onToggleGroup,
  groupOrder,
  onReorderGroups,
}: Props) {
  const [updates, setUpdates] = useState<Record<string, SourceUpdateState>>({})
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [reconciliation, setReconciliation] = useState<PreparedSkillReconciliation | null>(null)
  const [reconciliationBusy, setReconciliationBusy] = useState(false)
  const [reconciliationError, setReconciliationError] = useState<string | null>(null)
  const [hiddenResourceSources, setHiddenResourceSources] = useState<Set<string>>(() => new Set())

  const agents = manifest.config?.targets ?? []
  const visibleAgents: AgentId[] = agents
  const sourceCount = manifest.skills.sources.length
  const localCount = manifest.skills.skills.length

  const handleChipToggle = async (
    sourceUrl: string,
    memberEntry: string,
    agent: AgentId,
    currentTargets: AgentId[],
  ) => {
    await operations.toggleSourceSkillTarget(sourceUrl, memberEntry, agent, currentTargets)
  }

  const handleLocalChipToggle = async (id: string, agent: AgentId, currentTargets: AgentId[]) => {
    await operations.toggleLocalSkillTarget(id, agent, currentTargets)
  }

  const handleCheck = async (src: SkillSource) => {
    const result = await operations.checkSourceUpdate(src)
    if (result.ok && result.result?.update) {
      setUpdates((prev) => ({ ...prev, [src.url]: result.result!.update! }))
    }
  }

  const handlePerformUpdate = async (src: SkillSource) => {
    const result = await operations.performSourceUpdate(src, updates[src.url])
    if (result.ok && result.result) {
      const prepared = result.result as PreparedSkillReconciliation
      setReconciliationError(null)
      setReconciliation(prepared)
    }
  }

  const finalizeReconciliation = async (
    preserve: string[],
    resourceBoundaryDecisions: Array<{ entry: string; action: 'enable' | 'exclude' }>,
  ) => {
    if (!reconciliation) return
    setReconciliationBusy(true)
    setReconciliationError(null)
    try {
      const result = await operations.finalizeSourceUpdate(
        reconciliation.sessionId,
        preserve,
        resourceBoundaryDecisions,
      )
      if (!result.ok) {
        setReconciliationError(result.message ?? '完成 source 更新失败')
        return
      }
      setReconciliation(null)
      setUpdates({})
    } finally {
      setReconciliationBusy(false)
    }
  }

  const requestDeleteSource = (url: string, label: string) => {
    setDeleteTarget({ kind: 'source', url, label })
  }

  const requestDeleteLocal = (id: string) => {
    setDeleteTarget({ kind: 'local', id, label: id })
  }

  const toggleSourceResources = (sourceUrl: string) => {
    setHiddenResourceSources((current) => {
      const next = new Set(current)
      if (next.has(sourceUrl)) next.delete(sourceUrl)
      else next.add(sourceUrl)
      return next
    })
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const result =
      deleteTarget.kind === 'source'
        ? await operations.deleteSource(deleteTarget.url)
        : await operations.deleteLocalSkill(deleteTarget.id)
    if (result.ok) {
      setDeleteTarget(null)
    }
  }

  if (sourceCount === 0 && localCount === 0) return null

  const deleteBusy =
    deleteTarget?.kind === 'source'
      ? operations.pending.source.delete(deleteTarget.url)
      : deleteTarget?.kind === 'local'
        ? operations.pending.skills.deleteLocal(deleteTarget.id)
        : false
  const groupLabels = new Map(
    manifest.skills.sources.map((source) => [
      `source:${source.url}`,
      sourceIdentity(source).repoId,
    ]),
  )
  if (localCount > 0) groupLabels.set('local', 'local skills')

  return (
    <>
      <SortableSkillGroups
        ids={groupOrder ?? normalizeSkillGroupOrder(manifest.skills)}
        labels={groupLabels}
        onReorder={onReorderGroups ?? (() => {})}
      >
        {/* Remote sources */}
        {manifest.skills.sources.map((src) => {
          const repoId = sourceIdentity(src).repoId
          const key = src.url + '-' + src.ref
          const isExpanded = expandedGroups.has(key)
          const sourceUpdate = updates[src.url]
          const includedResources = [...(src.resources?.include ?? [])].sort((a, b) =>
            a.path.localeCompare(b.path, 'en'),
          )
          const excludedResources = [...(src.resources?.exclude ?? [])].sort((a, b) =>
            a.path.localeCompare(b.path, 'en'),
          )
          const resourceRuleCount = includedResources.length + excludedResources.length
          const resourcesVisible = !hiddenResourceSources.has(src.url)
          const resourceSectionId = `source-resources-${repoId}`
          const repositoryWebUrl = inferRepositoryWebUrl(src.url)
          return (
            <SortableSkillGroup key={key} id={`source:${src.url}`}>
              <div className={styles.group}>
                <div
                  className={styles['group-head']}
                  data-testid={`skill-group-head-${repoId}`}
                  data-sort-activator="true"
                  style={{ position: 'relative' }}
                  data-expanded={isExpanded}
                  onClick={() => onToggleGroup(key)}
                >
                  <button
                    type="button"
                    className={styles.gname}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? '折叠' : '展开'} ${repoId}`}
                  >
                    <ChevronDown size={14} style={chevronStyle(!isExpanded)} />
                    {repoId}
                  </button>
                  <span
                    className={cn(
                      styles['source-type-badge'],
                      src.type === 'tag' ? styles.tag : styles.branch,
                    )}
                  >
                    {src.type ?? 'branch'}
                  </span>
                  {repositoryWebUrl ? (
                    <a
                      href={repositoryWebUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.gurl}
                      title={src.url}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {src.url}
                    </a>
                  ) : (
                    <span className={styles.gurl} title={src.url}>
                      {src.url}
                    </span>
                  )}
                  <span className={styles.gref}>@ {src.ref}</span>
                  {sourceUpdate && (
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: 'var(--warn)',
                      }}
                    >
                      {'-> '}
                      {sourceUpdate === 'repair' ? 'repair' : sourceUpdate.label}
                    </span>
                  )}
                  <span className={styles.gacts} onClick={(e) => e.stopPropagation()}>
                    {visibleAgents.length > 0 && (
                      <span
                        className={cn('target-chips', styles['source-target-chips'])}
                        aria-label={`${repoId} 批量投影`}
                      >
                        {visibleAgents.map((agent) => {
                          const { count, total, state } = sourceTargetState(src, agent)
                          const status =
                            state === 'on'
                              ? '全部已选择'
                              : state === 'mixed'
                                ? '部分已选择'
                                : '全部未选择'
                          const tooltip = state === 'mixed' ? `${status} ${count}/${total}` : status
                          const disabled =
                            total === 0 || operations.pending.skills.sourceTargets(src, agent)
                          return (
                            <TargetChip
                              key={agent}
                              agent={agent}
                              className={styles['source-target-chip']}
                              state={state}
                              label={`${repoId} ${agentShort[agent]}：${status}`}
                              tooltip={`${repoId} ${agentShort[agent]}：${tooltip}`}
                              disabled={disabled}
                              onClick={() => void operations.setSourceSkillTargets(src, agent)}
                            />
                          )
                        })}
                      </span>
                    )}
                    {visibleAgents.length > 0 && (
                      <span className={styles['source-actions-divider']} />
                    )}
                    {isExpanded && resourceRuleCount > 0 && (
                      <IconButton
                        label={`${resourcesVisible ? '隐藏' : '显示'} ${repoId} resources`}
                        tooltip={`${resourcesVisible ? '隐藏' : '显示'} resources`}
                        size="sm"
                        aria-controls={resourceSectionId}
                        aria-expanded={resourcesVisible}
                        onClick={() => toggleSourceResources(src.url)}
                      >
                        {resourcesVisible ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </IconButton>
                    )}
                    <IconButton
                      label={`检查更新 source ${repoId}`}
                      tooltip={operations.pending.source.check(src) ? '检查中…' : '检查更新'}
                      size="sm"
                      onClick={() => handleCheck(src)}
                      disabled={operations.pending.source.check(src)}
                    >
                      <RefreshCw
                        className={
                          'h-3.5 w-3.5' +
                          (operations.pending.source.check(src) ? ' animate-spin' : '')
                        }
                      />
                    </IconButton>
                    {updates[src.url] && (
                      <IconButton
                        label={`更新 source ${repoId}`}
                        tooltip={operations.pending.source.update(src) ? '更新中…' : '更新'}
                        size="sm"
                        onClick={() => handlePerformUpdate(src)}
                        disabled={operations.pending.source.update(src)}
                        tone="warning"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                    <IconButton
                      label={`编辑 source ${repoId}`}
                      tooltip="编辑"
                      size="sm"
                      onClick={() => onOpenEdit(src)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      label={`扫描 source ${repoId}`}
                      tooltip="scan"
                      size="sm"
                      onClick={() => onOpenScan(src)}
                    >
                      <ScanLine className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      label={`删除 source ${repoId}`}
                      tooltip="删除"
                      size="sm"
                      tone="danger"
                      onClick={() => requestDeleteSource(src.url, repoId)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </span>
                </div>
                {isExpanded &&
                  sortSkillMembers(src.members ?? []).map((m) => {
                    const mTargets = (m.targets ?? []) as AgentId[]
                    const memberEntry = typeof m.entry === 'string' ? m.entry : ''
                    const relativePath = sourceSkillRelativePath(m)
                    const displayPath = skillFolderDisplayPath(relativePath)
                    const repositoryFileWebUrl = inferRepositoryFileWebUrl(
                      src.url,
                      src.ref,
                      relativePath,
                    )
                    return (
                      <div
                        key={m.entry || `invalid:${m.name}`}
                        className={styles.skill}
                        data-testid={`source-skill-${m.name}`}
                        onClick={() =>
                          onOpenDetail({
                            skillId: formatSourceMemberSkillId(src, m.name, manifest.config),
                            source: src.url,
                            path: (m.path ?? memberEntry) || undefined,
                            targets: mTargets,
                          })
                        }
                      >
                        <span
                          className={styles['bundle-skill-icon']}
                          data-testid={`source-bundle-icon-${m.name}`}
                          aria-hidden="true"
                        >
                          <PackageCheck size={12} />
                        </span>
                        <span className={styles['skill-main']}>
                          <span className={styles['skill-name-line']}>
                            <span className={cn(styles.sname, styles.clickable)}>{m.name}</span>
                            {repositoryFileWebUrl && (
                              <a
                                href={repositoryFileWebUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles['skill-source-link']}
                                aria-label={`在仓库中打开 ${m.name} 的 SKILL.md`}
                                title={repositoryFileWebUrl}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                            <span
                              className={styles['skill-source-path']}
                              data-testid={`source-skill-path-${m.name}`}
                              title={relativePath}
                            >
                              {displayPath}
                            </span>
                          </span>
                          {m.description && (
                            <span className={styles['skill-description']} title={m.description}>
                              {m.description}
                            </span>
                          )}
                        </span>
                        <span className={styles.chips} onClick={(e) => e.stopPropagation()}>
                          {visibleAgents.map((a) =>
                            renderChip(
                              a,
                              mTargets.includes(a),
                              memberEntry
                                ? () => handleChipToggle(src.url, memberEntry, a, mTargets)
                                : undefined,
                            ),
                          )}
                        </span>
                      </div>
                    )
                  })}
                {isExpanded && !src.members?.length && (
                  <div className={styles.skill}>
                    <span className={cn(styles.sdot, styles.green)} />
                    <span className={styles.sname} style={{ color: 'var(--muted)' }}>
                      未发现 members
                    </span>
                    <span className={styles.chips}>
                      {visibleAgents.map((a) => renderChip(a, false))}
                    </span>
                  </div>
                )}
                {isExpanded && resourceRuleCount > 0 && (
                  <section
                    id={resourceSectionId}
                    className={styles['resource-section']}
                    data-testid={`source-resources-${repoId}`}
                  >
                    <button
                      type="button"
                      className={styles['resource-section-head']}
                      aria-controls={`${resourceSectionId}-list`}
                      aria-expanded={resourcesVisible}
                      onClick={() => toggleSourceResources(src.url)}
                    >
                      <span className={styles['resource-section-icon']} aria-hidden="true">
                        <Folder size={14} />
                      </span>
                      <span className={styles['resource-section-title']}>Resources</span>
                      <span className={styles['resource-summary']}>
                        {includedResources.length} selected
                        {excludedResources.length > 0 && ` · ${excludedResources.length} excluded`}
                      </span>
                      <span className={styles['resource-visibility-icon']} aria-hidden="true">
                        {resourcesVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </span>
                    </button>
                    {resourcesVisible && (
                      <div id={`${resourceSectionId}-list`} className={styles['resource-list']}>
                        {includedResources.map((resource) => (
                          <div
                            key={`include:${resource.kind}:${resource.path}`}
                            className={styles['resource-row']}
                            data-testid={`source-resource-include-${resource.path}`}
                          >
                            <span className={styles['resource-row-icon']} aria-hidden="true">
                              {resource.kind === 'directory' ? (
                                <Folder size={14} />
                              ) : (
                                <File size={14} />
                              )}
                            </span>
                            <span className={styles['resource-path']} title={resource.path}>
                              {resource.path}
                            </span>
                            <span className={styles['resource-kind']}>{resource.kind}</span>
                          </div>
                        ))}
                        {excludedResources.map((resource) => (
                          <div
                            key={`exclude:${resource.kind}:${resource.path}`}
                            className={cn(styles['resource-row'], styles['resource-row-excluded'])}
                            data-testid={`source-resource-exclude-${resource.path}`}
                          >
                            <span className={styles['resource-row-icon']} aria-hidden="true">
                              {resource.kind === 'directory' ? (
                                <FolderMinus size={14} />
                              ) : (
                                <FileMinus size={14} />
                              )}
                            </span>
                            <span className={styles['resource-path']} title={resource.path}>
                              {resource.path}
                            </span>
                            <span className={cn(styles['resource-kind'], styles.excluded)}>
                              excluded · {resource.kind}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </div>
            </SortableSkillGroup>
          )
        })}

        {/* Local skills */}
        {localCount > 0 && (
          <SortableSkillGroup id="local">
            <div className={cn(styles.group, styles['local-skills-group'])}>
              <div
                className={styles['group-head']}
                data-testid="skill-group-head-local"
                data-sort-activator="true"
                data-expanded={expandedGroups.has('local')}
                onClick={() => onToggleGroup('local')}
              >
                <button
                  type="button"
                  className={styles.gname}
                  aria-expanded={expandedGroups.has('local')}
                  aria-label={`${expandedGroups.has('local') ? '折叠' : '展开'} local skills`}
                >
                  <ChevronDown size={14} style={chevronStyle(!expandedGroups.has('local'))} />
                  local skills <span className={styles['local-tag']}>local</span>
                </button>
                <span
                  className={cn(styles['skill-source-path'], styles['local-skills-root-path'])}
                  title="assets/skills"
                >
                  assets/skills
                </span>
              </div>
              {expandedGroups.has('local') &&
                manifest.skills.skills.map((s) => {
                  const lTargets = (s.targets ?? []) as AgentId[]
                  const missing = Boolean(s.path && s.available === false)
                  const filePath = localSkillFilePath(s)
                  const displayPath = localSkillDisplayPath(filePath)
                  const openLocalDetail = () =>
                    onOpenDetail({ skillId: s.id, path: s.path, targets: lTargets })
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        styles.skill,
                        missing ? styles['skill-missing'] : styles['skill-clickable'],
                      )}
                      data-testid={`local-skill-${s.id}`}
                      onClick={missing ? undefined : openLocalDetail}
                    >
                      <span
                        className={cn(
                          styles['bundle-skill-icon'],
                          missing && styles['bundle-skill-icon-missing'],
                        )}
                        data-testid={`local-bundle-icon-${s.id}`}
                        aria-hidden="true"
                      >
                        <PackageCheck size={12} />
                      </span>
                      <span className={styles['skill-main']}>
                        <span className={styles['skill-name-line']}>
                          {missing ? (
                            <span className={cn(styles.sname, styles.dim)}>{s.id}</span>
                          ) : (
                            <button
                              type="button"
                              className={cn(
                                styles.sname,
                                styles.clickable,
                                styles['skill-name-button'],
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                openLocalDetail()
                              }}
                            >
                              {s.id}
                            </button>
                          )}
                          <span
                            className={styles['skill-source-path']}
                            data-testid={`local-skill-path-${s.id}`}
                            title={filePath}
                          >
                            {displayPath}
                          </span>
                          {s.path && <span className={styles['ref-badge']}>ref</span>}
                          {missing && (
                            <span className={styles['missing-ref-badge']} role="status">
                              <AlertTriangle size={12} /> 路径不存在
                            </span>
                          )}
                        </span>
                        {s.description && (
                          <span className={styles['skill-description']} title={s.description}>
                            {s.description}
                          </span>
                        )}
                      </span>
                      <span className={styles.chips} onClick={(e) => e.stopPropagation()}>
                        {visibleAgents.map((a) =>
                          renderChip(a, lTargets.includes(a), () =>
                            handleLocalChipToggle(s.id, a, lTargets),
                          ),
                        )}
                      </span>
                      <span
                        className={styles['skill-actions']}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <IconButton
                          label={`删除 local skill ${s.id}`}
                          tooltip="删除"
                          tone="danger"
                          onClick={() => requestDeleteLocal(s.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </span>
                    </div>
                  )
                })}
            </div>
          </SortableSkillGroup>
        )}
      </SortableSkillGroups>

      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleteBusy) setDeleteTarget(null)
        }}
        title={deleteTarget?.kind === 'local' ? '删除 local skill' : '删除 source'}
        width={420}
        busy={deleteBusy}
      >
        <div className={styles['danger-confirm']}>
          <div className={styles['danger-confirm-icon']} aria-hidden="true">
            <AlertTriangle size={18} />
          </div>
          <div className={styles['danger-confirm-copy']}>
            <p className={styles['danger-confirm-title']}>
              确认删除 <strong>{deleteTarget?.label}</strong>？
            </p>
            <p className={styles['danger-confirm-body']}>
              此操作会移除当前配置里的引用，无法在界面中撤销。删除前请确认没有其他 target 依赖它。
            </p>
          </div>
        </div>
        <div className={styles['danger-confirm-actions']}>
          <Button
            variant="secondary"
            size="sm"
            disabled={deleteBusy}
            data-autofocus
            onClick={() => setDeleteTarget(null)}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={deleteBusy}
            onClick={() => void confirmDelete()}
          >
            {deleteBusy ? '删除中…' : '删除'}
          </Button>
        </div>
      </Modal>
      <SkillReconciliationDialog
        state={reconciliation}
        busy={reconciliationBusy}
        error={reconciliationError}
        onClose={() => {}}
        onConfirm={finalizeReconciliation}
      />
    </>
  )
}
