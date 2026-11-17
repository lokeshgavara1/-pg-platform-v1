import { defineConfig } from 'vitest/config';

// Pure unit tests: no database needed.
export default defineConfig({
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'], setupFiles: ['tests/setup-env.ts'] },
});
