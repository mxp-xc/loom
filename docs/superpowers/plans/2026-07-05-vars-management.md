# Vars Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立独立的 typed vars 管理基础设施，支持多环境、有序链覆盖、变量引用、依赖诊断、管理 API 和三栏 Web UI。

**Architecture:** Core 提供无 IO 的 typed model、codec、resolver、引用图和 mutation；Server 用原子文件存储把领域能力暴露为 Hono API；Web 通过专用 API client/hook 管理环境、变量、预览链和诊断。具体 Skills/MCP 消费接入不在本计划内。

**Tech Stack:** TypeScript 5.9、Zod、js-yaml、Hono、React 18、Vite、Tailwind CSS v4、CodeMirror 6、Vitest、Testing Library、Playwright CLI。

---

## 执行约束

- 开始页面任务前必须依次加载 `ui-ux-pro-max`、`frontend-design`，并以 `docs/ui/` 为既有设计约束。
- 功能和修复遵循 `superpowers:test-driven-development`；完成声明前使用 `superpowers:verification-before-completion`。
- 前端完成后必须使用 `playwright-cli` 自动验证，并使用带 session 的命令。
- 下列 Commit 步骤仅表示建议检查点；执行时仍须先获得用户对 Git commit 的明确授权。
- 不创建分支或 worktree，除非执行阶段另获用户授权。

## 文件结构

| 文件                                                   | 职责                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `packages/core/src/vars-types.ts`                      | typed entry、环境、diagnostic、resolution 公共类型与 schema |
| `packages/core/src/vars-codec.ts`                      | typed/legacy YAML 数据的解析、规范化与序列化                |
| `packages/core/src/vars.ts`                            | 纯 resolver、模板引用解析、来源追踪                         |
| `packages/core/src/vars-graph.ts`                      | 引用图、循环、删除/重命名影响分析                           |
| `packages/core/src/vars-mutators.ts`                   | 环境内 set/delete/rename 的纯 mutation 与校验               |
| `packages/server/src/vars/store.ts`                    | vars 目录 IO、路径校验、原子多文件写入                      |
| `packages/server/src/api/routes/vars.ts`               | Vars HTTP API 和错误映射                                    |
| `packages/web/src/lib/vars.ts`                         | Web 专用 DTO、格式化和 UI 辅助类型                          |
| `packages/web/src/hooks/useVars.ts`                    | 查询、mutation、刷新和错误状态                              |
| `packages/web/src/views/vars/Vars.tsx`                 | 页面编排与三栏状态                                          |
| `packages/web/src/views/vars/EnvironmentSidebar.tsx`   | 环境列表和预览链编辑                                        |
| `packages/web/src/views/vars/VariableList.tsx`         | 搜索、列表、类型和诊断摘要                                  |
| `packages/web/src/views/vars/VariableEditor.tsx`       | typed editor、预览、引用关系和保存                          |
| `packages/web/src/views/vars/StringValueEditor.tsx`    | `${` 补全、引用高亮和 secret 显隐                           |
| `packages/web/src/views/vars/JsonValueEditor.tsx`      | CodeMirror JSON 编辑、格式化和校验                          |
| `packages/web/src/views/vars/DeleteVariableDialog.tsx` | 两阶段删除影响确认                                          |
| `packages/web/src/views/vars/vars.css`                 | Vars 页面局部布局与状态样式                                 |

### Task 1: 定义 typed vars 模型与 codec

**Files:**

- Create: `packages/core/src/vars-types.ts`
- Create: `packages/core/src/vars-codec.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/manifest.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/vars-codec.test.ts`
- Test: `packages/core/test/manifest.test.ts`

- [ ] **Step 1: 写 codec 失败测试**

覆盖显式五类型、非法 key、`NaN`、legacy 全部按 string、typed round-trip：

```ts
it('loads legacy scalars as strings without inference', () => {
  expect(parseVarsEnvironment('port: 3000\nenabled: true\n')).toEqual({
    format: 'legacy',
    entries: {
      port: { type: 'string', value: '3000' },
      enabled: { type: 'string', value: 'true' },
    },
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test -- packages/core/test/vars-codec.test.ts`
Expected: FAIL，`parseVarsEnvironment` 尚未导出。

