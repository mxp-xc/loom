import { useEffect, useMemo, useState } from 'react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import type { ManifestOperations } from '@/hooks/useManifestOperations'
import { AGENTS, agentName, agentShort, type AgentId } from '@/lib/agents'
import type { McpImportItem, McpImportScanResponse, McpImportSourceResult } from '@/lib/api'
import { FieldError } from '@/components/ErrorFeedback'
import styles from './McpImportDialog.module.css'

const IMPORT_SOURCES = AGENTS

interface McpImportDialogProps {
  open: boolean
  operations: ManifestOperations
  onClose: () => void
}

export default function McpImportDialog({ open, operations, onClose }: McpImportDialogProps) {
  const [scan, setScan] = useState<McpImportScanResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setScan(null)
    setSelected(new Set())
    operations.scanMcpImports(IMPORT_SOURCES).then((result) => {
      if (cancelled) return
      if (result.ok && result.result) {
        setScan(result.result)
        setSelected(
          new Set(
            result.result.items.filter((item) => item.selectedByDefault).map((item) => item.key),
          ),
        )
      } else {
        setError(result.message || '扫描 MCP 配置失败')
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, operations.scanMcpImports])

  const selectedKeys = useMemo(() => Array.from(selected), [selected])
  const busy = operations.pending.mcp.importScan || operations.pending.mcp.importApply

  const toggle = (item: McpImportItem) => {
    if (item.status === 'disabled') return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(item.key)) next.delete(item.key)
      else next.add(item.key)
      return next
    })
  }

  const confirm = async () => {
    setError(null)
    const result = await operations.applyMcpImports(selectedKeys, IMPORT_SOURCES)
    if (result.ok) {
      onClose()
    } else {
      setError(result.message || '导入 MCP Server 失败')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Import MCP servers" width={760} busy={busy}>
      <div className={styles.dialog}>
        <section className={styles.sources} aria-label="MCP import sources">
          {IMPORT_SOURCES.map((agent) => (
            <SourcePill
              key={agent}
              agent={agent}
              source={scan?.sources.find((item) => item.agent === agent)}
            />
          ))}
        </section>

        {error && <FieldError id="mcp-import-error">{error}</FieldError>}

        {!scan ? (
          <div className={styles.empty}>正在扫描 MCP 配置...</div>
        ) : scan.items.length === 0 ? (
          <div className={styles.empty}>未发现可导入的 MCP server</div>
        ) : (
          <div className={styles.list}>
            {scan.items.map((item) => (
              <label key={item.key} className={styles.item} data-status={item.status}>
                <input
                  type="checkbox"
                  aria-label={'导入 ' + item.finalId}
                  checked={selected.has(item.key)}
                  disabled={item.status === 'disabled'}
                  onChange={() => toggle(item)}
                />
                <span className={styles.itemMain}>
                  <span className={styles.itemTitle}>
                    <strong>{item.finalId}</strong>
                    {item.finalId !== item.id && <em>from {item.id}</em>}
                    <StatusBadge status={item.status} />
                  </span>
                  <span className={styles.itemMeta}>
                    {item.sourceAgents.map((agent) => agentShort[agent]).join(' + ')}
                    {' -> '}
                    {item.targets.map((agent) => agentShort[agent]).join(' + ')}
                    {item.server?.type ? ' · ' + item.server.type : ''}
                  </span>
                  {item.ignoredFields.length > 0 && (
                    <span className={styles.notice}>
                      ignored fields:
                      {item.ignoredFields.map((field) => (
                        <code key={field}>{field}</code>
                      ))}
                    </span>
                  )}
                  {item.diagnostics.map((diagnostic) => (
                    <span key={diagnostic.code + diagnostic.message} className={styles.notice}>
                      {diagnostic.message}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </div>
        )}

        <footer className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void confirm()}
            disabled={busy || selectedKeys.length === 0}
          >
            Confirm import
          </Button>
        </footer>
      </div>
    </Modal>
  )
}

function SourcePill({
  agent,
  source,
}: {
  agent: AgentId
  source: McpImportSourceResult | undefined
}) {
  const status = source?.status ?? 'ready'
  return (
    <span className={styles.source} data-status={status}>
      <strong>{agentShort[agent]}</strong>
      <span>{agentName[agent]}</span>
      <em>{sourceLabel(status)}</em>
    </span>
  )
}

function StatusBadge({ status }: { status: McpImportItem['status'] }) {
  return <span className={styles.status}>{status}</span>
}

function sourceLabel(status: McpImportSourceResult['status']) {
  if (status === 'missing_file') return 'missing'
  if (status === 'parse_failed') return 'failed'
  return 'ready'
}
