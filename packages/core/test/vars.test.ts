import { describe, it, expect } from 'vitest'
import { resolveVars } from '../src/vars'

const ctx = {
  env: { TOKEN: 'env-tok' },
  activeProfile: { TOKEN: 'active-tok', ONLY_ACTIVE: 'a' },
  defaultProfile: { ONLY_DEFAULT: 'd', browsers_path: '/p' },
}

describe('resolveVars', () => {
  it('env beats profile', () => {
    expect(resolveVars('${TOKEN}', ctx)).toBe('env-tok')
  })
  it('active profile beats default', () => {
    expect(resolveVars('${ONLY_ACTIVE}', ctx)).toBe('a')
  })
  it('falls back to default profile', () => {
    expect(resolveVars('${ONLY_DEFAULT}', ctx)).toBe('d')
  })
  it('default value syntax when unset', () => {
    expect(resolveVars('${MISSING:fallback}', ctx)).toBe('fallback')
  })
  it('literal passthrough', () => {
    expect(resolveVars('plain text', ctx)).toBe('plain text')
  })
  it('mixed literal + ref concatenates', () => {
    expect(resolveVars('Bearer ${TOKEN}', ctx)).toBe('Bearer env-tok')
  })
  it('throws on undefined var with no default', () => {
    expect(() => resolveVars('${NOPE}', ctx)).toThrow(/NOPE/)
  })
  it('undefined var in mixed value fails whole value', () => {
    expect(() => resolveVars('Bearer ${NOPE}', ctx)).toThrow(/NOPE/)
  })
  it('empty default ${VAR:} resolves to empty string', () => {
    expect(resolveVars('${MISSING:}', ctx)).toBe('')
  })
  it('env empty string still wins, no fallback to profile', () => {
    expect(resolveVars('${TOKEN}', { ...ctx, env: { TOKEN: '' } })).toBe('')
  })
})
