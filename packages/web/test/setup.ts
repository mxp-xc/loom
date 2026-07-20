import { afterEach, beforeEach } from 'vitest'

const originalConsoleError = console.error
const originalConsoleWarn = console.warn

let unexpectedConsoleCalls: Array<{ method: 'error' | 'warn'; args: unknown[] }> = []

beforeEach(() => {
  unexpectedConsoleCalls = []
  console.error = (...args: unknown[]) => {
    unexpectedConsoleCalls.push({ method: 'error', args })
    originalConsoleError(...args)
  }
  console.warn = (...args: unknown[]) => {
    unexpectedConsoleCalls.push({ method: 'warn', args })
    originalConsoleWarn(...args)
  }
})

afterEach(() => {
  console.error = originalConsoleError
  console.warn = originalConsoleWarn

  if (unexpectedConsoleCalls.length === 0) return
  const summary = unexpectedConsoleCalls
    .map(({ method, args }) => `console.${method}: ${args.map(String).join(' ')}`)
    .join('\n')
  throw new Error(`Unexpected console output:\n${summary}`)
})

function createMemoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear() {
      items.clear()
    },
    getItem(key: string) {
      return items.get(key) ?? null
    },
    key(index: number) {
      return Array.from(items.keys())[index] ?? null
    },
    removeItem(key: string) {
      items.delete(key)
    },
    setItem(key: string, value: string) {
      items.set(key, value)
    },
  }
}

function installTestStorage() {
  if (typeof window === 'undefined') return

  const storage = createMemoryStorage()

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  })
}

installTestStorage()
beforeEach(installTestStorage)

if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => ({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
}
