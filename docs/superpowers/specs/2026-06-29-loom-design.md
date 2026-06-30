# Loom 设计文档

## 背景

Loom 是一个自用的 code agent 周边设施管理工具。它解决的核心痛点是:Skills、MCP servers、prompts 等 agent 配置散落在多个 agent 各自的配置体系里,改一处要手动同步到 Claude Code、Codex、OpenCode 等多个 agent,多端(多台机器)之间也无法保证一致性。

Loom 的核心能力:配置一份,自动投影到多个 code agent;基于 Git 实现多端增量同步(合并而非覆盖);支持从 GitHub/Gitee 等远程仓库发现、安装、更新 Skills。

## 核心决策

### 运行形态

- WebUI 为日常操作主入口,可视化编辑配置、浏览状态
- CLI 次要,不作为主要交互方式
- 架构上为后续转桌面 GUI(Tauri)留口,核心逻辑与 Node 平台 API 解耦
- 定位:本机全局工具,放在 ~/.loom,不支持项目级别

### Agent 覆盖

- MVP: Claude Code + Codex(核心双雄)
- OpenCode 作为第三个验证适配层通用性
- 三者覆盖了三种不同的配置约定,把它们做透,适配层就沉淀出通用模式

### MVP 范围

- Skills(含远程源发现/安装/更新检查)
- MCP servers
- Prompts 和供应商凭证管理放第二批

### 技术栈

- Node/TypeScript 全栈
- 前端 React + Vite
- 前端 CSS/组件库:见"视觉设计规范"章节(Tailwind v4 + shadcn/ui)
- 后端 Express 或 Hono,REST API
- 后续转桌面 GUI 时用 Tauri(非 Electron),因此 Core 层必须纯 TS、零平台依赖

## 架构分层

系统切四层,关键约束是 Core 层纯 TS、零平台依赖,Tauri 迁移时只换 Platform 层。

### Core 层(纯 TS,零平台依赖)

大脑。所有业务逻辑在这,可纯单元测试覆盖。

- Manifest 模型与校验:定义"配置一份"的数据结构
- Projection:把 manifest 翻译成各 agent 原生配置格式的中间表示
- Merge Logic:结构化冲突解决(输入三方数据,输出合并结果或冲突标记)
- Version Compare:远程 skill 的更新检测
- Registry Index:远程源仓库的扫描缓存

### Platform 层(可替换接口)

手脚。定义为接口(IFileSystem、IGit、IProcess)。Node 实现一份,Tauri 迁移时换成 Rust binding 版本。

- fs:文件读写、软链/拷贝
- git:同步操作
- proc:进程检测(agent 是否安装)

### Adapter 层

翻译官,每个 agent 一个。吃进 manifest 片段,吐出该 agent 原生格式 + 落点路径。

- Claude Code Adapter:~/.claude/skills/ 软链,.mcp.json(JSON)
- Codex Adapter:~/.codex/skills/ 软链,config.toml(TOML)
- OpenCode Adapter:按其配置格式处理
- 新增 agent = 加一个 adapter,Core 不动

### UI 与 API 层

壳。API 薄层只做参数校验和调用编排,不写业务逻辑。前端 React + Vite。视觉风格与三态主题见"视觉设计规范"章节。

## 数据模型