- [ ] **Step 3: 实现公共类型、Zod schema 与 codec**

```ts
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type VarEntry =
  | { type: 'string' | 'secret'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'json'; value: JsonValue }
export interface VarsEnvironment {
  format: 'legacy' | 'typed'
  entries: Record<string, VarEntry>
}
export const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
```

`parseVarsEnvironment` 将 legacy scalar 规范化为字符串：number/boolean 使用 `String(parsedValue)`，YAML string 保持解析后的字符串值；`null`、数组、对象在 legacy 文件中返回 `legacy_value_invalid`。首版不引入 YAML AST，也不承诺保留引号、数字前导零等原始排版。

- [ ] **Step 4: 调整 manifest 聚合**

`RepoManifest.varsFiles` 改为 `Record<string, VarsEnvironment>`；`loadRepoManifest` 调 codec。保留 `Manifest.vars.default/active` 的兼容投影视图，值由 entry 转为字符串，避免本计划扩张到 MCP 接入。

- [ ] **Step 5: 运行 Core 测试**

Run: `bun run test -- packages/core/test/vars-codec.test.ts packages/core/test/manifest.test.ts packages/core/test/vars.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): add typed vars model and codec"
```

### Task 2: 实现环境链 resolver

**Files:**

- Modify: `packages/core/src/vars.ts`
- Test: `packages/core/test/vars.test.ts`

- [ ] **Step 1: 写覆盖与引用失败测试**

```ts
it('resolves later environments and references final visible values', () => {
  const result = resolveVarsChain(envs, ['base', 'local', 'prod'])
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.values['api.port']).toEqual({ type: 'number', value: 9000 })
    expect(result.values['api.url']).toEqual({ type: 'string', value: 'http://localhost:9000' })
    expect(result.sources['api.url']).toBe('base')
  }
})
```

同时覆盖默认值、跨类型字符串化、递归引用、缺失引用、重复/不存在环境、只查 vars 而不查 `process.env`。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test -- packages/core/test/vars.test.ts`
Expected: FAIL，`resolveVarsChain` 尚不存在。

- [ ] **Step 3: 实现 discriminated result 与 resolver**

```ts
export type VarsResolutionResult =
  | {
      ok: true
      values: Record<string, VarEntry>
      sources: Record<string, string>
      dependencies: Record<string, string[]>
      diagnostics: VarsDiagnostic[]
    }
  | { ok: false; diagnostics: VarsDiagnostic[] }

export function resolveVarsChain(
  environments: Record<string, VarsEnvironment>,
  chain: string[],
): VarsResolutionResult
```

引用 regex 必须支持点和连字符；默认值不递归解析。DFS 使用 `visiting` 栈返回完整 cycle path。Secret 在 Core 中保留真实值，遮罩由传输/UI 层控制。

- [ ] **Step 4: 保留当前投影兼容入口**

让旧 `resolveVars(value, ctx)` 变为明确的 deprecated wrapper，只读取 `activeProfile/defaultProfile`，删除 `env` 优先级；更新相应测试和调用类型，不增加新消费能力。

- [ ] **Step 5: 运行 Core 全套测试**

Run: `bun run test -- packages/core`
Expected: PASS。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add packages/core/src/vars.ts packages/core/test/vars.test.ts
git commit -m "feat(core): resolve typed vars chains"
```

### Task 3: 实现引用图与纯 mutators

**Files:**

- Create: `packages/core/src/vars-graph.ts`
- Create: `packages/core/src/vars-mutators.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/vars-graph.test.ts`
- Test: `packages/core/test/vars-mutators.test.ts`

- [ ] **Step 1: 写依赖影响测试**

```ts
it('returns direct and transitive delete impact', () => {
  expect(inspectVariableDelete(envs, 'base', 'host')).toEqual({
    direct: [{ environment: 'base', key: 'url' }],
    transitive: [{ environment: 'prod', key: 'health-url' }],
  })
})
```

