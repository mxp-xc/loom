import { SyncSessionManager } from '../../src/sync/session-manager.js'

const [operation, home, sessionId] = process.argv.slice(2)
if ((operation !== 'save' && operation !== 'abort') || !home || !sessionId) {
  throw new Error('Expected operation, home, and session id')
}

process.stdout.write('ready\n')
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()))

const manager = new SyncSessionManager({ home })
try {
  if (operation === 'save') {
    await manager.saveConflict(sessionId, 'skills.yaml', 'value: child-save\n')
  } else {
    await manager.abort(sessionId)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, operation })}\n`)
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      operation,
      code: err instanceof Error && 'code' in err ? err.code : undefined,
      message: err instanceof Error ? err.message : String(err),
    })}\n`,
  )
}
