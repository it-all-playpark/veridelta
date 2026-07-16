import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'conformance',
          include: ['tests/conformance/**/*.test.ts'],
          globalSetup: ['./tests/conformance/global-setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 120_000,
          // Each fixture spawns real vitest child processes; keep the suite
          // in one worker so child concurrency stays bounded.
          fileParallelism: false,
        },
      },
    ],
  },
})
