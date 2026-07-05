# 记忆管理(Memory Management)设计

- 日期:2026-07-05
- 状态:设计已确认,待编写实现计划

## 概述

在 loom 中新增"记忆管理"功能:维护多份命名提示词文档,激活其中一份,投影时按工具渲染 `${VAR}` 占位符并整文件写入 Claude Code / Codex / OpenCode 的全局提示词文件(`CLAUDE.md` / `AGENTS.md`)。复用 loom 现有 projection / adapters / vars / merge / git 基础设施。

配套整改:全局 API 参数 `repoPath` → `repo`(repo name),用目录列表精准匹配校验,防路径遍历。

## 背景与现状

loom 是 code agent 周边设施管理工具,已支持 Skills / MCP / Config 投影到 cc/cx/oc,基于 Git 做语义级三路合并。

用户当前全局提示词文件现状:

- `~/.claude/CLAUDE.md`(5.9K)与 `~/.codex/AGENTS.md`(5.9K)内容几乎完全相同 —— 手动维护两份重复文件
- 差异点:① 文件名不同;② `@RTK.md` 引用路径不同(codex 用绝对路径);③ 都有 `<!-- CODEGRAPH_START/END -->` 包裹的 CodeGraph 段(外部工具注入)
- `~/.codex/RTK.md`(482B)与 `~/.claude/RTK.md`(964B)内容不同(各工具 hook 机制差异)
- `~/.config/opencode/AGENTS.md` 是符号链接 → `~/workspace/agents/AGENTS.md`

记忆管理只管主文件(CLAUDE.md/AGENTS.md),不管 `@` 引用的子文件(RTK.md)和外部注入段(CodeGraph)—— 这些由各工具/原工具自行维护。

## 设计决策汇总

| 决策点         | 结论                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| 管理范围       | 只主文件(CLAUDE.md/AGENTS.md)                                                         |
| vars 引用语法  | 复用 loom 现有 `${VAR}` / `${VAR:fallback}`                                           |
| 投影语义       | 整文件覆盖(不用标记块)                                                                |
| `${}` 字面冲突 | `\${}` 转义符 → 字面 `${}`                                                            |
| 多文档         | `memories/<name>.md`,支持自定义名字(v1/v2/...)                                        |
| 激活机制       | `config.active_memory` 指向当前激活(平行于 `config.profile`)                          |
| targets        | 全局 `config.targets`,无 per-memory targets                                           |
| 内置变量       | `LOOM_AGENT`/`LOOM_CONFIG_DIR`/`LOOM_SKILLS_DIR`/`LOOM_AGENT_FILE`,注入 `varsCtx.env` |
| 投影触发       | `POST /project` 增加 `scope` 参数(skills/mcp/memory/all),各页面单资源投影             |
| 编辑器         | 三视图:编辑(默认)/预览/解析预览;占位符高亮                                            |
| repo 参数      | 全局 `repoPath` → `repo`(name),目录列表精准匹配校验                                   |

## §1 数据模型与存储

平行于 loom 已有 `vars/<profile>.yaml` 模式。

### 存储布局(`~/.loom/repos/<repo>/`)

```
├── config.yaml          # 新增 active_memory: <name>
├── skills.yaml
├── mcp.yaml
├── vars/
│   ├── default.yaml
│   └── <profile>.yaml
└── memories/            # 新增目录
    ├── v1.md
    └── v2.md
```

### 类型(`packages/core/src/types.ts`)

```ts
export interface Memory {
  name: string // 文件名去 .md;同时作为 id
  content?: string // 运行时填充:列表不填,详情/投影时读文件填
}

export interface MemoryManifest {
  memories: Memory[] // 扫描 memories/ 目录得到
  active: Memory | null // config.active_memory 对应的;无则 null
  activeContent: string // 激活 memory 的原始文本(未渲染)
}

// Config 增加:
export interface Config {
  // ...existing...
  active_memory?: string // 激活的 memory name;平行于 profile
}

// Manifest 增加:
export interface Manifest {
  // ...existing...
  memory: MemoryManifest
}
```

### 关键决策

- **无单独 `memory.yaml`** —— 列表由扫描 `memories/` 目录得到,避免元数据与文件脱节。新增 = 建文件;重命名 = 改文件名 + 同步 `active_memory`;删除 = 删文件 + 清 `active_memory`(若激活)
- **name 即 id** —— memory 无复杂属性(无 targets/scope),只有名字和内容,不需独立 id
- **targets 用全局 `config.targets`** —— 不加 per-memory targets(YAGNI)
- **`active_memory` 随 git 同步** —— 仓库级配置,团队共享激活状态

