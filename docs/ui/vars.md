# Vars 管理

Vars 页面从主导航的 `Variables` 入口进入，用于查看和编辑 agent-aware typed vars。解析、覆盖、secret 和 mutation 安全规则见 [Vars 规则](../rules/vars.md)。

## 页面结构

页面顶部提供两种视图：

- `配置管理`：左侧选择 profile，右侧显示当前 profile 的变量表格和编辑入口。
- `最终结果`：只读显示当前查看范围解析后的 key、最终值和来源。

当前 profile 固定为：

- `Builtin`：运行时内置变量，只读。
- `Base`：仓库同步的 key schema、默认值和 agent override。
- `Local`：当前机器的 default/agent override；可选择是否显示尚未配置的 Base keys。

页面记住每个 repo 最近选择的 profile；加载的 profile 不存在时回退到 `Base`。

## 查看范围

`default` 与 Settings 中已配置的 target agents 共享同一组查看范围 controls：

- `default` 使用 Base -> Local，不应用 agent override 或 builtin runtime。
- Agent 范围使用 Base -> Base/agent -> Local -> Local/agent -> Runtime。
- 初始 agent 取 Settings 中首个 target；没有 target 时回退到 Codex。
- 查看范围只改变表格、预览和 trace，不写入 targets，也不触发 projection。

Agent controls 使用品牌图标和完整 accessible name，不以 `CC/CX/OC` 文字缩写作为唯一识别信息。

## 编辑

变量支持 `string`、`number`、`boolean`、`secret`、`json` 五种类型。Base 可以新增定义；Base agent、Local 和 Local agent 只能覆盖 Base 已定义的 key。

编辑弹窗按当前 profile 和查看范围选择写入层，提供 raw/resolved preview、来源 trace、依赖和结构化 diagnostics。JSON 在保存前解析；无效输入保留在弹窗内并阻止保存。清除 override 只删除当前槽位，不删除 Base 定义。

`secret` 在列表、预览和 trace 中保持遮罩，编辑使用 password input。Secret 编辑框不会把遮罩占位符当作新值提交；当前页面不提供明文 reveal，对外响应仍受 [R-VARS-003](../rules/vars.md#r-vars-003-secret-默认遮罩并传递-taint) 约束。

## API

Vars API 位于 `/api/vars`，通过 `repoPath` 绑定授权仓库。页面读取 default 与每个 agent 的 matrix，并通过 base key、override 和 clear 操作更新数据；成功 mutation 后重新读取 matrix，不在客户端猜测最终覆盖结果。

## 状态与布局

- Loading、页面级错误、空表格和 mutation 错误使用稳定布局；页面加载失败提供重试。
- 搜索只过滤当前 profile，不改变配置或最终结果。
- 桌面端 profile rail 与数据区并列；窄屏改为自然文档流，表格在自身区域内处理横向溢出。
