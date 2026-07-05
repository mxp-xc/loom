# Vars 变量管理设计

## 目标

为 Loom 提供独立、可复用的 typed vars 基础设施。用户可管理多个彼此独立的环境，在业务模块中按有序环境链解析变量，并获得稳定的解析结果、来源信息和诊断。Vars 不绑定 Skills、MCP 或任何具体消费模块。

## 范围

首版包含：

- 环境与变量的 CRUD。
- `string`、`number`、`boolean`、`secret`、`json` 五种类型。
- 业务模块传入有序环境链进行多级覆盖。
- `string` 与 `secret` 中的变量引用、默认值、递归解析和循环检测。
- 引用依赖分析、删除影响检查和悬空引用警告。
- Vars 管理页面、JSON 智能编辑和解析预览。
- 兼容现有扁平 `vars/*.yaml`。

首版不包含：

- 系统环境变量的读取、枚举、补全或引用。
- JSON Schema。
- Secret 加密或独立安全存储；`secret` 只提供遮罩显示。
- 在 vars 环境文件中声明继承关系。
- Skills、MCP 等具体消费模块的接入改造。

## 核心语义

### 独立环境

每个环境对应 `vars/<environment>.yaml`，环境之间没有 parent，也不会互相改写。环境名由存储层校验，文件路径不得由未经校验的用户输入直接拼接。

继承链由消费模块保存并传给 resolver，例如：

```ts
;['base', 'local', 'prod']
```

后出现的环境覆盖先出现的环境，因此优先级为 `prod > local > base`。链必须非空、环境必须存在，同一环境不得重复出现。

### Key 规则

变量 key 使用以下规则：

```regex
^[A-Za-z_][A-Za-z0-9_.-]*$
```

例如 `api.base-url`、`feature_v2.enabled` 合法。key 在单个环境内唯一，不同环境可定义同名 key。

### Typed entry

每个环境使用显式类型存储：

```yaml
api.port:
  type: number
  value: 3000

api.url:
  type: string
  value: 'http://localhost:${api.port}'

feature.enabled:
  type: boolean
  value: true

service.config:
  type: json
  value:
    retries: 3

api.token:
  type: secret
  value: plaintext-for-now
```

类型约束：

- `string`：字符串，可包含引用。
- `secret`：底层仍为明文字符串，可包含引用；API 与 UI 默认遮罩。
- `number`：有限数值，不接受 `NaN` 或无穷值，只能保存字面值。
- `boolean`：布尔字面值。
- `json`：合法 JSON value，只能保存字面值，不支持引用。

## 引用与解析

### 语法

`string` 与 `secret` 支持：

- `${key}`：引用变量。
- `${key:default}`：变量不存在时使用字符串默认值。

引用 key 遵循相同命名规则。默认值是纯文本，不递归解析其中出现的 `${...}`。

### 算法

Resolver 是不依赖存储和具体业务模块的纯领域服务：

1. 校验环境链并按从左到右合并 typed entries。
2. 记录每个最终值来自哪个环境。
3. 对最终可见的 `string` 和 `secret` 建立引用依赖图。
4. 递归解析引用；引用查找只访问合并后的 vars。
5. 被引用值无论原类型为何，都转换为字符串后插入引用位置。
6. 返回 typed resolved values、来源、依赖图和 diagnostics。

引用使用合并后的最终可见值。例如 `base` 的 `url` 引用 `port`，而 `prod` 覆盖了 `port`，则解析 `['base', 'prod']` 时 `url` 使用 `prod.port`。

类型保持规则：变量自身声明类型保持不变。只有 `string` 或 `secret` 能包含引用，因此不存在 `${key}` 使 `number`、`boolean` 或 `json` 动态改变值的情况。

### 解析结果

```ts
interface VarsResolution {
  values: Record<string, TypedValue>
  sources: Record<string, string>
  dependencies: Record<string, string[]>
  diagnostics: VarsDiagnostic[]
}
```

`sources` 表示最终 entry 的来源环境；`dependencies` 表示解析后仍具有语义关系的直接引用，不展开为传递闭包。Resolver 遇到 error 时不返回可供业务消费的不完整 values；调用方必须先检查成功状态。

## 模块边界

### Storage

负责环境文件发现、读取、校验和原子写入，并提供环境及变量 CRUD。写入采用临时文件加原子替换，失败时保留原文件。Storage 不执行继承解析。

### Resolver

接收已加载的环境集合和有序 chain，返回解析结果。Resolver 不读取 process env、不访问文件系统，也不了解 Skills 或 MCP。

### Diagnostics

建立引用图并检测：

- 非法 key 或 typed entry。
- 不存在或重复的环境。
- 缺失引用。
- 循环引用及完整循环路径。
- 删除、重命名的直接与传递影响。