加入 rename 原子重写 `${old}` 但不误改 `${old-name}`、确认删除产生 warning、无关编辑不扩大 warning 可保存的测试。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test -- packages/core/test/vars-graph.test.ts packages/core/test/vars-mutators.test.ts`
Expected: FAIL，graph/mutator API 尚不存在。

- [ ] **Step 3: 实现引用提取、反向图和 mutation result**

```ts
export interface MutationResult {
  environments: Record<string, VarsEnvironment>
  changed: string[]
  diagnostics: VarsDiagnostic[]
}
```

`renameVariable` 返回所有受影响环境的新快照；`deleteVariable(..., { confirmed: false })` 在存在依赖时返回 `delete_confirmation_required`，confirmed 后保留悬空引用及 warning。

- [ ] **Step 4: 运行测试与 typecheck**

Run: `bun run test -- packages/core && bun --filter @loom/core build`
Expected: PASS。

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): add vars dependency diagnostics"
```

### Task 4: 实现原子 VarsStore

**Files:**

- Create: `packages/server/src/vars/store.ts`
- Modify: `packages/server/src/ports/fs.ts`
- Modify: `packages/server/src/platform/node/fs.ts`
- Test: `packages/server/test/vars/store.test.ts`
- Test: `packages/server/test/platform/node-fs.test.ts`

- [ ] **Step 1: 写路径与原子写失败测试**

覆盖非法环境名/路径穿越、单文件替换、多文件 rename 中途失败后回滚、临时文件清理。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test -- packages/server/test/vars/store.test.ts`
Expected: FAIL，`VarsStore` 尚不存在。

- [ ] **Step 3: 扩展文件系统端口并实现 store**

```ts
interface IFileSystem {
  createLink(targetDir: string, linkPath: string): Promise<{ fallback: 'copy' | null }>
  removeLink(linkPath: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  mkdir(path: string, recursive?: boolean): Promise<void>
  readDir(path: string): Promise<string[]>
  isLink(path: string): Promise<boolean>
  copyDir(src: string, dest: string): Promise<void>
  move(src: string, dest: string): Promise<void>
  removeDir(path: string): Promise<void>
  replaceFile(tempPath: string, targetPath: string): Promise<void>
  removeFile(path: string): Promise<void>
}
```

`VarsStore.writeMany` 先写同目录临时文件、保留原内容 journal，再逐一 replace；失败时逆序恢复并调用 `logger.error({ err, files }, 'vars atomic write failed')`。

- [ ] **Step 4: 运行 Server 相关测试**

Run: `bun run test -- packages/server/test/vars/store.test.ts packages/server/test/platform/node-fs.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): add atomic vars store"
```

### Task 5: 暴露 Vars HTTP API

**Files:**

- Create: `packages/server/src/api/routes/vars.ts`
- Modify: `packages/server/src/api/router.ts`
- Modify: `packages/server/src/api/repo-config.ts`
- Test: `packages/server/test/api/vars-routes.test.ts`

- [ ] **Step 1: 写 API 契约失败测试**

覆盖：列环境、读取环境、创建/删除环境、set/rename/delete variable、inspectDelete、resolve、400 稳定错误码、500 完整日志对象。

```ts
const res = await app.request('/api/vars/resolve', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoPath, chain: ['base', 'prod'] }),
})
expect(await res.json()).toMatchObject({ ok: true, sources: { 'api.url': 'base' } })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test -- packages/server/test/api/vars-routes.test.ts`
Expected: FAIL，routes 未注册。

- [ ] **Step 3: 实现路由与错误映射**

使用 `/vars/environments`、`/vars/variables`、`/vars/variables/rename`、`/vars/variables/delete-impact`、`/vars/resolve`。Secret 默认返回 `{ masked: true, value: '••••••••' }`；仅编辑详情的显式 reveal 请求返回真实值。

- [ ] **Step 4: 修复现有 repo-config 静默 catch**

对 vars 目录/文件读取失败使用完整错误日志；仅 `ENOENT` 作为正常缺失处理。不得保留空 catch。

- [ ] **Step 5: 运行 Server 全套测试**

Run: `bun run test -- packages/server`
Expected: PASS。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): expose vars management api"
```

