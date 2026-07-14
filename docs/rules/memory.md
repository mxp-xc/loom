# Memory 规则

这些规则定义 memory 文件、激活状态、预览和 projection 的产品契约。

## R-MEMORY-001 Memory 由 memories/*.md 与 active_memory 表达

Status: active
Applies to: memory manifest, memory API

Rule:
Memory 列表来自仓库内 `memories/*.md` 文件，激活项由 `config.active_memory` 指向。不存在独立的 memory 元数据文件；memory name 即文件名派生出的业务 id。新建和重命名使用跨平台可移植名称：1 至 252 个 ASCII 字符，只允许字母、数字、`.`、`_`、`-`，且名称首段不得是不区分大小写的 Windows 保留设备名 `CON`、`PRN`、`AUX`、`NUL`、`COM1` 至 `COM9`、`LPT1` 至 `LPT9`；设备名带扩展时仍视为保留名。

Implications:

- 没有 `memories/` 目录时，memory 列表为空且 active 为 `null`。
- `active_memory` 指向不存在的 memory 时，active 为 `null` 并记录 manifest error。
- 读取 active memory 时返回其原始 markdown 内容。
- `.` 是合法 memory name，对应文件 `memories/..md`。
- 新建和重命名按不区分大小写的文件名检查冲突，避免在大小写敏感系统创建无法同步到大小写不敏感系统的两个 memory。
- 已存在但不符合新建规则的 `.md` 文件仍可被 manifest 发现；Loom 不自动重命名或删除。

Safety:

- Memory name 不能允许路径穿越。
- Memory name 不能使用跨平台不稳定字符或保留文件名。
- 文件列表和 active 状态不能从 projection artifact 反向推断。

Examples:

- `memories/default.md` 存在且 `config.active_memory: default` 时，manifest 中 active 为 `default`，activeContent 为该文件内容。
- name `team.v2` 可创建为 `memories/team.v2.md`；name `CON`、`CON.notes` 和与既有 `Team` 冲突的 `team` 必须拒绝。

Tests:

- packages/core/test/memory-manifest.test.ts
- packages/core/test/memory-types.test.ts
- packages/server/test/api/memory.test.ts

## R-MEMORY-002 Memory 激活、删除和重命名必须同步 active_memory

Status: active
Applies to: memory API, memory UI

Rule:
Memory 激活状态通过 `config.active_memory` 管理。删除当前激活 memory 必须清空 `active_memory`；重命名当前激活 memory 必须把 `active_memory` 更新为新名称。

Implications:

- 设置 active 为某个 memory name 会写入 `config.active_memory`。
- 设置 active 为 `null` 会取消激活。
- 删除非激活 memory 不影响当前 active。
- UI 的 active 状态点是 memory 激活/取消激活入口。

Safety:

- 不能留下指向已删除或已重命名文件的 active state。
- 删除操作需要用户确认，不静默删除 memory 文件。

Examples:

- 当前 active 为 `v1`，重命名 `v1.md` 为 `team.md` 后，`active_memory` 也应变为 `team`。

Tests:

- packages/server/test/api/memory.test.ts
- packages/web/test/views.test.tsx

## R-MEMORY-003 Memory projection 使用全局 targets 并按 agent 渲染

Status: active
Applies to: memory projection, projection executor

Rule:
Memory 没有 per-memory targets。Projection 使用全局 `config.targets`，过滤为已安装 agent 后，对每个 target 用 agent-aware vars 渲染当前 active memory，再写入该 agent 的原生 memory 文件。

Implications:

- `scope=memory` 只执行 memory projection。
- `scope=skills` 不写 memory 文件。
- 没有 active memory 时，memory projection 跳过且不写任何 agent 文件。
- Memory 页面 target chips 编辑 repo-level Settings targets；保存成功后立即运行 memory projection。

Safety:

- 任一 agent 渲染失败时，本次 memory projection 不能写入部分目标结果。
- Target 更新成功但 projection 失败时，不能报告整体成功。
- 写入后发生失败时，应通过 undo 恢复已写入目标。

Examples:

- Active memory 引用了某个对 Codex 不可解析的 vars key 时，本次 projection 应失败并保持所有 agent memory 文件不变。

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

Examples:

- 草稿引用 `${memory.rtk}`，但当前 agent 的 vars 没有该 key 时，preview 显示 resolver diagnostic，旧的 rendered markdown 被清空。

Tests:

- packages/web/test/memory-editor.test.tsx
- packages/server/test/api/memory.test.ts
