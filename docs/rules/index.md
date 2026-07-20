# Loom 规则索引

本目录记录 Loom 的当前业务规则和安全边界。修改 skills、MCP、memory、vars、projection 或同步相关代码前，先读本索引，再进入对应规则文件。新增或调整规则时参考 [规则模板](template.md)。

## 阅读顺序

1. [领域术语](../../CONTEXT.md) — 统一词汇。只描述概念，不承载规则。
2. [Repository 规则](repositories.md) — managed repository 的名称、路径授权和错误契约。
3. [跨模块规则](cross-cutting.md) — 适用于 skills、MCP、memory、vars 的通用契约。
4. [Vars 规则](vars.md) — 变量解析、分层覆盖、secret 和变更安全边界。
5. [MCP 规则](mcp.md) — MCP server 定义、agent 应用、配置解析上下文和投影边界。
6. [Memory 规则](memory.md) — memory 存储、顺序、激活、预览和投影契约。
7. [Projection 规则](projection.md) — desired state 如何落到 agent-native 文件。
8. [Skills 规则](skills.md) — skills/source/local skill 与顶层顺序的特有规则。
9. [Sync 规则](sync.md) — Git 同步、冲突处理和强制同步的安全边界。

## 规则格式

每条规则使用稳定编号：

- R-CROSS-*：跨模块规则
- R-REPOSITORY-*：repository 规则
- R-VARS-*：vars 规则
- R-MCP-*：MCP 规则
- R-MEMORY-*：memory 规则
- R-PROJECTION-*：projection 规则
- R-SKILLS-*：skills 规则
- R-SYNC-*：sync 规则

规则字段见 [规则模板](template.md)。核心字段：

- Status：当前是否生效。
- Applies to：适用范围。
- Rule：必须遵守的产品契约。
- Implications：实现和 UI 应体现的直接后果。
- Safety：不得突破的安全边界。
- Examples：典型场景。
- Tests：已有自动化验证入口。

## 更新原则

- 规则描述当前事实，不写历史沿革。
- 规则应写产品契约和安全边界，不写内部调用链。
- 如果规则需要解释一个难逆转且有真实 trade-off 的选择，再补 ADR。
- 新 feature spec 应链接相关规则，而不是复制规则正文。
