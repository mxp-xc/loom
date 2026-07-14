# Skills、MCP 与 Memory 列表拖拽排序设计

## 目标

Skills、MCP 与 Memory 管理页面支持通过拖拽调整仓库共享的展示顺序。排序结果保存在对应领域数据中并参与 Git Sync，但不触发 projection，也不改变 targets、配置定义、active memory 或其他业务语义。

相关规则：[跨模块规则](../../rules/cross-cutting.md)、[Skills 规则](../../rules/skills.md)、[MCP 规则](../../rules/mcp.md) 和 [Memory 规则](../../rules/memory.md)。

## 范围

本轮纳入：

- Skills 页面顶层 source group 与整个 local group 的排序。
- MCP 页面 server row 的排序。
- Memory 页面 version row 的排序。
- 指针、触摸和键盘排序。
- 乐观更新、失败回滚和仓库共享持久化。
- 删除 Vars route 内仅服务本地并发请求的读写队列，保留仓库授权和 Vars store 原子写入。

本轮不纳入：

- Source member 排序。
- Local group 内 local skill 排序。
- Vars 排序。
- 跨 group 移动、树形拖拽或多选拖拽。
- 搜索或筛选结果内排序。

## 数据归属

排序数据由对应仓库领域数据拥有，不使用单独的 UI preference 文件。Skills 与 MCP 直接使用各自领域文件；Memory 的非权威顺序字段放在现有 `config.yaml` 中。

`mcp.yaml` 本身是 server 数组。数组顺序就是 MCP 展示顺序，重排直接更新数组，不保存第二份 order。

Memory 实体继续由 `memories/*.md` 权威拥有。`config.yaml` 增加可选的 `memory_order`，只表达 memory name 的展示顺序，不保存内容、active 状态或实体备份。这样遵守 R-MEMORY-001 的“无独立 memory metadata 文件”约束，并让排序继续参与仓库同步。

`memory_order` 采用与 Skills `group_order` 相同的非权威归一化原则：按保存顺序去重、忽略不存在的 name，并按当前文件枚举顺序追加遗漏 name。字段缺失或 malformed 时回退为当前 memory 文件顺序；读取不自动改写，下一次成功 reorder 或 memory create/delete/rename mutation 写入规范化后的完整顺序。重命名时 order 中对应 name 同步替换，删除时移除，新增时追加到末尾。

`skills.yaml` 的 `sources` 与 `skills` 仍是实体的权威数据。新增可选的 `group_order` 只表达顶层 group 顺序：

```yaml
sources:
  - url: https://github.com/example/a
    ref: main
  - url: https://github.com/example/b
    ref: main

skills:
  - id: local-a

group_order:
  - source:https://github.com/example/b
  - local
  - source:https://github.com/example/a
```

Source group 使用 `source:<url>` 作为稳定 id。修改 source `ref` 不改变其排序身份。`local` 表示整个 local group；只有存在至少一个 local skill 时，该 group 才参与运行时顺序。

`group_order` 不能创建、删除或隐藏任何 source/local skill。删除实体只能通过现有 Skills mutation 完成；排序数据不是实体备份。

## Skills 顺序归一化

读取 Skills 时以 `sources` 和 `skills` 计算当前已知 groups，再对 `group_order` 做纯函数归一化：

1. 按保存顺序读取 group id，重复 id 只保留第一次。
2. 忽略当前不存在的 source id。
3. 没有 local skill 时忽略 `local`。
4. 按 `sources` 原始顺序追加 `group_order` 遗漏的 source。
5. 存在 local skill 且 `local` 被遗漏时，将其追加到末尾。
6. `group_order` 缺失或不是字符串数组时，将其视为空数组，回退为 sources 原始顺序加末尾 local group。

例如 `sources` 为 `[A, C]`、存在 local skill，而保存顺序为 `[B, A, A]` 时，运行时顺序是 `[A, C, local]`。未知的 B 被忽略，A 被去重，遗漏的 C 与 local 被追加。

读取过程不自动改写文件，避免仅打开页面就产生 Git diff。下一次成功的 group reorder 或相关 Skills mutation 写入完整的规范化 `group_order`，清理手动编辑或旧版本留下的脏引用。

新增、删除、更新 source 以及新增或删除 local skill 的 application path 都使用同一个归一化函数。Source 实体出现重复 URL 等导致排序身份不唯一的结构错误时，reorder 必须失败并保留原文件，不能猜测用户意图。

## 服务端接口

排序进入现有领域 application，不新增通用 UI order 模块：

- `PUT /api/skills/order`
- `PUT /api/mcp/order`
- `PUT /api/memory/order`

Skills 请求：

```ts
interface ReorderSkillGroupsRequest {
  repo: string
  ids: string[]
}
```

MCP 请求：

```ts
interface ReorderMcpServersRequest {
  repo: string
  ids: string[]
}
```

Memory 请求：

```ts
interface ReorderMemoriesRequest {
  repo: string
  names: string[]
}
```

