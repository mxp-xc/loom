# Source 自定义命名设计

- 日期: 2026-07-12
- 状态: 已实现

## 背景

Loom 当前从 source URL 派生 `repoId`,并用它作为 source 的 UI 分组名、source member skill id 前缀、remote cache 目录名以及 skills projection namespace。用户需要能为 source 自定义名字,并用这个名字修改投影 skills 的 namespace 文件夹名称。

## 目标

- Source 拥有明确的 `name`,默认值是 URL 派生出的仓库名。
- 保存 source 时总是把 `name` 写入 `skills.yaml`。
- 修改 source name 后,skills projection 使用新 name 作为 namespace。
- 改名后清理旧 namespace 下可证明为 Loom-managed 的 artifacts。
- 保留 user-owned artifacts,不因为路径形状像旧 namespace 就删除。

## 非目标

- 不支持同一个 `url` 添加多个 source。
- 不增加单独的展示名和投影 namespace 两套字段。
- 不放宽 source name 为任意目录名或中文展示名。
- 不引入 `previousName` 或其它改名历史字段。

## 数据模型

`SkillSource` 新增必填语义字段 `name`:

```ts
export interface SkillSource {
  name?: string
  url: string
  ref: string
  type?: 'branch' | 'tag'
  pinned_commit?: string
  scan?: string
  members?: SkillMemberOverride[]
}
```

TypeScript 上保持可选是为了读取旧配置。产品语义上 `name` 是 source 的正式名字。没有 `name` 的旧 source 在运行时按 `deriveRepoId(url)` 得到默认 name;后续 source 保存会把默认值持久化。

`name` 必须匹配:

```text
^[a-z0-9]+(-[a-z0-9]+)*$
```

同一个 `skills.yaml` 内 source name 不能重复。同一个 `url` 仍只允许一个 source。

## Identity 与 Projection Namespace

`sourceIdentity(source).repoId` 改为优先使用 `source.name`,没有时回退 `deriveRepoId(source.url)`。为降低改动面,内部字段名可以暂时保留 `repoId`;在 source 对象输入场景下,它表示 projection source name。

所有需要 projection source name 的位置统一走 `sourceIdentity`:

- Skills 页面 source 分组标题。
- Scan/Edit modal 标题和 aria label。
- Toast 文案。
- `formatSourceMemberSkillId(source, memberName, config)`。
- `planProjection()` 产出的 `link.skillId` 和 `link.source.repoId`。

`LinkPlan.source` 中 projection name 和 cache id 必须分离:

```ts
source: {
  repoId: sourceIdentity(source).repoId
  cacheId: deriveRepoId(source.url)
  memberName: member.name
  path?: member.path
}
```

这里的 `repoId` 是 projection namespace name；`cacheId` 是 remote cache 目录名。实现 source 内容读取、projection src 解析、refresh/update 时都必须使用 `cacheId` 或 `deriveRepoId(url)` 找 cache，不能把 `repoId` 当 cache id。

remote cache 路径解析不能走 source name,必须继续用 URL 派生 cache id。读取 source member 内容时,cache dir 使用 `deriveRepoId(source.url)`,member 定位优先使用已保存的 runtime `member.path`;缺少 `member.path` 时才用解析出的 member name fallback。

示例:

```yaml
sources:
  - name: openai-skills
    url: github:obra/superpowers
    ref: main
```

当 `skill_naming: dir` 时,member `brainstorming` 投影为:

```text
<agent skills root>/openai-skills/brainstorming
```

当 `skill_naming: hyphen` 时,member `brainstorming` 投影为:

```text
<agent skills root>/openai-skills-brainstorming
```

## Remote Cache

remote cache 可以继续使用 URL 派生出的 repo id,避免改名导致重新 clone cache:

```text
remote-cache/<deriveRepoId(url)>
```

projection namespace 使用 `source.name`,cache identity 使用 URL 派生名。二者职责不同:

- cache identity: 找到同一个远端内容的本地缓存。
- source name: 表达用户在 Loom 中给 source 取的名字,并决定 projection namespace。

## Add Source 流程

Add Source 增加 `name` 输入框。

- 用户输入 URL 后,如果 `name` 仍为空,前端用 `deriveRepoId(url)` 预填。
- 保存时始终提交 `name`。
- 后端也会兜底:如果请求没有 `name`,用 `deriveRepoId(url)` 写入。
- 后端校验 `name` 格式、重复 name、重复 URL。
- auto-install 仍按 URL 派生 cache id 写入 remote cache。

写入示例:

