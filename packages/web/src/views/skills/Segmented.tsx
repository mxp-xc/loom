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
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              border: '1px solid',
              borderColor: active
                ? 'color-mix(in srgb, var(--primary) 72%, var(--border))'
                : 'var(--border)',
              background: active
                ? 'color-mix(in srgb, var(--primary) 16%, var(--card))'
                : 'transparent',
              color: active ? 'var(--primary)' : 'var(--muted)',
              boxShadow: active
                ? 'inset 0 0 0 1px color-mix(in srgb, var(--primary) 22%, transparent)'
                : 'none',
              fontFamily: mono,
              fontSize: 12,
              fontWeight: active ? 600 : 500,
            }}
          >
            {o.label}
          </Button>
        )
      })}
    </div>
  )
}
