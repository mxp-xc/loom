import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { inputStyle } from '@/lib/styles'
import { Search, FolderOpen, RefreshCw } from 'lucide-react'
import { Segmented } from './Segmented'
import type { ScanMember, LocalScanResult } from './types'

interface Props {
  open: boolean
  repoPath: string
  reload: () => void
  onClose: () => void
}

const DEFAULT_LOCAL_DIR = '~/.agents/skills/'
const mono = "'JetBrains Mono', monospace"

// Strip trailing slashes so '~/.agents/skills/' and '~/.agents/skills' match.
const norm = (p: string) => p.trim().replace(/[\\/]+$/, '')

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

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingLeft: 28, marginBottom: 0 }}
      />
    </div>
  )
}

export default function AddSkillModal({ open, repoPath, reload, onClose }: Props) {
  const [addTab, setAddTab] = useState<'local' | 'source'>('local')
  const [addBusy, setAddBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)

  // Local tab
  const [localPath, setLocalPath] = useState(DEFAULT_LOCAL_DIR)
  const [localScanning, setLocalScanning] = useState(false)
  const [localSkills, setLocalSkills] = useState<LocalScanResult[]>([])
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set())
  const [localSearch, setLocalSearch] = useState('')
  const [importMode, setImportMode] = useState<'move' | 'ref'>('move')

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
  const [srcSearch, setSrcSearch] = useState('')

  const isDefaultDir = norm(localPath) === norm(DEFAULT_LOCAL_DIR)

  const scanLocal = useCallback(async (dir: string) => {
    const d = dir.trim()
    if (!d) return
    setLocalScanning(true)
    setAddErr(null)
    try {
      const res = await api.scanLocalSkills(d)
      if (res.ok) {
        const skills = res.skills ?? []
        setLocalSkills(skills)
        // Pre-select everything discovered so the bulk-import button is
        // immediately useful; the user can untick what they don't want.
        setLocalSelected(new Set(skills.map((s) => s.name)))
      } else {
        setLocalSkills([])
        setLocalSelected(new Set())
        setAddErr(res.message || res.error || '扫描失败')
      }
    } catch (e) {
      setLocalSkills([])
      setLocalSelected(new Set())
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalScanning(false)
    }
  }, [])

  // Reset every field and kick off the initial local scan each time the
  // modal opens.
  useEffect(() => {
    if (!open) return
    setAddErr(null)
    setAddBusy(false)
    setAddTab('local')
    setLocalPath(DEFAULT_LOCAL_DIR)
    setLocalSearch('')
    setLocalSkills([])
    setLocalSelected(new Set())
    setImportMode('move')
    setSrcUrl('')
    setSrcType('branch')
    setSrcRef('')
    setSrcBranches([])
    setSrcTags([])
    setSrcMembers([])
    setSrcSelected(new Set())
    setSrcSearch('')
    setSrcScanned(false)
    void scanLocal(DEFAULT_LOCAL_DIR)
  }, [open, scanLocal])

  const fetchRefs = async (url: string) => {
    if (!url) return
    setSrcRefsLoading(true)
    setAddErr(null)
    try {
      const res = await api.getSourceRefs(url)
      if (res.ok) {
        const branches = res.branches ?? []
        const tags = res.tags ?? []
        setSrcBranches(branches)
        setSrcTags(tags)
        const list = srcType === 'tag' ? tags : branches
        setSrcRef(list[0] ?? '')
      } else {
        setAddErr(res.message || res.error || '获取 refs 失败')
      }
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
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
      const res = await api.scanSource(srcUrl.trim())
      if (Array.isArray(res.members)) {
        setSrcMembers(res.members)
        // Pre-select not-yet-installed members; installed ones stay locked.
        setSrcSelected(new Set(res.members.filter((m) => !m.installed).map((m) => m.name)))
      } else {
        setAddErr('扫描失败')
      }
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
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
    // Skills already living in the default dir only need to be registered.
    const mode = isDefaultDir ? 'ref' : importMode
    setAddBusy(true)
    setAddErr(null)
    try {
      const res = await api.importLocalSkills({
        repoPath,
        skills: selected.map((s) => ({ name: s.name, path: s.path })),
        mode,
      })
      if (res.ok) {
        onClose()
        reload()
      } else {
        setAddErr('导入失败')
      }
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
      // Persist selected members from Scan so they aren't lost.
      if (srcSelected.size > 0) {
        try {
          await api.setSourceMembers({
            repoPath,
            url: srcUrl.trim(),
            members: [...srcSelected],
          })
        } catch {
          // Source was created successfully; member selection failure is non-fatal.
        }
      }
      onClose()
      reload()
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  const filteredLocal = localSkills.filter((s) =>
    s.name.toLowerCase().includes(localSearch.trim().toLowerCase()),
  )
  const refOptions = srcType === 'tag' ? srcTags : srcBranches
  const filteredSrc = srcMembers.filter((s) =>
    s.name.toLowerCase().includes(srcSearch.trim().toLowerCase()),
  )

  return (
    <Modal open={open} onClose={onClose} title="Add Skill" width={560}>
      <div style={{ marginBottom: 16 }}>
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
          <div style={{ marginBottom: 14 }}>
            <span className="label">path</span>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder={DEFAULT_LOCAL_DIR}
                style={{ ...inputStyle, marginTop: 0, flex: 1 }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => scanLocal(localPath)}
                disabled={localScanning}
                title="浏览 / 重新扫描"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </Button>
            </div>
          </div>

          {localSkills.length > 0 && (
            <SearchInput value={localSearch} onChange={setLocalSearch} placeholder="搜索 skill…" />
          )}

          <div style={listBox}>
            {localScanning ? (
              <div style={placeholderStyle}>扫描中…</div>
            ) : localSkills.length === 0 ? (
              <div style={placeholderStyle}>未发现 SKILL.md</div>
            ) : filteredLocal.length === 0 ? (
              <div style={placeholderStyle}>无匹配</div>
            ) : (
              filteredLocal.map((s) => {
                const checked = localSelected.has(s.name)
                return (
                  <label key={s.path} style={{ ...rowStyle, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setLocalSelected((prev) => {
                          const n = new Set(prev)
                          if (e.target.checked) n.add(s.name)
                          else n.delete(s.name)
                          return n
                        })
                      }}
                    />
                    <span style={{ flex: 1, fontFamily: mono, fontSize: 12 }}>{s.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: mono }}>
                      SKILL.md
                    </span>
                  </label>
                )
              })
            )}
          </div>

          {!isDefaultDir && localSkills.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="label" style={{ marginBottom: 6 }}>
                import mode
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontFamily: mono,
                  fontSize: 12,
                }}
              >
                <input
                  type="radio"
                  name="importMode"
                  checked={importMode === 'move'}
                  onChange={() => setImportMode('move')}
                />
                <span>移动到 ~/.agents/skills (推荐)</span>
              </label>
              <div
                style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 24, marginBottom: 6 }}
              >
                移动目录,git 同步,跨机器可用
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontFamily: mono,
                  fontSize: 12,
                }}
              >
                <input
                  type="radio"
                  name="importMode"
                  checked={importMode === 'ref'}
                  onChange={() => setImportMode('ref')}
                />
                <span>仅引用登记</span>
              </label>
              <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 24 }}>
                不移动,在 yaml 登记路径,其他机器可能没有
              </div>
            </div>
          )}

          <Button
            variant="primary"
            onClick={handleAddLocal}
            disabled={addBusy || localSelected.size === 0}
            style={{ width: '100%' }}
          >
            {addBusy ? '添加中…' : `添加 ${localSelected.size} 个 Local Skill`}
          </Button>
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

          {srcMembers.length > 0 && (
            <SearchInput value={srcSearch} onChange={setSrcSearch} placeholder="搜索 skill…" />
          )}

          {(srcScanning || srcScanned) && (
            <div style={listBox}>
              {srcScanning ? (
                <div style={placeholderStyle}>扫描中…</div>
              ) : srcMembers.length === 0 ? (
                <div style={placeholderStyle}>未发现 SKILL.md</div>
              ) : filteredSrc.length === 0 ? (
                <div style={placeholderStyle}>无匹配</div>
              ) : (
                filteredSrc.map((m) => {
                  const checked = srcSelected.has(m.name)
                  return (
                    <label
                      key={m.path}
                      style={{
                        ...rowStyle,
                        cursor: m.installed ? 'default' : 'pointer',
                        opacity: m.installed ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={m.installed}
                        onChange={(e) => {
                          setSrcSelected((prev) => {
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
