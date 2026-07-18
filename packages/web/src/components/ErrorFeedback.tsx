import { useState, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import type { AppErrorFeedback, ErrorFeedbackAction } from '@/lib/app-error'
import Modal from './Modal'
import { Button } from './ui/button'

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="app-field-error">
      <AlertCircle size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

export function ErrorDetails({ code, detail }: { code?: string; detail?: string }) {
  if (!code && !detail) return null
  return (
    <details className="app-error-details">
      <summary>技术详情</summary>
      <div>
        {code && <code>错误码: {code}</code>}
        {detail && <pre>{detail}</pre>}
      </div>
    </details>
  )
}

function ErrorActionButton({ action }: { action: ErrorFeedbackAction }) {
  const [pending, setPending] = useState(false)
  const run = async () => {
    setPending(true)
    try {
      await action.run()
    } catch (err) {
      console.error({ err }, 'Failed to run error recovery action')
    } finally {
      setPending(false)
    }
  }
  return (
    <Button type="button" variant="secondary" disabled={pending} onClick={() => void run()}>
      <RefreshCw size={14} className={pending ? 'app-error-action-spin' : undefined} />
      {pending ? '正在重试' : action.label}
    </Button>
  )
}

export function ErrorState({
  title,
  message,
  detail,
  code,
  action,
  fullscreen = false,
}: AppErrorFeedback & { fullscreen?: boolean }) {
  return (
    <section
      className="app-error-state"
      data-fullscreen={fullscreen ? 'true' : undefined}
      role="alert"
    >
      <AlertCircle size={24} aria-hidden="true" />
      <div className="app-error-state-copy">
        <strong>{title}</strong>
        <p>{message}</p>
        <ErrorDetails code={code} detail={detail} />
      </div>
      {action && <ErrorActionButton action={action} />}
    </section>
  )
}

export function WarningState({
  title,
  message,
  detail,
  code,
}: Pick<AppErrorFeedback, 'title' | 'message' | 'detail' | 'code'>) {
  return (
    <section className="app-error-state" data-tone="warning" role="status" aria-label={title}>
      <AlertTriangle size={24} aria-hidden="true" />
      <div className="app-error-state-copy">
        <strong>{title}</strong>
        <p>{message}</p>
        <ErrorDetails code={code} detail={detail} />
      </div>
    </section>
  )
}

export function ErrorDialog({
  open,
  onClose,
  feedback,
}: {
  open: boolean
  onClose: () => void
  feedback: AppErrorFeedback
}) {
  return (
    <Modal open={open} onClose={onClose} title={feedback.title}>
      <div className="app-error-dialog">
        <AlertCircle size={22} aria-hidden="true" />
        <p>{feedback.message}</p>
        <ErrorDetails code={feedback.code} detail={feedback.detail} />
        {feedback.action && <ErrorActionButton action={feedback.action} />}
      </div>
    </Modal>
  )
}
