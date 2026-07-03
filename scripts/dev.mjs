#!/usr/bin/env node
// Dev wrapper: allocates a free port for the API server when LOOM_PORT is
// unset, then launches the backend + frontend directly (no concurrently, no
// nested pnpm) with that port shared through the environment. Lets multiple
// worktree dev servers run in parallel without port collisions.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const __root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// Spawn a child whose stdout/stderr is line-buffered and tagged with a
// colored prefix, replacing the role concurrently used to play.
function tagged(name, color, cmd, args, opts) {
  const prefix = `\x1b[${color}m[${name}]\x1b[0m`
  const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], ...opts })
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        process.stdout.write(`${prefix} ${line}\n`)
      }
    })
    stream.on('end', () => { if (buf) process.stdout.write(`${prefix} ${buf}\n`) })
  }
  return child
}

async function main() {
  // Respect an explicitly provided LOOM_PORT; otherwise allocate one so
  // parallel worktree dev servers don't collide on the default 3000.
  const port = process.env.LOOM_PORT ?? String(await pickFreePort())
  process.env.LOOM_PORT = port
  console.log(`\x1b[35m[dev]\x1b[0m API server port: ${port}`)

  const env = { ...process.env }
  // Launch both processes directly with node — skips ~560ms of per-process
  // pnpm startup overhead (two nested `pnpm --filter` calls) plus the
  // concurrently indirection. Each runs in its own package directory so
  // node's module resolution finds the local tsx / vite binaries.
  const children = [
    tagged('api', '34', 'node', ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(__root, 'packages/server'),
      env,
    }),
    tagged('web', '32', 'node', [join('node_modules', 'vite', 'bin', 'vite.js')], {
      cwd: join(__root, 'packages/web'),
      env,
    }),
  ]

  let exiting = false
  const exitAll = (code) => {
    if (exiting) return
    exiting = true
    for (const c of children) c.kill('SIGTERM')
    process.exit(code ?? 0)
  }
  for (const c of children) {
    c.on('exit', (code, signal) => exitAll(code ?? signal ? 1 : 0))
  }
  process.on('SIGINT', () => exitAll(0))
  process.on('SIGTERM', () => exitAll(0))
}

main().catch((err) => {
  console.error('[dev] failed to start:', err)
  process.exit(1)
})
