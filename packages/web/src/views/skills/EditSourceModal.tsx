import { useEffect, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { Dropdown } from '@/components/ui/dropdown'
import { Segmented } from './Segmented'
import { sourceIdentity, type SkillSource } from '@loom/core'
import { sortSkillMembers, type ScanMember } from './types'
import SkillReconciliationDialog from './SkillReconciliationDialog'
import {
  useManifestOperations,
  type PreparedSkillReconciliation,
} from '@/hooks/useManifestOperations'
import styles from './EditSourceModal.module.css'
import { FieldError } from '@/components/ErrorFeedback'
import { GitFork, RefreshCw } from 'lucide-react'
import SkillWorkbench, { SkillWorkbenchTitle } from './SkillWorkbench'
import SkillSelectionList, { type SkillSelectionItem } from './SkillSelectionList'

interface Props {
  repoPath: string
  source: SkillSource | null
  showToast: (msg: string) => void
  onClose: () => void
  onSaved: () => void
}

type OpenProps = Omit<Props, 'source'> & { source: SkillSource }

const mono = "'JetBrains Mono', monospace"

export default function EditSourceModal({ repoPath, source, showToast, onClose, onSaved }: Props) {
  if (!source) return null
  return (
    <EditSourceModalContent
      key={source.url}
      repoPath={repoPath}
      source={source}
      showToast={showToast}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

function EditSourceModalContent({ repoPath, source, showToast, onClose, onSaved }: OpenProps) {
  const [type, setType] = useState<'branch' | 'tag'>(source.type ?? 'branch')
  const [name, setName] = useState(() => sourceIdentity(source).repoId)
  const [ref, setRef] = useState(source.ref ?? '')
  const [scan, setScan] = useState(source.scan ?? '')
  const [branches, setBranches] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [refsLoading, setRefsLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [members, setMembers] = useState<ScanMember[]>([])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((source.members ?? []).map((member) => member.name)),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reconciliation, setReconciliation] = useState<PreparedSkillReconciliation | null>(null)
  const operations = useManifestOperations(repoPath, { onError: setError, onToast: showToast })
  const { loadSourceRefs, scanSourceMembers, saveSource } = operations

  // Re-initialise whenever a source is opened: pre-fill url/type/ref from
  // the source, fetch the available refs, scan the members, and pre-select
  // the members that were already configured.
  useEffect(() => {
    let active = true
    const url = source.url
    const initName = sourceIdentity(source).repoId
    const initType = source.type ?? 'branch'
    const initScan = source.scan ?? ''
    const existing = new Set((source.members ?? []).map((m) => m.name))
    setType(initType)
    setName(initName)
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
        const res = await loadSourceRefs(url, { shouldNotify: () => active, allowConcurrent: true })
        if (!active) return
        if (res.skipped) return
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
          allowConcurrent: true,
          ref: source.ref,
          type: initType,
          scan: initScan,
        })
        if (!active) return
        if (res.skipped) return
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
    setSaving(true)
    setError(null)
    try {
      const selectedMembers = members
        .filter((member) => selected.has(member.name))
        .map((member) => ({ name: member.name, path: member.path }))
      const res = await saveSource({ source, name, ref, type, scan, members: selectedMembers })
      if (res.ok) {
        const result = res.result as
          { finalized: boolean; changes: PreparedSkillReconciliation['changes'] } | undefined
        if (result?.finalized === false) {
          setReconciliation({
            sessionId: `edit:${source.url}`,
            pinned_commit: '',
            changes: result.changes,
          })
        } else {
          onSaved()
        }
      } else {
        setError(res.message || '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const finalizeReconciliation = async (preserve: string[]) => {
    setSaving(true)
    setError(null)
    try {
      const selectedMembers = members
        .filter((member) => selected.has(member.name))
        .map((member) => ({ name: member.name, path: member.path }))
      const res = await saveSource({
        source,
        name,
        ref,
        type,
        scan,
        members: selectedMembers,
        preserve,
      })
      if (res.ok) {
        setReconciliation(null)
        onSaved()
      } else {
        setError(res.message || '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleScan = async () => {
    setScanning(true)
    setError(null)
    const existing = new Set((source.members ?? []).map((m) => m.name))
    try {
      const res = await scanSourceMembers(source.url, {
        ref,
        type,
        scan,
      })
      if (res.skipped) return
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

  const repoId = sourceIdentity(source).repoId
  const refOptions = type === 'tag' ? tags : branches
  const listItems: SkillSelectionItem[] = members.map((member) => ({
    id: member.name,
    description: member.description,
    path: member.path,
    installed: member.installed,
  }))
  const baselineIds = new Set((source.members ?? []).map((member) => member.name))

  return (
    <>
      <Modal
        open
        onClose={() => {
          if (!saving) onClose()
        }}
        ariaLabel={`Edit Source · ${repoId}`}
        title={
          <SkillWorkbenchTitle icon={<GitFork size={17} />} eyebrow="Edit source" title={repoId} />
        }
        width={1040}
        className={styles.dialog}
        bodyClassName={styles.body}
        headerClassName={styles.header}
        titleClassName={styles.modalTitle}
      >
        <SkillWorkbench
          resultCount={selected.size}
          className={styles.layout}
          configuration={
            <div className={styles.fields}>
              <span className={styles.kicker}>Repository</span>
              {error && <FieldError id="edit-source-error">{error}</FieldError>}

              <div className={styles.field}>
                <span className={styles.fieldLabel}>Repository URL</span>
                <div className={styles.inputWithIcon}>
                  <GitFork size={15} aria-hidden="true" />
                  <input value={source.url} readOnly />
                  <span>locked</span>
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="edit-source-name">
                  Source name
                </label>
                <input
                  id="edit-source-name"
                  aria-label="source name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={styles.control}
                />
              </div>

              <div className={styles.fieldGrid}>
                <div className={styles.field}>
                  <div className={styles.fieldLabel}>Type</div>
                  <Segmented
                    value={type}
                    onChange={handleTypeChange}
                    options={[
                      { value: 'branch', label: 'branch' },
                      { value: 'tag', label: 'tag' },
                    ]}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Ref</span>
                  <Dropdown
                    ariaLabel="Repository ref"
                    value={ref}
                    onChange={setRef}
                    disabled={refsLoading || refOptions.length === 0}
                    options={refOptions.map((item) => ({ value: item, label: item }))}
                    placeholder={refsLoading ? '加载中…' : '—'}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="edit-source-scan-pattern">
                  Scan pattern
                </label>
                <div className={styles.scanRow}>
                  <input
                    id="edit-source-scan-pattern"
                    aria-label="scan pattern"
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    placeholder="**/SKILL.md"
                    className={styles.control}
                  />
                  <Button
                    className={styles.scanButton}
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleScan()}
                    disabled={scanning}
                  >
                    <RefreshCw className={scanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                    Scan members
                  </Button>
                </div>
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
            </div>
          }
          results={
            scanning ? (
              <div className="selectable-list-empty">扫描中…</div>
            ) : (
              <SkillSelectionList
                className={styles.skillList}
                ariaLabel={'Edit Source · ' + repoId}
                items={listItems}
                selectedIds={selected}
                onSelectedIdsChange={setSelected}
                repositoryLabel={`${repoId} · ${ref || 'ref'}`}
                mode="edit"
                baselineIds={baselineIds}
                emptyMessage="No skills found"
              />
            )
          }
          footer={
            <>
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                aria-label={saving ? '保存中…' : `保存 (${selected.size})`}
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save source'}
              </Button>
            </>
          }
        />
      </Modal>
      <SkillReconciliationDialog
        state={reconciliation}
        busy={saving}
        error={error}
        onClose={() => {
          if (!saving) setReconciliation(null)
        }}
        onConfirm={finalizeReconciliation}
      />
    </>
  )
}
