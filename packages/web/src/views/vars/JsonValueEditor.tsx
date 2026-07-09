import { Button } from '../../components/ui/button.js'
import VarsMonacoValueEditor from './VarsMonacoValueEditor.js'

interface Props {
  value: string
  onChange: (value: string) => void
  error: string | null
  onError: (error: string | null) => void
  disabled?: boolean
}

export default function JsonValueEditor({ value, onChange, error, onError, disabled }: Props) {
  const format = () => {
    try {
      const next = JSON.stringify(JSON.parse(value), null, 2)
      onChange(next)
      onError(null)
    } catch (cause) {
      console.error({ err: cause }, 'JSON format failed')
      onError(cause instanceof Error ? `JSON 语法错误：${cause.message}` : 'JSON 语法错误')
    }
  }
  return (
    <div className="vars-json-editor">
      <div className="vars-json-toolbar">
        <span>JSON</span>
        <Button type="button" size="xs" variant="secondary" disabled={disabled} onClick={format}>
          格式化 JSON
        </Button>
      </div>
      <VarsMonacoValueEditor
        ariaLabel="JSON 值"
        disabled={disabled}
        error={error}
        type="json"
        value={value}
        onChange={onChange}
        onError={onError}
      />
    </div>
  )
}
