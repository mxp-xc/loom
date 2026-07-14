# Memory 预览、可移植命名与复制设计

## 目标

修复 Memory 所见视图在合法 Markdown 尖括号链接后截断的问题，允许跨平台可移植的点号名称，并提供复制原始 Markdown 的入口。

相关规则：[Memory 规则](../../rules/memory.md)、[跨模块规则](../../rules/cross-cutting.md)。

## 命名规则

Memory name 继续作为 `memories/<name>.md` 的业务 id。名称必须匹配：

```regex
^[A-Za-z0-9._-]+$
```

同时拒绝名称首段中不区分大小写的 Windows 保留设备名：`CON`、`PRN`、`AUX`、`NUL`、`COM1` 至 `COM9`、`LPT1` 至 `LPT9`。设备名带扩展时仍然保留，因此 `CON.notes` 也必须拒绝。该规则允许 `.`，但继续排除路径分隔符、空格、Unicode 和跨平台语义不稳定的标点。

名称长度为 1 至 252 个 ASCII 字符，确保追加 `.md` 后不超过常见文件系统的 255-byte 文件名限制。新建和重命名按不区分大小写的名称检查冲突，避免 `Team` 与 `team` 在大小写敏感系统共存后无法同步到大小写不敏感系统。

创建、读取、写入、激活、删除和重命名使用同一校验规则。路径仍需保持在 `memories/` 直属目录内，不能仅依赖字符规则防止路径穿越。

已存在但不符合新建规则的 `.md` 文件仍由 manifest 发现；本次不自动迁移、改名或删除。

## 所见视图

所见视图是只读 Markdown 预览，不承担富文本编辑。它使用项目已有的标准 Markdown renderer，而不是 MDXEditor。标准 Markdown 的 `<...>` 链接目标必须完整渲染，不能被当作 MDX/JSX 并截断后续内容。

Loom 管理标记使用的 Markdown HTML 注释继续以可见文本展示。只对注释标记做转义，不改写其他 Markdown，也不改变保存内容。

## 复制

Memory 详情顶部提供带 tooltip 和 accessible name 的 `Copy` 图标按钮。按钮始终复制当前编辑状态中的原始 Markdown，包括尚未保存的源码修改；它不复制渲染后的 HTML，也不复制按 agent 解析后的内容。

复制成功显示“已复制”Toast。复制失败记录完整错误对象，并显示可恢复的错误 Toast；失败不会改变编辑内容或 dirty 状态。

## 测试

- Server API：覆盖 `.`、包含点号的名称、长度边界、Windows 保留名、大小写冲突和路径穿越；验证创建、读取、重命名、激活与删除使用一致规则。
- Web unit：含尖括号链接目标的内容在链接后仍完整显示，Markdown 注释仍可见；复制得到原始 Markdown并覆盖失败反馈。
- Browser：创建名为 `.` 的 Memory，写入复现内容并检查所见视图完整；验证复制按钮可用且内容正确。

## 非目标

- 不增加独立展示名称。
- 不允许空格、Unicode 或任意当前文件系统字符。
- 不改变变量解析预览与 projection 语义。
