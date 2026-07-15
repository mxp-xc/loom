# MCP Workbench 高保真生产实现计划

> **For agentic workers:** 按任务顺序执行。视觉识图任务必须 fan out 到一次性 subagent；主 agent 禁止读取截图，只接收结构化文字结论并修复。

**Goal:** 将已确认的 MCP 高保真原型完整迁入生产 Web 应用，使列表、抽屉、详情、新增/编辑、JSON、变量、Tools、排序、弹窗、反馈、主题和响应式布局与原型保持一致，同时保留真实 MCP API、规则和错误处理。

**High-fidelity source:** `temp/prototypes/mcp-editor-feedback/`

- 结构与交互：`temp/prototypes/mcp-editor-feedback/src/v2.tsx`
- 视觉、尺寸与断点：`temp/prototypes/mcp-editor-feedback/src/v3.css`
- 当前事实与验证记录：`temp/prototypes/mcp-editor-feedback/prototype-manifest.md`
- 设计约束：`docs/superpowers/specs/2026-07-14-mcp-workbench-editor-redesign-design.md`

**Priority:** 业务与安全冲突时以 `docs/rules/mcp.md` 及服务端契约为准；视觉、排版、尺寸、颜色、动效和响应式冲突时以高保真原型为准。生产代码不得 import `temp/`。

**Tech Stack:** React, TypeScript, CSS Modules, Monaco, Radix Dialog, dnd-kit, Vitest, Testing Library, Playwright CLI

## Global Constraints

- 生产 MCP 页面必须与高保真原型的 DOM 分组、视觉 tokens、列宽、抽屉尺寸、固定 header/footer、sticky tabs、字号、间距、颜色和断点一致；禁止实现成“相似版本”。
- 默认亮色，暗色使用原型的低眩光映射。验证视口至少包含 `1575x1272`、`1512x982`、`1440x900`、`1280x800`、`390x844`。
- Targets 只在列表行和 `Apply all` 编辑；Detail、Editor、JSON 和 Preview 不编辑 targets。保存定义必须保留当前 targets，不自动 Project changes。
- Tools 只连接已保存 Server。Edit 使用“保存并连接”，Create 使用“创建并连接”；产品中不展示 draft/stale session。
- 保留现有 Import、Project changes、变量解析、MCP debug API、reorder API 和日志边界。后端 `source: 'draft'` 暂时保持兼容，但 Web 不再调用；不把 UI 重设计扩大成 API 删除。
- 原型仅保留到全部视觉验收通过。最终删除原型目录及其 artifacts/junction，不提交 fixture、截图或临时验证产物。
- 主 agent 不得调用 `view_image` 或自行读取截图。所有图片判断只由一次性视觉 subagent 完成。

## Prototype Cleanup Contract

迁移时只保留产品行为和视觉，不复制以下 prototype-only 内容：

- `fixtures`、`variableDetails`、`debugTools` 等演示数据。
- 模拟保存、连接、调用的 `setTimeout`，假结果、假耗时和固定 token。
- `acme/tooling`、伪 workspace 状态、演示计数等静态 shell 文案；生产值继续来自现有 App/manifest。
- 原型轮次说明、设计解释、浏览器反馈记录和仅用于演示的注释。
- 未渲染的旧 CSS（例如淘汰的 editor targets、大型 targets、旧 fixed workbench 选择器）和重复样式。
- 可以从正式组件/API/类型推导的包装函数与低价值注释。仅对非显然的 JSON 同步、保存并连接、session cleanup 和回滚边界保留简短注释。

---

### Task 1: Freeze Fidelity Baseline and Test Fixtures

**Files:**

- Reference: `temp/prototypes/mcp-editor-feedback/src/v2.tsx`
- Reference: `temp/prototypes/mcp-editor-feedback/src/v3.css`
- Modify: `packages/web/test/mcp-view.test.tsx`

- [ ] 创建确定性的 MCP Web 测试 fixture：四种 server、长 arguments、remote headers、`${...}`、Tools schemas/results、错误响应和 reorder 响应。
- [ ] 为原型和生产定义同名 Playwright 状态脚本，确保截图前使用相同 server、tab、Agent、theme、viewport、scrollTop 和展开状态。
- [ ] 将截图输出限定在 `temp/visual-mcp/<run-id>/{prototype,production}/`；不写 tracked snapshot。
- [ ] 在迁移前自动捕获原型 reference screenshots。主 agent只记录路径和尺寸，不打开图片。
- [ ] 保存 DOM/CSS 数值基准：列表 tracks、drawer 宽高、header/footer、tabs、TargetChip、handle、modal、overflow、scrollTop；这些数值与截图识别共同作为验收门槛。