## §2 vars 引用与渲染

复用现有 `${VAR}` 语法,新增转义处理 + per-agent 内置变量注入。不修改 `resolveVars` 签名(仍服务 MCP env)。

### 渲染函数(`packages/core/src/vars.ts` 新增)

```ts
const ESC = '��DOLLAR_BRACE��'

export function renderText(text: string, ctx: VarsContext): string {
  let s = text.replaceAll('\\${', ESC) // 1. 保护转义
  s = resolveVars(s, ctx) // 2. 复用现有解析
  return s.replaceAll(ESC, '${') // 3. 还原转义为字面 ${
}
```

顺序关键:先保护 `\${` → 再解析 `${VAR}` → 最后还原。`\${HOME}` 不被误解析,`${LOOM_CONFIG_DIR}` 正常解析。

### per-agent 内置变量(投影时注入 `varsCtx.env`,优先级最高,不可被 vars 文件覆盖)

| 变量              | cc                                | cx                        | oc                                           |
| ----------------- | --------------------------------- | ------------------------- | -------------------------------------------- |
| `LOOM_AGENT`      | `claude-code`                     | `codex`                   | `opencode`                                   |
| `LOOM_CONFIG_DIR` | `~/.claude`(`$CLAUDE_CONFIG_DIR`) | `~/.codex`(`$CODEX_HOME`) | `~/.config/opencode`(`$OPENCODE_CONFIG_DIR`) |
| `LOOM_SKILLS_DIR` | `<config>/skills`                 | `<config>/skills`         | `<config>/skills`                            |
| `LOOM_AGENT_FILE` | `CLAUDE.md`                       | `AGENTS.md`               | `AGENTS.md`                                  |

值全部来自 `paths.ts` 动态解析(`homedir()` + 环境变量覆盖),绝不硬编码路径字面量。

### `paths.ts` 既有 bug 修正

opencode macOS 分支当前返回 `~/Library/Application Support/opencode`(实际不存在),opencode 在所有平台实际用 `~/.config/opencode`。修正为统一路径:

```ts
case 'opencode': {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'opencode')   // 所有平台统一 ~/.config/opencode
}
```

新增 `agentMemoryFile(agent)`:`join(agentConfigDir(agent), agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md')`。

### 用法示例

主提示词写 `@${LOOM_CONFIG_DIR}/RTK.md` → 投影到 cc 得 `@/Users/<user>/.claude/RTK.md`,投影到 cx 得 `@/Users/<user>/.codex/RTK.md`。

### 扩展点(YAGNI,不在本期)

当前 loom 投影时解析 `${VAR}` 写入最终值,产物是纯文本,不依赖各工具 vars 能力。未来若工具原生支持 `${VAR}`,可增加"透传不解析"模式。

## §3 投影触发模型

### 现状澄清

目前只有一个 `POST /project` 端点,调用 `executeProjection` 一次性投影 skills + mcp。skills/mcp 页面"投影"按钮都调同一个 `api.project({ repo })`,即点哪个都是全投影。改为:每个页面投影只投影该资源本身。

### scope 参数

`POST /project` body 增加 `scope: 'skills' | 'mcp' | 'memory' | 'all'`(默认 `'all'` 向后兼容)。

`executeProjection(plan, mf, varsCtx, deps, scope)` 按 scope 执行:

- `skills` → Phase A-C(skills 链接 + 清理)
- `mcp` → mcp 合并写入
- `memory` → Phase D(新增)
- `all` → 全部(现有行为)

### 前端各页面传 scope

- skills 页面 → `scope: 'skills'`
- mcp 页面 → `scope: 'mcp'`
- memory 页面 → `scope: 'memory'`
- 可选:全局"投影"入口(sidebar/顶部)→ `scope: 'all'`

### memory 投影流程(`scope='memory'`)

```
取激活 memory 的 activeContent
对 config.targets 里每个 agent:
  1. 构建 per-agent varsCtx = {
       env: { LOOM_AGENT, LOOM_CONFIG_DIR, LOOM_SKILLS_DIR, LOOM_AGENT_FILE },
       activeProfile, defaultProfile
     }
  2. rendered = renderText(activeContent, varsCtx)
  3. path = agentMemoryFile(agent)
  4. backup = fs.exists(path) ? fs.readFile(path) : null
  5. journal.undos.push({ kind: 'restoreMemory', path, backup })
  6. fs.writeFile(path, rendered)   // 整文件覆盖
```

### 关键决策

