# Agent 抽象设计

Status: approved

## 目标

Loom 通过一个共享的代码 Catalog 声明内置 agent。Core、Server 和 Web 从同一份声明派生类型、校验、顺序、运行时集成信息和展示信息，避免新增 agent 时在多个模块重复维护同一事实。

本设计遵循 [规则索引](../../rules/index.md) 及其链接的 skills、MCP、memory、vars 和 projection 规则，不改变 desired state、三态 agent 控制或 projection 安全边界。

Agent 范围使用三个不同概念：

- Registered agents：Agent Catalog 中 Loom 支持的全集；
- Configured agents：effective `config.agents` 选择的全局可见与 projection 候选集合；
- Applicable agents：Configured agents 中支持当前 capability 的子集。

## 设计原则

- 单一来源只覆盖 agent 的声明性事实，不把所有行为塞进一个万能配置对象。
- Catalog 保持纯 TypeScript、零 IO，不包含 React 组件、文件系统操作、进程调用或任意业务 callback。
- 复用现有能力的 agent 只增加一个 Catalog 条目；真正新增原生格式时，通过独立 codec 扩展。
- Core、Server 和 Web 不再维护各自的 agent id、顺序或元数据列表。
- 不以削弱类型安全或引入运行时插件系统换取表面的可扩展性。

## 推荐架构

在 `packages/core` 建立不可变的 Agent Catalog。Catalog 是跨层唯一的 per-agent 声明来源，提供：

- 完整 agent definitions；
- 规范 agent 顺序；
- 按 id 查询 agent definition；
- 由 Catalog 派生的 `AgentId` 和 `AgentIdSchema`。

Catalog definition 使用以下字段结构：

```ts
export const AGENTS = defineAgentCatalog([
  {
    id: 'codex',
    display: {
      name: 'Codex',
      short: 'CX',
      color: '#06b6d4',
      icon: { kind: 'asset', key: 'codex' },
    },
    command: 'codex',
    configDir: {
      overrideEnv: 'CODEX_HOME',
      fallback: { root: 'home', segments: ['.codex'] },
    },
    skills: { path: { root: 'config', segments: ['skills'] } },
    memory: { path: { root: 'config', segments: ['AGENTS.md'] } },
    mcp: {
      path: { root: 'config', segments: ['config.toml'] },
      codec: 'toml-table',
      rootKey: 'mcp_servers',
      importSuffix: 'cx',
    },
  },
] as const)

export type AgentId = (typeof AGENTS)[number]['id']
```

`skills`、`memory` 和 `mcp` 能力由对应字段是否存在表达。Agent-aware vars 是所有已注册 agent 都具备的跨模块能力，不单独设可选开关。页面和 projection 只向适用 agent 展示或执行可选能力，不假设所有 agent 永远支持相同功能。

## Catalog interface 与 invariants

Catalog 对调用方暴露不可变 definitions、按 id 查询和按 capability 过滤三个主要入口。`AGENT_IDS`、`AgentId` 和 `AgentIdSchema` 从 definitions 派生，不允许调用方自行拼装另一份列表。

`defineAgentCatalog` 在模块初始化时校验代码配置：

- agent id 唯一且满足稳定的小写 kebab-case 格式；
- display short name 和 MCP import suffix 在各自适用范围内唯一；
- path segment 是非空相对 segment，不包含分隔符、`.` 或 `..`；
- 每个 agent 至少声明一项可投影 capability；
- capability 出现时，它要求的 path、codec 和容器信息必须完整；
- codec id 受 TypeScript union 约束，并由 codec contract test 验证已注册实现。

这些错误属于开发者引入的无效代码，不降级运行，也不转换成用户 manifest diagnostic。

Path spec 只覆盖当前可证明存在的模式：

- `home`：用户 home；
- `xdg-config`：`XDG_CONFIG_HOME`，缺失时回退到 `~/.config`；
- `config`：当前 agent 已解析的 config directory；
- config directory 可以声明一个覆盖整个目录的环境变量。

Server path resolver 接收显式的 home、environment 和 platform context 后解释 path spec。Web 只格式化 fallback path 用于展示，不读取服务端环境变量。未来 agent 需要新的 path root 时，新增一个经过测试的 path primitive，而不是在 definition 中嵌入函数。

## 声明与实现

Catalog 负责描述：

- agent id 与规范顺序；
- 完整名称、短名称、颜色和图标声明；
- 安装检测使用的命令；
- 配置目录及 skills、memory、MCP 的路径规则；
- agent 支持的能力；
- MCP 使用的 codec、容器键和导入后缀。

