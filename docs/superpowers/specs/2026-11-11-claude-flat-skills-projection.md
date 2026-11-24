# Claude Code Skills 平铺投影

- 日期: 2026-11-11
- 状态: 已实现

## 背景

Claude Code 只发现 skills root 的直接子目录（`~/.claude/skills/<folder>/SKILL.md`），不会递归进入 `~/.claude/skills/<source-name>/<member>/`。现有 remote source namespace 会把所有选中 member 嵌在 source 目录下，导致 Claude Code 看不到这些 skill。

## 决策

1. 只调整 Claude Code destination；Codex、OpenCode 和 `~/.agents/skills` 继续使用 `<source-name>/` namespace。
2. Claude Code 在 source 没有 bundle 外 resource selection 时，把每个选中 member 投影为独立的 `<source-name>-<member-name>/` 目录，bundle 内容直接位于该目录根。
3. source 选择了 bundle 外 resources 时，Claude Code 保留 `<source-name>/` namespace 以维持资源目录关系，并返回 `nested-skill-layout` warning；不把资源复制进每个平铺 skill 目录。
4. 每个平铺目录是独立 managed namespace：拥有自己的 `.loom-projection.json`，marker 绑定 ownerRepo、sourceKey、sourceName 和实际 namespace。
5. 平铺 namespace 名必须在该 destination 内唯一；与 local skill destination 同名时按普通 destination collision 拒绝。

## Projection 行为

```text
source: superpowers
selected members: brainstorming, tdd
resources: none

Claude Code                      Codex / OpenCode / Shared
~/.claude/skills/                ~/.codex/skills/ (etc.)
├── superpowers-brainstorming/   └── superpowers/
│   └── SKILL.md                     ├── brainstorming/
└── superpowers-tdd/                 └── tdd/
    └── SKILL.md
```

选择 resource 后：

```text
source: workflow-kit
resources: folder/shared

Claude Code
~/.claude/skills/workflow-kit/
├── .loom-projection.json
├── skill-a/SKILL.md
└── shared/...
```

此时返回 `nested-skill-layout` warning，`skill-a` 可能不被 Claude Code 发现。

## Reconcile 与清理

- 布局变化（平铺 ↔ 嵌套）由同一次 desired-state reconcile 完成：新 namespace 创建，旧 namespace 按 marker ownership 清理。
- Source 改名后，旧平铺目录通过 marker 的 `sourceKey` 识别并清理。
- Targeted projection 清理会枚举 skills root 的直接子目录，但只删除 ownerRepo 和 sourceKey 同时匹配目标 source 的 namespace。
- Source 暂时不可用时，preserved sourceKey 会保留该 source 的全部 managed namespace（旧嵌套目录和已有平铺目录）。
- User-owned 平铺目录冲突沿用现有 409 collision 流程；解析时请求携带具体 namespace，避免误备份其他目录。

## 相关规则

- [Projection 规则](../../rules/projection.md) R-PROJECTION-006
- [Skills 规则](../../rules/skills.md) R-SKILLS-006

## 验证

- `packages/core/test/projection.test.ts`：平铺 plan、资源回退、同名/重复 namespace collision。
- `packages/server/test/projection/executor-source-namespace.test.ts`：平铺物化、legacy namespace 清理、warning、targeted cleanup、preserved source。
- `packages/server/test/projection/scan.test.ts`：full projection 平铺与资源 warning。
- `packages/server/test/remote/update.test.ts`：平铺路径在 update preview 中的目标路径。
- `packages/server/test/skills/source-namespace-collision.test.ts`：平铺目录冲突解析。
- `packages/web/test/skill-detail-editor.test.tsx`：各 destination 的投影路径预览。
