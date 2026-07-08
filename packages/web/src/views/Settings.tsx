import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { ConfigField, FIELD_SCHEMA, type ConfigLevel } from '@/components/ConfigField'
import { useViewError } from '@/hooks/useViewError'
import { useManifestOperations } from '@/hooks/useManifestOperations'
import { cn } from '@/lib/utils'
import styles from './Settings.module.css'

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
  const operations = useManifestOperations(repoPath, {
    onError: setError,
    onSuccess: () => setError(null),
  })
  const [level, setLevel] = useState<ConfigLevel>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_LEVEL) : null
    return saved === 'effective' || saved === 'repo' || saved === 'local' ? saved : 'effective'
  })
  const [catTab, setCatTab] = useState<string>(() => {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem(LS_CAT) : null) || 'general'
  })
  const [drafts, setDrafts] = useState<Record<string, string>>({})

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
    return api
      .getConfig(repoPath)
      .then((c) => setCfg(c as ConfigResponse))
      .catch((e) => setError(e))
  }

  const commitField = async (field: string, value: unknown) => {
    if (level === 'effective') return
    const result = await operations.saveConfig({ level, field, value })
    if (!result.ok) throw new Error(result.message || '保存配置失败')
    await reload()
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

  if (error) {
    return (
      <div className="p-4" style={{ color: 'var(--error)' }}>
        配置加载失败:{error}
        <button
          onClick={() => {
            setError(null)
            void reload()
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
  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">
          仓库级 &lt;repo&gt;/config.yaml(同步) + 本地级 ~/.loom/config.yaml(不同步,覆盖)
        </p>
      </div>

      {/* Category tabs */}
      <div className={styles['cfg-cat-tabs']}>
        {CATEGORY_TABS.map((tab) => (
          <div
            key={tab.id}
            className={cn(styles['cfg-cat-tab'], catTab === tab.id && styles.on)}
            onClick={() => handleSetCatTab(tab.id)}
          >
            {tab.label}
          </div>
        ))}
      </div>

      {/* Level switch */}
      <div className={styles['cfg-lvl-bar']}>
        <span className={styles['cfg-lvl-label']}>view</span>
        <div className={styles['cfg-lvl-sw']}>
          {(['effective', 'repo', 'local'] as ConfigLevel[]).map((l) => (
            <div
              key={l}
              className={cn(styles['cfg-lvl-opt'], level === l && styles.on)}
              data-l={l === 'effective' ? 'merged' : l}
              onClick={() => handleSetLevel(l)}
            >
              <span className={styles.dotc} />
              {l === 'effective' ? '最终结果' : l === 'repo' ? '仓库级' : '本地级'}
            </div>
          ))}
        </div>
        <span className={styles['cfg-lvl-hint']}>{LEVEL_HINTS[level]}</span>
      </div>

      {/* Group cards */}
      <div className={styles['cfg-lvl-pane']} data-l={level === 'effective' ? 'merged' : level}>
        {activeCat.groups.map((gName) => {
          const gFields = fieldsInTab.filter((f) => f.group === gName)
          if (!gFields.length) return null
          return (
            <div key={gName} className={styles['cfg-group']}>
              <div className={styles['cfg-group-head']}>
                <span className={styles['cfg-group-title']}>{gName}</span>
                <span className={styles['cfg-group-desc']}>{groupDesc}</span>
              </div>
              <div className={styles['cfg-group-body']}>
                {gFields.map((field) => (
                  <ConfigField
                    key={field.key}
                    field={field}
                    level={level}
                    value={getPath(levelData, field.key)}
                    effectiveValue={getPath(cfg.effective, field.key)}
                    inRepo={hasPath(cfg.repo, field.key)}
                    inLocal={hasPath(cfg.local, field.key)}
                    onCommit={commitField}
                    draft={drafts[field.key]}
                    onDraftChange={handleDraftChange}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
