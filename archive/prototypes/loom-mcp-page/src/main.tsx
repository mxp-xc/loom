import React, { useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  Command,
  Copy,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/IconButton'
import '@/index.css'
import './styles.css'

type AgentId = 'claude-code' | 'codex' | 'opencode'
type McpType = 'stdio' | 'sse' | 'http'
type PreviewState = 'normal' | 'empty' | 'loading' | 'error' | 'long'
type Filter = 'all' | 'local' | 'remote'
type EditorMode = 'create' | 'edit'

interface Agent {
  id: AgentId
  label: string
  name: string
  color: string
  path: string
}

interface McpServerFixture {
  id: string
  type: McpType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  targets: AgentId[]
  status: 'projected' | 'partial' | 'draft'
  updated: string
  note: string
}

const variable = (name: string) => '$' + '{' + name + '}'

interface VariableInfo {
  value: string
  source: string
  kind: string
  secret?: boolean
  trace: VariableTraceStep[]
}

interface VariableTraceStep {
  layer: string
  source: string
  title: string
  detail: string
}

const variableInfo: Record<string, VariableInfo> = {
  browsers_path: {
    value: 'C:/Users/10107/AppData/Local/ms-playwright',
    source: '本机配置覆盖',
    kind: 'path',
    trace: [
      {
        layer: 'Base',
        source: 'agent baseline',
        title: '默认路径策略',
        detail: '没有本机覆盖时使用。',
      },
      {
        layer: 'Local',
        source: 'workspace override',
        title: '本机覆盖',
        detail: 'C:/Users/10107/AppData/Local/ms-playwright',
      },
      {
        layer: 'Runtime',
        source: 'resolved preview',
        title: '运行时解析',
        detail: '写入 MCP env 前替换。',
      },
    ],
  },
  repo_root: {
    value: 'C:/Users/10107/.codex/worktrees/2114/loom',
    source: 'runtime',
    kind: 'path',
    trace: [
      {
        layer: 'Base',
        source: 'agent baseline',
        title: '继承工作区规则',
        detail: '保留可被 runtime 注入的 repo 变量。',
      },
      {
        layer: 'Local',
        source: 'workspace override',
        title: '当前项目未覆盖',
        detail: '继续使用运行时仓库位置。',
      },
      {
        layer: 'Runtime',
        source: 'active repo',
        title: '解析为当前 worktree',
        detail: 'C:/Users/10107/.codex/worktrees/2114/loom',
      },
    ],
  },
  active_repo: {
    value: 'loom',
    source: 'runtime',
    kind: 'string',
    trace: [
      {
        layer: 'Base',
        source: 'agent baseline',
        title: '声明展示名规则',
        detail: '用于需要仓库名称的 header 或 auth 信息。',
      },
      {
        layer: 'Local',
        source: 'workspace override',
        title: '当前项目未覆盖',
        detail: '沿用 runtime 的项目名。',
      },
      {
        layer: 'Runtime',
        source: 'active repo',
        title: '解析为 loom',
        detail: '当前预览中的 active repository。',
      },
    ],
  },
  ZHIPU_API_KEY: {
    value: 'zhipu-••••••••••••',
    source: '本机配置覆盖',
    kind: 'secret',
    secret: true,
    trace: [
      {
        layer: 'Base',
        source: 'agent baseline',
        title: '不提供默认密钥',
        detail: '敏感值只允许在本地层声明。',
      },
      {
        layer: 'Local',
        source: 'secret override',
        title: '读取本机密钥',
        detail: '仅用于投影时注入，不在预览中明文展示。',
      },
      { layer: 'Runtime', source: 'masked preview', title: '显示前遮罩', detail: '••••••••' },
    ],
  },
}

function resolveVariableValue(name: string) {
  const info = variableInfo[name]
  if (!info) return '未解析变量'
  return info.secret ? '••••••••' : info.value
}

const targetVariableValues: Record<AgentId, Record<string, string>> = {
  'claude-code': {
    browsers_path: 'C:/Users/10107/AppData/Local/Claude/ms-playwright',
    repo_root: 'C:/Users/10107/.claude/workspaces/loom',
    active_repo: 'loom-claude',
  },
  codex: {
    browsers_path: 'C:/Users/10107/AppData/Local/ms-playwright',
    repo_root: 'C:/Users/10107/.codex/worktrees/2114/loom',
    active_repo: 'loom',
  },
  opencode: {
    browsers_path: 'C:/Users/10107/AppData/Local/opencode/ms-playwright',
    repo_root: 'C:/Users/10107/Projects/loom',
    active_repo: 'loom-opencode',
  },
}

function resolveVariableValueForTarget(name: string, target: AgentId) {
  const info = variableInfo[name]
  if (info?.secret) return '••••••••'
  return targetVariableValues[target]?.[name] ?? resolveVariableValue(name)
}

function resolveInterpolations(value: string) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => resolveVariableValue(name))
}