> manifest 指一个配置仓内 skills.yaml + mcp.yaml + vars/*.yaml + 仓库级 config.yaml 的聚合(本地级 config.yaml 不属于 manifest)。全文 manifest 用词均指此聚合。

### 目录结构

```
~/.loom/
  config.yaml                    # 本地级配置(本机覆盖,不同步):active_repo/proxy 等
  repos/
    default/                     # 你的配置仓(git repo)
      .gitignore                 # 忽略 remote-cache/
      config.yaml                # 仓库级配置(随 git 同步,团队共享默认)
      skills.yaml                # 技能配置(sources: 远程仓库 + skills: 本地 skill)
      mcp.yaml                   # MCP servers 配置(单文件,所有 server 列表)
      vars/                      # 变量按 profile 分组(均入 git)
        default.yaml
        local.yaml
      assets/skills/             # local skill 的文件资产
        frontend-design/
          SKILL.md
      remote-cache/              # 远程 skill clone 缓存,loom 管理,git 不同步
        superpowers/
    friend-config/               # 共享配置仓(git repo)
      skills.yaml
      ...
```

### config.yaml(两级,本地覆盖仓库)

配置分两级,合并规则:本地级字段存在则覆盖仓库级,不存在则继承仓库级(回退用仓库值)。

仓库级 `<repo>/config.yaml`(随 git 同步,团队共享默认):

```yaml
profile: local                     # vars profile 覆盖档
targets: [claude-code, codex]      # 全局默认投影目标,member/mcp 未写 targets 时继承
projection:
  strategy: link                   # link | copy,默认 link
update_check:
  enabled: true
  interval: 6h
```

本地级 `~/.loom/config.yaml`(不同步,本机覆盖,只写差异):

```yaml
active_repo: default               # 本机当前激活的 repo(固定本地,不进仓库级)
proxy:                             # 本机网络环境,通常留本地级
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
  no_proxy: localhost,127.0.0.1
```

- active_repo 固定本地级(本机当前激活哪个 repo,同步无意义)
- proxy 通常本机不同,默认留本地级;也可在仓库级给默认,本地覆盖
- 任何字段都可在本地级覆盖仓库级;删除本地级行即回退继承仓库级(删行,非设空字符串)
- 嵌套对象(projection/update_check/proxy)深合并:本地级只写某子字段,其余继承仓库级;数组整体替换不做元素级合并

### skills.yaml(技能配置)

技能配置统一在 skills.yaml,分 `sources:`(远程仓库)和 `skills:`(本地 skill)两类。source 是远程 repo,含多个 member(多 member source);local skill 是单 member,资产在 assets/skills/<id>/。

```yaml
sources:                              # 远程技能源仓库(clone 到 remote-cache/)
  - url: github:obra/superpowers      # 只给 url,id 从 repo 名自动派生
    ref: v5.1.4
    # scan: skills/*/SKILL.md         # 可选,默认 **/SKILL.md 递归
    # members:                        # 只在需要覆盖某 member 时才列
    #   - name: brainstorming
    #     enabled: false
    #   - name: test-driven-development
    #     targets: [codex]

  - url: gitee:some/playwright-helper
    ref: main

skills:                               # 本地 skill(资产在 assets/skills/<id>/)
  - id: frontend-design               # path 默认 ./assets/skills/<id>,约定可省
  - id: my-helper
```

- source id 从 repo 名派生(github:obra/superpowers -> superpowers),用户不用填,重名时自动加后缀或提示改名
- scan 默认 **/SKILL.md 递归,匹配到的父目录就是 skill 根,目录名就是 member name;内置排除 .git/node_modules/.cache
- source id 同时充当 namespace,投影时落点目录名带 namespace 前缀(superpowers-brainstorming)
- members 不列则全启用、走全局 targets;列了即白名单覆盖:仅列出的 member 按覆盖项处理,未列出的 member 仍全启用走全局
- 覆盖项内未显式写的字段回退到全局默认(enabled 默认 true,targets 默认全局),非回退上次值
- local skill 的 id 即 assets/skills/ 下的目录名;path 默认 ./assets/skills/<id>,特殊位置才显式写
- local skill id 与 source 派生 id 允许同名(投影落点不同:local 不带前缀、source 带 namespace 前缀),UI 按类型分组区分

### MCP 配置(mcp.yaml,单文件)

所有 MCP server 在一个 mcp.yaml 里列表声明。type 取值 stdio/sse/http(默认 stdio):stdio 为 local 类(command+args+env),sse/http 为 remote 类(url+headers+env)。args/headers/env 值均支持 `${VAR}` 变量插值。

```yaml
- id: playwright
  type: stdio                         # stdio | sse | http,默认 stdio
  command: npx
  args: ["@executeautomation/playwright-mcp-server"]
  env:
    PLAYWRIGHT_BROWSERS_PATH: ${browsers_path}
  targets: [claude-code, codex]       # 逐项覆盖全局 targets

- id: zhipu
  type: sse
  url: https://api.zhipu.ai/mcp/sse
  headers:
    Authorization: Bearer ${ZHIPU_API_KEY}
  targets: [claude-code, codex]
