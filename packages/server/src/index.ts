import { startApiServer } from './api/server.js'
import { logger, cleanupOldLogs } from './lib/logger.js'

// Clean up old log files on startup (retain last 7 days)
cleanupOldLogs(process.env.LOOM_LOG_DIR ?? 'logs', 7).catch(() => {
  /* best-effort */
})

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err })
  logger.flush().then(() => process.exit(1))
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  logger.error('unhandled rejection', { err })
  logger.flush().then(() => process.exit(1))
})

startApiServer().catch((err) => {
  logger.error('failed to start Loom API server', { err })
  logger.flush().then(() => process.exit(1))
})
