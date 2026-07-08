import { CheckCircle2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { AGENTS, agentColor, agentShort, type AgentId } from '../../lib/agents'
import { cn } from '@/lib/utils'
import type { VarsLayerRef, VarsMatrixResponse } from '../../lib/vars'
import type { VarsDiagnostic } from '../../lib/vars'
import type { VarsProfileEntry, VarsProfileSummary } from './profile-model'
import { entryValuePreview, parseOverrideDraft, parseVarDraft } from './profile-model'
import styles from './Vars.module.css'

type PreviewMode = 'edit' | 'raw' | 'resolved'
type ModalKind = 'view' | 'edit' | 'add'
type Slot = 'default' | AgentId

export type VarsModalState =
  | { kind: 'view'; entry: VarsProfileEntry }
  | { kind: 'edit'; entry: VarsProfileEntry }
  | { kind: 'add'; entry?: VarsProfileEntry }

type VarsConfigModalProps = {
  repoPath: string
  modal: VarsModalState
  profile: VarsProfileSummary
  baseEntries: VarsProfileEntry[]
  activeAgent: AgentId
  activeMatrix: VarsMatrixResponse
  matricesByAgent: Record<AgentId, VarsMatrixResponse>
  onClose: () => void
  onSaved: () => Promise<void>
  onError: (message: string) => void
  setPending: (pending: boolean) => void
}

const slotOptions: Slot[] = ['default', ...AGENTS]

function slotLabel(slot: Slot) {
  return slot === 'default' ? 'default' : agentShort[slot]
}

function valueForSlot(
  activeMatrix: VarsMatrixResponse,
  matricesByAgent: Record<AgentId, VarsMatrixResponse>,
  profileId: VarsProfileSummary['id'],
  key: string,
  slot: Slot,
): string {
  const matrix = slot === 'default' ? activeMatrix : (matricesByAgent[slot] ?? activeMatrix)
  if (profileId === 'base' && slot === 'default')
    return entryValuePreview(matrix.snapshot.base[key])
  if (profileId === 'base' && slot !== 'default')
    return entryValuePreview(matrix.snapshot.baseAgent[key])
  if (profileId === 'local' && slot === 'default')
    return entryValuePreview(matrix.snapshot.local[key])
  if (profileId === 'local' && slot !== 'default')
    return entryValuePreview(matrix.snapshot.localAgent[key])
  if (matrix.resolution.ok) return entryValuePreview(matrix.resolution.values[key])
  return ''
}

function traceLabel(ref: VarsLayerRef) {
  if (ref.locality === 'builtin')
    return ['Builtin', ref.agent ? agentShort[ref.agent as AgentId] : 'runtime']
  if (ref.locality === 'synced' && ref.layer === 'base') return ['Base', 'default']
  if (ref.locality === 'synced') return ['Base', agentShort[ref.agent as AgentId] ?? ref.agent]
  if (ref.layer === 'local') return ['Local', 'default']
  return ['Local', agentShort[ref.agent as AgentId] ?? ref.agent]
}

function diagnosticText(diagnostic: VarsDiagnostic) {
  const details = [
    diagnostic.key ? `key=${diagnostic.key}` : null,
    diagnostic.referencedKey ? `ref=${diagnostic.referencedKey}` : null,
    diagnostic.path?.length ? `path=${diagnostic.path.join(' → ')}` : null,
  ].filter(Boolean)
  return `${diagnostic.message}${details.length ? ` · ${details.join(' · ')}` : ''}`
}

function BaseKeyPicker({
  entries,
  selectedKey,
  onChange,
}: {
  entries: VarsProfileEntry[]
  selectedKey: string
  onChange: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = entries.filter((entry) => {
    const haystack = [entry.key, entry.type, entry.format].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })

  return (
    <div className={styles['vars-key-picker']}>
      <label className={styles['vars-key-filter']}>
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 key / format"
        />
      </label>
      <div className={styles['vars-key-options']} role="listbox" aria-label="Base key">
        {filtered.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="option"
            aria-selected={entry.key === selectedKey}
            className={cn(styles['vars-key-option'], entry.key === selectedKey && styles.on)}
            onClick={() => onChange(entry.key)}
          >
            <span>
              <strong>{entry.key}</strong>
              <small>{entry.valuePreview || '未配置'}</small>
            </span>
            <span className={styles['vars-type-stack']}>
              <span className={styles['vars-type-main']}>{entry.type}</span>
              {entry.format && <span className={styles['vars-format']}>{entry.format}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function MarkdownPreview({ value }: { value: string }) {
  const lines = value.split('\n')
  return (
    <div className={cn('md-preview', styles['vars-preview'])}>
      {lines.map((line, index) => {
        if (line.startsWith('# ')) return <h3 key={index}>{line.slice(2)}</h3>
        if (line.startsWith('- ')) return <p key={index}>• {line.slice(2)}</p>
        return <p key={index}>{line || '\u00a0'}</p>
      })}
    </div>
  )
}

export default function VarsConfigModal({
  repoPath,
  modal,
  profile,
  baseEntries,
  activeAgent,
  activeMatrix,
  matricesByAgent,
  onClose,
  onSaved,
  onError,
  setPending,
}: VarsConfigModalProps) {
  const isReadonly = modal.kind === 'view' || profile.id === 'builtin'
  const initialKey = modal.entry?.key ?? baseEntries[0]?.key ?? ''
  const [selectedKey, setSelectedKey] = useState(initialKey)
  const selectedEntry = useMemo(
    () =>
      profile.id === 'base' && modal.kind !== 'add'
        ? modal.entry
        : (baseEntries.find((entry) => entry.key === selectedKey) ?? modal.entry ?? baseEntries[0]),
    [baseEntries, modal.entry, modal.kind, profile.id, selectedKey],
  )
  const initialSlot: Slot =
    modal.kind !== 'add' && profile.id === 'local' && modal.entry.agentSlots.includes(activeAgent)
      ? activeAgent
      : 'default'
  const [slot, setSlot] = useState<Slot>(initialSlot)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('edit')
  const [draft, setDraft] = useState(() =>
    selectedEntry
      ? valueForSlot(activeMatrix, matricesByAgent, profile.id, selectedEntry.key, initialSlot)
      : '',
  )
  const [baseKeyDraft, setBaseKeyDraft] = useState('')

  useEffect(() => {
    if (!selectedEntry) return
    setDraft(valueForSlot(activeMatrix, matricesByAgent, profile.id, selectedEntry.key, slot))
  }, [activeMatrix, matricesByAgent, profile.id, selectedEntry, slot])

  const key =
    profile.id === 'base' && modal.kind === 'add' ? baseKeyDraft.trim() : (selectedEntry?.key ?? '')
  const dialogLabel =
    modal.kind === 'view' ? '查看配置' : modal.kind === 'edit' ? '编辑配置' : '新建配置'
  const type = selectedEntry?.type ?? 'string'
  const format = selectedEntry?.format
  const resolvedValue =
    activeMatrix.resolution.ok && key
      ? entryValuePreview(activeMatrix.resolution.values[key])
      : draft
  const trace =
    activeMatrix.resolution.ok && key ? (activeMatrix.resolution.overrideChains[key] ?? []) : []
  const dependencies =
    activeMatrix.resolution.ok && key ? (activeMatrix.resolution.dependencies[key] ?? []) : []
  const diagnostics = selectedEntry?.diagnostics ?? []

  const save = async () => {
    if (!key || !selectedEntry) return
    setPending(true)
    try {
      if (profile.id === 'base' && slot === 'default') {
        await api.vars.setBaseKey(repoPath, key, parseVarDraft(type, draft, format))
      } else if (profile.id === 'base' && slot !== 'default') {
        await api.vars.setOverride(
          repoPath,
          'base-agent',
          key,
          parseOverrideDraft(type, draft),
          slot,
        )
      } else if (profile.id === 'local' && slot === 'default') {
        await api.vars.setOverride(repoPath, 'local', key, parseOverrideDraft(type, draft))
      } else if (profile.id === 'local' && slot !== 'default') {
        await api.vars.setOverride(
          repoPath,
          'local-agent',
          key,
          parseOverrideDraft(type, draft),
          slot,
        )
      }
      await onSaved()
      onClose()
    } catch (err) {
      console.error({ err }, 'Failed to save vars config')
      onError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setPending(false)
    }
  }

  const clearConfig = async () => {
    if (!key) return
    setPending(true)
    try {
      if (profile.id === 'base' && slot !== 'default') {
        await api.vars.clearOverride(repoPath, 'base-agent', key, slot)
      } else if (profile.id === 'local' && slot === 'default') {
        await api.vars.clearOverride(repoPath, 'local', key)
      } else if (profile.id === 'local' && slot !== 'default') {
        await api.vars.clearOverride(repoPath, 'local-agent', key, slot)
      }
      await onSaved()
      onClose()
    } catch (err) {
      console.error({ err }, 'Failed to clear vars config')
      onError(err instanceof Error ? err.message : '清除失败')
    } finally {
      setPending(false)
    }
  }

  const canClear =
    modal.kind === 'edit' &&
    ((profile.id === 'base' && slot !== 'default') || profile.id === 'local')
  const showPicker = modal.kind === 'add' && profile.id !== 'base'

  return (
    <div className={styles['vars-modal-backdrop']} role="presentation">
      <section
        className={styles['vars-modal']}
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
      >
        <header className={styles['vars-modal-head']}>
          <div>
            <div className={styles['vars-eyebrow']}>{dialogLabel}</div>
            <h2>{modal.kind === 'add' ? profile.name + ' · 新建配置' : key}</h2>
          </div>
          <div className={styles['vars-modal-head-actions']}>
            {!isReadonly && (
              <div className={styles['vars-agent-switch']} aria-label="配置槽位">
                <span>配置槽位</span>
                <div className="target-chips">
                  {slotOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="target-chip"
                      data-agent={option === 'default' ? 'default' : undefined}
                      data-state={slot === option ? 'on' : 'off'}
                      style={{
                        ['--c' as string]:
                          option === 'default' ? 'var(--primary)' : agentColor[option],
                      }}
                      onClick={() => setSlot(option)}
                    >
                      {slotLabel(option)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              className={styles['vars-icon-button']}
              aria-label="关闭弹窗"
              onClick={onClose}
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className={styles['vars-modal-body']}>
          <div className={cn(styles['vars-editor-column'], showPicker && styles['has-target-key'])}>
            {showPicker && (
              <section className={styles['vars-editor-card']}>
                <div className={styles['vars-eyebrow']}>目标 key</div>
                <BaseKeyPicker
                  entries={baseEntries}
                  selectedKey={selectedKey}
                  onChange={setSelectedKey}
                />
              </section>
            )}
            {profile.id === 'base' && modal.kind === 'add' && (
              <section className={styles['vars-editor-card']}>
                <label className={styles['vars-field']}>
                  <span>key</span>
                  <input
                    value={baseKeyDraft}
                    onChange={(event) => setBaseKeyDraft(event.target.value)}
                    placeholder="输入新变量 key"
                  />
                </label>
              </section>
            )}

            <section className={cn(styles['vars-editor-card'], styles['vars-modal-editor-card'])}>
              <div className={styles['vars-eyebrow']}>配置值</div>
              <div className={styles['vars-editor-tabs']}>
                {(['edit', 'raw', 'resolved'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={previewMode === mode ? styles.on : undefined}
                    onClick={() => setPreviewMode(mode)}
                  >
                    {mode === 'edit' ? '编辑' : mode === 'raw' ? '原始预览' : '解析预览'}
                  </button>
                ))}
              </div>
              {previewMode === 'edit' ? (
                <label className={cn(styles['vars-field'], styles['vars-editor-field'])}>
                  <span>
                    配置值 · {profile.name} · {slotLabel(slot)}
                  </span>
                  <textarea
                    aria-label="配置值"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="输入配置值"
                    readOnly={isReadonly}
                  />
                </label>
              ) : previewMode === 'raw' ? (
                <pre className={cn(styles['vars-preview'], styles['vars-preview-raw'])}>
                  {draft || '当前槽位还没有输入内容。'}
                </pre>
              ) : format === 'markdown' ? (
                <MarkdownPreview value={draft || resolvedValue} />
              ) : (
                <pre className={cn(styles['vars-preview'], styles['vars-preview-raw'])}>
                  {resolvedValue || '当前没有解析结果。'}
                </pre>
              )}
            </section>
          </div>

          <aside className={styles['vars-inspector-column']}>
            <section className={styles['vars-editor-card']}>
              <div className={styles['vars-eyebrow']}>元信息</div>
              <dl className={styles['vars-meta']}>
                <div>
                  <dt>profile</dt>
                  <dd>{profile.name}</dd>
                </div>
                <div>
                  <dt>slot</dt>
                  <dd>{slotLabel(slot)}</dd>
                </div>
                <div>
                  <dt>type</dt>
                  <dd>{type}</dd>
                </div>
                <div>
                  <dt>format</dt>
                  <dd>{format ?? 'plain'}</dd>
                </div>
              </dl>
            </section>
            <section className={styles['vars-editor-card']}>
              <div className={styles['vars-eyebrow']}>trace</div>
              <div className={styles['vars-trace']} aria-label="变量追溯">
                {trace.length || dependencies.length ? (
                  <>
                    {trace.map((ref, index) => {
                      const [profileLabel, slotName] = traceLabel(ref)
                      return (
                        <div className={styles['vars-trace-row']} key={index}>
                          <span>{profileLabel}</span>
                          <span>{slotName}</span>
                        </div>
                      )
                    })}
                    {dependencies.map((dependency) => (
                      <div className={styles['vars-trace-row']} key={dependency}>
                        <span>{dependency}</span>
                        <span>dependency</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <span className={styles['vars-slot-dash']}>无已配置 trace</span>
                )}
              </div>
            </section>
            {diagnostics.length > 0 && (
              <section className={styles['vars-editor-card']} role="alert">
                <div className={styles['vars-eyebrow']}>diagnostics</div>
                {diagnostics.map((diagnostic) => (
                  <p key={diagnostic.code + diagnostic.message}>{diagnosticText(diagnostic)}</p>
                ))}
              </section>
            )}
          </aside>
        </div>

        <footer className={styles['vars-modal-footer']}>
          <button type="button" className={styles['vars-ghost-action']} onClick={onClose}>
            取消
          </button>
          {canClear && (
            <button
              type="button"
              className={cn(styles['vars-ghost-action'], styles['vars-danger-action'])}
              onClick={clearConfig}
            >
              清除配置
            </button>
          )}
          {!isReadonly && (
            <button type="button" className={styles['vars-primary-action']} onClick={save}>
              <CheckCircle2 size={14} />
              保存
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