- **memory 读写不进 adapter** —— 各工具 memory 文件格式一致(纯 markdown),直接用 `IFileSystem` + `agentMemoryFile(agent)`,与 MCP adapter 解耦
- **整文件覆盖 + journal 回滚**(仅 memory 阶段)
- **跳过条件**:`memoryPlan.active === null`(无激活 memory 或 `memories/` 空)→ 整个 Phase D 跳过,记 `logger.info('no active memory, skip')`,不影响 skills/mcp
- **失败处理**:`renderText` 抛 `ResolveError`(未定义变量)→ 该 agent memory 写入失败,记 `logger.error({ err, agent })`,投影 failure,回滚已写文件。不静默吞错
- **skills/mcp 也变成单资源投影**(写不同文件、无依赖,拆分安全)

### ProjectionPlan 扩展

```ts
memoryPlan: {
  active: Memory | null
  content: string | null
  targets: AgentId[]        // = config.targets
}
```

## §4 前端页面与 API

### 后端路由(新建 `packages/server/src/api/routes/memory.ts`,`router.ts` 注册)

```
GET    /memory?repo=              → { memories: [{name}], active: name|null, activeContent: string }
POST   /memory                    → { repo, name }              新建 memories/<name>.md 空文件
DELETE /memory?repo=&name=        → 删除(若激活则清 active_memory)
POST   /memory/rename             → { repo, name, newName }     改文件名 + 同步 active_memory
PUT    /memory/content            → { repo, name, content }     写入
POST   /memory/active             → { repo, name }              写 config.active_memory
POST   /memory/preview            → { repo, content, agent }    返回 renderText 结果(投影前预览)
```

投影复用 `POST /project` with `scope:'memory'`,不新建投影端点。

### 前端 `/memory` 页面(新建 `packages/web/src/views/Memory.tsx`)

sidebar workspace 区加 NavLink `✦ Memory`;`App.tsx` Routes 加 `<Route path="memory" element={<Memory repo={repo} />} />`。

布局左右分栏(参考 `Mcp.tsx`):

- 左栏:`+ 新建` 按钮 + memory 列表(激活项高亮,每项 `⋯` 菜单:激活/重命名/删除)
- 右栏:头部(name + 投影按钮 + targets chips)+ MemoryEditor

### MemoryEditor 组件(新建,三视图)

| 视图           | 内容                                                            | 说明                                                          |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| **编辑**(默认) | textarea + 占位符高亮叠加层                                     | 默认进入(与现有 `MarkdownPreview` 默认 preview 相反)          |
| **预览**       | ReactMarkdown 渲染,`${VAR}` 原样显示                            | 看排版效果                                                    |
| **解析预览**   | 选 agent(CC/CX/OC)→ `POST /memory/preview` → ReactMarkdown 渲染 | 看 `${LOOM_CONFIG_DIR}` 解析成实际路径后的最终效果,投影前验证 |

复用:`Modal`、`Toast`、`Button`、`useManifest`、`useViewError`、`agentShort`/`agentColor`、`ReactMarkdown`。

### 占位符高亮(编辑视图)

textarea 文字透明 + 同步滚动的高亮层(`<pre>` 叠在背后),用正则识别占位符包 `<span>`:

- `${VAR}` / `${VAR:fallback}` → 主色背景(`var(--accent)`)
- `\${...}` 转义 → 次色背景(`var(--muted)`),表示"字面不解析"

无新依赖,符合 loom 轻量风格。若叠加层同步滚动/字体对齐有坑,退路是引入 CodeMirror 自定义高亮(首选叠加层)。

## §5 Git 同步与边界

### Git 同步

`memories/*.md` 自动纳入 loom 仓库(已在 repo 内),随现有 `sync/pull`/`sync/push` 同步:

- `memories/*.md` 走文本合并策略(与 `assets/` 同:纯文本冲突检测,有冲突标记供 Sync 页面解决)
- `config.yaml` 的 `active_memory` 字段随 config 走现有深度对象合并(`mergeConfig`)
- 无需新增 merge kind

### 边界处理

| 情况                                | 行为                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `memories/` 为空或不存在            | `GET /memory` 返回空列表,`active=null`,投影跳过                                   |
| `active_memory` 指向不存在的 memory | 记入 `manifest.errors`,投影跳过 memory 阶段                                       |
| 删除激活的 memory                   | 自动清空 `active_memory`                                                          |
| 重命名激活的 memory                 | 同步更新 `active_memory = newName`                                                |
| name 不合法                         | 拒绝(见 §6 校验)                                                                  |
| name 已存在(新建)                   | `POST /memory` 拒绝,返回 409                                                      |
| `renderText` 抛 `ResolveError`      | 该 agent memory 写入失败,记 `logger.error({err,agent})`,投影 failure,回滚已写文件 |
| 文件首次创建(无备份)                | journal.undos 记 `restoreMemory` + `backup=null`,回滚时删除文件                   |

