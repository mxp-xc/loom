import { useCallback, useEffect, useRef } from 'react'
import MonacoTextEditor from '../../components/monaco/MonacoTextEditor.js'
import { languageForVarValue } from '../../components/monaco/languages.js'
import { registerVarsCompletionProvider } from '../../components/monaco/varsCompletion.js'
import type { StringFormat, VarEntryInput, VarsResolution } from '../../lib/vars.js'

type VarsResolutionLike =
  | VarsResolution
  | {
      ok: true
      values: Record<string, unknown>
    }
  | {
      values: Record<string, unknown>
    }
  | { ok: false }
  | null
  | undefined

interface VarsMonacoValueEditorProps {
  value: string
  onChange: (value: string) => void
  type: VarEntryInput['type']
  format?: StringFormat | null
  disabled?: boolean
  ariaLabel: string
  varsKeys?: string[]
  error?: string | null
  onError?: (error: string | null) => void
  height?: string | number
}

export function keysFromVarsResolution(resolution: VarsResolutionLike): string[] {
  if (!resolution || ('ok' in resolution && resolution.ok === false)) return []
  if (!('values' in resolution)) return []
  return Array.from(new Set(Object.keys(resolution.values))).sort((left, right) =>
    left.localeCompare(right),
  )
}

export default function VarsMonacoValueEditor({
  value,
  onChange,
  type,
  format,
  disabled,
  ariaLabel,
  varsKeys = [],
  error,
  onError,
  height = '190px',
}: VarsMonacoValueEditorProps): JSX.Element {
  const language = languageForVarValue(type, format)
  const varsKeysRef = useRef(varsKeys)

  useEffect(() => {
    varsKeysRef.current = varsKeys
  }, [varsKeys])

  const handleEditorMount = useCallback(
    (_editor: unknown, monaco: unknown) => {
      return registerVarsCompletionProvider(monaco as never, language, () => varsKeysRef.current)
    },
    [language],
  )

  return (
    <>
      <MonacoTextEditor
        key={language}
        ariaLabel={ariaLabel}
        height={height}
        language={language}
        readOnly={disabled}
        value={value}
        onChange={(next) => {
          onChange(next)
          if (error) onError?.(null)
        }}
        onEditorMount={handleEditorMount}
      />
      {error && (
        <p className="vars-field-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
