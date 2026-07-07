# Vars Profiles UI 信息架构设计

- 日期: 2026-07-07
- 状态: 草案,以当前 `/vars-lab` 演示版为准
- 关联设计:
  - docs/superpowers/specs/2026-07-07-agent-aware-vars-design.md
  - docs/superpowers/specs/2026-07-07-memory-vars-consumption-design.md
  - docs/ui/index.md
  - docs/ui/design-system.md
  - docs/ui/components.md

## 目标

重新设计 Vars 页面信息架构,让用户先理解“在哪个配置范围里管理变量”,再进入具体变量的编辑、预览和追溯。

本设计只覆盖 Web UI 信息架构和交互文案。核心存储、resolver、builtin registry、agent-aware 解析语义以关联设计为准。

## 术语

推荐使用 Profiles 作为左侧主导航术语。

取舍:

- Groups 只描述 UI 分组,不是产品概念,不适合作为主对象名称。
- Environments 容易被理解为 dev/staging/prod 运行环境,但 base、local、builtin 并不全是部署环境。
- Profiles 更适合表达一组可命名、可选择、可参与解析的配置范围,也能自然容纳 prod、work 等未来自定义配置。

UI 可以在局部文案中解释 profile 是 configuration scope,但主导航不使用 Groups。

## 页面结构

Vars 页面采用两层视图。UI 文案使用中文任务语言,内部规格仍可使用 Definitions / Resolved 指代两类视图:

1. 配置管理:按 profile 管理已配置的变量。
2. 最终结果:按 agent 查看最终解析后的所有变量。

默认进入配置管理。

### 配置管理视图

布局:

```text
Vars
├── top tabs: 配置管理 / 最终结果
├── left: Profiles
└── right: selected profile variable list
```

左侧 Profiles 列表展示配置范围,例如:

- Builtin
- Base
- Local
- Prod
- Work

右侧只展示当前选中 profile 中已配置的变量信息。不要把未配置的 base keys 默认混入列表。

### 最终结果视图

最终结果是只读视图,用于回答“当前 agent 下最终所有 vars 是什么”。

输入:

- agent: CC / CX / OC
- profile chain:第一版由系统固定,后续多 profile 时再提供链选择能力

输出:

- key
- type / format
- resolved value
- source profile / agent slot
- diagnostics
- trace 入口

最终结果视图不直接编辑变量。用户需要修改值时,从行操作跳转回对应 profile 的变量编辑弹窗。

## Profile 类型与操作

Profile 列表中 profile kind 使用英文短标签,并用弱语义颜色辅助识别:

| kind    | UI badge | 视觉语义                      |
| ------- | -------- | ----------------------------- |
| builtin | runtime  | 蓝色系,表示运行时来源         |
| base    | locked   | 灰色系,表示系统保留且不可删除 |
| local   | local    | emerald/绿色系,表示本机当前层 |
| custom  | custom   | 紫色或中性色,表示用户自定义   |

badge 只是元信息,不作为主要操作入口。Builtin、Base、Local、Prod 等 profile 名称仍按 profile label 展示。

### Builtin

Builtin 是系统运行时只读变量集合,不是用户可编辑 profile。

规则:

- 不允许新建、重命名、删除 Builtin。
- 不允许编辑 Builtin key 或 value。
- 列表展示 builtin keys、type/format、runtime value 摘要和只读标记。
- 详情弹窗只展示 metadata、runtime value、resolved trace 和 diagnostics。

### Base

Base 是用户变量 schema registry 和默认值来源。

规则:

- 不允许重命名或删除 Base profile。
- Base 内允许变量 CRUD。
- 新建用户变量只能在 Base 中发生。
- 删除或重命名 Base key 必须执行引用影响检查。
- Base 中的 key 定义 type、format、metadata 和默认 value。

### Local

Local 是本机专属配置范围,参与最高用户可配置优先级。

当前推荐:

- Local 作为保留 profile 展示。
- 允许编辑、添加、删除 Local 中的变量配置。
- 不在第一版允许重命名或删除 Local profile 本身。

原因:关联核心设计中 Local 是固定本机层。如果产品决定 Local 也要像普通 profile 一样可删除/重命名,需要同步调整 storage 与 resolver 语义,不能只在 UI 层处理。

