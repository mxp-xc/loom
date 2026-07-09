import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function readCss(relativePath: string): Promise<string> {
  return await readFile(new URL(relativePath, import.meta.url), 'utf8')
}

async function readSource(relativePath: string): Promise<string> {
  return await readFile(new URL(relativePath, import.meta.url), 'utf8')
}

describe('web CSS architecture', () => {
  it('keeps index.css as an ordered global/shared import interface', async () => {
    const css = await readCss('../src/index.css')
    const lines = css
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    expect(lines.every((line) => line.startsWith('@import '))).toBe(true)
    expect(lines.some((line) => line.includes('.module.css'))).toBe(false)
    expect(lines.some((line) => line.includes('./views/'))).toBe(false)
    expect(lines).toContain("@import './styles/global/tokens.css';")
    expect(lines).toContain("@import './styles/app-shell/shell.css';")
    expect(lines).toContain("@import './styles/shared/target-chips.css';")
    expect(lines).toContain("@import './styles/shared/markdown-preview.css';")
  })

  it('loads business-local CSS through owning CSS Modules', async () => {
    const ownerImports = [
      ['../src/views/skills/Skills.tsx', './Skills.module.css'],
      ['../src/views/skills/SkillSourceList.tsx', './SkillSourceList.module.css'],
      ['../src/views/skills/SkillDetailEditor.tsx', './SkillDetailEditor.module.css'],
      ['../src/views/skills/AddSkillModal.tsx', './AddSkillModal.module.css'],
      ['../src/views/Memory.tsx', './Memory.module.css'],
      ['../src/components/MemoryEditor.tsx', './MemoryEditor.module.css'],
      ['../src/views/Settings.tsx', './Settings.module.css'],
      ['../src/components/ConfigField.tsx', './ConfigField.module.css'],
      ['../src/views/Mcp.tsx', './Mcp.module.css'],
      ['../src/views/Sync.tsx', './Sync.module.css'],
      ['../src/views/sync/ConflictEditor.tsx', './ConflictEditor.module.css'],
      ['../src/views/vars/Vars.tsx', './Vars.module.css'],
      ['../src/views/vars/VarsProfileDemo.tsx', './VarsProfileDemo.module.css'],
    ] as const

    await Promise.all(
      ownerImports.map(async ([sourcePath, modulePath]) => {
        const source = await readSource(sourcePath)
        expect(source).toContain(`import styles from '${modulePath}'`)
      }),
    )
  })

  it('uses target-chip as the shared target selector contract', async () => {
    const targetChipsCss = await readCss('../src/styles/shared/target-chips.css')

    expect(targetChipsCss).toContain('.target-chips')
    expect(targetChipsCss).toContain('.target-chip')
    expect(targetChipsCss).toContain('.target-chip-count')
    expect(targetChipsCss).not.toContain('.cfg-chips')
    expect(targetChipsCss).not.toContain('.achip')
  })

  it('keeps every page layout aligned to the sidebar gutter', async () => {
    const pageLayoutCss = await readCss('../src/styles/app-shell/page-layout.css')

    expect(pageLayoutCss).toContain('margin-inline: 0 auto;')
    expect(pageLayoutCss).not.toContain('margin-inline: auto;')
  })

  it('keeps Sync hero metrics stable while remote status loads', async () => {
    const syncCss = await readCss('../src/views/Sync.module.css')

    expect(syncCss).toContain('flex: 0 0 136px;')
    expect(syncCss).toContain('min-height: 72px;')
    expect(syncCss).toContain('min-inline-size: 86px;')
    expect(syncCss).toContain('height: 76px;')
    expect(syncCss).toContain('white-space: nowrap;')
  })

  it('keeps legacy target chip selectors out of business CSS Modules', async () => {
    const businessModules = [
      '../src/views/skills/SkillSourceList.module.css',
      '../src/views/Memory.module.css',
      '../src/views/Settings.module.css',
      '../src/views/Mcp.module.css',
      '../src/views/Sync.module.css',
      '../src/views/vars/Vars.module.css',
    ] as const

    await Promise.all(
      businessModules.map(async (modulePath) => {
        const css = await readCss(modulePath)
        expect(css).not.toMatch(/\.cfg-chips\b/)
        expect(css).not.toMatch(/\.achip\b/)
        expect(css).not.toMatch(/\.achip-count\b/)
      }),
    )
  })
})
