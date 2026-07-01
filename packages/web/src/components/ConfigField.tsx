import { useState } from 'react'
import { api } from '@/lib/api'

export type ConfigLevel = 'effective' | 'repo' | 'local'

function formatValue(v: unknown): string {
  if (v == null) return '(空)'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return '[object]' }
  }
  return String(v)
}

export function ConfigField({
  name, value, level, inRepo, inLocal, fixed, repoPath, onSaved,
}: {
  name: string
  value: unknown
  level: ConfigLevel
  inRepo: boolean
  inLocal: boolean
  fixed: boolean
  repoPath: string
  onSaved?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(formatValue(value))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  let dotClass = ''
  let title = ''
  if (fixed) { dotClass = 'sdot-cfg fixed'; title = '固定本地级' }
  else if (level === 'effective') {
    if (inLocal) { dotClass = 'sdot-cfg local'; title = '生效自本地级' }
    else if (inRepo) { dotClass = 'sdot-cfg repo'; title = '生效自仓库级' }
    else { dotClass = 'sdot-cfg inherit'; title = '两处未设' }
  } else if (level === 'local') {
    dotClass = inLocal ? 'sdot-cfg local' : 'sdot-cfg inherit'
    title = inLocal ? '本地覆盖' : '继承仓库级'
  }

  const canEdit = level !== 'effective' && !fixed

  const handleSave = async () => {
    if (level === 'effective') return
    setSaving(true); setErr(null)
    try {
      let parsed: unknown = editValue
      if (editValue.startsWith('[') || editValue.startsWith('{')) {
        parsed = JSON.parse(editValue)
      } else if (editValue === '(空)' || editValue === '') {
        parsed = null
      }
      await api.putConfig({ repoPath, level: level as 'repo' | 'local', field: name, value: parsed })
      setEditing(false)
      onSaved?.()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="flex items-center gap-2" style={{ padding: '10px 16px' }}>
      {dotClass && <span className={dotClass} title={title} />}
      <span style={{ width: 160, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--text)' }}>{name}</span>
      {editing ? (
        <>
          <input
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            style={{ flex: 1, padding: '4px 8px', fontSize: 13, fontFamily: "'Fira Code', monospace",
              border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }}
            autoFocus
          />
          <button className="gbtn" onClick={handleSave} disabled={saving} style={{ color: 'var(--signal)' }}>
            {saving ? '...' : '✓'}
          </button>
          <button className="gbtn" onClick={() => { setEditing(false); setEditValue(formatValue(value)) }}>x</button>
          {err && <span style={{ fontSize: 11, color: 'var(--error)' }}>{err}</span>}
        </>
      ) : (
        <>
          <span style={{ flex: 1, fontFamily: "'Fira Code', monospace", fontSize: 13, color: 'var(--muted)' }}>
            {formatValue(value)}
          </span>
          {canEdit && (
            <button className="gbtn" onClick={() => { setEditing(true); setEditValue(formatValue(value)) }}>编辑</button>
          )}
        </>
      )}
    </div>
  )
}