```

### 变量系统(类 Spring Environment)

- 所有值支持:环境变量引用 ${VAR}、自定义变量引用 ${var_name}、明文字面值
- 变量解析规则:${VAR} 依次查 环境变量 -> active profile vars -> default profile vars,任一层命中即替换;三层都未命中时,若有 ${VAR:default} 则用 default,否则投影前校验失败(见下)。纯字面值(无 ${})原样使用,混合值(如 `Bearer ${TOKEN}`)按片段分别解析后拼接
- vars 按 profile 分文件:vars/default.yaml(入 git,兜底)、vars/local.yaml(入 git,覆盖)。MVP 不预置 prod(自用无 prod 环境),需要时再加。profile 名仅为档位标签,与「本地级配置」的 local 概念无关,vars/local.yaml 同样入 git 同步
- active profile 存本地级 config.yaml 的 profile 字段(不进 git 的本地级),每台机器各自维护;仓库级 config.yaml 可给团队默认 profile
- 引用未定义且无默认值的变量:投影前校验失败,标记该条目投影失败(不写入 agent 配置),UI 红色提示缺哪个变量,记日志带完整上下文;不静默替换空串或保留字面量
- WebUI 编辑器在值字段输入 ${ 时自动补全提示(已定义 vars + 常见环境变量名)

```yaml
# vars/default.yaml
browsers_path: ~/.cache/ms-playwright
work_root: ~/projects
```

### 敏感信息处理

- MVP 不加密,用 ${VAR} 引用本地环境变量
- loom 内部配置用 ${},投影到 agent 时解析为明文写入 agent 配置文件
- 明文密钥落到 agent 配置文件(不在 loom 仓库内,不进 git),本地磁盘明文
- 后续可引入投影后加密或权限收紧

## Skills 投影机制

### Local skill

assets/skills/<id>/ 里的资产,建软链到各 agent 落点。

```
~/.claude/skills/frontend-design/  ->  ~/.loom/repos/default/assets/skills/frontend-design/
~/.codex/skills/frontend-design/   ->  ~/.loom/repos/default/assets/skills/frontend-design/
```

### Remote skill

仓库 clone 到 remote-cache/<id>/（不进 git,可重建),checkout ref,每个 member 子目录软链到各 agent 落点。

```
# superpowers repo 扫描到的 brainstorming
~/.loom/repos/default/remote-cache/superpowers/skills/brainstorming/

