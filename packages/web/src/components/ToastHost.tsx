import Toast from './Toast'
import { useToast } from '@/hooks/useToast'

export default function ToastHost() {
  const { toasts, dismiss } = useToast()
  if (toasts.length === 0) return null
  return (
    <div className="app-toast-host" aria-label="通知">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}
