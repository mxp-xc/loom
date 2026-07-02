#!/usr/bin/env node
// Dev wrapper: allocates a free port for the API server when LOOM_PORT is
// unset, then launches the backend + frontend via concurrently with that
// port shared through the environment. Lets multiple worktree dev servers
// run in parallel without port collisions.
import { spawn } from 'node:child_process'
import net from 'node:net'

/** Resolve a free TCP port; returns 0 to let the OS pick. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function main() {
  // Respect an explicitly provided LOOM_PORT; otherwise allocate one so
  // parallel worktree dev servers don't collide on the default 3000.
  const port = process.env.LOOM_PORT ?? String(await pickFreePort())
  process.env.LOOM_PORT = port
  console.log(`\x1b[35m[dev]\x1b[0m API server port: ${port}`)

  // Pass a single command string (not an args array) to shell:true so the
  // quoted sub-commands survive intact — mirroring how npm ran the original
  // script and avoiding Node's DEP0190 arg-escaping pitfall on Windows.
  const cmd =
    'concurrently -n api,web -c blue,green "pnpm --filter @loom/server dev" "pnpm --filter @loom/web dev"'

  const child = spawn(cmd, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  })

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

main().catch((err) => {
  console.error('[dev] failed to start:', err)
  process.exit(1)
})
