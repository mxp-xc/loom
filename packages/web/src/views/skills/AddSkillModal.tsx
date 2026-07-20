import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import { Dropdown } from '@/components/ui/dropdown'
import { Check, Folder, FolderOpen, GitFork, RefreshCw } from 'lucide-react'
import {
  deriveRepoId,
  type SourceResources,
  type SourceTree,
  type SourceTreeNode,
} from '@loom/core'
import { Segmented } from './Segmented'
import type { LocalScanResult } from './types'
import { useManifestOperations } from '@/hooks/useManifestOperations'
import styles from './AddSkillModal.module.css'

function sourceNameFromUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    return deriveRepoId(trimmed)
  } catch {
    return ''
  }
}
import SkillWorkbench, { SkillWorkbenchTitle } from './SkillWorkbench'
import SkillSelectionList, { type SkillSelectionItem } from './SkillSelectionList'
import SourceTreeSelection, { type SourceTreeSelectionValue } from './SourceTreeSelection'
import { PickedSkillFileReadError, readPickedSkillDirectory } from './picked-skill-files'

interface Props {
  open: boolean
  repoPath: string
  onClose: () => void
}

// Repository assets are auto-discovered separately; adding starts from the
// user's shared cross-agent skill directory.
const DEFAULT_LOCAL_DIR = '~/.agents/skills'
const emptyResources: SourceResources = { include: [], exclude: [] }

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

