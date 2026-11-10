import { defineConfig } from 'vitest/config';

/** The expensive synthetic benchmark is intentionally excluded from default CI. */
export default defineConfig({
  test: {
    include: ['tests/benchmarks/pbr-memory.test.ts'],
    testTimeout: 600_000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
