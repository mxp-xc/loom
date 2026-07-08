import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { SelectableList, type SelectableListItem } from '@/components/ui/selectable-list'
import { inputStyle } from '@/lib/styles'
import { FolderInput, RefreshCw } from 'lucide-react'
import { Segmented } from './Segmented'
import type { ScanMember, LocalScanResult } from './types'
import { useManifestOperations } from '@/hooks/useManifestOperations'
import styles from './AddSkillModal.module.css'

interface Props {
  open: boolean
  repoPath: string
  onClose: () => void
}

// Repository assets are auto-discovered separately; adding starts from the
// user's shared cross-agent skill directory.
const DEFAULT_LOCAL_DIR = '~/.agents/skills'
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
  maxHeight: 220,
  overflow: 'auto',
  marginBottom: 14,
}

const placeholderStyle: React.CSSProperties = {
  padding: '12px 10px',
  fontSize: 12,
  color: 'var(--muted)',
  fontFamily: mono,
}

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
  const [srcType, setSrcType] = useState<'branch' | 'tag'>('branch')
  const [srcRef, setSrcRef] = useState('')
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
    setSrcType('branch')
    setSrcRef('')
    setSrcBranches([])
    setSrcTags([])
    setSrcMembers([])
    setSrcSelected(new Set())
    setSrcScanned(false)
    void scanLocal(DEFAULT_LOCAL_DIR)
  }, [open, scanLocal])

  const fetchRefs = async (url: string) => {
    if (!url) return
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
      const res = await scanSourceMembers(srcUrl.trim())
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
        url: srcUrl.trim(),
        ref: srcRef.trim() || 'main',
        members: [...srcSelected],
      })
      if (res.ok) onClose()
      else setAddErr(res.message || '添加 source 失败')
    } finally {
      setAddBusy(false)
    }
  }

  const localListItems: SelectableListItem[] = localSkills.map((skill) => ({
    id: skill.name,
    label: skill.name,
    searchText: skill.name,
    meta: 'SKILL.md',
  }))
  const refOptions = srcType === 'tag' ? srcTags : srcBranches
  const sourceListItems: SelectableListItem[] = srcMembers.map((member) => ({
    id: member.name,
    label: member.name,
    searchText: member.name,
    disabled: member.installed,
    meta: member.installed ? '已安装' : undefined,
  }))

  return (
    <Modal open={open} onClose={onClose} title="Add Skill" width={600}>
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

      {addErr && <div style={errBox}>{addErr}</div>}

      {addTab === 'local' ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is a non-standard DOM attribute
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void handleBrowsePick(e.target.files)
              e.target.value = ''
            }}
          />
          <div className={styles['add-skill-section']}>
            <span className="label">path</span>
            <div className={styles['add-skill-path-row']}>
              <input
                value={localPath}
                onChange={(e) => {
                  setLocalPath(e.target.value)
                  setPickedExternal(false)
                }}
                placeholder={DEFAULT_LOCAL_DIR}
                style={{ ...inputStyle, marginTop: 0, flex: 1 }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                title="选择外部目录导入"
              >
                <FolderInput className="h-3.5 w-3.5" />
                Browse
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPickedExternal(false)
                  void scanLocal(localPath)
                }}
                disabled={localScanning || pickedExternal}
                title="重新扫描当前路径"
              >
                <RefreshCw className={localScanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              </Button>
            </div>
            <div className={styles['add-skill-helper']}>
              默认扫描 <code style={{ fontFamily: mono }}>~/.agents/skills</code> 并以 ref
              方式添加；仓库内 <code style={{ fontFamily: mono }}>assets/skills</code>{' '}
              会自动加载。Browse 可将其他目录导入仓库。
            </div>
          </div>

          {localScanning ? (
            <div className={styles['add-skill-results']} style={listBox}>
              <div style={placeholderStyle}>扫描中…</div>
            </div>
          ) : (
            <SelectableList
              ariaLabel="Local Skill"
              items={localListItems}
              selectedIds={localSelected}
              onSelectedIdsChange={setLocalSelected}
              searchPlaceholder="搜索 skill…"
              showSearch={localSkills.length > 0}
              emptyMessage="未发现 SKILL.md"
              noMatchesMessage="无匹配"
            />
          )}

          <div className={styles['add-skill-footer']}>
            <span className={styles['add-skill-selection']}>已选择 {localSelected.size} 项</span>
            <Button
              variant="primary"
              onClick={handleAddLocal}
              disabled={addBusy || localSelected.size === 0}
            >
              {addBusy ? '添加中…' : '添加 Local Skill'}
            </Button>
          </div>
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
              onBlur={() => {
                if (srcUrl.trim()) void fetchRefs(srcUrl.trim())
              }}
              placeholder="https://github.com/org/repo"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div className="label" style={{ marginBottom: 4 }}>
              type
            </div>
            <Segmented
              value={srcType}
              onChange={handleTypeChange}
              options={[
                { value: 'branch', label: 'branch' },
                { value: 'tag', label: 'tag' },
              ]}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <span className="label">ref</span>
            <select
              value={srcRef}
              onChange={(e) => setSrcRef(e.target.value)}
              disabled={srcRefsLoading || refOptions.length === 0}
              style={{ ...inputStyle, marginTop: 0, cursor: 'pointer' }}
            >
              {refOptions.length === 0 ? (
                <option value="">{srcRefsLoading ? '加载中…' : '—'}</option>
              ) : (
                refOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))
              )}
            </select>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleScanSource}
            disabled={srcScanning || !srcUrl.trim()}
            style={{ width: '100%', marginBottom: 14 }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {srcScanning ? '扫描中…' : 'Scan'}
          </Button>

          {(srcScanning || srcScanned) && (
            <>
              {srcScanning ? (
                <div style={listBox}>
                  <div style={placeholderStyle}>扫描中…</div>
                </div>
              ) : (
                <SelectableList
                  ariaLabel="Source members"
                  items={sourceListItems}
                  selectedIds={srcSelected}
                  onSelectedIdsChange={setSrcSelected}
                  searchPlaceholder="搜索 skill…"
                  showSearch={srcMembers.length > 0}
                  emptyMessage="未发现 SKILL.md"
                  noMatchesMessage="无匹配"
                />
              )}
            </>
          )}

          <Button
            variant="primary"
            onClick={handleAddSource}
            disabled={addBusy || !srcUrl.trim()}
            style={{ width: '100%' }}
          >
            {addBusy ? '添加中…' : '添加 Source'}
          </Button>
        </>
      )}
    </Modal>
  )
}