# 投影到 Codex
~/.codex/skills/superpowers-brainstorming/  ->  .../remote-cache/superpowers/skills/brainstorming/
```

### 投影策略

- 全局配置项,默认 symlink,可选 copy
- Platform 层 IFileSystem 接口统一"创建指向 dir 的链接",Node 实现内部判断平台:macOS/Linux symlink,Windows 目录用 junction(无权限要求);IFileSystem 的 removeLink 语义为"只删链接本身,禁止递归删目标"(Windows junction 若用 rm -rf 递归会删目标真实内容,数据丢失级风险)
- Windows junction 约束:仅本地绝对路径目录、不可跨卷;落点路径统一规范化为绝对路径再建;跨卷(junction 目标在不同卷)自动降级 copy 并提示
- 投影作为事务:任一 agent 落点失败时,对本次已新建的软链/已拷贝文件清理回滚(解链或删除),remote-cache clone 保留(可重建不影响),失败信息回传 UI,保持本次投影前状态(失败不留半成品)
- 投影前确保目标目录存在;已有软链先解链再重建;目标是真实文件(用户手放)则报错不覆盖
- enabled: false 的 member 不建软链,已存在的对应软链会被清理;若落点已是真实文件/目录(非软链),跳过清理并记日志告警(不删用户数据),UI 提示需手动处理
- agent 未安装(proc 检测):该 agent 的 targets 自动跳过投影,UI 标灰"未安装";已安装后下次投影自动补上,不因单 agent 缺失阻断整次投影

### MCP 配置投影

- adapter 吃进 manifest 的 MCP 定义,生成对应格式片段
- 合并策略:以 MCP id 为 key,读已有 agent 配置 -> 有就替换、没有就插入、manifest 删了就移除;agent 原生配置无 id 字段时(Claude .mcp.json / Codex config.toml 按 server name),用 loom id 作为 server name 对齐
- type 变更(stdio↔sse↔http)视为该 id 条目整体重写,清理旧 type 独有字段(command/args 或 url/headers),避免残留
- agent 配置里 id 不在 manifest 的条目不碰(保护用户手写内容)
- 变量解析在投影时由 Core 层完成:${VAR} 写进 agent 配置前解析为明文

## 同步机制

### 设计原则

- Git 是唯一变更引擎,不维护额外的 changes 日志层
- 增量展示 = git log 渲染成语义事件("添加了 superpowers 源"而非"skills.yaml 第 42 行变了")
- 冲突 = 结构化 merge 失败的字段进 UI

### 同步流程

- **拉取**(一步 fetch + 程序内三向 merge):git fetch 取远程,以 `git merge-base FETCH_HEAD HEAD` 取共同祖先 base,读 base/本地/远程三份文件解析为 YAML AST 做节点级三向合并(非 git merge 的行级冲突标记);无冲突则写结果 + 重新投影,有冲突则进冲突 UI(拉取后提示冲突数,不单列 fetch 步)。冲突数据在内存/临时区持有,repo 始终保持干净可操作态(不落 `<<<<<<<` 标记、不进半合并态);UI 解决后写结果文件 + git add
- **冲突 UI**:结构化配置(skills.yaml/mcp.yaml/vars/*.yaml)走字段级三栏(本地/合并结果/远程,冲突字段高亮,用户选保留哪方);assets/skills/ 下文本文件(SKILL.md 等)冲突不在 WebUI 内做 diff,提供三入口外部解决——① 在编辑器打开(VSCode 打开 repo 根目录,用 merge editor 一次处理所有冲突文件,推荐)② 打开终端(cd repo,用 AI/git 修复)③ 复制 repo path;外部解决并 git add 后回 WebUI 点"重新检查"验证
- **上传**(push):推送本地改动(非 fast-forward 失败则提示重新拉取,不使用 force,避免覆盖别机新提交;单次 push 本身原子,ref 更新要么全成功要么全失败)。非 fast-forward 后必须用户重新拉取,不自动循环重试
- 后台定期冲突监测(轮询远程)为可选项,MVP 默认仅拉取时检测

### 结构化 merge

冲突范围覆盖配置仓所有文件:config.yaml(仓库级)、skills.yaml、mcp.yaml、vars/*.yaml 走结构化字段级 merge;assets/skills/ 下的文本文件(SKILL.md 等)非结构化,走外部工具解决(不内建 WebUI diff)。各文件合并 key:skills.yaml 的 sources 按 url(或派生 id)合并、skills 按 id 合并;mcp.yaml 按 id 合并列表项;vars/*.yaml 按顶层 key 合并;config.yaml 按顶层字段合并(嵌套对象深合并)。

- 两机各加一个 source/skill -> 自动合并,两边都保留
- 两机各删了不同的 source/skill -> 自动合并,都删
- 两机同时改了同一 source 的同一字段 -> 标记冲突,进三栏 UI
- assets 文本文件两机同改 -> 标记冲突,提供外部工具入口(VSCode 打开 repo / 终端 / 复制 path)
- 文件级冲突先由 git 检测,loom 解析后:yaml 配置按节点合并,文本文件交外部工具解决

### 不同步的内容

- remote-cache/（gitignored,可重建)
- 本地级 config.yaml(~/.loom/config.yaml,本机覆盖,不同步)

## 远程 Skills 发现与更新

### 发现

用户填 repo url -> loom 浅 clone(git clone --depth 1)到临时目录 -> 默认 glob **/SKILL.md 扫描 -> 展示 member 列表(目录名、SKILL.md frontmatter 的 name/description、路径）-> 标出已安装的 member。

### 安装

用户选择后 -> clone 到 remote-cache -> checkout ref -> 验证成功后写 skills.yaml 的 sources 项(url + ref + pinned_commit) -> 建投影软链。ref 不存在/clone/checkout 失败时不写入 skills.yaml,清理 remote-cache 半成品,UI 红色提示具体原因;与更新流程"保持旧 ref"语义对齐——安装失败保持"未安装"状态。

### 更新检测

- 触发:WebUI 手动"检查全部"或分组头单点 check,或后台定时轮询(可配置间隔)
- 逻辑:git ls-remote --tags 取远程 tag,和 manifest 锁定 ref 对比
- 有新 tag -> 分组头亮黄环 + 版本对比(`v5.1.4 → v5.1.5`)+ update 按钮,member 行标 will update
- manifest 存 tag(可读) + pinned_commit(hash):sources 项旁路记录锁定的 commit hash,checkout 以 pinned_commit 为准(ref 仅作人类可读标签),兑现可复现(git tag mutable,只存 tag 名会被上游移动 tag 破坏)
- 无 tag 的仓库:ref 填 main,更新检测退化为"远程 HEAD 和本地缓存 HEAD 是否一致",显示 `@ main · latest`

### 更新流程

- 用户点 `⟳ update` 才更新,不自动
- 步骤:git fetch + checkout 新 ref 到 remote-cache -> 改 skills.yaml 的 sources.ref + pinned_commit -> 重建该 source 投影软链(member 的 enabled/targets 是本地配置,不受影响)
- 更新后重新 scan,对 skills.yaml 中指向新 ref 已不存在的 member 覆盖项标记 orphan(孤儿),UI 提示该 member 已不存在,投影软链清理;覆盖项配置保留不自动删(等用户决定),避免 member 临时改名导致配置丢失
- 按钮状态:update → updating(spinner)→ updated(✓);失败(ref 不存在/checkout 失败)红色提示,保持旧 ref
- 更新只改本地 + 重新投影,不自动上传;弹 toast「已更新到 vX,需上传同步到别机」+ `去 Sync 上传` 入口,上传统一走 Sync 视图(单点入口)

## 多仓支持

- ~/.loom/repos/ 下每个子目录是独立 git 仓库
- active_repo 单选,只激活一个（MVP 不支持同时激活多个)
- 切换 repo 时 loom 先建新 repo 投影、验证成功、再清旧 repo 投影(避免清旧成功但建新失败导致两仓投影都不在);任一步失败 UI 明确提示当前投影状态,不静默中间态
- 外部共享配置仓 clone 进来即可使用

## 首次初始化

- loom 首次运行(~/.loom/ 不存在)自动创建骨架:~/.loom/config.yaml(本地级,默认 active_repo=default)、repos/default/(空 git repo + .gitignore 忽略 remote-cache/)、空但合法的 skills.yaml(sources: []、skills: [])、mcp.yaml([])、vars/default.yaml
- 空 repo 下投影为空操作(不报错),WebUI 引导用户 Add source 或导入已有配置仓
- active_repo 指向尚无内容的 default repo 时,各视图显示空状态 + 引导

## 未纳入 MVP 的内容

- Prompts / 自定义指令管理
- 供应商凭证管理(api_key、base_url、model 映射）
- 加密存储
- 同时激活多个 repo 的投影合并
- 项目级配置
- Branch 模式的远程 skill ref（MVP 只支持 tag/commit）

## 视觉设计规范

> 本节随 brainstorming 进展持续更新,记录已确认的视觉与技术决策。

### 视觉风格:Terminal Loom

深墨蓝底,翡翠绿作活跃信号。开发者工具气质,代码字体是母语舒适区。

signature 元素:投影连接线。在 source 详情展示 `manifest ──▶ agent` 的发光节点链(形态见下文"signature"小节),把"一份配置编织到多个 agent"的核心概念直接可视化,这是其他配置管理工具没有的记忆点。

### 三态主题

支持暗色、亮色、跟随系统三种模式,用 CSS 变量 + `prefers-color-scheme` 媒体查询 + 手动覆盖实现三态切换。

**暗色(深夜终端):**

| Token | 值 | 用途 |
|---|---|---|
| 背景 | `#0b1120` | 主区底色 |
| 导航 | `#0a0f1c` | 侧边栏底色 |
| 卡片 | `#131c2e` | 列表项/面板 |
| 边框 | `#1e293b` | 分隔线/卡片边框 |
| 主文字 | `#e2e8f0` | 正文 |
| 高亮文字 | `#f1f5f9` | 标题 |
| 次要文字 | `#64748b` | 元信息 |
| 信号绿 | `#34d399` | 已投影/运行中(active) |
| 警告黄 | `#fbbf24` | 有更新可用 |
| 错误红 | `#f87171` | 失败/destructive |
| info青 | `#38bdf8` | 链接/提示 |

