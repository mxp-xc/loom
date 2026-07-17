import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  Braces,
  Check,
  CircleDot,
  Copy,
  Eye,
  Files,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import type { AgentId } from '@/lib/agents'
import { MarkdownDocument } from '@/components/MarkdownPreview'
import { IconButton } from '@/components/ui/IconButton'
import { AgentChip } from '@/components/ui/AgentChip'
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
  onDirtyChange?: (dirty: boolean) => void
  agents: AgentId[]
  assignedAgents?: AgentId[]
  contextLabel?: string
  toolbarStart?: ReactNode
  onRename?: () => void
  onDelete?: () => void
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
  onDirtyChange,
  agents,
  assignedAgents = [],
  contextLabel,
  toolbarStart,
  onRename,
  onDelete,
}: Props) {
  const [view, setView] = useState<View>('compose')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [agent, setAgent] = useState<AgentId | null>(agents[0] ?? null)
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<VarsDiagnostic[]>([])
  const [copied, setCopied] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    const closeActions = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false)
    }
    document.addEventListener('pointerdown', closeActions)
    return () => document.removeEventListener('pointerdown', closeActions)
  }, [])

  useEffect(() => {
    if (agent !== null && agents.includes(agent)) return
    setAgent(agents[0] ?? null)
  }, [agents, agent])

  useEffect(() => {
    if (agent === null && view === 'resolved') setView('compose')
  }, [agent, view])

  const completionCacheKey = agent === null ? '' : repo + '\0' + agent
  const varKeys = varKeyState.cacheKey === completionCacheKey ? varKeyState.keys : []

  useEffect(() => {
    if (agent === null) return
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
    if (view !== 'resolved' || agent === null) return
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
    } catch (error) {
      console.error({ err: error }, 'Failed to save Memory content')
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
          <div className={styles['mem-document-content']}>
            <DocumentHeader name={name} agents={assignedAgents} />
            <MarkdownDocument
              content={showMarkdownComments(edit)}
              className={styles['mem-rendered-editor']}
            />
          </div>
        </div>
      )
    }
    if (view === 'source') {
      return <MemorySourceMarkdownEditor value={edit} onChange={updateEdit} varsKeys={varKeys} />
    }
    return null
  }, [assignedAgents, edit, name, varKeys, view])

  const tab = (v: View, label: string, icon: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      className={cn(styles['cfg-seg-opt'], view === v && styles.on)}
      onClick={() => setView(v)}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className={styles['mem-editor']}>
      <div className={styles['mem-toolbar']}>
        <div className={styles['mem-toolbar-start']}>{toolbarStart}</div>
        <div className={styles['cfg-seg']} role="tablist" aria-label="Memory 视图">
          {tab('compose', '所见', <Eye />)}
          {tab('source', '源码', <Braces />)}
          {agent !== null && tab('resolved', '解析', <Sparkles />)}
        </div>
        <div className={styles['mem-toolbar-actions']}>
          {view === 'resolved' && (
            <div className={styles['mem-preview-agents']}>
              <span className="label">预览为</span>
              <div className="agent-chips">
                {agents.map((a) => (
                  <AgentChip
                    key={a}
                    agent={a}
                    state={agent === a ? 'on' : 'off'}
                    onClick={() => setAgent(a)}
                  />
                ))}
              </div>
            </div>
          )}
          <div className={styles['mem-action-control']} ref={actionsRef}>
            <IconButton
              label="管理 Memory"
              tooltip="管理"
              onClick={() => setActionsOpen((open) => !open)}
            >
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
            {actionsOpen && (
              <div className={styles['mem-action-menu']} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  aria-label={copied ? '已复制 Memory 原始内容' : '复制 Memory 原始内容'}
                  onClick={() => void copyRawMarkdown()}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? '已复制' : '复制源码'}
                </button>
                {onRename && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setActionsOpen(false)
                      onRename()
                    }}
                  >
                    <Pencil />
                    重命名
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.danger}
                    onClick={() => {
                      setActionsOpen(false)
                      onDelete()
                    }}
                  >
                    <Trash2 />
                    删除
                  </button>
                )}
              </div>
            )}
          </div>
          {view !== 'resolved' && (
            <button
              type="button"
              className={cn(styles['mem-save'], !dirty && styles.saved)}
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              <Check />
              {saving ? '保存中…' : dirty ? '保存' : '已保存'}
            </button>
          )}
        </div>
      </div>

      <div className={styles['mem-document-context']}>
        <div className={styles['mem-document-identity']}>
          <span className={styles['mem-file-symbol']}>
            <Files />
          </span>
          <div>
            <strong>{contextLabel ?? name}</strong>
            <span>Agent Memory</span>
          </div>
        </div>
        <div className={styles['mem-document-facts']} aria-label="Memory 状态">
          <span>
            <CircleDot /> {assignedAgents.length} 个 Agent
          </span>
          <span>{edit.length} 字符</span>
        </div>
      </div>

      {editor}

      {view === 'resolved' && agent !== null && (
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
          <div className={styles['mem-document-content']}>
            <DocumentHeader name={name} agents={assignedAgents} />
            <div className={cn('md-preview', styles['mem-rendered-preview'])}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {resolved}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DocumentHeader({ name, agents }: { name: string; agents: AgentId[] }) {
  return (
    <header className={styles['mem-document-header']}>
      <h1>{name}</h1>
      <div className={styles['mem-document-agents']}>
        <span>{agents.length ? '投影到' : '尚未分配 Agent'}</span>
        {agents.map((agent) => (
          <AgentChip key={agent} agent={agent} state="on" />
        ))}
      </div>
    </header>
  )
}
