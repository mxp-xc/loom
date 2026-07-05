import CodeMirror from '@uiw/react-codemirror'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { lintGutter, linter } from '@codemirror/lint'
import { useState } from 'react'
import { Button } from '../../components/ui/button'

interface Props {
  value: string
  onChange: (value: string) => void
  error: string | null
  onError: (error: string | null) => void
  disabled?: boolean
}

export default function JsonValueEditor({ value, onChange, error, onError, disabled }: Props) {
  const [editorView, setEditorView] = useState<import('@codemirror/view').EditorView | null>(null)
  const format = () => {
    try {
      const next = JSON.stringify(JSON.parse(value), null, 2)
      onChange(next)
      onError(null)
    } catch (cause) {
      console.error('JSON format failed', { cause })
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
      <CodeMirror
        value={value}
        editable={!disabled}
        height="190px"
        extensions={[json(), linter(jsonParseLinter()), lintGutter()]}
        basicSetup={{
          foldGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
        }}
        onCreateEditor={(view) => {
          view.contentDOM.setAttribute('aria-label', 'JSON 值')
          setEditorView(view)
        }}
        onChange={(next) => {
          onChange(next)
          if (error) onError(null)
        }}
      />
      {editorView && <span className="vars-sr-only">{editorView.state.doc.lines} 行</span>}
      {error && (
        <p className="vars-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
