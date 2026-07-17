# Loom Sync + Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 git 同步编排(拉取 fetch+merge-base+三向 merge+冲突、上传 push non-ff)与远程 skill 发现/安装/更新(浅 clone+scan+frontmatter+pinned_commit+orphan 检测)。复用 Plan 1 threeWayMerge/compareVersion/NodeGit 与 Plan 2 scan。

**Architecture:** Sync 层编排 git fetch/merge-base,从 git 对象读三份(base/ours/theirs)调 Plan 1 threeWayMerge,无冲突写+重新投影,有冲突产冲突数据进 UI;Remote 层浅 clone+scan+gray-matter 解析 frontmatter,安装 checkout pinned_commit 兑现可复现,更新检测对比 lsRemote tags。TDD,vitest。

**Tech Stack:** Node.js, TypeScript (strict), vitest, gray-matter(frontmatter), Plan 1/2 的 simple-git/tinyglobby/js-yaml/threeWayMerge/compareVersion

## Global Constraints

- 继承 Plan 1/2 Global Constraints(snake_case、ESM import .js、pnpm vitest、Core 零平台依赖、日志 catch 带完整对象不静默)
- 引入 gray-matter(SKILL.md frontmatter 解析,避免手写切 `---` 误切代码块;内部用 js-yaml,无新解析器族)
- IGit 需加 show/revParseHead/lsTree(Task 0 扩展):syncPull 从 git 对象读 base/ours/theirs 三份(ls-tree -r 递归列 vars/assets 文件含嵌套,**不从工作区读**避免脏态污染基线);lsTree 不存在目录返回 [](非错误,不噪声)
- 三向 merge 复用 Plan 1 threeWayMerge(无现成库覆盖「按 key 结构化+冲突标记」语义)
- non-ff push 检测收敛正则为 `/non-fast-forward|fetch first|updates were rejected because the tip/i`:Task 1 同步修订 Plan 1 NodeGit.push 正则(去 `rejected`,避免误判 auth/权限失败)
- 拉取后 repo 始终干净(不落 `<<<<<<<` 标记、不进半合并态);冲突数据驻内存/临时区,UI 解决后写结果+git add;clean 分支 syncPull 写结果+add+**commit**(HEAD 含 merge 结果,syncPush 推 HEAD 才能上传,spec 行 257/259)
- remote 层 git URL 经 resolveGitUrl 归一化(github:owner/repo → https://github.com/owner/repo.git;gitee:owner/repo → https://gitee.com/owner/repo.git;裸 URL 透传),simple-git 不认 `github:` scheme
- 远程 skill 安装失败不写 skills.yaml,清理 remote-cache 半成品(`~/.loom/repos/<repo>/remote-cache/<sourceId>/` 整目录 rm)
- SKILL.md name 校验:= 父目录名,小写字母+数字+连字符(`^[a-z0-9]+(-[a-z0-9]+)*$`),不合规标红跳过
- 安装用非浅 clone(含所有 tag,checkout ref 必成功;--branch tag 浅 clone 需扩展 IGit.clone 且 tag 可能不在默认分支浅历史内,故用非浅);发现用浅 clone --depth 1;更新时 fetch+checkout 新 tag,pinned_commit 兑现可复现(tag mutable)

---

## File Structure

- `src/sync/pull.ts` — syncPull(fetch + merge-base + 三份 git 对象 + threeWayMerge + 无冲突写/有冲突归集)
- `src/sync/push.ts` — syncPush(push,non-ff 收敛正则)
- `src/sync/conflicts.ts` — 冲突视图模型(ConflictGroup + TextFileConflict,供 UI 三栏)
- `src/remote/frontmatter.ts` — SKILL.md frontmatter 解析(gray-matter)+ name 校验
- `src/remote/discover.ts` — 远程 skill 发现(浅 clone + scan + frontmatter + member 列表)
- `src/remote/install.ts` — 安装(clone --branch tag + checkout pinned_commit + 写 skills.yaml + 失败回滚)
- `src/remote/update.ts` — 更新检测(lsRemote + compareVersion)+ 更新流程(fetch/checkout + orphan 检测)
- `tests/sync/*.test.ts` / `tests/remote/*.test.ts` — 对应单测
- `package.json` 加 dependencies: gray-matter

---

## Task 0: 扩展 IGit(show / revParseHead / lsTree)

**Files:**

- Modify: `src/platform/interfaces.ts`(Plan 1)、`src/platform/node/git.ts`(Plan 1)、`tests/platform/node/git.test.ts`(Plan 1,补用例)

**Interfaces:**

- Consumes: Plan 1 IGit/NodeGit
- Produces: IGit 加 `show(repoPath, ref, path): Promise<string>`(`git show <ref>:<path>`)、`revParseHead(repoPath): Promise<string>`(`git rev-parse HEAD`)、`lsTree(repoPath, ref, dir): Promise<string[]>`(`git ls-tree --name-only`)。被 Task 1/5/6 消费

- [ ] **Step 1: 写失败测试**(补到 `tests/platform/node/git.test.ts`)

```typescript
describe('NodeGit show/revParseHead/lsTree', () => {
  it('show reads file content at ref', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'show-'))
    created.push(dest)
    await new NodeGit().clone(bare, dest, false)
    expect(await new NodeGit().show(dest, 'HEAD', 'a.txt')).toContain('x')
  })
  it('revParseHead returns HEAD hash', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'rev-'))
    created.push(dest)
    await new NodeGit().clone(bare, dest, false)
    expect(await new NodeGit().revParseHead(dest)).toMatch(/^[0-9a-f]{7,40}$/)
  })
  it('lsTree lists files under dir', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'lstree-'))
    created.push(dest)
    await new NodeGit().clone(bare, dest, false)
    const files = await new NodeGit().lsTree(dest, 'HEAD', '.')
    expect(files).toContain('a.txt')
  })
  it('lsTree 不存在目录返回 [](不抛错)', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'lstree-none-'))
    created.push(dest)
    await new NodeGit().clone(bare, dest, false)
    expect(await new NodeGit().lsTree(dest, 'HEAD', 'nonexistent/')).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/platform/node/git.test.ts`
Expected: FAIL — show/revParseHead/lsTree is not a function

- [ ] **Step 3: 写实现**

`src/platform/interfaces.ts` IGit 加:

```typescript
  show(repoPath: string, ref: string, path: string): Promise<string>
  revParseHead(repoPath: string): Promise<string>
  lsTree(repoPath: string, ref: string, dir: string): Promise<string[]>
```

`src/platform/node/git.ts` NodeGit 加:

```typescript
  async show(repoPath: string, ref: string, path: string): Promise<string> {
    return (await this.git(repoPath).raw(['show', `${ref}:${path}`])).trimEnd()
  }
  async revParseHead(repoPath: string): Promise<string> {
    return (await this.git(repoPath).raw(['rev-parse', 'HEAD'])).trim()
  }
  async lsTree(repoPath: string, ref: string, dir: string): Promise<string[]> {
    const d = dir.endsWith('/') ? dir : dir + '/'
    // -r 递归:assets/skills/<id>/SKILL.md 嵌套文件需递归列出(vars/ 平铺,-r 无副作用);不存在目录 git 报 fatal(Not a valid object name),返回 [] 属正常(非错误,不噪声日志)
    try {
      const out = await this.git(repoPath).raw(['ls-tree', '-r', '--name-only', `${ref}:${d}`])
      return out.split('\n').map(s => s.trim()).filter(Boolean)
    } catch { return [] }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/platform/node/git.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/platform/interfaces.ts src/platform/node/git.ts tests/platform/node/git.test.ts
git commit -m "feat(platform): IGit show/revParseHead/lsTree (Plan 3 sync 依赖)"
```

---

## Task 1: git 同步编排(syncPull + syncPush)

**Files:**

- Create: `src/sync/pull.ts`, `src/sync/push.ts`
- Test: `tests/sync/pull.test.ts`, `tests/sync/push.test.ts`

**Interfaces:**

- Consumes: `IGit`(Plan 1,需加 show)、`IFileSystem`(Plan 1)、`threeWayMerge`/`MergeResult`/`Kind`/`Conflict`(Plan 1)
- Produces: `syncPull(repoPath, git, fs): Promise<PullResult>`(fetch+merge-base+三份 git 对象+threeWayMerge,无冲突写+git add,有冲突归集)、`syncPush(repoPath, git): Promise<{ok:boolean; nonFastForward?:boolean}>`(push non-ff 收敛正则)。被 API(Plan 4)消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/sync/pull.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { syncPull } from '../../src/sync/pull'

const created: string[] = []
afterAll(async () => {
  for (const p of created.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

// base 推到 bare,w2 clone 自 bare(共享祖先)造 theirs,本地造 ours——保证 merge-base 有共同祖先
async function setupRepo(contentBase: string, ours: string, theirs: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'syncrepo-'))
  const g = simpleGit(repo)
  await g.raw(['init', '-b', 'main'])
  await g.addConfig('user.email', 't@t.t')
  await g.addConfig('user.name', 't')
  await writeFile(join(repo, 'skills.yaml'), contentBase)
  await g.add('.')
  await g.commit('base')
  const bare = await mkdtemp(join(tmpdir(), 'syncbare-'))
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
  await g.addRemote('origin', bare)
  await g.push('origin', 'HEAD:main')
  await writeFile(join(repo, 'skills.yaml'), ours)
  await g.add('.')
  await g.commit('ours')
  const w2 = await mkdtemp(join(tmpdir(), 'syncw2-'))
  const gw2 = simpleGit(w2)
  await gw2.clone(bare, '.') // 共享 base
  await gw2.addConfig('user.email', 't@t.t')
  await gw2.addConfig('user.name', 't')
  await writeFile(join(w2, 'skills.yaml'), theirs)
  await gw2.add('.')
  await gw2.commit('theirs')
  await gw2.push('origin', 'HEAD:main')
  await g.fetch('origin')
  created.push(repo, bare, w2)
  return repo
}

// 多文件版 setup:支持 vars/assets 等额外文件的三方历史(base/ours/theirs 各自可选)
async function setupRepoMulti(
  files: { path: string; base?: string; ours?: string; theirs?: string }[],
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'syncrepo-'))
  const g = simpleGit(repo)
  await g.raw(['init', '-b', 'main'])
  await g.addConfig('user.email', 't@t.t')
  await g.addConfig('user.name', 't')
  const writeAt = async (root: string, p: string, c: string) => {
    await mkdir(join(root, dirname(p)), { recursive: true }).catch(() => {})
    await writeFile(join(root, p), c)
  }
  for (const f of files) if (f.base !== undefined) await writeAt(repo, f.path, f.base)
  await g.add('.')
  await g.commit('base')
  const bare = await mkdtemp(join(tmpdir(), 'syncbare-'))
  await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
  await g.addRemote('origin', bare)
  await g.push('origin', 'HEAD:main')
  for (const f of files) if (f.ours !== undefined) await writeAt(repo, f.path, f.ours)
  await g.add('.')
  await g.commit('ours')
  const w2 = await mkdtemp(join(tmpdir(), 'syncw2-'))
  const gw2 = simpleGit(w2)
  await gw2.clone(bare, '.')
  await gw2.addConfig('user.email', 't@t.t')
  await gw2.addConfig('user.name', 't')
  for (const f of files) if (f.theirs !== undefined) await writeAt(w2, f.path, f.theirs)
  await gw2.add('.')
  await gw2.commit('theirs')
  await gw2.push('origin', 'HEAD:main')
  await g.fetch('origin')
  created.push(repo, bare, w2)
  return repo
}

