import { playwright } from '@vitest/browser-playwright'
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
      // The design system's tests run in a real browser (Vitest browser mode, Playwright only as the driver): Chrome at
      // HARNESS_BROWSER_PATH when it is set, as in the e2e tests, otherwise Playwright's own Chromium.
      {
        extends: true,
        // The dependency scan starts from the test files, so everything they import is prebundled before the first
        // test and Vite never reloads the page in the middle of a run.
        optimizeDeps: { entries: ['packages/ui/test/**/*.test.{ts,tsx}'] },
        test: {
          name: '@latch/ui',
          include: ['packages/ui/test/**/*.test.{ts,tsx}'],
          setupFiles: ['packages/ui/test/setup.ts'],
          css: true,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: process.env.HARNESS_BROWSER_PATH ? { executablePath: process.env.HARNESS_BROWSER_PATH } : {},
            }),
            instances: [{ browser: 'chromium', name: '@latch/ui' }],
            viewport: { width: 1280, height: 800 },
            screenshotFailures: false,
          },
        },
      },
    ],
  },
})
