import { Button } from '@/components/ui/button'

const mono = "'JetBrains Mono', monospace"

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <Button
            key={o.value}
            variant="ghost"
            size="sm"
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              border: '1px solid var(--border)',
              background: active ? 'var(--bg)' : 'transparent',
              color: active ? 'var(--bright)' : 'var(--muted)',
              fontFamily: mono,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {o.label}
          </Button>
        )
      })}
    </div>
  )
}
