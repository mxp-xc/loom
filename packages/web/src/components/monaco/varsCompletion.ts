import { completionAt, filterCompletionKeys, placeholderForKey } from '../memoryCompletion.js'

interface Position {
  lineNumber: number
  column: number
}

interface Range {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

interface Model {
  getValueInRange: (range: Range) => string
}

interface CompletionItem {
  label: string
  kind: unknown
  filterText: string
  insertText: string
  range: Range
}

interface MonacoLike {
  languages: {
    CompletionItemKind: {
      Variable: unknown
    }
    registerCompletionItemProvider: (
      language: string,
      provider: {
        triggerCharacters: string[]
        provideCompletionItems: (
          model: Model,
          position: Position,
        ) => { suggestions: CompletionItem[] }
      },
    ) => { dispose: () => void }
  }
  Range: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) => Range
}

export function varsCompletionSuggestions(
  monaco: MonacoLike,
  model: Model,
  position: Position,
  keys: string[],
): { suggestions: CompletionItem[] } {
  const linePrefix = model.getValueInRange(
    new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column),
  )
  const completion = completionAt(linePrefix, linePrefix.length)
  if (!completion) return { suggestions: [] }

  let endColumn = position.column
  const nextCharacter = model.getValueInRange(
    new monaco.Range(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column + 1,
    ),
  )
  if (nextCharacter === '}' && !completion.token.endsWith('}')) {
    endColumn += 1
  }

  const range = new monaco.Range(
    position.lineNumber,
    completion.start + 1,
    position.lineNumber,
    endColumn,
  )

  return {
    suggestions: filterCompletionKeys(keys, completion.query).map((key) => ({
      label: key,
      kind: monaco.languages.CompletionItemKind.Variable,
      filterText: completion.token,
      insertText: placeholderForKey(key),
      range,
    })),
  }
}

export function registerVarsCompletionProvider(
  monaco: MonacoLike,
  language: string,
  getKeys: () => string[],
): { dispose: () => void } {
  return monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['{'],
    provideCompletionItems: (model, position) => {
      try {
        return varsCompletionSuggestions(monaco, model, position, getKeys())
      } catch (err) {
        console.error({ err }, 'Failed to provide Monaco variable completions')
        return { suggestions: [] }
      }
    },
  })
}
