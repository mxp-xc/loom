import { useEffect, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { inputStyle } from '@/lib/styles'
import { Segmented } from './Segmented'
import { sourceIdentity, type SkillSource } from '@loom/core'
import { sortSkillMembers, type ScanMember } from './types'
import { useManifestOperations } from '@/hooks/useManifestOperations'
import { SelectableList, type SelectableListItem } from '@/components/ui/selectable-list'

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

export default function EditSourceModal({ repoPath, source, showToast, onClose, onSaved }: Props) {
  const [type, setType] = useState<'branch' | 'tag'>('branch')
  const [ref, setRef] = useState('')
  const [scan, setScan] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [refsLoading, setRefsLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [members, setMembers] = useState<ScanMember[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useManifestOperations(repoPath, { onError: setError, onToast: showToast })
  const { loadSourceRefs, scanSourceMembers, saveSource } = operations

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
      setScan('')
      setError(null)
      return
    }
    let active = true
    const url = source.url
    const initType = source.type ?? 'branch'
    const initScan = source.scan ?? ''
    const existing = new Set((source.members ?? []).map((m) => m.name))
    setType(initType)
    setRef(source.ref ?? '')
    setScan(initScan)
    setError(null)
    setMembers([])
    setBranches([])
    setTags([])
    setSelected(new Set())

    void (async () => {
      setRefsLoading(true)
      try {
        const res = await loadSourceRefs(url, { shouldNotify: () => active })
        if (!active) return
        if (res.ok) {
          const br = res.result?.branches ?? []
          const tg = res.result?.tags ?? []
          setBranches(br)
          setTags(tg)
          const list = initType === 'tag' ? tg : br
          setRef(source.ref && list.includes(source.ref) ? source.ref : (list[0] ?? ''))
        } else {
          setError(res.message || '获取 refs 失败')
        }
      } finally {
        if (active) setRefsLoading(false)
      }
    })()

    void (async () => {
      setScanning(true)
      try {
        const res = await scanSourceMembers(url, {
          shouldNotify: () => active,
          ref: source.ref,
          type: initType,
          scan: initScan,
        })
        if (!active) return
        if (res.ok && Array.isArray(res.result?.members)) {
          const scanned = res.result.members as ScanMember[]
          setMembers(sortSkillMembers(scanned))
          // Pre-select scanned members that are already configured on the source.
          setSelected(new Set(scanned.filter((m) => existing.has(m.name)).map((m) => m.name)))
        } else if (!res.ok) {
          setError(res.message || '扫描失败')
        }
      } finally {
        if (active) setScanning(false)
      }
    })()

    return () => {
      active = false
    }
  }, [loadSourceRefs, scanSourceMembers, source])

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
      const res = await saveSource({ source, ref, type, scan, members: [...selected] })
      if (res.ok) {
        onSaved()
      } else {
        setError(res.message || '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleScan = async () => {
    if (!source) return
    setScanning(true)
    setError(null)
    const existing = new Set((source.members ?? []).map((m) => m.name))
    try {
      const res = await scanSourceMembers(source.url, {
        ref,
        type,
        scan,
      })
      if (res.ok && Array.isArray(res.result?.members)) {
        const scanned = res.result.members as ScanMember[]
        setMembers(sortSkillMembers(scanned))
        setSelected(new Set(scanned.filter((m) => existing.has(m.name)).map((m) => m.name)))
      } else if (!res.ok) {
        setError(res.message || '扫描失败')
      }
    } finally {
      setScanning(false)
    }
  }

  if (!source) return null

  const repoId = sourceIdentity(source).repoId
  const refOptions = type === 'tag' ? tags : branches
  const listItems: SelectableListItem[] = members.map((member) => ({
    id: member.name,
    label: member.name,
    searchText: member.name,
    disabled: member.installed,
    meta: member.installed ? '已安装' : undefined,
  }))

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

      <div style={{ marginBottom: 14 }}>
        <label className="label" htmlFor="edit-source-scan-pattern">
          scan pattern
        </label>
        <input
          id="edit-source-scan-pattern"
          aria-label="scan pattern"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          placeholder="**/SKILL.md"
          style={inputStyle}
        />
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: mono,
          }}
        >
          留空使用默认 <code style={{ fontFamily: mono }}>**/SKILL.md</code>
        </div>
      </div>

      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleScan()}
        disabled={scanning}
        style={{ width: '100%', marginBottom: 14 }}
      >
        {scanning ? '扫描中…' : 'Scan'}
      </Button>

      {scanning ? (
        <div className="selectable-list-empty">扫描中…</div>
      ) : (
        <SelectableList
          ariaLabel={'Edit Source · ' + repoId}
          items={listItems}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          searchPlaceholder="搜索 skill…"
          showSearch={members.length > 0}
          showSelectionActions={members.length > 0}
          emptyMessage="未发现 SKILL.md"
          noMatchesMessage="无匹配"
        />
      )}

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