### 自定义 Profiles

例如 Prod、Work。

规则:

- 支持新建、重命名、删除。
- 删除 profile 是破坏性操作,必须确认。
- 删除 profile 只删除该 profile 中已配置变量,不删除 Base key。
- 自定义 profile 中不能声明新 key,只能为 Base 已声明 key 添加配置。

## Profile 列表操作

左侧 Profiles 使用项目现有 UI 风格:

- 操作使用 Lucide 图标按钮,不使用大段文字按钮。
- 图标按钮遵循 docs/ui/components.md 的 IconButton 规范。
- 每个图标按钮必须有 accessible label 和 tooltip。
- Base 和 Builtin 的禁止操作显示为锁定状态,不展示可点击 edit/delete。
- 新建 profile 可以使用主动作按钮,文案为“新建 profile”或等效中文。

常见图标建议:

| 操作                | 图标语义        |
| ------------------- | --------------- |
| 新建                | plus            |
| 重命名/编辑 profile | pencil          |
| 删除 profile        | trash           |
| 锁定                | lock            |
| 更多操作            | more-horizontal |

具体图标以项目当前 Lucide 使用集合为准。

## 变量列表

右侧列表显示当前 profile 中“已配置”的变量。

当前列表采用 4 列模型:

| 列         | 内容                                                     |
| ---------- | -------------------------------------------------------- |
| key        | key 名称,type / format 作为紧凑 badge 放在 key 旁边      |
| 当前值     | 当前 profile 中该 key 的 value 摘要;未配置项显示“未配置” |
| Agent 专属 | 只显示 CC / CX / OC 中已单独配置的 agent 槽位            |
| 操作       | 查看、编辑、删除、更多等图标按钮                         |

规则:

- type / format 不作为单独列,避免列表横向信息碎片化。
- `default` 槽位不在列表中展示。默认槽位是基础配置,不需要作为“已激活”状态反复出现。
- 如果没有 agent 专属配置,Agent 专属列显示弱化的 `—`。
- 不显示未配置 agent 的灰色 chip。完整槽位状态放到编辑弹窗或 trace 中查看。
- 表头与数据行必须使用同一列模型,避免标题挤在左侧而数据分散。

### Base 变量列表

Base 列表展示 Base 中定义的所有用户变量。

行信息:

- key + type / format
- value 摘要
- agent 专属配置状态
- diagnostics
- 行操作

Base 中允许:

- 新建 key
- 编辑 key metadata 与 value
- 删除 key
- 重命名 key
- 添加或编辑 agent 专属配置

### Builtin 变量列表

Builtin 列表展示 builtin runtime keys。

行信息:

- key + type / format
- runtime value 摘要
- readonly 状态
- diagnostics

Builtin 行操作只允许查看详情。

### Local / 自定义 Profile 变量列表

默认只展示该 profile 已配置的变量。

如果某个 Base key 在当前 profile 没有配置,默认不显示该 key,也不显示“继承 base default”之类的伪值。

允许通过显式入口查看可配置项:

- 显示可配置项
- Show available from Base

打开后,列表可以展示 Base 中已声明但当前 profile 尚未配置的 key。这些行必须以弱化样式显示,状态为“未配置”或“可配置”,不能展示成当前 profile 已有值。

## 新增变量与新增配置

文案不使用 override。

原因:用户是在某个 profile 中新增一条配置,实现上虽然是覆盖层 value,但 UI 不需要暴露 resolver 术语。

### Base 中新增

Base 中的主操作为“新建变量”。

行为:

- 用户输入 key。
- 用户选择 type 和 string format。
- 用户填写默认 value。
- 保存后写入 Base。

### Local / 自定义 Profile 中新增

Local / 自定义 profile 中的主操作为“新建配置”或“添加配置”。

行为:

- 用户从 Base 已声明 key 中选择一个 key。
- key 的 type/format 从 Base 自动带出,不可在当前 profile 中改类型。
- 用户选择写入槽位:
  - profile default 槽位
  - 当前 agent 槽位,例如 CC / CX / OC
- 用户填写 value。
- 保存后写入当前 profile。

Base key 选择控件:

