import { useEffect, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import type { PreparedSkillReconciliation } from '@/hooks/useManifestOperations'
import styles from './SkillReconciliationDialog.module.css'

interface Props {
  state: PreparedSkillReconciliation | null
  busy: boolean
  error?: string | null
  onClose: () => void
  onConfirm: (
    preserve: string[],
    resourceBoundaryDecisions: Array<{ entry: string; action: 'enable' | 'exclude' }>,
  ) => Promise<void>
}

export default function SkillReconciliationDialog({
  state,
  busy,
  error,
  onClose,
  onConfirm,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [enabledBoundaries, setEnabledBoundaries] = useState<Set<string>>(new Set())

  useEffect(() => {
    setSelected(new Set(state?.changes.removed.map(({ name }) => name) ?? []))
    setEnabledBoundaries(new Set())
  }, [state?.sessionId])

  if (!state) return null
  const removedNames = state.changes.removed.map(({ name }) => name)
  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  const boundaryDecisions = state.resourceBoundaryChanges.map(({ entry }) => ({
    entry,
    action: enabledBoundaries.has(entry) ? ('enable' as const) : ('exclude' as const),
  }))

  return (
    <Modal open title="确认 skills 更新" width={620} busy={busy} onClose={onClose}>
      <div className={styles.summary}>
        <ChangeSection title="新增" names={state.changes.added.map(({ name }) => name)} />
        <ChangeSection title="更新" names={state.changes.updated.map(({ name }) => name)} />
        {(state.pathMoves?.length ?? 0) > 0 && (
          <section className={styles.section}>
            <div className={styles.heading}>
              <strong>投影路径变化</strong>
              <span>{state.pathMoves!.length}</span>
            </div>
            <div className={styles.list}>
              {state.pathMoves!.map((move) => (
                <div key={`${move.agent}:${move.kind}:${move.sourcePath}`} className={styles.row}>
                  <span>{move.agent}</span>
                  <code>
                    {move.previousTargetPath ?? 'new'} → {move.nextTargetPath ?? 'removed'}
                  </code>
                </div>
              ))}
            </div>
          </section>
        )}
        {state.resourceBoundaryChanges.length > 0 && (
          <section className={styles.section}>
            <div className={styles.heading}>
              <strong>新增 SkillBundle 边界</strong>
              <span>{state.resourceBoundaryChanges.length}</span>
            </div>
            <p className={styles.hint}>选择要立即启用的 bundle；未选择项不再作为普通资源投影。</p>
            <div className={styles.list}>
              {state.resourceBoundaryChanges.map((change) => (
                <label key={change.entry} className={styles.row}>
                  <input
                    type="checkbox"
                    checked={enabledBoundaries.has(change.entry)}
                    onChange={() =>
                      setEnabledBoundaries((current) => {
                        const next = new Set(current)
                        if (next.has(change.entry)) next.delete(change.entry)
                        else next.add(change.entry)
                        return next
                      })
                    }
                    aria-label={`启用 ${change.name}`}
                  />
                  <span>{change.name}</span>
                  <code>{change.path}</code>
                </label>
              ))}
            </div>
          </section>
        )}
        <section className={styles.section}>
          <div className={styles.heading}>
            <h3>删除</h3>
            <span>{removedNames.length}</span>
          </div>
          {removedNames.length === 0 ? (
            <p className={styles.hint}>无变化</p>
          ) : (
            <>
              <p className={styles.hint}>已默认保留为 local skill；取消勾选的项目将被删除。</p>
              <div className={styles.tools}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSelected(new Set(removedNames))}
                >
                  全选
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>
                  取消全选
                </Button>
              </div>
              <div className={styles.list}>
                {removedNames.map((name) => (
                  <label key={name} className={styles.row}>
                    <input
                      type="checkbox"
                      checked={selected.has(name)}
                      onChange={() => toggle(name)}
                      aria-label={`保留 ${name}`}
                    />
                    <span>{name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {removedNames.length > 0 && (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void onConfirm([], boundaryDecisions)}
          >
            不保留
          </Button>
        )}
        <Button disabled={busy} onClick={() => void onConfirm([...selected], boundaryDecisions)}>
          {busy ? '处理中…' : removedNames.length > 0 ? '保留所选并继续' : '应用更新'}
        </Button>
      </div>
    </Modal>
  )
}

function ChangeSection({ title, names }: { title: string; names: string[] }) {
  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <h3>{title}</h3>
        <span>{names.length}</span>
      </div>
      <div className={styles.names}>{names.length > 0 ? names.join(', ') : '无变化'}</div>
    </section>
  )
}