### Task 2: Split the Production MCP Surface Without Changing Behavior

**Files:**

- Modify: `packages/web/src/views/Mcp.tsx`
- Create: `packages/web/src/views/mcp/McpInventory.tsx`
- Create: `packages/web/src/views/mcp/McpDrawer.tsx`
- Create: `packages/web/src/views/mcp/McpServerDetail.tsx`
- Create: `packages/web/src/views/mcp/McpServerEditor.tsx`
- Create: `packages/web/src/views/mcp/McpToolsDebug.tsx`
- Create: `packages/web/src/views/mcp/McpServerPreview.tsx`
- Modify: `packages/web/src/views/Mcp.module.css`

- [ ] 先增加结构测试，锁定 list + overlay drawer、fixed header/footer、scroll body 和 `配置 / Tools` tabs。
- [ ] 将 `Mcp.tsx` 收敛为 manifest/operations、selection、URL 状态、modal orchestration 和组件组合；不要继续扩张单文件。
- [ ] 组件以真实 `McpServer`、现有 API response 和 callbacks 为输入，不接收 prototype fixture shape。
- [ ] 页面状态使用 `?view=detail&server=<id>`、`?view=edit&server=<id>`、`?view=create`；浏览器返回只关闭/回退当前抽屉层，刷新恢复上下文。
- [ ] 保留现有错误日志和 toast host，不复制 prototype 的本地 toast 实现。

### Task 3: Rebuild Inventory and Explicit Reorder Handle

**Files:**

- Modify: `packages/web/src/views/mcp/McpInventory.tsx`
- Modify: `packages/web/src/views/Mcp.module.css`
- Modify: `packages/web/src/components/ui/sortable-list.tsx`
- Test: `packages/web/test/sortable-list.test.tsx`
- Test: `packages/web/test/mcp-view.test.tsx`

- [ ] 按原型实现受控宽度列表、居中表头、Server/Targets/操作 tracks、transport 标签、selected row、Apply all 和行 Targets。
- [ ] 在 Server 列最左加入 `GripVertical`，视觉为 `40x40px` 命中区；整行仍只负责进入 Detail。
- [ ] 修复 `SortableList activator="child"`：native button 作为 child activator 时必须收到 Mouse/Touch/Keyboard listeners；交互元素过滤只应用于 `activator="item"`，不要在生产使用伪 button workaround。
- [ ] 搜索非空或 transport filter 不是 `all` 时禁用排序，handle 的 label/tooltip 改为恢复说明。
- [ ] Reorder 乐观更新、保存期间锁定、成功采用服务端 ids；失败记录完整错误、恢复/重载服务端顺序并显示错误反馈。不得改变 selection、targets 或触发 projection。
- [ ] 测试 pointer activator、Space/Arrow/Space、TouchSensor 配置、row click、TargetChip/Edit/Delete 不触发拖拽、筛选禁用和失败回滚。

### Task 4: Implement Drawer Shell and Spatial Continuity

**Files:**

- Modify: `packages/web/src/views/mcp/McpDrawer.tsx`
- Modify: `packages/web/src/views/Mcp.module.css`

- [ ] Detail 宽度严格使用原型的 `min(clamp(680px, 48vw, 740px), available-width)`；Edit/Create 使用 `min(clamp(760px, 60vw, 880px), available-width)`。
- [ ] 视口不足时全屏；`390x844` drawer 为 `390px`，无页面级横向滚动。
- [ ] header、footer 固定，只有 body 纵向滚动；content tabs 在 body 顶部 sticky。
- [ ] row→Detail、row Edit→Editor、Detail→Edit、关闭/返回使用原型的 220–260ms transform/opacity 连续过渡；reduced motion 关闭位移。
- [ ] 抽屉打开期间来源行持续高亮；关闭后焦点返回触发入口。Dirty close 使用确认 dialog。

### Task 5: Implement Shared Config View and Detail

**Files:**

