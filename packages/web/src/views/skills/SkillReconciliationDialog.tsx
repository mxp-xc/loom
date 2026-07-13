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
  onConfirm: (preserve: string[]) => Promise<void>
}

export default function SkillReconciliationDialog({
  state,
  busy,
  error,
  onClose,
  onConfirm,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    setSelected(new Set(state?.changes.removed.map(({ name }) => name) ?? []))
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

  return (
    <Modal open title="确认 skills 更新" width={620} busy={busy} onClose={onClose}>
      <div className={styles.summary}>
        <ChangeSection title="新增" names={state.changes.added.map(({ name }) => name)} />
        <ChangeSection title="更新" names={state.changes.updated.map(({ name }) => name)} />
        {removedNames.length > 0 && (
          <section className={styles.section}>
            <div className={styles.heading}>
              <strong>远端已删除</strong>
              <span>{removedNames.length}</span>
            </div>
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
          </section>
        )}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {removedNames.length > 0 && (
          <Button variant="destructive" disabled={busy} onClick={() => void onConfirm([])}>
            不保留
          </Button>
        )}
        <Button disabled={busy} onClick={() => void onConfirm([...selected])}>
          {busy ? '处理中…' : removedNames.length > 0 ? '保留所选并继续' : '应用更新'}
        </Button>
      </div>
    </Modal>
  )
}

function ChangeSection({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <strong>{title}</strong>
        <span>{names.length}</span>
      </div>
      <div className={styles.names}>{names.join(', ')}</div>
    </section>
  )
}
