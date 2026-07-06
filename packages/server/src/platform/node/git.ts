import { simpleGit, type SimpleGit } from 'simple-git'
import type { GitPushResult, IGit } from '../../ports/git.js'

export class NodeGit implements IGit {
  private git(path?: string): SimpleGit {
    return simpleGit(path)
  }

  async init(repoPath: string): Promise<void> {
    await this.git(repoPath).raw(['init', '-b', 'main'])
  }

  async fetch(repoPath: string): Promise<void> {
    // Use raw to ensure FETCH_HEAD is set — simple-git's .fetch() wrapper
    // doesn't reliably create FETCH_HEAD for merge-base lookups.
    // Don't hardcode 'origin' — fetch without naming a remote uses the
    // configured default remote and still sets FETCH_HEAD.
    await this.git(repoPath).raw(['fetch', 'origin', '--tags'])
  }

  async merge(repoPath: string, ref: string): Promise<{ clean: boolean }> {
    try {
      await this.git(repoPath).merge([ref, '--no-edit'])
      return { clean: true }
    } catch (err) {
      if ((await this.unmergedPaths(repoPath)).length > 0) return { clean: false }
      throw err
    }
  }

  async unmergedPaths(repoPath: string): Promise<string[]> {
    const out = await this.git(repoPath).raw(['diff', '--name-only', '--diff-filter=U', '-z'])
    return out.split('\0').filter(Boolean)
  }

  async showIndexStage(repoPath: string, stage: 1 | 2 | 3, path: string): Promise<string | null> {
    try {
      return (await this.git(repoPath).raw(['show', `:${stage}:${path}`])).replace(/\n$/, '')
    } catch {
      return null
    }
  }

  async abortMerge(repoPath: string): Promise<void> {
    await this.git(repoPath).raw(['merge', '--abort'])
  }

  async mergeBase(repoPath: string, a: string, b: string): Promise<string> {
    const r = await this.git(repoPath).raw(['merge-base', a, b])
    return r.trim()
  }

  async lsRemote(
    url: string,
  ): Promise<{ tags: Record<string, string>; head: string; branches: string[] }> {
    const out = await this.git().listRemote([url])
    const tags: Record<string, string> = {}
    const branches: string[] = []
    let head = ''
    for (const line of out.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(/\s+/)
      if (ref === 'HEAD') head = sha
      else if (ref?.startsWith('refs/heads/')) {
        branches.push(ref.slice('refs/heads/'.length))
      } else if (ref?.startsWith('refs/tags/')) {
        const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')
        tags[name] = sha
      }
    }
    return { tags, head, branches }
  }

  async clone(url: string, dest: string, shallow = false): Promise<void> {
    const args = shallow ? ['--depth', '1'] : []
    await this.git().clone(url, dest, args.length ? args : undefined)
  }

  async checkout(repoPath: string, ref: string): Promise<void> {
    await this.git(repoPath).checkout(ref)
  }

  async add(repoPath: string, paths: string[]): Promise<void> {
    await this.git(repoPath).add(paths)
  }

  async commit(repoPath: string, msg: string): Promise<void> {
    await this.git(repoPath).commit(msg)
  }

  async push(repoPath: string): Promise<GitPushResult> {
    try {
      await this.git(repoPath).push('origin', 'HEAD')
      return { ok: true }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      const nonFastForward =
        /non-fast-forward|fetch first|updates were rejected because the tip/i.test(msg)
      return { ok: false, nonFastForward, message: msg, cause: err }
    }
  }

  async status(repoPath: string): Promise<{ dirty: boolean }> {
    const s = await this.git(repoPath).status()
    return { dirty: !s.isClean() }
  }

  async show(repoPath: string, ref: string, path: string): Promise<string> {
    return (await this.git(repoPath).raw(['show', `${ref}:${path}`])).trimEnd()
  }

  async revParseHead(repoPath: string): Promise<string> {
    return (await this.git(repoPath).raw(['rev-parse', 'HEAD'])).trim()
  }

  async revParse(repoPath: string, ref: string): Promise<string> {
    return (await this.git(repoPath).raw(['rev-parse', ref])).trim()
  }

  async lsTree(repoPath: string, ref: string, dir: string): Promise<string[]> {
    const d = dir.endsWith('/') ? dir : dir + '/'
    try {
      const out = await this.git(repoPath).raw(['ls-tree', '-r', '--name-only', `${ref}:${d}`])
      return out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async commitTree(
    repoPath: string,
    tree: string,
    parents: string[],
    message: string,
  ): Promise<string> {
    const args = ['commit-tree', tree, '-m', message]
    for (const p of parents) {
      args.push('-p', p)
    }
    return (await this.git(repoPath).raw(args)).trim()
  }

  async updateRef(repoPath: string, ref: string, commit: string): Promise<void> {
    await this.git(repoPath).raw(['update-ref', ref, commit])
  }

  async resetHard(repoPath: string, ref: string): Promise<void> {
    await this.git(repoPath).raw(['reset', '--hard', ref])
  }

  async writeTree(repoPath: string): Promise<string> {
    // write-tree reflects the staged index. syncPull stages merged files via add() first.
    return (await this.git(repoPath).raw(['write-tree'])).trim()
  }

  async addOrUpdateRemote(repoPath: string, remoteUrl: string): Promise<void> {
    const sg = simpleGit(repoPath)
    try {
      await sg.raw(['remote', 'add', 'origin', remoteUrl])
    } catch {
      // origin already exists, update the URL
      await sg.raw(['remote', 'set-url', 'origin', remoteUrl])
    }
  }

  async getRemoteUrl(repoPath: string): Promise<string | null> {
    try {
      const sg = simpleGit(repoPath)
      const out = await sg.raw(['remote', 'get-url', 'origin'])
      const trimmed = out.trim()
      return trimmed || null
    } catch {
      return null
    }
  }
}
