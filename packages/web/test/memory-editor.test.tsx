// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MemoryEditor from '../src/components/MemoryEditor'
import { ApiError, api } from '../src/lib/api'

const editorMocks = vi.hoisted(() => ({
  richProps: [] as any[],
  monacoProps: [] as any[],
  monacoProvider: null as any,
  monacoDisposeCallbacks: [] as Array<() => void>,
  monacoSetTheme: vi.fn(),
  providerDispose: vi.fn(),
}))

function monacoLineModel(line: string) {
  return {
    getValueInRange: ({ startColumn, endColumn }: { startColumn: number; endColumn: number }) =>
      line.slice(startColumn - 1, endColumn - 1),
  }
}

function renderedMarkdown(markdown: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)
  const hasTable = /^\|.+\|\n\|[-:\s|]+\|/m.test(markdown)
  return (
    <>
      {heading && <h1>{heading[1]}</h1>}
      {hasTable && (
        <table>
          <tbody>
            <tr>
              <td>场景</td>
              <td>规则</td>
            </tr>
          </tbody>
        </table>
      )}
      {!heading && !hasTable && <p>{markdown}</p>}
    </>
  )
}

vi.mock('@mdxeditor/editor', () => {
  const plugin = () => ({})
  return {
    MDXEditor: forwardRef((props: any, ref) => {
      useImperativeHandle(ref, () => ({
        focus: vi.fn(),
        getMarkdown: () => props.markdown,
        insertMarkdown: vi.fn(),
        setMarkdown: vi.fn(),
      }))
      editorMocks.richProps.push(props)
      return (
        <section
          data-testid="memory-rich-mdx-editor"
          className={props.contentEditableClassName}
          aria-label="Memory 内容"
        >
          {renderedMarkdown(props.markdown)}
          <button type="button" onClick={() => props.onChange('# Edited directly\n\nBody copy')}>
            mock rich change
          </button>
        </section>
      )
    }),
    headingsPlugin: plugin,
    listsPlugin: plugin,
    quotePlugin: plugin,
    thematicBreakPlugin: plugin,
    tablePlugin: plugin,
    markdownShortcutPlugin: plugin,
    codeBlockPlugin: plugin,
    codeMirrorPlugin: plugin,
  }
})

vi.mock('@monaco-editor/react', () => ({
  default: (props: any) => {
    editorMocks.monacoProps.push(props)
    const monaco = {
      editor: {
        defineTheme: vi.fn(),
        setTheme: editorMocks.monacoSetTheme,
      },
      languages: {
        CompletionItemKind: { Variable: 17 },
        registerCompletionItemProvider: vi.fn((_language: string, provider: any) => {
          editorMocks.monacoProvider = provider
          return { dispose: editorMocks.providerDispose }
        }),
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
    props.beforeMount?.(monaco)
    props.onMount?.(
      {
        getValue: () => props.value,
        onDidDispose: (callback: () => void) => {
          editorMocks.monacoDisposeCallbacks.push(callback)
          return { dispose: vi.fn() }
        },
      },
      monaco,
    )
    return (
      <textarea
        data-testid="memory-source-monaco"
        aria-label="Memory 内容"
        value={props.value}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
      />
    )
  },
}))

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')
  return {
    ...actual,
    api: {
      previewMemory: vi.fn(),
      vars: {
        getMatrix: vi.fn(async () => ({
          ok: true,
          agent: 'codex',
          builtinKeys: ['LOOM_REPO'],
          userKeys: ['API_URL', 'PORT'],
          snapshot: { base: {}, baseAgent: {}, local: {}, localAgent: {} },
          resolution: {
            ok: true,
            values: {},
            sources: {},
            overrideChains: {},
            dependencies: {},
            diagnostics: [],
          },
        })),
      },
    },
  }
})

