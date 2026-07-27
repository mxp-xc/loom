# Shared Skills 投影与纳管设计

- 日期: 2026-07-27
- 状态: 已批准

## 背景

Loom 当前把 Skills desired state 按真实 Agent 保存，并投影到各 Agent 的原生 Skills
目录，例如 `~/.codex/skills`、`~/.claude/skills` 和
`~/.config/opencode/skills`。

Agent Skills 生态同时约定了跨工具共享位置
`~/.agents/skills/<skill-name>/SKILL.md`。VS Code、OpenCode 等客户端会读取该
目录，因此 Loom 需要让 Skills 页面把它作为一个独立、逐项可选的投影位置。

`~/.agents/skills` 不是 Agent:

- 它没有 command、品牌、config directory、MCP codec 或 Memory 文件；
- 它不属于 `config.agents`；
- 它可以在 `config.agents: []` 时单独使用；
- 同一 Skill 可以同时投影到 Agent 原生目录和通用目录。

相关外部约定:

- [Agent Skills client implementation](https://agentskills.io/client-implementation/adding-skills-support)
- [VS Code Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
- [OpenCode Skills](https://opencode.ai/docs/skills/)

本设计遵循:

- [领域术语](../../../CONTEXT.md)
- [跨模块规则](../../rules/cross-cutting.md)
- [Projection 规则](../../rules/projection.md)
- [Skills 规则](../../rules/skills.md)
- [Agent 抽象设计](./2026-07-16-agent-abstraction-design.md)
- [Skills 定向投影性能设计](./2026-07-25-targeted-skills-projection-design.md)

## 关键决策

1. `~/.agents/skills` 是逐个 local skill/source member 独立选择的 desired state，
   不是仓库级全量镜像，也不根据 Agent 选择自动推导。
2. 通用 Skills control 始终出现在 Skills 页面，默认关闭，不需要先在 Settings
   启用。
3. 现有 `agents` 字段继续只保存真实 `AgentId`，不把 manifest 全量迁回泛化的
   `targets`。
4. 每个 Skill 使用 `shared: true` 表达投影到通用位置；缺失或 `false` 表示不投影。
5. `~/.agents` 使用独立 shared-home definition，不进入 Agent Catalog，也不建立
   与 Agent Catalog 互相引用的第二套大 Catalog。
6. Agent destinations 与 shared destination 只在 Skills projection composition
   边界组合，Planner、Executor 和 Web 使用带 `kind` 的明确 destination identity。
7. 首版只实现 `skills` capability，不实现未来 Agents 页面或
   `~/.agents/agents`；shared-home definition 保留以后增加 capability 的结构。
8. 不在每个 Skill 下引入 `integrations` 配置 map、空对象或 per-item
   `strategy`。未来 capability 扩展属于 shared-home definition，不属于逐项选择值。
9. Skills 页面默认扫描 `~/.agents/skills`，但扫描结果必须排除 Loom-managed
   projection artifacts，只展示用户自己维护、可被 Loom 纳管的 Skills。
10. 从 `~/.agents/skills` 纳管 Skill 时沿用现有 `ref` 模式，不移动或复制用户目录。
    已纳管的 local skill 不再出现在后续扫描结果中。
11. External local skill 的 canonical source 与 selected destination 相同时，视为
    in-place satisfied：不创建 link/copy、不写 managed artifact state，也不在关闭
    assignment 或删除 manifest entry 时清理该目录。
12. `.loom-projection.json` 是扫描阶段的保留边界。Candidate 自身或扫描根目录以内
    任一祖先存在该 entry 时，整个 subtree 都不进入扫描结果；不解析 marker 内容，
    也不区分 `ownerRepo`。

## 目标

- Local skill 和 source member 可以独立选择通用 Skills destination。
- Global、source、item 和 detail controls 都支持 shared on/off/mixed 状态。
- Agent 与 shared 选择可以同时存在，且互不推导。
- Shared mutation 使用现有 targeted projection 的事务、性能和错误契约。
- Full Skills projection 同时 reconcile Agent 原生目录和 `~/.agents/skills`。
- `~/.agents/skills` 使用与 Agent 原生 Skills 目录相同的路径、ownership、
  collision、rollback 和 cleanup 安全等级。
- Skills 添加流程默认发现 `~/.agents/skills` 下的用户自有 Skills，并复用现有
  local skill 纳管能力。
- 纳管 `~/.agents/skills` 下的 Skill 后继续以原目录为 source，用户文件不因
  assignment toggle、manifest remove 或 cleanup 被移动、覆盖或删除。
- 设计边界允许 future Agents 内容领域复用 shared-home definition、destination
  resolution 和 projection infrastructure。

## 非目标

- 不把 `shared`、`agents-home` 或其他 sentinel 加入 `AgentId`、`AGENT_IDS`、
  `AgentIdSchema` 或 Agent Catalog。
- 不增加 Settings 开关、自定义 shared root 或运行时插件系统。
- 不实现 Agents 页面或 `~/.agents/agents` 投影。
- 不改变 MCP、Memory 或 Vars 的 manifest 与 projection 模型。
- 不增加 per-item projection strategy、命名规则或其他尚无需求的配置。
- 不从磁盘 artifact 自动推导 `shared: true`。
- 不接管、覆盖或删除 user-owned Skills。
- 不把默认扫描发现的 Skill 自动移动或复制到 repository `assets/skills`。
- 不通过解析所有 repository 的 `projected-skills.json` 来实现默认扫描过滤。

## 领域模型

### Manifest

`SkillMemberOverride` 和 `LocalSkill` 增加可选 boolean:

```ts
interface SkillMemberOverride {
  name: string
  entry: string
  agents?: AgentId[]
  shared?: boolean
}

interface LocalSkill {
  id: string
  path?: string
  agents?: AgentId[]
  shared?: boolean
}
```

示例:

```yaml
sources:
  - name: superpowers
    url: https://github.com/obra/superpowers.git
    ref: main
    members:
      - name: brainstorming
        entry: skills/brainstorming/SKILL.md
        agents: [codex]
        shared: true

skills:
  - id: frontend-design
    agents: [claude-code, opencode]
    shared: true
```

规则:

- 缺失与 `false` 等价，序列化时可以省略 `false`。
- `shared` 只接受 boolean；其他类型产生定位到具体 member/local skill 的 manifest
  diagnostic。
- `agents: []` 且 `shared: true` 是合法状态，表示只投影到通用位置。
- `agents` 非空且 `shared: false` 保持现有 Agent-only 行为。
- `agents` 和 `shared` 都未选择时，existing managed artifacts 按 ownership 规则清理。
- UI 状态只读取 manifest desired state，不读取磁盘目录推断选择。

### Runtime assignment

Manifest 保持清晰的平铺字段，Core 使用一个 Skills 专属值对象处理 mutation 和 diff:

```ts
interface SkillProjectionAssignment {
  agents: AgentId[]
  shared: boolean
}
```

Normalization 使用 Agent Catalog 顺序规范 `agents`，并把缺失 `shared` 规范为
`false`。Mutation 比较 normalized expected/next assignment，避免 Web 与 Server
分别实现选择语义。

### Destination identity

Skills Planner 与 Executor 使用判别 union:

```ts
type SkillProjectionDestination = { kind: 'agent'; agent: AgentId } | { kind: 'shared' }
```

稳定 key:

```text
agent:claude-code
agent:codex
agent:opencode
shared
```

Key 必须由单一 helper 生成，不能在 Core、Server 和 Web 各自拼接。

## Shared Home Definition

首版只有一个固定 shared home，不建立用户可配置 Catalog:

```ts
const SHARED_HOME = {
  root: { root: 'home', segments: ['.agents'] },
  capabilities: {
    skills: { path: ['skills'] },
  },
} as const
```

设计约束:

- Definition 是 pure TypeScript、零 IO。
- Definition 不 import Agent Catalog 或 `AgentId`。
- Agent Catalog 不 import shared-home definition。
- Definition 只声明 shared root 与已实现 capability path。
- Future Agents 内容领域可以在对应实现存在时增加
  `agents: { path: ['agents'] }`，但首版不预注册无实现 capability。
- 如果未来出现第二个真正独立的 shared provider，再把单个 definition 提升为
  Catalog；当前不提前引入 provider ids、插件加载或用户配置。

## 组合边界

模块依赖保持单向:

```text
Agent Catalog ───────┐
                     ├─ Skills Projection Destinations ─ Planner / Web
SHARED_HOME ─────────┘
```

Skills composition module 负责:

- 从 effective `config.agents` 得到 Applicable Skills agents；
- 把每个 Applicable Agent 转换为 `{ kind: 'agent', agent }`；
- 始终追加 `{ kind: 'shared' }` 作为 UI 候选；
- 从 `SkillProjectionAssignment` 生成 active destinations；
- 提供规范顺序: Agent Catalog 顺序在前，shared 在后；
- 提供 Web 所需 display metadata，但不让 `AgentChip` 接受假的 Agent id。

MCP、Memory、Vars 不经过这个 composition module，继续使用 Agent Catalog。

## Planner

Skills-specific plan 从 Agent-only 改为 destination-aware:

```ts
interface LinkPlan {
  skillId: string
  localPath?: string
  source: 'local' | SourceIdentity
  destinations: SkillProjectionDestination[]
}

interface SourceProjectionPlan {
  sourceName: string
  sourceUrl: string
  cacheId: string
  commit: string
  destination: SkillProjectionDestination
  projectionBase: string
  entries: SourceProjectionEntry[]
}

interface PreservedSourceNamespace {
  sourceName: string
  sourceUrl: string
  destination: SkillProjectionDestination
}
```

MCP plan、Memory plan 和 `skippedAgents` 继续使用 Agent 类型，不为 shared Skills 泛化。

Planning 规则:

- Local skill active destinations 是 selected agents 与 `shared` 的并集。
- Source member 为每个 active destination 独立参与 source plan。
- Source resources 沿用现有规则: 只有该 source 至少一个 selected member 选择了某个
  destination，resources 才投影到该 destination 的 source namespace。
- 不同 destination 的 selected members 不同，因此分别计算 projection base。
- Local/source namespace collision 按 destination key 分组；Agent A 的 collision 不
  阻断只针对 shared 的 targeted mutation，反之亦然。
- Full projection 检查所有 active destinations。

### In-place satisfaction

Local external ref 在 projection preflight 中解析 source 与 destination 的 canonical
physical identity。如果二者指向同一个真实目录:

- selected destination 视为已经满足，不生成 build/remove filesystem action；
- 该目录保持 user-owned，不写入 `.loom-projection.json`；
- `projected-skills.json` 不记录该 destination/skill artifact；
- 关闭 assignment、删除 local skill 或执行 orphan cleanup 时不删除该目录；
- 对 user-owned in-place source，`shared: false` 只表示 Loom 不管理 shared
  destination，不承诺该 Skill 在磁盘或读取该目录的客户端中不可见；
- source/destination identity 在 preflight 与 apply 边界内必须保持稳定，发生变化时
  本次 projection fail closed；
- canonical source 与 destination 不相同但目标已存在时，仍按普通 user-owned
  collision 处理，不能用名称相同代替 identity 相同。

该规则由 destination-aware executor 统一执行，避免 link 指向自身或 copy 覆盖
source。它适用于 shared destination，也适用于 external ref 恰好位于某个 Agent
原生 Skills destination 的同路径场景。

## Path Resolution

Server 暴露统一入口:

```ts
resolveSkillDestinationRoot(destination, context)
```

分派规则:

- `{ kind: 'agent', agent }` 委托现有 `agentSkillsDir(agent, context)`；
- `{ kind: 'shared' }` 从 home trust root 解析 `.agents/skills`。

Executor 只接收 destination identity 与经过统一 resolver 得到的 root，不直接读取
Agent Catalog 或 shared-home definition。

Shared path 不执行 command detection。目录不存在不表示“未安装”；它按安全创建规则
处理。

## Mutation 与 Targeted Projection

现有 agent-only assignment command 扩展为完整 Skills projection assignment batch:

```ts
interface SkillProjectionAssignment {
  agents: AgentId[]
  shared: boolean
}

interface AssignmentUpdate {
  expected: SkillProjectionAssignment
  next: SkillProjectionAssignment
}
```

一次 item/shared toggle:

1. Web 从当前 manifest 构造 normalized `expected`。
2. Web 只改变 `next.shared`。
3. Server 在 repository/projection lease 内重新读取 manifest。
4. 任一 target 的 current assignment 与 `expected` 不同，整批返回
   `409 stale_projection_assignment`。
5. Server 一次写入 `skills.yaml`。
6. Core diff 生成 `{ kind: 'shared' }` change destination。
7. Targeted projection 只准备、锁定和 reconcile 受影响的 local artifact 或
   source namespace。
8. Projection 成功后请求成功；失败时 desired state 保持已写入，Executor 回滚本次
   artifact mutations，Web reload manifest 并展示失败。

Source/global bulk:

- Source bulk 只更新该 source 的 selected members。
- Global bulk 更新全部 source members 和 local skills。
- 两者都使用一次 batch request、一次 YAML write 和一个 projection transaction。
- 不按 member 发 HTTP 请求、写 YAML 或执行 projection。
- Agent 与 shared 同时变化时，所有 changed destinations 进入同一个 journal；任一
  destination 失败时按实际 mutation 逆序 rollback。

Manual projection:

- Skills 页手动“投影”执行 full Skills reconciliation，覆盖所有 Applicable Agents
  和 shared destination。
- 现有 agent-scoped `/project` 只处理指定 Agent，不顺带处理 shared。
- Sync 后 full projection 同样包含 shared desired state。

## Source Reconciliation

现有 source selection/update/preserve 流程必须完整携带 `shared`:

- 编辑 source 时，仍存在的 selected member 保留原 `shared`。
- 新发现但未选择的 member 不自动获得 `shared`。
- 用户新选择 member 时默认 `shared: false`，除非 UI 明确提供并选择该 assignment。
- Remote update 中缺失 member 被保留为 local skill 时，同时继承原 `agents` 和
  `shared`。
- Source rename 后 shared destination 的旧 namespace 使用与 Agent destinations
  相同的 marker ownership orphan cleanup。
- Cache unavailable 时，shared namespace 与 Agent namespace 一样保留并返回
  source-specific warning。

## Web 交互

Shared control 覆盖现有所有 Skills assignment scopes:

- Global: 对全部 source members 和 local skills 显示 on/off/mixed 与计数。
- Source: 只对该 source selected members 显示 on/off/mixed 与计数。
- Item: 显示该 member/local skill 的 on/off。
- Detail: 展示并允许修改当前 Skill 的 shared assignment。

显示规则:

- Shared control 始终存在，不受 `config.agents` 影响。
- `config.agents: []` 时隐藏 Agent controls，但保留 shared control。
- Shared chip 位于 Agent chips 之后，并有视觉分隔。
- Shared chip 不复用 Agent 品牌外观；使用中性共享目录图标和可见文字“通用”。
- Tooltip 明确显示 `投影到 ~/.agents/skills`。
- Pending 时 global/source/item/detail assignment controls 使用同一个 gate，避免
  stale batch。
- Shared state 不根据磁盘 artifact 显示为 selected。

## Managed State

现有 `projected-skills.json` v1:

```json
{
  "version": 1,
  "ownerRepo": "...",
  "agents": {
    "codex": {}
  }
}
```

新 v2 使用 destination keys:

```json
{
  "version": 2,
  "ownerRepo": "...",
  "destinations": {
    "agent:codex": {},
    "shared": {}
  }
}
```

兼容规则:

- v1 只接受 Agent Catalog 中的合法 ids。
- v1 在内存中转换为 `agent:<id>`，不扫描文件系统补状态。
- 下一次成功 state write 写为 v2；读取本身不必产生额外写入。
- v2 只接受当前支持的 destination key 和合法 artifact entries。
- Version、owner、destination 或 entry malformed 时记录完整 `{ err }` 并
  fail closed，不执行基于该 state 的 cleanup。

Source namespace ownership 继续由 namespace marker 证明；local link/copy ownership
继续结合 managed state 与 marker。Marker parser 接收 destination identity，不依赖
Agent Catalog；marker document 保持现有 `ownerRepo`、artifact kind、source identity
等 ownership 字段。

## Resource Leases

Skills projection lease 包含:

- canonical repository identity；
- canonical home key；
- repository-specific `projected-skills.json`；
- 实际受影响的 Agent Skills roots；
- 实际受影响时的 `~/.agents/skills`。

Full Skills projection 锁定全部可能写入的 roots。Agent-scoped projection 不锁
shared root。Shared targeted mutation 不锁无关 Agent roots。不同 repository 同时
操作 `~/.agents/skills` 时由 shared root key 串行化，marker `ownerRepo` 决定是否有
权替换具体 artifact。

默认扫描和纳管也进入相同 resource boundary:

- 带 repository 的 scan 持有 repository、canonical home 与实际 scan root 的 read
  lease；默认 scan root key 与 shared projection 使用的
  `~/.agents/skills` key 完全相同；
- `ref` import 在读取 source identity、检查 manifest 和写入 manifest 期间持有
  repository 与 source root lease；
- `move` import 同时锁 source root 与 repository `assets/skills` root；
- shared assignment mutation 即使最终判定为 in-place satisfied，也在 preflight
  期间持有 shared root lease；
- scan/import 与 projection 不能观察或消费另一个 operation 的中间 transaction
  状态。

## Filesystem Safety 与 Ownership

`~/.agents/skills` 使用与 Agent-native Skills 相同的安全边界:

- home 是 trust root；
- `.agents`、`skills` 和 descendants 必须是稳定的真实目录；
- 缺失时可以逐级创建；
- existing symlink、junction、special entry、canonical escape 或 identity drift
  fail closed；
- preflight 在第一次 write 前覆盖全部 source 和 destination roots；
- apply 时重新验证 preflight 授权的 physical identity。

Cleanup:

- 只删除 Loom 能通过 state 或 marker 证明 ownership 的 artifact。
- User-owned destination collision 失败并保留原内容。
- 删除本次 managed child 后，可以删除变空的 `~/.agents/skills`。
- Cleanup 不能继续删除 `~/.agents`。
- Source unavailable 时保留 existing managed namespace。
- Full/global multi-destination projection 共用 journal，全部成功前不删除 backups 或
  报告成功。

## 默认扫描与纳管

### Candidate discovery

- Add Skill modal 每次打开时默认扫描 `~/.agents/skills`；用户仍可输入其他目录。
- Server 继续以 `**/SKILL.md` 发现 candidate，包含 dot directories，但不遍历
  `.git`、`node_modules` 或 symbolic-link directories。
- Candidate name 必须通过 `LocalSkillIdSchema`。
- Candidate directory 与从 candidate 到 scan root 的祖先链必须保持在 scan root
  内，并在返回结果前完成 stable identity revalidation。
- 已在当前 manifest 登记的 local skill id 不返回，因为它不能再次通过 import。
- 扫描只返回 candidate metadata，不读取磁盘状态推导 `agents` 或 `shared`。

### Managed filtering

`.loom-projection.json` 是 scan 的 reserved entry。对每个 candidate，从 candidate
directory 向上检查到 scan root:

- 任一层存在该名称的 entry，candidate 被排除；
- entry 内容不参与判定，valid、malformed、legacy、其他 repository owner 或未知
  kind 都同样排除；
- source namespace marker 因为位于 member 的祖先目录，会排除 namespace 内全部
  projected members；
- copy fallback marker 位于 candidate 自身，会排除该 projected local skill；
- link projection 不会被 glob 跟随，因此不会成为 candidate；
- stale `projected-skills.json` 记录本身不排除当前 unmarked physical directory，
  避免把已由用户接管的内容错误归类为 managed。

Marker 名称在 scan root 内属于 Loom 保留命名。用户自有 Skill 如果包含该 entry，
也不会显示为可纳管 candidate。Marker/ancestor entry inspection 或 identity
revalidation 失败时，scan 整体失败并记录完整 error，不返回部分结果。

### Ref import

用户选择默认扫描结果后，Server 复用现有 local skill `ref` import:

1. 在 source-root lease 内重新读取并验证 candidate，而不信任旧 scan result。
2. 检查 Skill id 尚未登记、source 是稳定真实目录且 `SKILL.md` 是稳定真实文件。
3. 在 `skills.yaml` 写入 `{ id, path: canonicalSourceDirectory }`，不写
   `shared: true`，不移动或复制 source。
4. 后续 scan 因该 id 已登记而不再返回它。
5. 用户明确打开 shared assignment 时，如果 source 就是
   `~/.agents/skills/<id>`，projection 按 in-place satisfaction 处理。
6. 关闭 shared assignment、remove local skill 或 repository cleanup 都只修改
   Loom desired/managed state，不删除该 user-owned source。

Browser directory picker 继续使用现有 archive write 流程写入 `assets/skills`，不受
默认 path scan 的 `ref` 语义影响。显式 `move` API 继续保留，但默认
`~/.agents/skills` 流程不调用它。

## 错误处理

- `shared` schema error 定位到具体 member/local skill。
- Stale assignment 返回 `409 stale_projection_assignment`，零 YAML write、零
  projection mutation。
- Shared user-owned collision 返回稳定消息，指出通用 Skills 目标存在非 Loom 管理
  内容；HTTP response 不回显绝对路径或 stack。
- Path boundary、marker/state parse、projection apply 和 rollback failure 记录完整
  error object、repository、destination kind 与阶段。
- Projection warning 传播到 Web；Web reload manifest、显示 warning，并抑制普通
  success toast。
- Scan/import 的 catch、拒绝分支和降级同样记录完整 `{ err }`，不能只记录
  `err.message`。
- Reserved marker subtree 属于正常过滤，不作为错误；marker/ancestor stat、source
  snapshot 或 identity revalidation 失败属于 scan/import failure。

## 测试计划

### Core

- Manifest 接受 shared missing/false/true，拒绝非法类型并给出字段路径。
- Assignment normalization、equality 与 diff。
- Agent + shared、shared-only、Agent-only 和全部关闭。
- Local/source/resources 按 destination planning。
- Collision 按 destination 隔离。
- Preserve missing source member 时继承 shared。

### Server

- Shared root resolution 与安全逐级创建。
- `.agents`/`skills` symlink、junction、special entry、escape 和 identity swap。
- Link/copy shared projection 与 managed cleanup。
- 空 `skills` root cleanup 保留 `.agents`。
- User-owned collision 与跨-repository owner mismatch。
- Source unavailable preservation 与 warning。
- Agent + shared transaction rollback。
- `projected-skills.json` v1 read、v2 write、malformed fail-closed。
- Single/source/global shared toggle 均为一次 YAML write、一次 targeted projection
  transaction。
- Stale assignment 零写入。
- Full、agent-scoped 和 shared-targeted resource leases。
- 默认 scan root 是 `~/.agents/skills`。
- Link/copy/source namespace managed artifacts 不出现在 scan candidates。
- Candidate/ancestor 的 valid、malformed、legacy 和 foreign-owner marker 都排除
  subtree，且不读取 marker content。
- Unmarked user-owned Skill 可被发现并通过 `ref` 纳管，已登记 id 不再返回。
- Ref import 保留原目录，不写 `shared: true`，browser archive write 行为不变。
- Shared in-place on/off、manifest remove 和 cleanup 都是零 filesystem mutation、
  零 managed artifact state。
- Canonical same-path、same-name/different-path collision 和 identity drift。
- Scan/import 与 shared projection 竞争同一 root 时由 lease 串行化。

### Web

- Global/source/item/detail shared on/off/mixed/count。
- `config.agents: []` 时 shared control 仍存在。
- Shared 与 Agent states 互不影响。
- Assignment batch body、pending gate、stale/failure reload 和 warning。
- Add Skill 默认展示 `~/.agents/skills` scan，并不展示 Loom-managed candidates。
- User-owned scan result 可以选择并完成现有纳管流程。

### Browser

实现完成后启动自己的 `bun dev`，使用命名 `playwright-cli` session 验证:

- Desktop 与窄屏 shared controls；
- Global/source/item/detail toggle；
- Tooltip、loading、mixed/count；
- Applicable Agents 为空时的布局；
- Add Skill 默认 scan、managed filtering 和 user-owned import；
- 无重叠、无异常 layout shift、无控制台错误。

### Repository

- 聚焦 Vitest。
- `bun run test:rtk`。
- `bun run format:check`。
- 检查 production source，确保 Agent ids 仍只来自 Agent Catalog，shared 不进入
  Agent schema，MCP/Memory/Vars 不出现 shared 分支。

## 规则文档更新

实现时同步更新:

- `CONTEXT.md`: 定义 Shared projection destination，明确它不是 Agent。
- `docs/rules/cross-cutting.md`: desired state、自动 targeted reconcile、UI 不从磁盘
  反推。
- `docs/rules/projection.md`: destination root、安全边界、ownership、state v2 和
  scoped reconciliation。
- `docs/rules/skills.md`: `shared`、三态 bulk、resources、shared namespace、默认
  scan 与 managed filtering。

规则只描述实现后的当前产品事实，不记录本次讨论或迁移故事。

## 验收标准

- `~/.agents/skills` 始终作为 Skills assignment 候选，默认关闭。
- 每个 source member/local skill 能独立保存 `shared`。
- Agent 与 shared 可以同时选择并正确投影。
- `config.agents: []` 时 shared-only projection 可用。
- Shared 不存在于任何 Agent Catalog、Agent schema 或 Settings Agent 配置。
- Full 与 targeted projection 的 scope、locks、cleanup 和 rollback 符合本设计。
- Existing Agent-only Skills、MCP、Memory 和 Vars 行为无回归。
- 默认 scan 只返回 user-owned Skills，不返回 Loom-managed projection artifacts。
- 用户可以用既有 `ref` 能力纳管 scan results，原目录和文件保持不变。
- 纳管后开启 shared assignment 不产生 self-link/self-copy，也不让 Loom 获得该
  user-owned directory 的 cleanup ownership。
- 实现、规则、Vitest、format check 和 Playwright 自动验证全部通过。
