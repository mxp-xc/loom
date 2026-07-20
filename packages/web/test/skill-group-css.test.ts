// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { webSourcePath } from './project-path'

const skillSourceCssPath = webSourcePath('views/skills/SkillSourceList.module.css')

async function readCss(path: string): Promise<string> {
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
})
