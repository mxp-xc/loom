# Memory 消费 Agent-aware Vars 设计

- 日期:2026-07-07
- 状态:草案,讨论中
- 依赖: [Agent-aware Vars 设计](./2026-07-07-agent-aware-vars-design.md)

## 概述

Memory 继续维护命名 markdown 模板,但模板中的变量由 agent-aware vars 解析。投影或预览时,同一份 memory 模板会根据目标 agent 和本机 local vars 生成最终 markdown,再写入该 agent 的全局提示词文件。

## 设计决策汇总

| 决策点      | 结论                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| memory 存储 | 继续使用 `memories/<name>.md`,`config.active_memory` 指向激活模板                         |
| 模板语法    | 模板使用 `${key}` 引用 vars;字面 `${...}` 使用 `\${...}` 转义                             |
| key 来源    | 模板只能引用 full registry 中存在的 key,即 builtin key 或 `vars/base.yaml` 声明的用户 key |
| 默认值      | 不支持 `${key:default}`;默认值由 `vars/base.yaml` 提供                                    |
| 渲染链      | 使用 agent-aware vars 的 `base → base.agent → local → local.agent → builtin runtime`      |
| 文本插值    | `string` 原样插入,`number`/`boolean` 转文本,`json` 不允许直接插入                         |
| local 参与  | local vars 参与本机预览与投影,但不进入 sync / push                                        |
| 预览        | Memory 页面提供模板预览和按 agent 渲染后的最终 markdown 预览                              |
| 投影        | 对所有目标 agent 先渲染校验,全部成功后再写入对应的 `CLAUDE.md` 或 `AGENTS.md`             |
| 失败策略    | 投影采用 all-or-nothing:任一目标失败则本次不写入任何 agent 文件                           |

## 模板示例

```markdown
# ${agent_name}

通用规则...

@${rtk}

${agent_extra_rules}
```

这些 key 的 type、format 和默认值由 `vars/base.yaml` 定义:

```yaml
agent_name:
  type: string
  value: Agent

rtk:
  type: string
  format: path
  value: ${LOOM_CONFIG_DIR}/RTK.md

agent_extra_rules:
  type: string
  format: markdown
  value: ''
```

## 渲染流程

对每个目标 agent:

```
1. 读取激活 memory 模板
2. 调用 agent-aware vars resolver:
   synced vars/base.yaml
   → synced vars/agents/<agent>.yaml
   → local vars/local.yaml
   → local vars/agents/<agent>.yaml
   → builtin runtime
3. 合并 layer 并递归解析变量引用
4. 将模板中的 ${key} 替换成最终变量值
5. 得到该 agent 的最终 markdown
```

模板是文本消费者。替换 `${key}` 时:

- `string` 值原样插入。
- `number` 和 `boolean` 使用稳定文本表示插入。
- `json` 值不允许直接插入 memory 模板,产生诊断;如需 JSON 文本,变量应定义为 `type: string, format: json`。

builtin runtime 提供 agent 相关内置 key,例如:

```yaml
LOOM_AGENT: codex
LOOM_CONFIG_DIR: C:/Users/10107/.codex
LOOM_SKILLS_DIR: C:/Users/10107/.codex/skills
LOOM_AGENT_FILE: AGENTS.md
```

其中 `LOOM_CONFIG_DIR` 表示当前渲染目标 agent 的配置目录,不是 Loom home。

## 预览

Memory 页面保留三类视图:

- 编辑:编辑原始 markdown 模板。
- 模板预览:只渲染 markdown 排版,不解析 vars。
- Agent 预览:选择 agent,显示该 agent 的最终 markdown。

Agent 预览出现变量错误时,直接展示 agent-aware vars resolver 返回的诊断。变量来源和依赖追溯由 agent-aware vars 的预览页展示;Memory 页面可以从 `${key}` 跳转到对应变量。

## 投影

投影 memory 时:

- 只处理当前激活 memory。
- 对 `config.targets` 中安装的 agent 逐个渲染。
- 投影采用 all-or-nothing:
  - 先完成所有目标 agent 的渲染和校验。
  - 任一目标 agent 渲染失败时,本次投影不写入任何 agent 文件。
  - 全部目标 agent 渲染成功后,再开始写入。
- 写入前保留 rollback backup。
- 写入过程中任一目标失败时,回滚本次已写入的目标文件并返回诊断。
- Claude Code 写入 `CLAUDE.md`;Codex 和 OpenCode 写入 `AGENTS.md`。

local vars 只影响本机投影结果,不会写入 synced repo。

## 错误处理

以下情况阻塞预览中的 agent 渲染和 memory 投影:

- 模板引用了 full registry 中不存在的 key。
- vars resolver 发现循环引用。
- override value 与 base schema 类型不匹配。
- memory 模板直接引用 `json` 类型变量。
- agent 文件名不是支持的 AgentId。
- `LOOM_` 前缀被用户变量占用。

错误应带诊断信息,指向 key、layer 和引用路径,方便从 Memory 页面跳转到 Vars 页面修复。
