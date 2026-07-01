import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { registerRoutes } from './routes.js'

export function createApp(): Hono {
  const app = new Hono()
  app.use('*', logger())
  app.route('/api', registerRoutes())
  const dist = process.env.LOOM_WEBUI_DIST ?? fileURLToPath(new URL('../../webui/dist/', import.meta.url))
  app.use('/assets/*', serveStatic({ root: dist }))
  app.get('/favicon.ico', (c) => c.body(null, 204))
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404)
    return c.html(await readFile(join(dist, 'index.html'), 'utf8'))
  })
  return app
}

export function startApiServer(port = Number(process.env.LOOM_PORT ?? 3000)) {
  return import('@hono/node-server').then(({ serve }) =>
    serve({ fetch: createApp().fetch, port }, (info) => console.log(`Loom API on http://localhost:${info.port}`)),
  )
}
