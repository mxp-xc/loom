import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Files, Plus, Search, Trash2 } from 'lucide-react'
import { AGENT_IDS, applicableAgents, type AgentId } from '@loom/core'
import { api } from '@/lib/api'
import { agentName } from '@/lib/agents'
import MemoryEditor from '@/components/MemoryEditor'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { AgentChip } from '@/components/ui/AgentChip'
import { useToast } from '@/hooks/useToast'
import { useManifest } from '@/hooks/useManifest'
import styles from './Memory.module.css'

interface Props {
  repoPath: string
}

interface MemoryEntry {
  name: string
  agents: AgentId[]
}

interface AgentConflict {
  agent: AgentId
  previous: string
  next: string
}

export default function Memory({ repoPath }: Props) {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedContent, setSelectedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [conflict, setConflict] = useState<AgentConflict | null>(null)
  const [draftName, setDraftName] = useState('')
  const [updatingAgent, setUpdatingAgent] = useState<AgentId | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const contentRequestRef = useRef(0)
  const { showToast, showErrorToast } = useToast()
  const { manifest } = useManifest(repoPath)
  const agents = applicableAgents(manifest?.config?.agents, 'memory')

  const readContent = async (name: string) => {
    const response = await api.getMemoryContent(repoPath, name)
    return response.content ?? ''
  }

  const load = async (preferred: string | null = selected, reloadContent = true) => {
    const requestId = ++contentRequestRef.current
    try {
      const response = await api.getMemory(repoPath)
      const nextMemories = response.memories.map((memory) => ({
        name: memory.name,
        agents: (memory.agents ?? []).filter((agent): agent is AgentId =>
          AGENT_IDS.includes(agent as AgentId),
        ),
      }))
      const nextSelected =
        (preferred && nextMemories.some((memory) => memory.name === preferred)
          ? preferred
          : nextMemories.find((memory) => memory.agents.length > 0)?.name) ??
        nextMemories[0]?.name ??
        null
      const nextContent = reloadContent && nextSelected ? await readContent(nextSelected) : null
      if (requestId !== contentRequestRef.current) return
      setMemories(nextMemories)
      setSelected(nextSelected)
      if (reloadContent) setSelectedContent(nextContent ?? '')
    } catch (error) {
      console.error({ err: error }, 'Failed to load memory list')
      showErrorToast(error, { title: 'Memory 加载失败', message: '请稍后重试' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(null)
  }, [repoPath])

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      menuTriggerRef.current?.focus()
    }
    window.addEventListener('keydown', closeMenu)
    return () => window.removeEventListener('keydown', closeMenu)
  }, [menuOpen])

  const visibleMemories = useMemo(
    () =>
      memories.filter((memory) => memory.name.toLowerCase().includes(search.trim().toLowerCase())),
    [memories, search],
  )
  const selectedMemory = memories.find((memory) => memory.name === selected) ?? null
  const selectedApplicableAgents =
    selectedMemory?.agents.filter((agent) => agents.includes(agent)) ?? []
  const assignedMemory = (agent: AgentId) =>
    memories.find((memory) => memory.agents.includes(agent))?.name ?? null

  const performSelection = async (name: string) => {
    const requestId = ++contentRequestRef.current
    try {
      const content = await readContent(name)
      if (requestId !== contentRequestRef.current) return
      setSelected(name)
      setSelectedContent(content)
    } catch (error) {
      if (requestId !== contentRequestRef.current) return
      console.error({ err: error }, 'Failed to select memory')
      showErrorToast(error, { title: 'Memory 内容加载失败', message: '请选择其他 Memory 后重试' })
    }
  }

  const selectMemory = (name: string) => {
    setMenuOpen(false)
    setSearch('')
    if (name === selected) return
    if (editorDirty) {
      setPendingSelection(name)
      return
    }
    void performSelection(name)
  }

  const applyAgent = async (agent: AgentId, name: string | null) => {
    setUpdatingAgent(agent)
    try {
      await api.updateMemoryAgent({ repo: repoPath, agent, name })
      const projected = (await api.project({ repo: repoPath, scope: 'memory' })) as {
        ok?: boolean
        message?: string
        error?: string
      }
      if (projected.ok === false)
        throw new Error(projected.message ?? projected.error ?? '投影失败')
      await load(selected, false)
      showToast('Agent 投影已更新')
    } catch (error) {
      console.error({ err: error }, 'Failed to update memory agent')
      await load(selected, false)
      showErrorToast(error, { title: 'Agent 投影更新失败', message: '请检查配置后重试' })
    } finally {
      setUpdatingAgent(null)
      setConflict(null)
    }
  }

  const toggleAgent = (name: string, agent: AgentId) => {
    const previous = assignedMemory(agent)
    if (previous === name) {
      void applyAgent(agent, null)
      return
    }
    if (previous) {
      setConflict({ agent, previous, next: name })
      return
    }
    void applyAgent(agent, name)
  }
  const create = async () => {
    const name = draftName.trim()
    if (!name) return
    try {
      await api.createMemory({ repo: repoPath, name })
      setCreating(false)
      setDraftName('')
      await load(name)
      showToast('已创建')
    } catch (error) {
      console.error({ err: error }, 'Failed to create memory')
      showErrorToast(error, { title: 'Memory 创建失败', message: '请检查名称后重试' })
    }
  }

  const rename = async () => {
    const newName = draftName.trim()
    if (!renaming || !newName) return
    try {
      await api.renameMemory({ repo: repoPath, name: renaming, newName })
      const nextSelected = selected === renaming ? newName : selected
      setRenaming(null)
      setDraftName('')
      await load(nextSelected)
      showToast('已重命名')
    } catch (error) {
      console.error({ err: error }, 'Failed to rename memory')
      showErrorToast(error, { title: 'Memory 重命名失败', message: '请检查名称后重试' })
    }
  }

  const remove = async (name: string) => {
    try {
      await api.deleteMemory(repoPath, name)
      setDeleting(null)
      await load(selected === name ? null : selected, selected === name)
      showToast('已删除')
    } catch (error) {
      console.error({ err: error }, 'Failed to delete memory')
      showErrorToast(error, { title: 'Memory 删除失败', message: '请稍后重试' })
    }
  }

  const save = async (content: string) => {
    if (!selected) return
    try {
      await api.saveMemoryContent({ repo: repoPath, name: selected, content })
      setSelectedContent(content)
      if (selectedMemory?.agents.length) {
        const projected = (await api.project({ repo: repoPath, scope: 'memory' })) as {
          ok?: boolean
          message?: string
          error?: string
        }
        if (projected.ok === false)
          throw new Error(projected.message ?? projected.error ?? 'Memory 已保存，但投影失败')
      }
      showToast('已保存')
    } catch (error) {
      console.error({ err: error }, 'Failed to save and project memory')
      showErrorToast(error, {
        title: 'Memory 保存失败',
        message: '内容可能已保存，请检查投影配置后重试',
      })
      throw error
    }
  }

  const toolbarStart = (
    <>
      <div className={styles.memoryControl} ref={menuRef}>
        <button
          ref={menuTriggerRef}
          className={styles.memoryTrigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span>Memory</span>
          <i />
          <strong>{selected ?? (loading ? '加载中…' : '选择 Memory')}</strong>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <div className={styles.memoryMenu} role="menu" aria-label="Memory 列表">
            <label className={styles.memorySearch}>
              <Search className="h-3.5 w-3.5" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索 Memory"
                aria-label="搜索 Memory"
              />
            </label>
            <div className={styles.memoryOptions}>
              {visibleMemories.map((memory) => (
                <div
                  className={styles.memoryOption}
                  data-selected={selected === memory.name ? 'true' : undefined}
                  key={memory.name}
                >
                  <button
                    type="button"
                    className={styles.memorySelect}
                    onClick={() => selectMemory(memory.name)}
                  >
                    <span>{selected === memory.name ? <Check /> : <Files />}</span>
                    <strong>{memory.name}</strong>
                  </button>
                  <div className={styles.memoryRowAgents}>
                    {agents.map((agent) => {
                      const assigned = assignedMemory(agent)
                      const active = assigned === memory.name
                      return (
                        <AgentChip
                          key={agent}
                          agent={agent}
                          state={active ? 'on' : 'off'}
                          className={!active && assigned ? styles.occupiedAgent : undefined}
                          label={
                            active
                              ? `${memory.name} 已投影到 ${agentName[agent]}`
                              : `${memory.name} 投影到 ${agentName[agent]}`
                          }
                          tooltip={
                            active
                              ? `取消投影到 ${agentName[agent]}`
                              : assigned
                                ? `${agentName[agent]} 当前使用 ${assigned}，点击切换`
                                : `投影到 ${agentName[agent]}`
                          }
                          disabled={updatingAgent !== null}
                          onClick={() => toggleAgent(memory.name, agent)}
                        />
                      )
                    })}
                  </div>
                  <IconButton
                    label={`删除 ${memory.name}`}
                    tooltip="删除"
                    tone="danger"
                    onClick={() => {
                      if (editorDirty && memory.name !== selected) {
                        showToast('请先保存当前更改')
                        return
                      }
                      setDeleting(memory.name)
                      setMenuOpen(false)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              ))}
            </div>
            <button
              type="button"
              className={styles.createMemory}
              role="menuitem"
              onClick={() => {
                if (editorDirty) {
                  showToast('请先保存当前更改')
                  return
                }
                setCreating(true)
                setDraftName('')
                setMenuOpen(false)
              }}
            >
              <span>
                <Plus className="h-3.5 w-3.5" />
              </span>
              <strong>新建 Memory</strong>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      {selectedMemory && agents.length > 0 && (
        <div className={styles.currentAgents} aria-label="当前 Memory 投影 Agent">
          <span>投影到</span>
          {agents.map((agent) => {
            const assigned = assignedMemory(agent)
            return (
              <AgentChip
                key={agent}
                agent={agent}
                state={assigned === selected ? 'on' : 'off'}
                className={assigned && assigned !== selected ? styles.occupiedAgent : undefined}
                label={`${selected} 投影到 ${agentName[agent]}`}
                tooltip={
                  assigned && assigned !== selected
                    ? `${agentName[agent]} 当前使用 ${assigned}，点击切换`
                    : agentName[agent]
                }
                disabled={updatingAgent !== null}
                onClick={() => toggleAgent(selected!, agent)}
              />
            )
          })}
        </div>
      )}
    </>
  )

  return (
    <div className={styles.memoryPage} data-testid="memory-layout">
      {selected ? (
        <MemoryEditor
          repo={repoPath}
          name={selected}
          content={selectedContent}
          onSave={save}
          onDirtyChange={setEditorDirty}
          agents={agents}
          assignedAgents={selectedApplicableAgents}
          contextLabel={selected}
          toolbarStart={toolbarStart}
          onRename={() => {
            if (editorDirty) {
              showToast('请先保存当前更改')
              return
            }
            setRenaming(selected)
            setDraftName(selected)
          }}
          onDelete={() => {
            if (editorDirty) {
              showToast('请先保存当前更改')
              return
            }
            setDeleting(selected)
          }}
        />
      ) : (
        <div className={styles.emptyState}>
          <Files className="h-6 w-6" />
          <strong>{loading ? '正在加载 Memory' : '还没有 Memory'}</strong>
          {!loading && (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              新建 Memory
            </Button>
          )}
        </div>
      )}

      <Modal
        open={pendingSelection !== null}
        onClose={() => setPendingSelection(null)}
        title="放弃未保存更改"
        width={420}
      >
        <p className={styles.modalText}>当前 Memory 还有未保存的内容。</p>
        <div className={styles.modalActions}>
          <Button variant="ghost" size="sm" onClick={() => setPendingSelection(null)}>
            继续编辑
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              const next = pendingSelection
              setPendingSelection(null)
              if (next) void performSelection(next)
            }}
          >
            放弃并切换
          </Button>
        </div>
      </Modal>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建 Memory" width={380}>
        <input
          autoFocus
          className={styles.nameInput}
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void create()}
          placeholder="memory-name"
        />
        <div className={styles.modalActions}>
          <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void create()}
            disabled={!draftName.trim()}
          >
            创建
          </Button>
        </div>
      </Modal>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="重命名 Memory"
        width={380}
      >
        <input
          autoFocus
          className={styles.nameInput}
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void rename()}
        />
        <div className={styles.modalActions}>
          <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void rename()}
            disabled={!draftName.trim()}
          >
            重命名
          </Button>
        </div>
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="删除 Memory"
        width={380}
      >
        <p className={styles.modalText}>
          确认删除 <strong>{deleting}</strong>？它占用的 Agent 将同时释放。
        </p>
        <div className={styles.modalActions}>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
            取消
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={styles.dangerButton}
            onClick={() => deleting && void remove(deleting)}
          >
            删除
          </Button>
        </div>
      </Modal>

      <Modal
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title={conflict ? `切换 ${agentName[conflict.agent]} 的 Memory` : ''}
        width={420}
      >
        {conflict && (
          <>
            <p className={styles.modalText}>
              <strong>{agentName[conflict.agent]}</strong> 当前使用 <code>{conflict.previous}</code>
              ，切换后将改为 <code>{conflict.next}</code>。
            </p>
            <div className={styles.modalActions}>
              <Button variant="ghost" size="sm" onClick={() => setConflict(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void applyAgent(conflict.agent, conflict.next)}
              >
                确认切换
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
