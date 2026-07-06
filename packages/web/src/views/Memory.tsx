import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { agentShort, agentColor, type AgentId } from '@/lib/agents'
import MemoryEditor from '@/components/MemoryEditor'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { useToast } from '@/hooks/useToast'
import { useManifest } from '@/hooks/useManifest'
import { Pencil, Plus, RefreshCw, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'

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
  const { showToast } = useToast()
  const { manifest, reload } = useManifest(repoPath)
  const targets = manifest?.config?.targets ?? []

  const toggleTarget = async (a: AgentId) => {
    const cur = manifest?.config?.targets ?? []
    const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]
    try {
      await api.putConfig({ repo: repoPath, level: 'local', field: 'targets', value: next })
      reload()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

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
    } catch {
      setSelectedContent('')
    }
  }

  const project = async () => {
    setProjecting(true)
    try {
      const res = (await api.project({ repo: repoPath, scope: 'memory' })) as any
      if (res.ok) showToast('投影完成')
      else showToast(res.message || '投影失败')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setProjecting(false)
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
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const activate = async (name: string | null) => {
    try {
      await api.setMemoryActive({ repo: repoPath, name })
      await load()
      showToast(name ? `已激活 ${name}` : '已取消激活')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const save = async (content: string) => {
    if (!selected) return
    await api.saveMemoryContent({ repo: repoPath, name: selected, content })
    if (selected === active) setActiveContent(content)
    showToast('已保存')
  }

  const agentKey = (a: AgentId) => (a === 'claude-code' ? 'cc' : a === 'codex' ? 'cx' : 'oc')

  return (
    <div className="mem-layout">
      <aside className="mem-list">
        <div className="mem-list-head">
          <span className="label">memories</span>
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
        <div className="mem-global-targets">
          <span className="label">投影目标</span>
          <div className="cfg-chips">
            {targets.map((a) => (
              <button
                key={a}
                type="button"
                className={'achip ' + (targets.includes(a) ? 'on' : 'off')}
                data-a={agentKey(a)}
                style={{ ['--c' as string]: agentColor[a] }}
                aria-pressed={targets.includes(a)}
                onClick={() => toggleTarget(a)}
              >
                {agentShort[a]}
              </button>
            ))}
          </div>
        </div>
        <div className="mem-list-scroll">
          {loading && <div className="mem-empty">加载中…</div>}
          {!loading && memories.length === 0 && (
            <div className="mem-empty">
              无 memory
              <br />
              <span className="add-link" onClick={() => setCreating(true)}>
                点此创建第一份
              </span>
            </div>
          )}
          {memories.map((m) => (
            <div
              key={m.name}
              className={'mem-item' + (selected === m.name ? ' sel' : '')}
              onClick={() => select(m.name)}
            >
              <span
                className={'mem-active-dot' + (active === m.name ? '' : ' dim')}
                title={active === m.name ? '已激活(将投影)' : '未激活'}
              />
              <span className="mem-name">{m.name}</span>
              <span className="mem-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton
                  label={active === m.name ? `取消激活 memory ${m.name}` : `激活 memory ${m.name}`}
                  tooltip={active === m.name ? '取消激活' : '激活'}
                  pressed={active === m.name}
                  tone={active === m.name ? 'success' : 'default'}
                  onClick={() => activate(active === m.name ? null : m.name)}
                >
                  {active === m.name ? (
                    <ToggleRight className="h-3.5 w-3.5" />
                  ) : (
                    <ToggleLeft className="h-3.5 w-3.5" />
                  )}
                </IconButton>
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
          ))}
        </div>
      </aside>

      <main className="mem-main">
        {selected ? (
          <>
            <div className="mem-detail-head">
              <span className="mem-detail-name">{selected}</span>
              <IconButton
                label="投影 memory"
                tooltip={projecting ? '投影中…' : '投影'}
                onClick={project}
                disabled={projecting}
                style={{ marginLeft: 'auto' }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            <div className="mem-detail-body">
              <MemoryEditor
                repo={repoPath}
                name={selected}
                content={selectedContent}
                onSave={save}
                targets={targets}
              />
            </div>
          </>
        ) : (
          <div className="mem-placeholder">选择或新建一份 memory 开始</div>
        )}
      </main>

      <Modal open={creating} onClose={() => setCreating(false)} title="新建 memory" width={360}>
        <input
          autoFocus
          className="mem-new-input"
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
          className="mem-new-input"
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
