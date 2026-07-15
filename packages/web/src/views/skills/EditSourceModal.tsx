import { useEffect, useRef, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { Dropdown } from '@/components/ui/dropdown'
import { Segmented } from './Segmented'
import {
  sourceIdentity,
  type SkillSource,
  type SourceTree,
  type SourceTreeBundleNode,
  type SourceTreeNode,
} from '@loom/core'
import SkillReconciliationDialog from './SkillReconciliationDialog'
import {
  useManifestOperations,
  type PreparedSkillReconciliation,
} from '@/hooks/useManifestOperations'
import styles from './EditSourceModal.module.css'
import { FieldError } from '@/components/ErrorFeedback'
import { Check, GitFork, RefreshCw } from 'lucide-react'
import SkillWorkbench, { SkillWorkbenchTitle } from './SkillWorkbench'
import SourceTreeSelection, { type SourceTreeSelectionValue } from './SourceTreeSelection'
import SourceSkillPreview from './SourceSkillPreview'

interface Props {
  repoPath: string
  source: SkillSource | null
  showToast: (msg: string) => void
  onClose: () => void
  onSaved: () => void
}

type OpenProps = Omit<Props, 'source'> & { source: SkillSource }

function flattenSourceTree(nodes: readonly SourceTreeNode[]): SourceTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.kind === 'container' ? flattenSourceTree(node.children) : []),
  ])
}

