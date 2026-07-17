import { useEffect, useState, type CSSProperties } from 'react'
import { api } from '@/lib/api'
import { refreshManifest } from '@/hooks/useManifest'
import { showErrorToast } from '@/hooks/useToast'
import Modal from '@/components/Modal'
import { MarkdownDocument } from '@/components/MarkdownPreview'
import MonacoTextEditor from '@/components/monaco/MonacoTextEditor'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { Check, Code2, Copy, FileText, LoaderCircle } from 'lucide-react'
import { agentColor, agentName, agentShort, agentSkillPath, type AgentId } from '@/lib/agents'
import type { SkillDetail } from './types'
import SkillWorkbench, { SkillWorkbenchTitle } from './SkillWorkbench'
import styles from './SkillDetailEditor.module.css'

interface Props {
  repoPath: string
  detail: SkillDetail | null
  agents?: AgentId[]
  showToast: (msg: string) => void
  onClose: () => void
}

type DocumentMode = 'preview' | 'source'

function skillDocumentPath(path?: string): string {
  if (!path) return 'Resolved from skill source'
  if (/SKILL\.md$/i.test(path)) return path
  return `${path.replace(/[\\/]+$/, '')}/SKILL.md`
}

export default function SkillDetailEditor({
  repoPath,
  detail,
  agents = [],
  showToast,
  onClose,
}: Props) {
  const [skillContent, setSkillContent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<DocumentMode>('preview')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!detail) {
      setSkillContent(null)
      setDraft('')
      setSkillError(null)
      setSaveError(null)
      setMode('preview')
      setDirty(false)
      setSaving(false)
      setCopied(false)
      return
    }

    let active = true
    setSkillContent(null)
    setDraft('')
    setSkillError(null)
    setSaveError(null)
    setMode('preview')
    setDirty(false)
    setCopied(false)

    api
      .getSkillContent(repoPath, detail.skillId, detail.source, detail.path)
      .then((res) => {
        if (!active) return
        if (!res.ok) {
          setSkillError(res.message ?? res.error ?? '读取失败')
          return
        }
        const content = res.content ?? ''
        setSkillContent(content)
        setDraft(content)
      })
      .catch((err: unknown) => {
        if (!active) return
        console.error({ err }, 'Failed to load skill content')
        const message = err instanceof Error ? err.message : String(err)
        setSkillError(message === 'Failed to fetch' ? '网络错误,请检查后端服务是否运行' : message)
      })

    return () => {
      active = false
    }
  }, [detail, reloadKey, repoPath])

  const copySkillContent = async () => {
    if (!navigator.clipboard || skillContent == null) return
    try {
      await navigator.clipboard.writeText(mode === 'source' ? draft : skillContent)
      setCopied(true)
      showToast('已复制 SKILL.md')
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error({ err }, 'Failed to copy skill content')
    }
  }

  const saveSkillContent = async () => {
    if (!detail || detail.source || !dirty || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await api.saveSkillContent({
        repo: repoPath,
        skillId: detail.skillId,
        localPath: detail.path,
        content: draft,
      })
      if (!result.ok) throw new Error(result.message ?? result.error ?? '保存失败')

      setSkillContent(draft)
      setDirty(false)
      try {
        await refreshManifest(repoPath)
      } catch (err) {
        console.error({ err }, 'Failed to refresh skills after saving content')
        showErrorToast(err, {
          title: '内容已保存，但列表刷新失败',
          message: '请稍后刷新页面',
        })
        return
      }
      showToast('已保存')
    } catch (err) {
      console.error({ err }, 'Failed to save skill content')
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message)
      showErrorToast(err, {
        title: 'Skill 内容保存失败',
        message: '请检查内容后重试',
      })
    } finally {
      setSaving(false)
    }
  }

  const activeAgents = detail ? agents.filter((agent) => detail.agents.includes(agent)).length : 0
  const isLocal = Boolean(detail && !detail.source)
  const savedState = detail?.source ? 'Read only' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'
  const savedTone = saving ? 'saving' : dirty ? 'dirty' : 'saved'

  return (
    <Modal
      open={!!detail}
      onClose={onClose}
      ariaLabel={detail?.skillId ?? ''}
      title={
        <SkillWorkbenchTitle
          icon={<FileText size={17} />}
          eyebrow={detail?.source ? 'Source skill' : 'Local skill'}
          title={detail?.skillId ?? ''}
        />
      }
      width={1180}
      busy={saving}
      className={styles.dialog}
      bodyClassName={styles.body}
      headerClassName={styles.header}
      titleClassName={styles.modalTitle}
      headerActions={
        detail ? (
          <span className={styles.savedState} data-state={savedTone}>
            {saving ? <LoaderCircle size={13} className={styles.spin} /> : <Check size={13} />}
            {savedState}
          </span>
        ) : null
      }
    >
      {detail && (
        <SkillWorkbench
          className={styles.layout}
          bodyClassName={styles.editorBody}
          configurationClassName={styles.metadata}
          resultsClassName={styles.document}
          configurationLabel="Details"
          resultsLabel="SKILL.md"
          configuration={
            <div className={styles.metadataContent} data-testid="skill-metadata-pane">
              <section>
                <span className={styles.kicker}>Location</span>
                <dl className={styles.metaList}>
                  {detail.source && (
                    <div>
                      <dt>Source</dt>
                      <dd>{detail.source}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Path</dt>
                    <dd>{skillDocumentPath(detail.path)}</dd>
                  </div>
                </dl>
              </section>

              {agents.length > 0 && (
                <section>
                  <div className={styles.sectionHeading}>
                    <span className={styles.kicker}>Projected links</span>
                    <span>
                      {activeAgents} of {agents.length}
                    </span>
                  </div>
                  <div className={styles.agentList}>
                    {agents.map((agent: AgentId) => {
                      const active = detail.agents.includes(agent)
                      return (
                        <div
                          key={agent}
                          className={styles.agentRow}
                          data-active={active}
                          style={{ '--agent-color': agentColor[agent] } as CSSProperties}
                        >
                          <span className={styles.agentBadge}>{agentShort[agent]}</span>
                          <div>
                            <strong>{agentName[agent]}</strong>
                            <code>{agentSkillPath(agent, detail.skillId)}</code>
                          </div>
                          <span className={styles.agentState}>{active ? 'linked' : 'off'}</span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}
            </div>
          }
          results={
            <div className={styles.documentPane} data-testid="skill-document-pane">
              <div className={styles.documentToolbar}>
                <div className={styles.documentTabs} role="tablist" aria-label="SKILL.md view">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'preview'}
                    onClick={() => setMode('preview')}
                  >
                    <FileText size={14} />
                    Preview
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'source'}
                    onClick={() => setMode('source')}
                  >
                    <Code2 size={14} />
                    Source
                  </button>
                </div>
                <div className={styles.documentActions}>
                  <span>SKILL.md</span>
                  <IconButton
                    label={copied ? '已复制 SKILL.md' : '复制 SKILL.md'}
                    tooltip={copied ? '已复制' : '复制'}
                    tone={copied ? 'success' : 'default'}
                    onClick={() => void copySkillContent()}
                    disabled={skillContent == null}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </IconButton>
                </div>
              </div>

              <div className={styles.documentContent} data-testid="skill-detail-content-frame">
                {skillContent == null && !skillError && (
                  <div className={styles.resultState} role="status">
                    <LoaderCircle size={20} className={styles.spin} />
                    <strong>Loading SKILL.md</strong>
                    <p>正在读取 skill 内容…</p>
                  </div>
                )}

                {skillError && (
                  <div className={styles.resultState} role="alert">
                    <FileText size={20} />
                    <strong>SKILL.md failed to load</strong>
                    <p>{skillError}</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setReloadKey((key) => key + 1)}
                    >
                      Retry
                    </Button>
                  </div>
                )}

                {skillContent != null && mode === 'preview' && skillContent.trim() === '' && (
                  <div className={styles.resultState}>
                    <FileText size={22} />
                    <strong>Empty SKILL.md</strong>
                    <Button size="sm" onClick={() => setMode('source')}>
                      {isLocal ? 'Start editing' : 'View source'}
                    </Button>
                  </div>
                )}

                {skillContent != null && mode === 'preview' && skillContent.trim() !== '' && (
                  <MarkdownDocument content={skillContent} className={styles.markdownPreview} />
                )}

                {skillContent != null && mode === 'source' && isLocal && (
                  <MonacoTextEditor
                    className={styles.sourceEditor}
                    ariaLabel="SKILL.md 内容"
                    height="100%"
                    language="markdown"
                    value={draft}
                    onChange={(next) => {
                      setDraft(next)
                      setDirty(next !== skillContent)
                      setSaveError(null)
                    }}
                    options={{
                      lineNumbers: 'on',
                      padding: { top: 18, bottom: 18 },
                      renderWhitespace: 'selection',
                    }}
                  />
                )}

                {skillContent != null && mode === 'source' && !isLocal && (
                  <pre className={styles.readOnlySource}>{skillContent}</pre>
                )}
              </div>

              {saveError && (
                <div className={styles.saveError} role="alert">
                  {saveError}
                </div>
              )}
            </div>
          }
          footer={
            <>
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Close
              </Button>
              {isLocal && (
                <Button onClick={() => void saveSkillContent()} disabled={saving || !dirty}>
                  {saving ? 'Saving…' : 'Save SKILL.md'}
                </Button>
              )}
            </>
          }
        />
      )}
    </Modal>
  )
}
