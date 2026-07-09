import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import type { VarsResolution } from '../../lib/vars.js'
import VarsMonacoValueEditor, { keysFromVarsResolution } from './VarsMonacoValueEditor.js'

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
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="vars-string-editor">
      <div className="vars-value-control">
        {secret ? (
          <input
            id="vars-value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoComplete="off"
            disabled={disabled}
            placeholder={maskedPlaceholder ? MASK : undefined}
            type={revealed ? 'text' : 'password'}
          />
        ) : (
          <VarsMonacoValueEditor
            ariaLabel="值"
            disabled={disabled}
            format="plain"
            type="string"
            value={value}
            varsKeys={keysFromVarsResolution(resolution)}
            onChange={onChange}
          />
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
    </div>
  )
}
