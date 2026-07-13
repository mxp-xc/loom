import { useCallback, useSyncExternalStore } from 'react'
import {
  normalizeErrorFeedback,
  type AppErrorFeedback,
  type ErrorFeedbackFallback,
} from '@/lib/app-error'

type Listener = () => void

export type ToastItem = {
  id: string
  tone: 'success' | 'error'
  title: string
  message?: string
  feedback?: AppErrorFeedback
  count: number
  duration?: number
}

let nextId = 0
let toasts: ToastItem[] = []
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return toasts
}

export function showToast(message: string) {
  const id = `toast-${++nextId}`
  const toast: ToastItem = { id, tone: 'success', title: message, count: 1, duration: 3000 }
  toasts = [...toasts, toast].slice(-4)
  emit()
  return id
}

export function showErrorToast(error: unknown, fallback: ErrorFeedbackFallback) {
  const feedback = normalizeErrorFeedback(error, fallback)
  const duplicate = toasts.find(
    (toast) =>
      toast.tone === 'error' &&
      toast.title === feedback.title &&
      toast.message === feedback.message &&
      toast.feedback?.detail === feedback.detail,
  )
  if (duplicate) {
    toasts = toasts.map((toast) =>
      toast.id === duplicate.id ? { ...toast, count: toast.count + 1 } : toast,
    )
    emit()
    return duplicate.id
  }

  const id = `toast-${++nextId}`
  const toast: ToastItem = {
    id,
    tone: 'error',
    title: feedback.title,
    message: feedback.message,
    feedback,
    count: 1,
    duration: feedback.action ? undefined : 8000,
  }
  toasts = [...toasts, toast].slice(-4)
  emit()
  return id
}

export function dismissToast(id?: string) {
  toasts = id ? toasts.filter((toast) => toast.id !== id) : toasts.slice(1)
  emit()
}

export function clearToasts() {
  toasts = []
  emit()
}

export function useToast() {
  const toastItems = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const show = useCallback((message: string) => showToast(message), [])
  const showError = useCallback(
    (error: unknown, fallback: ErrorFeedbackFallback) => showErrorToast(error, fallback),
    [],
  )
  const dismiss = useCallback((id?: string) => dismissToast(id), [])

  return { toasts: toastItems, showToast: show, showErrorToast: showError, dismiss }
}
