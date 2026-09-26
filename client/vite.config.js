import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const BACKEND_PORT = process.env.BACKEND_PORT || 3417

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5192,
    proxy: {
      '/api': `http://localhost:${BACKEND_PORT}`,
      '/uploads': `http://localhost:${BACKEND_PORT}`,
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5192,
  },
})
