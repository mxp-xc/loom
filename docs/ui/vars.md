# Vars 管理

Vars 页面从主导航的“变量”入口进入，用于管理仓库内的多环境 typed variables。

## 页面与类型

桌面端采用环境、变量、详情三栏布局；窄屏下三栏纵向排列。变量支持 `string`、`number`、`boolean`、`secret`、`json` 五种类型。

环境彼此独立。用户按消费顺序把环境加入预览链，后加入的环境覆盖先加入环境中的同名变量。字符串可通过 `${key}` 引用预览链最终可见的变量；引用只查询 Vars，不读取 `process.env`。

`secret` 在接口响应和页面中默认遮罩，但仓库的 Vars YAML 仍以明文保存，不能替代专用密钥管理服务。页面可按需显示 secret 明文。

JSON 使用专用编辑器，支持格式化与语法错误提示。变量详情展示缺失引用、循环引用等诊断；删除前展示直接和间接影响，确认删除后允许保留悬空引用并显示警告。重命名会同步更新相关定义和引用。

## API

Vars API 位于 `/api/vars`，通过 `repoPath` 指定仓库。环境列表、环境内容、解析预览、变量校验、写入、重命名、删除影响检查与 secret 显示均由该入口提供。

## 验证

```bash
bun run test
bun run build
```

页面回归使用带名称的 Playwright CLI session，在隔离 `HOME` 下启动服务，并检查 console error 和业务请求状态。
