// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageLayout, type PageLayoutVariant } from '../src/components/PageLayout'

describe('PageLayout', () => {
  it.each([
    ['content', 'page-layout--content'],
    ['workbench', 'page-layout--workbench'],
    ['fullHeight', 'page-layout--full-height'],
  ] satisfies Array<[PageLayoutVariant, string]>)(
    'renders the %s layout variant',
    (variant, variantClass) => {
      const { container } = render(
        <PageLayout variant={variant}>
          <span>layout content</span>
        </PageLayout>,
      )

      const layout = container.querySelector('[data-page-layout="' + variant + '"]')
      expect(layout).toBeTruthy()
      expect(layout?.classList.contains('page-layout')).toBe(true)
      expect(layout?.classList.contains(variantClass)).toBe(true)
      expect(screen.getByText('layout content')).toBeDefined()
    },
  )

  it('merges custom class names without dropping layout classes', () => {
    const { container } = render(
      <PageLayout variant="workbench" className="custom-layout">
        <span>custom content</span>
      </PageLayout>,
    )

    const layout = container.querySelector('[data-page-layout="workbench"]')
    expect(layout?.classList.contains('page-layout')).toBe(true)
    expect(layout?.classList.contains('page-layout--workbench')).toBe(true)
    expect(layout?.classList.contains('custom-layout')).toBe(true)
  })
})