Route 负责 request schema、仓库授权、HTTP status 和响应格式。各领域 application 负责重新读取当前实体、规范化请求顺序并写回各自数据。Memory reorder 只更新 `config.yaml.memory_order`，不重写 markdown 文件。

服务端不能把客户端 ids 当作实体全集。写入顺序为“请求中仍存在的 id，按请求顺序去重”加“服务端当前存在但请求遗漏的 id，按当前领域顺序追加”。这样 stale 页面不会写入已不存在的引用，也不会遗漏服务端读取时已经存在的实体。请求中的未知 id 被忽略；当前领域数据本身存在重复 identity 时返回 `409`，领域 YAML 或实体结构无法解析时返回 `422`。

Reorder API 返回服务端归一化后的最终 ids 或 names。顺序没有变化时返回成功但不写文件，避免无意义 Git diff。写入失败保留原文件，并在错误节点记录完整错误对象和仓库、scope 等排障上下文。

Loom 定位为本地个人工具，不为 reorder 或其他普通 mutation 新增进程内队列、repository mutex 或 filesystem lock。两个页面、两个进程或 Git Sync 与 mutation 极端并发时采用 last-write-wins；前端只防止当前列表在一次保存完成前再次 reorder，不承诺跨页面并发协调。

单个 YAML 文件通过同目录临时文件写入并原子 replace，避免进程中断留下半份内容。Memory create/delete/rename 同时更新 markdown、`active_memory` 或 `memory_order` 时记录原始状态；后续步骤失败则按逆序恢复已完成步骤，回滚失败记录原始错误与完整 rollback error，不能静默留下部分成功状态。

排序只保存 desired repository data，不自动运行 Skills 或 MCP projection。MCP array 顺序可以影响未来 projection 输出的条目顺序，但不改变投影集合或 target 语义。

## 组件选型

使用稳定版 `@dnd-kit/core` 与 `@dnd-kit/sortable`。当前项目使用 React 18；该组合提供 sortable preset、Mouse/Touch/Keyboard sensors、禁用状态、`DragOverlay` 和无障碍 announcements，并允许页面保留现有 DOM 与 CSS Modules。

不使用 `react-dnd`，因为它提供通用 drag/drop primitives，不提供完整 sortable 行为，键盘排序和无障碍反馈需要自行实现。`@hello-pangea/dnd` 适合标准列表并内置较完整的交互，但本项目需要在现有 card/table 结构中保持更细粒度的样式与状态控制，`dnd-kit` 的 headless sortable 边界更合适。

前端新增一个薄的共享 sortable primitive，只封装 sensors、垂直排序策略、overlay、整行 activator、交互子元素排除和 disabled 状态。页面继续拥有 row/card 渲染、业务 id、保存调用和错误反馈。

## 页面交互

每个可排序项不显示独立 drag handle。桌面端在整行任意非交互区域按下并移动至少 6px 后开始拖拽；触屏端长按约 180ms 后开始拖拽，并允许不超过 8px 的自然位移。button、link、input、checkbox 等交互子元素不触发拖拽，短按和普通点击保持原行为。Skills header、MCP row 与 Memory row 本身可聚焦并承担键盘排序，不增加视觉隐藏或可见的独立 drag handle。

Skills 只允许从 source/local group header 的非交互区域开始拖动。展开后的 member 区域完全不绑定 activator；拖动 group 不改变其展开状态，展开状态继续按稳定 group id 保存。

MCP 允许拖动每个 server row。重排后 selected server 继续按 server id 保持；selected 与普通 row 使用相同背景，仅通过边框和侧边 marker 表达选中。搜索词非空或 transport filter 不是 `all` 时，pointer、touch 和 keyboard 排序全部禁用，清空搜索并恢复 `all` 后重新启用。MCP inventory 是滚动容器，拖动时使用 `DragOverlay`，防止 active row 被容器裁切。

Memory 允许拖动左侧 version row。active dot、重命名和删除按钮不触发拖拽；重排后 selected memory、active memory 和编辑器草稿继续按 memory name 保持。Memory inventory 使用 `DragOverlay`，防止 active row 被滚动容器裁切。

Mouse sensor 使用 6px 移动距离阈值；Touch sensor 使用约 180ms 延迟和 8px 容差，避免点击 row action 或滚动列表时误触。可排序 header/row 带“调整 `<name>` 顺序”的可访问名称和 sortable roledescription。Keyboard sensor 使用 `sortableKeyboardCoordinates`：Space 拾取、方向键移动、Space 或 Enter 放下、Escape 取消，并提供中文 screen reader announcements。

页面不增加排序模式、保存按钮或操作说明文案。拖动开始后，active item 使用 lifted overlay，其他项目通过 sortable transform 平滑让位，并显示当前 insertion position；`prefers-reduced-motion` 下关闭位移动画但保留排序功能。空列表和单项列表禁用排序且不发 reorder 请求。

## 前端数据流

`onDragEnd` 在 source 与 destination 不同时用 `arrayMove` 计算新顺序。页面立即乐观更新并锁定当前列表，然后调用领域 reorder API。

