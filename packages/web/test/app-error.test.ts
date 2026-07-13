import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/api'
import { normalizeErrorFeedback } from '../src/lib/app-error'

const fallback = {
  title: '保存失败',
  message: '请检查输入后重试',
}

describe('normalizeErrorFeedback', () => {
  it('keeps stable user copy and exposes API metadata as technical detail', () => {
    const error = new ApiError('upstream rejected', 502, 'gateway_failed')

    expect(normalizeErrorFeedback(error, fallback)).toEqual({
      ...fallback,
      code: 'gateway_failed',
      detail: 'upstream rejected',
    })
  })

  it('maps known MCP session errors to actionable copy', () => {
    expect(
      normalizeErrorFeedback(new ApiError('expired', 410, 'session_expired'), fallback),
    ).toMatchObject({
      title: 'MCP session 已过期',
      message: '请重新连接后再试',
      code: 'session_expired',
    })
  })

  it('redacts secrets from technical detail', () => {
    const feedback = normalizeErrorFeedback(
      new Error('authorization: Bearer abc123 password=hunter2 token=secret-value'),
      fallback,
    )

    expect(feedback.detail).toContain('[已隐藏]')
    expect(feedback.detail).not.toContain('abc123')
    expect(feedback.detail).not.toContain('hunter2')
    expect(feedback.detail).not.toContain('secret-value')
  })

  it('does not expose unhelpful unknown values', () => {
    expect(normalizeErrorFeedback({ failed: true }, fallback)).toEqual(fallback)
  })
})
