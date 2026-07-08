import { useCallback, useSyncExternalStore } from 'react'

type Listener = () => void

let currentToast: string | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return currentToast
}

export function showToast(message: string) {
  currentToast = message
  emit()
}

export function dismissToast() {
  currentToast = null
  emit()
}

export function useToast() {
  const toast = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const show = useCallback((message: string) => showToast(message), [])
  const dismiss = useCallback(() => dismissToast(), [])

  return { toast, showToast: show, dismiss }
}
