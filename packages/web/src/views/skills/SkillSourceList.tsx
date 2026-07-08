import { useState } from 'react'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import {
  formatSourceMemberSkillId,
  sourceIdentity,
  type SkillSource,
  type Manifest,
} from '@loom/core'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  RefreshCw,
  Pencil,
  Trash2,
  ScanLine,
} from 'lucide-react'
import { sortSkillMembers, type SkillDetail } from './types'
import type { ManifestOperations, SourceUpdateState } from '@/hooks/useManifestOperations'
import styles from './SkillSourceList.module.css'

interface Props {
  manifest: Manifest
  operations: ManifestOperations
  onOpenDetail: (d: SkillDetail) => void
  onOpenScan: (src: SkillSource) => void
  onOpenEdit: (src: SkillSource) => void
  expandedGroups: Set<string>
  onToggleGroup: (key: string) => void
}

type DeleteTarget =
  { kind: 'source'; url: string; label: string } | { kind: 'local'; id: string; label: string }

const chevronStyle = (isCollapsed: boolean): React.CSSProperties => ({
  color: 'var(--signal)',
  transition: 'transform var(--dur) var(--ease)',
  transform: isCollapsed ? 'rotate(-90deg)' : 'none',
})

const renderChip = (agent: AgentId, active: boolean, onClick?: () => void) => (
  <button
    type="button"
    key={agent}
    className={cn(styles.chip, active ? styles.active : styles.inactive)}
    style={{ ['--c' as string]: agentColor[agent] }}
    onClick={onClick}
    aria-pressed={active}
    title={`${agentShort[agent]} ${active ? '已启用' : '未启用'}`}
  >
    {agentShort[agent]}
  </button>
)

function sourceTargetState(src: SkillSource, agent: AgentId) {
  const members = (src.members ?? []).filter((member) => member.enabled !== false)
  const count = members.filter((member) => (member.targets ?? []).includes(agent)).length
  const state = count === 0 ? 'off' : count === members.length ? 'on' : 'mixed'
  return { count, total: members.length, state }
}

type SourceSkillMember = NonNullable<SkillSource['members']>[number]
type LocalSkillItem = Manifest['skills']['skills'][number]

function sourceSkillRelativePath(member: SourceSkillMember): string {
  const rawPath = member.path?.replace(/\\/g, '/')
  if (!rawPath) return `skills/${member.name}/SKILL.md`
  const skillsPathIndex = rawPath.lastIndexOf('/skills/')
  const relativePath =
    skillsPathIndex >= 0 ? rawPath.slice(skillsPathIndex + 1) : rawPath.replace(/^\/+/, '')
  return relativePath.endsWith('/SKILL.md')
    ? relativePath
    : relativePath.replace(/\/+$/, '') + '/SKILL.md'
}

