import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // sieve-transport is raw socket I/O (STARTTLS handshake) — exercised
      // against a live server, not unit-testable without a socket fixture.
      exclude: ['src/index.ts', 'src/**/*.module.ts', 'src/core/types.ts', 'src/mail/sieve-transport.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});