- Modify: `packages/web/src/views/mcp/McpServerDetail.tsx`
- Modify: `packages/web/src/views/mcp/McpServerPreview.tsx`
- Reuse: `packages/web/src/views/mcp/mcp-preview.ts`
- Modify: `packages/web/src/views/Mcp.module.css`

- [ ] fixed header 中放 Raw/CC/CX/OC、transport 和 Edit icon；正文只放 `配置 / Tools`。
- [ ] Raw 展示原始 `${...}`；CC/CX/OC 同时解析 summary、connection、env、headers 和 agent-native output。
- [ ] Connection、Environment、Headers 按原型分组；标题和说明在内容上方，stdio 不显示 headers，remote 独立显示 headers。
- [ ] Preview 默认展开，Raw 展示 desired definition，Agent 模式展示已解析写入结果；沿用正式 JSON/TOML syntax highlight。
- [ ] 变量 token 仅在 Raw 的 Detail 可点击。Variable Inspector 使用真实 matrix/trace、mask 和 source；Agent output 中不再渲染 token button。

### Task 6: Replace the Editor Data Model and GUI/JSON Sync

**Files:**

- Modify: `packages/web/src/views/mcp/McpServerEditor.tsx`
- Create: `packages/web/src/views/mcp/McpArgumentsEditor.tsx`
- Create: `packages/web/src/views/mcp/McpRecordEditor.tsx`
- Test: `packages/web/test/mcp-view.test.tsx`

- [ ] 使用 `Omit<McpServer, 'targets'>` 的 canonical editable definition；targets 始终由打开 editor 时的 persisted server 保留，Create 为 `[]`。
- [ ] `command` 独占一行；Arguments 权威状态为 `string[]`，支持新增、删除、上/下移动、拖拽、空字符串、长值和 CRLF/LF 多行粘贴。
- [ ] env/headers 使用 key/value rows；空 value 合法，空/重复 key 就地报错。remote 才显示 headers，transport 切换不静默删除隐藏值。
- [ ] `可视化 / JSON` 使用 production Monaco。合法 JSON 实时回写 GUI；非法 JSON 保留原文、锁定 GUI、禁用保存，并提供“丢弃无效 JSON”。
- [ ] Server JSON 不包含 targets；保存定义时通过现有 operation 保留 persisted targets。
- [ ] header 的 Raw/CC/CX/OC 只改变 Preview，不替换输入框中的原始 `${...}`。
- [ ] footer 固定并复用真实 pending/error/partial-success 状态；Save/Create 成功后保持 server 和列表位置。

### Task 7: Convert Tools to Saved-Server-Only Debugging

**Files:**

- Modify: `packages/web/src/views/mcp/McpToolsDebug.tsx`
- Modify: `packages/web/src/lib/api.ts` only if types need narrowing
- Test: `packages/web/test/mcp-view.test.tsx`

- [ ] Detail 直接以 `{ source: 'saved', serverId, previewTarget }` 创建 session。
- [ ] Edit dirty 时显示“保存并连接”；Create 显示“创建并连接”。先完成真实 validation/persist，成功后以 saved server 创建 session，失败不连接。
- [ ] 保存并连接后留在当前 Editor/Tools，不切回 Detail；Create header/context 转为已保存 Server。
- [ ] Raw 禁用连接并提示选择 Agent；CC/CX/OC 决定变量解析环境，不静默切换。
- [ ] 已连接后修改 transport/command/args/url/env/headers 或切离 Tools，立即 disconnect 并回到“未连接”；不显示 draft/stale。
- [ ] 保留 tools list、schema starter args、Monaco JSON、reset、call、duration/result、parse error、session expiry、disconnect 和 cleanup。
- [ ] 后端 draft debug contract 暂不删除；增加 Web 测试断言任何 UI 路径都不发送 `source: 'draft'`。

### Task 8: Integrate Modals, Import and Feedback

**Files:**

- Modify: `packages/web/src/views/Mcp.tsx`
- Modify: `packages/web/src/views/mcp/McpImportDialog.tsx`
- Modify: `packages/web/src/views/Mcp.module.css`

