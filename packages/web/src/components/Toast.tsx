import { useEffect, useState } from 'react'
import { AlertCircle, Check, X } from 'lucide-react'
import type { ToastItem } from '@/hooks/useToast'
import { ErrorDetails } from './ErrorFeedback'
import { Button } from './ui/button'
import { IconButton } from './ui/IconButton'

export default function Toast({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const [hovered, setHovered] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (hovered || toast.duration === undefined) return
    const timer = window.setTimeout(onClose, toast.duration)
    return () => window.clearTimeout(timer)
  }, [hovered, onClose, toast.duration])

  const runAction = async () => {
    const action = toast.feedback?.action
    if (!action) return
    setPending(true)
    try {
      await action.run()
      onClose()
    } catch (err) {
      console.error({ err, toastId: toast.id }, 'Failed to run toast recovery action')
      setPending(false)
    }
  }

  return (
    <article
      className="app-toast"
      data-tone={toast.tone}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="app-toast-icon" aria-hidden="true">
        {toast.tone === 'error' ? <AlertCircle size={16} /> : <Check size={15} />}
      </span>
      <div className="app-toast-copy">
        <strong>{toast.title}</strong>
        {toast.message && <p>{toast.message}</p>}
        {toast.count > 1 && <small>发生 {toast.count} 次</small>}
        <ErrorDetails code={toast.feedback?.code} detail={toast.feedback?.detail} />
        {toast.feedback?.action && (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={pending}
            onClick={() => void runAction()}
          >
            {pending ? '正在重试' : toast.feedback.action.label}
          </Button>
        )}
      </div>
      <IconButton label={`关闭“${toast.title}”`} tooltip="关闭" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </article>
  )
}
