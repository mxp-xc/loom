import { AlertTriangle, KeyRound, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import type { VarEntry, VarsDiagnostic } from '../../lib/vars'

interface Props {
  entries: Record<string, VarEntry>
  selectedKey: string | null
  onEdit: (key: string) => void
  onDelete: (key: string) => void
  onCreate: () => void
  diagnostics?: VarsDiagnostic[]
}

export default function VariableList({
  entries,
  selectedKey,
  onEdit,
  onDelete,
  onCreate,
  diagnostics = [],
}: Props) {
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
        <div className="vars-list-actions">
          <span className="vars-count">{Object.keys(entries).length}</span>
          <Button type="button" size="sm" variant="secondary" onClick={onCreate}>
            <Plus size={15} /> 新建变量
          </Button>
        </div>
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
      <div className="vars-variable-list" role="list">
        {filtered.map(([key, entry]) => {
          const warning = diagnostics.find(
            (item) => item.severity === 'warning' && item.key === key,
          )
          const warningText = warning
            ? `引用缺失：${warning.referencedKey ?? warning.path?.at(-1) ?? '未知变量'}`
            : null
          return (
            <div
              key={key}
              className={`vars-variable${warning ? 'vars-variable-warning' : ''}`}
              data-selected={selectedKey === key ? 'true' : undefined}
              role="listitem"
            >
              {warning ? <AlertTriangle size={16} aria-label="引用警告" /> : <KeyRound size={16} />}
              <span className="vars-variable-main">
                <span className="vars-variable-title">
                  <span className="vars-variable-name">{key}</span>
                  <span className={`vars-variable-type vars-variable-type-${entry.type}`}>
                    {entry.type}
                  </span>
                </span>
                {warningText && <span className="vars-variable-note">{warningText}</span>}
              </span>
              <span className="vars-variable-row-actions">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  aria-label={`编辑变量 ${key}`}
                  onClick={() => onEdit(key)}
                >
                  <Pencil size={13} />
                  编辑
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="vars-variable-delete"
                  aria-label={`删除变量 ${key}`}
                  onClick={() => onDelete(key)}
                >
                  <Trash2 size={13} />
                  删除
                </Button>
              </span>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="vars-inline-empty">{query ? '没有匹配的变量' : '此环境还没有变量'}</div>
        )}
      </div>
    </section>
  )
}
