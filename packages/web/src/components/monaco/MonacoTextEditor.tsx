import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import Editor from '@monaco-editor/react'
import { monacoThemeName, useMonacoUiTheme } from './theme.js'
import { ErrorState } from '../ErrorFeedback'

interface Disposable {
  dispose: () => void
}

export interface MonacoTextEditorProps {
  value: string
  onChange: (next: string) => void
  language?: string
  ariaLabel: string
  ariaDescribedBy?: string
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
  return <ErrorState title="编辑器加载失败" message="请刷新页面后重试" />
}

export default function MonacoTextEditor({
  value,
  onChange,
  language = 'plaintext',
  ariaLabel,
  ariaDescribedBy,
  height = '100%',
  readOnly = false,
  className,
  options,
  onEditorMount,
}: MonacoTextEditorProps): JSX.Element {
  const uiTheme = useMonacoUiTheme()
  const [mountFailed, setMountFailed] = useState(false)
  const editorRef = useRef<any>(null)

  const syncErrorDescription = useCallback(
    (editor: any) => {
      const domNode = editor?.getDomNode?.() as HTMLElement | null | undefined
      const editable = domNode?.matches('textarea')
        ? domNode
        : domNode?.querySelector<HTMLElement>('textarea')
      if (ariaDescribedBy) editable?.setAttribute('aria-describedby', ariaDescribedBy)
      else editable?.removeAttribute('aria-describedby')
    },
    [ariaDescribedBy],
  )

  useEffect(() => {
    syncErrorDescription(editorRef.current)
  }, [syncErrorDescription])

  const handleMount = useCallback(
    (editor: any, monaco: any) => {
      try {
        editorRef.current = editor
        const domNode = editor.getDomNode?.() as HTMLElement | null | undefined
        domNode?.setAttribute('aria-label', ariaLabel)
        syncErrorDescription(editor)

        const disposable = onEditorMount?.(editor, monaco)
        if (disposable) {
          editor.onDidDispose?.(() => disposable.dispose())
        }
      } catch (err) {
        console.error({ err }, 'Failed to mount Monaco editor')
        setMountFailed(true)
      }
    },
    [ariaLabel, onEditorMount, syncErrorDescription],
  )

  if (mountFailed) return <MonacoErrorFallback />

  return (
    <MonacoRenderErrorBoundary fallback={<MonacoErrorFallback />}>
      <Editor
        className={className}
        wrapperProps={ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : undefined}
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
