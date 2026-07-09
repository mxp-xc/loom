import { useEffect, useMemo, useRef } from 'react'
import {
  MDXEditor,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  type MDXEditorMethods,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import { cn } from '@/lib/utils'
import MemoryVarsCompletionOverlay from './MemoryVarsCompletionOverlay'
import styles from './MemoryEditor.module.css'

const variablePlaceholderPattern = /\$\{[A-Za-z_][A-Za-z0-9_.-]*\}/g
const markdownCommentPattern = /<!--[\s\S]*?-->/g
const variableHighlightName = 'memory-var'
const markdownCommentHighlightName = 'memory-markdown-comment'

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}

type HighlightConstructor = new (...ranges: Range[]) => unknown

function encodeMarkdownComments(markdown: string): string {
  let encoded = ''
  let cursor = 0
  markdownCommentPattern.lastIndex = 0

  let match = markdownCommentPattern.exec(markdown)
  while (match) {
    const index = match.index
    const comment = match[0]
    encoded += markdown.slice(cursor, index)
    encoded += index > 0 && markdown[index - 1] === '\\' ? comment : '\\' + comment
    cursor = index + comment.length
    match = markdownCommentPattern.exec(markdown)
  }

  return encoded + markdown.slice(cursor)
}

function decodeMarkdownComments(markdown: string): string {
  return markdown
    .replace(/\\(<!--[\s\S]*?-->)/g, '$1')
    .replace(/&lt;!--([\s\S]*?)--&gt;/g, '<!--$1-->')
}

function customHighlightApi(): {
  highlights: HighlightRegistry
  Highlight: HighlightConstructor
} | null {
  if (typeof CSS === 'undefined') return null
  const highlights = (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights
  const Highlight = (globalThis as typeof globalThis & { Highlight?: HighlightConstructor })
    .Highlight
  if (!highlights || !Highlight) return null
  return { highlights, Highlight }
}

function textRanges(root: HTMLElement, pattern: RegExp): Range[] {
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let textNode = walker.nextNode() as Text | null

  while (textNode) {
    const value = textNode.nodeValue ?? ''
    pattern.lastIndex = 0

    let match = pattern.exec(value)
    while (match) {
      const range = document.createRange()
      range.setStart(textNode, match.index)
      range.setEnd(textNode, match.index + match[0].length)
      ranges.push(range)
      match = pattern.exec(value)
    }

    textNode = walker.nextNode() as Text | null
  }

  return ranges
}

function updateCustomHighlights(root: HTMLElement) {
  const api = customHighlightApi()
  if (!api) return

  const editable = root.querySelector<HTMLElement>('[contenteditable]')
  if (!editable) {
    api.highlights.delete(variableHighlightName)
    api.highlights.delete(markdownCommentHighlightName)
    return
  }

  api.highlights.set(
    variableHighlightName,
    new api.Highlight(...textRanges(editable, variablePlaceholderPattern)),
  )
  api.highlights.set(
    markdownCommentHighlightName,
    new api.Highlight(...textRanges(editable, markdownCommentPattern)),
  )
}

function clearCustomHighlights() {
  const api = customHighlightApi()
  api?.highlights.delete(variableHighlightName)
  api?.highlights.delete(markdownCommentHighlightName)
}

interface Props {
  value: string
  onChange: (next: string) => void
  varsKeys: string[]
  readOnly?: boolean
  enableVarsCompletion: boolean
}

export default function MemoryRichMarkdownEditor({
  value,
  onChange,
  varsKeys,
  readOnly = false,
  enableVarsCompletion,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MDXEditorMethods>(null)
  const lastValueRef = useRef(value)
  const editorMarkdown = useMemo(() => encodeMarkdownComments(value), [value])

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      tablePlugin(),
      codeBlockPlugin(),
      codeMirrorPlugin({
        codeBlockLanguages: {
          bash: 'Bash',
          json: 'JSON',
          markdown: 'Markdown',
          text: 'Text',
          ts: 'TypeScript',
          yaml: 'YAML',
        },
      }),
      markdownShortcutPlugin(),
    ],
    [],
  )

  useEffect(() => {
    const setEditableLabel = () => {
      const editable = rootRef.current?.querySelector('[contenteditable]')
      editable?.setAttribute('aria-label', 'Memory 内容')
    }

    setEditableLabel()

    if (!rootRef.current) return
    const observer = new MutationObserver(setEditableLabel)
    observer.observe(rootRef.current, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (lastValueRef.current === value) return
    if (editorRef.current && editorRef.current.getMarkdown() !== editorMarkdown) {
      editorRef.current.setMarkdown(editorMarkdown)
    }
    lastValueRef.current = value
  }, [editorMarkdown, value])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !customHighlightApi()) return

    let frame = 0
    const requestFrame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
    const cancelFrame =
      typeof window.cancelAnimationFrame === 'function'
        ? window.cancelAnimationFrame.bind(window)
        : window.clearTimeout.bind(window)

    const refresh = () => {
      if (frame) cancelFrame(frame)
      frame = requestFrame(() => {
        frame = 0
        updateCustomHighlights(root)
      })
    }

    refresh()

    const observer = new MutationObserver(refresh)
    observer.observe(root, {
      characterData: true,
      childList: true,
      subtree: true,
    })
    root.addEventListener('input', refresh)
    root.addEventListener('keyup', refresh)

    return () => {
      if (frame) cancelFrame(frame)
      observer.disconnect()
      root.removeEventListener('input', refresh)
      root.removeEventListener('keyup', refresh)
      clearCustomHighlights()
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className={cn(
        styles['mem-edit-wrap'],
        styles['mem-compose-wrap'],
        readOnly && styles['mem-rich-readonly'],
      )}
    >
      <MDXEditor
        ref={editorRef}
        markdown={editorMarkdown}
        className={styles['mem-mdx-root']}
        contentEditableClassName={cn('md-preview', styles['mem-rendered-editor'])}
        spellCheck={false}
        readOnly={readOnly}
        plugins={plugins}
        placeholder={readOnly ? '暂无 Memory 内容。' : '直接输入 Memory 内容…'}
        onChange={(next, initialMarkdownNormalize) => {
          if (readOnly) return
          const decoded = decodeMarkdownComments(next)
          lastValueRef.current = decoded
          if (!initialMarkdownNormalize) onChange(decoded)
        }}
        onError={(err) => {
          console.error({ err }, 'Failed to parse rich memory markdown')
        }}
      />
      {!readOnly && (
        <MemoryVarsCompletionOverlay
          enabled={enableVarsCompletion}
          rootRef={rootRef}
          editorRef={editorRef}
          varsKeys={varsKeys}
          onChange={(next) => {
            const decoded = decodeMarkdownComments(next)
            lastValueRef.current = decoded
            onChange(decoded)
          }}
        />
      )}
    </div>
  )
}
