import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const cssPath = new URL('../src/index.css', import.meta.url)

async function readIndexCss(): Promise<string> {
  return await readFile(cssPath, 'utf8')
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
    const css = await readIndexCss()
    const groupHead = ruleBody(css, '.group-head')
    const collapsedGroupHead = ruleBody(css, ".group-head[data-expanded='false']")

    expect(groupHead).not.toMatch(/\bborder-color\b/)
    expect(collapsedGroupHead).not.toMatch(/border-bottom\s*:\s*(?:0|none)\b/)
    expect(collapsedGroupHead).toMatch(/border-bottom-width\s*:\s*0\b/)
  })

  it('centers compact skill badges and target chips', async () => {
    const css = await readIndexCss()
    const chip = ruleBody(css, '.chip')
    const compactBadge = ruleBodyContaining(css, '.ref-badge')

    expect(chip).toMatch(/font-size\s*:\s*10px\b/)
    expect(chip).toMatch(/font-weight\s*:\s*400\b/)
    expect(chip).toMatch(/line-height\s*:\s*15px\b/)
    expect(compactBadge).toMatch(/display\s*:\s*inline-flex\b/)
    expect(compactBadge).toMatch(/align-items\s*:\s*center\b/)
    expect(compactBadge).toMatch(/justify-content\s*:\s*center\b/)
    expect(compactBadge).toMatch(/font-size\s*:\s*10px\b/)
    expect(compactBadge).toMatch(/font-weight\s*:\s*400\b/)
    expect(compactBadge).toMatch(/line-height\s*:\s*15px\b/)
    expect(compactBadge).toMatch(/padding\s*:\s*1px 6px\b/)
  })
})
