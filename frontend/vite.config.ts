import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8810',
      '/health': 'http://127.0.0.1:8810',
    },
  },
})