export default function AddSkillModal({ open, repoPath, onClose }: Props) {
  const operations = useManifestOperations(repoPath)
  const { scanLocalSkills, loadSourceRefs, scanSourceTree, addLocalSkills, addSource } = operations
  const [addTab, setAddTab] = useState<'local' | 'source'>('local')
  const [addBusy, setAddBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)

  // Local tab
  const [localPath, setLocalPath] = useState(DEFAULT_LOCAL_DIR)
  const [localScanning, setLocalScanning] = useState(false)
  const [localSkills, setLocalSkills] = useState<LocalScanResult[]>([])
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set())
  // When true, the listed skills came from an external folder picked via the
  // directory chooser (webkitdirectory). These have no server-side path, so
  // import ships their file contents to /skills/local/write. When false, the
  // listed skills already live under <repo>/assets/skills and just need a ref
  // entry in skills.yaml.
  const [pickedExternal, setPickedExternal] = useState(false)
  // Picked skill files keyed by skill name, retained until import completes.
  const [pickedFiles, setPickedFiles] = useState<
    Map<string, Array<{ path: string; content: string }>>
  >(new Map())
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Source tab
  const [srcUrl, setSrcUrl] = useState('')
  const [srcName, setSrcName] = useState('')
  const [srcNameTouched, setSrcNameTouched] = useState(false)
  const [srcType, setSrcType] = useState<'branch' | 'tag'>('branch')
  const [srcRef, setSrcRef] = useState('')
  const [srcBranches, setSrcBranches] = useState<string[]>([])
  const [srcTags, setSrcTags] = useState<string[]>([])
  const [srcRefsLoaded, setSrcRefsLoaded] = useState(false)
  const [srcRefsLoading, setSrcRefsLoading] = useState(false)
  const [srcScanning, setSrcScanning] = useState(false)
  const [srcScanError, setSrcScanError] = useState<string | null>(null)
  const [srcTree, setSrcTree] = useState<SourceTree | null>(null)
  const srcRefsGeneration = useRef(0)
  const srcScanGeneration = useRef(0)
  const srcTypeRef = useRef(srcType)
  const srcScanAfterRefsRef = useRef(false)
  const [srcSelection, setSrcSelection] = useState<SourceTreeSelectionValue>({
    memberEntries: new Set(),
    resources: emptyResources,
  })

  const scanLocal = useCallback(
    async (dir: string) => {
      const d = dir.trim()
      if (!d) return
      setLocalScanning(true)
      setAddErr(null)
      try {
        const res = await scanLocalSkills(d)
        if (res.ok) {
          const skills = res.result?.skills ?? []
          setLocalSkills(skills)
          // Pre-select everything discovered so the bulk-import button is
          // immediately useful; the user can untick what they don't want.
          setLocalSelected(new Set(skills.map((s) => s.name)))
        } else {
          setLocalSkills([])
          setLocalSelected(new Set())
          setAddErr(res.message || '扫描失败')
        }
      } finally {
        setLocalScanning(false)
      }
    },
    [scanLocalSkills],
  )

  // Browse via the native directory picker (webkitdirectory). The browser
  // only exposes file contents + relative paths, so we scan client-side for
  // SKILL.md and remember each skill's files. Import then writes them into
  // <repo>/assets/skills through /skills/local/write.
  const handleBrowsePick = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    try {
      const picked = await readPickedSkillDirectory(Array.from(files))
      setLocalSkills(picked.skills)
      setLocalSelected(new Set(picked.skills.map((skill) => skill.name)))
      setPickedFiles(picked.filesBySkill)
      setPickedExternal(true)
      setLocalPath('(外部目录)')
      setAddErr(null)
    } catch (err) {
      console.error(
        { err, path: err instanceof PickedSkillFileReadError ? err.path : undefined },
        'Failed to read picked skill directory',
      )
      setLocalSkills([])
      setLocalSelected(new Set())
      setPickedFiles(new Map())
      setPickedExternal(false)
      setAddErr(err instanceof Error ? err.message : '读取外部 skill 目录失败')
    }
  }, [])

  // Reset every field and kick off the initial local scan each time the
  // modal opens.
  useEffect(() => {
    srcRefsGeneration.current++
    srcScanGeneration.current++
    if (!open) return
    setAddErr(null)
    setAddBusy(false)
    setAddTab('local')
    setLocalPath(DEFAULT_LOCAL_DIR)
    setLocalSkills([])
    setLocalSelected(new Set())
    setPickedExternal(false)
    setPickedFiles(new Map())
    setSrcUrl('')
    setSrcName('')
    setSrcNameTouched(false)
    setSrcType('branch')
    setSrcRef('')
    setSrcBranches([])
    setSrcTags([])
    setSrcRefsLoaded(false)
    setSrcRefsLoading(false)
    setSrcScanning(false)
    setSrcScanError(null)
    setSrcTree(null)
    srcTypeRef.current = 'branch'
    srcScanAfterRefsRef.current = false
    setSrcSelection({ memberEntries: new Set(), resources: emptyResources })
    void scanLocal(DEFAULT_LOCAL_DIR)
  }, [open, scanLocal])

  const fetchRefs = async (url: string) => {
    if (!url || srcRefsLoaded || srcRefsLoading) return
    const generation = ++srcRefsGeneration.current
    setSrcRefsLoading(true)
    setAddErr(null)
    try {
      const res = await loadSourceRefs(url, {
        shouldNotify: () => generation === srcRefsGeneration.current,
        allowConcurrent: true,
      })
      if (generation !== srcRefsGeneration.current || res.skipped) return
      if (res.ok) {
        const branches = res.result?.branches ?? []
        const tags = res.result?.tags ?? []
        setSrcBranches(branches)
        setSrcTags(tags)
        setSrcRefsLoaded(true)
        const currentType = srcTypeRef.current
        const list = currentType === 'tag' ? tags : branches
        const nextRef = srcScanAfterRefsRef.current ? (list[0] ?? '') : srcRef || list[0] || ''
        setSrcRef(nextRef)
        if (srcScanAfterRefsRef.current) {
          srcScanAfterRefsRef.current = false
          if (nextRef) void handleScanSource(nextRef, currentType)
        }
      } else {
        srcScanAfterRefsRef.current = false
        setAddErr(res.message || '获取 refs 失败')
      }
    } finally {
      if (generation === srcRefsGeneration.current) setSrcRefsLoading(false)
    }
  }

  const handleTypeChange = (t: 'branch' | 'tag') => {
    if (t === srcTypeRef.current) return
    setSrcType(t)
    srcTypeRef.current = t
    const list = t === 'tag' ? srcTags : srcBranches
    setSrcRef(list[0] ?? '')
    srcScanGeneration.current++
    setSrcScanning(false)
    setSrcScanError(null)
    setSrcTree(null)
    if (!srcRefsLoaded) {
      srcScanAfterRefsRef.current = true
      if (srcUrl.trim()) void fetchRefs(srcUrl.trim())
      return
    }
    if (list[0]) void handleScanSource(list[0], t)
  }

  const handleScanSource = async (nextRef = srcRef, nextType = srcType) => {
    if (!srcUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    const generation = ++srcScanGeneration.current
    setSrcScanning(true)
    setAddErr(null)
    setSrcScanError(null)
    setSrcTree(null)
    try {
      const res = await scanSourceTree(srcUrl.trim(), {
        name: srcName.trim() || undefined,
        ref: nextRef.trim() || undefined,
        type: nextType,
      })
      if (generation !== srcScanGeneration.current) return
      if (res.ok && res.result?.tree) {
        const tree = res.result.tree
        setSrcRef(nextRef.trim() || 'HEAD')
        setSrcTree(tree)
        setSrcSelection({
          memberEntries: new Set(
            flattenSourceTree(tree.nodes)
              .filter((node) => node.kind === 'bundle')
              .map((node) => (node.kind === 'bundle' ? node.entry : '')),
          ),
          resources: emptyResources,
        })
      } else {
        setSrcScanError(res.message || '扫描失败')
      }
    } finally {
      if (generation === srcScanGeneration.current) setSrcScanning(false)
    }
  }

  const handleAddLocal = async () => {
    const selected = localSkills.filter((s) => localSelected.has(s.name))
    if (selected.length === 0) {
      setAddErr('未选择 skill')
      return
    }
    setAddBusy(true)
    setAddErr(null)
    try {
      const res = await addLocalSkills({ skills: selected, pickedExternal, pickedFiles })
      if (res.ok) {
        onClose()
      } else {
        setAddErr(res.message || '导入失败')
      }
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
      const res = await addSource({
        name: srcName.trim() || deriveRepoId(srcUrl.trim()),
        url: srcUrl.trim(),
        ref: srcRef.trim() || 'HEAD',
        type: srcType,
        members: flattenSourceTree(srcTree?.nodes ?? [])
          .filter((node) => node.kind === 'bundle' && srcSelection.memberEntries.has(node.entry))
          .map((node) => ({
            name: node.name,
            entry: node.kind === 'bundle' ? node.entry : '',
          })),
        resources: srcSelection.resources,
      })
      if (res.ok) onClose()
      else setAddErr(res.message || '添加 source 失败')
    } finally {
      setAddBusy(false)
    }
  }

  const localListItems: SkillSelectionItem[] = localSkills.map((skill) => ({
    id: skill.name,
    path: skill.path.endsWith('SKILL.md') ? skill.path : `${skill.path}/SKILL.md`,
  }))
  const availableRefOptions = srcType === 'tag' ? srcTags : srcBranches
  const refOptions =
    srcRef && !availableRefOptions.includes(srcRef)
      ? [srcRef, ...availableRefOptions]
      : availableRefOptions
  const sourceNodes = flattenSourceTree(srcTree?.nodes ?? [])
  const sourceBundleCount = sourceNodes.filter((node) => node.kind === 'bundle').length
  const sourceResourceCount = sourceNodes.filter((node) => node.kind === 'resource').length
  const sourceUnavailableCount = sourceNodes.filter(
    (node) => node.kind === 'symlink' || node.kind === 'submodule',
  ).length

  const configuration = (
    <div className={styles.configStack}>
      <div className={styles.modeSwitch} role="group" aria-label="Add skill type">
        <button
          type="button"
          aria-pressed={addTab === 'local'}
          data-active={addTab === 'local'}
          onClick={() => {
            setAddTab('local')
            setAddErr(null)
          }}
        >
          <FolderOpen size={14} aria-hidden="true" />
          Local skill
        </button>
        <button
          type="button"
          aria-pressed={addTab === 'source'}
          data-active={addTab === 'source'}
          onClick={() => {
            setAddTab('source')
            setAddErr(null)
          }}
        >
          <GitFork size={14} aria-hidden="true" />
          Source
        </button>
      </div>
      {addErr && <div className={styles.error}>{addErr}</div>}
      {addTab === 'local' ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is a non-standard DOM attribute
            webkitdirectory=""
            directory=""
            multiple
            hidden
            onChange={(e) => {
              void handleBrowsePick(e.target.files)
              e.target.value = ''
            }}
          />
          <span className={styles.kicker}>Local directory</span>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Skills directory</span>
            <div className={styles.directoryRow}>
              <div className={styles.inputWithIcon}>
                <Folder size={15} aria-hidden="true" />
                <input
                  value={localPath}
                  onChange={(e) => {
                    setLocalPath(e.target.value)
                    setPickedExternal(false)
                  }}
                  placeholder={DEFAULT_LOCAL_DIR}
                />
              </div>
              <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                <FolderOpen className="h-3.5 w-3.5" /> Choose
              </Button>
            </div>
          </label>
          <Button
            className={styles.scanAction}
            variant="secondary"
            size="sm"
            onClick={() => {
              setPickedExternal(false)
              void scanLocal(localPath)
            }}
            disabled={localScanning || pickedExternal}
          >
            <RefreshCw className={localScanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            Scan directory
          </Button>
        </>
      ) : (
        <>
          <span className={styles.kicker}>Repository</span>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Repository URL</span>
            <div className={styles.inputWithIcon}>
              <GitFork size={15} aria-hidden="true" />
              <input
                value={srcUrl}
                onChange={(e) => {
                  const nextUrl = e.target.value
                  setSrcUrl(nextUrl)
                  if (!srcNameTouched) setSrcName(sourceNameFromUrl(nextUrl))
                  srcRefsGeneration.current++
                  srcScanGeneration.current++
                  setSrcBranches([])
                  setSrcTags([])
                  setSrcRefsLoaded(false)
                  setSrcRef('')
                  setSrcRefsLoading(false)
                  setSrcScanning(false)
                  setSrcScanError(null)
                  setSrcTree(null)
                  srcScanAfterRefsRef.current = false
                }}
                placeholder="https://host.example/org/repo.git"
              />
            </div>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Source name</span>
            <input
              id="add-source-name"
              aria-label="source name"
              value={srcName}
              onChange={(e) => {
                const nextName = e.target.value
                setSrcName(nextName)
                setSrcNameTouched(true)
                setSrcTree((current) =>
                  renameRootBundle(
                    current,
                    nextName.trim() || sourceNameFromUrl(srcUrl) || 'source',
                  ),
                )
              }}
              placeholder="openai-skills"
              className={styles.control}
            />
          </label>
          <div className={styles.fieldPair}>
            <div>
              <div className={styles.fieldLabel}>Type</div>
              <Segmented
                value={srcType}
                onChange={handleTypeChange}
                options={[
                  { value: 'branch', label: 'branch' },
                  { value: 'tag', label: 'tag' },
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>Ref</div>
              <Dropdown
                ariaLabel="Repository ref"
                value={srcRef}
                onChange={(nextRef) => {
                  if (nextRef === srcRef && (srcTree || srcScanning)) return
                  srcScanAfterRefsRef.current = false
                  setSrcRef(nextRef)
                  void handleScanSource(nextRef, srcType)
                }}
                onOpen={() => void fetchRefs(srcUrl.trim())}
                options={refOptions.map((item) => ({ value: item, label: item }))}
                disabled={srcRefsLoading || !srcUrl.trim()}
                placeholder={srcRefsLoading ? '加载中…' : '—'}
              />
            </div>
          </div>
          {srcTree && (
            <>
              <div className={styles.commitStatus}>
                <i />
                <span>
                  <strong>{srcTree.commit.slice(0, 7)}</strong>
                  <small>{sourceNodes.length} tracked entries</small>
                </span>
                <Check size={14} />
              </div>
              <div className={styles.sourceStats}>
                <span>
                  <strong>{sourceBundleCount}</strong> bundles
                </span>
                <span>
                  <strong>{sourceResourceCount}</strong> resources
                </span>
                <span>
                  <strong>{sourceUnavailableCount}</strong> unavailable
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )

  const selectedCount =
    addTab === 'local'
      ? localSelected.size
      : srcSelection.memberEntries.size + srcSelection.resources.include.length
  const results =
    addTab === 'source' ? (
      <SourceTreeSelection
        nodes={srcTree?.nodes ?? []}
        diagnostics={srcTree?.diagnostics}
        sourceUrl={srcUrl}
        sourceRef={srcRef}
        sourceName={srcName.trim() || sourceNameFromUrl(srcUrl) || 'source'}
        value={srcSelection}
        onChange={setSrcSelection}
        loading={srcScanning || (srcRefsLoading && srcScanAfterRefsRef.current)}
        error={srcScanError}
        onRetry={handleScanSource}
      />
    ) : localScanning ? (
      <div className={styles.resultState}>正在扫描 SKILL.md…</div>
    ) : (
      <SkillSelectionList
        ariaLabel="Local Skill"
        items={localListItems}
        selectedIds={localSelected}
        onSelectedIdsChange={setLocalSelected}
        repositoryLabel={localPath}
        emptyMessage="No skills found"
      />
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Add Skill or Source"
      title={
        <SkillWorkbenchTitle
          icon={addTab === 'local' ? <FolderOpen size={17} /> : <GitFork size={17} />}
          eyebrow={addTab === 'local' ? 'Add' : 'Remote source'}
          title={
            addTab === 'local'
              ? 'Skills'
              : srcName.trim() || sourceNameFromUrl(srcUrl) || 'New source'
          }
        />
      }
      width={1120}
      className={styles.dialog}
      bodyClassName={styles.body}
      headerClassName={styles.header}
      titleClassName={styles.modalTitle}
      headerActions={
        addTab === 'source' ? (
          <IconButton
            label="Refresh repository tree"
            tooltip="Refresh tree"
            onClick={() => void handleScanSource()}
            disabled={srcScanning || !srcUrl.trim()}
          >
            <RefreshCw className={srcScanning ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </IconButton>
        ) : null
      }
    >
      <SkillWorkbench
        className={styles.layout}
        configuration={configuration}
        results={results}
        resultCount={selectedCount}
        configurationLabel={addTab === 'local' ? 'Configuration' : 'Source'}
        resultsLabel={addTab === 'local' ? 'Skills' : 'Contents'}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              aria-label={addTab === 'local' ? '添加 Local Skill' : '添加 Source'}
              onClick={addTab === 'local' ? handleAddLocal : handleAddSource}
              disabled={
                addBusy ||
                (addTab === 'local'
                  ? selectedCount === 0
                  : !srcUrl.trim() || !srcTree || srcSelection.memberEntries.size === 0)
              }
            >
              {addBusy
                ? '添加中…'
                : addTab === 'local'
                  ? `Import ${selectedCount} skills`
                  : `Add source (${srcSelection.memberEntries.size})`}
            </Button>
          </>
        }
      />
    </Modal>
  )
}