### Task 6: 建立 Web 数据层与页面骨架

**Files:**

- Modify: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/lib/vars.ts`
- Create: `packages/web/src/hooks/useVars.ts`
- Create: `packages/web/src/views/vars/Vars.tsx`
- Create: `packages/web/src/views/vars/EnvironmentSidebar.tsx`
- Create: `packages/web/src/views/vars/VariableList.tsx`
- Create: `packages/web/src/views/vars/vars.css`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/test/vars-view.test.tsx`

- [ ] **Step 1: 加载 UI 设计技能并检查规范**

依次使用 `ui-ux-pro-max`、`frontend-design`，阅读 `docs/ui/index.md` 指向的相关规范。保持已批准的三栏信息架构；技能只细化排版、状态、响应式和可访问性，不改变产品语义。

- [ ] **Step 2: 写页面骨架失败测试**

```tsx
it('selects an environment and builds an ordered preview chain', async () => {
  render(<Vars repoPath="/repo" />)
  expect(await screen.findByRole('button', { name: /base/ })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /local/ }))
  expect(screen.getByText('base → local')).toBeDefined()
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun run test -- packages/web/test/vars-view.test.tsx`
Expected: FAIL，Vars view 尚不存在。

- [ ] **Step 4: 实现 typed API、hook、路由和三栏骨架**

在侧栏 workspace 区加入 `/vars`；`useVars(repoPath)` 管理 environments、selectedEnvironment、previewChain、reload 和 mutation pending/error。使用项目现有 `Button`、`Modal`、`Toast` 与 CSS variables。

- [ ] **Step 5: 运行 Web 测试**

