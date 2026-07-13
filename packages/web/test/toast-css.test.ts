import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const cssPath = new URL('../src/components/Toast.css', import.meta.url)

describe('toast CSS', () => {
  it('vertically centers toast content within each notification row', async () => {
    const css = await readFile(cssPath, 'utf8')
    const rule = css.match(/\.app-toast\s*\{([^}]*)\}/)?.[1]

    expect(rule).toBeDefined()
    expect(rule).toMatch(/align-items\s*:\s*center\b/)
  })
})
