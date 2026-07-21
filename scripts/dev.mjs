#!/usr/bin/env bun
// Dev wrapper: allocates a free port for the API server when LOOM_PORT is
// unset, then launches the backend + frontend directly with bun. Lets
// multiple worktree dev servers run in parallel without port collisions.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const __root = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')

/** Resolve a free TCP port; returns 0 to let the OS pick. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Probe one stack: EADDRINUSE → occupied; other errors → stack unavailable (treat as free). */
function probeBind(host, port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', (err) => resolve(err.code === 'EADDRINUSE' ? false : true))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}

/** True if the port is free on the same host the server binds (127.0.0.1). */
function isPortFree(port) {
  return probeBind('127.0.0.1', port)
}

/** Prefer an explicit env override, then the default port if free, else a random one. */
async function resolvePort(envVar, defaultPort) {
  if (process.env[envVar]) return process.env[envVar]
  if (await isPortFree(defaultPort)) return String(defaultPort)
  return String(await pickFreePort())
}

// Tag each child's output with a colored prefix, like concurrently does.
function tagged(name, color, cmd, cwd) {
  const prefix = `\x1b[${color}m[${name}]\x1b[0m`
  const child = Bun.spawn(cmd, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'inherit',
  })
  for (const stream of [child.stdout, child.stderr]) {
    const reader = stream.getReader()
    ;(async () => {
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          if (buf) process.stdout.write(`${prefix} ${buf}\n`)
          break
        }
        buf += new TextDecoder().decode(value)
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          process.stdout.write(`${prefix} ${buf.slice(0, idx)}\n`)
          buf = buf.slice(idx + 1)
        }
      }
    })()
  }
  return child
}

async function main() {
  const port = await resolvePort('LOOM_PORT', 3000)
  process.env.LOOM_PORT = port
  const webPort = await resolvePort('LOOM_WEB_PORT', 5173)
  process.env.LOOM_WEB_PORT = webPort
  console.log(`\x1b[35m[dev]\x1b[0m API server port: ${port}`)
  console.log(`\x1b[35m[dev]\x1b[0m Web server port: ${webPort}  →  http://127.0.0.1:${webPort}`)

  // Bun runs TypeScript natively — no tsx, no node, no pnpm in the chain.
  const children = [
    tagged('api', '34', ['bun', 'dev:api'], __root),
    tagged('web', '32', [
      'bun',
      '--cwd',
      `${__root}/packages/web`,
      'node_modules/vite/bin/vite.js',
    ]),
  ]

  let exiting = false
  const exitAll = (code) => {
    if (exiting) return
    exiting = true
    for (const c of children) c.kill('SIGTERM')
    process.exit(code ?? 0)
  }
  for (const c of children) {
    c.exited.then((code) => exitAll(code ?? 0))
  }
  process.on('SIGINT', () => exitAll(0))
  process.on('SIGTERM', () => exitAll(0))
}

main().catch((err) => {
  console.error('[dev] failed to start:', err)
  process.exit(1)
})
