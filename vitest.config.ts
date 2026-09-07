import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Every database-backed test file builds its own PGlite instance, which is
    // CPU bound and holds a WebAssembly heap. Running the files one at a time,
    // each in its own process, keeps peak memory to a single instance and is no
    // slower than sharing a process (measured both ways).
    fileParallelism: false,
    testTimeout: 120_000,
    // Building the lab and running every scenario happens once, in beforeAll.
    hookTimeout: 600_000,
  },
});
