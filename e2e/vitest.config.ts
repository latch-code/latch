import { defineConfig } from 'vitest/config'

// `pnpm test:e2e` runs this config from the repository root, as `pnpm test` runs the unit config: Vitest takes the
// working directory as its root, so the include pattern and the tests' own paths (dist/web, apps/desktop/src/main.cjs,
// test-results/) resolve from the repository root.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
