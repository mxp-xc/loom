import { readFile, readdir } from 'node:fs/promises'
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

  it('keeps every page layout aligned to the sidebar gutter', async () => {
    const pageLayoutCss = await readCss('../src/styles/app-shell/page-layout.css')

    expect(pageLayoutCss).toContain('margin-inline: 0 auto;')
    expect(pageLayoutCss).not.toContain('margin-inline: auto;')
  })

  it('keeps the global sidebar aligned with the high-fidelity navigation surface', async () => {
    const shellCss = await readCss('../src/styles/app-shell/shell.css')

    expect(shellCss).toMatch(
      /\.sidebar\s*\{[^}]*background:\s*var\(--card\);[^}]*padding:\s*24px 12px 16px;/s,
    )
    expect(shellCss).toMatch(
      /\.nav-item\s*\{[^}]*min-height:\s*44px;[^}]*padding:\s*0 12px;[^}]*font-size:\s*13px;[^}]*border-radius:\s*6px;/s,
    )
    expect(shellCss).toMatch(
      /\.nav-item\.active\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--primary\) 8%, var\(--card\)\);[^}]*box-shadow:\s*inset 2px 0 var\(--primary\);/s,
    )
    expect(shellCss).not.toContain(
      'background: linear-gradient(90deg, var(--accent), transparent);',
    )
  })

  it('keeps Sync hero metrics stable while remote status loads', async () => {
    const syncCss = await readCss('../src/views/Sync.module.css')

    expect(syncCss).toContain('flex: 0 0 136px;')
    expect(syncCss).toContain('min-height: 72px;')
    expect(syncCss).toContain('min-inline-size: 86px;')
    expect(syncCss).toContain('height: 76px;')
    expect(syncCss).toContain('white-space: nowrap;')
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
    const sourceRoot = new URL('../src/', import.meta.url)
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

  it('keeps composite search focus on the rounded container only', async () => {
    const [mcpCss, varsCss, varsDemoCss] = await Promise.all([
      readCss('../src/views/mcp/McpWorkbench.module.css'),
      readCss('../src/views/vars/Vars.module.css'),
      readCss('../src/views/vars/VarsProfileDemo.module.css'),
    ])

    expect(mcpCss).toMatch(/\.search input:focus\s*\{[^}]*box-shadow:\s*none;/s)
    for (const selector of ['vars-search', 'vars-key-filter']) {
      expect(varsCss).toMatch(
        new RegExp(`\\.${selector} input:focus\\s*\\{[^}]*box-shadow:\\s*none;`, 's'),
      )
    }
    for (const selector of ['vars-lab-search', 'vars-lab-key-filter']) {
      expect(varsDemoCss).toMatch(
        new RegExp(`\\.${selector} input:focus\\s*\\{[^}]*box-shadow:\\s*none;`, 's'),
      )
    }
  })

  it('keeps the MCP workbench aligned to the shared gutter and animates drawer entry', async () => {
    const mcpCss = await readCss('../src/views/mcp/McpWorkbench.module.css')

    expect(mcpCss).not.toContain('margin: 17px clamp(0px, 3vw, 45px) 14px;')
    expect(mcpCss).not.toContain('calc(8px - var(--page-gutter))')
    expect(mcpCss).toMatch(/\.inventoryHeader\s*\{[^}]*display:\s*grid;/s)
    expect(mcpCss).toMatch(/\.globalAgents\s*\{[^}]*border-top:\s*1px solid var\(--border\);/s)
    for (const selector of [
      'sectionTabs button',
      'transportTabs button',
      'editorModeSwitch button',
    ]) {
      expect(mcpCss).toMatch(new RegExp(`\\.${selector}\\s*\\{[^}]*cursor:\\s*pointer;`, 's'))
    }
    expect(mcpCss).toMatch(/\.transportTabs\s*\{[^}]*border:\s*1px solid var\(--border\);/s)
    expect(mcpCss).toMatch(/\.editorModeSwitch\s*\{[^}]*border:\s*1px solid var\(--border\);/s)
    expect(mcpCss).toMatch(/\.recordModeSwitch\s*\{[^}]*border:\s*1px solid var\(--border\);/s)
    expect(mcpCss).toMatch(/\.fieldInput\s*\{[^}]*display:\s*flex;/s)
    expect(mcpCss).toMatch(/\.argumentHandle\s*\{[^}]*cursor:\s*pointer;/s)
    expect(mcpCss).toMatch(/\.toolsList button > svg\s*\{[^}]*grid-row:\s*span 2;/s)
    expect(mcpCss).toMatch(
      /\.toolsList button span,\s*\.toolsList button small\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    )
    expect(mcpCss).toMatch(
      /\.toolsBody\s*\{[^}]*grid-template-columns:\s*minmax\(280px, 0\.44fr\) minmax\(0, 0\.56fr\);/s,
    )
    expect(mcpCss).toMatch(
      /\.drawerBodyTools\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/s,
    )
    expect(mcpCss).toMatch(
      /\.toolsDebug\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*flex-direction:\s*column;/s,
    )
    expect(mcpCss).toMatch(/\.toolsBody\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;/s)
    expect(mcpCss).toMatch(
      /\.toolsColumn > header\s*\{[^}]*display:\s*grid;[^}]*min-height:\s*60px;/s,
    )
    expect(mcpCss).toMatch(/\.toolsList\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*auto;/s)
    expect(mcpCss).toMatch(
      /\.toolsConnectionButton\s*\{[^}]*border-radius:\s*999px;[^}]*font-size:\s*11px;/s,
    )
    expect(mcpCss).toMatch(/\.toolCallSpinner\s*\{[^}]*animation:\s*tool-call-spin/s)
    expect(mcpCss).toContain('@keyframes drawer-pane-in')
    expect(mcpCss).toMatch(
      /\.drawerLayer\[data-open='true'\] \.contentPane\s*\{[^}]*animation:\s*drawer-pane-in/s,
    )
  })

  it('keeps Skills modal workbenches inside the mobile modal height', async () => {
    const [workbenchCss, sourceTreeCss, editSourceCss, detailCss] = await Promise.all([
      readCss('../src/views/skills/SkillWorkbench.module.css'),
      readCss('../src/views/skills/SourceTreeSelection.module.css'),
      readCss('../src/views/skills/EditSourceModal.module.css'),
      readCss('../src/views/skills/SkillDetailEditor.module.css'),
    ])

    expect(workbenchCss).toMatch(/\.workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s)
    expect(sourceTreeCss).toMatch(
      /\.selectionToolbar\[data-view='tree'\] \.searchControl\s*\{[^}]*grid-row:\s*3;/s,
    )
    expect(sourceTreeCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*\.treeActions\s*\{[^}]*grid-column:\s*1 \/ -1;/,
    )
    expect(sourceTreeCss).toMatch(
      /\.bundleList\[data-empty='true'\] \.emptyResult\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s,
    )
    expect(sourceTreeCss).toMatch(/\.viewSwitch button\s*\{[^}]*cursor:\s*pointer;/s)
    expect(sourceTreeCss).toMatch(
      /\.treeRow\[data-expandable='true'\]\s*\{[^}]*cursor:\s*pointer;/s,
    )
    expect(workbenchCss).toContain('height: calc(92dvh - 72px);')
    expect(editSourceCss).not.toContain('height: calc(100dvh - 76px);')
    expect(detailCss).not.toContain('height: calc(100dvh - 76px);')
  })
})