- [ ] Delete、dirty close、Variable Inspector、Import 全部使用生产 Modal/Radix focus trap，并映射原型的 surface、边框、半径、scrim、字号和按钮层级。
- [ ] Delete 文案包含 server id；pending 禁止重复操作，成功关闭相关 drawer，失败保留列表/selection。
- [ ] Import 保留现有扫描、候选、rename、ignored/disabled、stale preview 和 apply 行为；仅调整为高保真视觉语言，不删除业务信息。
- [ ] Toast、inline error、saving、connecting、calling、empty、loading、invalid JSON 和 partial success 都有稳定尺寸，不造成 layout shift。

### Task 9: Port the High-Fidelity CSS Exactly

**Files:**

- Modify: `packages/web/src/views/Mcp.module.css`
- Modify production component CSS only when shared controls cannot match prototype tokens.

- [ ] 从 `v3.css` 迁移 semantic values，而不是复制 `.v2-*`/prototype class names。使用现有 `--bg`、`--card`、`--border`、`--text`、`--primary`、agent tokens。
- [ ] 对齐列表 max width/tracks、84–116px responsive header、form spacing、14–16px inputs、23px desktop drawer title、26px TargetChip、7px max card radius和代码语义色。
- [ ] 对齐 light/dark、hover/pressed/focus/disabled、drag overlay、selected transport、sticky tabs、modal和toast。
- [ ] 删除被新结构替代的 workbench/detail/editor/debug CSS，不保留两套布局 fallback。
- [ ] 运行 CSS architecture test，检查无裸全局污染、无重复失效 selector、无 horizontal overflow。

### Task 10: Behavioral and Contract Tests

**Files:**

- Modify: `packages/web/test/mcp-view.test.tsx`
- Modify: `packages/web/test/sortable-list.test.tsx`
- Modify: `packages/web/test/api.test.ts` only when API typing changes

- [ ] 列表：search/filter、targets、row/detail/edit/delete、explicit reorder handle、selection/order retention。
- [ ] Drawer：URL/history、focus return、dirty close、fixed header/footer、Detail→Edit continuity。
- [ ] Editor：args round-trip/multiline paste/empty item/reorder、env/headers validation、transport hidden values、GUI↔JSON、invalid JSON preservation。
- [ ] Preview/vars：Raw vs CC/CX/OC、placeholder preservation、resolved output、trace/mask、default expanded。
- [ ] Tools：saved detail、Save/Create and connect、Raw disabled、no draft request、disconnect on change、call result/error/session expiry。
- [ ] Modals/feedback：Delete、Import stale/error、partial save、toast aria-live、loading/empty/error。
- [ ] Run focused tests, then `bun run test`, then `bun run format:check`. Do not use format commands that rewrite unrelated files.

---

## Task 11: Visual Fidelity Capture

- [ ] Start prototype and production with separate named Playwright sessions and fixed data. Capture component/region screenshots, not oversized full-page images when a smaller region answers the comparison.
- [ ] Every comparison task receives exactly four image paths: two prototype references and the corresponding two production captures.
- [ ] Root/main agent may run capture commands and inspect DOM metrics, but must never open/read images.
- [ ] Store screenshots under `temp/visual-mcp/<run-id>/`; record viewport, theme, state, selector, scrollTop and dimensions beside each filename.

## Task 12: Fan-Out Visual Recognition Matrix

Run at most three image agents concurrently (root + 3 fills the four-agent limit). Each task below uses a newly spawned subagent that has never handled a prior image comparison. Do not reuse an agent for another row or for revalidation.

