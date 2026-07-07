# Agent-aware Vars 设计

- 日期:2026-07-07
- 状态:草案,讨论中

## 概述

为 loom 的 vars 系统增加 agent-aware 覆盖能力,使同一个变量 key 可以在不同 profile 与不同 agent 下得到不同值。memory、MCP 配置和后续投影能力都可以作为消费者复用同一套 vars 解析模型。

本设计按“产品仍在开发中,不需要兼容旧用户数据”的前提处理。优先选择更清晰、可维护、可扩展的 schema。

## 设计决策汇总

| 决策点           | 结论                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| base             | `vars/base.yaml` 是唯一用户可编辑 key schema registry,定义用户 key 的 type、format 与默认值           |
| local 层         | `local` 是本机专属层,不进 git sync,是最高用户可配置层                                                 |
| agent 覆盖       | synced base 与 local 都可以有 `vars/agents/<agent>.yaml` 子覆盖                                       |
| builtin registry | 系统内置只读 registry,不落盘,由代码定义并在运行时计算值                                               |
| storage 形状     | synced: `vars/base.yaml` + `vars/agents/*`;local: `vars/local.yaml` + `vars/agents/*`                 |
| value override   | 非 base 层不定义新 key;只允许对 base 已声明 key 写显式 `value` 覆盖                                   |
| UI 视角          | key-centric:选中一个 key 后查看/编辑 base/local/agent 覆盖                                            |
| 预览追溯         | 提供最终解析预览页;每个变量可追溯到具体 layer 与依赖                                                  |
| 多行文本         | `string` 天然支持多行                                                                                 |
| markdown         | 不新增 `markdown` type;用 `string.format = markdown`                                                  |
| JSON             | 保留 `json` type 表示结构化 JSON;`string.format = json` 表示 JSON 文本                                |
| fallback         | 第一版不支持 `${key:default}`;默认值放在 `base.yaml` 中                                               |
| required key     | 第一版不支持;无值默认用空字符串,有场景再增加 required                                                 |
| `LOOM_*`         | `LOOM_` 前缀保留给 builtin runtime,用户变量禁止使用                                                   |
| key 命名         | 使用 `^[A-Za-z_][A-Za-z0-9_.-]*$`,支持 `memory.rtk` 等 namespace 风格                                 |
| JSON 覆盖        | 按 key 整值替换,不做 deep merge                                                                       |
| 引用解析         | 先 merge 所有 layer,再递归解析引用                                                                    |
| 文本插值         | `string` 原样插入,`number`/`boolean` 转文本,`json` 不允许直接插入文本;字面 `${...}` 用 `\${...}` 转义 |
| 删除/重命名      | 删除 key 需检查引用;重命名 key 需同步更新覆盖和引用                                                   |
| 类型校验         | override 严格按 base schema 校验,不自动 stringify                                                     |
| secret           | 暂无需求,本轮不设计 secret 存储/预览策略                                                              |

## 方案

### 存储布局

#### Loom home 约定

Loom home 目录按职责分层:

```
~/.loom/
├── config.yaml                  # 全局本机配置,如 active_repo、UI 偏好
├── repos/
│   └── <repo>/                  # 可同步的 repo state
├── local/
│   └── repos/
│       └── <repo>/              # repo-scoped local overrides
├── state/                       # 运行状态,如 sync session metadata
├── cache/                       # 可重建缓存,如临时 worktree/update cache
└── logs/                        # 本机日志
```

原则:

- `~/.loom/config.yaml` 保持为全局本机配置。
- `~/.loom/repos/<repo>` 只放需要参与 sync / git 管理的声明式配置。
- `~/.loom/local/repos/<repo>` 只放该 repo 的本机专属覆盖。
- `~/.loom/state` 放运行状态,不要求可重建,但不属于用户声明式配置。
- `~/.loom/cache` 放可重建缓存。
- `~/.loom/logs` 放本机日志。
- 暂不设计 repo-scoped local config;repo 级本机覆盖先只覆盖 vars 等明确需要 local 的资源。

#### Builtin vars

