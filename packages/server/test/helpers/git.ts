import { spawn } from 'node:child_process'
import { appendFile, cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

const TEST_GIT_NAME = 'Loom Test'
const TEST_GIT_EMAIL = 'test@loom.local'
const TEST_GIT_CONFIG = ['user.name=' + TEST_GIT_NAME, 'user.email=' + TEST_GIT_EMAIL]

export function testGit(baseDir?: string): SimpleGit {
  return baseDir
    ? simpleGit(baseDir, { config: TEST_GIT_CONFIG })
    : simpleGit({ config: TEST_GIT_CONFIG })
}

export interface GitFixtureCommit {
  message: string
  files: Record<string, string | null>
  tags?: string[]
}

export async function createBareRepo(commits: GitFixtureCommit[]): Promise<string> {
  const bare = await mkdtemp(join(tmpdir(), 'loom-git-bare-'))
  try {
    await testGit().raw(['init', '--bare', '-b', 'main', bare])
    await gitFastImport(bare, buildLinearImport(commits))
    return bare
  } catch (err) {
    return cleanupFailedFixture(bare, err)
  }
}

export interface DivergedFile {
  path: string
  base?: string
  ours?: string
  theirs?: string
  baseMode?: '100644' | '100755' | '120000'
  oursMode?: '100644' | '100755' | '120000'
  theirsMode?: '100644' | '100755' | '120000'
}

export interface DivergedRepo {
  root: string
  home: string
  repo: string
}

interface DivergedTemplate {
  root: string
  repo: string
  bare: string
}

const templates = new Map<string, Promise<DivergedTemplate>>()

export async function createDivergedRepo(files: DivergedFile[]): Promise<DivergedRepo> {
  const template = await getDivergedTemplate(files)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'loom-git-test-')))
  const home = join(root, 'home')
  const repo = join(root, 'repo')

  try {
    await cp(template.repo, repo, { recursive: true })
    return { root, home, repo }
  } catch (err) {
    return cleanupFailedFixture(root, err)
  }
}

export async function cleanupGitTestTemplates(): Promise<void> {
  const settled = await Promise.allSettled(templates.values())
  templates.clear()
  await Promise.all(
    settled.map((result) =>
      result.status === 'fulfilled'
        ? rm(result.value.root, { recursive: true, force: true })
        : Promise.resolve(),
    ),
  )
}

function getDivergedTemplate(files: DivergedFile[]): Promise<DivergedTemplate> {
  const key = JSON.stringify(files)
  let template = templates.get(key)
  if (!template) {
    template = buildDivergedTemplate(files)
    templates.set(key, template)
    void template.catch(() => {
      if (templates.get(key) === template) templates.delete(key)
    })
  }
  return template
}

async function buildDivergedTemplate(files: DivergedFile[]): Promise<DivergedTemplate> {
  const root = await mkdtemp(join(tmpdir(), 'loom-git-template-'))
  const repo = join(root, 'repo')
  const bare = join(root, 'remote.git')
  try {
    await writeDivergedHistory(bare, files)
    await testGit().clone(bare, repo, [
      '--config',
      'remote.origin.pushurl=' + join(root, 'read-only-remote.git'),
    ])

    const git = testGit(repo)
    await git.raw(['reset', '--hard', 'origin/local'])
    await appendFile(
      join(repo, '.git', 'config'),
      '\n[user]\n\tname = ' + TEST_GIT_NAME + '\n\temail = ' + TEST_GIT_EMAIL + '\n',
    )

    return { root, repo, bare }
  } catch (err) {
    return cleanupFailedFixture(root, err)
  }
}

async function cleanupFailedFixture(root: string, error: unknown): Promise<never> {
  try {
    await rm(root, { recursive: true, force: true })
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Git fixture creation and cleanup failed')
  }
  throw error
}

// Build the three-commit test topology in one Git process:
// base -> local branch (ours), and base -> origin/main (theirs).
// This keeps tests faithful to real Git merge behavior while avoiding several
// clone/commit/push subprocesses for every unique fixture shape.
async function writeDivergedHistory(bare: string, files: DivergedFile[]): Promise<void> {
  await testGit().raw(['init', '--bare', '-b', 'main', bare])
  await gitFastImport(bare, buildDivergedImport(files))
}

