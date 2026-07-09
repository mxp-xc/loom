# 页面布局契约

Loom 页面布局由 PageLayout 统一承载。页面必须选择一个 variant，不按操作系统、设备型号或固定分辨率分支。

## Layout tokens

全局布局 token 定义在前端全局样式中：

```css
--page-gutter: clamp(12px, 1.8vw, 28px);
--content-max: 1040px;
--workbench-max: 1440px;
--full-height-max: 1480px;
--panel-gap: clamp(12px, 1.2vw, 18px);
```

## PageLayout

PageLayout 只负责页面外层宽度、gutter、高度和滚动边界，不接管标题、loading、error、数据请求或业务状态。

| Variant    | 适用页面               | 契约                                           |
| ---------- | ---------------------- | ---------------------------------------------- |
| content    | Sync、Settings         | 内容居中，最大宽度较窄，页面主区域可以垂直滚动 |
| workbench  | MCP、Skills            | 外层限宽，工作台内部列表、详情、编辑区承担滚动 |
| fullHeight | Vars、Memory、vars-lab | 占满主区域高度，只允许明确的内部区域滚动       |

## 溢出规则

- 页面根节点、shell、main 不应产生横向滚动条。
- 长路径、命令、变量名、header value、preview code 不能撑破页面外层。
- 表格、代码块、Monaco editor 可使用内部横向滚动。
- grid/flex 子项必须保留 min-width: 0，避免内容把布局撑开。
