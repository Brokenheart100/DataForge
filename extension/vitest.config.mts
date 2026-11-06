import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Unit tests run in plain Node. `vscode` does not exist outside the extension
 * host, so it is aliased to the in-repo fake; everything the extension imports
 * from it is part of that fake's surface.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      vscode: fileURLToPath(new URL('./src/test/vscode-mock.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
