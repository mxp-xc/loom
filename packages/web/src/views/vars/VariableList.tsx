import { AlertTriangle, KeyRound, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { VarEntry, VarsDiagnostic } from '../../lib/vars'

interface Props {
  entries: Record<string, VarEntry>
  selectedKey: string | null
  onSelect: (key: string) => void
  diagnostics?: VarsDiagnostic[]
}

export default function VariableList({ entries, selectedKey, onSelect, diagnostics = [] }: Props) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () =>
      Object.entries(entries).filter(([key]) =>
        key.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [entries, query],
  )
  return (
    <section className="vars-list-pane" aria-labelledby="vars-list-title">
      <div className="vars-pane-heading">
        <div>
          <span className="vars-eyebrow">变量</span>
          <h2 id="vars-list-title">当前环境</h2>
        </div>
        <span className="vars-count">{Object.keys(entries).length}</span>
      </div>
      <label className="vars-search">
        <span className="sr-only">搜索变量</span>
        <Search size={16} />
        <input
          type="search"
          aria-label="搜索变量"
          placeholder="搜索变量"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="vars-variable-list">
        {filtered.map(([key, entry]) => {
          const warning = diagnostics.find(
            (item) => item.severity === 'warning' && item.key === key,
          )
          return (
            <button
              key={key}
              type="button"
              className={`vars-variable${warning ? 'vars-variable-warning' : ''}`}
              aria-pressed={selectedKey === key}
              onClick={() => onSelect(key)}
            >
              {warning ? <AlertTriangle size={16} aria-label="引用警告" /> : <KeyRound size={16} />}
              <span className="vars-variable-name">{key}</span>
              <span className="vars-variable-meta">
                <span>{entry.type}</span>
                <span>
                  {warning
                    ? `引用缺失：${warning.referencedKey ?? warning.path?.at(-1) ?? '未知变量'}`
                    : entry.type === 'secret'
                      ? '已隐藏'
                      : '可预览'}
                </span>
              </span>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <div className="vars-inline-empty">{query ? '没有匹配的变量' : '此环境还没有变量'}</div>
        )}
      </div>
    </section>
  )
}
