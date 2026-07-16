import { useState } from 'react'
import { AGENTS, agentName } from '@/lib/agents'
import { IconButton } from '@/components/ui/IconButton'
import { TargetChip } from '@/components/ui/TargetChip'
import { Check, Eraser, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import styles from './ConfigField.module.css'

export type ConfigLevel = 'effective' | 'repo' | 'local'

export type ControlType = 'select' | 'segmented' | 'toggle' | 'chips' | 'input' | 'input-unit'

export interface FieldSchema {
  key: string
  label: string
  group: string
  control: ControlType
  fixed?: boolean
  options?: string[]
  unit?: string
  helpByLevel?: Partial<Record<ConfigLevel, string>>
}

export const FIELD_SCHEMA: FieldSchema[] = [
  {
    key: 'active_repo',
    label: 'Active repo',
    group: 'Workspace',
    control: 'select',
    fixed: true,
    helpByLevel: {
      effective:
        '本机当前操作的 repo。固定存本地级(~/.loom/config.yaml),不随 git 同步,切换会重建投影',
      repo: '此字段固定本地级,不进仓库级 config.yaml',
      local: '切换 repo 会清空当前投影再重建。切换前会弹确认',
    },
  },
  {
    key: 'profile',
    label: 'Profile',
    group: 'Workspace',
    control: 'select',
    helpByLevel: {
      effective: 'vars profile 覆盖档。投影时从 vars/ 目录取对应 profile 的变量文件',
      repo: '团队默认 profile。各成员可在本地级覆盖为不同值',
      local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖',
    },
  },
  {
    key: 'projection.strategy',
    label: 'Strategy',
    group: 'Projection',
    control: 'segmented',
    options: ['link', 'copy'],
    helpByLevel: {
      effective: 'link=创建软链到 agent skills 目录(节省空间); copy=复制文件(跨文件系统兼容)',
      local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖',
    },
  },
  {
    key: 'targets',
    label: 'Targets',
    group: 'Projection',
    control: 'chips',
    helpByLevel: {
      effective: '投影目标 agent。CC=Claude Code, CX=Codex, OC=OpenCode',
      local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖',
    },
  },
  {
    key: 'update_check.enabled',
    label: 'Auto check',
    group: 'Updates',
    control: 'toggle',
    helpByLevel: {
      effective: '开启后按间隔自动检查远程 skill 仓库是否有新版本',
      repo: '团队默认开关。各成员可在本地级覆盖',
      local: '当前继承仓库级值。点左圆点可创建本地覆盖',
    },
  },
  {
    key: 'update_check.interval',
    label: 'Interval',
    group: 'Updates',
    control: 'input-unit',
    unit: 'hours',
    helpByLevel: {
      effective: '两次检查之间的时间间隔',
      local: '当前继承仓库级值。点左圆点或编辑可创建本地覆盖',
    },
  },
  {
    key: 'proxy.http',
    label: 'HTTP',
    group: 'Proxy',
    control: 'input',
    helpByLevel: {
      effective: '拉取远程 skill 仓库时使用的 HTTP 代理',
    },
  },
  {
    key: 'proxy.https',
    label: 'HTTPS',
    group: 'Proxy',
    control: 'input',
    helpByLevel: {
      effective: '拉取远程 skill 仓库时使用的 HTTPS 代理',
    },
  },
  {
    key: 'proxy.no_proxy',
    label: 'No proxy',
    group: 'Proxy',
    control: 'input',
    helpByLevel: {
      effective: '不走代理的地址列表,逗号分隔',
      local: '逗号分隔的地址列表,匹配的地址不走代理',
    },
  },
]

function dotState(level: ConfigLevel, fixed: boolean, inRepo: boolean, inLocal: boolean): string {
  if (fixed) return 'dot-fixed'
  if (level === 'effective') return inLocal ? 'local' : inRepo ? 'repo' : 'inherit'
  if (level === 'repo') return inRepo ? 'repo' : 'inherit'
  return inLocal ? 'local' : 'inherit'
}

function dotTitle(s: string): string {
  switch (s) {
    case 'dot-fixed':
      return '固定本地级'
    case 'repo':
      return '仓库级已设'
    case 'local':
      return '本地级已覆盖 · 点此删除回退'
    case 'inherit':
      return '继承仓库级 · 点此覆盖'
    default:
      return ''
  }
}

interface ConfigFieldProps {
  field: FieldSchema
  level: ConfigLevel
  value: unknown
  effectiveValue: unknown
  inRepo: boolean
  inLocal: boolean
  onCommit: (key: string, value: unknown) => Promise<void>
  draft: string | undefined
  onDraftChange: (key: string, value: string | undefined) => void
}

export function ConfigField({
  field,
  level,
  value,
  effectiveValue,
  inRepo,
  inLocal,
  onCommit,
  draft,
  onDraftChange,
}: ConfigFieldProps) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isFixed = field.fixed === true
  const isReadonly = level === 'effective'
  const isDisabled = isReadonly || (level === 'repo' && isFixed)
  const isInherited =
    (level === 'local' && !inLocal && !isFixed && inRepo) ||
    (level === 'repo' && !inRepo && isFixed)
  const ds = dotState(level, isFixed, inRepo, inLocal)
  const help = field.helpByLevel?.[level]
  const canEdit = !isDisabled
  const editing = draft !== undefined
  const editValue = draft ?? ''
  const displayValue = isInherited ? effectiveValue : value

  const save = async (v: unknown) => {
    if (level === 'effective') return
    setSaving(true)
    setErr(null)
    try {
      await onCommit(field.key, v)
      onDraftChange(field.key, undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Clear a saved value at the current level (saves null)
  const clearValue = async () => {
    setSaving(true)
    setErr(null)
    try {
      await onCommit(field.key, null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const dotClick = () => {
    if (level !== 'local' || isFixed) return
    if (ds === 'inherit') {
      save(effectiveValue)
    } else if (ds === 'local') {
      clearValue()
    }
  }

  const startEdit = () => {
    onDraftChange(field.key, value != null ? String(value) : '')
  }

  const onControlClick = (newValue: unknown) => {
    if (canEdit) save(newValue)
  }
  const toggleChip = (agent: string) => {
    const cur = Array.isArray(value) ? (value as string[]) : []
    const set = new Set(cur)
    if (set.has(agent)) set.delete(agent)
    else set.add(agent)
    // Emit in canonical AGENTS order so local overrides match repo config order
    const next = AGENTS.filter((a) => set.has(a))
    onControlClick(next)
  }

  return (
    <div className={styles['cfg-field']} data-level={level}>
      <div className={styles['cfg-field-row']}>
        <span className={cn(styles.sdot2, styles[ds])} title={dotTitle(ds)} onClick={dotClick} />
        <span className={styles['cfg-field-label']}>
          {field.label}
          {help && (
            <span className={styles['help-ico']}>
              ?<span className={styles['help-tip']}>{help}</span>
            </span>
          )}
        </span>
        <div className={cn(styles['cfg-field-ctrl'], isDisabled && styles['cfg-ctrl-disabled'])}>
          {field.control === 'select' && (
            <div
              className={cn(
                styles['cfg-select'],
                isDisabled && styles['cfg-ctrl-disabled'],
                isInherited && styles['cfg-ctrl-inherited'],
              )}
            >
              {(value as string) || '— 未设置'} <span className={styles.caret}>▼</span>
            </div>
          )}
          {field.control === 'segmented' && (
            <div className={cn(styles['cfg-seg'], isDisabled && styles['cfg-ctrl-disabled'])}>
              {(field.options ?? []).map((opt) => (
                <div
                  key={opt}
                  className={cn(styles['cfg-seg-opt'], value === opt && styles.on)}
                  onClick={() => onControlClick(opt)}
                >
                  {opt}
                </div>
              ))}
            </div>
          )}
          {field.control === 'toggle' && (
            <div
              className={cn(
                styles['cfg-toggle'],
                value === true && styles.on,
                isDisabled && styles['cfg-ctrl-disabled'],
              )}
              onClick={() => onControlClick(!value)}
            />
          )}
          {field.control === 'chips' && (
            <div
              className={cn(
                'target-chips',
                styles['cfg-target-chips'],
                isDisabled && styles['cfg-ctrl-disabled'],
              )}
            >
              {AGENTS.map((agent) => {
                const on = Array.isArray(value) && (value as string[]).includes(agent)
                return (
                  <TargetChip
                    key={agent}
                    agent={agent}
                    state={on ? 'on' : 'off'}
                    label={agentName[agent]}
                    disabled={isDisabled || saving}
                    onClick={() => toggleChip(agent)}
                  />
                )
              })}
            </div>
          )}
          {field.control === 'input-unit' &&
            (editing ? (
              <>
                <input
                  className={cn(styles['cfg-input'], styles['with-unit'])}
                  value={editValue}
                  onChange={(e) => onDraftChange(field.key, e.target.value)}
                  autoFocus
                />
                <span className={styles['cfg-unit']}>{field.unit}</span>
                <IconButton
                  label={`保存 ${field.label}`}
                  tooltip={saving ? '保存中…' : '保存'}
                  tone="success"
                  onClick={() => save(editValue || null)}
                  disabled={saving}
                >
                  <Check className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label={`取消编辑 ${field.label}`}
                  tooltip="取消"
                  onClick={() => {
                    onDraftChange(field.key, undefined)
                    setErr(null)
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
                {err && <span style={{ fontSize: 11, color: 'var(--error)' }}>{err}</span>}
              </>
            ) : (
              <>
                <span
                  className={cn(
                    styles['cfg-input'],
                    styles['with-unit'],
                    isInherited && styles['cfg-ctrl-inherited'],
                  )}
                  style={{ border: 'none', cursor: canEdit ? 'pointer' : 'default' }}
                  onClick={canEdit ? startEdit : undefined}
                >
                  {value != null ? String(value) : '—'}
                </span>
                <span className={styles['cfg-unit']}>{field.unit}</span>
                {canEdit && value != null && (
                  <IconButton
                    label={`清空 ${field.label}`}
                    tooltip={saving ? '清空中…' : '清空'}
                    tone="warning"
                    onClick={clearValue}
                    disabled={saving}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </>
            ))}
          {field.control === 'input' &&
            (editing ? (
              <>
                <input
                  className={styles['cfg-input']}
                  value={editValue}
                  onChange={(e) => onDraftChange(field.key, e.target.value)}
                  autoFocus
                />
                <IconButton
                  label={`保存 ${field.label}`}
                  tooltip={saving ? '保存中…' : '保存'}
                  tone="success"
                  onClick={() => save(editValue || null)}
                  disabled={saving}
                >
                  <Check className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label={`取消编辑 ${field.label}`}
                  tooltip="取消"
                  onClick={() => {
                    onDraftChange(field.key, undefined)
                    setErr(null)
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
                {err && <span style={{ fontSize: 11, color: 'var(--error)' }}>{err}</span>}
              </>
            ) : (
              <>
                <span
                  className={cn(styles['cfg-input'], isInherited && styles['cfg-ctrl-inherited'])}
                  style={{
                    border: 'none',
                    cursor: canEdit ? 'pointer' : 'default',
                    maxWidth: '420px',
                  }}
                  onClick={canEdit ? startEdit : undefined}
                >
                  {displayValue != null && String(displayValue) !== ''
                    ? String(displayValue)
                    : '— 未设置'}
                </span>
                {canEdit && value != null && (
                  <IconButton
                    label={`清空 ${field.label}`}
                    tooltip={saving ? '清空中…' : '清空'}
                    tone="warning"
                    onClick={clearValue}
                    disabled={saving}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </>
            ))}
        </div>
      </div>
    </div>
  )
}