- 不使用原生 select 作为主交互。
- 使用可搜索、可滚动的 picker / combobox。
- 输入区支持按 key、format、描述过滤。
- 结果区固定最大高度,内部滚动,避免 Base key 多时撑高弹窗。
- 每个选项展示 key、简短描述、type / format badge。
- 选中项以项目现有选中态表达,不依赖浏览器原生下拉样式。

禁止:

- 在非 Base profile 中手写未知 key 并保存。
- 在非 Base profile 中修改 key 的 type/format。

## 编辑弹窗

编辑变量和新增配置都使用居中大弹窗,不使用右侧详情栏作为第一版主交互。

弹窗遵循 docs/ui/components.md 的 Modal 规范:

- 全屏遮罩。
- 居中卡片。
- background 使用 var(--popover)。
- 圆角使用 var(--radius-card)。
- 阴影使用 popover 层级。
- Esc 与关闭按钮可关闭。
- 有未保存改动时关闭前确认。

### 弹窗尺寸

弹窗应是大编辑器弹窗,不是小确认框。

推荐:

- 桌面端最大宽度约 960px 到 1120px。
- 最大高度约 80vh 到 86vh。
- 弹窗 body 内部滚动。
- 多行文本编辑区和预览区各自内部滚动。

### 编辑弹窗内容

编辑弹窗 header:

- key
- 当前 profile
- 当前编辑槽位
- agent 切换: default / CC / CX / OC

编辑弹窗 body 建议两栏:

```text
left: editor / preview
right: metadata / trace / diagnostics
```

左栏:

- value editor
- 编辑 / 原始预览 / 解析预览切换
- string format 工具
- markdown preview
- JSON text 校验与格式化
- structured json editor

右栏:

- type / format
- profile
- file 或 semantic layer 来源
- trace
- diagnostics

多行 string 和 markdown 不撑高弹窗;编辑器区域内部滚动。

编辑与预览必须互斥展示:

- 选择“编辑”时,左栏只显示 value editor,不在下方额外挂一块预览内容。
- 选择“原始预览”时,左栏显示当前编辑文本的 raw preview。
- 选择“解析预览”时,左栏显示经过 vars resolver 后的渲染结果或 markdown preview。
- 预览不是第二个独立编辑区,也不保存状态;它只是当前内容的查看模式。
- textarea 的 label 不应在 grid/flex 拉伸时产生大块空白,编辑器应占据主要可用高度。

第一版编辑器使用项目现有 textarea + preview 组合即可。按 `format` 预留编辑器能力扩展点,但本轮不要求 Monaco / VSCode 编辑内核。

### 新增配置弹窗内容

新增配置弹窗 header:

- 当前 profile
- 操作名称:新建配置

body:

- Base key 搜索 picker。
- type / format 只读摘要。
- 写入槽位选择:
  - profile default 槽位
  - CC
  - CX
  - OC
- value editor。
- diagnostics。

按钮文案:

- 取消
- 保存

不要使用“创建 override”、“保存 override”等文案。

## 文案规则

UI 不使用“继承”作为核心概念。

原因:未配置值只是没有单独写配置,并不表示存在一条显式继承配置。

推荐文案:

| 场景                | 使用                | 避免              |
| ------------------- | ------------------- | ----------------- |
| 当前 profile 没有值 | 未配置              | 继承 base default |
| 添加 profile 配置   | 新建配置 / 添加配置 | 创建 override     |
| 保存 profile 配置   | 保存                | 保存 override     |
| 删除 profile 配置   | 删除配置 / 清除配置 | 恢复继承          |
| 查看最终值          | 解析结果 / 最终值   | 继承值            |

列表与编辑器中不要把上游值当作当前 profile 的 value 显示。需要说明最终值来自哪里时,放在最终结果视图或 trace 中。

## Trace 与最终值

Trace 是诊断与解释工具,不是编辑模型。

规则:

- Trace 可以展示哪些 profile/agent slot 有显式配置。
- Trace 可以展示最终 source。
- 默认 trace 不展示未配置的 profile/agent slot,避免噪音。
- 如果未来需要完整矩阵,应通过显式“显示全部”入口展开,不能默认塞入主 trace。
- Trace 不使用“恢复继承”操作。
- 删除当前 profile 配置后,该 slot 从 trace 的显式配置中移除。

