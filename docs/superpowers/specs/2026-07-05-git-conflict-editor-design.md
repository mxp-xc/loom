# Git 冲突编辑器设计

## 目标

同步以 Git 的三方文本合并结果为入口。Git 能自动合并时 Loom 不展示冲突；Git 产生冲突时，Loom 提供接近 IntelliJ IDEA 系列产品的三栏 Merge Viewer。编辑器使用 BASE、LOCAL、REMOTE 对 Git 的粗粒度 conflict blocks 再做一次通用 diff3 细化，自动合入双方互不重叠的文本修改，只把真正重叠的 change blocks 留给用户处理。该过程不按 YAML 字段推断业务语义。

## 同步流程

1. 拉取前沿用现有策略保存工作区改动，然后执行 `git fetch`。
2. 使用原生 Git merge 合并 `FETCH_HEAD`。
3. 合并成功时完成 merge commit，并返回无冲突结果。
4. 合并失败时保留 Git merge 状态，从 index stages 读取每个冲突文件的 BASE、LOCAL、REMOTE，并读取带 conflict markers 的工作区结果。
5. 对文本文件执行通用 diff3 细化。互不重叠的 LOCAL / REMOTE change blocks 自动进入 RESULT，重叠修改保留为待解决 change blocks。Git 仍将该文件视为 unmerged，直到用户保存。
6. 用户保存某个结果后，服务端写入文件并执行 `git add`。所有 unmerged paths 消失后创建 merge commit。
7. 用户放弃时执行 `git merge --abort`，恢复本次拉取前状态。

删除、重命名、modify/delete 等冲突同样以 Git index 状态为准，不另建 YAML 专用规则。

## API 契约

拉取响应包含合并状态和冲突文件：

- `clean`: 是否已自动合并完成。
- `conflicts`: 冲突文件列表；每项包含 `path`、`base`、`ours`、`theirs`、`result`。
- `result` 是 Git 写入工作区的待解决文本，可能含标准 conflict markers。

保存接口按文件接收完整 `result`。服务端只允许保存当前 Git unmerged paths，写入后执行 `git add`，并返回剩余冲突文件。全部解决后完成 merge commit。

放弃接口仅在存在 merge 状态时执行 `git merge --abort`。错误分支记录完整错误对象和堆栈。

## 前端交互

冲突区按文件展示。桌面端使用 LOCAL / RESULT / REMOTE 三栏 Merge Viewer，包括行号、同步滚动、差异高亮和折叠未修改区域。RESULT 始终表示将写回文件的实际内容，不以 conflict marker 文本充当主要交互模型。

交互遵循 IntelliJ IDEA 系列 Merge Viewer：

- BASE→LOCAL、BASE→REMOTE 的全部 change blocks 使用 `@codemirror/merge` 的 `Chunk.build()` 计算；`node-diff3` 继续负责区分重叠冲突和可自动合并区域，不另写 diff 算法。
- 双方互不重叠、已自动进入 RESULT 的 change blocks 使用淡绿色背景与边线；双方重叠、仍需人工决定的 change blocks 使用淡红色背景与边线。
- LOCAL 和 REMOTE 的每个红色 change block 各自显示一个指向 RESULT 的“应用”按钮和一个“×”按钮。操作组锚定在该 change block 最后一行代码的右侧，不占用首行左侧空间。
- 点击“应用”把该侧 change block 应用到 RESULT；点击“×”明确忽略该侧 change block。
- 两侧互不冲突的 change blocks 默认自动进入 RESULT，不要求用户逐块确认。例如 LOCAL 修改 `targets`、REMOTE 新增 `proxy` 时，`proxy` 自动进入 RESULT，只留下 `targets` 的重叠修改等待处理。
- 同一重叠区域可以分别应用或忽略两侧 change block；界面不提供含义模糊的“接受两者”按钮。
- 用户可直接编辑 RESULT，手动编辑与 change block 操作使用同一份编辑器状态。
- 提供上一个/下一个待处理 change block 及剩余数量。
- 尚有未处理 change blocks 或 RESULT 仍含 conflict markers 时禁止保存并说明原因。
- 保存后进入下一个文件；所有文件保存后完成合并。

文件头提供三个整文件快捷操作：

