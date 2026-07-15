# Source 仓库与文件 Web 链接设计

## 目标

Skills 页面为 Source 的 Git remote URL 派生可在浏览器打开的仓库主页，并为 Source member 的 `SKILL.md` 派生对应 forge 的文件页面。映射只服务于 UI 展示，不修改 `skills.yaml` 中保存的 Source URL，也不改变 scan、update、clone 或其他 Git 行为。

相关规则：[Skills 规则](../../rules/skills.md)，尤其是 R-SKILLS-005 与 R-SKILLS-009。

## 现状与问题

Source header 当前仅从 `src.url` 删除末尾 `.git` 后直接写入 `href`。HTTPS remote 可以正常打开，但 scp-like SSH remote 仍会得到无效浏览器链接。例如：

```text
git@gitcode.com:HarnessPlatform/Marketplace.git
```

当前 Source member 文件链接只识别 GitHub，并固定使用 GitHub `/blob/{ref}/{path}` 路由。GitCode、Gitee 与 GitHub 使用 `/blob/{ref}/{path}`，GitLab 使用 `/-/blob/{ref}/{path}`；这些 provider 差异不应继续写死在 React 组件中。

Git 只定义 repository transport URL，不提供从 SSH remote 到 forge Web URL 的标准映射，也不通过 `git ls-remote` 等协议返回仓库主页。Loom 因此使用确定性的本地推导，不联网探测链接是否存在。

## 范围

本轮纳入：

- HTTP、HTTPS、Git、SSH URL 与常见 scp-like SSH remote 的仓库主页推导。
- GitHub、GitLab、GitCode 与 Gitee 的 member 文件路由。
- 未知 forge 的 `/blob/{ref}/{path}` 默认降级。
- Source header 与 Source member 链接接入。
- URL 安全边界、单元测试、组件回归测试和浏览器验证。

本轮不纳入：

- 修改或规范化 manifest 中保存的 Source URL。
- 读取用户 SSH config 以解析 host alias。
- 请求远端网页、forge API 或 Git API 探测 provider 和链接有效性。
- 新增可配置的 Web URL 或文件路由模板。
- 为 local skill 生成远端链接。
- 保证 SSH alias、独立 Web host 或非同构 repository path 能自动映射。

## 映射边界

Web 层新增独立的 repository-link 工具模块。它提供两个纯函数：

```ts
inferRepositoryWebUrl(sourceUrl: string): string | null

inferRepositoryFileWebUrl(
  sourceUrl: string,
  ref: string,
  relativePath: string,
): string | null
```

两个公开函数共享内部 Git remote 解析结果。该模块属于 Web 展示边界，放在 `packages/web/src/lib/repository-links.ts`；provider Web 路由不进入 `packages/core`，server 的 Git transport 也不依赖它。

函数名使用 `infer`，明确结果来自约定推导而不是 Git 标准保证。调用方不能把推导结果写回 manifest 或传给 Git。

## 仓库主页推导

映射规则如下：

| Source URL                          | Repository Web URL       |
| ----------------------------------- | ------------------------ |
| `https://host/team/repo.git`        | `https://host/team/repo` |
| `http://host/team/repo.git`         | `http://host/team/repo`  |
| `git@host:team/repo.git`            | `https://host/team/repo` |
| `ssh://git@host:2222/team/repo.git` | `https://host/team/repo` |
| `git://host/team/repo.git`          | `https://host/team/repo` |

HTTP 与 HTTPS remote 保留原 Web scheme 和显式 Web port。SSH 与 Git transport 默认映射为 HTTPS，并删除 transport username、password 和 SSH port，因为 SSH 端口通常不是 Web 端口。

Repository path 保留任意层级 namespace，只删除路径末尾的 `.git` 和多余尾部 `/`。输入中的 query 与 fragment 不进入输出。host 做大小写标准化，provider 判断使用精确 host，不使用 `includes` 等可能把非目标域名误判为已知 forge 的匹配方式。

无法可靠解析的输入返回 `null`，包括本地路径、`file://`、缺少 host 或 repository path 的值，以及非 Git transport scheme。Windows drive path 不能被误判为 scp-like SSH remote。

典型 GitCode 映射为：

```text
git@gitcode.com:HarnessPlatform/Marketplace.git
-> https://gitcode.com/HarnessPlatform/Marketplace
```

SSH config 中的单标签 alias、`HostName` 重写、独立 Web 域名和不同 Web path 无法仅从 remote 字符串得知。此类输入仍按可见 host 做最佳努力推导，但 Loom 不读取系统 SSH 配置，也不承诺结果可访问。

## Member 文件路由

`inferRepositoryFileWebUrl()` 先得到仓库主页与标准化 host，再选择文件 route builder：

| Forge   | Host            | File route             |
| ------- | --------------- | ---------------------- |
| GitHub  | `github.com`    | `/blob/{ref}/{path}`   |
| GitLab  | `gitlab.com`    | `/-/blob/{ref}/{path}` |
| GitCode | `gitcode.com`   | `/blob/{ref}/{path}`   |
| Gitee   | `gitee.com`     | `/blob/{ref}/{path}`   |
| Unknown | 其他可解析 host | `/blob/{ref}/{path}`   |

已知 provider 使用显式 host 与 route builder。发现新的 forge 路由差异时，在同一映射表增加适配；不把 provider 条件散落到 React 组件中。

