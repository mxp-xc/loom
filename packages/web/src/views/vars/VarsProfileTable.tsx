import { useMemo } from 'react'
import { Eye, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { IconButton } from '@/components/ui/IconButton'
import { agentColor, agentShort } from '../../lib/agents'
import type { AgentId } from '../../lib/agents'
import type { VarsProfileEntry } from './profile-model'

type VarsProfileTableProps = {
  entries: VarsProfileEntry[]
  search: string
  onView: (entry: VarsProfileEntry) => void
  onEdit: (entry: VarsProfileEntry) => void
  onAdd: (entry: VarsProfileEntry) => void
  onClear: (entry: VarsProfileEntry) => void
}

function AgentChips({ slots }: { slots: AgentId[] }) {
  if (slots.length === 0) return <span className="vars-slot-dash">—</span>
  return (
    <span className="vars-slots">
      {slots.map((slot) => (
        <span
          key={slot}
          className="vars-slot-chip"
          data-a={slot === 'claude-code' ? 'cc' : slot === 'codex' ? 'cx' : 'oc'}
          style={{ ['--c' as string]: agentColor[slot] }}
        >
          {agentShort[slot]}
        </span>
      ))}
    </span>
  )
}

function KeyCell({ entry }: { entry: VarsProfileEntry }) {
  return (
    <span className="vars-key-cell">
      <span className="vars-key">{entry.key}</span>
      <span className="vars-type-stack">
        <span className="vars-type-main">{entry.type}</span>
        {entry.format && <span className="vars-format">{entry.format}</span>}
      </span>
    </span>
  )
}

function RowActions({
  entry,
  onView,
  onEdit,
  onAdd,
  onClear,
}: Omit<VarsProfileTableProps, 'entries' | 'search'> & { entry: VarsProfileEntry }) {
  if (entry.state === 'readonly') {
    return (
      <span className="vars-row-actions">
        <IconButton label={'查看 ' + entry.key} tooltip="查看" onClick={() => onView(entry)}>
          <Eye size={14} />
        </IconButton>
      </span>
    )
  }

  if (entry.state === 'available') {
    return (
      <span className="vars-row-actions">
        <IconButton
          label={'新建 ' + entry.key + ' 配置'}
          tooltip="新建配置"
          onClick={() => onAdd(entry)}
        >
          <Plus size={14} />
        </IconButton>
      </span>
    )
  }

  return (
    <span className="vars-row-actions">
      <IconButton label={'编辑 ' + entry.key} tooltip="编辑" onClick={() => onEdit(entry)}>
        <Pencil size={14} />
      </IconButton>
      <IconButton
        label={'清除 ' + entry.key + ' 配置'}
        tooltip="清除配置"
        tone="danger"
        className="vars-danger-action"
        onClick={() => onClear(entry)}
      >
        <Trash2 size={14} />
      </IconButton>
      <IconButton label={entry.key + ' 更多操作'} tooltip="更多操作" disabled>
        <MoreHorizontal size={14} />
      </IconButton>
    </span>
  )
}

export default function VarsProfileTable({
  entries,
  search,
  onView,
  onEdit,
  onAdd,
  onClear,
}: VarsProfileTableProps) {
  const query = search.trim().toLowerCase()
  const visibleEntries = query
    ? entries.filter((entry) => {
        const text = [entry.key, entry.type, entry.format, entry.valuePreview]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return text.includes(query)
      })
    : entries
  const columns = useMemo<Array<DataTableColumn<VarsProfileEntry>>>(
    () => [
      {
        id: 'key',
        header: 'key',
        cell: (entry) => <KeyCell entry={entry} />,
        className: 'vars-col-key',
      },
      {
        id: 'value',
        header: '当前值',
        cell: (entry) => entry.valuePreview || '未配置',
        className: 'vars-col-value',
        cellClassName: 'vars-value',
      },
      {
        id: 'slots',
        header: 'Agent 专属',
        cell: (entry) => <AgentChips slots={entry.agentSlots} />,
        className: 'vars-col-slots',
        cellClassName: 'vars-slots-cell',
      },
      {
        id: 'actions',
        header: '操作',
        cell: (entry) => (
          <RowActions
            entry={entry}
            onView={onView}
            onEdit={onEdit}
            onAdd={onAdd}
            onClear={onClear}
          />
        ),
        className: 'vars-col-actions',
        cellClassName: 'vars-actions-cell',
      },
    ],
    [onAdd, onClear, onEdit, onView],
  )

  return (
    <DataTable
      ariaLabel="变量列表"
      className="vars-table"
      tableClassName="vars-table-grid"
      columns={columns}
      rows={visibleEntries}
      getRowId={(entry) => entry.key}
      rowClassName={(entry) => entry.state}
      emptyMessage="当前列表没有变量。"
      emptyClassName="vars-table-empty"
    />
  )
}