function renameRootBundle(tree: SourceTree | null, name: string): SourceTree | null {
  if (!tree || !name) return tree
  const nodes = tree.nodes.map((node) =>
    node.kind === 'bundle' && node.path === '' ? { ...node, name } : node,
  )
  return nodes.some((node, index) => node !== tree.nodes[index]) ? { ...tree, nodes } : tree
}

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
  const [branches, setBranches] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [refsLoaded, setRefsLoaded] = useState(false)
  const [refsLoading, setRefsLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [tree, setTree] = useState<SourceTree | null>(null)
  const [liveCacheCommit, setLiveCacheCommit] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const typeRef = useRef(type)
  const refsGeneration = useRef(0)
  const scanGeneration = useRef(0)
  const scanAfterRefsRef = useRef(false)
  const [selection, setSelection] = useState<SourceTreeSelectionValue>(() => ({
    memberEntries: new Set((source.members ?? []).map((member) => member.entry)),
    resources: source.resources ?? { include: [], exclude: [] },
  }))
  const [previewBundle, setPreviewBundle] = useState<SourceTreeBundleNode | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reconciliation, setReconciliation] = useState<PreparedSkillReconciliation | null>(null)
  const operations = useManifestOperations(repoPath, { onError: setError, onToast: showToast })
  const { loadSourceRefs, loadCachedSourceTree, scanSourceTree, saveSource } = operations
  const initialTreeReadRef = useRef<{
    key: string
    request: ReturnType<typeof loadCachedSourceTree>
  } | null>(null)

  useEffect(() => {
    setPreviewBundle(null)
  }, [tree?.commit])

  useEffect(() => {
    let active = true
    const generation = ++scanGeneration.current
    const initName = sourceIdentity(source).repoId
    const initType = source.type ?? 'branch'
    setType(initType)
    typeRef.current = initType
    setName(initName)
    setRef(source.ref ?? '')
    setError(null)
    setScanError(null)
    setTree(null)
    setLiveCacheCommit(null)
    setBranches([])
    setTags([])
    setRefsLoaded(false)
    scanAfterRefsRef.current = false
    setSelection({
      memberEntries: new Set((source.members ?? []).map((member) => member.entry)),
      resources: source.resources ?? { include: [], exclude: [] },
    })

    void (async () => {
      setScanning(true)
      try {
        const requestKey = JSON.stringify([repoPath, source.url, source.pinned_commit, source.ref])
        if (initialTreeReadRef.current?.key !== requestKey) {
          initialTreeReadRef.current = {
            key: requestKey,
            request: loadCachedSourceTree(source, { notify: false, allowConcurrent: true }),
          }
        }
        const res = await initialTreeReadRef.current.request
        if (!active || generation !== scanGeneration.current) return
        if (res.skipped) return
        if (res.ok && res.result?.tree) {
          setTree(res.result.tree)
          setLiveCacheCommit(res.result.tree.commit)
        } else if (!res.ok) {
          setScanError(res.message || '扫描失败')
        }
      } finally {
        if (active && generation === scanGeneration.current) setScanning(false)
      }
    })()

    return () => {
      active = false
      refsGeneration.current++
      scanGeneration.current++
      scanAfterRefsRef.current = false
    }
  }, [loadCachedSourceTree, source])

  const handleScan = async (nextRef = ref, nextType = type) => {
    const generation = ++scanGeneration.current
    setScanning(true)
    setError(null)
    setScanError(null)
    try {
      const res = await scanSourceTree(source.url, {
        name: name.trim() || undefined,
        notify: false,
        ref: nextRef,
        type: nextType,
      })
      if (generation !== scanGeneration.current) return
      if (res.skipped) return
      if (res.ok && res.result?.tree) {
        setTree(res.result.tree)
      } else if (!res.ok) {
        setScanError(res.message || '扫描失败')
      }
    } finally {
      if (generation === scanGeneration.current) setScanning(false)
    }
  }

  const fetchRefs = async () => {
    if (refsLoaded || refsLoading) return
    const generation = ++refsGeneration.current
    setRefsLoading(true)
    setError(null)
    try {
      const res = await loadSourceRefs(source.url, {
        shouldNotify: () => generation === refsGeneration.current,
        allowConcurrent: true,
      })
      if (generation !== refsGeneration.current || res.skipped) return
      if (res.ok) {
        const nextBranches = res.result?.branches ?? []
        const nextTags = res.result?.tags ?? []
        setBranches(nextBranches)
        setTags(nextTags)
        setRefsLoaded(true)
        const currentType = typeRef.current
        const list = currentType === 'tag' ? nextTags : nextBranches
        const nextRef =
          currentType === (source.type ?? 'branch') && ref
            ? ref
            : list.includes(ref)
              ? ref
              : (list[0] ?? '')
        setRef(nextRef)
        if (scanAfterRefsRef.current) {
          scanAfterRefsRef.current = false
          if (nextRef) void handleScan(nextRef, currentType)
        }
      } else {
        scanAfterRefsRef.current = false
        setError(res.message || '获取 refs 失败')
      }
    } finally {
      if (generation === refsGeneration.current) setRefsLoading(false)
    }
  }

  const handleTypeChange = (t: 'branch' | 'tag') => {
    if (t === typeRef.current) return
    setType(t)
    typeRef.current = t
    const list = t === 'tag' ? tags : branches
    setRef(list[0] ?? '')
    scanGeneration.current++
    setScanning(false)
    setScanError(null)
    setTree(null)
    if (!refsLoaded) {
      scanAfterRefsRef.current = true
      void fetchRefs()
      return
    }
    if (list[0]) void handleScan(list[0], t)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const selectedMembers = flattenSourceTree(tree?.nodes ?? [])
        .filter((node) => node.kind === 'bundle' && selection.memberEntries.has(node.entry))
        .map((node) => ({
          name: node.name,
          entry: node.kind === 'bundle' ? node.entry : '',
        }))
      const res = await saveSource({
        source,
        name,
        ref,
        type,
        expectedCommit: tree?.commit,
        members: selectedMembers,
        resources: selection.resources,
      })
      if (res.ok) {
        const result = res.result as
          { finalized: boolean; changes: PreparedSkillReconciliation['changes'] } | undefined
        if (result?.finalized === false) {
          setReconciliation({
            sessionId: `edit:${source.url}`,
            pinned_commit: '',
            changes: result.changes,
            resourceBoundaryChanges: [],
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
      const selectedMembers = flattenSourceTree(tree?.nodes ?? [])
        .filter((node) => node.kind === 'bundle' && selection.memberEntries.has(node.entry))
        .map((node) => ({
          name: node.name,
          entry: node.kind === 'bundle' ? node.entry : '',
        }))
      const res = await saveSource({
        source,
        name,
        ref,
        type,
        expectedCommit: tree?.commit,
        members: selectedMembers,
        resources: selection.resources,
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

  const repoId = sourceIdentity(source).repoId
  const availableRefOptions = type === 'tag' ? tags : branches
  const refOptions =
    ref && !availableRefOptions.includes(ref) ? [ref, ...availableRefOptions] : availableRefOptions
  const sourceNodes = flattenSourceTree(tree?.nodes ?? [])
  const selectedCount = selection.memberEntries.size + selection.resources.include.length
  const treePending = !tree && (scanning || refsLoading)

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
        width={1120}
        className={styles.dialog}
        bodyClassName={styles.body}
        headerClassName={styles.header}
        titleClassName={styles.modalTitle}
        headerActions={
          <IconButton
            label="Refresh repository tree"
            tooltip="Refresh tree"
            onClick={() => void handleScan()}
            disabled={scanning}
          >
            <RefreshCw className={scanning ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </IconButton>
        }
      >
        <SkillWorkbench
          resultCount={selectedCount}
          className={styles.layout}
          configurationLabel="Source"
          resultsLabel="Contents"
          configuration={
            <div className={styles.fields}>
              <span className={styles.kicker}>Repository</span>
              {error && <FieldError id="edit-source-error">{error}</FieldError>}

              <div className={styles.field}>
                <span className={styles.fieldLabel}>Repository URL</span>
                <div className={styles.inputWithIcon}>
                  <GitFork size={15} aria-hidden="true" />
                  <input
                    value={source.url}
                    readOnly
                    onFocus={(event) => {
                      event.currentTarget.setSelectionRange(0, 0)
                      event.currentTarget.scrollLeft = 0
                    }}
                  />
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
                  onChange={(e) => {
                    const nextName = e.target.value
                    setName(nextName)
                    setTree((current) =>
                      renameRootBundle(current, nextName.trim() || sourceIdentity(source).repoId),
                    )
                  }}
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
                    onChange={(nextRef) => {
                      if (nextRef === ref && (tree || scanning)) return
                      setRef(nextRef)
                      setTree(null)
                      void handleScan(nextRef, type)
                    }}
                    onOpen={() => void fetchRefs()}
                    loading={refsLoading}
                    loadingLabel="Loading refs…"
                    options={refOptions.map((item) => ({ value: item, label: item }))}
                    placeholder={refsLoading ? '加载中…' : '—'}
                  />
                </div>
              </div>

              {treePending ? (
                <div className={styles.commitStatus} data-loading="true" role="status">
                  <i />
                  <span>
                    <strong>Loading commit…</strong>
                    <small>Resolving repository ref</small>
                  </span>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                </div>
              ) : tree ? (
                <>
                  <div className={styles.commitStatus}>
                    <i />
                    <span>
                      <strong>{tree.commit.slice(0, 7)}</strong>
                      <small>{sourceNodes.length} tracked entries</small>
                    </span>
                    <Check size={14} />
                  </div>
                  <div className={styles.sourceStats}>
                    <span>
                      <strong>{sourceNodes.filter((node) => node.kind === 'bundle').length}</strong>
                      bundles
                    </span>
                    <span>
                      <strong>
                        {sourceNodes.filter((node) => node.kind === 'resource').length}
                      </strong>
                      resources
                    </span>
                    <span>
                      <strong>
                        {
                          sourceNodes.filter(
                            (node) => node.kind === 'symlink' || node.kind === 'submodule',
                          ).length
                        }
                      </strong>
                      unavailable
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          }
          results={
            previewBundle ? (
              <SourceSkillPreview
                repoPath={repoPath}
                sourceUrl={source.url}
                sourceRef={ref}
                sourceName={name.trim() || repoId}
                bundle={previewBundle}
                onBack={() => setPreviewBundle(null)}
              />
            ) : (
              <SourceTreeSelection
                nodes={tree?.nodes ?? []}
                diagnostics={tree?.diagnostics}
                sourceName={name.trim() || repoId}
                sourceUrl={source.url}
                sourceRef={ref}
                value={selection}
                onChange={setSelection}
                onOpenBundle={tree?.commit === liveCacheCommit ? setPreviewBundle : undefined}
                loading={scanning || treePending}
                error={!scanning ? scanError : null}
                onRetry={handleScan}
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
                aria-label={saving ? '保存中…' : `保存 (${selectedCount})`}
                onClick={handleSave}
                disabled={saving || !tree}
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
