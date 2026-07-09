# Monaco 编辑器统一设计

## 目标

Loom 的复杂文本编辑入口统一使用 Monaco。Memory 已接入的 Monaco 能力上升为公共编辑基座，并扩展到 Vars、Skills、MCP 和 Sync 冲突解决。迁移只改变编辑体验，不改变业务保存、解析、投影或同步语义。

相关规则：

- [R-CROSS-001](../../rules/cross-cutting.md)：UI 反映 desired state，而不是文件系统偶然状态。
- [R-VARS-001](../../rules/vars.md)：Vars 解析只读取 Vars。
- [R-VARS-003](../../rules/vars.md)：Secret 默认遮罩并传递 taint。
- [R-MEMORY-004](../../rules/memory.md)：Memory preview 使用结构化 vars 诊断。
- [R-SKILLS-005](../../rules/skills.md)：Source scan 使用 ref-aware SKILL.md pattern。

## 范围

本轮纳入以下产品编辑入口：

- Memory 源码编辑。
- Vars string 值编辑。
- Vars 配置值弹窗编辑。
- Vars JSON 值编辑，迁出 CodeMirror。
- 本地 SKILL.md 源码编辑。
- MCP env file 和 headers file 编辑。
- Sync 三栏冲突解决编辑器，迁出 CodeMirror。

本轮不纳入：

- Settings 的普通配置 input/select/chips。
- MCP args 单行输入。
- Skill source scan pattern。
- VarsProfileDemo 等 demo/prototype 页面。
- Memory 富文本编辑；它仍属于 MDXEditor 路线，不与源码编辑统一。

## 架构

新增公共 Monaco 基座组件，负责以下通用能力：

- Monaco 装载与销毁。
- 亮色/暗色主题同步。
- 通用编辑器 options。
- aria-label、readOnly、height、language、value、onChange。
- 可选 completion provider。
- 可选 formatter action。
- 可选 diagnostics/marker 显示。

普通编辑场景只包装公共基座，不重复写 Monaco 初始化。Sync 冲突解决是特殊三栏 UI，使用独立 MonacoConflictEditor，但复用公共 theme、language 和 options helper。

