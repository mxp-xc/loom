import { useEffect, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { vi } from 'vitest'

interface MonacoEditorMockProps {
  value?: string
  onChange?: (next: string | undefined) => void
  onMount?: (editor: MonacoEditorMockEditor, monaco: MonacoEditorMockMonaco) => void
  'aria-label'?: string
  ariaLabel?: string
  [key: string]: any
}

interface MonacoEditorMockEditor {
  getDomNode: () => HTMLTextAreaElement | null
  deltaDecorations: ReturnType<typeof vi.fn>
  onDidDispose: (callback: () => void) => { dispose: () => void }
}

interface MonacoEditorMockMonaco {
  editor: {
    setTheme: ReturnType<typeof vi.fn>
  }
  languages: {
    registerCompletionItemProvider: ReturnType<typeof vi.fn>
    CompletionItemKind: {
      Variable: string
    }
  }
  Range: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) => {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
}

export interface MonacoEditorMockController {
  props: MonacoEditorMockProps[]
  providers: any[]
  setTheme: ReturnType<typeof vi.fn>
  deltaDecorations: ReturnType<typeof vi.fn>
  disposeCallbacks: Array<() => void>
  disposeLast: () => void
  reset: () => void
  module: () => { default: (props: MonacoEditorMockProps) => JSX.Element }
}

let sharedController: MonacoEditorMockController | null = null

export function createMonacoEditorMock(): MonacoEditorMockController {
  if (sharedController) return sharedController

  const props: MonacoEditorMockProps[] = []
  const providers: any[] = []
  const disposeCallbacks: Array<() => void> = []
  const setTheme = vi.fn()
  const deltaDecorations = vi.fn((_oldIds: string[], decorations: unknown[]) =>
    decorations.map((_decoration, index) => `decoration-${index}`),
  )
  const monaco: MonacoEditorMockMonaco = {
    editor: {
      setTheme,
    },
    languages: {
      registerCompletionItemProvider: vi.fn((_language: string, provider: any) => {
        providers.push(provider)
        return { dispose: vi.fn() }
      }),
      CompletionItemKind: {
        Variable: 'Variable',
      },
    },
    Range: class {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number

      constructor(
        startLineNumber: number,
        startColumn: number,
        endLineNumber: number,
        endColumn: number,
      ) {
        this.startLineNumber = startLineNumber
        this.startColumn = startColumn
        this.endLineNumber = endLineNumber
        this.endColumn = endColumn
      }
    },
  }

  function Editor(props: MonacoEditorMockProps) {
    const ref = useRef<HTMLTextAreaElement | null>(null)
    const latestProps = useRef(props)
    latestProps.current = props

    useEffect(() => {
      const editor: MonacoEditorMockEditor = {
        getDomNode: () => ref.current,
        deltaDecorations,
        onDidDispose: (callback) => {
          disposeCallbacks.push(callback)
          return { dispose: vi.fn() }
        },
      }
      latestProps.current.onMount?.(editor, monaco)
    }, [])

    const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
      props.onChange?.(event.currentTarget.value)
    }

    return (
      <textarea
        ref={ref}
        aria-label={props.ariaLabel ?? props['aria-label']}
        readOnly={Boolean(props.options?.readOnly)}
        value={props.value ?? ''}
        onChange={handleChange}
      />
    )
  }

  sharedController = {
    props,
    providers,
    setTheme,
    deltaDecorations,
    disposeCallbacks,
    disposeLast: () => {
      for (const callback of [...disposeCallbacks]) callback()
    },
    reset: () => {
      props.length = 0
      providers.length = 0
      disposeCallbacks.length = 0
      setTheme.mockClear()
      deltaDecorations.mockClear()
      deltaDecorations.mockImplementation((_oldIds: string[], decorations: unknown[]) =>
        decorations.map((_decoration, index) => `decoration-${index}`),
      )
      monaco.languages.registerCompletionItemProvider.mockClear()
    },
    module: () => ({
      default: (editorProps: MonacoEditorMockProps) => {
        props.push(editorProps)
        return <Editor {...editorProps} />
      },
    }),
  }

  return sharedController
}
