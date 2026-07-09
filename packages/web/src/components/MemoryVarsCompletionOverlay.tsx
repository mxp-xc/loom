import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import {
  completionAt,
  filterCompletionKeys,
  placeholderForKey,
  type CompletionMatch,
} from './memoryCompletion'
import styles from './MemoryEditor.module.css'

interface MarkdownEditorHandle {
  focus?: (callbackFn?: () => void, opts?: { defaultSelection?: 'rootStart' | 'rootEnd' }) => void
  getMarkdown: () => string
  setMarkdown: (value: string) => void
}

interface ActiveCompletion extends CompletionMatch {
  occurrence: number
}

interface Props {
  enabled: boolean
  rootRef: RefObject<HTMLElement>
  editorRef: RefObject<MarkdownEditorHandle>
  varsKeys: string[]
  onChange: (next: string) => void
}

function textBeforeCaret(root: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return ''
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return ''

  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().replace(/\u00a0/g, ' ')
}

function countOccurrences(value: string, token: string): number {
  if (!token) return 0
  let count = 0
  let cursor = 0
  while (cursor < value.length) {
    const index = value.indexOf(token, cursor)
    if (index < 0) break
    count += 1
    cursor = index + token.length
  }
  return count
}

function nthOccurrenceIndex(value: string, token: string, occurrence: number): number {
  if (!token || occurrence <= 0) return -1
  let count = 0
  let cursor = 0
  while (cursor < value.length) {
    const index = value.indexOf(token, cursor)
    if (index < 0) return -1
    count += 1
    if (count === occurrence) return index
    cursor = index + token.length
  }
  return -1
}

export default function MemoryVarsCompletionOverlay({
  enabled,
  rootRef,
  editorRef,
  varsKeys,
  onChange,
}: Props) {
  const [active, setActive] = useState<ActiveCompletion | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const refresh = useCallback(() => {
    if (!enabled || !rootRef.current) {
      setActive(null)
      return
    }
    const before = textBeforeCaret(rootRef.current)
    const completion = completionAt(before, before.length)
    if (!completion) {
      setActive(null)
      return
    }
    setActive({ ...completion, occurrence: countOccurrences(before, completion.token) })
    setSelectedIndex(0)
  }, [enabled, rootRef])

  const suggestions = useMemo(
    () => (active ? filterCompletionKeys(varsKeys, active.query) : []),
    [active, varsKeys],
  )

  const insertCompletion = useCallback(
    (key: string) => {
      const editor = editorRef.current
      if (!active || !editor) return

      const markdown = editor.getMarkdown()
      const index = nthOccurrenceIndex(markdown, active.token, active.occurrence)
      if (index < 0) return

      const replacement = placeholderForKey(key)
      const next =
        markdown.slice(0, index) + replacement + markdown.slice(index + active.token.length)
      editor.setMarkdown(next)
      onChange(next)
      setActive(null)
      editor.focus?.(undefined, { defaultSelection: 'rootEnd' })
    },
    [active, editorRef, onChange],
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!suggestions.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((current) =>
          event.key === 'ArrowDown'
            ? (current + 1) % suggestions.length
            : (current - 1 + suggestions.length) % suggestions.length,
        )
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertCompletion(suggestions[selectedIndex] ?? suggestions[0])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setActive(null)
      }
    }

    root.addEventListener('input', refresh)
    root.addEventListener('keyup', refresh)
    root.addEventListener('mouseup', refresh)
    root.addEventListener('focusin', refresh)
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('input', refresh)
      root.removeEventListener('keyup', refresh)
      root.removeEventListener('mouseup', refresh)
      root.removeEventListener('focusin', refresh)
      root.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled, insertCompletion, refresh, rootRef, selectedIndex, suggestions])

  if (!enabled || !suggestions.length) return null

  return (
    <div className={styles['mem-completions']} role="listbox" aria-label="变量引用建议">
      {suggestions.map((key, index) => (
        <button
          key={key}
          type="button"
          role="option"
          aria-selected={selectedIndex === index}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertCompletion(key)}
        >
          <strong>{key}</strong>
        </button>
      ))}
    </div>
  )
}
