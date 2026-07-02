import { useEffect, useState, type ReactNode } from 'react'

interface ToastProps {
  message: string
  onClose: () => void
  duration?: number
  icon?: ReactNode
}

export default function Toast({ message, onClose, duration = 3000, icon }: ToastProps) {
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (hovered) return
    const t = setTimeout(onClose, duration)
    return () => clearTimeout(t)
  }, [hovered, duration, onClose])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'fixed',
        top: 48,
        right: 24,
        zIndex: 1001,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 16px',
        borderRadius: 'var(--radius-card)',
        background: 'color-mix(in srgb, var(--popover) 85%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-popover)',
        fontFamily: "'Inter', sans-serif",
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--bright)',
        animation: 'toast-in 0.25s var(--ease)',
      }}
    >
      {icon ?? (
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--primary)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      )}
      {message}
    </div>
  )
}
