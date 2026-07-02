import { useState, useCallback } from 'react'

// Toast state + helper. Auto-dismiss is handled by the <Toast> component itself
// (its onClose timer), so showToast only sets the message; dismiss clears it.
export function useToast() {
  const [toast, setToast] = useState<string | null>(null)
  const showToast = useCallback((msg: string) => setToast(msg), [])
  const dismiss = useCallback(() => setToast(null), [])
  return { toast, showToast, dismiss }
}
