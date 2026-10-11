import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Build the two existing renderers without compiling or packaging Electron.
// Keep the output separate so either native host can be tested independently.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'out/webview2-renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'desktop-lyrics': resolve(__dirname, 'desktop-lyrics.html'),
      },
    },
  },
})