**亮色(温暖纸感):**

| Token | 值 | 用途 |
|---|---|---|
| 背景 | `#faf8f3` | 主区底色(暖白) |
| 导航 | `#f0ede5` | 侧边栏底色(羊皮纸) |
| 卡片 | `#ffffff` | 列表项/面板 |
| 边框 | `#e4dcc8` | 分隔线/卡片边框 |
| 主文字 | `#2a2519` | 正文 |
| 高亮文字 | `#1c1917` | 标题 |
| 次要文字 | `#a89e85` | 元信息 |
| 信号绿 | `#0f7a52` | 已投影/运行中(深翠,保证亮底 4.5:1) |
| 警告黄 | `#a8731a` | 有更新可用(降档) |
| 错误红 | `#dc2626` | 失败/destructive |
| info青 | `#0284c7` | 链接/提示 |

设计意图:暗色是"深夜终端",亮色是"白天牛皮纸",冷暖呼吸形成戏剧性但不刺眼。两个模式共享翡翠绿信号语义,亮色降一档饱和度以满足对比度。

### 字体

- 标题/代码/路径:Fira Code(monospace)
- 正文/UI:Fira Sans

保留 Fira 家族(同族协调;Fira Code 连字 `=>` `->` `!==` 在展示 manifest/代码时有语义价值;避开 JetBrains+IBM Plex 这个开发者工具默认配方)。type scale(正文 line-height 1.6,数字用 tabular figures 防版本号/计数 layout shift):