```yaml
sources:
  - name: superpowers
    url: github:obra/superpowers
    ref: main
```

## Edit Source 流程

Edit Source 增加可编辑 `name` 输入框。URL 保持只读,仍作为当前 source 的查找 key。

保存时:

1. 校验 `name`、`ref`、`type`、`scan`。
2. 更新 `skills.yaml` 中该 source 的 metadata。
3. 保存 selected members。
4. 自动运行 skills projection。

如果只改 name,也必须运行 projection,因为 desired state 的 projection namespace 已变化。

## Projection 与 Cleanup

改名不使用 `previousName`。projection plan 只包含当前 desired state 的 skill ids。executor 通过 orphan cleanup 删除不在当前 plan 内、且可证明为 Loom-managed 的旧 artifacts。

Cleanup 规则:

- symlink artifact 可以删除。
- copy artifact 只有在目录内存在 `.loom-projection.json` 且 marker 表示 `managedBy: "loom"` 时可以删除。
- 真实目录且无 marker 视为 user-owned,必须保留并记录 warning。
- 只有在本次 cleanup 删除了 managed child 后,才沿父目录向上清理空目录。
- 如果 agent 的 skills root 在清理后为空,也删除 skills root。
- 非空目录不删除。

这个规则覆盖:

- source 改名: `superpowers/*` 变成 orphan,清理旧 namespace。
- source 删除:该 source 的 projected artifacts 变成 orphan。
- member 移除或 disabled:对应 artifact 清理。
- `skill_naming` 从 `dir` 改为 `hyphen`:旧格式 artifact 清理。

## API 变更

`POST /sources` 请求体新增:

```ts
{
  repo: unknown
  name?: string
  url: string
  ref: string
  type?: 'branch' | 'tag'
  scan?: string
}
```

`POST /sources/update` 请求体新增:

```ts
{
  repo: unknown
  url: string
  name?: string
  ref?: string
  type?: 'branch' | 'tag'
  scan?: string
}
```

`/sources/scan` 与 `/sources/refresh` 不需要依赖 source name;它们扫描远端内容和 cache,仍按 URL/ref/scan 工作。

## UI 变更

- Source group head 展示 `source.name`。
- Group head 仍展示 URL、type、ref。
- Add Source tab 增加 `name` input,放在 URL 后或 URL 前均可,但保存前必须可见。
- Edit Source modal 增加 `name` input。
- Scan modal、Edit modal、toast、aria label 统一使用 source name。
- name 输入错误时在 modal 内展示错误,不静默失败。

## 规则文档更新

更新 `docs/rules/skills.md`:

- Source name 是 source 的稳定名字。
- Source name 默认来自 URL 派生仓库名。
- 保存 source 时必须持久化 name。
- Source name 参与 projection namespace。

更新 `docs/rules/projection.md`:

- Projection cleanup 删除 managed child 后可以删除空 parent。
- 如果 agent skills root 因本次 cleanup 变空,也可以删除 skills root。
- User-owned artifacts 仍必须保留。

## 测试计划

Core:

- `SkillSourceSchema` 接收并校验 `name`。
- `sourceIdentity()` 优先使用 `name`,没有时回退 URL 派生值。
- `planProjection()` 使用 source name 生成 `skillId` 和 `link.source.repoId`。
- `addSource()` 写入传入 name。
- `updateSourceMeta()` 可以更新 name。

Server:

- `SkillsApplication.addSource()` 没有传 name 时写入默认 name。
- `SkillsApplication.addSource()` 传 name 时写入自定义 name。
- 重复 URL 拒绝。
- 重复 name 拒绝。
- 非法 name 拒绝并返回明确错误。
- 改名保存后仍保留 members/targets。

Projection:

- source 改名后旧 namespace symlink 被 orphan cleanup 删除。
- copy strategy 下带 `.loom-projection.json` 的旧 namespace artifact 被删除。
- 无 marker 的真实目录被保留并记录 warning。
- cleanup 后空 namespace parent 被删除。
- cleanup 后 skills root 为空时删除 skills root。

Web:

- Add Source 提交 `name`。
- Add Source URL blur 后默认填充 repo name。
- Edit Source 提交更新后的 `name`。
- Source list 使用 `name` 展示。
- 保存 source 后保持自动 skills projection 链路。

## 验证

默认验证:

```bash
bun run test
```

涉及前端交互后,启动自己的 dev server 并用 `playwright-cli` 自动验证 Add/Edit Source 的 name 输入、保存 payload、source list 展示与基础布局。
