import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { inputStyle } from '@/lib/styles'
import { Search } from 'lucide-react'
import { Segmented } from './Segmented'
import { deriveRepoId, type SkillSource } from '@loom/core'
import type { ScanMember } from './types'

interface Props {
  repoPath: string
  source: SkillSource | null
  showToast: (msg: string) => void
  onClose: () => void
  onSaved: () => void
}

const mono = "'JetBrains Mono', monospace"

const errBox: React.CSSProperties = {
  marginBottom: 12,
  padding: 8,
  borderRadius: 'var(--radius)',
  fontSize: 12,
  fontFamily: mono,
  color: 'var(--error)',
  border: '1px solid var(--error)',
  background: 'var(--card)',
}

const listBox: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  maxHeight: 240,
  overflow: 'auto',
  marginBottom: 14,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  borderBottom: '1px solid var(--border)',
}

const placeholderStyle: React.CSSProperties = {
  padding: '12px 10px',
  fontSize: 12,
  color: 'var(--muted)',
  fontFamily: mono,
}

export default function EditSourceModal({ repoPath, source, showToast, onClose, onSaved }: Props) {
  const [type, setType] = useState<'branch' | 'tag'>('branch')
  const [ref, setRef] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [refsLoading, setRefsLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [members, setMembers] = useState<ScanMember[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-initialise whenever a source is opened: pre-fill url/type/ref from
  // the source, fetch the available refs, scan the members, and pre-select
  // the members that were already configured.
  useEffect(() => {
    if (!source) {
      setMembers([])
      setSelected(new Set())
      setBranches([])
      setTags([])
      setRef('')
      setError(null)
      return
    }
    let active = true
    const url = source.url
    const initType = source.type ?? 'branch'
    const existing = new Set((source.members ?? []).map((m) => m.name))
    setType(initType)
    setRef(source.ref ?? '')
    setSearch('')
    setError(null)
    setMembers([])
    setBranches([])
    setTags([])
    setSelected(new Set())

    void (async () => {
      setRefsLoading(true)
      try {
        const res = await api.getSourceRefs(url)
        if (!active) return
        if (res.ok) {
          const br = res.branches ?? []
          const tg = res.tags ?? []
          setBranches(br)
          setTags(tg)
          const list = initType === 'tag' ? tg : br
          setRef(source.ref && list.includes(source.ref) ? source.ref : (list[0] ?? ''))
        } else {
          setError(res.message || res.error || '获取 refs 失败')
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (active) setRefsLoading(false)
      }
    })()

    void (async () => {
      setScanning(true)
      try {
        const res = await api.scanSource(url)
        if (!active) return
        if (Array.isArray(res.members)) {
          setMembers(res.members)
          // Pre-select scanned members that are already configured on the source.
          setSelected(new Set(res.members.filter((m) => existing.has(m.name)).map((m) => m.name)))
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (active) setScanning(false)
      }
    })()

    return () => {
      active = false
    }
  }, [source])

  const handleTypeChange = (t: 'branch' | 'tag') => {
    setType(t)
    const list = t === 'tag' ? tags : branches
    setRef(list[0] ?? '')
  }

  const handleSave = async () => {
    if (!source) return
    setSaving(true)
    setError(null)
    try {
      // Persist ref/type changes if they differ from the original source
      const refChanged = ref !== source.ref
      const typeChanged = type !== (source.type ?? 'branch')
      if (refChanged || typeChanged) {
        const metaRes = await api.updateSourceMeta({
          repoPath,
          url: source.url,
          ref: refChanged ? ref : undefined,
          type: typeChanged ? type : undefined,
        })
        if (!metaRes.ok) {
          setError(metaRes.message || metaRes.error || '更新 source 元信息失败')
          setSaving(false)
          return
        }
      }
      const res = await api.setSourceMembers({
        repoPath,
        url: source.url,
        members: [...selected],
      })
      if (res.ok) {
        showToast(`${deriveRepoId(source.url)} 已更新`)
        onSaved()
      } else {
        setError(res.message || res.error || '保存失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!source) return null

  const repoId = deriveRepoId(source.url)
  const refOptions = type === 'tag' ? tags : branches
  const filtered = members.filter((m) => m.name.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose()
      }}
      title={`Edit Source · ${repoId}`}
      width={560}
    >
      {error && <div style={errBox}>{error}</div>}

      <div style={{ marginBottom: 14 }}>
        <span className="label">url</span>
        <input value={source.url} readOnly style={{ ...inputStyle, marginTop: 0 }} />
      </div>

      <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
        <div style={{ flex: '0 0 120px' }}>
          <div className="label" style={{ marginBottom: 4 }}>
            type
          </div>
          <Segmented
            value={type}
            onChange={handleTypeChange}
            options={[
              { value: 'branch', label: 'branch' },
              { value: 'tag', label: 'tag' },
            ]}
          />
        </div>
        <div style={{ flex: 1 }}>
          <span className="label">ref</span>
          <select
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            disabled={refsLoading || refOptions.length === 0}
            style={{ ...inputStyle, marginTop: 0, cursor: 'pointer' }}
          >
            {refOptions.length === 0 ? (
              <option value="">{refsLoading ? '加载中…' : '—'}</option>
            ) : (
              refOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      {members.length > 0 && (
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <Search
            size={13}
            style={{
              position: 'absolute',
              left: 9,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 skill…"
            style={{ ...inputStyle, paddingLeft: 28, marginBottom: 0 }}
          />
        </div>
      )}

      <div style={listBox}>
        {scanning ? (
          <div style={placeholderStyle}>扫描中…</div>
        ) : members.length === 0 ? (
          <div style={placeholderStyle}>未发现 SKILL.md</div>
        ) : filtered.length === 0 ? (
          <div style={placeholderStyle}>无匹配</div>
        ) : (
          filtered.map((m) => {
            const checked = selected.has(m.name)
            return (
              <label key={m.path} style={{ ...rowStyle, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const n = new Set(prev)
                      if (e.target.checked) n.add(m.name)
                      else n.delete(m.name)
                      return n
                    })
                  }}
                />
                <span style={{ flex: 1, fontFamily: mono, fontSize: 12 }}>{m.name}</span>
                {m.installed && (
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: mono }}>
                    已安装
                  </span>
                )}
              </label>
            )
          })
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={handleSave} disabled={saving} style={{ flex: 1 }}>
          {saving ? '保存中…' : `保存 (${selected.size})`}
        </Button>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={saving}
          style={{ flex: '0 0 auto' }}
        >
          取消
        </Button>
      </div>
    </Modal>
  )
}
