import { defineConfig } from 'vitest/config';

// Process creation (git, node/tsx children) costs ~10x more on Windows with real-time antivirus scanning,
// so the same suites need more headroom there. Timeouts are ceilings, not expected durations.
const slowHost = process.platform === 'win32';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: slowHost ? 120_000 : 30_000,
    hookTimeout: slowHost ? 120_000 : 30_000,
    pool: 'forks',
  },
});
