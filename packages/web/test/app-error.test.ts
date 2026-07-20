// @vitest-environment node

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

  it.each([
    [
      'plain text',
      'authorization: Bearer plain-auth password=plain-pass',
      ['plain-auth', 'plain-pass'],
      'authorization: [已隐藏] password=[已隐藏]',
    ],
    [
      'JSON',
      '{"token":"json-token","nested":{"api_key":"json-key"},"safe":"ok"}',
      ['json-token', 'json-key'],
      'ok',
    ],
    ['quoted header', 'Authorization: "Bearer quoted-auth" safe=ok', ['quoted-auth'], 'ok'],
    ['query string', 'request failed?token=query-token&safe=ok', ['query-token'], 'ok'],
  ])(
    'redacts secrets from %s while preserving safe context',
    (_label, message, sentinels, safeContext) => {
      const feedback = normalizeErrorFeedback(new Error(message), fallback)

      expect(feedback.detail).toContain('[已隐藏]')
      expect(feedback.detail).toContain(safeContext)
      for (const sentinel of sentinels) expect(feedback.detail).not.toContain(sentinel)
    },
  )

  it('does not expose unhelpful unknown values', () => {
    expect(normalizeErrorFeedback({ failed: true }, fallback)).toEqual(fallback)
  })
})
