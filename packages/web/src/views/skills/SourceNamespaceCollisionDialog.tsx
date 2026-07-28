import { Archive } from 'lucide-react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { agentName } from '@/lib/agents'
import type { SourceNamespaceCollision } from '@/hooks/useManifestOperations'

interface Props {
  collision: SourceNamespaceCollision | null
  busy: boolean
  onClose: () => void
  onResolve: () => Promise<unknown>
}

export default function SourceNamespaceCollisionDialog({
  collision,
  busy,
  onClose,
  onResolve,
}: Props) {
  return (
    <Modal
      open={collision !== null}
      onClose={onClose}
      title="Skill 目录冲突"
      width={460}
      busy={busy}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'grid',
              width: 34,
              height: 34,
              flex: '0 0 34px',
              placeItems: 'center',
              border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))',
              borderRadius: 'var(--radius)',
              color: 'var(--warning)',
              background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
            }}
          >
            <Archive size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, color: 'var(--bright)', fontSize: 14, lineHeight: 1.5 }}>
              {agentName[collision?.agent ?? 'codex']} 中已有同名目录{' '}
              <strong>{collision?.sourceName}</strong>，但它不是 Loom 创建的。
            </p>
            <p
              style={{
                margin: '8px 0 0',
                color: 'var(--muted)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              Loom 会将原目录完整移动到 Agent 配置目录下的
              skill-backups，再创建受管投影。若还有其他冲突，会继续逐项确认；其他投影失败时，原目录会自动恢复。
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" size="sm" disabled={busy} data-autofocus onClick={onClose}>
            保留现有目录
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void onResolve()}>
            {busy ? '处理中…' : '备份并改由 Loom 管理'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
