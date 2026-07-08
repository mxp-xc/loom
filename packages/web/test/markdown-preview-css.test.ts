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

describe('markdown preview CSS', () => {
  it('vertically centers frontmatter keys within each metadata row', async () => {
    const css = await readIndexCss()
    const row = ruleBody(css, '.md-frontmatter-row')
    const key = ruleBody(css, '.md-frontmatter dt')

    expect(row).toMatch(/align-items\s*:\s*center\b/)
    expect(key).toMatch(/align-self\s*:\s*stretch\b/)
    expect(key).toMatch(/display\s*:\s*flex\b/)
    expect(key).toMatch(/align-items\s*:\s*center\b/)
  })
})
