import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

/**
 * The workbench is served by the Vite dev server against its in-memory
 * DemoTransport, so the suite needs no VS Code host and no database.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30 * 1000,
  expect: {
    timeout: 10 * 1000,
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    actionTimeout: 10 * 1000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