function resolveInterpolationsForTarget(value: string, target: AgentId) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) =>
    resolveVariableValueForTarget(name, target),
  )
}

function resolveRecordForTarget(record: Record<string, string> | undefined, target: AgentId) {
  if (!record) return undefined
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      resolveInterpolationsForTarget(value, target),
    ]),
  )
}

function resolveServerForTarget(server: McpServerFixture, target: AgentId): McpServerFixture {
  return {
    ...server,
    args: server.args?.map((arg) => resolveInterpolationsForTarget(arg, target)),
    url: server.url ? resolveInterpolationsForTarget(server.url, target) : server.url,
    env: resolveRecordForTarget(server.env, target),
    headers: resolveRecordForTarget(server.headers, target),
  }
}

function renderInterpolatedValue(value: string, onVariableSelect: (name: string) => void) {
  const nodes: React.ReactNode[] = []
  const pattern = /\$\{([^}]+)\}/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(value)) !== null) {
    const [raw, name] = match
    if (match.index > lastIndex) nodes.push(value.slice(lastIndex, match.index))
    nodes.push(
      <button
        key={match.index + name}
        type="button"
        className="mcp-var-token"
        title={'查看变量 ' + name}
        onClick={() => onVariableSelect(name)}
      >
        {raw}
      </button>,
    )
    lastIndex = match.index + raw.length
  }

  if (lastIndex < value.length) nodes.push(value.slice(lastIndex))
  return nodes.length > 0 ? nodes : value
}

function hasInterpolation(value: string) {
  return /\$\{[^}]+\}/.test(value)
}

const agents: Agent[] = [
  {
    id: 'claude-code',
    label: 'CC',
    name: 'Claude Code',
    color: '#d97757',
    path: '~/.claude/.mcp.json',
  },
  {
    id: 'codex',
    label: 'CX',
    name: 'Codex',
    color: '#06b6d4',
    path: '~/.codex/config.toml',
  },
  {
    id: 'opencode',
    label: 'OC',
    name: 'OpenCode',
    color: '#8b5cf6',
    path: '~/.config/opencode/mcp.json',
  },
]

const servers: McpServerFixture[] = [
  {
    id: 'playwright',
    type: 'stdio',
    command: 'npx',
    args: ['@executeautomation/playwright-mcp-server', '--browser=chromium'],
    env: {
      PLAYWRIGHT_BROWSERS_PATH: variable('browsers_path'),
      DEBUG: 'pw:mcp',
    },
    targets: ['claude-code', 'codex'],
    status: 'partial',
    updated: '2m ago',
    note: '浏览器自动化，常用于前端验收与交互回放。',
  },
  {
    id: 'codegraph',
    type: 'stdio',
    command: 'node',
    args: ['.codegraph/server.mjs', '--workspace=' + variable('repo_root')],
    env: {
      CODEGRAPH_INDEX: variable('repo_root') + '/.codegraph',
    },
    targets: ['claude-code', 'codex', 'opencode'],
    status: 'projected',
    updated: '8m ago',
    note: '代码索引查询，默认投影到全部 agent。',
  },
  {
    id: 'zhipu-web-search',
    type: 'sse',
    url: 'https://open.bigmodel.cn/api/mcp/sse',
    headers: {
      Authorization: 'Bearer ' + variable('ZHIPU_API_KEY'),
      'X-Workspace': variable('active_repo'),
    },
    env: {
      REQUEST_TIMEOUT: '15s',
    },
    targets: ['codex', 'opencode'],
    status: 'partial',
    updated: '24m ago',
    note: '远程搜索适配器，用于需要联网检索的 agent。',
  },
  {
    id: 'filesystem-long-path-lab',
    type: 'stdio',
    command: 'uv',
    args: [
      'run',
      '--with',
      'mcp-server-filesystem',
      'python',
      '-m',
      'mcp_server_filesystem',
      'C:/Users/10107/Documents/Projects/Clients/Very Long Workspace Name/Research Artifacts/2026/07',
    ],
    env: {
      ALLOW_WRITE: 'false',
      SANDBOX_ROOT: variable('repo_root'),
      LOG_LEVEL: 'info',
    },
    targets: ['claude-code'],
    status: 'draft',
    updated: 'draft',
    note: '长命令/长路径压力测试：列表和详情都应保持可读不横向炸开。',
  },
]

function setTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('mcp-proto-theme', theme)
}

function serverEndpoint(server: McpServerFixture) {
  return server.type === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : (server.url ?? '')
}

function compactRecord(record?: Record<string, string>) {
  return record && Object.keys(record).length > 0 ? record : undefined
}

function jsonServerDefinition(server: McpServerFixture) {
  return server.type === 'stdio'
    ? {
        command: server.command,
        args: server.args,
        env: compactRecord(server.env),
      }
    : {
        type: server.type,
        url: server.url,
        headers: compactRecord(server.headers),
        env: compactRecord(server.env),
      }
}

