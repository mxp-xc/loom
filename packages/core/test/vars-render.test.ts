import { describe, it, expect } from 'vitest'
import { renderText, type VarsContext } from '../src/vars.js'

const ctx: VarsContext = {
  env: { LOOM_AGENT: 'codex', LOOM_CONFIG_DIR: '/home/u/.codex' },
  activeProfile: { PROFILE_VAR: 'active' },
  defaultProfile: { DEFAULT_VAR: 'def' },
}

describe('renderText', () => {
  it('resolves ${VAR} from env first', () => {
    expect(renderText('${LOOM_AGENT}', ctx)).toBe('codex')
  })

  it('resolves ${VAR:fallback} when undefined', () => {
    expect(renderText('${MISSING:fallback}', ctx)).toBe('fallback')
  })

  it('embeds in surrounding text', () => {
    expect(renderText('@${LOOM_CONFIG_DIR}/RTK.md', ctx)).toBe('@/home/u/.codex/RTK.md')
  })

  it('uses even backslashes for active tokens and odd backslashes for literals', () => {
    for (const count of [0, 1, 2, 3, 4]) {
      const input = '\\'.repeat(count) + '${LOOM_AGENT}'
      const expected =
        '\\'.repeat(Math.floor(count / 2)) + (count % 2 === 0 ? 'codex' : '${LOOM_AGENT}')
      expect(renderText(input, ctx)).toBe(expected)
    }
  })

  it('mixed escape and resolve', () => {
    expect(renderText('\\${literal} and ${LOOM_AGENT}', ctx)).toBe('${literal} and codex')
  })

  it('multiline markdown resolves throughout', () => {
    const md = '# Title\n@${LOOM_CONFIG_DIR}/x\nuse \\${HOME}\n'
    expect(renderText(md, ctx)).toBe('# Title\n@/home/u/.codex/x\nuse ${HOME}\n')
  })

  it('throws on undefined var without fallback', () => {
    expect(() => renderText('${NOPE}', ctx)).toThrow(/NOPE/)
  })

  it('does not modify unrelated DOLLAR_BRACE text', () => {
    expect(renderText('Before DOLLAR_BRACE After', ctx)).toBe('Before DOLLAR_BRACE After')
  })
})