Builtin vars 是系统提供的只读变量,不写入任何 YAML 文件。它们由代码中的 builtin registry 定义 type/format,在 resolver 运行时根据当前 agent、profile 与本机路径计算 value。

初始 builtin keys:

```yaml
LOOM_AGENT:
  type: string
LOOM_PROFILE:
  type: string
LOOM_CONFIG_DIR:
  type: string
  format: path
LOOM_SKILLS_DIR:
  type: string
  format: path
LOOM_AGENT_FILE:
  type: string
  format: path
```

语义:

| key               | value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `LOOM_AGENT`      | 当前渲染目标 agent 的 AgentId,例如 `codex`                          |
| `LOOM_PROFILE`    | 当前 profile chain 的用户可见名称;第一版固定为 `base`               |
| `LOOM_CONFIG_DIR` | 当前渲染目标 agent 的配置目录,例如渲染 Codex 时是 Codex home        |
| `LOOM_SKILLS_DIR` | 当前渲染目标 agent 的 skills 目录;目标 agent 不支持时使用空字符串   |
| `LOOM_AGENT_FILE` | 当前渲染目标 agent 的 prompt 文件名,例如 `CLAUDE.md` 或 `AGENTS.md` |

规则:

- Builtin vars 是 full registry 的一部分,消费者可以引用。
- Builtin vars 不出现在 `vars/base.yaml`,也不参与 sync、merge、push。
- Builtin vars 在 UI 中作为只读分组展示。
- 用户不能新建、编辑、删除或覆盖 builtin vars。
- 用户 key 不能以 `LOOM_` 开头,避免与 builtin vars 冲突。

#### Synced repo vars

```
~/.loom/repos/<repo>/
└── vars/
    ├── base.yaml
    ├── agents/
    │   ├── claude-code.yaml
    │   ├── codex.yaml
    │   └── opencode.yaml
    └── profiles/               # 未来多 profile 时使用;第一版可不实现
        └── work/
            ├── vars.yaml
            └── agents/
                └── codex.yaml
```

#### Local vars

```
~/.loom/local/repos/<repo>/
└── vars/
    ├── local.yaml
    └── agents/
        ├── claude-code.yaml
        ├── codex.yaml
        └── opencode.yaml
```

说明:

- `base.yaml` 是唯一用户可编辑 key schema registry,不可删除。
- `local.yaml` 是本机专属覆盖,不进 git sync。
- `vars/agents/<agent>.yaml` 在 synced repo 中表示 base agent 覆盖,在 local repo 中表示 local agent 覆盖。
- 第一版实际 chain 只需要 `base → base.agent → local → local.agent`。
- Schema 预留多 profile 能力;未来可以扩展为 `base → base.agent → work → work.agent → local → local.agent`。
- builtin `LOOM_*` 不落盘,渲染时临时构造。
- 缺失的 agent 文件或 local 文件按空 layer 处理,不阻塞渲染。

### 文件格式与 key 定义

vars 文件允许两类 entry:

1. typed definition:只允许出现在 `vars/base.yaml`,定义 key 的 type/format/value。
2. value override:出现在 agent/local/profile layer,只覆盖 base 已定义 key 的 value。

`base.yaml` 定义所有 key、编辑格式与默认值:

```yaml
# synced: vars/base.yaml
rtk:
  type: string
  format: path
  value: ${LOOM_CONFIG_DIR}/RTK.md

agent_name:
  type: string
  value: Agent

agent_extra_rules:
  type: string
  format: markdown
  value: ''

model_config:
  type: json
  value:
    model: gpt-5
    temperature: 0.2
```

base 的 agent 子覆盖:

```yaml
# synced: vars/agents/codex.yaml
agent_name:
  value: Codex

agent_extra_rules:
  value: |-
    - Codex 通用规则。
```

local 可以覆盖已有 key:

```yaml
# local: vars/local.yaml
agent_extra_rules:
  value: |-
    - 本机专属补充规则。
```

local + codex 的专属覆盖:

```yaml
# local: vars/agents/codex.yaml
agent_extra_rules:
  value: |-
    - Codex 在本机上的专属规则。
```

