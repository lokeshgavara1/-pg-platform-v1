import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // DB-backed test files share one test database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
