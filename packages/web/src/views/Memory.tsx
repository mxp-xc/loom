import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import MemoryEditor from '@/components/MemoryEditor'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { useToast } from '@/hooks/useToast'
import { refreshManifest, useManifest } from '@/hooks/useManifest'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import styles from './Memory.module.css'

interface Props {
  repoPath: string
}

export default function Memory({ repoPath }: Props) {
  const [memories, setMemories] = useState<Array<{ name: string }>>([])
  const [active, setActive] = useState<string | null>(null)
  const [activeContent, setActiveContent] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedContent, setSelectedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [projecting, setProjecting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [updatingTarget, setUpdatingTarget] = useState<AgentId | null>(null)
  const { showToast } = useToast()
  const { manifest } = useManifest(repoPath)
  const targets = manifest?.config?.targets ?? []

  const load = async () => {
    try {
      const res = await api.getMemory(repoPath)
      setMemories(res.memories)
      setActive(res.active)
      setActiveContent(res.activeContent)
      if (res.active && !selected) {
        setSelected(res.active)
        setSelectedContent(res.activeContent)
      }
    } catch (e) {
      console.error({ err: e }, 'Failed to load memory list')
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [repoPath])

  const select = async (name: string) => {
    setSelected(name)
    if (name === active) {
      setSelectedContent(activeContent)
      return
    }
    try {
      const res = await fetch(
        `/api/memory?repo=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}`,
      ).then((r) => r.json())
      setSelectedContent(res.content ?? '')
    } catch (e) {
      console.error({ err: e }, 'Failed to select memory')
      setSelectedContent('')
    }
  }

  const project = async () => {
    setProjecting(true)
    try {
      const res = (await api.project({ repo: repoPath, scope: 'memory' })) as any
      if (res.ok) showToast('投影完成')
      else {
        console.error({ err: res }, 'Memory projection returned failure')
        showToast(res.message || '投影失败')
      }
    } catch (e) {
      console.error({ err: e }, 'Failed to project memory')
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setProjecting(false)
    }
  }

  const toggleProjectionTarget = async (agent: AgentId) => {
    const nextTargets = targets.includes(agent)
      ? targets.filter((item) => item !== agent)
      : [...targets, agent]
    let saved = false
    setUpdatingTarget(agent)
    try {
      const savedConfig = (await api.putConfig({
        repo: repoPath,
        level: 'repo',
        field: 'targets',
        value: nextTargets,
      })) as { ok?: boolean; message?: string; error?: string }
      if (savedConfig.ok === false) {
        throw new Error(savedConfig.message ?? savedConfig.error ?? '保存配置失败')
      }
      saved = true
      const projected = (await api.project({ repo: repoPath, scope: 'memory' })) as {
        ok?: boolean
        message?: string
        error?: string
      }
      if (projected.ok === false) {
        throw new Error(projected.message ?? projected.error ?? '投影失败')
      }
      await refreshManifest(repoPath)
      showToast('投影目标已更新')
    } catch (e) {
      console.error({ err: e }, 'Failed to update memory projection targets')
      if (saved) {
        try {
          await refreshManifest(repoPath)
        } catch (refreshError) {
          console.error(
            { err: refreshError },
            'Failed to refresh manifest after memory target update failure',
          )
        }
      }
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setUpdatingTarget(null)
    }
  }

  const create = async () => {
    const n = draftName.trim()
    if (!n) return
    try {
      await api.createMemory({ repo: repoPath, name: n })
      setCreating(false)
      setDraftName('')
      await load()
      await select(n)
      showToast('已创建')
    } catch (e) {
      console.error({ err: e }, 'Failed to create memory')
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doRename = async () => {
    if (!renaming || !draftName.trim()) return
    const n = draftName.trim()
    try {
      await api.renameMemory({ repo: repoPath, name: renaming, newName: n })
      setRenaming(null)
      setDraftName('')
      await load()
      await select(n)
      showToast('已重命名')
    } catch (e) {
      console.error({ err: e }, 'Failed to rename memory')
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async (name: string) => {
    try {
      await api.deleteMemory(repoPath, name)
      if (selected === name) {
        setSelected(null)
        setSelectedContent('')
      }
      await load()
      setDeleting(null)
      showToast('已删除')
    } catch (e) {
      console.error({ err: e }, 'Failed to delete memory')
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const activate = async (name: string | null) => {
    try {
      await api.setMemoryActive({ repo: repoPath, name })
      await load()
      showToast(name ? `已激活 ${name}` : '已取消激活')
    } catch (e) {
      console.error({ err: e }, 'Failed to set active memory')
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const save = async (content: string) => {
    if (!selected) return
    await api.saveMemoryContent({ repo: repoPath, name: selected, content })
    if (selected === active) setActiveContent(content)
    showToast('已保存')
  }

  return (
    <div
      className={styles['mem-layout']}
      data-layout="compact-workbench"
      data-testid="memory-layout"
    >
      <aside className={styles['mem-list']}>
        <div className={styles['mem-list-head']} data-testid="memory-rail-header">
          <div>
            <span className="label">memories</span>
          </div>
          <div className={styles['mem-list-actions']}>
            <IconButton
              label="投影 memory"
              tooltip={projecting ? '投影中…' : '投影'}
              onClick={project}
              disabled={projecting}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              label="新建 memory"
              tooltip="新建"
              onClick={() => {
                setCreating(true)
                setDraftName('')
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>
        <div className={styles['mem-global-targets']} data-testid="memory-targets">
          <span className="label">投影目标</span>
          <div className="target-chips">
            {AGENTS.map((a) => {
              const activeTarget = targets.includes(a)
              const busy = updatingTarget === a
              return (
                <button
                  key={a}
                  type="button"
                  className="target-chip"
                  data-state={activeTarget ? 'on' : 'off'}
                  style={{ ['--c' as string]: agentColor[a] }}
                  aria-pressed={activeTarget}
                  data-tooltip={
                    busy
                      ? '更新中…'
                      : activeTarget
                        ? `${agentShort[a]} 点击取消投影目标`
                        : `${agentShort[a]} 点击添加投影目标`
                  }
                  disabled={!!updatingTarget || projecting}
                  onClick={() => void toggleProjectionTarget(a)}
                >
                  {agentShort[a]}
                </button>
              )
            })}
          </div>
        </div>
        <div className={styles['mem-list-scroll']}>
          {loading && <div className={styles['mem-empty']}>加载中…</div>}
          {!loading && memories.length === 0 && (
            <div className={styles['mem-empty']}>
              无 memory
              <br />
              <span className={styles['add-link']} onClick={() => setCreating(true)}>
                点此创建第一份
              </span>
            </div>
          )}
          {memories.map((m) => {
            const isActive = active === m.name
            return (
              <div
                key={m.name}
                className={cn(styles['mem-item'], selected === m.name && styles.sel)}
                data-testid={`memory-row-${m.name}`}
                onClick={() => select(m.name)}
              >
                <button
                  type="button"
                  className={cn(styles['mem-active-dot'], !isActive && styles.dim)}
                  aria-label={isActive ? `取消激活 memory ${m.name}` : `激活 memory ${m.name}`}
                  aria-pressed={isActive}
                  data-state={isActive ? 'active' : 'inactive'}
                  data-tooltip={isActive ? '已激活，点击取消' : '未激活，点击设为投影'}
                  title={isActive ? '已激活，点击取消' : '未激活，点击设为投影'}
                  onClick={(event) => {
                    event.stopPropagation()
                    activate(isActive ? null : m.name)
                  }}
                />
                <span className={styles['mem-name']}>{m.name}</span>
                <span className={styles['mem-actions']} onClick={(e) => e.stopPropagation()}>
                  <IconButton
                    label={`重命名 memory ${m.name}`}
                    tooltip="重命名"
                    onClick={() => {
                      setRenaming(m.name)
                      setDraftName(m.name)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={`删除 memory ${m.name}`}
                    tooltip="删除"
                    tone="danger"
                    onClick={() => setDeleting(m.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </span>
              </div>
            )
          })}
        </div>
      </aside>

      <main className={styles['mem-main']}>
        {selected ? (
          <div className={styles['mem-detail-body']}>
            <MemoryEditor
              repo={repoPath}
              name={selected}
              content={selectedContent}
              onSave={save}
              targets={targets}
              contextLabel={selected}
            />
          </div>
        ) : (
          <div className={styles['mem-placeholder']}>选择或新建一份 memory 开始</div>
        )}
      </main>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建 memory" width={360}>
        <input
          autoFocus
          className={styles['mem-new-input']}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="name (如 v1, v2, default)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={create} disabled={!draftName.trim()}>
            创建
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={`重命名 ${renaming ?? ''}`}
        width={360}
      >
        <input
          autoFocus
          className={styles['mem-new-input']}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doRename()
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={doRename} disabled={!draftName.trim()}>
            重命名
          </Button>
        </div>
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="删除 memory" width={360}>
        <p style={{ color: 'var(--text)', fontSize: 13 }}>
          确认删除 <strong>{deleting}</strong>？此操作不可撤销。
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
            取消
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ color: 'var(--error)' }}
            onClick={() => deleting && del(deleting)}
          >
            删除
          </Button>
        </div>
      </Modal>
    </div>
  )
}