未知 host 默认使用多数 forge 接受的 `/blob/{ref}/{path}`。这是有意的 best-effort 降级，可能生成不存在的页面，但仍满足输出只能是安全 HTTP(S) URL 的要求。Loom 不在渲染时验证其 HTTP 状态。

`ref` 与 member relative path 按 `/` 分段编码，保留 branch namespace 和目录层级，同时编码空格、`#`、`?` 等 URL 特殊字符。relative path 继续来自现有 `sourceSkillRelativePath()`，默认指向 `skills/{memberName}/SKILL.md`，并保留 scan 得到的实际嵌套路径。

GitCode 示例：

```text
source: git@gitcode.com:HarnessPlatform/Marketplace.git
ref: main
path: skills/so-debug/SKILL.md

-> https://gitcode.com/HarnessPlatform/Marketplace/blob/main/skills/so-debug/SKILL.md
```

## UI 接入

`SkillSourceList` 不再直接从 `src.url.replace(/\.git$/, '')` 构造 Source header 的 `href`，也不再包含 GitHub 专用 URL helper。

每个 Source render 期间先推导仓库主页：

- 推导成功时，header 继续显示原始 `src.url`，点击后在新标签页打开派生的 Web URL。
- 推导失败时，header 只显示原始文本，不渲染为 anchor。
- `title` 保留原始 Source URL，使用户能确认 Git 实际使用的 remote。
- 外链继续使用 `target="_blank"` 与 `rel="noopener noreferrer"`。

每个 Source member 使用相同 remote 解析边界派生文件链接。推导成功时显示现有 external-link icon；可访问名称改为 provider-neutral 的“在仓库中打开 `<member>` 的 `SKILL.md`”，不再写死 GitHub。推导失败时不显示 external-link icon，点击 member row 打开 Loom 内部详情的现有行为不变。

local skill、Source 展开折叠、拖拽、targets、scan、edit、update 和 delete 交互均不改变。

## 安全与错误处理

- 派生函数只返回 `http:` 或 `https:` URL，任何其他输出 scheme 返回 `null`。
- HTTP(S) clone URL 中的 username、password、query 和 fragment 不复制到 Web URL，避免把凭据或 token 放进浏览器导航。
- SSH username 与 transport port 不进入 Web URL。
- host 与 repository path 由结构化 URL 解析和受限的 scp-like parser 提取，不把原始输入直接拼到 `href` scheme 位置。
- `.git` 只从 repository path 末尾删除，不替换 namespace 或 repository name 中间的同名文本。
- provider 匹配只影响 path builder，不放宽 scheme、host 或路径校验。

Malformed remote 是可预期输入。纯函数返回 `null`，组件使用无链接文本降级，不抛异常，也不进入需要记录错误的 `catch`。本轮不新增异步调用、网络错误或可静默吞掉的异常分支。

## 规则与文档

`docs/rules/skills.md` 增加 Source Web 链接规则，明确：

- Git remote 是 scan、update 与 clone 的权威地址，必须原样保留。
- UI 可以从 remote 派生仓库主页和 member 文件 Web 链接，但不能把结果写回 Source。
- 已知 forge 使用显式文件路由，未知 forge 使用 `/blob/` best-effort 降级。
- 无法生成安全 HTTP(S) URL 时不渲染外链。

规则描述用户可见契约与安全边界，不记录 React helper 或内部调用链。

## 测试与验证

新增 `packages/web/test/repository-links.test.ts`，使用表驱动测试覆盖：

- HTTPS 与 HTTP remote、末尾 `.git` 和 `/`。
- scp-like SSH、`ssh://` 自定义端口和 `git://`。
- nested group path。
- HTTP(S) userinfo、query 与 fragment 移除。
- 本地路径、Windows drive path、`file://`、无 host/path 和未知 scheme 返回 `null`。
- GitHub `/blob/`、GitLab `/-/blob/`、GitCode `/blob/`、Gitee `/blob/`。
- 未知 host 的 `/blob/` 降级。
- ref 和 relative path 的逐段编码。

更新 `packages/web/test/views.test.tsx`，覆盖：

- GitCode SSH Source header 指向 HTTPS 仓库主页。
- GitCode member 指向 `/blob/{ref}/{path}`。
- GitHub 现有 `/blob/{ref}/{path}` 行为保持不变。
- 未知 host member 使用 `/blob/{ref}/{path}`。
- 无法解析的 Source URL 不产生 header 或 member anchor。
- header link 和 member external link 的点击不会触发 Source group 展开折叠或 member 详情。
- member link 使用 provider-neutral accessible name。

实现后运行相关 Vitest 和全量 `bun run test`。启动 `bun dev` 后使用带名称 session 的 `playwright-cli`，在当前 `/skills` 页面验证 GitCode SSH Source 的实际 `href`、member 文件 `href`、新标签页导航、Source 展开状态和 console error。

## 验收标准

- `git@gitcode.com:HarnessPlatform/Marketplace.git` 的 Source header 打开 `https://gitcode.com/HarnessPlatform/Marketplace`。
- GitCode member 文件链接使用 `/blob/{ref}/{path}`。
- GitHub、GitLab、GitCode 与 Gitee 使用各自已知路由。
- 未知可解析 forge 使用 `/blob/{ref}/{path}` 默认降级。
- Source URL 的显示值、manifest 值和 Git transport 行为保持不变。
- 无法解析或不能生成安全 HTTP(S) URL 的 remote 不产生外链。
- 外链不会触发所在 Source/member 的现有行级交互。
- local skill 与非链接 Skills 行为不发生变化。