function quoteToml(value: string) {
  return JSON.stringify(value)
}

function inlineTomlRecord(record?: Record<string, string>) {
  const entries = Object.entries(record ?? {})
  if (entries.length === 0) return null
  return '{ ' + entries.map(([key, value]) => key + ' = ' + quoteToml(value)).join(', ') + ' }'
}

function targetPreviewText(server: McpServerFixture, target: AgentId) {
  const resolvedServer = resolveServerForTarget(server, target)

  if (target === 'claude-code') {
    return JSON.stringify(
      {
        mcpServers: {
          [resolvedServer.id]: jsonServerDefinition(resolvedServer),
        },
      },
      null,
      2,
    )
  }

  if (target === 'codex') {
    const lines = ['[mcp_servers.' + resolvedServer.id + ']']
    if (resolvedServer.type === 'stdio') {
      if (resolvedServer.command) lines.push('command = ' + quoteToml(resolvedServer.command))
      if (resolvedServer.args?.length) {
        lines.push('args = [' + resolvedServer.args.map((arg) => quoteToml(arg)).join(', ') + ']')
      }
    } else {
      lines.push('transport = ' + quoteToml(resolvedServer.type))
      if (resolvedServer.url) lines.push('url = ' + quoteToml(resolvedServer.url))
    }
    const env = inlineTomlRecord(resolvedServer.env)
    const headers = inlineTomlRecord(resolvedServer.headers)
    if (env) lines.push('env = ' + env)
    if (headers && resolvedServer.type !== 'stdio') lines.push('headers = ' + headers)
    return lines.join('\n')
  }

  return JSON.stringify(
    {
      mcp: {
        [resolvedServer.id]: jsonServerDefinition(resolvedServer),
      },
    },
    null,
    2,
  )
}

function typeTone(server: McpServerFixture) {
  return server.type === 'stdio' ? 'local' : 'remote'
}

function ThemeButtons() {
  const [current, setCurrent] = useState(() => {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  })

  return (
    <div className="proto-theme-buttons">
      <IconButton
        label="切换浅色主题"
        tooltip="浅色"
        pressed={current === 'light'}
        onClick={() => {
          setCurrent('light')
          setTheme('light')
        }}
      >
        <Sun className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        label="切换暗色主题"
        tooltip="暗色"
        pressed={current === 'dark'}
        onClick={() => {
          setCurrent('dark')
          setTheme('dark')
        }}
      >
        <Moon className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="statusline">
        <span className="brand">◆ loom</span>
        <span className="v">mcp prototype</span>
        <span>·</span>
        <span className="v">sidecar</span>
        <span className="sync">
          <span className="dot" />
          mock data
        </span>
      </div>
      <div className="shell" style={{ '--sidebar-width': '196px' } as React.CSSProperties}>
        <aside className="sidebar" aria-label="原型导航">
          <div className="sidebar-toolbar">
            <span className="label">workspace</span>
          </div>
          <a className="nav-item" href="#skills">
            <span className="ic" aria-hidden="true">
              <Sparkles size={15} />
            </span>
            <span className="nav-text">Skills</span>
          </a>
          <a className="nav-item active" href="#mcp">
            <span className="ic" aria-hidden="true">
              <Command size={15} />
            </span>
            <span className="nav-text">MCP servers</span>
          </a>
          <a className="nav-item" href="#vars">
            <span className="ic" aria-hidden="true">
              <Braces size={15} />
            </span>
            <span className="nav-text">Variables</span>
          </a>
          <div className="nav-section">
            <span className="label">prototype</span>
          </div>
          <ThemeButtons />
        </aside>
        <main className="main">{children}</main>
      </div>
    </>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="mcp-metric">
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  )
}

function Hero({ visibleServers }: { visibleServers: McpServerFixture[] }) {
  const projected = visibleServers.filter((server) => server.status === 'projected').length
  const remote = visibleServers.filter((server) => server.type !== 'stdio').length
  const targetPairs = visibleServers.reduce((sum, server) => sum + server.targets.length, 0)

  return (
    <section className="mcp-hero" aria-labelledby="mcp-page-title">
      <div className="mcp-hero-copy">
        <div>
          <span className="label">workspace mcp</span>
          <h1 id="mcp-page-title">MCP Servers</h1>
          <p>
            管理本地 stdio 与远程 SSE/HTTP server，并把它们清晰投影到 Claude Code、Codex 与
            OpenCode。
          </p>
        </div>
      </div>
      <div className="mcp-hero-side">
        <div className="mcp-orbit" aria-hidden="true">
          <span />
          <span />
          <Command className="mcp-orbit-icon" />
        </div>
      </div>
      <div className="mcp-metrics" aria-label="MCP 概览">
        <Metric
          label="servers"
          value={String(visibleServers.length)}
          detail={String(remote) + ' remote'}
        />
        <Metric label="fully projected" value={String(projected)} detail="all targets enabled" />
        <Metric label="target links" value={String(targetPairs)} detail="agent projections" />
      </div>
    </section>
  )
}