- “保留两者”重置为 IDEA 式自动合并结果，同时应用 LOCAL 和 REMOTE 的全部绿色 change blocks，所有红色 change blocks 恢复为待处理；不会拼接或自动接受红色区域。
- “保留本地”使用完整 LOCAL 内容作为 RESULT，并将当前文件标记为已解决。
- “保留远程”使用完整 REMOTE 内容作为 RESULT，并将当前文件标记为已解决。

移动端不强行维持三栏，窄屏以 LOCAL / RESULT / REMOTE 标签页切换；change block 的“应用”和“×”操作保持一致。

原来的字段冲突卡片和 `String(object)` 展示路径整体删除，因此不再出现 `[object Object]`。

## 前端状态模型

前端根据 API 返回的 BASE、LOCAL、REMOTE 构造每个文件独立的 merge model：

- `result`: 已自动合入稳定 change blocks 的当前文本。
- `blocks`: 尚需决定的重叠 change blocks；每项保存稳定 id、左右文本、在三侧编辑器中的范围，以及 LOCAL / REMOTE 各自的 `pending`、`applied` 或 `ignored` 状态。
- `changes`: BASE→LOCAL、BASE→REMOTE 的完整 change ranges；每项包含起止位置及 `stable`（绿色）或 `conflict`（红色）分类，只负责展示和操作锚点。

“应用”和“×”只通过 CodeMirror transaction 修改对应 block 及其状态。transaction 的位置映射负责在用户手动编辑后保持其他 block 的锚点有效；无法安全映射的 block 保持待处理并要求用户手动完成，不猜测位置。文件切换时保留各自的 merge model，放弃整个 merge 时一并清空。

待处理数量属于前端交互状态，不扩展 Git 的冲突语义。服务端仍接收最终完整文本，并保留 conflict marker 检查作为安全兜底。

## 依赖与边界

- Git 决定文件是否进入冲突流程，并维护标准 merge 状态；Loom 的通用 diff3 细化只缩小文本 change blocks，不会在 Git 未报告冲突时制造冲突。
- 前端采用官方 `@codemirror/merge` 及必要的 CodeMirror 6 核心包，不自行实现编辑器、行对齐或差异展示。
- three-way merge 细化使用成熟第三方 diff3 包（优先评估 `node-diff3`），不自行实现 diff 或 merge 算法。依赖必须支持 BASE、LOCAL、REMOTE 输入，并能区分稳定合并区和重叠冲突区。
- Loom 只负责把 Git index stages 转成 API 数据，并把用户编辑结果写回标准 Git merge 流程。
- YAML 语法高亮可使用 CodeMirror 官方 YAML language package；语法有效性不影响 Git 冲突是否解决。

## 测试

- Git 可自动合并的相邻和分离修改不会出现在冲突列表。
- Git 对同一文本区域的修改返回真实冲突及 BASE、LOCAL、REMOTE、RESULT。
- Git 粗粒度冲突中互不重叠的 change blocks 会自动进入 RESULT，只保留真正重叠区域。
- `config.yaml` 示例中 REMOTE 的 `proxy` 自动进入 RESULT，LOCAL / REMOTE 对 `targets` 的修改仍待处理。
- LOCAL、REMOTE 的非冲突 change blocks 整段显示绿色背景；冲突 change blocks 整段显示红色背景。
- 红色 change block 的操作组显示在最后一行代码右侧。
- “保留两者”恢复自动合并结果并只留下红色块待处理；“保留本地”和“保留远程”分别替换整份 RESULT。
- 每侧 change block 的“应用”只修改对应 RESULT 区域，“×”只改变该侧 block 的处理状态。
- 手动编辑 RESULT 后，后续 block 操作不会覆盖无关编辑。
- 保存仍含 conflict markers 的结果被拒绝。
- 保存全部冲突文件后产生双亲 merge commit。
- 放弃合并恢复拉取前 HEAD 和工作区。
- 前端渲染三栏 Merge Viewer、编辑 RESULT、保存并推进剩余冲突。
- 页面不再渲染 `[object Object]`。

## 非目标

- 不实现 YAML 字段级或 member 集合级自动合并。
- 不实现自定义 diff 或 three-way merge 算法。
- 不处理二进制冲突的在线编辑；二进制文件仅允许整文件选择 LOCAL 或 REMOTE。