const A = 'sources:\n  - url: github:x/a\n    ref: v1\nskills: []\n'
const B =
  'sources:\n  - url: github:x/a\n    ref: v1\n  - url: github:x/b\n    ref: v1\nskills: []\n'
const C =
  'sources:\n  - url: github:x/a\n    ref: v1\n  - url: github:x/c\n    ref: v1\nskills: []\n'

describe('syncPull', () => {
  it('no conflict: auto-merges both sides (B + C)', async () => {
    const repo = await setupRepo(A, B, C)
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(true)
    const merged = await readFile(join(repo, 'skills.yaml'), 'utf8')
    expect(merged).toContain('github:x/b')
    expect(merged).toContain('github:x/c')
  })
  it('conflict: both change same ref -> conflicts, no <<<<<<< in working tree', async () => {
    const repo = await setupRepo(
      A,
      'sources:\n  - url: github:x/a\n    ref: v2\nskills: []\n',
      'sources:\n  - url: github:x/a\n    ref: v3\nskills: []\n',
    )
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(false)
    expect(
      res.files.some((f) =>
        f.result.conflicts.some((c) => c.path.includes('github:x/a') && c.field === 'ref'),
      ),
    ).toBe(true)
    expect(await readFile(join(repo, 'skills.yaml'), 'utf8')).not.toContain('<<<<<<<')
  })
  it('vars 三方并集: HEAD 无 vars, theirs 新增 vars/local.yaml -> clean 落盘(父目录自建)', async () => {
    const repo = await setupRepoMulti([
      { path: 'skills.yaml', base: A, ours: A, theirs: A },
      { path: 'vars/local.yaml', theirs: 'k: v\n' }, // 仅 theirs 有,HEAD 无 vars/
    ])
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(true)
    expect(await readFile(join(repo, 'vars', 'local.yaml'), 'utf8')).toContain('k: v')
  })
  it('assets 两方同改 -> textConflicts 非空, working tree 无 <<<<<<<', async () => {
    const repo = await setupRepoMulti([
      { path: 'skills.yaml', base: A, ours: A, theirs: A },
      { path: 'assets/skills/foo/SKILL.md', base: 'v1\n', ours: 'v2\n', theirs: 'v3\n' }, // 两方同改
    ])
    const res = await syncPull(repo, new NodeGit(), new NodeFileSystem())
    expect(res.clean).toBe(false)
    expect(res.textConflicts.some((t) => t.file.includes('SKILL.md'))).toBe(true)
  })
})
```

```typescript
// tests/sync/push.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { syncPush } from '../../src/sync/push'