规则:

- 非 `base.yaml` 文件只能覆盖 `base.yaml` 已声明 key。
- 非 `base.yaml` 文件出现未知 key 时产生诊断。
- 非 `base.yaml` 文件出现 typed definition 时产生诊断。
- 不使用裸值 override。即使覆盖值是简单字符串,也写成 `key: { value: ... }` 或展开形式,避免 YAML 把 `false`、`1` 等误读成其它类型。
- 本机专属 key 也必须先在 `base.yaml` 中声明;如果没有通用默认值,可把默认值设为空字符串或合适的空值。
- `base.yaml` 不支持 required key;第一版没有值时使用空字符串等显式默认值。
- `LOOM_` 前缀保留给 builtin runtime,用户 key 禁止以 `LOOM_` 开头。
- 用户 key 使用 `^[A-Za-z_][A-Za-z0-9_.-]*$`,支持 `memory.rtk`、`agent_extra_rules`、`model-config` 等命名。
- 用户 key 不允许使用 `:`,为后续默认值或 formatter 语法预留空间。

### VarEntry 类型

```ts
type StringFormat = 'plain' | 'markdown' | 'json' | 'yaml' | 'toml' | 'shell' | 'path'

type VarDefinition =
  | { type: 'string'; value: string; format?: StringFormat }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'json'; value: JsonValue }

type VarOverride = { value: string | number | boolean | JsonValue }
```

规则:

- `string` 可以是单行或多行;单行/多行只是编辑器状态。
- `format` 只影响编辑器、语法高亮、格式化、校验和预览,不改变变量解析语义。
- `format: markdown` 支持单变量 markdown 预览,但值仍然是 string。
- `format: json` 表示 JSON 文本;如果调用方需要结构化对象,使用 `type: json`。
- vars resolver 保留 typed value,不会把所有变量统一转成 string。
- 在 `string` 值中使用 `${key}` 时:
  - `string` 值原样插入。
  - `number` 和 `boolean` 使用稳定文本表示插入,例如 `0.2`、`true`。
  - `json` 值不允许直接插入文本,产生诊断;需要 JSON 文本时使用 `type: string, format: json`。
  - 字面 `${...}` 使用 `\${...}` 转义,解析后输出 `${...}`。
- secret 暂不纳入本轮设计。

### 覆盖链与解析

第一版渲染某个 agent 时构造 chain:

```
synced vars/base.yaml
→ synced vars/agents/<agent>.yaml
→ local vars/local.yaml
→ local vars/agents/<agent>.yaml
→ builtin runtime
```

未来多 profile chain 可以扩展为:

```
base
→ base.agent
→ profile.work
→ profile.work.agent
→ local
→ local.agent
→ builtin runtime
```

builtin runtime value 示例:

```yaml
LOOM_AGENT:
  type: string
  value: codex

LOOM_PROFILE:
  type: string
  value: base

LOOM_CONFIG_DIR:
  type: string
  value: C:/Users/10107/.codex

LOOM_SKILLS_DIR:
  type: string
  value: C:/Users/10107/.codex/skills

LOOM_AGENT_FILE:
  type: string
  value: AGENTS.md
```

builtin runtime 不写入磁盘,且优先级高于 local。用户不能覆盖 `LOOM_*`。

解析使用 vars 的递归 resolver。普通变量可以引用 builtin 变量:

```yaml
rtk:
  type: string
  format: path
  value: ${LOOM_CONFIG_DIR}/RTK.md
```

第一版不支持 `${key:default}`;缺失 key 直接产生诊断。需要默认值时在 `base.yaml` 中定义。

消费者只引用 full registry 中存在的 key。full registry 由 builtin registry 与 `vars/base.yaml` 组成;缺失 key 直接产生诊断。

### key-centric UI

UI 不要求用户切换到不同文件里寻找同一个 key。UI 以 key 为中心:

```
agent_extra_rules
├── base: ...
├── base / codex: ...
├── local: ...
└── local / codex: ...
```

交互规则:

- 变量列表显示 builtin registry 与 `base.yaml` 中声明的 key。
- Builtin vars 以只读分组展示,不提供编辑、覆盖、删除和重命名操作。
- 新建 key 只写入 `base.yaml`。
- 选中 key 后,在同一面板查看 base、base agent、local、local agent 覆盖。
- 未配置覆盖时显示“继承”,并展示最终继承值。
- 支持“设为覆盖”和“恢复继承”。
- 多行 string 使用 textarea 或代码编辑器。
- `format: markdown` 提供“编辑 / 解析结果 / Markdown 预览”视图。
- `format: json` / `yaml` / `toml` 提供格式化和校验。
- 单变量 markdown 预览只预览该变量自身;完整消费场景由对应消费者页面预览。

### 解析预览与追溯

预留一个 vars 解析预览页面,用于查看某个 agent 下的最终变量结果与来源。

预览输入:

- agent
- profile chain(第一版固定为 `base → local`)

预览输出:

- 最终 key/value 列表
- 每个 key 的 type/format
- 每个 key 的最终来源 layer
- 每个 key 的覆盖链,例如 `base → base/codex → local → local/codex`
- 每个 key 的依赖链,例如 `rtk → LOOM_CONFIG_DIR(builtin)`
- 诊断:缺失引用、循环引用、类型不匹配、未知 key override、非 base typed definition

示例:

```
rtk = C:/Users/10107/.codex/RTK.md
source: base.yaml
depends on: LOOM_CONFIG_DIR(builtin)

agent_extra_rules = "- Codex 在本机上的专属规则。"
source: local vars/agents/codex.yaml
overrides: base.yaml → synced vars/agents/codex.yaml → local vars/local.yaml
```

### 边缘场景规则

- **JSON 覆盖**:按 key 整值替换,不做 deep merge。若需要细粒度覆盖,拆成多个 key。
- **引用解析顺序**:先按 chain merge,再递归解析引用。因此 base 中的 `${other_key}` 会看到 local 对 `other_key` 的覆盖。
- **删除 key**:删除 `base.yaml` 中的 key 前必须检查变量引用和已登记消费者引用;存在引用时阻塞删除并展示引用来源。
- **清除覆盖**:删除当前 layer 的 `value` 只表示恢复继承,不需要阻塞。
- **重命名 key**:跨所有 layer 同步改名,并更新变量值及已登记消费者中的 `${old_key}` 引用;执行前展示影响范围。
- **未知 agent 文件**:`vars/agents/<agent>.yaml` 中的 agent 必须是支持的 AgentId;未知文件产生诊断,不参与渲染。
- **类型不匹配**:override value 必须符合 base schema。schema 是 `string` 时,`value: false` 是类型错误,应写成 `value: 'false'`。
- **local 不同步**:`~/.loom/local/repos/<repo>/...` 只参与本机解析和投影,不进入 sync diff、merge、push。

### API 形状

API 可以按 storage 和 UI 各提供一层:

- storage-level API:操作 base/local/agent layer 下的持久化 entry,不写 builtin vars。
- key-centric API:返回面向 UI 的聚合视图。
- preview API:返回最终解析结果、来源与依赖追溯。

示意:

```ts
type VarsLayerRef =
  | { locality: 'builtin'; layer: 'runtime' }
  | { locality: 'synced'; layer: 'base'; agent?: AgentId }
  | { locality: 'local'; layer: 'local'; agent?: AgentId }

type VarsKeyMatrix = {
  key: string
  readonly: boolean
  definition: {
    layer: VarsLayerRef
    entry: VarDefinition
  }
  values: Array<{
    layer: VarsLayerRef
    override: VarOverride | null
    inherited: boolean
    effective: VarDefinition
  }>
}

type VarsPreviewEntry = {
  key: string
  value: VarDefinition
  source: VarsLayerRef
  overrides: VarsLayerRef[]
  dependencies: string[]
}
```

具体路由可以在实现计划阶段确定;核心约束是 API 不把 UI 绑定到文件路径,而是使用 locality/layer/agent/key 语义。