成功后直接采用 API 返回的规范化顺序，不显示成功 toast，也不通过全量 refresh 重建 MCP 或 Memory 编辑器。失败时记录完整错误对象，恢复 drag 前快照，只重新读取对应列表顺序以对齐服务端状态，并显示错误 toast；当前 selection 和未保存 draft 继续按稳定 id/name 保持。拖拽取消、无 destination、位置未变化、组件卸载或 disabled 状态下不发请求。

保存期间不接受第二次拖拽，避免同一页面产生乱序 reorder 请求。服务端响应中的规范化 ids 或 names 是最终顺序；后续正常数据刷新仍以领域文件为准。

## Vars 路由简化

删除 `packages/server/src/api/routes/vars.ts` 内的 `repoAccessLocks`、reader/writer queue 和测试用 lock 状态导出。保留轻量的 `withRepoAccess` 授权包装以减少 route churn，但其 mode 参数不再控制调度；Route 解析并授权 repo 后直接调用 `VarsApplication`。

这项简化只移除同一进程内 Vars 请求的串行化和 writer priority，不改变 request schema、授权边界、错误响应、变量解析或 mutation 语义。`VarsStore.writeMany` 的临时文件替换、失败回滚、cleanup 和完整错误日志继续保留；极端并发 Vars mutation 与其他领域一致采用 last-write-wins。

## 错误与脏数据

- `group_order` 中未知、重复或遗漏 id 通过归一化容错，不影响实体可见性。
- `memory_order` 中未知、重复或遗漏 name 通过归一化容错，不影响 markdown 文件可见性、active memory 或内容。
- 完全 malformed 的 `group_order` 回退为领域原始顺序，不阻断 Skills 页面读取。
- 用户手动编辑导致的轻微脏 order 在下一次相关成功写入时清理，不在 read path 自动改文件。
- 实体文件本身出现重复 source URL、重复 MCP id 或无法解析时，reorder 明确失败，不覆盖原文件。
- 如果实体被错误 mutation 删除，残留 order 只能被忽略，不能恢复实体；实体恢复依赖 Git/Sync。
- 所有 catch、写入失败和失败后的刷新失败都记录完整错误对象，不只记录 `err.message`。

## 规则与文档

`docs/rules/skills.md` 增加 Skills group 顺序、非权威 `group_order` 和归一化契约。`docs/rules/mcp.md` 增加 MCP server 数组顺序是仓库共享展示顺序、reorder 不触发 projection 的契约。`docs/rules/memory.md` 增加非权威 `config.memory_order`、create/delete/rename 归一化和 reorder 不改变 active memory 的契约。

Skills、MCP 与 Memory UI 规范补充 activator scope、筛选禁用、键盘操作、保存中锁定和失败回滚。规则只描述产品契约与安全边界，不复制实现调用链。

## 测试与验证

Core 测试覆盖 Skills group order 和 Memory order 的缺失、未知、重复、遗漏、malformed 输入，以及 MCP reorder 的无变化、部分 ids、未知 ids 与重复 identity。

Server application 和 route 测试覆盖授权、schema 校验、领域写入、stale 请求归一化、无变化时不写文件、重复实体 identity 返回 `409`、malformed 领域数据返回 `422`、写入失败保留原文件，以及 reorder 不触发 projection。

删除 Vars route 中验证同仓库 mutation 串行、read 等待 rename、writer priority 和 lock 状态清理的实现型测试。保留 Vars 授权、API 行为、mutation 结果、`VarsStore.writeMany` 原子替换和失败回滚测试。

Web 测试覆盖 activator scope、交互子元素排除、Skills member 区域不触发、Skills 展开状态保持、MCP selected server 保持、Memory selected/active/editor draft 状态保持、筛选时禁用、拖到列表末尾、乐观更新、采用成功响应中的规范化顺序、保存中锁定，以及失败回滚与列表重载。

实现后运行相关 Vitest 和全量 `bun run test`。启动 `bun dev` 后使用带名称 session 的 `playwright-cli`，在桌面与移动 viewport 自动验证指针拖拽、键盘排序、触摸等价路径、滚动容器 overlay、实际请求、持久化后的刷新顺序及 console error。

## 验收标准

- Skills 顶层 source/local groups 可通过整行非交互区域排序并写入 `skills.yaml.group_order`。
- Source member 和 local skill 不支持排序。
- MCP server 可排序，结果直接体现在 `mcp.yaml` 数组顺序中。
- Memory version 可排序，结果写入非权威 `config.yaml.memory_order`，不改变 markdown、selected 或 active memory。
- MCP 搜索或非 `all` filter 生效时不能拖拽。
- 排序支持指针、触摸和键盘，screen reader 能收到中文状态反馈。
- 成功不显示冗余 toast；失败回滚、刷新并显示错误。
- 脏 `group_order` 不会创建、隐藏或删除实体，并在下一次相关写入时规范化。
- 排序不修改 targets，不自动 projection，不影响当前选择或 Skills 展开状态。
- 普通 mutation 不新增并发锁；极端跨页面或跨进程并发采用 last-write-wins。
- Vars route 不再维护进程内读写队列，仓库授权与 Vars store 原子写入保持不变。
