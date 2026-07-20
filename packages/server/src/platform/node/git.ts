import { simpleGit, type SimpleGit } from 'simple-git'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitPushResult, GitTreeEntry, IGit } from '../../ports/git.js'
import { GitUnbornHeadError, readGitHead } from './git-head.js'

const execFileAsync = promisify(execFile)

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
    return this.pushWithArgs(repoPath, ['origin', 'HEAD'])
  }

  async forcePush(repoPath: string): Promise<GitPushResult> {
    return this.pushWithArgs(repoPath, ['--force', 'origin', 'HEAD'])
  }

  private async pushWithArgs(repoPath: string, args: string[]): Promise<GitPushResult> {
    try {
      await this.git(repoPath).raw(['push', ...args])
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
    return this.git(repoPath).raw(['show', `${ref}:${path}`])
  }

  async showBytes(repoPath: string, ref: string, path: string): Promise<Uint8Array> {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'show', `${ref}:${path}`], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  }

  async revParseHead(repoPath: string): Promise<string> {
    const head = await readGitHead(this.git(repoPath))
    if (head.kind === 'unborn') {
      throw new GitUnbornHeadError(head.ref, { cause: head.error })
    }
    return head.oid
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

  async readTree(repoPath: string, ref: string): Promise<GitTreeEntry[]> {
    const out = await this.git(repoPath).raw(['ls-tree', '-r', '-t', '-z', '--full-tree', ref])
    return out
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf('\t')
        const header = tab >= 0 ? record.slice(0, tab) : ''
        const path = tab >= 0 ? record.slice(tab + 1) : ''
        const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)$/.exec(header)
        if (!match || !path) throw new Error(`Invalid git ls-tree record: ${record}`)
        return {
          mode: match[1],
          type: match[2] as GitTreeEntry['type'],
          oid: match[3],
          path,
        }
      })
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
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