| 角色 | 字体 | 字号/字重 | 处理 |
|---|---|---|---|
| display | Fira Code | 28/700 | -0.02em,页面标题 |
| h1/h2 | Fira Sans | 22/600,18/600 | — |
| body | Fira Sans | 14/400 | 1.6 line-height |
| label | Fira Sans | 12/500 | uppercase +0.04em,呼应终端 prompt |
| code/path | Fira Code | 13/400 | manifest、路径、配置片段 |

### 前端 CSS 与组件库

敲定 **Tailwind CSS v4 + shadcn/ui**。经 5 候选并行评估(shadcn/ui / Tailwind 自建 / CSS Modules+Radix / Mantine / Panda+Park UI),shadcn/ui 以"复制即拥有"模式让 Dialog/Popover/Combobox/Toast 等复杂交互组件近乎零成本到手且完全可定制,纯客户端 + 构建期 CSS 预期在 Tauri webview 三端可用(WebView2/wkwebview/webkit2gtk 渲染一致性需 Tauri 集成后实测),胜出。

实现约束:
- 不用 next-themes(hydration 假设偏 Next.js),纯 Vite 下自写 ~30 行 theme provider(监听 `prefers-color-scheme` + localStorage + 写 `data-theme`)
- shadcn 默认 dark 变体绑 `.dark` 类,改 `@custom-variant dark (&:is([data-theme=dark] *))` 贴合 data-theme 方案
- macOS Tauri hover bug(tauri#14987):v4 默认 `hover:` 经 `@media (hover: hover)` 门控在 macOS WebKit 不可靠,全局加 `@custom-variant hover (&:hover);` 规避
- shadcn 组件源码统一放 `src/components/ui/`,业务组件放 `src/components/`;Combobox/Command 基于 cmdk,变量补全定制放业务层
- 必做改造:换掉 new-york + zinc 默认观感(OKLCH 色板换深墨蓝/翡翠绿、全局 Fira 字体、重绘投影连接线),否则会"长得像所有 shadcn 应用"

### Agent 标识系统

agent chip 用圆形品牌色编码身份,填充/线框编码投影状态:
- 选中(投影到该 agent)= 品牌色实心圆 + 白色官方图标
- 未选(不投影)= 品牌色线框 + 半透明图标
- 整行未激活(所有 agent 关)= 灰色线框 + 灰图标
- 有更新 = 该 agent 节点脉冲黄环
- 陌生 agent(Loom 未内置图标)= 首字母 + 中性灰圆
- 图标用各 agent 官方 SVG(Claude/Anthropic、OpenAI/Codex、OpenCode 从其 brand 页下载,存为静态资源),mockup 阶段用简化占位

品牌色: CC(Claude Code)= `#D97757`(Anthropic 橙), CX(Codex)= `#06B6D4`(青), OC(OpenCode)= `#8B5CF6`(紫,待官方色确认)。三色均不撞信号绿 `#34d399`;未来加绿色品牌 agent 需做去重映射。圆形与投影线端节点统一视觉语言——"agent=圆点、线连圆点"贯穿,呼应织机 motif。

### 信息架构与导航

导航四项: **Skills / MCP servers / Sync / Settings**。

Sources 合并进 Skills: 数据层用 skills.yaml 统一管理,分 sources:(远程仓库)和 skills:(本地 skill)两类;UI 不单独露出 Sources 项,Skills 视图按 sources/skills 分组展示所有 skill。

- source 级操作(更新 ref / scan / 删除 / 发现安装新 source)放分组头菜单 + 顶部 `+ Add source`
- 更新检查的展示与操作在 Skills 视图(source 分组头亮黄 + 版本对比 + Update),不独立视图;member 行只有 projected / disabled 两态
- 顶部 hairline statusline: active repo / profile / 同步状态

### 视图布局

- **Skills**: 分组平铺列表,行内 agent chip 切换投影;点击 skill 名弹 shadcn Dialog 查看详情(chip + 投影路径 + SKILL.md 预览)。切换为主,详情偶发。source 有更新时分组头亮黄环 + 版本对比(`v5.1.4 → v5.1.5`)+ `⟳ update` 按钮,该 source 下 member 行标 `will update`;按钮状态流转 update → updating(spinner)→ updated(✓)。顶部"检查全部"批量检查 + 每分组头单点 check;导航 Skills 项带更新数 badge。更新是 source 级(整 repo 换 ref),非 member 级;检查范围仅远程 skill 仓库,MCP / local skills 不参与。无 tag 仓库显示 `@ main · latest`。
- **MCP servers**: master-detail。左 MCP 列表每行内联 3 个大尺寸 targets toggle(30px 圆角,品牌色,直接点击启停投影,无需展开)+ type 标签(stdio/sse/http)+ 投影计数;targets 启用/禁用是高频操作,大 toggle 保证易按。右编辑表单:type 切换器(local·stdio / remote·sse / remote·http)切换字段;local=command+args+env,remote=url+headers+env;args/headers/env 值均支持 `${VAR}` 变量插值(输入 `${` 触发 Combobox 补全,来源 vars/*.yaml + 环境变量)。MCP 投影按 id 合并进 agent 配置文件(`.mcp.json` JSON / `config.toml` TOML),非软链。
- **Sync**: 冲突解决用结合方案——结构化配置(skills.yaml/mcp.yaml/vars)走字段级三栏(本地/合并结果/远程,冲突字段高亮,点 local/remote 选保留哪方);assets 文本文件(SKILL.md 等)不在 WebUI 做 diff,改提供三入口外部解决(编辑器打开 repo 根目录为主 + 终端 + 复制 path,解决后回 WebUI 重新检查)。顶部 syncbar 显示冲突数 + 拉取/上传(拉取=一步 fetch+merge,拉取后自动检测冲突并提示;不单列 fetch);底部语义事件流(git log 渲染成 added/updated/removed source 事件,区分机器)。
- **Settings**: 顶部分类 tab(通用/网络,按功能分不无脑,预留扩展)+ 三态切换(最终结果/仓库级/本地级)。最终结果=合并生效值+左圆点来源标识(绿=生效自仓库级/蓝=生效自本地级/灰=两处都未设/蓝锁=固定本地);圆点颜色由该字段实际生效值的来源决定。仓库级=编辑团队共享默认(随 git 同步),无值字段占位「未设置」;本地级=编辑本机覆盖,未覆盖字段继承仓库级(空心灰圆点,与最终结果的实心灰区分),编辑或点圆点即覆盖(变实心蓝),再点删除回退继承(删本地行,非空字符串)。蓝锁仅用于语义上不可进仓库级的固定本地字段(当前仅 active_repo)。active_repo 固定本地级。配置两级:仓库级 `<repo>/config.yaml`(同步)+ 本地级 `~/.loom/config.yaml`(不同步,覆盖)。

### signature:投影连接线

source 详情展示 `manifest ──▶ agent` 节点链: hairline 细线 + 沿线流动小光点(dataflow 感),agent 端是带缩写的品牌色圆点节点(CC/CX/OC)。enabled:false 的 member 线虚化、节点暗淡;有更新的 agent 节点脉冲黄环。尊重 `prefers-reduced-motion`(光点静止)。这是 Loom 区别于其他配置管理工具的记忆点。
