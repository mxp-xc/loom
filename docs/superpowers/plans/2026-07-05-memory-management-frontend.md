# Memory 页面前端实现(优化版)

由 `ui-ux-pro-max` + `frontend-design` 产出,贴合 loom 现有设计系统。plan Task 15/16 以此为权威实现。

## 设计说明

- **复用现有 class**:`.cfg-seg`/`.cfg-seg-opt`(三视图 tab)、`.cfg-chips`/`.achip`(agent 选择)、`.chip`(targets 只读)、`.md-preview`(markdown 渲染)、`.label`、Button 组件
- **激活态 vs 选中态**:激活(将投影)用 signal 绿点 + glow(`.mem-active-dot`);选中(编辑中)用 `.mem-item.sel`(`.mcp.sel` 同款左条+渐变)。两者独立
- **占位符高亮**:`.ph-var`(绿色调,会解析)vs `.ph-esc`(灰色,字面不解析),IDE 感
- **操作按钮**:hover/选中时才显示(`.mem-actions` opacity 0→1),减少视觉噪音
- **空状态**:列表空 + 未选中都有引导
- 全程 CSS 变量,暗色模式自适应

## MemoryEditor.tsx

```tsx
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
}

// Highlight ${VAR}/${VAR:fallback} and \${...} escapes for the overlay layer.
// HTML-escape first, then wrap matches in spans (escape before var so \${} wins).
function highlight(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/\\\$\{[^}]*\}/g, (m) => `<span class="ph-esc">${m}</span>`)
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}/g, (m) => `<span class="ph-var">${m}</span>`)
}

export default function MemoryEditor({ repo, name, content, onSave }: Props) {
  const [view, setView] = useState<View>('edit')
  const [edit, setEdit] = useState(content)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [agent, setAgent] = useState<AgentId>('claude-code')
  const [resolved, setResolved] = useState('')
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setEdit(content)
    setDirty(false)
  }, [content, name])

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
            {AGENTS.map((a) => (
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
```

## Memory.tsx

```tsx
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { AGENTS, agentShort, agentColor, type AgentId } from '@/lib/agents'
import MemoryEditor from '@/components/MemoryEditor'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/useToast'

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
  const { showToast } = useToast()

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
    if (!confirm(`删除 ${name}?此操作不可撤销。`)) return
    try {
      await api.deleteMemory(repoPath, name)
      if (selected === name) {
        setSelected(null)
        setSelectedContent('')
      }
      await load()
      showToast('已删除')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const activate = async (name: string) => {
    try {
      await api.setMemoryActive({ repo: repoPath, name })
      await load()
      showToast(`已激活 ${name}`)
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
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setCreating(true)
              setDraftName('')
            }}
          >
            + 新建
          </Button>
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
                {active !== m.name && (
                  <button className="mem-act activate" onClick={() => activate(m.name)}>
                    激活
                  </button>
                )}
                <button
                  className="mem-act"
                  onClick={() => {
                    setRenaming(m.name)
                    setDraftName(m.name)
                  }}
                >
                  改名
                </button>
                <button className="mem-act danger" onClick={() => del(m.name)}>
                  删
                </button>
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
              <span className="mem-detail-targets">
                {AGENTS.map((a) => (
                  <span
                    key={a}
                    className="chip active"
                    style={{ ['--c' as string]: agentColor[a] }}
                    title={a}
                  >
                    {agentShort[a]}
                  </span>
                ))}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={project}
                disabled={projecting}
                style={{ marginLeft: 'auto' }}
              >
                {projecting ? '投影中…' : '投影'}
              </Button>
            </div>
            <div className="mem-detail-body">
              <MemoryEditor
                repo={repoPath}
                name={selected}
                content={selectedContent}
                onSave={save}
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
    </div>
  )
}
```

## index.css 追加

```css
/* ===== memory editor ===== */
.mem-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.mem-toolbar .cfg-chips {
  margin-left: auto;
}
.mem-save {
  margin-left: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 5px 12px;
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-fg);
  border: none;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.mem-save:hover:not(:disabled) {
  box-shadow: 0 0 12px rgba(16, 185, 129, 0.25);
}
.mem-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mem-edit-wrap {
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--card);
  overflow: hidden;
  transition:
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.mem-edit-wrap:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 22%, transparent);
}
.mem-overlay,
.mem-textarea {
  margin: 0;
  padding: 14px 16px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
  border: 0;
}
.mem-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: transparent;
  overflow: auto;
  background: var(--card);
}
.mem-textarea {
  position: relative;
  display: block;
  width: 100%;
  min-height: 440px;
  background: transparent;
  color: var(--text);
  resize: vertical;
  outline: none;
  caret-color: var(--primary);
}
.ph-var {
  background: var(--accent);
  color: var(--primary);
  border-radius: 2px;
  padding: 1px 3px;
  font-weight: 500;
}
.ph-esc {
  background: color-mix(in srgb, var(--muted) 18%, transparent);
  color: var(--muted);
  border-radius: 2px;
  padding: 1px 3px;
  opacity: 0.75;
}
.mem-pane {
  min-height: 440px;
  padding: 16px 18px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow: auto;
}
.mem-err {
  margin-bottom: 10px;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--error);
  background: color-mix(in srgb, var(--error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-radius: var(--radius);
}

/* ===== memory page ===== */
.mem-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 0;
  height: 100%;
}
.mem-list {
  border-right: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.mem-list-head {
  display: flex;
  align-items: center;
  padding: 16px 16px 10px;
}
.mem-list-head .label {
  flex: 1;
}
.mem-list-scroll {
  flex: 1;
  overflow: auto;
  padding: 4px 0 16px;
}
.mem-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 14px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background var(--dur) var(--ease);
}
.mem-item:hover {
  background: var(--accent);
}
.mem-item.sel {
  background: linear-gradient(90deg, var(--accent), transparent);
  border-left-color: var(--signal);
}
.mem-active-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--signal);
  box-shadow: 0 0 6px color-mix(in srgb, var(--signal) 60%, transparent);
  flex-shrink: 0;
}
.mem-active-dot.dim {
  background: var(--muted);
  box-shadow: none;
  opacity: 0.3;
}
.mem-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mem-item.sel .mem-name {
  color: var(--bright);
  font-weight: 600;
}
.mem-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.mem-item:hover .mem-actions,
.mem-item.sel .mem-actions {
  opacity: 1;
}
.mem-act {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 3px 7px;
  border-radius: var(--radius);
  background: transparent;
  border: 1px solid transparent;
  color: var(--m2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.mem-act:hover {
  color: var(--text);
  background: var(--card);
  border-color: var(--border);
}
.mem-act.danger:hover {
  color: var(--error);
  border-color: color-mix(in srgb, var(--error) 35%, transparent);
}
.mem-act.activate:hover {
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 35%, transparent);
}
.mem-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.mem-empty .add-link {
  color: var(--primary);
  cursor: pointer;
  text-decoration: underline;
}
.mem-main {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.mem-detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 22px;
  border-bottom: 1px solid var(--border);
}
.mem-detail-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--bright);
}
.mem-detail-targets {
  display: flex;
  gap: 5px;
}
.mem-detail-body {
  flex: 1;
  overflow: auto;
  padding: 18px 22px;
}
.mem-placeholder {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}
.mem-new-input {
  width: 100%;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 9px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  outline: none;
}
@media (max-width: 760px) {
  .mem-layout {
    grid-template-columns: 1fr;
  }
  .mem-list {
    max-height: 240px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mem-item,
  .mem-actions,
  .mem-act,
  .mem-edit-wrap {
    transition-duration: 0.01ms;
  }
}
```