## Agent 切换

Agent 切换使用项目现有 Agent toggle 风格:

- CC
- CX
- OC

在变量列表中,agent 状态使用紧凑 chip 或图标状态展示。具体值编辑发生在弹窗中。

在编辑弹窗中,agent 切换用于选择当前编辑槽位:

- default:当前 profile 的默认配置。
- CC / CX / OC:当前 profile 下对应 agent 的专属配置。

如果所选槽位未配置,编辑区显示空值与“未配置”状态,不展示上游值。

## 视觉规范

实现必须读取并遵循项目 UI 规范:

- docs/ui/design-system.md
- docs/ui/components.md

具体约束:

- 使用 emerald 主色与现有 CSS tokens。
- 使用 Inter 作为 UI 字体。
- key、path、value 摘要使用 JetBrains Mono。
- 使用 Lucide 图标作为结构性操作图标,不使用 emoji。
- 图标按钮必须有 tooltip 与 accessible label。
- 交互控件有 visible focus state。
- 搜索输入的 focus 不使用强 emerald 边框;emerald 主要用于主动作、选中态和成功状态。搜索 focus 使用更弱的中性描边/阴影。
- 支持 light/dark。
- 支持 reduced motion。
- 主要列表与表单维持 dense technical dashboard 风格。

## API 与数据要求

UI 不直接依赖文件路径组织,但 API 需要提供语义对象:

- profile 列表。
- profile 是否锁定。
- profile 是否可重命名。
- profile 是否可删除。
- profile 中已配置变量列表。
- Base registry key 列表,用于非 Base profile 的“新建配置”搜索 picker。
- 单个 key 在某 profile / agent slot 下的配置详情。
- 单个 key 的 resolved preview、trace 和 diagnostics。

必要状态:

```ts
type VarsProfileKind = 'builtin' | 'base' | 'local' | 'custom'

type VarsProfileSummary = {
  id: string
  label: string
  kind: VarsProfileKind
  locked: boolean
  canRename: boolean
  canDelete: boolean
  configuredCount: number
}

type VarsConfiguredEntrySummary = {
  key: string
  type: string
  format?: string
  valuePreview: string
  configuredSlots: Array<'default' | 'claude-code' | 'codex' | 'opencode'>
  diagnostics: Array<{ severity: 'warning' | 'error'; message: string }>
}
```

列表 UI 渲染 `configuredSlots` 时:

- `default` 参与详情、trace 和保存语义。
- `default` 不在列表的“Agent 专属”列展示。
- `claude-code`、`codex`、`opencode` 才作为 Agent 专属 chip 展示。

具体路由在实现计划中确定。

## 待确认

### Local profile 是否允许重命名/删除

推荐第一版不允许重命名或删除 Local profile 本身,只允许编辑 Local 中的变量配置。

如果要让 Local 像 Prod/Work 一样完全 CRUD,需要先重新定义 local 在 storage 与 resolver 中的语义。

### 自定义 profile 第一版是否落地

UI 可按 profile 模型设计,但第一版实现是否包括 Prod / Work 等自定义 profile CRUD,需要和 core/storage 计划一起确认。

如果 core 第一版仍只有 base → local,UI 可以先只展示 Builtin、Base、Local,并预留自定义 profile 入口。

## 成功标准

- 用户能先选择 profile,再管理该 profile 中真实配置过的变量。
- 未配置项不会伪装成当前 profile 的 value。
- 变量列表使用 4 列模型,key 旁展示 type / format,表头和行数据列对齐。
- 列表中 default 不作为 Agent 专属状态展示,只展示实际 agent 专属槽位。
- 非 Base profile 新增配置时,用户从 Base registry 选择 key,不会手写错 key 或类型。
- Base key 选择器支持搜索和内部滚动,不会因为 key 多而撑高弹窗。
- 编辑和新增都在大弹窗中完成,多行内容不会撑爆布局。
- 编辑模式和预览模式互斥,不会同时显示 textarea 与额外预览块造成困惑。
- Builtin 和 Base 的锁定规则清楚可见。
- 操作文案使用“新建/保存/删除/清除”等用户任务语言,不暴露 override 术语。
- 图标、modal、agent toggle、字体和颜色遵循项目 UI 规范。