function githubRepositoryUrl(sourceUrl: string): string | null {
  const withoutGitSuffix = sourceUrl.replace(/\.git$/, '')
  if (withoutGitSuffix.startsWith('github:')) {
    return 'https://github.com/' + withoutGitSuffix.slice('github:'.length).replace(/^\/+/, '')
  }
  if (withoutGitSuffix.startsWith('git@github.com:')) {
    return 'https://github.com/' + withoutGitSuffix.slice('git@github.com:'.length)
  }
  const match = withoutGitSuffix.match(/^https?:\/\/github\.com\/([^/]+\/[^/#?]+)/)
  return match ? 'https://github.com/' + match[1] : null
}

function encodePathSegmented(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

function githubSourceFileUrl(sourceUrl: string, ref: string, relativePath: string): string | null {
  const repoUrl = githubRepositoryUrl(sourceUrl)
  if (!repoUrl) return null
  return `${repoUrl}/blob/${encodePathSegmented(ref)}/${encodePathSegmented(relativePath)}`
}

function localSkillFilePath(skill: LocalSkillItem): string {
  if (skill.skillFilePath) return skill.skillFilePath
  const rawPath = skill.path?.replace(/\\/g, '/') ?? `assets/skills/${skill.id}`
  const relativePath = rawPath.replace(/^\.\/+/, '').replace(/\/+$/, '')
  return relativePath.endsWith('/SKILL.md') ? relativePath : relativePath + '/SKILL.md'
}

function skillFolderDisplayPath(skillFilePath: string): string {
  return skillFilePath.replace(/\\/g, '/').replace(/\/SKILL\.md$/, '')
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
}: Props) {
  const [updates, setUpdates] = useState<Record<string, SourceUpdateState>>({})
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  const agents = manifest.config?.targets ?? []
  const visibleAgents: AgentId[] = agents
  const sourceCount = manifest.skills.sources.length
  const localCount = manifest.skills.skills.length

  const handleChipToggle = async (
    sourceUrl: string,
    memberName: string,
    agent: AgentId,
    currentTargets: AgentId[],
  ) => {
    await operations.toggleSourceSkillTarget(sourceUrl, memberName, agent, currentTargets)
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
    if (result.ok) {
      setUpdates((prev) => {
        const n = { ...prev }
        delete n[src.url]
        return n
      })
    }
  }

  const requestDeleteSource = (url: string, label: string) => {
    setDeleteTarget({ kind: 'source', url, label })
  }

  const requestDeleteLocal = (id: string) => {
    setDeleteTarget({ kind: 'local', id, label: id })
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

  return (
    <>
      <div className={styles['skill-groups']}>
        {/* Remote sources */}
        {manifest.skills.sources.map((src) => {
          const repoId = sourceIdentity(src).repoId
          const key = src.url + '-' + src.ref
          const isExpanded = expandedGroups.has(key)
          const sourceUpdate = updates[src.url]
          return (
            <div key={key} className={styles.group}>
              <div
                className={styles['group-head']}
                data-testid={`skill-group-head-${repoId}`}
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
                <a
                  href={src.url.replace(/\.git$/, '')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.gurl}
                  title={src.url}
                  onClick={(e) => e.stopPropagation()}
                >
                  {src.url}
                </a>
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
                        const tooltip =
                          state === 'on'
                            ? '全部已选择'
                            : state === 'mixed'
                              ? '部分已选择'
                              : '全部未选择'
                        const disabled =
                          total === 0 || operations.pending.skills.sourceTargets(src, agent)
                        return (
                          <button
                            key={agent}
                            type="button"
                            className={cn('target-chip', styles['source-target-chip'])}
                            style={{ ['--c' as string]: agentColor[agent] }}
                            data-state={state}
                            aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
                            aria-label={`${repoId} ${agentShort[agent]}：${tooltip}`}
                            data-tooltip={`${repoId} ${agentShort[agent]}：${tooltip}`}
                            disabled={disabled}
                            onClick={() => void operations.setSourceSkillTargets(src, agent)}
                          >
                            {agentShort[agent]}
                            {state === 'mixed' && (
                              <span className="target-chip-count">
                                {count}/{total}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </span>
                  )}
                  {visibleAgents.length > 0 && (
                    <span className={styles['source-actions-divider']} />
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
                      <RefreshCw className="h-3.5 w-3.5" />
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
                  const isEnabled = m.enabled !== false
                  const mTargets = (m.targets ?? []) as AgentId[]
                  const relativePath = sourceSkillRelativePath(m)
                  const displayPath = skillFolderDisplayPath(relativePath)
                  const githubFileUrl = githubSourceFileUrl(src.url, src.ref, relativePath)
                  return (
                    <div
                      key={m.name}
                      className={styles.skill}
                      data-testid={`source-skill-${m.name}`}
                      onClick={() =>
                        onOpenDetail({
                          skillId: formatSourceMemberSkillId(src, m.name, manifest.config),
                          source: src.url,
                          targets: mTargets,
                        })
                      }
                    >
                      <span className={cn(styles.sdot, isEnabled ? styles.green : styles.dim)} />
                      <span className={styles['skill-main']}>
                        <span className={styles['skill-name-line']}>
                          <span
                            className={cn(styles.sname, styles.clickable, !isEnabled && styles.dim)}
                          >
                            {m.name}
                          </span>
                          {githubFileUrl && (
                            <a
                              href={githubFileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles['skill-source-link']}
                              aria-label={`在 GitHub 打开 ${m.name} 的 SKILL.md`}
                              title={githubFileUrl}
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
                          renderChip(a, isEnabled && mTargets.includes(a), () =>
                            handleChipToggle(src.url, m.name, a, mTargets),
                          ),
                        )}
                      </span>
                      {!isEnabled && <span className={styles['disabled-label']}>disabled</span>}
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
            </div>
          )
        })}

        {/* Local skills */}
        {localCount > 0 && (
          <div className={cn(styles.group, styles['local-skills-group'])}>
            <div
              className={styles['group-head']}
              data-testid="skill-group-head-local"
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
                    <span className={cn(styles.sdot, missing ? styles.yellow : styles.green)} />
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
                    <span className={styles['skill-actions']} onClick={(e) => e.stopPropagation()}>
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
        )}
      </div>

      <div className={styles.legend}>
        {visibleAgents.map((agent) => (
          <div className={styles.lg} key={agent}>
            <span className={styles.sw} style={{ background: agentColor[agent] }} />
            {agentShort[agent]}{' '}
            {agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'OpenCode'}
          </div>
        ))}
        <div className={styles.lg}>
          <span className={styles.sw} style={{ background: 'var(--warn)' }} />
          有更新
        </div>
      </div>
      <div className={styles.hint}>
        source 级操作(更新 ref / scan / 删除)在分组头右侧;发现安装新 source 走右上 + Add source
      </div>

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
    </>
  )
}
