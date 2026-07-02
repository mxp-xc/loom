import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Modal from '@/components/Modal'
import { inputStyle } from '@/lib/styles'
import type { ScanMember } from './types'

interface Props {
  open: boolean
  repoPath: string
  reload: () => void
  onClose: () => void
}

const refreshBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 34,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 15,
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  cursor: 'pointer',
}

export default function AddSkillModal({ open, repoPath, reload, onClose }: Props) {
  const [addTab, setAddTab] = useState<'local' | 'source'>('local')
  const [addBusy, setAddBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState('')
  const [srcUrl, setSrcUrl] = useState('')
  const [srcRef, setSrcRef] = useState('main')
  const [scanning, setScanning] = useState(false)
  const [scanMembers, setScanMembers] = useState<ScanMember[]>([])
  const [scanSelected, setScanSelected] = useState<Set<string>>(new Set())

  // Reset the form each time the modal opens (mirrors the original
  // resetAddForm that ran right before setAddOpen(true)).
  useEffect(() => {
    if (!open) return
    setAddErr(null)
    setLocalPath('')
    setSrcUrl('')
    setSrcRef('main')
    setAddTab('local')
    setScanMembers([])
    setScanSelected(new Set())
  }, [open])

  const handleScan = async () => {
    if (scanning) return
    if (!srcUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    setScanning(true)
    setAddErr(null)
    setScanMembers([])
    try {
      const res = (await api.scanSource(srcUrl.trim())) as any
      if (Array.isArray(res.members)) {
        setScanMembers(res.members)
        setScanSelected(
          new Set(
            res.members.filter((m: ScanMember) => !m.installed).map((m: ScanMember) => m.name),
          ),
        )
      } else {
        setAddErr(res.message || '扫描失败')
      }
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  const handleAddLocal = async () => {
    const path = localPath.trim()
    if (!path) {
      setAddErr('path 不能为空')
      return
    }
    const id =
      path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() ?? ''
    if (!id) {
      setAddErr('无法从 path 提取 id')
      return
    }
    setAddBusy(true)
    setAddErr(null)
    try {
      await api.addLocalSkill({ repoPath, skill: { id, path } })
      onClose()
      reload()
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const handleAddSource = async () => {
    if (!srcUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    setAddBusy(true)
    setAddErr(null)
    try {
      await api.addSource({ repoPath, url: srcUrl.trim(), ref: srcRef.trim() || 'main' })
      onClose()
      reload()
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const derivedLocalId = localPath.trim()
    ? (localPath
        .trim()
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() ?? '')
    : ''

  return (
    <Modal open={open} onClose={onClose} title="Add Skill">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {(['local', 'source'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setAddTab(tab)
              setAddErr(null)
            }}
            style={{
              flex: 1,
              padding: '6px 0',
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 500,
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              background: addTab === tab ? 'var(--bg)' : 'transparent',
              color: addTab === tab ? 'var(--bright)' : 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            {tab === 'local' ? 'Local Skill' : 'Source'}
          </button>
        ))}
      </div>

      {addErr && (
        <div
          style={{
            marginBottom: 12,
            padding: 8,
            borderRadius: 'var(--radius)',
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            color: 'var(--error)',
            border: '1px solid var(--error)',
            background: 'var(--card)',
          }}
        >
          {addErr}
        </div>
      )}

      {addTab === 'local' ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <span className="label">
              path <span style={{ color: 'var(--error)' }}>*</span>
            </span>
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="./assets/skills/my-skill"
              style={inputStyle}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
              本地 skill 目录路径，id 将从目录名自动提取
            </div>
            <div
              style={{
                marginTop: 4,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: 'var(--signal)',
              }}
            >
              id: {derivedLocalId || '—'}
            </div>
          </div>
          <button
            className="add-btn"
            onClick={handleAddLocal}
            disabled={addBusy}
            style={{ width: '100%' }}
          >
            {addBusy ? '添加中…' : '添加 Local Skill'}
          </button>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <span className="label">
              url <span style={{ color: 'var(--error)' }}>*</span>
            </span>
            <input
              value={srcUrl}
              onChange={(e) => setSrcUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <span className="label">ref</span>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                value={srcRef}
                onChange={(e) => setSrcRef(e.target.value)}
                onBlur={() => {
                  if (srcUrl.trim()) handleScan()
                }}
                placeholder="main"
                style={{ ...inputStyle, marginTop: 0, flex: 1 }}
              />
              <button onClick={handleScan} disabled={scanning} title="扫描" style={refreshBtnStyle}>
                {scanning ? '...' : '↻'}
              </button>
            </div>
          </div>
          {scanMembers.length > 0 && (
            <div
              style={{
                marginBottom: 14,
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                maxHeight: 200,
                overflow: 'auto',
              }}
            >
              {scanMembers.map((m) => (
                <label
                  key={m.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderBottom: '1px solid var(--border)',
                    cursor: m.installed ? 'default' : 'pointer',
                    opacity: m.installed ? 0.5 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={scanSelected.has(m.name)}
                    disabled={m.installed}
                    onChange={(e) => {
                      setScanSelected((prev) => {
                        const n = new Set(prev)
                        if (e.target.checked) n.add(m.name)
                        else n.delete(m.name)
                        return n
                      })
                    }}
                  />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    {m.name}
                  </span>
                  {m.installed && (
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>(已安装)</span>
                  )}
                </label>
              ))}
            </div>
          )}
          <button
            className="add-btn"
            onClick={handleAddSource}
            disabled={addBusy}
            style={{ width: '100%' }}
          >
            {addBusy ? '添加中…' : '添加 Source'}
          </button>
        </>
      )}
    </Modal>
  )
}
