# Settings 页面重新设计

> 2026-07-02 | 基于 brainstorming mockup v6(用户确认)

## 背景

当前 Settings 页面存在两类问题:

### 功能 bug

- `formatValue` 把数组 join 成逗号串,编辑时丢失 JSON 结构
- 嵌套对象挤成一行,不可读
- 本地级无"删除覆盖回退继承"操作
- 仓库级未设字段直接显示合并值,无"未设置"占位
- 最终结果"两处未设"和本地级"继承"都用空心灰圆点,spec 要求区分

### UI 简陋

- 无分类 tab,全部字段堆在一个列表里
- 表格挤在左上角,右侧大量空白
- 所有字段统一用文本 input,没有 toggle/select/segmented 等控件
- inline style 泛滥,CSS 已写好样式但组件没用
- 状态点硬编码颜色,不用 CSS 变量

## 数据模型

### Config 结构(packages/core/src/types.ts:53)

```typescript
interface Config {
  active_repo?: string
  profile?: string
  targets?: AgentId[]
  projection?: { strategy: 'link' | 'copy' }
  update_check?: { enabled: boolean; interval: string }
  proxy?: { http?: string; https?: string; no_proxy?: string }
}
```

### API

- `GET /config?repoPath=` 返回 `{ effective, repo, local }` 三个 Config
- `PUT /config` 接收 `{ repoPath, level, field, value }`,value=null 删除字段

### 字段元数据

前端定义 field schema,不依赖后端:

| 字段                  | 分组       | 控件        | 固定本地 |
| --------------------- | ---------- | ----------- | -------- |
| active_repo           | Workspace  | select      | 是       |
| profile               | Workspace  | select      | 否       |
| targets               | Projection | agent chips | 否       |
| projection.strategy   | Projection | segmented   | 否       |
| update_check.enabled  | Updates    | toggle      | 否       |
| update_check.interval | Updates    | input+unit  | 否       |
| proxy.http            | Proxy      | text input  | 否       |
| proxy.https           | Proxy      | text input  | 否       |
| proxy.no_proxy        | Proxy      | text input  | 否       |

嵌套字段用点号路径。需扩展 setConfigField 支持点号路径写入。

## UI 设计

### 布局

分类 tab(通用/网络) + 三态切换(最终结果/仓库级/本地级) + group cards。

每个字段单行,三个 pane 用相同控件,只通过 disabled 置灰区分。切换 pane 时行高一致不跳。

### 控件类型

select / segmented / agent chips / toggle / input+unit / text input

### 状态点

用 CSS 变量:repo=绿, local=蓝, inherit=空心灰, fixed=蓝环。本地级可点击切换覆盖/继承。

### 帮助 tooltip

label 旁问号图标,hover 弹自定义 CSS tooltip。只在需要说明的字段加。

### Save bar

底部 sticky,dirty 指示 + 放弃/保存按钮。

## 实现范围

### 前端

- 重写 Settings.tsx 和 ConfigField.tsx
- 新增 field schema 和 CSS
- 复用现有 API,不改 API 层

### 后端

- 扩展 setConfigField 支持点号路径

### 不做

- JSON 编辑器
- 搜索过滤
- 批量保存(逐字段保存)

## 文件清单

| 文件                                        | 改动         |
| ------------------------------------------- | ------------ |
| packages/web/src/views/Settings.tsx         | 重写         |
| packages/web/src/components/ConfigField.tsx | 重写         |
| packages/web/src/index.css                  | 新增 CSS     |
| packages/core/src/mutators.ts               | 扩展点号路径 |

## 参考

- Mockup: .superpowers/brainstorm/session-1/content/v6-tooltip.html
- 参考设计: D:\code\github\loom\archive\loom-settings.html
- 设计系统: docs/ui/design-system.md
