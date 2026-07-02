# Skills & MCP 页面 UI 优化设计

> 日期: 2026-07-02
> 状态: 已确认,待实现

## 背景

Skills 和 MCP 两个页面存在按钮样式不统一、字体可读性差、Add Skill 弹窗功能不完善、repo skill 命名格式不可配置、分组无法折叠等问题。本设计文档描述优化方案。

## 变更清单

### 1. 统一 Button 组件 + 字体可读性 (问题 1+2)

**范围**: Skills 页面 + MCP 页面所有按钮

- 所有 `<button class="add-btn">` / `<button class="gbtn">` / 内联 style 按钮替换为 `Button` 组件 (`packages/web/src/components/ui/button.tsx`)
- Button 变体: `primary` (主操作)、`secondary` (次要操作)、`ghost` (工具栏操作)、`destructive` (删除)
- 图标统一使用 Lucide React (`lucide-react`),不再用文字符号如 `+`、`↻`、`⋯`
- 字体: skill 名从 12px 提升到 13px,状态文字从 10px 提升到 11px,颜色从 `--muted` 改为 `--text`/`--m2`

### 2. skill 行只显示名字 (问题 1)

- repo source 的 skill 行只显示 memberName (如 `my-skill`),不显示 `repoId-` 前缀
- repoId 在分组头展示,作为上下文
- local skill 行只显示 id

### 3. 分组头可折叠 (问题 5)

- repo source 分组和 local skills 分组的分组头可点击折叠/展开
- chevron 图标 (Lucide `ChevronDown`) 旋转动画指示状态
- 折叠状态用组件内 `useState` 管理,无需持久化
- 分组头内的操作按钮 (Check / Edit / 菜单) 点击时不触发挥折叠 (stopPropagation)

### 4. Add Local tab 重构 (问题 3)

**当前逻辑**: 手动填写 path,id 从路径提取,写入 skills.yaml。无自动扫描,无搜索。

**新逻辑**:

1. 打开时默认填入 `~/.agents/skills/` 作为扫描目录
2. 自动扫描该目录下的 SKILL.md,列出发现的 skill
3. 已导入的 skill 标记 "已导入" (灰色不可选)
4. 未导入的 skill 可 checkbox 选择
5. 搜索框过滤 skill 列表
6. Browse 按钮: 选择外部目录,扫描该目录
7. 当扫描的目录不是 `~/.agents/skills/` 时,底部出现导入方式选择:
   - **移动到 ~/.agents/skills (默认推荐)**: 移动文件夹到 `~/.agents/skills/`,随 git 同步,跨电脑可用
   - **仅引用登记**: 不移动,只在 skills.yaml 登记 path,其他电脑可能不存在
8. 当扫描的目录是 `~/.agents/skills/` 时,不显示导入方式选择 (直接登记)

**Local skill 三种状态**:

| 状态     | 来源                               | 跨电脑        | 展示                                        |
| -------- | ---------------------------------- | ------------- | ------------------------------------------- |
| 自动发现 | `~/.agents/skills/` 下扫描         | 是 (git 同步) | 正常 skill 行                               |
| 移动导入 | 外部目录移动到 `~/.agents/skills/` | 是 (git 同步) | 正常 skill 行                               |
| 引用登记 | 外部目录不移动,只登记 path         | 否            | `ref` badge + 正常行;缺失时黄点 + path 显示 |

### 5. Add Source tab 重构 (问题 6)

**当前逻辑**: url 文本框 + ref 文本框 + 刷新按钮 (扫描当前 ref)。

**新逻辑**:

1. url 输入框
2. type 切换: `branch` / `tag` (segmented control)
3. ref 下拉选择: 调用后端 `git ls-remote` API 列出分支或标签
   - type=branch 时列出所有 branch
   - type=tag 时列出所有 tag
   - 切换 type 时 ref 下拉自动刷新
4. Scan 按钮: 扫描当前 ref 下的 skills (保持现有逻辑)
5. 扫描结果: checkbox 列表 + 搜索框
6. 已安装的 skill 标记 "已安装"

### 6. Source 行展示 + Edit 按钮 (问题 6)

- 分组头新增 `type` badge: `branch` (蓝色) 或 `tag` (紫色)
- ref 展示保持 `@ main` 或 `@ v5.3.1` 格式
- 新增 `Edit` 按钮 (ghost variant),打开 Edit Source 弹窗

### 7. Edit Source 弹窗 (新增)

- 复用 Add Source tab 的表单结构
- 预填当前 source 的 url / type / ref
- 修改后点保存,更新 skills.yaml 并重新 clone/scan
- 底部有 scan 结果列表,可重新选择 members

### 8. 命名格式可配置 (问题 4)

**当前**: 固定 `repoId-memberName` (连字符),硬编码在 `planProjection` 和 `resolveFullLinks` 中。

**新方案**:

- Config 新增字段 `skill_naming: "dir" | "hyphen"` (默认 `"dir"`)
  - `"dir"`: `repoId/memberName` (子目录,如 `~/.claude/skills/loom-skills/my-skill`)
  - `"hyphen"`: `repoId-memberName` (连字符,如 `~/.claude/skills/loom-skills-my-skill`)
- 投影时根据配置生成 skillId
- 配置变更后,下次投影自动清理旧格式 symlink 并按新格式重建 (现有 `cleanOrphanedLinks` 逻辑已覆盖)
- 不需要向前兼容 (开发阶段)

### 9. MCP 页面按钮统一

- MCP 页面的 `+ Add server` / `投影` / `拷贝` / `删除` 按钮统一为 Button 组件
- type 切换 (stdio/sse/http) 改为 segmented control 样式
- targets toggle 保持现有 `.tg` chip 样式但尺寸微调

## 后端变更

### 新增 API

1. `POST /api/sources/refs` — 列出 repo 的分支和标签
   - 请求: `{ url }`
   - 响应: `{ branches: string[], tags: string[] }`
   - 实现: `git ls-remote --heads <url>` + `git ls-remote --tags <url>`

2. `POST /api/skills/local/scan` — 扫描本地目录的 SKILL.md
   - 请求: `{ dir }`
   - 响应: `{ skills: { name, path }[] }`
   - 实现: glob `**/SKILL.md` under `dir`,提取目录名

3. `POST /api/skills/local/import` — 导入 local skill (支持移动)
   - 请求: `{ repoPath, skills: [{ name, path }], mode: "move" | "ref" }`
   - `move`: 移动文件夹到 `~/.agents/skills/`,再写入 skills.yaml
   - `ref`: 直接写入 skills.yaml (path 不变)

### 类型变更

- `SkillSource` 新增 `type?: "branch" | "tag"` 字段 (默认 `"branch"`)
- `Config` 新增 `skill_naming?: "dir" | "hyphen"` 字段 (默认 `"dir"`)

### 投影变更

- `planProjection` 和 `resolveFullLinks` 中 skillId 生成逻辑改为根据 config.skill_naming 决定分隔符
- local skill 的 source 路径解析: 自动发现的用 `~/.agents/skills/<name>`,引用登记的用 yaml 中的 path

## 实现顺序

1. 后端: 新增 API + 类型变更
2. 前端: Button 组件统一 + 字体修复
3. 前端: 分组折叠
4. 前端: Add Local tab 重构
5. 前端: Add Source tab 重构 + Edit Source
6. 前端: 命名格式可配置
7. 前端: MCP 页面按钮统一
8. 测试 + 验证
