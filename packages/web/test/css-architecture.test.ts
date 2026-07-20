// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { webPackagePath, webSourcePath } from './project-path'

async function readCss(relativePath: string): Promise<string> {
  return await readFile(webPackagePath('test', relativePath), 'utf8')
}

async function readSource(relativePath: string): Promise<string> {
  return await readFile(webPackagePath('test', relativePath), 'utf8')
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
    expect(lines).toContain("@import './styles/shared/agent-chips.css';")
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
      ['../src/views/Mcp.tsx', './mcp/McpWorkbench.module.css'],
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

  it('uses agent-chip as the shared agent selector contract', async () => {
    const agentChipsCss = await readCss('../src/styles/shared/agent-chips.css')

    expect(agentChipsCss).toContain('.agent-chips')
    expect(agentChipsCss).toContain('.agent-chip')
    expect(agentChipsCss).toContain('.agent-chip-count')
    expect(agentChipsCss).not.toContain('.cfg-chips')
    expect(agentChipsCss).not.toContain('.achip')
  })

  it('keeps legacy agent chip selectors out of business CSS Modules', async () => {
    const businessModules = [
      '../src/views/skills/SkillSourceList.module.css',
      '../src/views/Memory.module.css',
      '../src/views/Settings.module.css',
      '../src/views/mcp/McpWorkbench.module.css',
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

  it('keeps Skills workbench field labels and composite input focus aligned with the UI spec', async () => {
    const [addSkillCss, editSourceCss, selectionCss] = await Promise.all([
      readCss('../src/views/skills/AddSkillModal.module.css'),
      readCss('../src/views/skills/EditSourceModal.module.css'),
      readCss('../src/views/skills/SkillSelectionList.module.css'),
    ])

    for (const css of [addSkillCss, editSourceCss]) {
      expect(css).toContain('.fieldLabel')
      expect(css).toMatch(/\.fieldLabel\s*\{[^}]*font-weight:\s*600;/s)
      expect(css).toMatch(/\.inputWithIcon input:focus\s*\{[^}]*box-shadow:\s*none;/s)
      expect(css).toMatch(/\.control:focus\s*\{[^}]*box-shadow:\s*none;/s)
    }
    expect(selectionCss).toMatch(/\.search input:focus\s*\{[^}]*box-shadow:\s*none;/s)
  })

  it('keeps text-field focus free of square glow across business views', async () => {
    const focusCss = await Promise.all(
      [
        '../src/styles/global/base.css',
        '../src/components/ConfigField.module.css',
        '../src/components/ui/SelectableList.css',
        '../src/views/mcp/McpWorkbench.module.css',
        '../src/views/Sync.module.css',
        '../src/views/vars/Vars.module.css',
        '../src/views/vars/VarsProfileDemo.module.css',
      ].map(readCss),
    )

    for (const css of focusCss) {
      const focusRules = css.match(/(?:input|textarea|select)[^,{]*:focus[^{}]*\{[^}]*\}/gs) ?? []
      for (const rule of focusRules) {
        const shadows = [...rule.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) =>
          match[1].trim(),
        )
        expect(shadows.every((shadow) => shadow === 'none')).toBe(true)
      }
    }
  })

  it('keeps Vars field styles out of nested Monaco content', async () => {
    const varsCss = await readCss('../src/views/vars/Vars.module.css')

    expect(varsCss).toContain('.vars-editor-card > p')
    expect(varsCss).toContain('.vars-field > span')
    expect(varsCss).toContain('.vars-field > textarea')
    expect(varsCss).toContain('.vars-editor-field > textarea')
    expect(varsCss).toMatch(
      /\.vars-preview\s*{[^}]*color: var\(--bright\);[^}]*font-family: 'JetBrains Mono', monospace;[^}]*font-size: 13px;[^}]*line-height: 1\.7;/s,
    )
    expect(varsCss).not.toMatch(/\.vars-preview-raw\s*{[^}]*(?:color|font(?:-family)?):/s)
    expect(varsCss).not.toMatch(/\.vars-field span\b/)
    expect(varsCss).not.toMatch(/\.vars-field textarea\b/)
    expect(varsCss).not.toMatch(/\.vars-editor-card p\b/)
    expect(varsCss).not.toMatch(/\.vars-editor-field textarea\b/)
  })

  it('uses pointer cursors for interactive controls and sortable activators', async () => {
    const [baseCss, skillSourceListCss] = await Promise.all([
      readCss('../src/styles/global/base.css'),
      readCss('../src/views/skills/SkillSourceList.module.css'),
    ])

    expect(baseCss).toMatch(/button:not\(:disabled\)[^{]*\{[^}]*cursor:\s*pointer;/s)
    expect(baseCss).toMatch(
      /\[role='button'\]\[aria-roledescription='可排序项'\][^{]*\{[^}]*cursor:\s*pointer;/s,
    )
    expect(skillSourceListCss).toMatch(/\.skill\s*\{[^}]*cursor:\s*pointer;/s)
  })

  it('does not use open-hand or closed-hand cursors', async () => {
    const sourceRoot = webSourcePath()
    const cssPaths = (await readdir(sourceRoot, { recursive: true }))
      .filter((path) => path.endsWith('.css'))
      .map((path) => path.replaceAll('\\', '/'))
    const cssFiles = await Promise.all(
      cssPaths.map(async (path) => ({ path, css: await readCss(`../src/${path}`) })),
    )

    for (const { path, css } of cssFiles) {
      expect(css, path).not.toMatch(/cursor:\s*grabb?(?:ing)?\s*;/)
    }
  })
})
