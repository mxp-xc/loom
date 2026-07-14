import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import type { AgentId } from '@/lib/agents'
import { MarkdownDocument } from '@/components/MarkdownPreview'
import { IconButton } from '@/components/ui/IconButton'
import { TargetChip } from '@/components/ui/TargetChip'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'
import type { VarsDiagnostic } from '@/lib/vars'
import MemorySourceMarkdownEditor from './MemorySourceMarkdownEditor'
import styles from './MemoryEditor.module.css'

type View = 'compose' | 'source' | 'resolved'
const markdownCommentPattern = /<!--[\s\S]*?-->/g

interface Props {
  repo: string
  name: string
  content: string
  onSave: (content: string) => Promise<void>
  targets: AgentId[]
  contextLabel?: string
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

function showMarkdownComments(markdown: string): string {
  return markdown.replace(markdownCommentPattern, (comment, index) =>
    index > 0 && markdown[index - 1] === '\\' ? comment : '\\' + comment,
  )
}

export default function MemoryEditor({
  repo,
  name,
  content,
  onSave,
  targets,
  contextLabel,
}: Props) {
  const [view, setView] = useState<View>('compose')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [agent, setAgent] = useState<AgentId>(targets[0] ?? 'claude-code')
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<VarsDiagnostic[]>([])
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const [varKeyState, setVarKeyState] = useState<{ cacheKey: string; keys: string[] }>({
    cacheKey: '',
    keys: [],
  })
  const { showToast, showErrorToast } = useToast()

  useEffect(() => {
    setEdit(content)
    setDirty(false)
    setCopied(false)
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [content, name])

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

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

  const copyRawMarkdown = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(edit)
      setCopied(true)
      showToast('已复制')
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null
        setCopied(false)
      }, 1500)
    } catch (err) {
      console.error({ err }, 'Failed to copy memory content')
      showErrorToast(err, { title: '复制失败', message: '请检查剪贴板权限后重试' })
    }
  }

  const editor = useMemo(() => {
    if (view === 'compose') {
      return (
        <div
          className={cn(
            styles['mem-edit-wrap'],
            styles['mem-compose-wrap'],
            styles['mem-rich-readonly'],
          )}
        >
          <MarkdownDocument
            content={showMarkdownComments(edit)}
            className={styles['mem-rendered-editor']}
          />
        </div>
      )
    }
    if (view === 'source') {
      return <MemorySourceMarkdownEditor value={edit} onChange={updateEdit} varsKeys={varKeys} />
    }
    return null
  }, [edit, varKeys, view])

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
        <div className={styles['mem-toolbar-actions']}>
          <IconButton
            label={copied ? '已复制 Memory 原始内容' : '复制 Memory 原始内容'}
            tooltip={copied ? '已复制' : '复制'}
            tone={copied ? 'success' : 'default'}
            onClick={() => void copyRawMarkdown()}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </IconButton>
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
        {view === 'resolved' && (
          <div className={styles['mem-preview-targets']}>
            <span className="label">预览为</span>
            <div className="target-chips">
              {targets.map((a) => (
                <TargetChip
                  key={a}
                  agent={a}
                  state={agent === a ? 'on' : 'off'}
                  onClick={() => setAgent(a)}
                />
              ))}
            </div>
          </div>
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
