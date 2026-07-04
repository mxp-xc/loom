// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from '../src/components/ui/button'
import '../src/index.css'

describe('Button', () => {
  it('keeps compact buttons padded after the global reset', () => {
    render(<Button size="sm">保存</Button>)

    const styles = getComputedStyle(screen.getByRole('button', { name: '保存' }))
    expect(styles.paddingInline).toBe('12px')
    expect(styles.height).toBe('32px')
  })
})