### API

对外提供三组稳定能力：

- `list/get/create/update/deleteEnvironment`
- `list/get/set/delete/renameVariable`
- `resolve(chain)`、`resolveKey(chain, key)`、`validate(chain?)`

HTTP 路由可按资源风格映射这些领域操作，但 Web UI 不直接依赖 YAML 文件结构。所有失败使用稳定错误码，并附带环境、key、引用链等结构化上下文。

删除变量采用两阶段行为：

1. `inspectDelete` 返回直接和传递依赖项。
2. 无依赖时直接删除；有依赖时必须携带确认标记再次请求。

确认删除后允许仓库暂时存在悬空引用，相关变量产生 warning；任何包含该悬空引用的解析链仍以 error 失败。

变量重命名是跨环境原子操作：先扫描所有环境中的直接引用，将旧 key 重写为新 key，再统一校验和落盘。任一文件校验或写入失败时，所有文件保持原状。重命名不得通过留下悬空引用来完成。

## 诊断与日志

诊断分级：

- `error`：非法 key/type、环境链非法、循环引用、普通新增或编辑产生缺失引用。阻止保存或解析。
- `warning`：用户确认删除后留下的悬空引用；旧格式尚未迁移。允许继续管理，但相关链不能成功解析。

已确认删除产生的 warning 会作为显式诊断状态保留。后续编辑只要没有新增或扩大悬空引用即可保存，避免一个 warning 锁死整个环境；修改对应引用或恢复缺失 key 后 warning 自动消失。

所有 catch、错误分支和降级路径记录完整错误对象及堆栈。日志不得只记录 `err.message`。API 文案可本地化，但调用方只依赖错误码和结构化字段。

## 管理页面

Vars 成为一级管理页面，采用三栏工作台：

1. 左栏显示独立环境列表、变量数量、新建环境和临时解析链预览。
2. 中栏显示当前环境变量，支持搜索、新建、类型摘要和诊断标记。
3. 右栏编辑 key、类型和值，并展示解析预览、引用项和被引用项。

交互要求：

- 输入 `${` 时，补全当前预览链中最终可见的 vars；候选项展示 key、类型、来源环境和解析值。
- Secret 的编辑值、列表摘要和解析预览默认遮罩；用户可临时切换可见性。
- String 编辑器提供引用高亮、补全、引用诊断和实时解析预览。
- JSON 编辑器提供语法高亮、括号与引号补全、格式化、折叠和实时语法校验，不提供 schema 驱动的字段补全。
- 删除被引用变量前展示影响列表并要求确认；确认后依赖项显示黄色 warning。
- 环境列表不展示继承关系；解析链只是预览输入，不写回 vars 文件。

## 兼容与迁移

Loader 继续识别现有扁平文件：

```yaml
browsers_path: ~/.cache/ms-playwright
```

旧值全部按 `string` 读取，不根据 YAML scalar 自动推断类型，以避免已有值因格式细节改变语义。旧环境在 UI 中显示待迁移 warning；首次修改该环境时，将整个文件原子转换为显式 typed entry。未编辑的旧文件保持原样，仍可参与解析。

迁移只改变 vars 文件表示，不改变环境名、key 或解析结果。

## 测试策略

### Core

- 五种类型的解析、序列化和非法值。
- key 边界与环境链校验。
- 多级覆盖、最终来源和同名 key。
- 字符串跨类型引用、默认值、递归引用、循环路径和缺失引用。
- 基础环境的字符串引用后续环境覆盖值。
- 引用图、重命名影响、删除影响和确认删除后的 warning。
- 旧格式读取与无语义变化迁移。

### Server

- 环境及变量 CRUD 的 API 契约和稳定错误码。
- 普通非法修改拒绝落盘。
- 两阶段删除和悬空引用状态。
- 原子写入失败保留原文件。
- 错误路径记录完整错误对象。

### Web

- 类型控件与各编辑器切换。
- `${` 补全的 key、类型、来源和解析值。
- Secret 遮罩与临时显示。
- JSON 格式化和语法错误。
- 删除影响确认与 warning 展示。

### 端到端

使用 Playwright 覆盖环境创建、五类变量编辑、解析链预览、引用补全、循环错误和确认删除流程。前端完成后必须自动运行验证，不把可自动验证的步骤交给用户。

## 成功标准

- 任意业务模块只需传入环境链，即可获得确定、可追踪的 typed vars 结果。
- 相同 vars 文件和 chain 在不同机器上得到相同结果。
- 用户能在一个页面完成环境和变量管理，并在保存前发现常规引用错误。
- 删除等破坏性操作提供影响分析，确认后仍能清晰定位悬空引用。
- 旧 vars 文件无需立即迁移即可继续使用。
