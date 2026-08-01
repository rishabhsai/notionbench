import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Spawn tests shell out to fake CLIs; give them room without being flaky-slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
