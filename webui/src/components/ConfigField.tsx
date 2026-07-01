export type ConfigLevel = 'effective' | 'repo' | 'local'

// sdot-cfg 四态(spec 行 426):
//   实心蓝锁=固定本地(active_repo)、绿=生效自仓库级、实心蓝=生效自本地级/本地覆盖、空心灰=继承/两处未设
export function ConfigField({
  name,
  value,
  level,
  inRepo,
  inLocal,
  fixed,
}: {
  name: string
  value: unknown
  level: ConfigLevel
  inRepo: boolean
  inLocal: boolean
  fixed: boolean
}) {
  let dotClass = ''
  let title = ''
  if (fixed) {
    dotClass = 'sdot-cfg fixed'
    title = '固定本地级'
  } else if (level === 'effective') {
    if (inLocal) {
      dotClass = 'sdot-cfg local'
      title = '生效自本地级'
    } else if (inRepo) {
      dotClass = 'sdot-cfg repo'
      title = '生效自仓库级'
    } else {
      dotClass = 'sdot-cfg inherit'
      title = '两处未设'
    }
  } else if (level === 'local') {
    dotClass = inLocal ? 'sdot-cfg local' : 'sdot-cfg inherit'
    title = inLocal ? '本地覆盖' : '继承仓库级'
  }
  // repo tab 不展示 sdot(active_repo 固定字段已在 Settings 过滤)

  return (
    <div className="flex items-center gap-2">
      {dotClass && <span className={dotClass} title={title} />}
      <span className="w-40 text-sm" style={{ fontFamily: "'Fira Code', monospace" }}>
        {name}
      </span>
      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        {String(value ?? '(空)')}
      </span>
    </div>
  )
}
