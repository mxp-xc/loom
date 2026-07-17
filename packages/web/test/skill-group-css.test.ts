import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const skillSourceCssPath = new URL(
  '../src/views/skills/SkillSourceList.module.css',
  import.meta.url,
)
const agentChipsCssPath = new URL('../src/styles/shared/agent-chips.css', import.meta.url)
const configFieldCssPath = new URL('../src/components/ConfigField.module.css', import.meta.url)

async function readCss(path: URL): Promise<string> {
  return await readFile(path, 'utf8')
}

function ruleBody(css: string, selector: string): string {
  const ruleStart = css.indexOf(`${selector} {`)
  expect(ruleStart, `Expected to find CSS rule for ${selector}`).toBeGreaterThanOrEqual(0)
  const bodyStart = css.indexOf('{', ruleStart)
  const bodyEnd = css.indexOf('}', bodyStart)
  expect(bodyStart).toBeGreaterThanOrEqual(0)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return css.slice(bodyStart + 1, bodyEnd)
}

function ruleBodyContaining(css: string, selector: string): string {
  const selectorIndex = css.indexOf(selector)
  expect(selectorIndex, 'Expected to find CSS rule containing ' + selector).toBeGreaterThanOrEqual(
    0,
  )
  const bodyStart = css.indexOf('{', selectorIndex)
  const bodyEnd = css.indexOf('}', bodyStart)
  expect(bodyStart).toBeGreaterThanOrEqual(0)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return css.slice(bodyStart + 1, bodyEnd)
}

describe('skill group header CSS', () => {
  it('keeps group spacing on the default cursor while the header stays interactive', async () => {
    const css = await readCss(skillSourceCssPath)
    const sortableGroup = ruleBodyContaining(
      css,
      ".sortable-group[role='button'][aria-roledescription='可排序项']:not([aria-disabled='true'])",
    )
    const groupHead = ruleBody(css, '.group-head')

    expect(sortableGroup).toMatch(/cursor\s*:\s*default\b/)
    expect(groupHead).toMatch(/cursor\s*:\s*pointer\b/)
  })

  it('keeps the pointer cursor across the page while a group drag is active', async () => {
    const css = await readCss(skillSourceCssPath)
    const draggingCursor = ruleBodyContaining(
      css,
      ":global(body[data-skill-group-dragging='true'] *)",
    )

    expect(draggingCursor).toMatch(/cursor\s*:\s*pointer\s*!important/)
  })

  it('does not animate an expanding header border from the text color', async () => {
    const css = await readCss(skillSourceCssPath)
    const groupHead = ruleBody(css, '.group-head')
    const collapsedGroupHead = ruleBody(css, ".group-head[data-expanded='false']")

    expect(groupHead).not.toMatch(/\bborder-color\b/)
    expect(collapsedGroupHead).not.toMatch(/border-bottom\s*:\s*(?:0|none)\b/)
    expect(collapsedGroupHead).toMatch(/border-bottom-width\s*:\s*0\b/)
  })

  it('centers compact skill badges and agent chips', async () => {
    const skillSourceCss = await readCss(skillSourceCssPath)
    const agentChipsCss = await readCss(agentChipsCssPath)
    const chip = ruleBody(skillSourceCss, '.chip')
    const compactBadge = ruleBodyContaining(skillSourceCss, '.ref-badge')
    const agentChip = ruleBody(agentChipsCss, '.agent-chip')
    const agentChipContract = ruleBody(agentChipsCss, ".agent-chip[data-agent-chip='true']")
    const agentChipIcon = ruleBody(agentChipsCss, '.agent-chip-icon')

    expect(chip).toMatch(/flex-shrink\s*:\s*0\b/)
    expect(compactBadge).toMatch(/display\s*:\s*inline-flex\b/)
    expect(compactBadge).toMatch(/align-items\s*:\s*center\b/)
    expect(compactBadge).toMatch(/justify-content\s*:\s*center\b/)
    expect(compactBadge).toMatch(/font-size\s*:\s*10px\b/)
    expect(compactBadge).toMatch(/font-weight\s*:\s*400\b/)
    expect(compactBadge).toMatch(/line-height\s*:\s*15px\b/)
    expect(compactBadge).toMatch(/padding\s*:\s*1px 6px\b/)
    expect(agentChip).toMatch(/display\s*:\s*inline-flex\b/)
    expect(agentChip).toMatch(/align-items\s*:\s*center\b/)
    expect(agentChip).toMatch(/justify-content\s*:\s*center\b/)
    expect(agentChip).toMatch(/font-size\s*:\s*10px\b/)
    expect(agentChip).toMatch(/font-weight\s*:\s*600\b/)
    expect(agentChip).toMatch(/min-height\s*:\s*26px\b/)
    expect(agentChip).toMatch(/padding\s*:\s*0 7px\b/)
    expect(agentChip).toMatch(/border-radius\s*:\s*999px\b/)
    expect(agentChipContract).toMatch(/width\s*:\s*26px\b/)
    expect(agentChipContract).toMatch(/height\s*:\s*26px\b/)
    expect(agentChipContract).toMatch(/padding\s*:\s*0\b/)
    expect(agentChipIcon).toMatch(/width\s*:\s*14px\b/)
    expect(agentChipIcon).toMatch(/height\s*:\s*14px\b/)
  })

  it('only enlarges agent chips in Settings fields', async () => {
    const css = await readCss(configFieldCssPath)
    const agentChip = ruleBody(css, ".cfg-agent-chips :global(.agent-chip[data-agent-chip='true'])")
    const agentChipIcon = ruleBody(css, '.cfg-agent-chips :global(.agent-chip-icon)')

    expect(agentChip).toMatch(/width\s*:\s*28px\b/)
    expect(agentChip).toMatch(/height\s*:\s*28px\b/)
    expect(agentChipIcon).toMatch(/width\s*:\s*16px\b/)
    expect(agentChipIcon).toMatch(/height\s*:\s*16px\b/)
  })
})