通用执行模块负责解释这些声明：

- Core 从 Catalog 派生类型、Zod schema 和能力查询；
- Server 使用统一路径解析、安装检测和 projection 流程；
- Web 使用同一顺序、名称、颜色、能力和预览元数据；
- MCP import、projection 和 preview 复用同一 codec 语义。

Server 保留 `IAgentAdapter` 作为 executor 与可替换文件 IO 之间的 seam。Production 只使用一个由 agent definition 和 codec 参数化的通用 MCP adapter；测试继续注入 failure adapter 验证 rollback。Projection dependencies 通过遍历支持 MCP 的 definitions 构建 adapter map，不再实例化逐 agent adapter classes。

进程 port 改为按可执行命令检测，workflow 将 definition 中的 command 传给 platform adapter。Node platform 不再维护 agent id 到 command 的映射。初始化 config 模板同样从规范 agent ids 生成。

JSON object 与 TOML table 是首批通用 MCP codecs。Codec 是纯格式转换实现，不负责文件 IO。Server adapter 负责读取和写入文件，Web preview 复用 codec 输出，从而避免两边分别维护 agent-specific 分支。

Codec interface 覆盖三个行为：

- 从完整 agent-native document 读取指定 root key 下的 MCP entries；
- 保留 document 中不属于该 root key 的内容，并写回合并后的 entries；
- 为 Web 生成与真实写入语义相同的单条 preview。

Import、projection 和 preview 通过 codec id 解析同一实现。新的 native format 可以新增 codec，但不能把 agent id 条件分支重新放回调用方。

## Capability 与校验策略

`config.agents` 表示当前仓库的 Configured agents，不要求其中每个 agent 支持所有能力。各功能从该集合中选取声明了对应 capability 的 agent：

```text
Applicable agents = Configured agents ∩ Registered agents supporting the capability
```

带 per-item agents 的功能进一步使用：

```text
active item agents = saved item agents ∩ Applicable agents
```

- Settings 是 Configured agents 的编辑入口，因此展示全部 Registered agents 作为候选项。
- Skills、MCP 和 Memory 只展示或执行 Applicable agents；Vars 使用全部 Configured agents。
- 其他功能页面不提供新增或移除 Configured agents 的入口。Memory 保留 per-memory agent assignment，但 controls 只枚举 Applicable Memory agents。
- Memory assignment 与其他 per-item desired state 一样保留当前未配置的 Registered agent；projection 再与 Configured、Applicable 和 Installed agents 求交集。
- Skill、source member 或 MCP server 显式选择了不支持对应能力的 agent 时，manifest 返回定位到该字段的 error，projection 在写入前失败。
- Item 中保存了 Registered 但当前未配置的 agent 是合法状态：它保持隐藏且不投影，不产生 manifest error。
- UI 应阻止创建新的非法选择，但不能依赖 UI 代替 manifest 校验。
- 不静默丢弃显式保存的非法 agent，避免配置错误长期隐藏。
- 从 Configured agents 移除 agent 时，已有 per-item agent selections、agent vars 文件和其他 desired state 保留但不展示；重新配置该 agent 后恢复可见。
- `config.agents` 是 UI scope 与 projection eligibility，不是授权边界，也不授权删除 user-owned data。

现有 `claude-code`、`codex` 和 `opencode` definitions 声明当前已支持的全部能力，因此非空 Configured agents 的 capability filtering 保持现有行为。空配置移除隐式 agent fallback 是本设计明确修正的契约。

## 空 Configured agents

`config.agents` 缺失或为空数组都规范化为空集合。空集合是合法且完整的产品状态，不回退到 Catalog 全集、规范顺序首项、Codex 或 Claude Code。

新仓库初始化可以把当时的 Registered agents 显式写入 `config.agents`，但运行时不存在隐式全选。Catalog 后续新增 agent 不会自动修改既有仓库；用户需要在 Settings 中明确配置后才会看见它。

各功能在空集合下保持自身非 agent 能力：

