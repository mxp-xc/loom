import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { Dropdown } from '@/components/ui/dropdown'
import { Folder, FolderOpen, GitFork, RefreshCw } from 'lucide-react'
import { deriveRepoId } from '@loom/core'
import { Segmented } from './Segmented'
import type { ScanMember, LocalScanResult } from './types'
import { useManifestOperations } from '@/hooks/useManifestOperations'
import styles from './AddSkillModal.module.css'
import SkillWorkbench, { SkillWorkbenchTitle } from './SkillWorkbench'
import SkillSelectionList, { type SkillSelectionItem } from './SkillSelectionList'

interface Props {
  open: boolean
  repoPath: string
  onClose: () => void
}

// Repository assets are auto-discovered separately; adding starts from the
// user's shared cross-agent skill directory.
const DEFAULT_LOCAL_DIR = '~/.agents/skills'
const mono = "'JetBrains Mono', monospace"

export default function AddSkillModal({ open, repoPath, onClose }: Props) {
  const operations = useManifestOperations(repoPath)
  const { scanLocalSkills, loadSourceRefs, scanSourceMembers, addLocalSkills, addSource } =
    operations
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
  const [srcScan, setSrcScan] = useState('')
  const [srcBranches, setSrcBranches] = useState<string[]>([])
  const [srcTags, setSrcTags] = useState<string[]>([])
  const [srcRefsLoading, setSrcRefsLoading] = useState(false)
  const [srcScanning, setSrcScanning] = useState(false)
  const [srcScanned, setSrcScanned] = useState(false)
  const [srcMembers, setSrcMembers] = useState<ScanMember[]>([])
  const [srcSelected, setSrcSelected] = useState<Set<string>>(new Set())

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
    // Group files by the SKILL.md's parent directory name — same shape the
    // server-side scan produces (name = basename(dirname(SKILL.md))).
    const bySkill = new Map<string, Array<{ path: string; content: string }>>()
    const readText = async (f: File) => {
      try {
        return await f.text()
      } catch {
        return null
      }
    }
    for (const f of Array.from(files)) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name
      const parts = rel.split('/')
      // parts[0] is the chosen root dir name; drop it so the stored path is
      // relative to the skill folder itself.
      const inSkill = parts.slice(1).join('/')
      if (!inSkill || !inSkill.endsWith('SKILL.md')) continue
      const skillName = parts.length > 2 ? parts[parts.length - 2] : parts[0]
      const content = await readText(f)
      if (content === null) continue
      bySkill.set(skillName, [{ path: 'SKILL.md', content }])
    }
    // Also collect sibling files next to each discovered SKILL.md so a
    // multi-file skill (references, assets) survives the import.
    for (const f of Array.from(files)) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name
      const parts = rel.split('/')
      const inSkill = parts.slice(1).join('/')
      if (!inSkill || inSkill.endsWith('SKILL.md')) continue
      const skillName = parts.length > 2 ? parts[1] : parts[0]
      if (!bySkill.has(skillName)) continue
      const content = await readText(f)
      if (content === null) continue
      const arr = bySkill.get(skillName)!
      const skillRel = parts.slice(2).join('/')
      arr.push({ path: skillRel || inSkill, content })
    }
    const skills: LocalScanResult[] = Array.from(bySkill.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: name }))
    setLocalSkills(skills)
    setLocalSelected(new Set(skills.map((s) => s.name)))
    setPickedFiles(bySkill)
    setPickedExternal(true)
    setLocalPath('(外部目录)')
    setAddErr(null)
  }, [])

  // Reset every field and kick off the initial local scan each time the
  // modal opens.
  useEffect(() => {
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
    setSrcScan('')
    setSrcBranches([])
    setSrcTags([])
    setSrcMembers([])
    setSrcSelected(new Set())
    setSrcScanned(false)
    void scanLocal(DEFAULT_LOCAL_DIR)
  }, [open, scanLocal])

  const fetchRefs = async (url: string) => {
    if (!url) return
    if (!srcNameTouched) setSrcName(deriveRepoId(url))
    setSrcRefsLoading(true)
    setAddErr(null)
    try {
      const res = await loadSourceRefs(url)
      if (res.ok) {
        const branches = res.result?.branches ?? []
        const tags = res.result?.tags ?? []
        setSrcBranches(branches)
        setSrcTags(tags)
        const list = srcType === 'tag' ? tags : branches
        setSrcRef(list[0] ?? '')
      } else {
        setAddErr(res.message || '获取 refs 失败')
      }
    } finally {
      setSrcRefsLoading(false)
    }
  }

  const handleTypeChange = (t: 'branch' | 'tag') => {
    setSrcType(t)
    const list = t === 'tag' ? srcTags : srcBranches
    setSrcRef(list[0] ?? '')
  }

  const handleScanSource = async () => {
    if (!srcUrl.trim()) {
      setAddErr('url 不能为空')
      return
    }
    setSrcScanning(true)
    setSrcScanned(true)
    setAddErr(null)
    setSrcMembers([])
    try {
      const res = await scanSourceMembers(srcUrl.trim(), {
        ref: srcRef.trim() || undefined,
        type: srcType,
        scan: srcScan,
      })
      if (res.ok && Array.isArray(res.result?.members)) {
        const members = res.result.members as ScanMember[]
        setSrcMembers(members)
        // Pre-select not-yet-installed members; installed ones stay locked.
        setSrcSelected(new Set(members.filter((m) => !m.installed).map((m) => m.name)))
      } else {
        setAddErr(res.message || '扫描失败')
      }
    } finally {
      setSrcScanning(false)
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
        ref: srcRef.trim() || 'main',
        type: srcType,
        scan: srcScan,
        members: [...srcSelected],
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
  const refOptions = srcType === 'tag' ? srcTags : srcBranches
  const sourceListItems: SkillSelectionItem[] = srcMembers.map((member) => ({
    id: member.name,
    description: member.description,
    path: member.path,
    installed: member.installed,
  }))

  const configuration = (
    <div className={styles.configStack}>
      <div className={styles['add-skill-tabs']}>
        <Segmented
          value={addTab}
          onChange={(t) => {
            setAddTab(t)
            setAddErr(null)
          }}
          options={[
            { value: 'local', label: 'Local Skill' },
            { value: 'source', label: 'Source' },
          ]}
        />
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
                onChange={(e) => setSrcUrl(e.target.value)}
                onBlur={() => srcUrl.trim() && void fetchRefs(srcUrl.trim())}
                placeholder="https://github.com/org/repo"
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
                setSrcName(e.target.value)
                setSrcNameTouched(true)
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
                onChange={setSrcRef}
                options={refOptions.map((item) => ({ value: item, label: item }))}
                disabled={srcRefsLoading || refOptions.length === 0}
                placeholder={srcRefsLoading ? '加载中…' : '—'}
              />
            </div>
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Scan pattern</span>
            <div className={styles.patternRow}>
              <input
                id="add-source-scan-pattern"
                aria-label="scan pattern"
                value={srcScan}
                onChange={(e) => setSrcScan(e.target.value)}
                placeholder="**/SKILL.md"
                className={styles.control}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleScanSource}
                disabled={srcScanning || !srcUrl.trim()}
              >
                <RefreshCw className={srcScanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                Scan repository
              </Button>
            </div>
            <small>留空使用 {<code style={{ fontFamily: mono }}>**/SKILL.md</code>}</small>
          </label>
        </>
      )}
    </div>
  )

  const listItems = addTab === 'local' ? localListItems : sourceListItems
  const selected = addTab === 'local' ? localSelected : srcSelected
  const results = (addTab === 'local' ? localScanning : srcScanning) ? (
    <div className={styles.resultState}>正在扫描 SKILL.md…</div>
  ) : (
    <SkillSelectionList
      ariaLabel={addTab === 'local' ? 'Local Skill' : 'Source members'}
      items={listItems}
      selectedIds={selected}
      onSelectedIdsChange={addTab === 'local' ? setLocalSelected : setSrcSelected}
      repositoryLabel={
        addTab === 'local'
          ? localPath
          : `${deriveRepoId(srcUrl) || 'repository'} · ${srcRef || 'ref'}`
      }
      emptyMessage={
        addTab === 'source' && !srcScanned
          ? 'Scan the repository to discover skills'
          : 'No skills found'
      }
    />
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Add Skill"
      title={
        <SkillWorkbenchTitle
          icon={addTab === 'local' ? <FolderOpen size={17} /> : <GitFork size={17} />}
          eyebrow="Add skill"
          title={addTab === 'local' ? 'Skills' : 'Source'}
        />
      }
      width={1040}
      className={styles.dialog}
      bodyClassName={styles.body}
      headerClassName={styles.header}
      titleClassName={styles.modalTitle}
    >
      <SkillWorkbench
        configuration={configuration}
        results={results}
        resultCount={selected.size}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              aria-label={addTab === 'local' ? '添加 Local Skill' : '添加 Source'}
              onClick={addTab === 'local' ? handleAddLocal : handleAddSource}
              disabled={addBusy || (addTab === 'local' ? selected.size === 0 : !srcUrl.trim())}
            >
              {addBusy
                ? '添加中…'
                : addTab === 'local'
                  ? `Import ${selected.size} skills`
                  : `Add source (${selected.size})`}
            </Button>
          </>
        }
      />
    </Modal>
  )
}
