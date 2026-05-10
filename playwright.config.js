// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * StockOS Playwright config.
 *
 * - Tests run against `E2E_BASE_URL` if set (e.g. https://stockos-mu.vercel.app),
 *   otherwise against a locally started server at http://localhost:3000.
 * - When testing locally, `webServer` boots `npm start` and reuses an existing
 *   server if one is already running (useful when `npm run dev` is open in another terminal).
 * - The local server requires DATABASE_URL in `.env`; tests that don't hit the DB
 *   (health, login screen render) still work as long as the process can start.
 */
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const isLocal = !process.env.E2E_BASE_URL;

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: isLocal
    ? {
        command: 'npm start',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
});
