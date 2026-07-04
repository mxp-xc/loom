import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { ConfigField, FIELD_SCHEMA, type ConfigLevel } from '@/components/ConfigField'
import { useViewError } from '@/hooks/useViewError'

type Config = Record<string, unknown>

interface ConfigResponse {
  effective: Config
  repo: Config
  local: Config
  profiles?: string[]
}

const CATEGORY_TABS = [
  { id: 'general', label: '通用', groups: ['Workspace', 'Projection', 'Updates'] },
  { id: 'network', label: '网络', groups: ['Proxy'] },
] as const

const LEVEL_HINTS: Record<ConfigLevel, string> = {
  effective: '生效值 + 来源;改值请切到对应级',
  repo: '编辑团队共享默认(随 git 同步);无值的字段占位',
  local: '编辑本机覆盖(不同步);未覆盖字段继承 repo,编辑即覆盖',
}

const LS_LEVEL = 'loom:settings:level'
const LS_CAT = 'loom:settings:catTab'

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function hasPath(obj: Record<string, unknown>, path: string): boolean {
  return getPath(obj, path) !== undefined
}

export default function Settings({ repoPath }: { repoPath: string }) {
  const [cfg, setCfg] = useState<ConfigResponse | null>(null)
  const { error, setError } = useViewError()
  const [level, setLevel] = useState<ConfigLevel>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_LEVEL) : null
    return saved === 'effective' || saved === 'repo' || saved === 'local' ? saved : 'effective'
  })
  const [catTab, setCatTab] = useState<string>(() => {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem(LS_CAT) : null) || 'general'
  })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingAll, setSavingAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .getConfig(repoPath)
      .then((c) => {
        if (!cancelled) setCfg(c as ConfigResponse)
      })
      .catch((e) => {
        if (!cancelled) setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const reload = () => {
    api
      .getConfig(repoPath)
      .then((c) => setCfg(c as ConfigResponse))
      .catch((e) => setError(e))
  }

  const handleDraftChange = (key: string, value: string | undefined) => {
    setDrafts((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
  }

  const handleSetLevel = (l: ConfigLevel) => {
    setLevel(l)
    localStorage.setItem(LS_LEVEL, l)
    setDrafts({})
  }

  const handleSetCatTab = (t: string) => {
    setCatTab(t)
    localStorage.setItem(LS_CAT, t)
    setDrafts({})
  }

  const discardAll = () => {
    setDrafts({})
  }

  const saveAll = async () => {
    const entries = Object.entries(drafts)
    if (!entries.length || level === 'effective') return
    setSavingAll(true)
    const savedKeys: string[] = []
    try {
      for (const [key, val] of entries) {
        await api.putConfig({
          repoPath,
          level: level as 'repo' | 'local',
          field: key,
          value: val || null,
        })
        savedKeys.push(key)
      }
      setDrafts({})
      reload()
    } catch (e) {
      setDrafts((prev) => {
        const next = { ...prev }
        for (const k of savedKeys) delete next[k]
        return next
      })
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingAll(false)
    }
  }

  if (error) {
    return (
      <div className="p-4" style={{ color: 'var(--error)' }}>
        配置加载失败:{error}
        <button
          onClick={() => {
            setError(null)
            reload()
          }}
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '7px 16px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted)',
            cursor: 'pointer',
            marginLeft: '12px',
          }}
        >
          重试
        </button>
      </div>
    )
  }
  if (!cfg) return <div className="p-4">加载中…</div>

  const activeCat = CATEGORY_TABS.find((t) => t.id === catTab)!
  const fieldsInTab = FIELD_SCHEMA.filter((f) =>
    (activeCat.groups as readonly string[]).includes(f.group),
  )
  const levelData = level === 'effective' ? cfg.effective : level === 'repo' ? cfg.repo : cfg.local
  const groupDesc =
    level === 'effective'
      ? '最终结果 · 生效值'
      : level === 'repo'
        ? '仓库级 · 随 git 同步'
        : '本地级 · 优先级最高 · 编辑或点左圆点覆盖'
  const dirtyCount = Object.keys(drafts).length

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">
          仓库级 &lt;repo&gt;/config.yaml(同步) + 本地级 ~/.loom/config.yaml(不同步,覆盖)
        </p>
      </div>

      {/* Category tabs */}
      <div className="cfg-cat-tabs">
        {CATEGORY_TABS.map((tab) => (
          <div
            key={tab.id}
            className={'cfg-cat-tab' + (catTab === tab.id ? ' on' : '')}
            onClick={() => handleSetCatTab(tab.id)}
          >
            {tab.label}
          </div>
        ))}
      </div>

      {/* Level switch */}
      <div className="cfg-lvl-bar">
        <span className="cfg-lvl-label">view</span>
        <div className="cfg-lvl-sw">
          {(['effective', 'repo', 'local'] as ConfigLevel[]).map((l) => (
            <div
              key={l}
              className={'cfg-lvl-opt' + (level === l ? ' on' : '')}
              data-l={l === 'effective' ? 'merged' : l}
              onClick={() => handleSetLevel(l)}
            >
              <span className="dotc" />
              {l === 'effective' ? '最终结果' : l === 'repo' ? '仓库级' : '本地级'}
            </div>
          ))}
        </div>
        <span className="cfg-lvl-hint">{LEVEL_HINTS[level]}</span>
      </div>

      {/* Group cards */}
      <div className="cfg-lvl-pane" data-l={level === 'effective' ? 'merged' : level}>
        {activeCat.groups.map((gName) => {
          const gFields = fieldsInTab.filter((f) => f.group === gName)
          if (!gFields.length) return null
          return (
            <div key={gName} className="cfg-group">
              <div className="cfg-group-head">
                <span className="cfg-group-title">{gName}</span>
                <span className="cfg-group-desc">{groupDesc}</span>
              </div>
              <div className="cfg-group-body">
                {gFields.map((field) => (
                  <ConfigField
                    key={field.key}
                    field={field}
                    level={level}
                    value={getPath(levelData, field.key)}
                    effectiveValue={getPath(cfg.effective, field.key)}
                    inRepo={hasPath(cfg.repo, field.key)}
                    inLocal={hasPath(cfg.local, field.key)}
                    repoPath={repoPath}
                    onSaved={reload}
                    draft={drafts[field.key]}
                    onDraftChange={handleDraftChange}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Save bar */}
      <div className="cfg-save-bar">
        <span className="cfg-dirty" style={{ visibility: dirtyCount > 0 ? 'visible' : 'hidden' }}>
          <span className="d" />
          {dirtyCount > 0 ? `${dirtyCount} 项未保存改动` : '仓库级改动会随下次上传同步'}
        </span>
        <button
          className="btn btn-ghost"
          onClick={discardAll}
          disabled={dirtyCount === 0}
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '7px 16px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted)',
            cursor: dirtyCount === 0 ? 'default' : 'pointer',
            opacity: dirtyCount === 0 ? 0.4 : 1,
          }}
        >
          放弃
        </button>
        <button
          className="btn btn-primary"
          onClick={saveAll}
          disabled={dirtyCount === 0 || savingAll || level === 'effective'}
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '7px 16px',
            borderRadius: 'var(--radius)',
            border: 'none',
            background: 'var(--primary)',
            color: 'var(--primary-fg)',
            cursor: dirtyCount === 0 || savingAll ? 'default' : 'pointer',
            marginLeft: 'auto',
            opacity: dirtyCount === 0 || savingAll ? 0.4 : 1,
          }}
        >
          {savingAll ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