- Settings 继续展示全部 Registered agents，用户可以重新配置 agent。
- Skills 继续允许管理 sources、local skills 和内容，但不显示 global、source 或 item agent controls。
- MCP 继续允许管理 server definitions，并保留 RAW 与 Default 视图；不显示 agent preview tabs、agent controls 或 agent-specific debug agent。
- MCP import 没有 source agents。显式 `sources: []` 扫描零个来源，绝不解释成扫描全部 Registered agents；请求未提供 sources 时由应用层使用当前 Applicable agents。
- Memory 继续允许管理、激活和编辑内容，但不显示 agent assignment controls，也不发起 agent-specific preview。
- Vars 保留 Base 与 Local 的 Default 上下文，不显示 agent slots，也不请求 agent matrices。
- React state 使用 `AgentId | null` 或显式 Default context 表达无 agent，不借用任一真实 agent 作为 sentinel。

Projection 以空 active agent set 规划，不创建新的 agent artifacts。显式或自动 reconciliation 仍可按照现有 ownership 规则删除 Loom-managed Skills/MCP artifacts；不能仅因 Configured agents 为空删除无法证明 ownership 的文件。当前 Memory projection 没有持久化 ownership 与原内容，因而本次重构不删除既有 agent-native memory 文件。安全的 Memory unprojection 需要独立的 ownership/restore 设计。

Project/reconcile commands 在空集合下仍可执行，以便清理可证明为 Loom-managed 的 artifacts；“没有 agent”本身不是错误。

## 错误处理

错误按所有者和发生阶段处理：

1. Catalog definition 错误由类型检查、`defineAgentCatalog` invariants 或 contract test 尽早失败。
2. 未知 agent id 和显式 capability mismatch 作为带字段路径的 manifest error 返回，并在任何 projection 写入前阻止执行。空 Configured agents 不是 error。
3. 全局 agent 不适用于当前功能时按 capability 交集排除；这不是错误，也不修改 desired state。
4. Agent command 未安装时沿用现有 skipped-agent 行为。安装检测本身抛错时记录完整 error 与 agent context，并沿用现有“假定已安装”降级。
5. MCP import parse error 记录完整 error、agent 和 path，并返回现有 `parse_failed` 诊断。
6. Projection 的 codec、读取或写入错误向 executor 传播，沿用 projection journal 回滚；原始错误和每个 rollback error 都完整记录。
7. Web 的 asset icon 缺失或 codec 引用不完整由 contract test 失败，不在运行时静默显示空内容。

所有新增 catch、错误分支和降级点遵循项目日志约定，保留完整错误对象与堆栈，不只记录 `err.message`。

## 现有契约

- 保留三个现有 agent ids、规范顺序、display names、short names、颜色与 env overrides。
- 保持 config、skills、memory 和 MCP 的现有落点路径。
- 保持 JSON/TOML 中非 Loom-managed 内容的保留语义、MCP import 冲突命名、projection rollback 和 user-owned artifact 安全边界。
- 保持品牌图标、tooltip、`aria-label`、三态与 count 行为。
- Agent native MCP parse、serialize 和 preview 输出由 contract tests 固定。
- 删除当前散落的 Codex/Claude Code fallback；空 Configured agents 不再产生隐式 agent-specific preview。

## 品牌图标

Agent 图标的视觉规范见 [Agent 品牌图标设计](./2026-07-16-agent-brand-icons-design.md)，图标选择由 Agent Catalog 维护。

- `display.icon` 显式区分本地 SVG asset 与文字图标。
- Web 使用一个通用 asset resolver 加载 `packages/web/src/assets/agents/*.svg`。
- `AgentChip` 将解析后的 asset 写入通用 `--agent-icon` CSS 变量。
- 共享 CSS 不再包含逐 agent 的 `[data-agent='...']` 选择器。
- `asset` 引用缺失时自动化验证失败；没有品牌图标的 agent 必须显式声明文字图标，不静默降级。
- 现有自定义 children、count、tooltip、`aria-label` 和三态行为保持不变。

SVG 是 agent 的实现资源，不是第二份 agent 配置。新增使用品牌图标的 agent 需要一个 Catalog 条目和对应 SVG asset。

Asset resolver 按 `display.icon.key` 从静态 SVG 集合中查询 URL，并把结果通过 CSS custom property 交给 `AgentChip`。Resolver 是 Web 与 Vite asset graph 之间的 adapter，不进入 Core，也不建立第二份 agent metadata map。

## 扩展契约

新增一个复用现有能力与 codec 的 agent 时：

1. 在 Agent Catalog 增加一个 definition。
2. 如声明品牌图标，增加对应 SVG asset。

Core 类型与 schema、Server 路径和安装检测、Web agent 控件及预览目标应自动生效，不修改页面、projection workflow 或平行映射。

新增原生配置格式时：