function AgentChip({ agent, active }: { agent: Agent; active: boolean }) {
  return (
    <span
      className="target-chip"
      data-state={active ? 'on' : 'off'}
      style={{ '--c': agent.color } as React.CSSProperties}
      aria-label={agent.id + ': ' + (active ? 'enabled' : 'disabled')}
      data-tooltip={agent.id + '：' + (active ? '已应用投影' : '未应用投影')}
      title={agent.id}
    >
      {agent.label}
    </span>
  )
}

function GlobalTargetsBar({
  servers,
  onToggle,
}: {
  servers: McpServerFixture[]
  onToggle: (agent: AgentId) => void
}) {
  if (servers.length === 0) return null

  return (
    <div className="mcp-global-targets">
      <div>
        <span className="label">settings.json targets</span>
        <strong>批量设置 · 应用于全部 MCP servers</strong>
      </div>
      <span className="target-chips">
        {agents.map((agent) => {
          const count = servers.filter((server) => server.targets.includes(agent.id)).length
          const state = count === 0 ? 'off' : count === servers.length ? 'on' : 'mixed'
          const tooltip =
            state === 'on' ? '全部已应用' : state === 'mixed' ? '部分已应用' : '全部未应用'
          return (
            <button
              key={agent.id}
              type="button"
              className="target-chip"
              data-state={state}
              style={{ '--c': agent.color } as React.CSSProperties}
              aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
              aria-label={agent.id + '：' + tooltip}
              data-tooltip={agent.id + '：' + tooltip}
              onClick={() => onToggle(agent.id)}
            >
              {agent.label}
              {state === 'mixed' && (
                <span className="target-chip-count">
                  {count}/{servers.length}
                </span>
              )}
            </button>
          )
        })}
      </span>
    </div>
  )
}