describe('MemoryEditor', () => {
  beforeEach(() => {
    editorMocks.richProps = []
    editorMocks.monacoProps = []
    editorMocks.monacoProvider = null
    editorMocks.monacoDisposeCallbacks = []
    editorMocks.monacoSetTheme.mockClear()
    editorMocks.providerDispose.mockClear()
    document.documentElement.setAttribute('data-theme', 'light')
    vi.clearAllMocks()
  })

  it('uses MDXEditor as a read-only raw preview and Monaco for source editing', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const content = '| 场景 | 规则 |\n|---|---|\n| Memory | 使用 rich editor |'
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content={content}
        targets={['codex']}
        onSave={onSave}
      />,
    )

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '所见编辑',
      '源码',
      '解析预览',
    ])
    expect(screen.getByRole('tab', { name: '所见编辑' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('memory-rich-mdx-editor')).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()
    expect(editorMocks.richProps.at(-1).readOnly).toBe(true)
    expect(screen.queryByRole('listbox', { name: '变量引用建议' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'mock rich change' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    const source = screen.getByTestId('memory-source-monaco') as HTMLTextAreaElement
    expect(source.value).toBe(content)
    fireEvent.change(source, { target: { value: '## Source edit' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('## Source edit'))
  })

  it('registers Monaco variable completion with disposable provider', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content=""
        targets={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
    expect(editorMocks.monacoProvider).toBeTruthy()

    const result = editorMocks.monacoProvider.provideCompletionItems(monacoLineModel('$' + '{AP'), {
      lineNumber: 1,
      column: 5,
    })
    expect(result.suggestions[0]).toMatchObject({
      label: 'API_URL',
      insertText: '$' + '{API_URL}',
      filterText: '$' + '{AP',
    })
    expect(result.suggestions[0].range.startColumn).toBe(1)
    expect(result.suggestions[0].range.endColumn).toBe(5)

    const autoClosed = editorMocks.monacoProvider.provideCompletionItems(
      monacoLineModel('$' + '{AP}'),
      { lineNumber: 1, column: 5 },
    )
    expect(autoClosed.suggestions[0]).toMatchObject({
      label: 'API_URL',
      insertText: '$' + '{API_URL}',
      filterText: '$' + '{AP',
    })
    expect(autoClosed.suggestions[0].range.startColumn).toBe(1)
    expect(autoClosed.suggestions[0].range.endColumn).toBe(6)

    expect(editorMocks.monacoDisposeCallbacks.length).toBeGreaterThan(0)
    editorMocks.providerDispose.mockClear()
    editorMocks.monacoDisposeCallbacks.at(-1)?.()
    expect(editorMocks.providerDispose).toHaveBeenCalledTimes(1)
  })

  it('keeps Monaco source editor on the built-in theme that matches the current UI', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')

    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content=""
        targets={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '源码' }))
    await waitFor(() => expect(editorMocks.monacoSetTheme).toHaveBeenCalledWith('vs-dark'))

    document.documentElement.setAttribute('data-theme', 'light')
    await waitFor(() => expect(editorMocks.monacoSetTheme).toHaveBeenCalledWith('vs'))
  })

  it('keeps rich preview usable with rich variable completion disabled', async () => {
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="# Preview first"
        targets={['codex']}
        onSave={async () => {}}
        enableRichVarsCompletion={false}
      />,
    )

    expect(screen.getByTestId('memory-rich-mdx-editor')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Preview first' })).toBeTruthy()
    expect(editorMocks.richProps.at(-1).readOnly).toBe(true)
    expect(screen.queryByRole('listbox', { name: '变量引用建议' })).toBeNull()
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
  })

  it('keeps markdown comments visible in the rich editor adapter', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="<!-- CODEGRAPH_START -->\n\nVisible notes\n\n<!-- CODEGRAPH_END -->"
        targets={['codex']}
        onSave={onSave}
      />,
    )

    expect(editorMocks.richProps.at(-1).markdown).toContain('\\<!-- CODEGRAPH_START -->')
    expect(editorMocks.richProps.at(-1).markdown).toContain('\\<!-- CODEGRAPH_END -->')
    expect(editorMocks.richProps.at(-1).suppressHtmlProcessing).toBeUndefined()
    expect(editorMocks.richProps.at(-1).readOnly).toBe(true)
    act(() => {
      editorMocks.richProps
        .at(-1)
        .onChange('\\<!-- CODEGRAPH_START -->\n\nEdited notes\n\n\\<!-- CODEGRAPH_END -->', false)
    })
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
    await waitFor(() => expect(api.vars.getMatrix).toHaveBeenCalledWith('/repo', 'codex'))
  })

  it('shows structured resolver diagnostics in the agent rendered preview', async () => {
    const missingMemory = 'Use ' + '$' + '{memory.rtk}'
    const cause = new ApiError('render failed', 400, 'render_failed', [
      {
        code: 'MISSING_REFERENCE',
        severity: 'error',
        message: '变量不存在: memory.rtk',
        key: 'memory.rtk',
        path: ['memory.rtk'],
      },
    ])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      vi.mocked(api.previewMemory).mockRejectedValue(cause)

      render(
        <MemoryEditor
          repo="/repo"
          name="default"
          content={missingMemory}
          targets={['codex']}
          onSave={async () => {}}
        />,
      )

      fireEvent.click(screen.getByRole('tab', { name: '解析预览' }))

      await waitFor(() =>
        expect(api.previewMemory).toHaveBeenCalledWith({
          repo: '/repo',
          content: missingMemory,
          agent: 'codex',
        }),
      )
      const diagnostics = await screen.findByLabelText('解析诊断')
      expect(diagnostics.textContent).toContain('MISSING_REFERENCE')
      expect(diagnostics.textContent).toContain('key=memory.rtk')
      expect(diagnostics.textContent).toContain('path=memory.rtk')
      expect(errorSpy).toHaveBeenCalledWith({ err: cause }, 'Failed to preview memory')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps markdown comments visible in the resolved preview', async () => {
    vi.mocked(api.previewMemory).mockResolvedValue({
      rendered: '<!-- CODEGRAPH_START -->\n\nResolved notes\n\n<!-- CODEGRAPH_END -->',
      diagnostics: [],
    } as never)

    render(
      <MemoryEditor
        repo="/repo"
        name="default"
        content="Memory"
        targets={['codex']}
        onSave={async () => {}}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '解析预览' }))

    const resolvedText = await screen.findByText('Resolved notes')
    const preview = resolvedText.closest('.md-preview')
    expect(preview?.textContent).toContain('<!-- CODEGRAPH_START -->')
    expect(preview?.textContent).toContain('<!-- CODEGRAPH_END -->')
  })

  it('clears the previous rendered preview when the current draft fails to resolve', async () => {
    const cause = new ApiError('render failed', 400, 'render_failed', [
      {
        code: 'MISSING_REFERENCE',
        severity: 'error',
        message: '变量不存在: missing',
        key: 'missing',
      },
    ])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      vi.mocked(api.previewMemory)
        .mockResolvedValueOnce({
          rendered: 'Rendered once',
          diagnostics: [],
        } as never)
        .mockRejectedValueOnce(cause)

      render(
        <MemoryEditor
          repo="/repo"
          name="default"
          content={'Use ' + '$' + '{ok}'}
          targets={['codex']}
          onSave={async () => {}}
        />,
      )

      fireEvent.click(screen.getByRole('tab', { name: '解析预览' }))
      expect(await screen.findByText('Rendered once')).toBeTruthy()

      fireEvent.click(screen.getByRole('tab', { name: '源码' }))
      fireEvent.change(screen.getByTestId('memory-source-monaco'), {
        target: { value: 'Use ' + '$' + '{missing}' },
      })
      fireEvent.click(screen.getByRole('tab', { name: '解析预览' }))

      await screen.findByLabelText('解析诊断')
      expect(screen.queryByText('Rendered once')).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith({ err: cause }, 'Failed to preview memory')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
