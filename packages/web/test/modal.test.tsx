// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import Modal from '../src/components/Modal'

function Controlled({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          onClose?.()
        }}
        title="编辑环境"
      >
        <input
          data-autofocus
          aria-label="名称"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="button">末尾操作</button>
      </Modal>
    </>
  )
}

function BusyControlled({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onClose={onClose} title="处理中" busy={busy}>
      <input data-autofocus aria-label="内容" />
      <button type="button" onClick={() => setBusy((value) => !value)}>
        切换忙碌
      </button>
    </Modal>
  )
}

describe('Modal', () => {
  it('focuses the preferred input and traps Tab from every boundary', async () => {
    render(<Controlled />)
    const opener = screen.getByRole('button', { name: '打开' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '编辑环境' })
    const input = screen.getByRole('textbox', { name: '名称' })
    const close = screen.getByRole('button', { name: '关闭' })
    const last = screen.getByRole('button', { name: '末尾操作' })
    await waitFor(() => expect(document.activeElement).toBe(input))

    dialog.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    dialog.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    close.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('preserves Radix background hiding while open', async () => {
    const { container } = render(<Controlled />)
    const opener = screen.getByRole('button', { name: '打开' })

    fireEvent.click(opener)

    const input = screen.getByRole('textbox', { name: '名称' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))

    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.getAttribute('data-aria-hidden')).toBe('true')
  })

  it('keeps focus on the dialog when it has no focusable descendants', async () => {
    render(
      <Modal open onClose={() => undefined} title="提示">
        <p>没有操作</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: '提示' })
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' })),
    )
    screen.getByRole('button', { name: '关闭' }).setAttribute('disabled', '')
    dialog.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(dialog)
  })

  it.each(['click', 'escape'] as const)('restores the opener after %s close', async (method) => {
    const close = vi.fn()
    render(<Controlled onClose={close} />)
    const opener = screen.getByRole('button', { name: '打开' })
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')))
    if (method === 'click') fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    else fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(opener)
  })

  it('does not steal focus on a controlled rerender', async () => {
    render(<Controlled />)
    const opener = screen.getByRole('button', { name: '打开' })
    opener.focus()
    fireEvent.click(opener)
    const input = screen.getByRole('textbox', { name: '名称' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'staging' } })
    expect(document.activeElement).toBe(input)
  })

  it('keeps focus inside the dialog when busy toggles', async () => {
    render(<BusyControlled onClose={() => undefined} />)
    const input = screen.getByRole('textbox', { name: '内容' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.click(screen.getByRole('button', { name: '切换忙碌' }))
    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByRole('dialog', { name: '处理中' }).contains(document.activeElement)).toBe(
      true,
    )
  })

  it('does not close from the backdrop while busy', () => {
    const onClose = vi.fn()
    render(<BusyControlled onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: '处理中' })
    fireEvent.click(screen.getByRole('button', { name: '切换忙碌' }))
    fireEvent.click(dialog.parentElement!)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('blocks Escape and disables the close button while busy', () => {
    const onClose = vi.fn()
    render(<BusyControlled onClose={onClose} />)

    const dialog = screen.getByRole('dialog', { name: '处理中' })
    const close = screen.getByRole('button', { name: '关闭' })

    fireEvent.click(screen.getByRole('button', { name: '切换忙碌' }))

    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect((close as HTMLButtonElement).disabled).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '处理中' })).toBeDefined()
  })

  it('closes from the backdrop when not busy and restores opener focus', async () => {
    const close = vi.fn()
    render(<Controlled onClose={close} />)

    const opener = screen.getByRole('button', { name: '打开' })
    opener.focus()
    fireEvent.click(opener)

    const input = screen.getByRole('textbox', { name: '名称' })
    await waitFor(() => expect(document.activeElement).toBe(input))

    const dialog = screen.getByRole('dialog', { name: '编辑环境' })
    fireEvent.click(dialog.parentElement!)

    expect(close).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(opener)
  })
})