Run: `bun run test -- packages/web/test/vars-view.test.tsx packages/web/test/views.test.tsx`
Expected: PASS。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add packages/web/src packages/web/test/vars-view.test.tsx
git commit -m "feat(web): add vars management workspace"
```

### Task 7: 实现 typed editors、补全和解析预览

**Files:**

- Modify: `packages/web/package.json`
- Modify: `bun.lock`
- Create: `packages/web/src/views/vars/VariableEditor.tsx`
- Create: `packages/web/src/views/vars/StringValueEditor.tsx`
- Create: `packages/web/src/views/vars/JsonValueEditor.tsx`
- Modify: `packages/web/src/views/vars/Vars.tsx`
- Test: `packages/web/test/vars-editors.test.tsx`

- [ ] **Step 1: 安装 CodeMirror 依赖**

Run: `bun add --filter @loom/web @uiw/react-codemirror @codemirror/lang-json @codemirror/autocomplete`
Expected: `packages/web/package.json` 和 `bun.lock` 更新，无 npm/pnpm 文件。

- [ ] **Step 2: 写 editor 失败测试**

覆盖五种类型、`${` 候选的 key/type/source/value、secret 默认遮罩/临时显示、JSON 格式化和非法 JSON 阻止保存。

- [ ] **Step 3: 运行测试确认失败**

Run: `bun run test -- packages/web/test/vars-editors.test.tsx`
Expected: FAIL，editor components 尚不存在。

- [ ] **Step 4: 实现编辑器**

String autocomplete 仅使用 `/vars/resolve` 返回的可见 vars，不读取浏览器或服务端环境变量。Secret 候选与预览必须遮罩。JSON 编辑器启用 `json()` language、括号补全、lint、format 按钮；格式化使用 `JSON.stringify(JSON.parse(value), null, 2)`，catch 记录并显示完整编辑错误。

- [ ] **Step 5: 实现保存与实时预览**

保存前调用 server validate；输入预览使用 200ms debounce，并用 request sequence 丢弃过期响应。错误诊断定位到 key 和引用链。

- [ ] **Step 6: 运行测试与构建**

Run: `bun run test -- packages/web/test/vars-editors.test.tsx && bun --filter @loom/web build`
Expected: PASS。

- [ ] **Step 7: Commit（需用户授权）**

```bash
git add packages/web/package.json bun.lock packages/web/src/views/vars packages/web/test
git commit -m "feat(web): add typed vars editors"
```

### Task 8: 实现删除影响、重命名与 warning UX

**Files:**

- Create: `packages/web/src/views/vars/DeleteVariableDialog.tsx`
- Modify: `packages/web/src/views/vars/VariableEditor.tsx`
- Modify: `packages/web/src/views/vars/VariableList.tsx`
- Modify: `packages/web/src/hooks/useVars.ts`
- Test: `packages/web/test/vars-diagnostics.test.tsx`

- [ ] **Step 1: 写诊断交互失败测试**

验证删除先显示 direct/transitive 影响、未确认不调用 delete、确认后 yellow warning、rename 后引用更新、warning 修复后消失。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test -- packages/web/test/vars-diagnostics.test.tsx`
Expected: FAIL，删除确认 UI 尚不存在。

- [ ] **Step 3: 实现两阶段删除和重命名**

Dialog 明确列出 `environment / key`；确认请求携带 server 返回的 impact token，避免检查后数据变化导致 TOCTOU。Mutation 成功统一 reload，失败通过 Toast 和字段内诊断同时呈现。

- [ ] **Step 4: 实现 warning 状态**

列表使用黄色左边框与警告图标；编辑器显示缺失 key、来源环境和引用路径。警告不得只靠颜色表达。

- [ ] **Step 5: 运行 Web 全套测试**

Run: `bun run test -- packages/web`
Expected: PASS。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add packages/web/src/views/vars packages/web/src/hooks/useVars.ts packages/web/test
git commit -m "feat(web): add vars dependency diagnostics"
```

### Task 9: 回归、端到端验证与文档收尾

**Files:**

- Create: ignored project-local E2E fixture script（当前仓库未配置 Playwright test runner，使用可重复 CLI fixture）
- Create: ignored project-local E2E transcript
- Modify: `docs/index.md`
- Modify: `docs/ui/index.md`
- Create: `docs/ui/vars.md`

- [ ] **Step 1: 写 Playwright 场景**

覆盖环境创建、五类变量、`${` 补全、`base → local → prod` 预览、循环错误、删除确认与 warning 修复。

- [ ] **Step 2: 运行全部单元测试与构建**

Run: `bun run test && bun run build`
Expected: 全部 PASS，三个 workspace 构建成功。

- [ ] **Step 3: 启动应用并用 Playwright CLI 验证**

先生成 session：

```bash
PYTHONIOENCODING='utf-8' uv run python -c "import uuid; print('vars-' + uuid.uuid4().hex[:8])"
```

Run: start the app with an isolated project-local HOME and dedicated API port.
Expected: Web `5173`、API `3100` 可访问，数据只写入隔离 HOME。

使用上一步 session 执行 `playwright-cli -s=<session> open http://localhost:5173/vars`，运行完整交互并保存截图到 ignored project-local evidence files。不得裸调用 `open`，不得安装浏览器。

- [ ] **Step 4: 检查日志和文件结果**

确认没有静默错误、secret 默认遮罩、typed YAML 正确、失败写入不遗留临时文件。若发现 bug，先使用 `superpowers:systematic-debugging` 再修复并重跑相关验证。

- [ ] **Step 5: 更新当前事实文档**

`docs/ui/vars.md` 只记录页面入口、三栏职责、类型控件、诊断状态和验证命令；不记录实施历史。更新两个 index 链接。

- [ ] **Step 6: 最终 diff 与状态检查**

Run: `git status --short && git diff --check && git diff --stat`
Expected: 仅本特性文件，无 whitespace error，无 ignored temporary evidence、`.superpowers/` 或无关改动待提交。

- [ ] **Step 7: 最终 Commit（需用户授权）**

```bash
git add packages/core packages/server packages/web docs/index.md docs/ui/index.md docs/ui/vars.md bun.lock
git commit -m "feat: add typed vars management"
```
