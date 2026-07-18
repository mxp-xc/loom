# Copy Path 设计

## 目标

在可复用的 `OpenWith` 下拉菜单中提供“复制路径”，把当前文件或目录的真实绝对路径复制到剪贴板。功能支持 macOS 和 Windows，不限定目标类型或文件扩展名。

## 服务端契约

- 新增路径解析 API，接收现有 `repo` 与仓库相对 `path`，返回目标的绝对路径。
- 路径解析复用 `open-path` 的仓库定位与安全校验，拒绝绝对输入、`..` 越界和 symlink 越界。
- 返回路径使用运行平台的原生格式；macOS 使用 POSIX 路径，Windows 使用 Windows 路径。
- 解析失败时返回结构化错误并记录完整错误对象。

## 前端组件

- `OpenWith` 接受可选的 `onPathCopied` 和 `onPathCopyError` 回调。
- 点击后请求服务端解析路径，再通过 Clipboard API 写入剪贴板。
- 下拉菜单在应用列表末尾显示 Lucide `Copy` 图标和“复制路径”，不增加分隔线。
- Memory 页面成功后显示“已复制路径”，失败时显示剪贴板或路径解析错误；工具栏不增加独立按钮。

## 验证

- Server 测试覆盖文件与目录路径、平台原生绝对路径以及越界输入。
- Web 测试覆盖复制成功、服务端失败和 Clipboard API 失败。
- 使用 `playwright-cli` 验证下拉菜单位置、实际复制内容和 console error。
