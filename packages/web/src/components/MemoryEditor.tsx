import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'

type View = 'edit' | 'preview' | 'resolved'

interface Props {
  repo: string
  name: string
  content: string
  onSave: (content: string) => Promise<void>
  targets: AgentId[]
}

// Highlight ${VAR}/${VAR:fallback} and \${...} escapes for the overlay layer.
// HTML-escape first, then a single alternation pass so ph-esc wins over ph-var
// (a separate second replace would re-match inside the ph-esc span and double-wrap).
function highlight(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(
    /\\\$\{[^}]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}/g,
    (m) => `<span class="${m[0] === '\\' ? 'ph-esc' : 'ph-var'}">${m}</span>`,
  )
}

export default function MemoryEditor({ repo, name, content, onSave, targets }: Props) {
  const [view, setView] = useState<View>('edit')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [agent, setAgent] = useState<AgentId>(targets[0] ?? 'claude-code')
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
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
    api
      .previewMemory({ repo, content: edit, agent })
      .then((res) => {
        if (!active) return
        if (res.rendered !== undefined) setResolved(res.rendered)
        else setResolveErr(res.message ?? res.error ?? '解析失败')
      })
      .catch((e: unknown) => {
        if (active) setResolveErr(e instanceof Error ? e.message : String(e))
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
      className={'cfg-seg-opt' + (view === v ? ' on' : '')}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  )

  const agentKey = (a: AgentId) => (a === 'claude-code' ? 'cc' : a === 'codex' ? 'cx' : 'oc')

  return (
    <div>
      <div className="mem-toolbar">
        <div className="cfg-seg">
          {tab('edit', '编辑')}
          {tab('preview', '预览')}
          {tab('resolved', '解析预览')}
        </div>
        {view === 'resolved' && (
          <div className="cfg-chips">
            {targets.map((a) => (
              <button
                key={a}
                type="button"
                className={'achip' + (agent === a ? ' on' : ' off')}
                data-a={agentKey(a)}
                style={{ ['--c' as string]: agentColor[a] }}
                onClick={() => setAgent(a)}
              >
                {agentShort[a]}
              </button>
            ))}
          </div>
        )}
        {view === 'edit' && dirty && (
          <button type="button" className="mem-save" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>

      {view === 'edit' && (
        <div className="mem-edit-wrap">
          <pre
            ref={overlayRef}
            aria-hidden
            className="mem-overlay"
            dangerouslySetInnerHTML={{ __html: highlight(edit) + '\n' }}
          />
          <textarea
            ref={taRef}
            className="mem-textarea"
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
        <div className="md-preview mem-pane">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{edit}</ReactMarkdown>
        </div>
      )}

      {view === 'resolved' && (
        <div className="mem-pane">
          {resolveErr && <div className="mem-err">{resolveErr}</div>}
          <div className="md-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{resolved}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