function Inventory({
  servers,
  selectedId,
  filter,
  query,
  onFilter,
  onQuery,
  onSelect,
  onAdd,
  onEdit,
}: {
  servers: McpServerFixture[]
  selectedId: string | null
  filter: Filter
  query: string
  onFilter: (filter: Filter) => void
  onQuery: (query: string) => void
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (id: string) => void
}) {
  return (
    <aside className="mcp-inventory" aria-label="MCP server 列表">
      <div className="mcp-panel-head">
        <div>
          <span className="label">inventory</span>
          <strong>{servers.length} configured</strong>
        </div>
        <div className="mcp-inventory-actions">
          <Button
            variant="primary"
            size="sm"
            className="mcp-inventory-action mcp-inventory-action-primary"
            onClick={onAdd}
          >
            <Plus className="h-3.5 w-3.5" />
            Add server
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="mcp-inventory-action mcp-inventory-action-project"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            投影
          </Button>
        </div>
      </div>
      <label className="mcp-search">
        <Search className="h-3.5 w-3.5" />
        <span className="sr-only">筛选 MCP server</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filter by id, command, url"
        />
      </label>
      <div className="mcp-filter-tabs" aria-label="server 类型筛选">
        {[
          ['all', 'All'],
          ['local', 'Local'],
          ['remote', 'Remote'],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={filter === id ? 'on' : undefined}
            aria-pressed={filter === id}
            onClick={() => onFilter(id as Filter)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mcp-server-list">
        {servers.map((server) => {
          const selected = selectedId === server.id
          const endpoint = serverEndpoint(server)
          return (
            <article
              key={server.id}
              role="button"
              tabIndex={0}
              className="mcp-server-card"
              data-selected={selected ? 'true' : undefined}
              onClick={() => onSelect(server.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(server.id)
                }
              }}
            >
              <span className="mcp-server-topline">
                <strong>{server.id}</strong>
                <span className="mcp-type-badge" data-type={typeTone(server)}>
                  {server.type}
                </span>
                <span className="mcp-server-actions" aria-label={server.id + ' actions'}>
                  <button
                    type="button"
                    className="mcp-row-action"
                    data-tone="edit"
                    aria-label={'编辑 ' + server.id}
                    title={'编辑 ' + server.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      onEdit(server.id)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="mcp-row-action"
                    data-tone="delete"
                    aria-label={'删除 ' + server.id}
                    title={'删除 ' + server.id}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </span>
              <span className="mcp-server-endpoint">{endpoint}</span>
              <span className="mcp-server-foot">
                <span className="mcp-status" data-status={server.status}>
                  <span />
                  {server.status}
                </span>
                <span className="mcp-card-targets">
                  {agents.map((agent) => (
                    <AgentChip
                      key={agent.id}
                      agent={agent}
                      active={server.targets.includes(agent.id)}
                    />
                  ))}
                </span>
              </span>
            </article>
          )
        })}
      </div>
    </aside>
  )
}

function EmptyState() {
  return (
    <section className="mcp-empty-state">
      <div className="mcp-empty-icon">
        <Command className="h-7 w-7" />
      </div>
      <strong>还没有 MCP server</strong>
      <p>先添加一个 stdio、本地脚本或远程 SSE/HTTP 端点，再选择要投影的 agent。</p>
      <Button variant="primary" size="sm">
        <Plus className="h-3.5 w-3.5" />
        Add first server
      </Button>
    </section>
  )
}

function LoadingState() {
  return (
    <section className="mcp-loading-state" aria-label="MCP 加载中">
      <div className="mcp-skeleton wide" />
      <div className="mcp-skeleton-row">
        <div className="mcp-skeleton" />
        <div className="mcp-skeleton" />
        <div className="mcp-skeleton" />
      </div>
      <div className="mcp-skeleton tall" />
      <span className="label">loading manifest…</span>
    </section>
  )
}

function ErrorState() {
  return (
    <section className="mcp-error-state" role="alert">
      <AlertTriangle className="h-5 w-5" />
      <div>
        <strong>MCP manifest 读取失败</strong>
        <p>无法读取 repo config。保留当前页面结构，并给用户一个明确的重试入口。</p>
      </div>
      <Button variant="secondary" size="sm">
        <RefreshCw className="h-3.5 w-3.5" />
        Retry
      </Button>
    </section>
  )
}

function DetailHeader({
  server,
  previewTarget,
  onPreviewTargetChange,
}: {
  server: McpServerFixture
  previewTarget: AgentId
  onPreviewTargetChange: (target: AgentId) => void
}) {
  return (
    <section className="mcp-detail-hero">
      <div className="mcp-detail-title">
        <span className="label">selected server</span>
        <h2>{server.id}</h2>
        <p>{server.note}</p>
      </div>
      <span className="mcp-type-badge large" data-type={typeTone(server)}>
        {server.type}
      </span>
      <TargetPreviewSwitch value={previewTarget} onChange={onPreviewTargetChange} />
      <div className="mcp-detail-actions">
        <IconButton label={'拷贝 ' + server.id + ' JSON'} tooltip="拷贝 JSON">
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </section>
  )
}

function FieldCard({
  title,
  children,
  meta,
  wide = false,
}: {
  title: string
  children: React.ReactNode
  meta?: string
  wide?: boolean
}) {
  return (
    <section className={wide ? 'mcp-field-card mcp-field-card-wide' : 'mcp-field-card'}>
      <div className="mcp-field-card-head">
        <span className="label">{title}</span>
        {meta && <small>{meta}</small>}
      </div>
      {children}
    </section>
  )
}

function CodeSurface({
  value,
  onVariableSelect,
  previewTarget,
}: {
  value: string
  onVariableSelect: (name: string) => void
  previewTarget?: AgentId
}) {
  const resolved = previewTarget
    ? resolveInterpolationsForTarget(value, previewTarget)
    : resolveInterpolations(value)
  const showResolved = resolved !== value
  return (
    <div className="mcp-code-preview">
      <pre className="mcp-code-surface">{renderInterpolatedValue(value, onVariableSelect)}</pre>
      {showResolved && (
        <div className="mcp-resolved-preview">
          <span className="label">解析预览</span>
          <code>{resolved}</code>
        </div>
      )}
    </div>
  )
}

function RecordRows({
  record,
  onVariableSelect,
  previewTarget,
}: {
  record?: Record<string, string>
  onVariableSelect: (name: string) => void
  previewTarget?: AgentId
}) {
  const entries = Object.entries(record ?? {})
  if (entries.length === 0) {
    return <p className="mcp-muted-copy">未配置；保存时不会写入该字段。</p>
  }
  return (
    <dl className="mcp-record-table">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <span>{renderInterpolatedValue(value, onVariableSelect)}</span>
            {hasInterpolation(value) && (
              <small className="mcp-record-resolved">
                →{' '}
                {previewTarget
                  ? resolveInterpolationsForTarget(value, previewTarget)
                  : resolveInterpolations(value)}
              </small>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function VariableInspector({ name, onClose }: { name: string | null; onClose: () => void }) {
  if (!name) return null

  const info = variableInfo[name]
  return (
    <div className="mcp-variable-overlay" role="presentation" onClick={onClose}>
      <section
        className="mcp-variable-panel"
        role="dialog"
        aria-modal="true"
        aria-label={'变量信息 ' + variable(name)}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mcp-variable-head">
          <div>
            <span className="label">variable</span>
            <h2>变量信息</h2>
            <p>查看变量的解析值、来源和变量层级 trace。</p>
          </div>
          <div className="mcp-variable-head-actions">
            <span>{info?.kind ?? 'unknown'}</span>
            <button
              type="button"
              className="mcp-variable-close"
              aria-label="关闭变量信息"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>
        <div className="mcp-variable-body">
          <section className="mcp-variable-card">
            <span className="label">definition</span>
            <code className="mcp-variable-name">{variable(name)}</code>
            <dl className="mcp-variable-meta">
              <div>
                <dt>resolved</dt>
                <dd>{info ? resolveVariableValue(name) : '未解析变量'}</dd>
              </div>
              <div>
                <dt>source</dt>
                <dd>{info?.source ?? '未在当前 settings.json mock 中找到'}</dd>
              </div>
            </dl>
          </section>
          <section className="mcp-variable-card">
            <span className="label">resolution trace</span>
            <ol className="mcp-variable-trace" aria-label="变量解析层级">
              {(
                info?.trace ?? [
                  {
                    layer: 'Missing',
                    source: 'unresolved',
                    title: '没有找到变量定义',
                    detail: '检查 base、local 或 runtime 是否提供了该变量。',
                  },
                ]
              ).map((step, index) => (
                <li key={step.layer + step.title}>
                  <span className="mcp-trace-index">{index + 1}</span>
                  <div className="mcp-trace-copy">
                    <div className="mcp-trace-topline">
                      <strong>{step.layer}</strong>
                      <em>{step.source}</em>
                    </div>
                    <p>{step.title}</p>
                    <span className="mcp-trace-detail">{step.detail}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <footer className="mcp-variable-footer">
          <Button
            variant="secondary"
            size="sm"
            className="mcp-dialog-close-button"
            onClick={onClose}
          >
            关闭
          </Button>
        </footer>
      </section>
    </div>
  )
}

function editorDraftServer(): McpServerFixture {
  return {
    id: 'new-browser-tools',
    type: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-playwright', '--browser=chromium'],
    env: {
      PLAYWRIGHT_BROWSERS_PATH: variable('browsers_path'),
      DEBUG: 'pw:mcp',
    },
    targets: [],
    status: 'draft',
    updated: 'draft',
    note: '用于浏览器自动化的新 MCP server。',
  }
}

function EditorField({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <label className="mcp-editor-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

function EditorKvRows({
  title,
  rows,
  onVariableSelect,
  previewTarget,
}: {
  title: string
  rows: Array<[string, string]>
  onVariableSelect: (name: string) => void
  previewTarget: AgentId
}) {
  return (
    <section className="mcp-editor-kv">
      <div className="mcp-editor-subhead">
        <span className="label">{title}</span>
        <small>{rows.length} entries</small>
      </div>
      <div>
        {rows.map(([key, value]) => (
          <div key={key} className="mcp-editor-kv-row">
            <input aria-label={title + ' key'} defaultValue={key} />
            <div className="mcp-editor-value-stack">
              <input aria-label={title + ' value'} defaultValue={value} />
              {hasInterpolation(value) && (
                <small className="mcp-editor-resolve-line">
                  <span>{renderInterpolatedValue(value, onVariableSelect)}</span>
                  <em>→ {resolveInterpolationsForTarget(value, previewTarget)}</em>
                </small>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function TargetPreviewSwitch({
  value,
  onChange,
}: {
  value: AgentId
  onChange: (target: AgentId) => void
}) {
  return (
    <div className="mcp-target-preview-switch" aria-label="当前预览 target">
      <span className="label">preview as</span>
      <div className="mcp-target-preview-tabs">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={value === agent.id ? 'on' : undefined}
            style={{ '--c': agent.color } as React.CSSProperties}
            aria-pressed={value === agent.id}
            onClick={() => onChange(agent.id)}
          >
            {agent.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function TargetSettingsPreview({
  server,
  className,
  previewTarget,
}: {
  server: McpServerFixture
  className: string
  previewTarget: AgentId
}) {
  const activeAgent = agents.find((agent) => agent.id === previewTarget) ?? agents[1]
  const applied = server.targets.includes(previewTarget)

  return (
    <section className={className}>
      <div className="mcp-target-preview-head">
        <div>
          <span className="label">target settings preview</span>
          <strong>{activeAgent.name} 写入预览</strong>
          <p>使用当前 target 的变量解析结果，预览 transport、env、headers 和最终配置形态。</p>
        </div>
      </div>
      <div
        className="mcp-target-preview-path"
        style={{ '--c': activeAgent.color } as React.CSSProperties}
      >
        <span>{activeAgent.name}</span>
        <code>{activeAgent.path}</code>
        <em>{applied ? '当前已应用' : '仅预览'}</em>
      </div>
      <pre className="mcp-editor-json">{targetPreviewText(server, previewTarget)}</pre>
    </section>
  )
}

function ServerEditor({
  mode,
  server,
  onCancel,
  onSave,
}: {
  mode: EditorMode
  server: McpServerFixture
  onCancel: () => void
  onSave: () => void
}) {
  const [transport, setTransport] = useState<McpType>(server.type)
  const [selectedVariable, setSelectedVariable] = useState<string | null>(null)
  const [previewTarget, setPreviewTarget] = useState<AgentId>('codex')
  const endpoint = serverEndpoint({ ...server, type: transport })
  const envRows = Object.entries(server.env ?? { WORKSPACE: variable('repo_root') })
  const headerRows =
    transport === 'stdio'
      ? []
      : Object.entries(server.headers ?? { Authorization: 'Bearer ' + variable('ZHIPU_API_KEY') })

  const previewPayload = {
    ...server,
    type: transport,
    url: transport !== 'stdio' ? (server.url ?? endpoint) : undefined,
    env: Object.fromEntries(envRows),
    headers: transport !== 'stdio' ? Object.fromEntries(headerRows) : undefined,
  }

  return (
    <div className="mcp-editor" data-mode={mode}>
      <header className="mcp-editor-cover">
        <div>
          <span className="label">{mode === 'create' ? 'new server' : 'edit server'}</span>
          <h2>{mode === 'create' ? 'Add MCP server' : 'Edit ' + server.id}</h2>
          <p>
            编辑 server 定义本身；是否应用到 Claude Code、Codex 或 OpenCode，回到列表里单独控制。
          </p>
          <div className="mcp-editor-cover-meta">
            <span>{transport === 'stdio' ? 'local process' : 'remote endpoint'}</span>
            <span>{mode === 'create' ? 'unprojected by default' : 'definition only'}</span>
            <span>draft only</span>
          </div>
        </div>
        <span
          className="mcp-type-badge large"
          data-type={transport === 'stdio' ? 'local' : 'remote'}
        >
          {transport}
        </span>
        <TargetPreviewSwitch value={previewTarget} onChange={setPreviewTarget} />
      </header>

      <div className="mcp-editor-grid">
        <div className="mcp-editor-form-stack">
          <section className="mcp-editor-card">
            <div className="mcp-editor-card-head">
              <div>
                <span className="label">identity</span>
                <strong>命名与说明</strong>
              </div>
              <small>不会写入 header/env</small>
            </div>

            <div className="mcp-editor-fields">
              <EditorField label="Server id" hint="保存后作为各 agent 配置里的 key。">
                <input defaultValue={server.id} />
              </EditorField>
              <EditorField label="Display note" hint="只用于 Loom UI，帮助列表里快速识别用途。">
                <input defaultValue={server.note} />
              </EditorField>
            </div>
          </section>

          <section className="mcp-editor-card">
            <div className="mcp-editor-card-head">
              <div>
                <span className="label">connection</span>
                <strong>Transport 与入口</strong>
              </div>
            </div>

            <div className="mcp-editor-transport" aria-label="transport type">
              {(['stdio', 'sse', 'http'] as McpType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={transport === type ? 'on' : undefined}
                  aria-pressed={transport === type}
                  onClick={() => setTransport(type)}
                >
                  <span>{type}</span>
                  <small>
                    {type === 'stdio'
                      ? 'local process'
                      : type === 'sse'
                        ? 'event stream'
                        : 'remote http'}
                  </small>
                </button>
              ))}
            </div>

            <EditorField label={transport === 'stdio' ? 'Command preview' : 'Endpoint URL'}>
              <textarea
                key={transport}
                defaultValue={
                  transport === 'stdio'
                    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
                    : (server.url ?? 'https://example.com/mcp')
                }
              />
            </EditorField>
          </section>

          <section className="mcp-editor-card">
            <div className="mcp-editor-card-head">
              <div>
                <span className="label">variables</span>
                <strong>{transport === 'stdio' ? 'Env 变量' : 'Env 与 headers'}</strong>
              </div>
              <small>
                {transport === 'stdio' ? 'stdio 不显示 headers' : 'remote auth 单独成行'}
              </small>
            </div>
            <div className="mcp-editor-env-grid">
              <EditorKvRows
                title="env"
                rows={envRows.length > 0 ? envRows : [['REQUEST_TIMEOUT', '15s']]}
                onVariableSelect={setSelectedVariable}
                previewTarget={previewTarget}
              />
              {transport !== 'stdio' && (
                <EditorKvRows
                  title="headers"
                  rows={
                    headerRows.length > 0
                      ? headerRows
                      : [['Authorization', 'Bearer ' + variable('ZHIPU_API_KEY')]]
                  }
                  onVariableSelect={setSelectedVariable}
                  previewTarget={previewTarget}
                />
              )}
            </div>
          </section>

          <TargetSettingsPreview
            server={previewPayload}
            className="mcp-editor-card mcp-target-preview-card"
            previewTarget={previewTarget}
          />
        </div>
      </div>

      <footer className="mcp-editor-actionbar">
        <div>
          <strong>{mode === 'create' ? 'Create as draft' : 'Save draft changes'}</strong>
          <span>
            {mode === 'create'
              ? '新增后默认不应用到任何 target。'
              : '只保存 server 定义，不改变 target 应用状态。'}
          </span>
        </div>
        <div className="mcp-editor-actions">
          <Button variant="ghost" size="sm" className="mcp-editor-cancel" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button variant="primary" size="sm" className="mcp-editor-save" onClick={onSave}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            {mode === 'create' ? 'Create draft' : 'Save draft'}
          </Button>
        </div>
      </footer>

      <VariableInspector name={selectedVariable} onClose={() => setSelectedVariable(null)} />
    </div>
  )
}

function Detail({ server }: { server: McpServerFixture }) {
  const [selectedVariable, setSelectedVariable] = useState<string | null>(null)
  const [previewTarget, setPreviewTarget] = useState<AgentId>('codex')
  const endpoint = serverEndpoint(server)
  const args = server.args ?? []

  return (
    <div className="mcp-detail">
      <DetailHeader
        server={server}
        previewTarget={previewTarget}
        onPreviewTargetChange={setPreviewTarget}
      />
      <div className="mcp-detail-grid">
        <FieldCard
          title="transport"
          meta={server.type === 'stdio' ? 'local process' : 'remote endpoint'}
          wide
        >
          <CodeSurface
            value={endpoint}
            onVariableSelect={setSelectedVariable}
            previewTarget={previewTarget}
          />
          {args.length > 0 && (
            <div className="mcp-arg-pills" aria-label="args">
              {args.map((arg) => (
                <span key={arg}>{renderInterpolatedValue(arg, setSelectedVariable)}</span>
              ))}
            </div>
          )}
        </FieldCard>

        <FieldCard title="env" meta="safe preview" wide>
          <RecordRows
            record={server.env}
            onVariableSelect={setSelectedVariable}
            previewTarget={previewTarget}
          />
        </FieldCard>

        {server.type !== 'stdio' && (
          <FieldCard title="headers" meta="remote auth" wide>
            <RecordRows
              record={server.headers}
              onVariableSelect={setSelectedVariable}
              previewTarget={previewTarget}
            />
          </FieldCard>
        )}
      </div>

      <VariableInspector name={selectedVariable} onClose={() => setSelectedVariable(null)} />

      <TargetSettingsPreview
        server={server}
        className="mcp-field-card mcp-target-preview-card"
        previewTarget={previewTarget}
      />
    </div>
  )
}

function Dashboard() {
  const [serverList, setServerList] = useState<McpServerFixture[]>(servers)
  const previewState: PreviewState = 'normal'
  const [selectedId, setSelectedId] = useState('playwright')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null)

  const activeServers = previewState === 'empty' ? [] : serverList
  const effectiveSelectedId = previewState === 'long' ? 'filesystem-long-path-lab' : selectedId
  const toggleAllTarget = (agent: AgentId) => {
    setServerList((current) => {
      const allEnabled = current.every((server) => server.targets.includes(agent))
      return current.map((server) => {
        const nextTargets = allEnabled
          ? server.targets.filter((target) => target !== agent)
          : server.targets.includes(agent)
            ? server.targets
            : [...server.targets, agent]
        return { ...server, targets: nextTargets }
      })
    })
  }
  const filteredServers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return activeServers.filter((server) => {
      const filterMatches =
        filter === 'all' ||
        (filter === 'local' && server.type === 'stdio') ||
        (filter === 'remote' && server.type !== 'stdio')
      if (!filterMatches) return false
      if (!normalizedQuery) return true
      return (server.id + ' ' + serverEndpoint(server)).toLowerCase().includes(normalizedQuery)
    })
  }, [activeServers, filter, query])
  const selectedServer =
    filteredServers.find((server) => server.id === effectiveSelectedId) ??
    filteredServers[0] ??
    null
  const editorServer = editorMode === 'create' ? editorDraftServer() : selectedServer

  return (
    <div className="mcp-prototype-page">
      <Hero visibleServers={activeServers} />

      {previewState !== 'loading' && previewState !== 'error' && (
        <GlobalTargetsBar servers={activeServers} onToggle={toggleAllTarget} />
      )}

      {previewState === 'error' ? (
        <ErrorState />
      ) : previewState === 'loading' ? (
        <LoadingState />
      ) : activeServers.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="mcp-workbench">
          <Inventory
            servers={filteredServers}
            selectedId={selectedServer?.id ?? null}
            filter={filter}
            query={query}
            onFilter={setFilter}
            onQuery={setQuery}
            onSelect={(id) => {
              setSelectedId(id)
              setEditorMode(null)
            }}
            onAdd={() => setEditorMode('create')}
            onEdit={(id) => {
              setSelectedId(id)
              setEditorMode('edit')
            }}
          />
          {editorMode && editorServer ? (
            <ServerEditor
              key={editorMode + ':' + editorServer.id}
              mode={editorMode}
              server={editorServer}
              onCancel={() => setEditorMode(null)}
              onSave={() => setEditorMode(null)}
            />
          ) : selectedServer ? (
            <Detail server={selectedServer} />
          ) : (
            <EmptyState />
          )}
        </section>
      )}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Shell>
      <Dashboard />
    </Shell>
  </React.StrictMode>,
)
