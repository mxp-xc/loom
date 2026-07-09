import { useCallback, useEffect, useRef } from 'react'
import styles from './MemoryEditor.module.css'
import MonacoTextEditor from './monaco/MonacoTextEditor.js'
import { registerVarsCompletionProvider } from './monaco/varsCompletion.js'

interface Props {
  value: string
  onChange: (next: string) => void
  varsKeys: string[]
}

export default function MemorySourceMarkdownEditor({ value, onChange, varsKeys }: Props) {
  const varsKeysRef = useRef(varsKeys)

  useEffect(() => {
    varsKeysRef.current = varsKeys
  }, [varsKeys])

  const onEditorMount = useCallback(
    (_editor: any, monaco: any) =>
      registerVarsCompletionProvider(monaco, 'markdown', () => varsKeysRef.current),
    [],
  )

  return (
    <div className={styles['mem-source-editor']}>
      <MonacoTextEditor
        ariaLabel="Memory 内容"
        height="100%"
        language="markdown"
        value={value}
        onChange={onChange}
        onEditorMount={onEditorMount}
        options={{
          lineNumbers: 'on',
          padding: { top: 14, bottom: 14 },
          renderWhitespace: 'selection',
        }}
      />
    </div>
  )
}
