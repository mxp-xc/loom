import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillsManifest } from '@loom/core'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import {
  discoverBuiltInLocalSkills,
  prepareBuiltInLocalSkill,
  resolveEffectiveLocalSkill,
  resolveRegisteredLocalSkill,
} from '../../src/skills/local-paths.js'

describe('local skill path authorization', () => {
  let root: string
  let repoPath: string
  let fs: NodeFileSystem

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loom-local-paths-'))
    repoPath = join(root, 'repo')
    await mkdir(repoPath)
    fs = new NodeFileSystem()
  })

  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('resolves a pathless manifest entry only from a real built-in direct child', async () => {
    const directory = await createBuiltIn(repoPath, 'alpha')
    const resolved = await resolveRegisteredLocalSkill(
      fs,
      repoPath,
      manifest({ id: 'alpha' }),
      'alpha',
    )

    expect(resolved).toMatchObject({
      id: 'alpha',
      provenance: 'manifest-built-in',
      directory,
      available: true,
    })
  })

  it('discovers only valid direct children and never flattens nested skills', async () => {
    await createBuiltIn(repoPath, 'alpha')
    await mkdir(join(repoPath, 'assets', 'skills', 'team', 'nested'), { recursive: true })
    await writeFile(join(repoPath, 'assets', 'skills', 'team', 'nested', 'SKILL.md'), '# nested')
    await createBuiltIn(repoPath, 'BadSkill')

    expect((await discoverBuiltInLocalSkills(fs, repoPath)).map((skill) => skill.id)).toEqual([
      'alpha',
    ])
  })

  it('rejects a built-in directory link even when its target contains SKILL.md', async () => {
    const target = join(root, 'target')
    await mkdir(target)
    await writeFile(join(target, 'SKILL.md'), '# target')
    const skillsRoot = join(repoPath, 'assets', 'skills')
    await mkdir(skillsRoot, { recursive: true })
    await symlink(
      target,
      join(skillsRoot, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(
      resolveEffectiveLocalSkill(fs, repoPath, manifest(), 'linked'),
    ).rejects.toMatchObject({ code: 'invalid_local_skill_path' })
  })

  it.skipIf(process.platform === 'win32')('rejects a linked SKILL.md leaf', async () => {
    const directory = join(repoPath, 'assets', 'skills', 'alpha')
    const target = join(root, 'target.md')
    await mkdir(directory, { recursive: true })
    await writeFile(target, '# target')
    await symlink(target, join(directory, 'SKILL.md'), 'file')

    await expect(
      resolveEffectiveLocalSkill(fs, repoPath, manifest(), 'alpha'),
    ).rejects.toMatchObject({ code: 'invalid_local_skill_path' })
  })

  it('resolves registered absolute and repo-relative external refs', async () => {
    const absolute = join(root, 'absolute')
    const relative = join(repoPath, 'external', 'relative')
    await mkdir(absolute)
    await mkdir(relative, { recursive: true })
    await writeFile(join(absolute, 'SKILL.md'), '# absolute')
    await writeFile(join(relative, 'SKILL.md'), '# relative')

    await expect(
      resolveRegisteredLocalSkill(
        fs,
        repoPath,
        manifest({ id: 'absolute', path: absolute }),
        'absolute',
      ),
    ).resolves.toMatchObject({
      provenance: 'manifest-external',
      directory: await fs.realPath(absolute),
      available: true,
    })
    await expect(
      resolveRegisteredLocalSkill(
        fs,
        repoPath,
        manifest({ id: 'relative', path: 'external/relative' }),
        'relative',
      ),
    ).resolves.toMatchObject({
      provenance: 'manifest-external',
      directory: await fs.realPath(relative),
      available: true,
    })
  })

  it('keeps a missing registered external ref unavailable without falling back to built-in', async () => {
    await createBuiltIn(repoPath, 'alpha')

    await expect(
      resolveEffectiveLocalSkill(
        fs,
        repoPath,
        manifest({ id: 'alpha', path: join(root, 'missing') }),
        'alpha',
      ),
    ).resolves.toMatchObject({ provenance: 'manifest-external', available: false })
  })

  it('rejects duplicate manifest identities before filesystem discovery', async () => {
    const inspect = vi.spyOn(fs, 'inspectEntry')
    const skills: SkillsManifest = { sources: [], skills: [{ id: 'alpha' }, { id: 'alpha' }] }

    await expect(resolveEffectiveLocalSkill(fs, repoPath, skills, 'alpha')).rejects.toMatchObject({
      code: 'invalid_skills_manifest',
    })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('prepares only a missing built-in destination', async () => {
    const canonicalRepo = await fs.realPath(repoPath)
    await expect(prepareBuiltInLocalSkill(fs, repoPath, 'new-skill')).resolves.toMatchObject({
      directory: join(canonicalRepo, 'assets', 'skills', 'new-skill'),
    })
    await createBuiltIn(repoPath, 'existing')
    await expect(prepareBuiltInLocalSkill(fs, repoPath, 'existing')).rejects.toMatchObject({
      code: 'local_skill_exists',
    })
  })

  it('creates a real built-in root under the canonical repository and returns stable ownership', async () => {
    const prepared = await prepareBuiltInLocalSkill(fs, repoPath, 'new-skill')

    expect(prepared.root.repository).toMatchObject({
      path: await fs.realPath(repoPath),
      identity: expect.any(String),
    })
    expect(prepared.root.assets).toMatchObject({
      path: await fs.realPath(join(repoPath, 'assets')),
      identity: expect.any(String),
    })
    expect(prepared.root.directory).toMatchObject({
      path: await fs.realPath(join(repoPath, 'assets', 'skills')),
      identity: expect.any(String),
    })
  })

  it('fails closed when the built-in root is a link and never writes through it', async () => {
    const outside = join(root, 'outside')
    await mkdir(join(repoPath, 'assets'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'keep')
    await symlink(
      outside,
      join(repoPath, 'assets', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(discoverBuiltInLocalSkills(fs, repoPath)).rejects.toMatchObject({
      code: 'invalid_local_skill_path',
    })
    await expect(prepareBuiltInLocalSkill(fs, repoPath, 'new-skill')).rejects.toMatchObject({
      code: 'invalid_local_skill_path',
    })
    expect(await fs.inspectEntry(join(outside, 'new-skill'))).toBeNull()
  })
})

function manifest(...skills: SkillsManifest['skills']): SkillsManifest {
  return { sources: [], skills }
}

async function createBuiltIn(repoPath: string, id: string): Promise<string> {
  const directory = join(repoPath, 'assets', 'skills', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `# ${id}`)
  return new NodeFileSystem().realPath(directory)
}
