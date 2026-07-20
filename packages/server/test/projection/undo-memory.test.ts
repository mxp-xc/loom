import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyUndo } from '../../src/projection/executor.js'
import { NodeFileSystem } from '../../src/platform/node/fs.js'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('applyUndo restoreMemory', () => {
  let fs: NodeFileSystem
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-undo-'))
    fs = new NodeFileSystem()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('restoreMemory with backup writes backup back', async () => {
    const f = join(dir, 'CLAUDE.md')
    await fs.writeFile(f, 'projected')
    const installed = await fs.inspectEntry(f)
    await applyUndo(
      {
        kind: 'restoreMemory',
        path: f,
        backup: 'original',
        installedIdentity: installed!.identity,
      },
      fs,
    )
    expect(readFileSync(f, 'utf8')).toBe('original')
  })

  it('restoreMemory with null backup deletes newly created file', async () => {
    const f = join(dir, 'AGENTS.md')
    await fs.writeFile(f, 'projected')
    const installed = await fs.inspectEntry(f)
    await applyUndo(
      { kind: 'restoreMemory', path: f, backup: null, installedIdentity: installed!.identity },
      fs,
    )
    expect(existsSync(f)).toBe(false)
  })
})
