import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import Modal from '@/components/Modal'
import { sourceIdentity, type SkillSource } from '@loom/core'
import { sortSkillMembers, type RefreshMember } from './types'
import type { ManifestOperations } from '@/hooks/useManifestOperations'

interface Props {
  source: SkillSource | null
  operations: ManifestOperations
  onClose: () => void
  onConfirm: () => void
}

export default function MemberScanModal({ source, operations, onClose, onConfirm }: Props) {
  const { refreshSourceMembers, saveSourceMembers } = operations
  const [members, setMembers] = useState<RefreshMember[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)

  // Scan runs when a source is opened. The modal stays closed while scanning
  // (matching the original flow, where the modal only appeared after the scan
  // resolved), so `active` cancellation is enough to guard stale results.
  useEffect(() => {
    if (!source) {
      setMembers([])
      setSelected(new Set())
      setScanning(false)
      return
    }
    let active = true
    setScanning(true)
    void (async () => {
      const res = await refreshSourceMembers(source, { shouldNotify: () => active })
      if (!active) return
      if (res.ok) {
        const mems = sortSkillMembers((res.result?.members ?? []) as RefreshMember[])
        const existing = new Set((source.members ?? []).map((m) => m.name))
        setMembers(mems)
        // Pre-select members already configured; new ones left unchecked so
        // the user explicitly opts in instead of silently enabling everything.
        setSelected(new Set(mems.filter((m) => existing.has(m.name)).map((m) => m.name)))
        setScanning(false)
      } else {
        setScanning(false)
        onClose()
      }
    })()
    return () => {
      active = false
    }
  }, [refreshSourceMembers, source])

  const handleConfirm = async (selectedNames: string[]) => {
    if (!source) return
    setSaving(true)
    try {
      const res = await saveSourceMembers(source, selectedNames)
      if (res.ok) onConfirm()
    } finally {
      setSaving(false)
    }
  }

  const open = !!source && !scanning

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose()
      }}
      title={`Scan · ${source ? sourceIdentity(source).repoId : ''}`}
      width={520}
      minHeight={300}
    >
      {source && (
        <div>
          <div
            style={{
              marginBottom: 12,
              fontSize: 12,
              color: 'var(--muted)',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            发现 {members.length} 个 member,勾选要启用的
          </div>
          {members.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 8,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
              }}
            >
              <button
                onClick={() => {
                  const all = selected.size === members.length
                  setSelected(all ? new Set() : new Set(members.map((m) => m.name)))
                }}
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '2px 8px',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                {selected.size === members.length ? '全不选' : '全选'}
              </button>
              <span style={{ color: 'var(--muted)' }}>
                已选 {selected.size} / {members.length}
              </span>
            </div>
          )}
          {members.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>未发现任何 SKILL.md</div>
          ) : (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                maxHeight: 280,
                overflow: 'auto',
                marginBottom: 14,
              }}
            >
              {members.map((m) => {
                const checked = selected.has(m.name)
                return (
                  <label
                    key={m.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 10px',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
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
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                      {m.name}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="primary"
              onClick={() => handleConfirm([...selected])}
              disabled={saving}
              style={{ flex: 1 }}
            >
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
        </div>
      )}
    </Modal>
  )
}
