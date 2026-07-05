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

  it('escaped \\${} stays literal', () => {
    expect(renderText('use \\${HOME} for dir', ctx)).toBe('use ${HOME} for dir')
  })

  it('escaped \\${} is NOT resolved', () => {
    expect(renderText('\\${LOOM_AGENT}', ctx)).toBe('${LOOM_AGENT}')
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

  it('literal text containing visible DOLLAR_BRACE is not corrupted (ESC uses NUL bytes)', () => {
    expect(renderText('Before DOLLAR_BRACE After', ctx)).toBe('Before DOLLAR_BRACE After')
  })
})
