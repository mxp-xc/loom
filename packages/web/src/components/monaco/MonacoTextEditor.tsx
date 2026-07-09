import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from 'react'
import Editor from '@monaco-editor/react'
import { monacoThemeName, useMonacoUiTheme } from './theme.js'

interface Disposable {
  dispose: () => void
}

export interface MonacoTextEditorProps {
  value: string
  onChange: (next: string) => void
  language?: string
  ariaLabel: string
  height?: string | number
  readOnly?: boolean
  className?: string
  options?: Record<string, unknown>
  onEditorMount?: (editor: any, monaco: any) => Disposable | void
}

export class MonacoRenderErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(err: unknown, _info: ErrorInfo) {
    console.error({ err }, 'Failed to render Monaco editor')
  }

  render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

function MonacoErrorFallback() {
  return (
    <div role="alert" style={{ padding: 12, color: 'var(--error)' }}>
      编辑器加载失败
    </div>
  )
}

export default function MonacoTextEditor({
  value,
  onChange,
  language = 'plaintext',
  ariaLabel,
  height = '100%',
  readOnly = false,
  className,
  options,
  onEditorMount,
}: MonacoTextEditorProps): JSX.Element {
  const uiTheme = useMonacoUiTheme()
  const [mountFailed, setMountFailed] = useState(false)

  const handleMount = useCallback(
    (editor: any, monaco: any) => {
      try {
        editor.getDomNode?.()?.setAttribute('aria-label', ariaLabel)

        const disposable = onEditorMount?.(editor, monaco)
        if (disposable) {
          editor.onDidDispose?.(() => disposable.dispose())
        }
      } catch (err) {
        console.error({ err }, 'Failed to mount Monaco editor')
        setMountFailed(true)
      }
    },
    [ariaLabel, onEditorMount],
  )

  if (mountFailed) return <MonacoErrorFallback />

  return (
    <MonacoRenderErrorBoundary fallback={<MonacoErrorFallback />}>
      <Editor
        className={className}
        height={height}
        language={language}
        theme={monacoThemeName(uiTheme)}
        value={value}
        onMount={handleMount}
        onChange={(next) => onChange(next ?? '')}
        options={{
          automaticLayout: true,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12.5,
          lineHeight: 22,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'on',
          ...options,
          ...(readOnly ? { readOnly: true, domReadOnly: true } : {}),
        }}
      />
    </MonacoRenderErrorBoundary>
  )
}
