import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { ApiError, api } from '@/lib/api'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import { cn } from '@/lib/utils'
import type { VarsDiagnostic } from '@/lib/vars'
import MemoryRichMarkdownEditor from './MemoryRichMarkdownEditor'
import MemorySourceMarkdownEditor from './MemorySourceMarkdownEditor'
import styles from './MemoryEditor.module.css'

type View = 'compose' | 'source' | 'resolved'

interface Props {
  repo: string
  name: string
  content: string
  onSave: (content: string) => Promise<void>
  targets: AgentId[]
  contextLabel?: string
  enableRichVarsCompletion?: boolean
}

function diagnosticText(diagnostic: VarsDiagnostic): string {
  const details = [
    diagnostic.key ? 'key=' + diagnostic.key : null,
    diagnostic.referencedKey ? 'ref=' + diagnostic.referencedKey : null,
    diagnostic.path?.length ? 'path=' + diagnostic.path.join(' → ') : null,
  ].filter(Boolean)
  return (
    '[' +
    diagnostic.code +
    '] ' +
    diagnostic.message +
    (details.length ? ' · ' + details.join(' · ') : '')
  )
}

export default function MemoryEditor({
  repo,
  name,
  content,
  onSave,
  targets,
  contextLabel,
  enableRichVarsCompletion = true,
}: Props) {
  // Rich editing and rich variable completion are intentionally parked for now.
  // Keep the adapter code in place so the feature can be re-enabled after the UX is stable.
  const richEditingEnabled = false
  const [view, setView] = useState<View>('compose')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [agent, setAgent] = useState<AgentId>(targets[0] ?? 'claude-code')
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<VarsDiagnostic[]>([])
  const [varKeyState, setVarKeyState] = useState<{ cacheKey: string; keys: string[] }>({
    cacheKey: '',
    keys: [],
  })

  useEffect(() => {
    setEdit(content)
    setDirty(false)
  }, [content, name])

  useEffect(() => {
    if (targets.length && !targets.includes(agent)) setAgent(targets[0])
  }, [targets, agent])

  const completionCacheKey = repo + '\0' + agent
  const varKeys = varKeyState.cacheKey === completionCacheKey ? varKeyState.keys : []

  useEffect(() => {
    if (varKeyState.cacheKey === completionCacheKey) return
    let active = true
    api.vars
      .getMatrix(repo, agent)
      .then((res) => {
        if (!active) return
        setVarKeyState({
          cacheKey: completionCacheKey,
          keys: [...new Set([...(res.userKeys ?? []), ...(res.builtinKeys ?? [])])].sort(),
        })
      })
      .catch((err: unknown) => {
        console.error({ err }, 'Failed to load memory variable suggestions')
        if (active) setVarKeyState({ cacheKey: completionCacheKey, keys: [] })
      })
    return () => {
      active = false
    }
  }, [agent, completionCacheKey, repo, varKeyState.cacheKey])

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
          console.error({ err: res }, 'Memory preview returned failure')
          setResolved('')
          setResolveErr(res.message ?? res.error ?? '解析失败')
        }
      })
      .catch((e: unknown) => {
        if (!active) return
        console.error({ err: e }, 'Failed to preview memory')
        setResolved('')
        setDiagnostics(e instanceof ApiError ? (e.diagnostics ?? []) : [])
        setResolveErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [view, agent, edit, repo])

  const updateEdit = (next: string) => {
    setEdit(next)
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(edit)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const editor = useMemo(() => {
    if (view === 'compose') {
      return (
        <MemoryRichMarkdownEditor
          value={edit}
          onChange={updateEdit}
          varsKeys={varKeys}
          readOnly={!richEditingEnabled}
          enableVarsCompletion={richEditingEnabled && enableRichVarsCompletion}
        />
      )
    }
    if (view === 'source') {
      return <MemorySourceMarkdownEditor value={edit} onChange={updateEdit} varsKeys={varKeys} />
    }
    return null
  }, [edit, enableRichVarsCompletion, varKeys, view])

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
          {tab('compose', '所见编辑')}
          {tab('source', '源码')}
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
        {view !== 'resolved' && dirty && (
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

      {editor}

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
          <div className={cn('md-preview', styles['mem-rendered-preview'])}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {resolved}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
