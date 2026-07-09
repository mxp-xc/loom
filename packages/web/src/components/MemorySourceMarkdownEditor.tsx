import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { completionAt, filterCompletionKeys, placeholderForKey } from './memoryCompletion'
import styles from './MemoryEditor.module.css'

interface Props {
  value: string
  onChange: (next: string) => void
  varsKeys: string[]
}

interface Disposable {
  dispose: () => void
}

type UiTheme = 'dark' | 'light'

function readUiTheme(): UiTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function monacoThemeName(theme: UiTheme) {
  return theme === 'dark' ? 'vs-dark' : 'vs'
}

export default function MemorySourceMarkdownEditor({ value, onChange, varsKeys }: Props) {
  const varsKeysRef = useRef(varsKeys)
  const monacoRef = useRef<any>(null)
  const providerRef = useRef<Disposable | null>(null)
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => readUiTheme())

  useEffect(() => {
    varsKeysRef.current = varsKeys
  }, [varsKeys])

  useEffect(() => {
    const syncUiTheme = () => setUiTheme(readUiTheme())
    syncUiTheme()

    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(syncUiTheme)
    observer.observe(document.documentElement, {
      attributeFilter: ['data-theme'],
      attributes: true,
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    monacoRef.current?.editor.setTheme(monacoThemeName(uiTheme))
  }, [uiTheme])

  const onMount = useCallback((editor: any, monaco: any) => {
    monacoRef.current = monaco
    providerRef.current?.dispose()
    const provider = monaco.languages.registerCompletionItemProvider('markdown', {
      triggerCharacters: ['{'],
      provideCompletionItems: (model: any, position: any) => {
        const linePrefix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        })
        const completion = completionAt(linePrefix, linePrefix.length)
        if (!completion) return { suggestions: [] }

        const nextCharacter = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column + 1,
        })
        const endColumn =
          nextCharacter === '}' && !completion.token.endsWith('}')
            ? position.column + 1
            : position.column
        const range = new monaco.Range(
          position.lineNumber,
          Math.max(1, position.column - completion.token.length),
          position.lineNumber,
          endColumn,
        )
        const suggestions = filterCompletionKeys(varsKeysRef.current, completion.query).map(
          (key) => ({
            label: key,
            kind: monaco.languages.CompletionItemKind.Variable,
            filterText: completion.token,
            insertText: placeholderForKey(key),
            range,
          }),
        )
        return { suggestions }
      },
    })
    providerRef.current = provider
    editor.onDidDispose?.(() => {
      if (providerRef.current === provider) {
        provider.dispose()
        providerRef.current = null
        monacoRef.current = null
      }
    })
    monaco.editor.setTheme(monacoThemeName(readUiTheme()))
  }, [])

  return (
    <div className={styles['mem-source-editor']}>
      <Editor
        height="100%"
        language="markdown"
        theme={monacoThemeName(uiTheme)}
        value={value}
        onMount={onMount}
        onChange={(next) => onChange(next ?? '')}
        options={{
          automaticLayout: true,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12.5,
          lineHeight: 22,
          lineNumbers: 'on',
          minimap: { enabled: false },
          padding: { top: 14, bottom: 14 },
          renderWhitespace: 'selection',
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'on',
        }}
      />
    </div>
  )
}
