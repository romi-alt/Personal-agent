import { defineConfig } from '@playwright/test';

/**
 * Browser tests of the owner command center. Uses the Microsoft Edge already installed on the machine
 * (`channel: 'msedge'`), so no Playwright browser download is needed. Run: `npm run test:browser`.
 */
export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    channel: process.env['PW_CHANNEL'] ?? 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results',
});