日志遵循 CLAUDE.md 规范:catch / 跳过 / 失败节点记 `logger.info`/`error` 带完整对象,不静默吞错。

## §6 repoPath → repo 整改(全局,配套)

### 需求

所有 API 参数 `repoPath` → `repo`(repo name,如 `default`),后端解析为 `~/.loom/repos/<repo>`。防路径遍历,不用正则,用目录列表精准匹配。

### repo 解析与校验(新建 `packages/server/src/api/repo.ts`)

```ts
import { join } from 'node:path'
import type { IFileSystem } from '../ports/fs.js'

async function listRepos(fs: IFileSystem, home: string): Promise<string[]> {
  const dir = join(home, '.loom', 'repos')
  try {
    return await fs.readDir(dir)
  } catch {
    return []
  }
}

export async function resolveRepoPath(
  fs: IFileSystem,
  repo: string,
  home: string,
): Promise<string> {
  const repos = await listRepos(fs, home)
  if (!repos.includes(repo)) {
    throw new Error(`invalid repo: ${repo}`) // 路由层捕获并返回 400
  }
  return join(home, '.loom', 'repos', repo)
}
```

- `../etc` 不在 repos 列表里,自然拒绝 → 天然防路径遍历
- 不用正则,不用 `startsWith` 二次防御
- 路由层 `try/catch` 捕获 `Error` 返回 400(或用 loom 现有 HTTP 错误处理机制)

### memory name 校验(同思路)

- **已存在操作**(读/删/重命名/激活):列 `memories/` 目录 → `includes(name)` 精准匹配
- **新建**:`target = join(memoriesDir, name)`;检查 `target.startsWith(memoriesDir + sep)` 防逃逸 + `!fs.exists(target)` 防重复(新建时还没进目录,用路径相对性检查,不用正则)

### 整改范围(机械重命名 + 集中校验)

- **后端**:所有路由 `body.repoPath`/`c.req.query('repoPath')` → `repo`,入口调 `resolveRepoPath(fs, repo, home)`;`readRepoFiles`/`readLocalConfig` 等内部函数参数名同步
- **前端**:`api.ts` 所有 `repoPath: string` → `repo: string`(约 30 处);所有 views 调用更新
- 影响 routes:projection/skills-yaml/mcp-yaml/config/sync/remote/health/memory;views:skills/mcp/sync/settings/memory;deps.ts、repo-config.ts

## 实现策略

1. **§6 整改先行**:建 `resolveRepoPath` + 校验,全局批量替换 `repoPath`→`repo`。与 memory 功能正交,先做让后续 memory 路由直接用新参数。
2. **paths.ts 修正**:opencode 分支统一 + 新增 `agentMemoryFile`。
3. **core 层**:`types.ts` 增加 Memory/MemoryManifest/Config.active_memory;`vars.ts` 增加 `renderText`;`readRepoFiles` 扩展读取 `memories/*.md`;`buildManifest`/`loadRepoManifest` 集成 memory;确认 `memories/*.md` 走文本合并。
4. **server 层**:`memory.ts` 路由;executor 增加 Phase D + scope;`projection.ts` 路由增加 scope 参数。
5. **web 层**:`Memory.tsx` + `MemoryEditor`;`App.tsx` 路由;`api.ts` 增加 memory 方法。
6. **测试**:`renderText`(转义、内置变量、未定义)、memory CRUD、scope 投影、`resolveRepoPath` 校验、`paths.ts` opencode 修正。

## 边界与风险

- **整文件覆盖会冲掉各工具文件里非 loom 内容**(CodeGraph 段、手写内容)—— 已确认接受,用户把所需内容写进主提示词。CodeGraph 等外部工具会自行重新注入。
- **`active_memory` 随 git 同步** —— 团队共享激活状态。若团队成员想用不同激活,需本地覆盖(本期不做,YAGNI)。
- **占位符高亮叠加层**的同步滚动/字体对齐是已知实现坑,退路是 CodeMirror。
- **skills/mcp 投影语义改变**(全投影→单资源)是用户明确要求,可能影响用户现有习惯(点 skills 投影不再顺带投影 mcp)。提供全局 `scope='all'` 入口作为补充。