1. 实现一个独立 codec 及其契约测试。
2. 在 Agent Catalog 中引用该 codec。
3. 如需要，增加对应 SVG asset。

新的真实行为允许产生新的实现代码；不允许为已有声明重复建立 agent-specific 列表或分支。

## 测试与验证

测试围绕 Catalog interface 和可观察行为组织：

### Core

- Catalog ids、顺序、schema 和 lookup 保持一致；
- 重复 id、无效 path、缺失 capability 字段和未知 codec 在 contract tests 中失败；
- capability filtering 区分全局不适用与显式非法选择；
- manifest error 定位到对应 agent 字段；
- 使用测试 Catalog 中的第四个 agent 验证派生类型之外的运行时 helpers 不依赖三个现有 id。

### Server

- 保留三个现有 agent 的路径和 env override golden tests；
- path resolver 使用注入的 home、environment 和 platform context 测试，不读取测试进程偶然状态；
- install detection 对 Catalog 中每个 command 使用同一流程；
- 每个 codec 运行 parse、preserve unrelated content、merge、serialize 和 preview contract tests；
- MCP import 与 projection 继续覆盖 parse failure、write failure、managed entry cleanup 和 rollback；
- partial-capability agent 不进入不适用功能的 projection plan。

### Web

- Settings、Skills、MCP、Memory 和 Vars 从 Catalog 或 capability query 获取 agent，不维护本地 id 列表；
- `AgentChip` 测试遍历 Catalog，验证 asset/text icon、完整 accessible name、tooltip、三态和 count；
- asset resolver contract test 验证每个 asset icon key 都存在对应 SVG；
- MCP syntax highlighting 和 preview format 从 codec metadata 派生；
- partial-capability fixture 验证功能页面只展示适用 agent；
- 空 Configured agents 覆盖 Skills、MCP、Memory 和 Vars 的无 agent 状态，并断言不出现隐式 Codex/Claude Code fallback；
- MCP import 覆盖 omitted sources、显式空 sources 和 configured subset，确保空数组不回退到全部 agents；
- hidden per-item selections、Memory assignments 与 agent vars 在 agent 移出并重新加入 Configured agents 后保持不变；
- 相关页面使用命名 Playwright session 验证桌面和窄屏布局、图标渲染、tooltip 边界及控制台错误。

### 仓库验证

- 运行 `bun run test`；
- 运行 `bun run format:check`；
- 检查 production source，具体 agent id 的穷举列表只允许存在于 Agent Catalog，agent-specific 行为只允许存在于对应 codec 或 asset。

## 规则文档

实现同步更新相关 `docs/rules/` 表述：产品规则使用“已注册且支持该 capability 的 agent”，不把 CC/CX/OC 写成封闭集合。现有三个 agent 可以继续作为 examples，但不再表达系统只能支持三个 agent。

Capability filtering 需要同步澄清 Configured agents 的全局可见性、空集合、Memory per-agent assignment、MCP preview/import agents、per-item agent validation 和 projection planning 的当前规则。规则只描述最终产品契约，不记录本次重构过程。

## 验收标准

- 新增复用现有 primitives 的 Hermes fixture 时，production consumers 不增加 agent-specific 分支。
- 新增真实内置 agent 时，常规改动限制为一个 Catalog definition 和可选 SVG asset。
- 新 native format 的额外改动限制为独立 codec、codec contract test、Catalog definition 和可选 SVG asset。
- Core、Server 和 Web 不再存在平行的 agent id、顺序、display metadata、path 或 native format 映射。
- 三个现有 agent 的路径、投影文件内容、MCP import/preview 和 UI 行为保持一致；manifest 字段按本设计切换为 `agents`。
- capability mismatch、未安装 agent、parse failure、write failure 和 icon 缺失分别按本设计的 error、skip、rollback 或 contract failure 处理。
- `config.agents: []` 时所有功能页面均无 Agent 控件，且没有代码路径回退到全部或某个固定 agent。
- 从 Configured agents 暂时移除 agent 不删除其 desired state；重新加入后恢复相关 agent selections、Memory assignments 与 vars。
- 全量 Vitest、Prettier check 和自动化浏览器验证通过。

## 非目标

- 不支持用户通过 YAML/JSON 在运行时定义 agent。
- 不引入动态插件加载或代码生成流水线。
- 不要求任何 agent 无论能力差异都只能修改一行代码。
- 不改变 manifest desired state、agent 三态语义、自动 reconcile 规则或 user-owned artifact 安全边界。
