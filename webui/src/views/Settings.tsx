import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { ConfigField, type ConfigLevel } from '@/components/ConfigField'

type Config = {
  effective: Record<string, unknown>
  repo: Record<string, unknown>
  local: Record<string, unknown>
}

export default function Settings({ repoPath }: { repoPath: string }) {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState<ConfigLevel>('effective')

  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .getConfig(repoPath)
      .then((c) => {
        if (!cancelled) setCfg(c as Config)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  if (error) {
    return (
      <div className="p-4" style={{ color: 'var(--color-error)' }}>
        配置加载失败:{error}
      </div>
    )
  }
  if (!cfg) return <div className="p-4">加载中…</div>

  // active_repo 固定本地级,仓库级 tab 不展示(spec 行 127)
  const allFields = Object.keys({ ...cfg.repo, ...cfg.local, ...cfg.effective })
  const fields = level === 'repo' ? allFields.filter((f) => f !== 'active_repo') : allFields

  return (
    <div className="space-y-2 p-4">
      <h1 className="text-xl font-bold">Settings</h1>
      <Tabs value={level} onValueChange={(v) => setLevel(v as ConfigLevel)}>
        <TabsList>
          <TabsTrigger value="effective">最终结果</TabsTrigger>
          <TabsTrigger value="repo">仓库级</TabsTrigger>
          <TabsTrigger value="local">本地级</TabsTrigger>
        </TabsList>
        <TabsContent value={level} className="mt-2 space-y-2">
          {fields.map((f) => (
            <ConfigField
              key={f}
              name={f}
              level={level}
              value={(cfg[level] as Record<string, unknown>)[f]}
              inRepo={f in cfg.repo}
              inLocal={f in cfg.local}
              fixed={f === 'active_repo'}
            />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}
