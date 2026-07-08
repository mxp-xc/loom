import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { refreshManifest } from '@/hooks/useManifest'
import Modal from '@/components/Modal'
import MarkdownPreview from '@/components/MarkdownPreview'
import { Copy, Check } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { AGENTS, agentShort, agentColor, agentSkillPath, type AgentId } from '@/lib/agents'
import type { SkillDetail } from './types'

interface Props {
  repoPath: string
  detail: SkillDetail | null
  showToast: (msg: string) => void
  onClose: () => void
}

const renderChip = (agent: AgentId, active: boolean, onClick?: () => void) => (
  <span
    key={agent}
    className={'chip ' + (active ? 'active' : 'inactive')}
    style={{ ['--c' as string]: agentColor[agent] }}
    onClick={onClick}
  >
    {agentShort[agent]}
  </span>
)

export default function SkillDetailEditor({ repoPath, detail, showToast, onClose }: Props) {
  const allAgents: AgentId[] = [...AGENTS]
  const [skillContent, setSkillContent] = useState<string | null>(null)
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [copiedSkillContent, setCopiedSkillContent] = useState(false)

  useEffect(() => {
    if (!detail) {
      setSkillContent(null)
      setSkillError(null)
      setSkillLoading(false)
      setCopiedSkillContent(false)
      return
    }
    let active = true
    setSkillLoading(true)
    setSkillError(null)
    setSkillContent(null)
    setCopiedSkillContent(false)
    api
      .getSkillContent(repoPath, detail.skillId, detail.source, detail.path)
      .then((res) => {
        if (!active) return
        if (res.ok) setSkillContent(res.content ?? null)
        else setSkillError(res.message ?? res.error ?? '读取失败')
      })
      .catch((e: unknown) => {
        if (!active) return
        const msg = e instanceof Error ? e.message : String(e)
        setSkillError(msg === 'Failed to fetch' ? '网络错误,请检查后端服务是否运行' : msg)
      })
      .finally(() => {
        if (active) setSkillLoading(false)
      })
    return () => {
      active = false
    }
  }, [detail, repoPath])

  const copyPath = async (p: string) => {
    if (!navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(p)
      setCopiedPath(p)
      setTimeout(() => setCopiedPath(null), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const copySkillContent = async () => {
    if (!navigator.clipboard || !skillContent) return
    try {
      await navigator.clipboard.writeText(skillContent)
      setCopiedSkillContent(true)
      showToast('已复制 SKILL.md')
      setTimeout(() => setCopiedSkillContent(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const showSkillLoading = Boolean(detail) && !skillContent && !skillError

  return (
    <Modal
      open={!!detail}
      onClose={onClose}
      title={detail?.skillId ?? ''}
      width={960}
      minHeight={460}
    >
      {detail && (
        <div>
          {detail.source && (
            <div style={{ marginBottom: 12 }}>
              <div className="label">source</div>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  color: 'var(--text)',
                  wordBreak: 'break-all',
                }}
              >
                {detail.source}
              </div>
            </div>
          )}
          {detail.path && (
            <div style={{ marginBottom: 12 }}>
              <div className="label">path</div>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  color: 'var(--text)',
                  wordBreak: 'break-all',
                }}
              >
                {detail.path}
              </div>
            </div>
          )}
          <div style={{ marginBottom: 12 }}>
            <div className="label">targets</div>
            <div style={{ display: 'flex', gap: 7, marginTop: 6 }}>
              {allAgents.map((a) => renderChip(a, detail.targets.includes(a)))}
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div className="label">projected links</div>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {allAgents.map((a) => {
                const p = agentSkillPath(a, detail.skillId)
                const active = detail.targets.includes(a)
                return (
                  <div
                    key={a}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      opacity: active ? 1 : 0.45,
                    }}
                  >
                    {renderChip(a, active)}
                    <span
                      style={{
                        flex: 1,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        color: 'var(--text)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {p}
                    </span>
                    <IconButton
                      label={copiedPath === p ? `已复制 ${p}` : `复制 ${p}`}
                      tooltip={copiedPath === p ? '已复制' : '复制'}
                      tone={copiedPath === p ? 'success' : 'default'}
                      onClick={() => copyPath(p)}
                    >
                      {copiedPath === p ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </IconButton>
                  </div>
                )
              })}
            </div>
          </div>
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <div className="label">SKILL.md</div>
            </div>
            <div className="skill-detail-content-frame" data-testid="skill-detail-content-frame">
              {showSkillLoading && (
                <>
                  <div className="skill-detail-preview-tabs" aria-hidden="true">
                    <span className="on">预览</span>
                    <span>原文</span>
                  </div>
                  <div className="skill-detail-loading-panel" role="status">
                    {skillLoading ? '加载 SKILL.md…' : '准备加载 SKILL.md…'}
                  </div>
                </>
              )}
              {skillError && (
                <div className="skill-detail-error" role="alert">
                  {skillError}
                </div>
              )}
              {skillContent && (
                <MarkdownPreview
                  content={skillContent}
                  editable={!detail.source}
                  toolbarEnd={
                    <IconButton
                      label={copiedSkillContent ? '已复制 SKILL.md' : '复制 SKILL.md'}
                      tooltip={copiedSkillContent ? '已复制' : '复制'}
                      tone={copiedSkillContent ? 'success' : 'default'}
                      onClick={() => void copySkillContent()}
                    >
                      {copiedSkillContent ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </IconButton>
                  }
                  onSave={async (newContent) => {
                    try {
                      await api.saveSkillContent({
                        repo: repoPath,
                        skillId: detail.skillId,
                        localPath: detail.path,
                        content: newContent,
                      })
                      setSkillContent(newContent)
                      try {
                        await refreshManifest(repoPath)
                      } catch (e) {
                        showToast(
                          '已保存，但刷新列表失败：' + (e instanceof Error ? e.message : String(e)),
                        )
                        return
                      }
                      showToast('已保存')
                    } catch (e) {
                      showToast(e instanceof Error ? e.message : String(e))
                    }
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