describe('syncPush', () => {
  let bare: string
  const created: string[] = []
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'pushbare-'))
    await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
    // 远程先有一个 commit
    const w = await mkdtemp(join(tmpdir(), 'pushw-'))
    const gw = simpleGit(w)
    await gw.raw(['init', '-b', 'main'])
    await gw.addConfig('user.email', 't@t.t')
    await gw.addConfig('user.name', 't')
    await writeFile(join(w, 'a.txt'), 'x')
    await gw.add('.')
    await gw.commit('init')
    await gw.addRemote('origin', bare)
    await gw.push('origin', 'HEAD:main')
  })
  afterEach(async () => {
    for (const p of created.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
  })

  it('non-fast-forward when local behind', async () => {
    // dest clone 自 bare(共享 init commit),bare 侧再追加 commit 使 dest 落后,push 旧 HEAD 才是真 non-ff
    const dest = await mkdtemp(join(tmpdir(), 'pushdest-'))
    created.push(dest)
    await simpleGit().clone(bare, dest)
    const w2 = await mkdtemp(join(tmpdir(), 'pushw2-'))
    created.push(w2)
    const gw2 = simpleGit(w2)
    await gw2.clone(bare, '.')
    await gw2.addConfig('user.email', 't@t.t')
    await gw2.addConfig('user.name', 't')
    await writeFile(join(w2, 'b.txt'), 'y')
    await gw2.add('.')
    await gw2.commit('remote-update')
    await gw2.push('origin', 'HEAD:main')
    // dest 仍指向旧 init commit(未 fetch),push 旧 HEAD -> ! [rejected] (fetch first) -> non-ff
    const res = await syncPush(dest, new NodeGit())
    expect(res.ok).toBe(false)
    expect(res.nonFastForward).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sync/pull.test.ts tests/sync/push.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/sync/pull.ts
import { join, dirname } from 'node:path'
import type { IGit, IFileSystem } from '../platform/interfaces.js'
import { threeWayMerge, type MergeResult, type Kind } from '../core/merge.js'
import type { TextFileConflict } from './conflicts.js'

const STRUCT_FILES: { path: string; kind: Kind }[] = [
  { path: 'skills.yaml', kind: 'skills' },
  { path: 'mcp.yaml', kind: 'mcp' },
  { path: 'config.yaml', kind: 'config' },
]

export interface PullFileResult {
  path: string
  result: MergeResult
}
export interface PullResult {
  files: PullFileResult[]
  varsFiles: PullFileResult[]
  textConflicts: TextFileConflict[]
  clean: boolean
}

type Logger = { warn?: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void }

export async function syncPull(
  repoPath: string,
  git: IGit,
  fs: IFileSystem,
  logger?: Logger,
): Promise<PullResult> {
  await git.fetch(repoPath)
  const base = await git.mergeBase(repoPath, 'FETCH_HEAD', 'HEAD')
  const files: PullFileResult[] = []
  for (const { path, kind } of STRUCT_FILES) {
    const baseText = await safeShow(git, repoPath, base, path, logger)
    const oursText = await safeShow(git, repoPath, 'HEAD', path, logger)
    const theirsText = await safeShow(git, repoPath, 'FETCH_HEAD', path, logger)
    files.push({ path, result: threeWayMerge(baseText, oursText, theirsText, kind) })
  }
  // vars/*.yaml:三方并集 ls-tree,逐个三向 merge(spec 行 264)
  const varsPaths = await listVarsFilesUnion(git, repoPath, base, logger)
  const varsFiles: PullFileResult[] = []
  for (const p of varsPaths) {
    const baseText = await safeShow(git, repoPath, base, p, logger)
    const oursText = await safeShow(git, repoPath, 'HEAD', p, logger)
    const theirsText = await safeShow(git, repoPath, 'FETCH_HEAD', p, logger)
    varsFiles.push({ path: p, result: threeWayMerge(baseText, oursText, theirsText, 'vars') })
  }
  const textConflicts = await detectTextConflicts(git, repoPath, base, logger)
  const allResults = [...files, ...varsFiles]
  const clean =
    allResults.every((f) => f.result.conflicts.length === 0) && textConflicts.length === 0
  if (clean) {
    for (const f of allResults) {
      const dest = join(repoPath, f.path)
      const dir = dirname(dest)
      if (!(await fs.exists(dir))) await fs.mkdir(dir, true) // vars/<profile>.yaml 父目录可能不存在(HEAD 无 vars 而 theirs 新增),避免 ENOENT
      await fs.writeFile(dest, f.result.merged)
    }
    await git.add(
      repoPath,
      allResults.map((f) => f.path),
    )
    await git.commit(repoPath, 'merge: pull from origin') // commit 使 HEAD 含 merge 结果,syncPush 推 HEAD 才能上传(spec 行 257/259)
    // 重新投影由 caller(API/Plan 4)编排,与 install/performUpdate 一致
  }
  return { files, varsFiles, textConflicts, clean }
}

async function safeShow(
  git: IGit,
  repoPath: string,
  ref: string,
  path: string,
  logger?: Logger,
): Promise<string> {
  try {
    return await git.show(repoPath, ref, path)
  } catch (e) {
    logger?.warn?.({ err: e, ref, path }, 'git show miss (file absent at ref)')
    return ''
  }
}

async function listVarsFilesUnion(
  git: IGit,
  repoPath: string,
  base: string,
  logger?: { warn?: (o: unknown, m: string) => void },
): Promise<string[]> {
  // 三方并集:base/HEAD/FETCH_HEAD 各 ls-tree vars/(git show <dir> 不可靠,用 ls-tree)
  const all = new Set<string>()
  for (const ref of [base, 'HEAD', 'FETCH_HEAD']) {
    try {
      for (const f of await git.lsTree(repoPath, ref, 'vars'))
        all.add(f.startsWith('vars/') ? f : `vars/${f}`)
    } catch (e) {
      logger?.warn?.({ err: e, ref }, 'ls-tree vars miss')
    }
  }
  return [...all]
}

// assets/ 文本文件两方同改检测(spec 行 258/270:文件级冲突先由 git 检测,文本交外部解决)
async function detectTextConflicts(
  git: IGit,
  repoPath: string,
  base: string,
  logger?: { warn?: (o: unknown, m: string) => void },
): Promise<TextFileConflict[]> {
  const out: TextFileConflict[] = []
  const allAssets = new Set<string>()
  for (const ref of [base, 'HEAD', 'FETCH_HEAD']) {
    try {
      for (const f of await git.lsTree(repoPath, ref, 'assets'))
        allAssets.add(f.startsWith('assets/') ? f : `assets/${f}`)
    } catch (e) {
      logger?.warn?.({ err: e, ref }, 'ls-tree assets miss')
    }
  }
  for (const p of allAssets) {
    const b = await safeShow(git, repoPath, base, p, logger)
    const o = await safeShow(git, repoPath, 'HEAD', p, logger)
    const t = await safeShow(git, repoPath, 'FETCH_HEAD', p, logger)
    if (o !== b && t !== b && o !== t) out.push({ file: p, resolvedExternally: false })
  }
  return out
}
```

```typescript
// src/sync/push.ts
import type { IGit } from '../platform/interfaces.js'

export async function syncPush(
  repoPath: string,
  git: IGit,
): Promise<{ ok: boolean; nonFastForward?: boolean }> {
  return git.push(repoPath) // Plan 1 NodeGit.push 已返回 {ok, nonFastForward};收敛正则在 NodeGit.push 内
}
```

> 注:`syncPush` 直接复用 Plan 1 `NodeGit.push`(已识别 non-ff)。

- [ ] **Step 3b: 修订 Plan 1 NodeGit.push non-ff 正则(去 rejected)**

Plan 1 `NodeGit.push`(行 830)正则 `/non-fast-forward|rejected|fetch first/i` 含 `rejected`,过宽——auth/权限失败如 `! [remote rejected] (Permission denied)` 会误判为 nonFastForward,UI 误导用户"重新拉取"而非提示权限问题。修改 `src/platform/node/git.ts`(Plan 1) 正则为 `/non-fast-forward|fetch first|updates were rejected because the tip/i`。Plan 1 git.test.ts 的 non-ff 用例(造 `! [rejected] (fetch first)`)仍匹配 `fetch first`,通过。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/sync/pull.test.ts tests/sync/push.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync/pull.ts src/sync/push.ts tests/sync/pull.test.ts tests/sync/push.test.ts
git commit -m "feat(sync): pull (fetch+merge-base+3-way from git objects) + push (non-ff)"
```

---

## Task 2: 冲突视图模型

**Files:**

- Create: `src/sync/conflicts.ts`
- Test: `tests/sync/conflicts.test.ts`

**Interfaces:**

- Consumes: `Conflict`、`Kind`(Plan 1 merge.ts)
- Produces: `ConflictGroup`(file + kind + conflicts 带 resolution)、`TextFileConflict`、`groupConflicts(files, kindOf): ConflictGroup[]`(供 Plan 4 UI 三栏渲染)

- [ ] **Step 1: 写失败测试**

```typescript
// tests/sync/conflicts.test.ts
import { describe, it, expect } from 'vitest'
import { groupConflicts } from '../../src/sync/conflicts'

describe('groupConflicts', () => {
  it('groups files with conflicts, attaches resolution slot', () => {
    const files = [
      {
        path: 'skills.yaml',
        result: {
          merged: '',
          conflicts: [
            {
              file: 'skills.yaml',
              path: 'github:x/a',
              field: 'ref',
              base: 'v1',
              ours: 'v2',
              theirs: 'v3',
            },
          ],
        },
      },
      { path: 'mcp.yaml', result: { merged: '', conflicts: [] } },
    ]
    const groups = groupConflicts(files, () => 'skills')
    expect(groups).toHaveLength(1)
    expect(groups[0].file).toBe('skills.yaml')
    expect(groups[0].conflicts[0].resolution).toBeUndefined() // 待用户选
  })
  it('skips files without conflicts', () => {
    const files = [{ path: 'mcp.yaml', result: { merged: '', conflicts: [] } }]
    expect(groupConflicts(files, () => 'mcp')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/sync/conflicts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/sync/conflicts.ts
import type { Conflict, Kind } from '../core/merge.js'

export type Resolution = 'ours' | 'theirs' | 'manual' | 'base'
export interface ConflictItem extends Conflict {
  resolution?: Resolution
  manualValue?: unknown
}
export interface ConflictGroup {
  file: string
  kind: Kind
  conflicts: ConflictItem[]
}
export interface TextFileConflict {
  file: string
  resolvedExternally: boolean
}

export function groupConflicts(
  files: { path: string; result: { conflicts: Conflict[] } }[],
  kindOf: (path: string) => Kind,
): ConflictGroup[] {
  return files
    .filter((f) => f.result.conflicts.length > 0)
    .map((f) => ({
      file: f.path,
      kind: kindOf(f.path),
      conflicts: f.result.conflicts.map((c) => ({ ...c })),
    }))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/sync/conflicts.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync/conflicts.ts tests/sync/conflicts.test.ts
git commit -m "feat(sync): conflict view model (ConflictGroup + resolution slot)"
```

---

## Task 3: SKILL.md frontmatter 解析

**Files:**

- Create: `src/remote/frontmatter.ts`
- Test: `tests/remote/frontmatter.test.ts`

**Interfaces:**

- Consumes: gray-matter
- Produces: `parseSkillMeta(content, dirName, path): SkillMeta | null`(gray-matter 解析 frontmatter,name 校验 = 父目录名 + `^[a-z0-9]+(-[a-z0-9]+)*$`,不合规返回 null)。被 Task 4 发现消费

- [ ] **Step 1: 写失败测试**

> 先安装依赖:`pnpm add gray-matter`(frontmatter 解析,内部用 js-yaml)。

````typescript
// tests/remote/frontmatter.test.ts
import { describe, it, expect } from 'vitest'
import { parseSkillMeta } from '../../src/remote/frontmatter'

describe('parseSkillMeta', () => {
  it('parses name + description from frontmatter', () => {
    const md = '---\nname: brainstorming\ndescription: A skill\n---\n# body\n'
    const m = parseSkillMeta(md, 'brainstorming', '/p/brainstorming')
    expect(m?.name).toBe('brainstorming')
    expect(m?.description).toBe('A skill')
  })
  it('rejects name != dirName', () => {
    const md = '---\nname: other\ndescription: x\n---\n'
    expect(parseSkillMeta(md, 'brainstorming', '/p')).toBeNull()
  })
  it('rejects invalid name (uppercase/space)', () => {
    expect(parseSkillMeta('---\nname: Bad Name\n---\n', 'Bad Name', '/p')).toBeNull()
  })
  it('returns null when no frontmatter', () => {
    expect(parseSkillMeta('# just body', 'brainstorming', '/p')).toBeNull()
  })
  it('does not mis-split fenced code block with --- inside body', () => {
    const md =
      '---\nname: brainstorming\ndescription: x\n---\n```yaml\n---\nfake: frontmatter\n---\n```\n'
    const m = parseSkillMeta(md, 'brainstorming', '/p')
    expect(m?.name).toBe('brainstorming') // gray-matter 不误切代码块内的 ---
  })
})
````

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/remote/frontmatter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/remote/frontmatter.ts
import matter from 'gray-matter'

export interface SkillMeta {
  name: string
  description: string
  path: string
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// gray-matter 解析 frontmatter;name 必须合法且 = 父目录名(spec/agentskills.io 规范),否则 null
export function parseSkillMeta(content: string, dirName: string, path: string): SkillMeta | null {
  const { data } = matter(content)
  const name = String(data?.name ?? '')
  if (!NAME_RE.test(name) || name !== dirName) return null
  return { name, description: String(data?.description ?? ''), path }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/remote/frontmatter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/remote/frontmatter.ts tests/remote/frontmatter.test.ts
git commit -m "feat(remote): SKILL.md frontmatter parse + name validation (gray-matter)"
```

---

## Task 4: 远程 skill 发现

**Files:**

- Create: `src/remote/resolve-url.ts`(github:/gitee: URL 归一化,remote 层共用)、`src/remote/discover.ts`
- Test: `tests/remote/discover.test.ts`

**Interfaces:**

- Consumes: `IGit`(Plan 1 clone)、`IFileSystem`、tinyglobby(Plan 2)、`parseSkillMeta`(Task 3)
- Produces: `resolveGitUrl(url): string`(github:owner/repo → https://github.com/owner/repo.git;gitee:owner/repo → https://gitee.com/owner/repo.git;裸 URL 透传)、`discoverSkills(git, fs, url, installed?): Promise<(SkillMeta & {installed:boolean})[]>`(浅 clone 临时目录 + scan + frontmatter + 标已安装 + 清理临时)。被 Task 5/6 + API(Plan 4)消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/remote/discover.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from '../../src/remote/discover'
import { resolveGitUrl } from '../../src/remote/resolve-url'
import { NodeFileSystem } from '../../src/platform/node/fs'
import type { IGit } from '../../src/platform/interfaces'

let srcTmp: string
beforeAll(async () => {
  srcTmp = await mkdtemp(join(tmpdir(), 'discsrc-'))
})
afterAll(async () => {
  await rm(srcTmp, { recursive: true, force: true }).catch(() => {})
})

describe('resolveGitUrl', () => {
  it('github:owner/repo -> https URL', () => {
    expect(resolveGitUrl('github:obra/superpowers')).toBe('https://github.com/obra/superpowers.git')
  })
  it('gitee:owner/repo -> https URL', () => {
    expect(resolveGitUrl('gitee:obra/superpowers')).toBe('https://gitee.com/obra/superpowers.git')
  })
  it('裸 URL 透传(本地 path / https)', () => {
    expect(resolveGitUrl('/tmp/bare-repo')).toBe('/tmp/bare-repo')
    expect(resolveGitUrl('https://github.com/x/y.git')).toBe('https://github.com/x/y.git')
  })
})

describe('discoverSkills', () => {
  it('shallow clone + scan + parse frontmatter, filter invalid name, mark installed', async () => {
    await mkdir(join(srcTmp, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\ndescription: A skill\n---\nbody\n',
    )
    await mkdir(join(srcTmp, 'skills', 'bad-name'), { recursive: true })
    await writeFile(
      join(srcTmp, 'skills', 'bad-name', 'SKILL.md'),
      '---\nname: BadName\ndescription: x\n---\n',
    ) // 不合规
    const mockGit = {
      clone: async (_u: string, dest: string) => {
        await cp(srcTmp, dest, { recursive: true })
      },
    } as unknown as IGit
    const members = await discoverSkills(
      mockGit,
      new NodeFileSystem(),
      'github:obra/superpowers',
      new Set(['superpowers-brainstorming']),
    )
    expect(members.map((m) => m.name)).toEqual(['brainstorming']) // bad-name 被过滤
    expect(members[0].description).toBe('A skill')
    expect(members[0].installed).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/remote/discover.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/remote/resolve-url.ts
// github:owner/repo / gitee:owner/repo 归一化为 https URL(skill source 约定简写,git 不认 scheme);裸 URL(本地 path/https)透传
export function resolveGitUrl(url: string): string {
  const m = url.match(/^(github|gitee):([^/]+\/[^/]+)$/)
  if (m) return `https://${m[1]}.com/${m[2]}.git`
  return url
}
```

```typescript
// src/remote/discover.ts
import { glob } from 'tinyglobby'
import { join, dirname, basename } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IGit, IFileSystem } from '../platform/interfaces.js'
import { parseSkillMeta, type SkillMeta } from './frontmatter.js'
import { resolveGitUrl } from './resolve-url.js'

const DEFAULT_IGNORE = ['**/.git/**', '**/node_modules/**', '**/.cache/**']

export async function discoverSkills(
  git: IGit,
  fs: IFileSystem,
  url: string,
  installed: Set<string> = new Set(),
): Promise<(SkillMeta & { installed: boolean })[]> {
  const tmp = await mkdtemp(join(tmpdir(), 'discover-'))
  try {
    await git.clone(resolveGitUrl(url), tmp, true) // 浅 clone 默认分支(归一化 github: -> https)
    const matches = await glob('**/SKILL.md', { cwd: tmp, ignore: DEFAULT_IGNORE, onlyFiles: true })
    const repoId = deriveRepoId(url)
    const out: (SkillMeta & { installed: boolean })[] = []
    for (const m of matches) {
      const dir = dirname(m),
        dirName = basename(dir)
      const meta = parseSkillMeta(await fs.readFile(join(tmp, m)), dirName, join(tmp, dir))
      if (meta) out.push({ ...meta, installed: installed.has(`${repoId}-${dirName}`) })
    }
    return out
  } finally {
    await rm(tmp, { recursive: true, force: true }) // 清理临时 clone
  }
}

function deriveRepoId(url: string): string {
  const parts = url.split(':')
  return parts[parts.length - 1]
    .split('/')
    .pop()!
    .replace(/\.git$/, '')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/remote/discover.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/remote/discover.ts tests/remote/discover.test.ts
git commit -m "feat(remote): skill discovery (shallow clone + scan + frontmatter + installed mark)"
```

---

## Task 5: 远程 skill 安装

**Files:**

- Create: `src/remote/install.ts`
- Test: `tests/remote/install.test.ts`

**Interfaces:**

- Consumes: `IGit`(Plan 1,需加 `revParseHead(repoPath): Promise<string>` 取 HEAD hash)、`IFileSystem`
- Produces: `installSkill(git, fs, url, ref, repoPath, sourceId): Promise<{pinned_commit:string; cacheDir:string}>`(clone 到 remote-cache/<sourceId> + checkout ref + 取 pinned_commit + 验证;失败清理半成品并抛错)。caller(API)负责写 skills.yaml + 投影

- [ ] **Step 1: 写失败测试**

```typescript
// tests/remote/install.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { installSkill } from '../../src/remote/install'

describe('installSkill', () => {
  let bare: string
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'instbare-'))
    await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
    const w = await mkdtemp(join(tmpdir(), 'instw-'))
    const g = simpleGit(w)
    await g.raw(['init', '-b', 'main'])
    await g.addConfig('user.email', 't@t.t')
    await g.addConfig('user.name', 't')
    await mkdir(join(w, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(w, 'skills', 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\n---\n',
    )
    await g.add('.')
    await g.commit('init')
    await g.addTag('v1.0.0')
    await g.addRemote('origin', bare)
    await g.push('origin', 'HEAD:main')
    await g.pushTags('origin')
  })

  it('clones + checks out ref + returns pinned_commit (HEAD hash)', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'instrepo-'))
    const res = await installSkill(
      new NodeGit(),
      new NodeFileSystem(),
      bare,
      'v1.0.0',
      repoPath,
      'superpowers',
    )
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(res.cacheDir).toBe(join(repoPath, 'remote-cache', 'superpowers'))
    await rm(repoPath, { recursive: true, force: true })
  })
  it('failure (bad ref) cleans up remote-cache half-product', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'instrepo2-'))
    const fs = new NodeFileSystem()
    await expect(
      installSkill(new NodeGit(), fs, bare, 'nonexistent-ref', repoPath, 'superpowers'),
    ).rejects.toThrow()
    expect(await fs.exists(join(repoPath, 'remote-cache', 'superpowers'))).toBe(false) // 半成品清理
    await rm(repoPath, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/remote/install.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/remote/install.ts
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { IGit, IFileSystem } from '../platform/interfaces.js'
import { resolveGitUrl } from './resolve-url.js'

// clone 到 remote-cache/<sourceId> + checkout ref + 取 pinned_commit;失败清理半成品(spec 行 285)
export async function installSkill(
  git: IGit,
  fs: IFileSystem,
  url: string,
  ref: string,
  repoPath: string,
  sourceId: string,
): Promise<{ pinned_commit: string; cacheDir: string }> {
  const cacheDir = join(repoPath, 'remote-cache', sourceId)
  if (await fs.exists(cacheDir)) await rm(cacheDir, { recursive: true, force: true }) // 重新安装先清
  try {
    await git.clone(resolveGitUrl(url), cacheDir, false) // 非浅(归一化 github: -> https);含所有 tag,checkout ref 必成功
    await git.checkout(cacheDir, ref) // checkout tag/ref;失败抛错
    const pinned_commit = await git.revParseHead(cacheDir) // HEAD hash,兑现可复现(tag mutable,spec 行 292)
    return { pinned_commit, cacheDir }
  } catch (e) {
    await rm(cacheDir, { recursive: true, force: true }) // 清理半成品,不写 skills.yaml
    throw e
  }
}
```

> 注:`IGit` 需加 `revParseHead(repoPath): Promise<string>`(Plan 1 NodeGit 用 `raw(['rev-parse','HEAD'])` 实现)。installSkill 只负责 clone+checkout+取 pinned_commit;写 skills.yaml sources 项 + 建投影软链由 caller(API/Plan 4)编排,失败时 caller 不写 skills.yaml(与 spec「失败保持未安装」对齐)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/remote/install.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/remote/install.ts tests/remote/install.test.ts
git commit -m "feat(remote): skill install (clone + checkout ref + pinned_commit + half-product cleanup)"
```

---

## Task 6: 更新检测 + 更新流程

**Files:**

- Create: `src/remote/update.ts`
- Test: `tests/remote/update.test.ts`

**Interfaces:**

- Consumes: `IGit`(lsRemote/fetch/checkout/revParseHead)、`IFileSystem`、`SkillSource`(Plan 1)、`compareVersion`/`RemoteRef`/`VersionStatus`(Plan 1)、`scanSourceMembers`/`ScannedMember`(Plan 2)
- Produces: `checkUpdates(sources, git): Promise<(VersionStatus & {source:SkillSource})[]>`(lsRemote + compareVersion)、`performUpdate(git, fs, source, newRef, repoPath, sourceId, oldMembers): Promise<{pinned_commit:string; orphans:ScannedMember[]}>`(fetch+checkout+pinned_commit+orphan 检测)。被 API(Plan 4)消费

- [ ] **Step 1: 写失败测试**

```typescript
// tests/remote/update.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { NodeGit } from '../../src/platform/node/git'
import { NodeFileSystem } from '../../src/platform/node/fs'
import { checkUpdates, performUpdate } from '../../src/remote/update'
import type { SkillSource } from '../../src/core/types'
import type { ScannedMember } from '../../src/projection/scan'

describe('checkUpdates', () => {
  it('hasUpdate when remote tag commit != pinned_commit', async () => {
    const mockGit = {
      lsRemote: async () => ({ tags: { 'v5.1.4': 'bbb' }, head: 'bbb' }),
    } as any
    const sources: SkillSource[] = [{ url: 'github:x/y', ref: 'v5.1.4', pinned_commit: 'aaa' }]
    const r = await checkUpdates(sources, mockGit)
    expect(r[0].hasUpdate).toBe(true)
  })
  it('no update when pinned_commit matches latest tag commit', async () => {
    const mockGit = { lsRemote: async () => ({ tags: { 'v5.1.4': 'aaa' }, head: 'aaa' }) } as any
    const r = await checkUpdates(
      [{ url: 'github:x/y', ref: 'v5.1.4', pinned_commit: 'aaa' }],
      mockGit,
    )
    expect(r[0].hasUpdate).toBe(false)
  })
})

describe('performUpdate', () => {
  let bare: string
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'updbare-'))
    await simpleGit().raw(['init', '--bare', '-b', 'main', bare])
    const w = await mkdtemp(join(tmpdir(), 'updw-'))
    const g = simpleGit(w)
    await g.raw(['init', '-b', 'main'])
    await g.addConfig('user.email', 't@t.t')
    await g.addConfig('user.name', 't')
    await mkdir(join(w, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(w, 'skills', 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\n---\nv1\n',
    )
    await g.add('.')
    await g.commit('v1')
    await g.addTag('v1.0.0')
    // v2:删 brainstorming,加 tdd(orphan 场景)
    await rm(join(w, 'skills', 'brainstorming', 'SKILL.md'))
    await mkdir(join(w, 'skills', 'tdd'), { recursive: true })
    await writeFile(join(w, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\n---\nv2\n')
    await g.add('.')
    await g.commit('v2')
    await g.addTag('v2.0.0')
    await g.addRemote('origin', bare)
    await g.push('origin', 'HEAD:main')
    await g.pushTags('origin')
  })

  it('fetch + checkout new ref + detect orphan members', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'updrepo-'))
    const git = new NodeGit(),
      fs = new NodeFileSystem()
    // 先装 v1.0.0(非浅,对齐 installSkill 契约;本地 clone 忽略 --depth,用 false 显式非浅)
    await git.clone(bare, join(repoPath, 'remote-cache', 'superpowers'), false)
    await git.checkout(join(repoPath, 'remote-cache', 'superpowers'), 'v1.0.0')
    const oldMembers: ScannedMember[] = [
      {
        name: 'brainstorming',
        path: join(repoPath, 'remote-cache', 'superpowers', 'skills', 'brainstorming'),
      },
    ]
    // 更新到 v2.0.0
    const res = await performUpdate(
      git,
      fs,
      { url: bare, ref: 'v1.0.0', pinned_commit: 'old' },
      'v2.0.0',
      repoPath,
      'superpowers',
      oldMembers,
    )
    expect(res.pinned_commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(res.orphans.map((o) => o.name)).toEqual(['brainstorming']) // brainstorming 在 v2 不存在 -> orphan
    await rm(repoPath, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/remote/update.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/remote/update.ts
import { join } from 'node:path'
import type { IGit, IFileSystem } from '../platform/interfaces.js'
import type { SkillSource } from '../core/types.js'
import { compareVersion, type RemoteRef, type VersionStatus } from '../core/version.js'
import { scanSourceMembers, type ScannedMember } from '../projection/scan.js'
import { resolveGitUrl } from './resolve-url.js'

export async function checkUpdates(
  sources: SkillSource[],
  git: IGit,
): Promise<(VersionStatus & { source: SkillSource })[]> {
  const out: (VersionStatus & { source: SkillSource })[] = []
  for (const s of sources) {
    const remote: RemoteRef = await git.lsRemote(resolveGitUrl(s.url))
    out.push({
      ...compareVersion({ ref: s.ref, pinned_commit: s.pinned_commit ?? '' }, remote),
      source: s,
    })
  }
  return out
}

export interface UpdateResult {
  pinned_commit: string
  orphans: ScannedMember[]
  newMembers: ScannedMember[]
}

// fetch + checkout newRef + 取 pinned_commit + 检测 orphan(旧 member 不在新 scan 结果中,spec 行 299)
export async function performUpdate(
  git: IGit,
  fs: IFileSystem,
  _source: SkillSource,
  newRef: string,
  repoPath: string,
  sourceId: string,
  oldMembers: ScannedMember[],
): Promise<UpdateResult> {
  const cacheDir = join(repoPath, 'remote-cache', sourceId)
  await git.fetch(cacheDir)
  await git.checkout(cacheDir, newRef)
  const pinned_commit = await git.revParseHead(cacheDir)
  const newMembers = await scanSourceMembers(fs, cacheDir, { url: _source.url, ref: newRef })
  const newNames = new Set(newMembers.map((m) => m.name))
  const orphans = oldMembers.filter((m) => !newNames.has(m.name)) // orphan:旧 member 不在新 ref
  return { pinned_commit, orphans, newMembers }
}
```

> 注:performUpdate 只做 fetch+checkout+orphan 检测;改 skills.yaml ref+pinned_commit + 清理 orphan 投影软链 + 保留覆盖项配置(spec 行 298-299)由 caller(API/Plan 4)编排。orphan 的覆盖项配置保留不自动删(等用户决定)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/remote/update.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/remote/update.ts tests/remote/update.test.ts
git commit -m "feat(remote): update check (lsRemote+compareVersion) + update flow (fetch+checkout+orphan)"
```

---

## Self-Review

**1. Spec coverage** (Plan 3 覆盖范围):

- 同步拉取(一步 fetch + 程序内三向 merge,不落冲突标记,repo 始终干净,spec 行 257)→ Task 1 ✓(从 git 对象读三份 base/ours/theirs)
- 同步上传(push,non-ff 提示重新拉取,不 force 不循环,spec 行 259)→ Task 1 ✓
- 结构化 merge 范围(config/skills/mcp/vars 三方并集,spec 行 264)→ Task 1 ✓(listVarsFilesUnion ls-tree 三方并集 + 复用 Plan 1 threeWayMerge)
- 冲突 UI 数据(三栏,冲突字段高亮,spec 行 258)→ Task 2 ✓(ConflictGroup + resolution)
- assets 文本文件冲突检测(文件级冲突先由 git 检测,spec 行 258/270)→ Task 1 detectTextConflicts ✓(两方同改标冲突,三入口外部解决在 Plan 4 UI)
- 远程 skill 发现(浅 clone + scan + frontmatter + 标已安装,spec 行 281)→ Task 4 ✓
- 安装(非浅 clone + checkout ref + pinned_commit + 失败清理半成品不写 skills.yaml,spec 行 285)→ Task 5 ✓
- 更新检测(lsRemote tags + compareVersion,spec 行 290)+ tag mutable 用 pinned_commit(spec 行 292)→ Task 6 ✓
- 更新流程(fetch + checkout + orphan 标记 + 保留覆盖项,spec 行 298-299)→ Task 6 ✓(orphan 检测 + 返回 newMembers;caller 改 skills.yaml + 保留覆盖项)

**2. Placeholder scan**: 无 TBD/TODO。IGit 加 show/revParseHead/lsTree(Task 0 扩展,NodeGit raw 实现);listVarsFilesUnion 用 ls-tree 三方并集(修复 git show <dir> 不可靠);install 非浅 clone(含所有 tag);performUpdate 返回 newMembers(caller 重建投影用);install/performUpdate 只做 git 操作,写 skills.yaml + 投影由 caller(Plan 4)编排(注明)。syncPull 加 logger,safeShow/ls-tree catch 记日志不静默。实现代码完整可跑。

**3. Type consistency**: `PullResult`(含 textConflicts)/`PullFileResult`(Task 1)、`ConflictGroup`/`ConflictItem`/`TextFileConflict`(Task 2)、`SkillMeta`(Task 3)、`discoverSkills` 返回(Task 4)、`installSkill` 返回(Task 5)、`UpdateResult`(含 newMembers)/`checkUpdates`/`performUpdate`(Task 6)跨 task 一致;复用 Plan 1 `Conflict`/`Kind`/`MergeResult`/`threeWayMerge`/`compareVersion`/`RemoteRef`/`VersionStatus`/`SkillSource`、Plan 2 `scanSourceMembers`/`ScannedMember`;IGit 扩展 show/revParseHead/lsTree(Task 0)。snake_case 继承(pinned_commit)。

**4. 三方包调研结论**: gray-matter(frontmatter)引入;simple-git(同步/clone/checkout/fetch/lsRemote + Task 0 raw show/rev-parse/ls-tree)、threeWayMerge/compareVersion(Plan 1)、tinyglobby/scanSourceMembers(Plan 2)复用;冲突模型/orphan 检测/文本冲突检测自写。base/ours/theirs 从 git 对象读(IGit.show)避免工作区脏态污染。non-ff 正则收敛(Task 1 同步修订 Plan 1 NodeGit.push,去 `rejected`)。

**5. 第 2 轮 review 修复**: syncPull 无冲突测试非法 YAML 改完整合法(blocker,`skills: []` 后跟块序列致 js-yaml 抛错)、syncPull 写 vars 父目录 mkdir + clean 后 commit(blocker,ENOENT + spec 257/259)、syncPush 空仓 non-ff 改 clone+bare 追加 commit(blocker,空仓报 `src refspec does not match` 非 non-ff)、lsTree 加 -r 递归(detectTextConflicts 嵌套 assets high)、resolveGitUrl 归一化 github:/gitee:(high,产线 simple-git 不认 `github:` scheme 必崩)、补 detectTextConflicts/listVarsFilesUnion 测试(vars 并集+assets 冲突 high)、NodeGit.push 正则去 rejected 显式 Step 3b(medium)、performUpdate 浅 clone 改非浅(medium)、lsTree 不存在目录返回 [](medium)、pull/push.test 加 afterAll 清理(low)。
第 1 轮修复: Task 0 IGit 扩展、setupRepo w2 clone 共享祖先、install 测试 mkdir、listVarsFilesUnion ls-tree 三方并集、textConflicts 检测、install 非浅 clone、syncPull logger、performUpdate newMembers、gray-matter 安装、discover beforeAll。

**未覆盖(留给后续 plan)**: API+WebUI(Plan 4,含冲突三栏 UI + 文件冲突三入口 + 安装/更新编排写 skills.yaml + 投影 + orphan 覆盖项保留 UI)、orphan 覆盖项保留的契约(caller 清理投影软链时不删 skills.yaml 覆盖项,等用户决定)。
