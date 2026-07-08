import Toast from './Toast'
import { useToast } from '@/hooks/useToast'

export default function ToastHost() {
  const { toast, dismiss } = useToast()
  return toast ? <Toast message={toast} onClose={dismiss} /> : null
}
