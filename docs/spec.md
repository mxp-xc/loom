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

壳。API 薄层只做参数校验和调用编排,不写业务逻辑。前端 React + Vite。

## 数据模型

### 目录结构

```
~/.loom/
  config.yaml                    # 本机全局设置(代理、策略、激活 repo),不进任何 repo
  repos/
    default/                     # 你的配置仓(git repo)
      .gitignore                 # 忽略 remote-cache/
      sources.yaml               # 技能源聚合配置
      mcp/                       # MCP 配置,一文件可多项或一项一文件
      vars/                      # 变量按 profile 分组
        default.yaml
        local.yaml
        prod.yaml
      local.yaml                 # active profile 等本机设置,不进 git
      assets/skills/             # local skill 的文件资产
        frontend-design/
          SKILL.md
      remote-cache/              # 远程 skill clone 缓存,loom 管理,git 不同步
        superpowers/
    friend-config/               # 共享配置仓(git repo)
      sources.yaml
      ...
```

### config.yaml(本机全局)

```yaml
active_repo: default               # 当前激活的 repo,单选
profile: local                     # vars profile 覆盖
projection:
  strategy: link                   # link | copy,默认 link
proxy:
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
  no_proxy: localhost,127.0.0.1
update_check:
  enabled: true
  interval: 6h
```

### sources.yaml(技能源)

核心模型:source 是主单元,member 是 source 内部的覆盖项。local skill 是单成员 source,remote skill 仓库是多成员 source。所有 source 同级一致。

```yaml
sources:
  - url: github:obra/superpowers     # 只给 url,id 从 repo 名自动派生
    ref: v5.1.4
    # scan: skills/*/SKILL.md        # 可选,默认 **/SKILL.md 递归
    # members:                       # 只在需要覆盖某 member 时才列
    #   - name: brainstorming
    #     enabled: false
    #   - name: test-driven-development
    #     targets: [codex]

  - url: gitee:some/playwright-helper
    ref: main

  - url: ./assets/skills/frontend-design   # 本地路径,type 自动识别
```

- id 从 repo 名派生(github:obra/superpowers -> superpowers),用户不用填,重名时自动加后缀或提示改名
- scan 默认 **/SKILL.md 递归,匹配到的父目录就是 skill 根,目录名就是 member name
- 内置排除 .git/node_modules/.cache
- source id 同时充当 namespace,投影时落点目录名带 namespace 前缀(superpowers-brainstorming)
- members 不列则全启用、走全局 targets;列了就按覆盖项处理

### MCP 配置

```yaml
- id: playwright
  command: npx
  args: ["@executeautomation/playwright-mcp-server"]
  env:
    PLAYWRIGHT_BROWSERS_PATH: ${browsers_path}
  targets: [claude-code, codex]       # 逐项覆盖全局 targets
```

### 变量系统(类 Spring Environment)

- 所有值支持:环境变量引用 ${VAR}、自定义变量引用 ${var_name}、明文字面值
- 优先级:环境变量 > active profile vars > default profile vars > 字面值
- 支持默认值语法 ${NAME:default}
- vars 按 profile 分文件:vars/default.yaml(入 git,兜底)、vars/local.yaml(入 git,覆盖)、vars/prod.yaml(入 git,覆盖)
- active profile 存 local.yaml(不进 git),每台机器各自维护
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
- Platform 层接口统一,Node 实现内部判断平台(macOS/Linux symlink,Windows junction)
- 投影前确保目标目录存在;已有软链先解链再重建;目标是真实文件(用户手放)则报错不覆盖
- enabled: false 的 member 不建软链,已存在的对应软链会被清理

### MCP 配置投影

- adapter 吃进 manifest 的 MCP 定义,生成对应格式片段
- 合并策略:以 MCP id 为 key,读已有 agent 配置 -> 有就替换、没有就插入、manifest 删了就移除
- agent 配置里 id 不在 manifest 的条目不碰(保护用户手写内容)
- 变量解析在投影时由 Core 层完成:${VAR} 写进 agent 配置前解析为明文

## 同步机制

### 设计原则

- Git 是唯一变更引擎,不维护额外的 changes 日志层
- 增量展示 = git log 渲染成语义事件("添加了 superpowers 源"而非"sources.yaml 第 42 行变了")
- 冲突 = 结构化 merge 失败的字段进 UI

### 同步流程

1. git fetch
2. 尝试结构化 merge（按 YAML 节点合并,非文本行）
3. 有冲突 -> 进三栏 UI（本地/合并结果/远程）,冲突字段高亮,用户选择保留哪方
4. 无冲突或解决后 -> 重新投影
5. push 本地改动

### 结构化 merge

- 两机各加一个 source -> 自动合并,两边都保留
- 两机各删了不同的 source -> 自动合并,都删
- 两机同时改了同一 source 的同一字段 -> 标记冲突,进 UI
- 文件级冲突先由 git 检测,loom 解析后按节点合并

### 不同步的内容

- remote-cache/（gitignored,可重建)
- local.yaml（active profile 等本机设置)
- ~/.loom/config.yaml（本机全局设置)

## 远程 Skills 发现与更新

### 发现

用户填 repo url -> loom 浅 clone(git clone --depth 1)到临时目录 -> 默认 glob **/SKILL.md 扫描 -> 展示 member 列表(目录名、SKILL.md frontmatter 的 name/description、路径）-> 标出已安装的 member。

### 安装

用户选择后 -> 写 sources.yaml（url + ref) -> clone 到 remote-cache -> checkout ref -> 建投影软链。

### 更新检测

- 触发:WebUI 手动点"检查更新"或后台定时轮询(可配置间隔)
- 逻辑:git ls-remote --tags 取远程 tag,和 manifest 锁定 ref 对比
- 有新 tag -> WebUI 亮标记,展示"当前 v5.1.4 -> 最新 v5.1.5"
- 用户确认才更新,不自动
- manifest 存 tag(可读),投影时以 tag 对应 commit hash 为准 checkout（可复现)
- 无 tag 的仓库:ref 填 main,更新检测退化为"远程 HEAD 和本地缓存 HEAD 是否一致"

## 多仓支持

- ~/.loom/repos/ 下每个子目录是独立 git 仓库
- active_repo 单选,只激活一个（MVP 不支持同时激活多个)
- 切换 repo 时 loom 先清掉当前 repo 的投影,再建新 repo 的投影
- 外部共享配置仓 clone 进来即可使用

## 未纳入 MVP 的内容

- Prompts / 自定义指令管理
- 供应商凭证管理(api_key、base_url、model 映射）
- 加密存储
- 同时激活多个 repo 的投影合并
- 项目级配置
- Branch 模式的远程 skill ref（MVP 只支持 tag/commit）