| Fresh agent task         | Four screenshots (prototype + production pairs)                            | Required checks                                                                 |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `vf-list-shell-r1`       | Default list at `1575x1272`; default list at `1512x982`                    | page bands, max width, typography, table tracks, Apply all, density             |
| `vf-list-interaction-r1` | selected row; active drag overlay                                          | handle, selected marker, row height, overlay width/shadow, column stability     |
| `vf-detail-config-r1`    | Detail Raw; Detail CX                                                      | drawer width, fixed header, groups, resolved values, Preview/highlight          |
| `vf-variable-r1`         | Variable Inspector desktop; Variable Inspector `390x844`                   | modal size, scrim, mask/source/trace, wrapping, safe-area                       |
| `vf-editor-basic-r1`     | Edit stdio visual; Create visual                                           | header/footer, tabs, section rhythm, command/args/env, primary action           |
| `vf-editor-complex-r1`   | remote http with headers; long arguments/env values                        | transport color, full-width fields, rows, wrapping/overflow                     |
| `vf-editor-json-r1`      | valid JSON editor; invalid JSON/read-only GUI                              | Monaco frame, mode switch, error banner, disabled/save states                   |
| `vf-tools-connect-r1`    | Tools Raw idle; Tools connected list                                       | sticky entry, RAW warning, state pill, columns, list selection, buttons         |
| `vf-tools-call-r1`       | Tools call result; Edit Save-and-connect/error                             | Monaco args, call action, result typography, duration, save/connection feedback |
| `vf-dialogs-r1`          | Delete dialog; dirty-close dialog                                          | modal language, destructive hierarchy, spacing, focus/scrim                     |
| `vf-import-toast-r1`     | prototype modal surfaces + production Import; prototype + production toast | Import consistency where no direct prototype screen exists, toast position/size |
| `vf-mobile-r1`           | mobile list; mobile Detail                                                 | handle/row/actions, full-screen drawer, two-row header, no overlap              |
| `vf-mobile-editor-r1`    | mobile Editor; mobile Tools                                                | tabs, footer, stacked debug columns, touch sizing, horizontal overflow          |
| `vf-dark-r1`             | dark list/Detail; dark Editor/Tools                                        | low-glare surfaces, contrast, borders, semantic color parity                    |

### Required Visual Agent Prompt Contract

Each visual subagent prompt must include only four image paths and the relevant prototype selectors/tokens. It must not scan other screenshots. Required response:

```text
coverage: 4/4
verdict: pass | fail
findings:
- severity: P0 | P1 | P2 | P3
  pair: <state name>
  region: <visual region>
  mismatch: <specific visible difference>
  expected: <prototype appearance>
  actual: <production appearance>
  likely_selector_or_token: <best code pointer>
  fix: <concrete correction>
unverified: <none or exact limitation>
```

- [ ] Missing/ambiguous images are not sent back to the same agent. Recapture a targeted region and spawn another fresh agent.
- [ ] Main agent aggregates only text findings, maps them to selectors/components, and applies fixes without opening screenshots.
- [ ] P0/P1/P2 findings block acceptance. P3 is fixed unless it is an intentional production-data difference documented in the plan report.

## Task 13: Fresh-Agent Revalidation and Convergence

- [ ] After fixes, recapture only failed pairs with the same viewport/state/selector.
- [ ] Spawn new task names with incremented rounds, e.g. `vf-detail-config-r2`; never call `followup_task` on an image agent from r1.
- [ ] Keep four images maximum per revalidation agent. If one area needs more states, split it into multiple fresh tasks.
- [ ] Repeat until every matrix row has `verdict: pass`, zero P0/P1/P2, `coverage: 4/4`, and no unverified layout region.
- [ ] Run DOM assertions for drawer dimensions, sticky positions, overflow, scroll regions and console errors after each visual round.

## Task 14: Final Verification and Prototype Removal

- [ ] Run `bun run test` and `bun run format:check`.
- [ ] Start `bun dev`; verify all five viewports, light/dark, pointer/keyboard reorder, browser history, Modal focus, Monaco input, Tools real session cleanup and zero console errors.
- [ ] Confirm production source contains no fixture data, fake timeout, fake result, prototype comments, `.v2-*` classes or import from `temp/`.
- [ ] Confirm all 14 visual matrix rows passed through fresh subagents and archive only the textual report needed for the PR.
- [ ] Remove `temp/prototypes/mcp-editor-feedback/` and `temp/visual-mcp/` only after fidelity acceptance. Do not remove or rewrite the design spec/plan.
- [ ] Update `docs/ui/mcp.md` to current production facts after implementation; do not document migration history.

## Acceptance Criteria

- Production MCP visual layout and interaction match the high-fidelity prototype at the specified viewports and states.
- List, explicit reorder handle, Detail, Edit/Create, JSON, Preview, variables, Tools, Import, delete/dirty dialogs, toast, light/dark and mobile are all covered by behavioral tests and fresh-agent screenshot comparison.
- Main agent never reads images; every image agent reads four images maximum and is never reused for another comparison or revalidation.
- Tools has no visible draft/stale concept and all calls use persisted Server configuration.
- Targets remain list-only; editing definitions cannot rewrite targets or trigger projection.
- Production code has no prototype fixture, demo delay, fake result, redundant description/comment or dependency on the ignored prototype project.
