import { AlertTriangle, CornerDownRight } from 'lucide-react'
import Modal from '../../components/Modal'
import { Button } from '../../components/ui/button'
import type { DeleteImpact } from '../../lib/vars'
import { FieldError } from '../../components/ErrorFeedback'

interface Props {
  variableKey: string
  impact: DeleteImpact | null
  open: boolean
  pending: boolean
  changed: boolean
  error?: string | null
  onClose: () => void
  onConfirm: () => void
}

export default function DeleteVariableDialog({
  variableKey,
  impact,
  open,
  pending,
  changed,
  error,
  onClose,
  onConfirm,
}: Props) {
  const group = (title: string, items: DeleteImpact['direct'], direct: boolean) =>
    items.length > 0 && (
      <section className="vars-impact-group">
        <h3>
          {direct ? <AlertTriangle size={16} /> : <CornerDownRight size={16} />}
          {title}
        </h3>
        <ul>
          {items.map((item) => (
            <li key={`${item.environment}-${item.key}`}>
              {item.environment} / {item.key}
            </li>
          ))}
        </ul>
      </section>
    )
  return (
    <Modal
      open={open}
      onClose={() => !pending && onClose()}
      title={`删除变量 ${variableKey}`}
      busy={pending}
    >
      <div className="vars-delete-dialog">
        {changed && (
          <p className="vars-impact-changed" role="alert">
            依赖已变化，请重新确认
          </p>
        )}
        {error && <FieldError id="delete-variable-error">{error}</FieldError>}
        {!impact ? (
          <p role="status">正在检查删除影响…</p>
        ) : (
          <>
            <p>
              {impact.direct.length + impact.transitive.length > 0
                ? '删除后以下变量会出现缺失引用。'
                : '没有发现依赖此变量的配置。此操作无法撤销。'}
            </p>
            {group('直接依赖', impact.direct, true)}
            {group('间接依赖', impact.transitive, false)}
          </>
        )}
        <div className="vars-form-actions">
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            data-autofocus
            type="button"
            variant="destructive"
            disabled={pending || !impact}
            onClick={onConfirm}
          >
            {pending ? '正在删除…' : '确认删除'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
