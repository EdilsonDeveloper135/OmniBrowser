import { defineConfig } from 'vitest/config';

// `npm run bench`: machine-specific timings of hot derivations, compared before and after a change. Not part of verify.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
    testTimeout: 120_000
  }
});
