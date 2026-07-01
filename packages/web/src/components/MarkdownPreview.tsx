import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

type ViewMode = 'preview' | 'source'

interface MarkdownPreviewProps {
  content: string
  editable?: boolean
  onSave?: (content: string) => Promise<void>
}

export default function MarkdownPreview({
  content,
  editable = false,
  onSave,
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
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
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

  const buttons = (
    <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
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
      {mode === 'source' && editable && (
        <>
          <button
            style={{
              ...toggleStyle(false),
              marginLeft: 'auto',
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
          <textarea
            value={editContent}
            onChange={(e) => {
              setEditContent(e.target.value)
              setDirty(true)
            }}
            style={{
              width: '100%',
              minHeight: 320,
              padding: 12,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--text)',
              resize: 'vertical',
              outline: 'none',
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
            maxHeight: 360,
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
          maxHeight: 360,
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
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
