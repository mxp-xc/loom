import { useMemo } from 'react'
import { Eye } from 'lucide-react'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { IconButton } from '@/components/ui/IconButton'
import { AGENTS, agentColor, agentShort } from '../../lib/agents'
import type { AgentId } from '../../lib/agents'
import type { VarsResolvedRow } from './profile-model'
import styles from './Vars.module.css'

type VarsResolvedViewProps = {
  rows: VarsResolvedRow[]
  activeAgent: AgentId
  onAgentChange: (agent: AgentId) => void
}

function KeyCell({ row }: { row: VarsResolvedRow }) {
  return (
    <span className={styles['vars-key-cell']}>
      <span className={styles['vars-key']}>{row.key}</span>
      <span className={styles['vars-type-stack']}>
        <span className={styles['vars-type-main']}>{row.type}</span>
        {row.format && <span className={styles['vars-format']}>{row.format}</span>}
      </span>
    </span>
  )
}

export default function VarsResolvedView({
  rows,
  activeAgent,
  onAgentChange,
}: VarsResolvedViewProps) {
  const columns = useMemo<Array<DataTableColumn<VarsResolvedRow>>>(
    () => [
      {
        id: 'key',
        header: 'key',
        cell: (row) => <KeyCell row={row} />,
        className: styles['vars-col-key'],
      },
      {
        id: 'value',
        header: '最终值',
        cell: (row) => row.valuePreview || '未配置',
        className: styles['vars-col-value'],
        cellClassName: styles['vars-value'],
      },
      {
        id: 'source',
        header: '来源',
        cell: (row) => row.sourceLabel,
        className: styles['vars-col-source'],
        cellClassName: styles['vars-source'],
      },
      {
        id: 'actions',
        header: '操作',
        cell: (row) => (
          <span className={styles['vars-row-actions']}>
            <IconButton label={row.key + ' 详情稍后接入'} tooltip="详情稍后接入" disabled>
              <Eye size={14} />
            </IconButton>
          </span>
        ),
        className: styles['vars-col-actions'],
        cellClassName: styles['vars-actions-cell'],
      },
    ],
    [],
  )

  return (
    <main className={styles['vars-main']} aria-label="最终结果">
      <section className={styles['vars-section-head']}>
        <div>
          <div className={styles['vars-eyebrow']}>resolved</div>
          <h2>当前 agent 的最终变量</h2>
          <p>只读查看解析后的最终值与来源。</p>
        </div>
        <div className="target-chips" aria-label="最终结果 agent">
          {AGENTS.map((agent) => (
            <button
              key={agent}
              type="button"
              className="target-chip"
              data-state={activeAgent === agent ? 'on' : 'off'}
              style={{ ['--c' as string]: agentColor[agent] }}
              onClick={() => onAgentChange(agent)}
            >
              {agentShort[agent]}
            </button>
          ))}
        </div>
      </section>

      <DataTable
        ariaLabel="解析结果"
        className={styles['vars-table']}
        tableClassName={styles['vars-table-grid']}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.key}
        emptyMessage="当前 agent 没有解析结果。"
        emptyClassName={styles['vars-table-empty']}
      />
    </main>
  )
}
