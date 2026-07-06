import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

const TEST_GIT_NAME = 'Loom Test'
const TEST_GIT_EMAIL = 'test@loom.local'
const TEST_GIT_CONFIG = ['user.name=' + TEST_GIT_NAME, 'user.email=' + TEST_GIT_EMAIL]

export function testGit(baseDir?: string): SimpleGit {
  return baseDir
    ? simpleGit(baseDir, { config: TEST_GIT_CONFIG })
    : simpleGit({ config: TEST_GIT_CONFIG })
}

export interface DivergedFile {
  path: string
  base?: string
  ours?: string
  theirs?: string
}

export interface DivergedRepo {
  root: string
  home: string
  repo: string
  bare: string
}

interface DivergedTemplate {
  root: string
  repo: string
  bare: string
}

const templates = new Map<string, Promise<DivergedTemplate>>()

export async function createDivergedRepo(files: DivergedFile[]): Promise<DivergedRepo> {
  const template = await getDivergedTemplate(files)
  const root = await mkdtemp(join(tmpdir(), 'loom-git-test-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const bare = join(root, 'remote.git')

  await cp(template.repo, repo, { recursive: true })
  await cp(template.bare, bare, { recursive: true })
  await testGit(repo).raw(['remote', 'set-url', 'origin', bare])

  return { root, home, repo, bare }
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
  }
  return template
}

async function buildDivergedTemplate(files: DivergedFile[]): Promise<DivergedTemplate> {
  const root = await mkdtemp(join(tmpdir(), 'loom-git-template-'))
  const repo = join(root, 'repo')
  const bare = join(root, 'remote.git')
  const peer = join(root, 'peer')

  await testGit().raw(['init', '--bare', '-b', 'main', bare])
  await testGit().clone(bare, repo)
  const git = testGit(repo)
  await appendFile(
    join(repo, '.git', 'config'),
    '\n[user]\n\tname = ' + TEST_GIT_NAME + '\n\temail = ' + TEST_GIT_EMAIL + '\n',
  )
  await writeFiles(repo, files, 'base')
  await git.add('.')
  await git.commit('base')
  await git.push('origin', 'HEAD:main')

  await writeFiles(repo, files, 'ours')
  await commitIfDirty(git, 'ours')

  await testGit().clone(bare, peer)
  const remoteGit = testGit(peer)
  await writeFiles(peer, files, 'theirs')
  await commitIfDirty(remoteGit, 'theirs')
  await remoteGit.push('origin', 'HEAD:main')
  await rm(peer, { recursive: true, force: true })

  return { root, repo, bare }
}

async function writeFiles(
  root: string,
  files: DivergedFile[],
  side: 'base' | 'ours' | 'theirs',
): Promise<void> {
  for (const file of files) {
    const content = file[side]
    if (content === undefined) continue
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

async function commitIfDirty(git: SimpleGit, message: string): Promise<void> {
  if ((await git.status()).isClean()) return
  await git.add('.')
  await git.commit(message)
}
