import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ApiError, api } from '@/lib/api'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import { cn } from '@/lib/utils'
import type { VarsDiagnostic } from '@/lib/vars'
import styles from './MemoryEditor.module.css'

type View = 'edit' | 'preview' | 'resolved'

interface Props {
  repo: string
  name: string
  content: string
  onSave: (content: string) => Promise<void>
  targets: AgentId[]
  contextLabel?: string
}

// Highlight ${VAR} and \${...} escapes for the overlay layer.
// HTML-escape first, then a single alternation pass so ph-esc wins over ph-var
// (a separate second replace would re-match inside the ph-esc span and double-wrap).
function highlight(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(
    /\\\$\{[^}]*\}|\$\{[A-Za-z_][A-Za-z0-9_.-]*\}/g,
    (m) => `<span class="${m[0] === '\\' ? styles['ph-esc'] : styles['ph-var']}">${m}</span>`,
  )
}

function diagnosticText(diagnostic: VarsDiagnostic): string {
  const details = [
    diagnostic.key ? `key=${diagnostic.key}` : null,
    diagnostic.referencedKey ? `ref=${diagnostic.referencedKey}` : null,
    diagnostic.path?.length ? `path=${diagnostic.path.join(' → ')}` : null,
  ].filter(Boolean)
  return `[${diagnostic.code}] ${diagnostic.message}${details.length ? ` · ${details.join(' · ')}` : ''}`
}

export default function MemoryEditor({
  repo,
  name,
  content,
  onSave,
  targets,
  contextLabel,
}: Props) {
  const [view, setView] = useState<View>('preview')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [agent, setAgent] = useState<AgentId>(targets[0] ?? 'claude-code')
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<VarsDiagnostic[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setEdit(content)
    setDirty(false)
  }, [content, name])

  useEffect(() => {
    if (targets.length && !targets.includes(agent)) setAgent(targets[0])
  }, [targets, agent])

  const onScroll = () => {
    if (taRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = taRef.current.scrollTop
      overlayRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }

  useEffect(() => {
    if (view !== 'resolved') return
    let active = true
    setResolveErr(null)
    setDiagnostics([])
    setResolved('')
    api
      .previewMemory({ repo, content: edit, agent })
      .then((res) => {
        if (!active) return
        setDiagnostics(res.diagnostics ?? res.resolution?.diagnostics ?? [])
        if (res.rendered !== undefined) setResolved(res.rendered)
        else {
          setResolved('')
          setResolveErr(res.message ?? res.error ?? '解析失败')
        }
      })
      .catch((e: unknown) => {
        if (!active) return
        setResolved('')
        setDiagnostics(e instanceof ApiError ? (e.diagnostics ?? []) : [])
        setResolveErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [view, agent, edit, repo])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(edit)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const tab = (v: View, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      className={cn(styles['cfg-seg-opt'], view === v && styles.on)}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  )

  return (
    <div className={styles['mem-editor']}>
      <div className={styles['mem-toolbar']}>
        {contextLabel && (
          <div className={styles['mem-current']}>
            <strong>{contextLabel}</strong>
          </div>
        )}
        <div className={styles['cfg-seg']} role="tablist" aria-label="Memory 视图">
          {tab('preview', '预览')}
          {tab('edit', '编辑')}
          {tab('resolved', '解析预览')}
        </div>
        {view === 'resolved' && (
          <div className={styles['mem-preview-targets']}>
            <span className="label">预览为</span>
            <div className="target-chips">
              {targets.map((a) => (
                <button
                  key={a}
                  type="button"
                  className="target-chip"
                  data-state={agent === a ? 'on' : 'off'}
                  style={{ ['--c' as string]: agentColor[a] }}
                  onClick={() => setAgent(a)}
                >
                  {agentShort[a]}
                </button>
              ))}
            </div>
          </div>
        )}
        {view === 'edit' && dirty && (
          <button
            type="button"
            className={styles['mem-save']}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>

      {view === 'edit' && (
        <div className={styles['mem-edit-wrap']}>
          <pre
            ref={overlayRef}
            aria-hidden
            className={styles['mem-overlay']}
            dangerouslySetInnerHTML={{ __html: highlight(edit) + '\n' }}
          />
          <textarea
            ref={taRef}
            className={styles['mem-textarea']}
            value={edit}
            onChange={(e) => {
              setEdit(e.target.value)
              setDirty(true)
            }}
            onScroll={onScroll}
            spellCheck={false}
          />
        </div>
      )}

      {view === 'preview' && (
        <div className={cn('md-preview', styles['mem-pane'])}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{edit}</ReactMarkdown>
        </div>
      )}

      {view === 'resolved' && (
        <div className={styles['mem-pane']}>
          {resolveErr && <div className={styles['mem-err']}>{resolveErr}</div>}
          {diagnostics.length > 0 && (
            <div className={styles['mem-err']} role="alert" aria-label="解析诊断">
              <ul>
                {diagnostics.map((diagnostic, index) => (
                  <li key={index}>{diagnosticText(diagnostic)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="md-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{resolved}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
