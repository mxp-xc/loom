import { Eye, EyeOff } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { VarsResolution } from '../../lib/vars'

const MASK = '••••••••'

interface Props {
  value: string
  secret: boolean
  resolution: VarsResolution | null
  onChange: (value: string) => void
  onReveal?: () => Promise<string>
  maskedPlaceholder?: boolean
  disabled?: boolean
}

export default function StringValueEditor({
  value,
  secret,
  resolution,
  onChange,
  onReveal,
  maskedPlaceholder,
  disabled,
}: Props) {
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const [revealed, setRevealed] = useState(false)
  const [active, setActive] = useState(0)
  const [cursor, setCursor] = useState(value.length)
  const [dismissed, setDismissed] = useState(false)
  const tokenMatch = value.slice(0, cursor).match(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)?$/)
  const query = tokenMatch?.[1]?.toLowerCase() ?? ''
  const suggestions = useMemo(() => {
    if (!tokenMatch || !resolution || dismissed) return []
    return Object.entries(resolution.values)
      .filter(([key]) => key.toLowerCase().includes(query))
      .map(([key, entry]) => ({ key, entry, source: resolution.sources[key] ?? '未知来源' }))
  }, [dismissed, query, resolution, tokenMatch?.[0]])

  const insert = (key: string) => {
    if (!tokenMatch) return
    const end = inputRef.current?.selectionStart ?? value.length
    const start = end - tokenMatch[0].length
    const next = `${value.slice(0, start)}\${${key}}${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => {
      const position = start + key.length + 3
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(position, position)
    })
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) =>
        event.key === 'ArrowDown'
          ? (current + 1) % suggestions.length
          : (current - 1 + suggestions.length) % suggestions.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      insert(suggestions[active]?.key ?? suggestions[0].key)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
    }
  }

  const shared = {
    ref: inputRef as never,
    id: 'vars-value',
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setActive(0)
      setCursor(event.target.value.length)
      setDismissed(false)
      onChange(event.target.value)
    },
    onKeyDown: keyDown,
    onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length),
    autoComplete: 'off',
    disabled,
    role: 'combobox',
    'aria-autocomplete': 'list' as const,
    'aria-expanded': suggestions.length > 0,
    'aria-controls': suggestions.length > 0 ? listboxId : undefined,
    'aria-activedescendant': suggestions.length > 0 ? `${listboxId}-${active}` : undefined,
  }

  return (
    <div className="vars-string-editor">
      <div className="vars-value-control">
        {secret ? (
          <input
            {...shared}
            placeholder={maskedPlaceholder ? MASK : undefined}
            type={revealed ? 'text' : 'password'}
          />
        ) : (
          <textarea {...shared} rows={4} />
        )}
        {secret && (
          <button
            type="button"
            className="vars-reveal"
            aria-label={revealed ? '隐藏密钥' : '显示密钥'}
            aria-pressed={revealed}
            disabled={disabled}
            onClick={() => {
              if (revealed) setRevealed(false)
              else if (onReveal) {
                void onReveal().then(
                  () => setRevealed(true),
                  () => undefined,
                )
              } else setRevealed(true)
            }}
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div id={listboxId} className="vars-completions" role="listbox" aria-label="变量引用建议">
          {suggestions.map(({ key, entry, source }, index) => (
            <button
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={active === index}
              key={key}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(key)}
            >
              <span>
                <strong>{key}</strong>
                <small>
                  {entry.type} · {source}
                </small>
              </span>
              <code>{'masked' in entry && entry.masked ? MASK : String(entry.value)}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