function buildDivergedImport(files: DivergedFile[]): string {
  let nextMark = 1
  const chunks: string[] = []
  const baseOps: string[] = []
  const oursOps: string[] = []
  const theirsOps: string[] = []

  for (const file of files) {
    if (file.base !== undefined) {
      chunks.push(fastImportBlob(nextMark, file.base))
      baseOps.push(fastImportModify(nextMark, file.path, file.baseMode))
      nextMark++
    }
    if (file.ours !== undefined) {
      chunks.push(fastImportBlob(nextMark, file.ours))
      oursOps.push(fastImportModify(nextMark, file.path, file.oursMode))
      nextMark++
    }
    if (file.theirs !== undefined) {
      chunks.push(fastImportBlob(nextMark, file.theirs))
      theirsOps.push(fastImportModify(nextMark, file.path, file.theirsMode))
      nextMark++
    }
  }

  const baseCommit = nextMark++
  chunks.push(fastImportCommit('refs/heads/main', baseCommit, 'base', null, baseOps))
  if (theirsOps.length > 0) {
    chunks.push(
      fastImportCommit('refs/heads/main', nextMark++, 'theirs', ':' + baseCommit, theirsOps),
    )
  }
  if (oursOps.length > 0) {
    chunks.push(fastImportCommit('refs/heads/local', nextMark++, 'ours', ':' + baseCommit, oursOps))
  } else {
    chunks.push('reset refs/heads/local\nfrom :' + baseCommit + '\n')
  }

  return chunks.join('')
}

function buildLinearImport(commits: GitFixtureCommit[]): string {
  let nextMark = 1
  let parent: number | null = null
  const chunks: string[] = []

  for (const commit of commits) {
    const operations: string[] = []
    for (const [path, content] of Object.entries(commit.files)) {
      if (content === null) {
        operations.push('D ' + fastImportPath(path) + '\n')
        continue
      }
      chunks.push(fastImportBlob(nextMark, content))
      operations.push(fastImportModify(nextMark, path))
      nextMark++
    }

    const commitMark = nextMark++
    chunks.push(
      fastImportCommit(
        'refs/heads/main',
        commitMark,
        commit.message,
        parent === null ? null : ':' + parent,
        operations,
      ),
    )
    for (const tag of commit.tags ?? []) {
      chunks.push('reset refs/tags/' + tag + '\nfrom :' + commitMark + '\n')
    }
    parent = commitMark
  }

  return chunks.join('')
}

function fastImportBlob(mark: number, content: string): string {
  return (
    'blob\nmark :' + mark + '\ndata ' + Buffer.byteLength(content, 'utf8') + '\n' + content + '\n'
  )
}

function fastImportModify(
  mark: number,
  path: string,
  mode: '100644' | '100755' | '120000' = '100644',
): string {
  return 'M ' + mode + ' :' + mark + ' ' + fastImportPath(path) + '\n'
}

function fastImportCommit(
  ref: string,
  mark: number,
  message: string,
  parent: string | null,
  operations: string[],
): string {
  return (
    'commit ' +
    ref +
    '\nmark :' +
    mark +
    '\nauthor ' +
    TEST_GIT_NAME +
    ' <' +
    TEST_GIT_EMAIL +
    '> 946684800 +0000\ncommitter ' +
    TEST_GIT_NAME +
    ' <' +
    TEST_GIT_EMAIL +
    '> 946684800 +0000\ndata ' +
    Buffer.byteLength(message, 'utf8') +
    '\n' +
    message +
    '\n' +
    (parent ? 'from ' + parent + '\n' : '') +
    operations.join('')
  )
}

export function fastImportPath(path: string): string {
  const segments = path.split('/')
  if (
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    path.startsWith('/') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Unsupported test fixture path for git fast-import: ' + path)
  }
  return path
}

export function gitFastImport(repo: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', repo, 'fast-import', '--quiet'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => finish(err))
    child.stdin.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code === 0) {
        finish()
      } else {
        finish(new Error(stderr || 'git fast-import failed with exit code ' + code))
      }
    })
    child.stdin.end(script)
  })
}
