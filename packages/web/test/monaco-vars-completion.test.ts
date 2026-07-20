// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import {
  registerVarsCompletionProvider,
  varsCompletionSuggestions,
} from '../src/components/monaco/varsCompletion'

function createFakeMonaco() {
  return {
    languages: {
      CompletionItemKind: {
        Variable: 'Variable',
      },
      registerCompletionItemProvider: vi.fn((_language: string, _provider: unknown) => ({
        dispose: vi.fn(),
      })),
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
}

function fakeModel(line: string) {
  return {
    getValueInRange(range: {
      startColumn: number
      endColumn: number
      startLineNumber: number
      endLineNumber: number
    }) {
      expect(range.startLineNumber).toBe(range.endLineNumber)
      return line.slice(range.startColumn - 1, range.endColumn - 1)
    },
  }
}

describe('varsCompletionSuggestions', () => {
  it('suggests matching vars for an open placeholder', () => {
    const monaco = createFakeMonaco()

    const result = varsCompletionSuggestions(
      monaco,
      fakeModel('\${AP'),
      { lineNumber: 1, column: 5 },
      ['PORT', 'API_URL'],
    )

    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({
      label: 'API_URL',
      kind: 'Variable',
      filterText: '\${AP',
      insertText: '\${API_URL}',
      range: {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 5,
      },
    })
  })

  it('replaces an auto-closed closing brace', () => {
    const monaco = createFakeMonaco()

    const result = varsCompletionSuggestions(
      monaco,
      fakeModel('\${AP}'),
      { lineNumber: 1, column: 5 },
      ['API_URL'],
    )

    expect(result.suggestions[0]?.range).toMatchObject({
      startColumn: 1,
      endColumn: 6,
    })
  })

  it('returns no suggestions for escaped placeholders', () => {
    const monaco = createFakeMonaco()

    const result = varsCompletionSuggestions(
      monaco,
      fakeModel('\\\${AP'),
      { lineNumber: 1, column: 6 },
      ['API_URL'],
    )

    expect(result.suggestions).toEqual([])
  })
})

describe('registerVarsCompletionProvider', () => {
  it('disposes the registered Monaco provider', () => {
    const monaco = createFakeMonaco()

    const disposable = registerVarsCompletionProvider(monaco, 'markdown', () => ['API_URL'])

    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledWith(
      'markdown',
      expect.objectContaining({
        triggerCharacters: ['{'],
      }),
    )

    const provider = monaco.languages.registerCompletionItemProvider.mock.calls[0]?.[1] as {
      provideCompletionItems: (model: unknown, position: unknown) => unknown
    }

    expect(
      provider.provideCompletionItems(fakeModel('\${AP'), { lineNumber: 1, column: 5 }),
    ).toMatchObject({
      suggestions: [expect.objectContaining({ label: 'API_URL' })],
    })

    disposable.dispose()

    expect(
      monaco.languages.registerCompletionItemProvider.mock.results[0]?.value.dispose,
    ).toHaveBeenCalledTimes(1)
  })

  it('returns empty suggestions and logs when getKeys throws', () => {
    const monaco = createFakeMonaco()
    const err = new Error('keys failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      registerVarsCompletionProvider(monaco, 'markdown', () => {
        throw err
      })

      const provider = monaco.languages.registerCompletionItemProvider.mock.calls[0]?.[1] as {
        provideCompletionItems: (model: unknown, position: unknown) => unknown
      }

      expect(
        provider.provideCompletionItems(fakeModel('\${AP'), { lineNumber: 1, column: 5 }),
      ).toEqual({
        suggestions: [],
      })
      expect(consoleError).toHaveBeenCalledWith(
        { err },
        'Failed to provide Monaco variable completions',
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
