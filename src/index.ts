import { startApiServer } from './api/server.js'

startApiServer().catch((err) => {
  console.error('Failed to start Loom API server:', err)
  process.exit(1)
})
