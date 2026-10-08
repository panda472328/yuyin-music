import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: { ignored: ['**/out/**', '**/release/**', '**/.qa/**', '**/build/**'] },
    proxy: {
      '/lyrics-api': {
        target: 'https://lrclib.net', changeOrigin: true,
        rewrite: path => path.replace(/^\/lyrics-api/, ''),
        headers: { 'User-Agent': 'YuyinMusic/0.2.0' }
      },
      '/bili-api': {
        target: 'https://api.bilibili.com', changeOrigin: true,
        rewrite: path => path.replace(/^\/bili-api/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' }
      }
    }
  }
})
