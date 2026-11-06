import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs: the webview is served from a vscode-webview:// origin.
  base: './',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  build: {
    // Built straight into the extension package; the host writes its own HTML.
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Stable names: the host references these files without a manifest.
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
})
