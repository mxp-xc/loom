import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { registerRoutes } from './router.js'
import { logger } from '../lib/logger.js'

const requestLogger = logger.child('api')

export function createApp(): Hono {
  const app = new Hono()
  // Custom request logging — replaces hono/logger so requests go to the file too
  app.use('*', async (c, next) => {
    const start = Date.now()
    await next()
    const duration = Date.now() - start
    requestLogger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration: `${duration}ms`,
    })
  })

  app.route('/api', registerRoutes())
  const dist =
    process.env.LOOM_WEB_DIST ?? fileURLToPath(new URL('../../../web/dist/', import.meta.url))
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
    serve({ fetch: createApp().fetch, port }, (info) =>
      logger.info('server started', { port: info.port }),
    ),
  )
}
