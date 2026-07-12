// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import VarsProfileDemo from '../src/views/vars/VarsProfileDemo'

describe('Vars profile demo modal', () => {
  it('closes from the backdrop', async () => {
    render(<VarsProfileDemo />)

    fireEvent.click(screen.getByRole('button', { name: '新建配置' }))
    const dialog = screen.getByRole('dialog', { name: '新建配置' })
    const backdrop = dialog.parentElement!

    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建配置' })).toBeNull())
  })
})
