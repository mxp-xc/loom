# UI 规范索引

本目录记录 Loom 前端当前使用的视觉 token、共享组件和页面布局契约。业务行为与安全边界以 [业务规则](../rules/index.md) 为准；UI 文档不重复规则正文。

## 文档列表

- [设计系统](design-system.md) — 当前色彩、字体、圆角、阴影、动效和主题 token
- [页面布局契约](layout.md) — `PageLayout` variants、宽度 token、滚动边界与溢出规则
- [组件规范](components.md) — 按钮、tooltip、target chip、toast、modal、错误反馈、tabs 和 app shell
- [Vars 管理](vars.md) — `Builtin / Base / Local` profiles、agent 查看范围与最终结果
- [MCP Workbench](mcp.md) — MCP server 列表、detail/editor、配置视图、Tools 与变量信息弹窗

## 设计语言

Loom 默认使用浅色中性表面和 emerald 主色，同时支持深色与跟随系统主题。界面以 sans-serif 为主，等宽字体用于代码、路径、配置键和数据值；交互控件优先复用 `packages/web/src/components/ui`，页面样式消费全局 token，不在页面内复制另一套主题值。
