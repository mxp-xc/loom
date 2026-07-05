import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    // dev.mjs picks the port (LOOM_WEB_PORT): 5173 if free, else random. strictPort
    // so vite binds exactly that port — under Bun, vite's auto-increment path
    // buffers its "ready" banner and it never reaches the terminal.
    port: process.env.LOOM_WEB_PORT ? Number(process.env.LOOM_WEB_PORT) : 5173,
    strictPort: Boolean(process.env.LOOM_WEB_PORT),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.LOOM_PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
})
