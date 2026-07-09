import { useState, useEffect, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import MonacoTextEditor from './monaco/MonacoTextEditor.js'

type ViewMode = 'preview' | 'source'

interface MarkdownPreviewProps {
  content: string
  editable?: boolean
  onSave?: (content: string) => Promise<void>
  toolbarEnd?: ReactNode
}

interface FrontmatterField {
  key: string
  value: string
}

const unquoteFrontmatterValue = (value: string) => {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const parseFrontmatter = (value: string): { fields: FrontmatterField[]; body: string } => {
  const normalized = value.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { fields: [], body: value }
  }

  const lines = normalized.split(/\r?\n/)
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closingIndex < 0) return { fields: [], body: value }

  const fields = lines
    .slice(1, closingIndex)
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
      if (!match) return null
      return {
        key: match[1],
        value: unquoteFrontmatterValue(match[2]),
      }
    })
    .filter((field): field is FrontmatterField => !!field && field.value.length > 0)

  return {
    fields,
    body: lines
      .slice(closingIndex + 1)
      .join('\n')
      .trimStart(),
  }
}

function FrontmatterFormatter({ fields }: { fields: FrontmatterField[] }) {
  if (!fields.length) return null
  return (
    <section className="md-frontmatter" aria-label="SKILL.md metadata">
      <dl className="md-frontmatter-grid">
        {fields.map((field) => (
          <div className="md-frontmatter-row" key={field.key}>
            <dt>{field.key}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export default function MarkdownPreview({
  content,
  editable = false,
  onSave,
  toolbarEnd,
}: MarkdownPreviewProps) {
  const [mode, setMode] = useState<ViewMode>('preview')
  const [editContent, setEditContent] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  useEffect(() => {
    setEditContent(content)
    setDirty(false)
  }, [content])

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 'var(--radius)',
    border: '1px solid',
    borderColor: active ? 'var(--primary)' : 'var(--border)',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? 'var(--primary)' : 'var(--muted)',
    cursor: 'pointer',
    transition: 'all var(--dur) var(--ease)',
  })

  const handleSave = async () => {
    if (!onSave) return
    setSaving(true)
    setSaveErr(null)
    try {
      await onSave(editContent)
      setDirty(false)
      setMode('preview')
    } catch (err) {
      console.error({ err }, 'Failed to save Markdown source')
      setSaveErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setEditContent(content)
    setDirty(false)
    setSaveErr(null)
    setMode('preview')
  }

  const sourceLabel = editable ? '编辑' : '原文'
  const { fields: frontmatterFields, body: markdownBody } = parseFrontmatter(content)

  const buttons = (
    <div
      className="md-preview-toolbar"
      style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', minHeight: 28 }}
    >
      <button style={toggleStyle(mode === 'preview')} onClick={() => setMode('preview')}>
        预览
      </button>
      <button
        style={toggleStyle(mode === 'source')}
        onClick={() => {
          setEditContent(content)
          setDirty(false)
          setSaveErr(null)
          setMode('source')
        }}
      >
        {sourceLabel}
      </button>
      {toolbarEnd && (
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
          {toolbarEnd}
        </span>
      )}
      {mode === 'source' && editable && (
        <>
          <button
            style={{
              ...toggleStyle(false),
              marginLeft: toolbarEnd ? 0 : 'auto',
              borderColor: 'var(--primary)',
              color: 'var(--primary)',
            }}
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button style={toggleStyle(false)} onClick={handleCancel}>
            取消
          </button>
        </>
      )}
    </div>
  )

  if (mode === 'source') {
    if (editable) {
      return (
        <div>
          {buttons}
          {saveErr && (
            <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--error)' }}>{saveErr}</div>
          )}
          <MonacoTextEditor
            ariaLabel="SKILL.md 内容"
            height="var(--skill-detail-panel-height)"
            language="markdown"
            value={editContent}
            onChange={(next) => {
              setEditContent(next)
              setDirty(true)
            }}
            options={{
              lineNumbers: 'on',
              padding: { top: 12, bottom: 12 },
              renderWhitespace: 'selection',
            }}
          />
        </div>
      )
    }
    return (
      <div>
        {buttons}
        <pre
          style={{
            height: 'var(--skill-detail-panel-height)',
            overflow: 'auto',
            padding: 12,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
          }}
        >
          {content}
        </pre>
      </div>
    )
  }

  return (
    <div>
      {buttons}
      <div
        className="md-preview"
        style={{
          height: 'var(--skill-detail-panel-height)',
          overflow: 'auto',
          padding: 14,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          fontFamily: "'Inter', sans-serif",
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--text)',
        }}
      >
        <FrontmatterFormatter fields={frontmatterFields} />
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {markdownBody}
        </ReactMarkdown>
      </div>
    </div>
  )
}
