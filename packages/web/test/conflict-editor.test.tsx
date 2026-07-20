// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConflictEditor from '../src/views/sync/ConflictEditor'
import type { GitConflictFile } from '../src/lib/api'
import { createMonacoEditorMock } from './monaco-test-utils'

const monacoEditorMock = createMonacoEditorMock()

vi.mock('@monaco-editor/react', async () => {
  const { createMonacoEditorMock } = await import('./monaco-test-utils')
  return createMonacoEditorMock().module()
})

beforeEach(() => {
  monacoEditorMock.reset()
  vi.clearAllMocks()
})

function renderUnsupported(conflict: GitConflictFile) {
  const onSave = vi.fn()
  const onAbort = vi.fn()
  render(
    <ConflictEditor
      conflict={conflict}
      index={0}
      total={1}
      saving={false}
      onSave={onSave}
      onAbort={onAbort}
    />,
  )
  return { onSave, onAbort }
}

describe('ConflictEditor unsupported conflicts', () => {
  it.each([
    ['non-regular-mode', '该冲突涉及符号链接或其他非普通文件，不能在线解决。'],
    ['binary-content', '该冲突包含二进制内容，不能在线解决。'],
    ['invalid-utf8', '该冲突不是有效的 UTF-8 文本，不能在线解决。'],
    ['too-large', '该冲突文件超过在线处理大小限制。'],
  ] as const)('does not offer raw save for %s', (unsupportedReason, message) => {
    const { onSave, onAbort } = renderUnsupported({
      path: 'conflict.bin',
      base: null,
      ours: null,
      theirs: null,
      result: null,
      binary: true,
      unsupportedReason,
    })

    expect(screen.getByText(message)).toBeDefined()
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '放弃合并' }))
    expect(onAbort).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('ConflictEditor text conflicts', () => {
  const conflict: GitConflictFile = {
    path: 'config.yaml',
    base: 'profile: local\nagents:\n  - claude-code\nprojection:\n  strategy: link\n',
    ours: 'profile: local\nagents:\n  - claude-code\n  - codex\n  - opencode\nprojection:\n  strategy: link\n',
    theirs:
      'profile: local\nagents: []\nprojection:\n  strategy: link\nproxy:\n  http: http://127.0.0.1:7890\n',
    result: 'unused Git marker result',
    binary: false,
  }

  it('surfaces Monaco decoration failures while keeping the conflict open', async () => {
    const err = new Error('decorations failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    monacoEditorMock.deltaDecorations.mockImplementation(() => {
      throw err
    })

    render(
      <ConflictEditor
        conflict={conflict}
        index={0}
        total={1}
        saving={false}
        onSave={vi.fn()}
        onAbort={vi.fn()}
      />,
    )

    expect((await screen.findByRole('alert')).textContent).toContain('冲突高亮加载失败')
    expect(screen.getByText('config.yaml')).toBeDefined()
    expect(consoleError).toHaveBeenCalledWith(
      { err },
      'Failed to update Monaco conflict decorations',
    )
    consoleError.mockRestore()
  })

  it('applies, resets, and ignores side changes before saving the result', async () => {
    const onSave = vi.fn()
    render(
      <ConflictEditor
        conflict={conflict}
        index={0}
        total={1}
        saving={false}
        onSave={onSave}
        onAbort={vi.fn()}
      />,
    )

    const result = screen.getByRole('textbox', { name: 'Sync RESULT' }) as HTMLTextAreaElement
    expect(screen.getByRole('textbox', { name: 'Sync LOCAL' })).toHaveProperty(
      'value',
      expect.stringContaining('opencode'),
    )
    expect(result.value).toContain('proxy:')
    expect(screen.getByText('1 个待处理冲突')).toBeDefined()

    fireEvent.change(result, {
      target: { value: `# manually edited\n${result.value.replace('profile: local\n', '')}` },
    })
    fireEvent.click(screen.getByRole('button', { name: '本地变更 1：应用到结果' }))
    expect(result.value).toContain('opencode')

    fireEvent.click(screen.getByRole('button', { name: '本地变更 1：撤回应用' }))
    expect(result.value).not.toContain('opencode')

    fireEvent.click(screen.getByRole('button', { name: '本地变更 1：应用到结果' }))
    fireEvent.click(screen.getByRole('button', { name: '远程变更 1：忽略变更' }))
    expect(screen.getByText('0 个待处理冲突')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '保存并完成合并' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        'config.yaml',
        expect.stringMatching(/agents:[\s\S]*opencode[\s\S]*proxy:/),
      ),
    )
  })
})
