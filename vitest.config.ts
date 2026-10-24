import { defineConfig } from 'vitest/config'

// One project per workspace project that has unit tests; `pnpm test --project <name>` runs one. Each inline project
// takes the shared options (`extends: true`), and they share one Vite server. Tests run with the repository root as the
// working directory, so paths such as dist/web and node_modules/.bin resolve from it in every project.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    projects: [
      { extends: true, test: { name: 'harness-link', include: ['tests/**/*.test.ts'] } },
      { extends: true, test: { name: '@latch/host', include: ['apps/host/test/**/*.test.ts'] } },
      { extends: true, test: { name: '@latch/web', include: ['apps/web/test/**/*.test.ts'] } },
      { extends: true, test: { name: '@latch/desktop', include: ['apps/desktop/test/**/*.test.ts'] } },
      { extends: true, test: { name: '@latch/harness-acp', include: ['packages/harness-acp/test/**/*.test.ts'] } },
    ],
  },
})
