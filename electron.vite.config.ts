import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve(__dirname, 'electron/main.ts'), output: { entryFileNames: 'index.js' } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload.ts'), 'desktop-lyrics': resolve(__dirname, 'electron/desktop-lyrics-preload.ts') }, output: { entryFileNames: '[name].js' } } } },
  renderer: {
    root: '.',
    plugins: [react()],
    build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), 'desktop-lyrics': resolve(__dirname, 'desktop-lyrics.html') } } },
    server: { host: '127.0.0.1', watch: { ignored: ['**/out/**', '**/release/**', '**/.qa/**', '**/build/**'] } }
  }
})
