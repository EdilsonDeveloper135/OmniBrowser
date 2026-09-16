import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/perf',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']]
});
