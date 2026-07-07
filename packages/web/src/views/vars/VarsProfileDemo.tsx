import { useMemo, useState } from 'react'
import {
  Braces,
  CheckCircle2,
  Filter,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { IconButton } from '../../components/ui/IconButton'
import { AGENTS, agentColor, agentShort, type AgentId } from '../../lib/agents'
import './vars-profile-demo.css'

type ProfileKind = 'builtin' | 'base' | 'local' | 'custom'
type Profile = {
  id: string
  name: string
  kind: ProfileKind
  description: string
  configuredCount: number
  locked?: boolean
}
type Slot = 'default' | AgentId
type Entry = {
  key: string
  type: string
  format?: string
  value: string
  slots: Slot[]
  state: 'configured' | 'readonly' | 'available'
  diagnostic?: string
}
type ModalState = 'edit' | 'add' | null
type PreviewMode = 'edit' | 'raw' | 'resolved'

const profiles: Profile[] = [
  {
    id: 'builtin',
    name: 'Builtin',
    kind: 'builtin',
    description: '运行时内置 · 只读',
    configuredCount: 5,
    locked: true,
  },
  {
    id: 'base',
    name: 'Base',
    kind: 'base',
    description: '变量定义 registry',
    configuredCount: 12,
    locked: true,
  },
  {
    id: 'local',
    name: 'Local',
    kind: 'local',
    description: '本机专属',
    configuredCount: 2,
  },
  {
    id: 'prod',
    name: 'Prod',
    kind: 'custom',
    description: '自定义 profile',
    configuredCount: 0,
  },
]

const configuredEntries: Record<string, Entry[]> = {
  builtin: [
    {
      key: 'LOOM_AGENT',
      type: 'string',
      value: 'codex',
      slots: ['default'],
      state: 'readonly',
    },
    {
      key: 'LOOM_CONFIG_DIR',
      type: 'string',
      format: 'path',
      value: 'C:/Users/10107/.codex',
      slots: ['default'],
      state: 'readonly',
    },
    {
      key: 'LOOM_AGENT_FILE',
      type: 'string',
      format: 'path',
      value: 'AGENTS.md',
      slots: ['default'],
      state: 'readonly',
    },
  ],
  base: [
    {
      key: 'agent_name',
      type: 'string',
      format: 'markdown',
      value: 'Agent display name',
      slots: ['default', 'codex'],
      state: 'configured',
    },
    {
      key: 'memory.rtk',
      type: 'string',
      format: 'path',
      value: 'C:/Users/10107/.codex/RTK.md',
      slots: ['default'],
      state: 'configured',
    },
    {
      key: 'deploy.target',
      type: 'string',
      format: 'json',
      value: '{ "region": "cn", "tier": "prod" }',
      slots: ['default'],
      state: 'configured',
      diagnostic: 'JSON text 可格式化',
    },
  ],
  local: [
    {
      key: 'agent_name',
      type: 'string',
      format: 'markdown',
      value: 'Local Codex agent',
      slots: ['codex'],
      state: 'configured',
    },
    {
      key: 'memory.rtk',
      type: 'string',
      format: 'path',
      value: 'C:/Users/10107/.codex/RTK.md',
      slots: ['default'],
      state: 'configured',
    },
  ],
  prod: [],
}

const availableEntries: Entry[] = [
  {
    key: 'memory.context',
    type: 'string',
    format: 'markdown',
    value: '',
    slots: [],
    state: 'available',
  },
  {
    key: 'deploy.target',
    type: 'string',
    format: 'json',
    value: '',
    slots: [],
    state: 'available',
  },
]

const baseKeyOptions = [
  {
    key: 'memory.context',
    type: 'string',
    format: 'markdown',
    description: '长文本 memory 片段,可用于 agent 模板。',
  },
  {
    key: 'agent_name',
    type: 'string',
    format: 'markdown',
    description: 'agent 展示名,支持不同 agent 单独配置。',
  },
  {
    key: 'deploy.target',
    type: 'string',
    format: 'json',
    description: 'JSON 文本格式,用于演示格式化编辑。',
  },
]

const resolvedEntries = [
  {
    key: 'agent_name',
    value: 'Local Codex agent',
    source: 'Local · CX',
    type: 'string',
    format: 'markdown',
  },
  {
    key: 'memory.rtk',
    value: 'C:/Users/10107/.codex/RTK.md',
    source: 'Local',
    type: 'string',
    format: 'path',
  },
  {
    key: 'LOOM_AGENT',
    value: 'codex',
    source: 'Builtin',
    type: 'string',
  },
]

function profileBadge(profile: Profile) {
  if (profile.kind === 'builtin') return 'runtime'
  if (profile.kind === 'base') return 'locked'
  if (profile.kind === 'local') return 'local'
  return 'custom'
}

function slotLabel(slot: Slot) {
  if (slot === 'default') return 'default'
  return agentShort[slot]
}

function shortAgentId(agent: AgentId) {
  return agent === 'claude-code' ? 'cc' : agent === 'codex' ? 'cx' : 'oc'
}

function AgentChips({
  activeAgent,
  onChange,
  includeDefault,
  label = 'Agent',
}: {
  activeAgent: AgentId | 'default'
  onChange: (agent: AgentId | 'default') => void
  includeDefault?: boolean
  label?: string
}) {
  return (
    <div className="cfg-chips vars-lab-agent-chips" aria-label={label}>
      {includeDefault && (
        <button
          type="button"
          className={'achip' + (activeAgent === 'default' ? ' on' : ' off')}
          data-a="df"
          style={{ ['--c' as string]: 'var(--primary)' }}
          onClick={() => onChange('default')}
        >
          default
        </button>
      )}
      {AGENTS.map((agent) => (
        <button
          key={agent}
          type="button"
          className={'achip' + (activeAgent === agent ? ' on' : ' off')}
          data-a={shortAgentId(agent)}
          style={{ ['--c' as string]: agentColor[agent] }}
          onClick={() => onChange(agent)}
        >
          {agentShort[agent]}
        </button>
      ))}
    </div>
  )
}

function EntrySlots({ slots }: { slots: Slot[] }) {
  const configuredAgentSlots = AGENTS.filter((agent) => slots.includes(agent))

  return (
    <div className="vars-lab-slots" aria-label="已配置槽位">
      {configuredAgentSlots.length ? (
        configuredAgentSlots.map((slot) => (
          <span className="vars-lab-slot on" key={slot}>
            {slotLabel(slot)}
          </span>
        ))
      ) : (
        <span className="vars-lab-slot-empty">—</span>
      )}
    </div>
  )
}

function KeyCell({ entry }: { entry: { key: string; type: string; format?: string } }) {
  return (
    <span className="vars-lab-key-cell">
      <span className="vars-lab-key">{entry.key}</span>
      <TypeBadges type={entry.type} format={entry.format} />
    </span>
  )
}

function BaseKeyPicker({
  selectedKey,
  onChange,
}: {
  selectedKey: string
  onChange: (key: string) => void
}) {
  return (
    <div className="vars-lab-key-picker" role="listbox" aria-label="从 Base registry 选择 key">
      <label className="vars-lab-key-filter">
        <Search size={13} />
        <input placeholder="搜索 key / format" />
      </label>
      <div className="vars-lab-key-options">
        {baseKeyOptions.map((option) => (
          <button
            type="button"
            className={'vars-lab-key-option' + (option.key === selectedKey ? ' on' : '')}
            key={option.key}
            role="option"
            aria-selected={option.key === selectedKey}
            onClick={() => onChange(option.key)}
          >
            <span>
              <strong>{option.key}</strong>
              <small>{option.description}</small>
            </span>
            <TypeBadges type={option.type} format={option.format} />
          </button>
        ))}
      </div>
    </div>
  )
}

function TypeBadges({ type, format }: { type: string; format?: string }) {
  return (
    <span className="vars-lab-type-stack">
      <span className="vars-lab-type-main">{type}</span>
      {format && <span className="vars-lab-format">{format}</span>}
    </span>
  )
}

function ProfileActions({ profile }: { profile: Profile }) {
  if (profile.locked) {
    return (
      <span className="vars-lab-profile-lock" aria-label="锁定">
        <Lock size={13} />
      </span>
    )
  }
  return (
    <div className="vars-lab-profile-actions">
      <IconButton label={'重命名 ' + profile.name} tooltip="重命名 profile">
        <Pencil size={14} />
      </IconButton>
      <IconButton label={'删除 ' + profile.name} tooltip="删除 profile" tone="danger">
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}

function VarsProfileDemo() {
  const [activeProfileId, setActiveProfileId] = useState('local')
  const [view, setView] = useState<'definitions' | 'resolved'>('definitions')
  const [modal, setModal] = useState<ModalState>(null)
  const [activeAgent, setActiveAgent] = useState<AgentId>('codex')
  const [modalSlot, setModalSlot] = useState<AgentId | 'default'>('codex')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('edit')
  const [selectedBaseKey, setSelectedBaseKey] = useState('memory.context')
  const [showAvailable, setShowAvailable] = useState(false)

  const openModal = (nextModal: Exclude<ModalState, null>) => {
    setPreviewMode('edit')
    setModal(nextModal)
  }

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
  const entries = configuredEntries[activeProfile.id] ?? []
  const visibleEntries = useMemo(() => {
    if (activeProfile.kind === 'base' || activeProfile.kind === 'builtin') return entries
    return showAvailable ? [...entries, ...availableEntries] : entries
  }, [activeProfile.kind, entries, showAvailable])

  return (
    <div className="vars-lab-page">
      <header className="vars-lab-topbar">
        <div>
          <div className="vars-lab-eyebrow">vars ui lab</div>
          <h1>按 Profile 管理 Variables</h1>
          <p>静态演示页。用于讨论 UI,不会读取或写入真实 vars 文件。</p>
        </div>
        <div className="vars-lab-tabs" role="tablist" aria-label="Vars 视图">
          <Button
            type="button"
            variant={view === 'definitions' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setView('definitions')}
          >
            配置管理
          </Button>
          <Button
            type="button"
            variant={view === 'resolved' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setView('resolved')}
          >
            最终结果
          </Button>
        </div>
      </header>

      <div className="vars-lab-shell">
        <aside className="vars-lab-profiles" aria-label="Profiles">
          <div className="vars-lab-pane-head">
            <div>
              <div className="vars-lab-eyebrow">profiles</div>
              <h2>配置范围</h2>
            </div>
            <IconButton label="新建 profile" tooltip="新建 profile" tone="success">
              <Plus size={15} />
            </IconButton>
          </div>
          <div className="vars-lab-profile-list">
            {profiles.map((profile) => (
              <button
                type="button"
                className={'vars-lab-profile' + (profile.id === activeProfile.id ? ' on' : '')}
                key={profile.id}
                onClick={() => setActiveProfileId(profile.id)}
              >
                <span>
                  <strong>{profile.name}</strong>
                  <small>{profile.description}</small>
                </span>
                <span className="vars-lab-profile-meta">
                  <span className="vars-lab-count">{profile.configuredCount}</span>
                  <span className={'vars-lab-kind ' + profile.kind}>{profileBadge(profile)}</span>
                </span>
              </button>
            ))}
          </div>
          <section className="vars-lab-profile-card">
            <div className="vars-lab-eyebrow">profile 操作</div>
            <div className="vars-lab-profile-card-row">
              <strong>{activeProfile.name}</strong>
              <ProfileActions profile={activeProfile} />
            </div>
            <p>
              {activeProfile.locked
                ? '该 profile 被系统锁定,只能管理内部允许的变量行为。'
                : '自定义 profile 可重命名或删除;删除只影响该 profile 内的配置。'}
            </p>
          </section>
        </aside>

        {view === 'definitions' ? (
          <main className="vars-lab-main" aria-label="Profile definitions demo">
            <section className="vars-lab-section-head">
              <div>
                <div className="vars-lab-eyebrow">当前 profile</div>
                <h2>{activeProfile.name}</h2>
                <p>
                  {activeProfile.kind === 'base'
                    ? 'Base 是用户变量 registry。这里可以新建变量。'
                    : activeProfile.kind === 'builtin'
                      ? 'Builtin 只读,展示 runtime keys。'
                      : '默认只显示该 profile 已配置的变量。'}
                </p>
              </div>
            </section>

            <div className="vars-lab-toolbar">
              <label className="vars-lab-search">
                <Search size={14} />
                <input placeholder="搜索当前列表" />
              </label>
              {activeProfile.kind !== 'builtin' && (
                <Button type="button" size="sm" onClick={() => openModal('add')}>
                  <Plus size={14} />
                  {activeProfile.kind === 'base' ? '新建变量' : '新建配置'}
                </Button>
              )}
              {activeProfile.kind !== 'base' && activeProfile.kind !== 'builtin' && (
                <Button
                  type="button"
                  variant={showAvailable ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setShowAvailable((current) => !current)}
                >
                  <Filter size={14} />
                  显示可配置项
                </Button>
              )}
            </div>

            <section className="vars-lab-table" aria-label={activeProfile.name + ' 变量列表'}>
              <div className="vars-lab-table-row head">
                <span>key</span>
                <span>当前值</span>
                <span>Agent 专属</span>
                <span>操作</span>
              </div>
              {visibleEntries.map((entry) => (
                <div
                  className={
                    'vars-lab-table-row' + (entry.state === 'available' ? ' available' : '')
                  }
                  key={entry.key + entry.state}
                >
                  <KeyCell entry={entry} />
                  <span className="vars-lab-value">
                    {entry.state === 'available' ? '未配置' : entry.value}
                  </span>
                  <EntrySlots slots={entry.slots} />
                  <span className="vars-lab-row-actions">
                    {entry.state === 'readonly' ? (
                      <IconButton label={'查看 ' + entry.key} tooltip="查看详情">
                        <Braces size={14} />
                      </IconButton>
                    ) : entry.state === 'available' ? (
                      <IconButton
                        label={'新建 ' + entry.key + ' 配置'}
                        tooltip="新建配置"
                        tone="success"
                        onClick={() => openModal('add')}
                      >
                        <Plus size={14} />
                      </IconButton>
                    ) : (
                      <>
                        <IconButton
                          label={'编辑 ' + entry.key}
                          tooltip="编辑"
                          onClick={() => openModal('edit')}
                        >
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton
                          label={'删除 ' + entry.key + ' 配置'}
                          tooltip="删除配置"
                          tone="danger"
                        >
                          <Trash2 size={14} />
                        </IconButton>
                        <IconButton label={'更多 ' + entry.key} tooltip="更多">
                          <MoreHorizontal size={14} />
                        </IconButton>
                      </>
                    )}
                  </span>
                </div>
              ))}
              {!visibleEntries.length && (
                <div className="vars-lab-empty">
                  <strong>{activeProfile.name} 还没有配置变量</strong>
                  <span>使用“新建配置”从 Base registry 选择一个 key。</span>
                </div>
              )}
            </section>
          </main>
        ) : (
          <main className="vars-lab-main" aria-label="Resolved vars demo">
            <section className="vars-lab-section-head">
              <div>
                <div className="vars-lab-eyebrow">最终结果</div>
                <h2>当前 agent 的最终变量</h2>
                <p>只读预览。编辑时跳回对应 profile。</p>
              </div>
              <div className="vars-lab-agent-switch">
                <span>查看 agent</span>
                <AgentChips
                  activeAgent={activeAgent}
                  label="选择要预览最终变量的 agent"
                  onChange={(agent) => setActiveAgent(agent as AgentId)}
                />
              </div>
            </section>
            <section className="vars-lab-table resolved" aria-label="解析结果">
              <div className="vars-lab-table-row head">
                <span>key</span>
                <span>最终值</span>
                <span>来源</span>
                <span>操作</span>
              </div>
              {resolvedEntries.map((entry) => (
                <div className="vars-lab-table-row" key={entry.key}>
                  <KeyCell entry={entry} />
                  <span className="vars-lab-value">{entry.value}</span>
                  <span className="vars-lab-source">{entry.source}</span>
                  <span className="vars-lab-row-actions">
                    <IconButton
                      label={'查看 ' + entry.key + ' trace'}
                      tooltip="查看 trace"
                      onClick={() => openModal('edit')}
                    >
                      <Braces size={14} />
                    </IconButton>
                    <IconButton label={'跳转编辑 ' + entry.key} tooltip="跳转编辑">
                      <Pencil size={14} />
                    </IconButton>
                  </span>
                </div>
              ))}
            </section>
          </main>
        )}
      </div>

      {modal && (
        <div className="vars-lab-modal-backdrop" role="presentation">
          <section
            className="vars-lab-modal"
            role="dialog"
            aria-modal="true"
            aria-label={modal === 'edit' ? '编辑变量' : '新建配置'}
          >
            <header className="vars-lab-modal-head">
              <div>
                <div className="vars-lab-eyebrow">{modal === 'edit' ? '编辑配置' : '新建配置'}</div>
                <h2>
                  {modal === 'edit'
                    ? 'agent_name · ' + activeProfile.name
                    : '新建 ' + activeProfile.name + ' 配置'}
                </h2>
              </div>
              <div className="vars-lab-modal-head-actions">
                <div className="vars-lab-agent-switch">
                  <span>配置槽位</span>
                  <AgentChips
                    activeAgent={modalSlot}
                    includeDefault
                    label="选择要编辑的配置槽位"
                    onChange={setModalSlot}
                  />
                </div>
                <IconButton label="关闭弹窗" tooltip="关闭" onClick={() => setModal(null)}>
                  <X size={15} />
                </IconButton>
              </div>
            </header>
            <div className="vars-lab-modal-body">
              <div
                className={'vars-lab-editor-column' + (modal === 'add' ? ' has-target-key' : '')}
              >
                {modal === 'add' && (
                  <section className="vars-lab-card">
                    <div className="vars-lab-eyebrow">目标 key</div>
                    <div className="vars-lab-field">
                      <span>从 Base registry 选择</span>
                      <BaseKeyPicker selectedKey={selectedBaseKey} onChange={setSelectedBaseKey} />
                    </div>
                  </section>
                )}
                <section className="vars-lab-card vars-lab-editor-card">
                  <div className="vars-lab-eyebrow">配置值</div>
                  <div className="vars-lab-editor-tabs">
                    <Button
                      type="button"
                      size="xs"
                      variant={previewMode === 'edit' ? 'primary' : 'secondary'}
                      onClick={() => setPreviewMode('edit')}
                    >
                      编辑
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant={previewMode === 'raw' ? 'primary' : 'secondary'}
                      onClick={() => setPreviewMode('raw')}
                    >
                      原始预览
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant={previewMode === 'resolved' ? 'primary' : 'secondary'}
                      onClick={() => setPreviewMode('resolved')}
                    >
                      解析预览
                    </Button>
                  </div>
                  {previewMode === 'edit' ? (
                    <label className="vars-lab-field vars-lab-editor-field">
                      <span>
                        {modalSlot === 'default'
                          ? activeProfile.name + ' · default'
                          : activeProfile.name + ' · ' + agentShort[modalSlot as AgentId]}
                      </span>
                      <textarea
                        defaultValue={
                          modal === 'edit'
                            ? 'Local Codex agent\n\n- 支持多行 markdown\n- 编辑区内部滚动\n- 预览区不撑高弹窗'
                            : ''
                        }
                        placeholder="输入配置值"
                        rows={11}
                      />
                    </label>
                  ) : previewMode === 'raw' ? (
                    <pre className="vars-lab-preview vars-lab-preview-raw">
                      {modal === 'edit'
                        ? 'Local Codex agent\n\n- 支持多行 markdown\n- 编辑区内部滚动\n- 预览区不撑高弹窗'
                        : '当前槽位还没有输入内容。'}
                    </pre>
                  ) : (
                    <div className="md-preview vars-lab-preview">
                      <h3>Local Codex agent</h3>
                      <ul>
                        <li>支持多行 markdown</li>
                        <li>编辑区内部滚动</li>
                        <li>预览区不撑高弹窗</li>
                      </ul>
                    </div>
                  )}
                </section>
              </div>
              <aside className="vars-lab-inspector-column">
                <section className="vars-lab-card">
                  <div className="vars-lab-eyebrow">元信息</div>
                  <dl className="vars-lab-meta">
                    <div>
                      <dt>profile</dt>
                      <dd>{activeProfile.name}</dd>
                    </div>
                    <div>
                      <dt>slot</dt>
                      <dd>
                        {modalSlot === 'default' ? 'default' : agentShort[modalSlot as AgentId]}
                      </dd>
                    </div>
                    <div>
                      <dt>type</dt>
                      <dd>string</dd>
                    </div>
                    <div>
                      <dt>format</dt>
                      <dd>markdown</dd>
                    </div>
                  </dl>
                </section>
                <section className="vars-lab-card">
                  <div className="vars-lab-eyebrow">trace</div>
                  <div className="vars-lab-trace">
                    <div className="vars-lab-trace-row">
                      <span>Base</span>
                      <span>default</span>
                    </div>
                    <div className="vars-lab-trace-row on">
                      <span>Local</span>
                      <span>CX</span>
                    </div>
                  </div>
                </section>
              </aside>
            </div>
            <footer className="vars-lab-modal-footer">
              <Button type="button" variant="secondary" onClick={() => setModal(null)}>
                取消
              </Button>
              {modal === 'edit' && (
                <Button type="button" variant="destructive">
                  清除配置
                </Button>
              )}
              <Button type="button" onClick={() => setModal(null)}>
                <CheckCircle2 size={14} />
                保存
              </Button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}

export default VarsProfileDemo
