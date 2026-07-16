# Memory 规则

这些规则定义 Memory 文件、Target 映射、预览和 projection 的产品契约。

## R-MEMORY-001 Memory 由文件与 Target 映射表达

Status: active
Applies to: memory manifest, memory API

Rule:
Memory 列表来自仓库内 `memories/*.md` 文件。`config.memory_targets` 以 Target 为键、Memory name 为值表达 desired state；一个 Memory 可被多个 Target 引用，一个 Target 同时只能引用一个 Memory。Memory name 即文件名派生出的业务 id，不存在独立元数据文件。新建和重命名使用跨平台可移植名称：1 至 252 个 ASCII 字符，只允许字母、数字、`.`、`_`、`-`，且名称首段不得是不区分大小写的 Windows 保留设备名 `CON`、`PRN`、`AUX`、`NUL`、`COM1` 至 `COM9`、`LPT1` 至 `LPT9`；设备名带扩展时仍视为保留名。

Implications:

- 没有 `memories/` 目录时，Memory 列表为空。
- `memory_targets` 指向不存在的 Memory 或未知 Target 时记录 manifest error，不产生有效映射。
- `memory_targets` 缺失时，`active_memory` 与 `config.targets` 共同提供兼容映射；写入新映射后使用 `memory_targets`。
- Legacy active API 在 `memory_targets` 已存在时仍须生效：设置 active 将所有 `config.targets` 指向该 Memory，清空 active 同时清空 Target 映射。
- 新建和重命名按不区分大小写的文件名检查冲突。
- 已存在但不符合新建规则的 `.md` 文件仍可被 manifest 发现；Loom 不自动重命名或删除。

Safety:

- Memory name 不能允许路径穿越、跨平台不稳定字符或保留文件名。
- Desired mapping 不能从 projection artifact 反向推断。

Tests:

- packages/core/test/memory-manifest.test.ts
- packages/server/test/api/memory.test.ts

## R-MEMORY-002 删除和重命名必须同步 Target 映射

Status: active
Applies to: memory API, memory UI

Rule:
删除 Memory 必须移除所有指向它的 `memory_targets` 条目；重命名 Memory 必须把所有指向旧名称的条目更新为新名称。

Implications:

- 删除未分配的 Memory 不改变其他映射。
- 删除已分配的 Memory 会释放对应 Target。
- 重命名不会改变 Memory 已占用的 Target 集合。
- 删除操作需要用户确认。

Safety:

- 不能留下指向已删除或已重命名文件的映射。
- 文件与 config 的组合 mutation 失败时必须回滚已完成步骤并记录完整错误。

Tests:

- packages/server/test/api/memory.test.ts
- packages/web/test/views.test.tsx

## R-MEMORY-003 Memory projection 按 Target 选择内容并按 agent 渲染

Status: active
Applies to: memory projection, projection executor

Rule:
Projection 对每个已配置且已安装的 Target 读取 `memory_targets` 指定的 Memory，使用该 Target 的 agent-aware vars 渲染内容，再写入对应 agent 的原生 Memory 文件。没有映射的 Target 不执行 Memory 写入。

Implications:

- `scope=memory` 只执行 Memory projection。
- `scope=skills` 不写 Memory 文件。
- 同一 Memory 可在一次 projection 中为多个 Target 分别渲染。
- 不同 Memory 可分别投影到不同 Target。
- 修改 Target 映射后立即运行 Memory projection。

Safety:

- 任一 Target 渲染失败时，本次 Memory projection 不能写入部分目标结果。
- 映射保存成功但 projection 失败时，不能报告整体成功。
- 写入后发生失败时，应通过 undo 恢复已写入目标。
- 取消映射不能删除无法证明由 Loom 管理的 agent 原生 Memory 文件。

Tests:

- packages/core/test/projection-memory.test.ts
- packages/server/test/projection/executor-memory.test.ts
- packages/server/test/projection/undo-memory.test.ts
- packages/web/test/views.test.tsx

## R-MEMORY-004 Memory preview 使用结构化 vars 诊断

Status: active
Applies to: memory editor, memory preview

Rule:
Memory preview 应按选定 agent 使用 agent-aware vars 渲染当前草稿。渲染失败时展示结构化 resolver diagnostics，并清除当前草稿对应的旧 preview 结果。

Implications:

- Preview 诊断包含 key、reference、path 等上下文。
- 当前草稿解析失败时，UI 不继续展示上一版成功渲染结果。
- Preview 与 projection 使用一致的渲染语义。

Safety:

- 不用 stale preview 掩盖当前草稿的解析错误。
- 不在诊断中泄露 secret 明文。

Tests:

- packages/web/test/memory-editor.test.tsx
- packages/server/test/api/memory.test.ts

## R-MEMORY-005 Memory 顺序是非权威仓库展示状态

Status: active
Applies to: memory manifest, memory API, memory UI

Rule:
`config.memory_order` 非权威地表达 `memories/*.md` 的仓库共享展示顺序。Memory 文件仍是实体权威来源，顺序字段不保存内容或 Target 映射。

Implications:

- 读取时去重、忽略不存在的 name，并按当前文件顺序追加遗漏 name。
- Create 将新 name 追加到末尾，delete 移除，rename 在原位置替换。
- 字段缺失或 malformed 时回退为当前文件顺序；读取不自动改写。

Safety:

- `memory_order` 不能创建、删除、隐藏或恢复 Markdown 文件。
- Reorder 不修改 Markdown、selected Memory、Target 映射或 projection。
- 同时修改文件与 config 的 mutation 失败时必须回滚已完成步骤并记录完整错误。

Tests:

- packages/core/test/memory-manifest.test.ts
- packages/server/test/api/memory.test.ts
- packages/web/test/views.test.tsx
