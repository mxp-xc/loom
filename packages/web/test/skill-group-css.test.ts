import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const skillSourceCssPath = new URL(
  '../src/views/skills/SkillSourceList.module.css',
  import.meta.url,
)
const targetChipsCssPath = new URL('../src/styles/shared/target-chips.css', import.meta.url)
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
  it('does not animate an expanding header border from the text color', async () => {
    const css = await readCss(skillSourceCssPath)
    const groupHead = ruleBody(css, '.group-head')
    const collapsedGroupHead = ruleBody(css, ".group-head[data-expanded='false']")

    expect(groupHead).not.toMatch(/\bborder-color\b/)
    expect(collapsedGroupHead).not.toMatch(/border-bottom\s*:\s*(?:0|none)\b/)
    expect(collapsedGroupHead).toMatch(/border-bottom-width\s*:\s*0\b/)
  })

  it('centers compact skill badges and target chips', async () => {
    const skillSourceCss = await readCss(skillSourceCssPath)
    const targetChipsCss = await readCss(targetChipsCssPath)
    const chip = ruleBody(skillSourceCss, '.chip')
    const compactBadge = ruleBodyContaining(skillSourceCss, '.ref-badge')
    const targetChip = ruleBody(targetChipsCss, '.target-chip')
    const agentTargetChip = ruleBody(targetChipsCss, ".target-chip[data-agent-chip='true']")
    const targetChipIcon = ruleBody(targetChipsCss, '.target-chip-icon')

    expect(chip).toMatch(/flex-shrink\s*:\s*0\b/)
    expect(compactBadge).toMatch(/display\s*:\s*inline-flex\b/)
    expect(compactBadge).toMatch(/align-items\s*:\s*center\b/)
    expect(compactBadge).toMatch(/justify-content\s*:\s*center\b/)
    expect(compactBadge).toMatch(/font-size\s*:\s*10px\b/)
    expect(compactBadge).toMatch(/font-weight\s*:\s*400\b/)
    expect(compactBadge).toMatch(/line-height\s*:\s*15px\b/)
    expect(compactBadge).toMatch(/padding\s*:\s*1px 6px\b/)
    expect(targetChip).toMatch(/display\s*:\s*inline-flex\b/)
    expect(targetChip).toMatch(/align-items\s*:\s*center\b/)
    expect(targetChip).toMatch(/justify-content\s*:\s*center\b/)
    expect(targetChip).toMatch(/font-size\s*:\s*10px\b/)
    expect(targetChip).toMatch(/font-weight\s*:\s*600\b/)
    expect(targetChip).toMatch(/min-height\s*:\s*26px\b/)
    expect(targetChip).toMatch(/padding\s*:\s*0 7px\b/)
    expect(targetChip).toMatch(/border-radius\s*:\s*999px\b/)
    expect(agentTargetChip).toMatch(/width\s*:\s*26px\b/)
    expect(agentTargetChip).toMatch(/height\s*:\s*26px\b/)
    expect(agentTargetChip).toMatch(/padding\s*:\s*0\b/)
    expect(targetChipIcon).toMatch(/width\s*:\s*14px\b/)
    expect(targetChipIcon).toMatch(/height\s*:\s*14px\b/)
  })

  it('only enlarges target chips in Settings fields', async () => {
    const css = await readCss(configFieldCssPath)
    const targetChip = ruleBody(
      css,
      ".cfg-target-chips :global(.target-chip[data-agent-chip='true'])",
    )
    const targetChipIcon = ruleBody(css, '.cfg-target-chips :global(.target-chip-icon)')

    expect(targetChip).toMatch(/width\s*:\s*28px\b/)
    expect(targetChip).toMatch(/height\s*:\s*28px\b/)
    expect(targetChipIcon).toMatch(/width\s*:\s*16px\b/)
    expect(targetChipIcon).toMatch(/height\s*:\s*16px\b/)
  })
})