迁移完成后，前端产品代码不再依赖 CodeMirror。若源码无引用，应移除 @uiw/react-codemirror、codemirror 和 @codemirror/* 相关依赖。

## 特性映射

| 特性        | 目标入口                             | Monaco language             | 能力                                                    |
| ----------- | ------------------------------------ | --------------------------- | ------------------------------------------------------- |
| Memory 源码 | Memory source editor 包装公共基座    | markdown                    | ${var} 补全、word wrap、主题同步                        |
| Vars string | 非 secret string editor              | 按 format，默认 plaintext   | 多行编辑、${var} 补全                                   |
| Vars 配置值 | Vars modal value editor              | 按 type + format            | markdown/json/yaml/toml/shell/path/plain 自动切语言     |
| Vars JSON   | JSON value editor                    | json                        | 格式化、语法错误提示、disabled/readOnly                 |
| SKILL.md    | MarkdownPreview editable source mode | markdown                    | 预览/源码切换、保存、取消                               |
| MCP env     | RecordField file mode                | plaintext 或 env-like text  | KEY=value 多行、${var} 补全、key/value 模式互转         |
| MCP headers | RecordField file mode                | plaintext                   | Header-Name=value 多行、${var} 补全、key/value 模式互转 |
| Sync 冲突   | MonacoConflictEditor                 | 按文件扩展名推断，默认 yaml | LOCAL/REMOTE readOnly、RESULT editable、冲突块操作      |

Secret 值仍使用 password input，不迁入 Monaco，避免明文编辑体验误导用户。

## 变量补全

变量补全是可选 provider，不是公共编辑器默认行为。

- Memory：按当前 preview agent 加载可见 vars key，插入 ${key}。
- Vars：按当前 resolution 或 matrix 中可见 vars 提供候选，支持 vars 引用其它 vars。
- MCP env/headers：按当前 MCP server 选中 targets 的 agent-aware vars key 并集提供 ${key} 补全；没有选中 target 时，按 Settings targets 的首个 agent 视角兜底。MCP args 仍保持单行输入，但 projection 解析 args/env/headers 的业务语义不变。

补全候选必须遵守 secret 遮罩规则。候选、预览和错误信息不得泄露 secret 明文。补全加载失败时编辑器仍可输入，候选为空并记录完整错误对象。

## 数据流

普通编辑器的数据流保持为字符串：

    业务页面 state
    → MonacoTextEditor value
    → 用户编辑 / completion / format action
    → onChange(nextString)
    → 原页面 draft / dirty / preview / save 流程

Monaco diagnostics 只作为编辑辅助，不替代业务 validate。保存、预览、投影和同步仍由现有 core/server/API 规则决定。

各特性保存语义保持不变：

- Memory 仍通过 memory preview API 和 save API。
- Vars 仍通过现有 parse、validate、resolve 和 mutation API。
- SKILL.md 仍通过 api.saveSkillContent 并刷新 manifest。
- MCP env/headers 仍通过 parseRecordLines 和 MCP server modal submit。
- Sync 仍通过 conflict save API 提交最终 RESULT 文本。

## Sync 冲突编辑器

Sync 迁移必须保留现有冲突解决语义：

- LOCAL 和 REMOTE 是 readOnly model。
- RESULT 是 editable model。
- “应用”“忽略”“保留两者”“保留本地”“保留远程”只更新 merge model 和 RESULT model。
- 保存时从 RESULT model 读取最终文本。
- 未处理冲突数大于 0 时禁止保存。
- 二进制冲突继续走选择本地/远程文件，不进入文本编辑器。
- 窄屏继续使用 LOCAL / RESULT / REMOTE 单栏切换。

## 错误处理

- Monaco 装载失败时显示编辑区域错误状态，不静默空白。
- 异步错误记录完整对象，例如 console.error({ err }, "Failed to ...")。
- JSON 格式化失败时不修改当前 draft，显示语法错误并记录完整错误对象。
- completion provider 加载失败时不阻断编辑或保存。
- Sync model/decorations 更新失败时不自动保存半成品，保留当前冲突文件并显示错误。
- editor instance、model 和 provider 必须在 unmount、文件切换或语言切换时 dispose。

## 可访问性

- 每个 Monaco editor 必须设置明确 aria-label。
- readOnly 状态同时体现在 Monaco options 和外层视觉状态中。
- toolbar 操作保留真实 button 元素，支持键盘访问。
- completion 是辅助能力，用户可以手动输入 ${key}。
- 错误信息使用现有错误区域或 role="alert"，不能只靠 toast 或颜色表达。

## 测试与验证

组件测试覆盖行为，不测试 Monaco 内部实现：

- Memory source 模式仍能编辑、补全变量并同步主题。
- Vars string 能插入 ${key}，secret 仍遮罩。
- Vars JSON 格式化成功/失败行为不变。
- VarsConfigModal 编辑、raw preview、resolved preview 和保存调用不变。
- SKILL.md editable source 模式保存后刷新 manifest。
- MCP env/headers file 模式编辑后仍能 submit 成 record，key/value 与 file 模式互转不变，变量补全可用。
- Sync LOCAL/REMOTE readOnly，RESULT editable；冲突块操作更新 RESULT；未处理冲突禁止保存；保存提交 RESULT 最新文本。

验证命令：

    bun run test -- packages/web/test/memory-editor.test.tsx
    bun run test -- packages/web/test/vars-editors.test.tsx
    bun run test -- packages/web/test/vars-view.test.tsx
    bun run test -- packages/web/test/views.test.tsx
    bun run test

若实现涉及真实浏览器交互路径，应启动 bun dev 并用 playwright-cli 自动验证关键页面，不要求用户手动打开浏览器确认。

## 验收标准

- 选定范围内的复杂编辑入口均使用 Monaco。
- Vars、Memory、MCP 的 ${var} 补全在对应 Monaco 编辑器可用。
- Vars JSON 不再依赖 CodeMirror，格式化和语法错误提示保留。
- Sync 冲突解决不再依赖 CodeMirror，解决语义不变。
- 前端产品代码无 CodeMirror 引用；若依赖无引用则移除。
- 业务保存、预览、投影和同步规则不因编辑器替换而改变。
