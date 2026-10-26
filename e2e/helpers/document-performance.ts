import { resolve } from 'node:path'
import { build } from 'vite'
/** A production bundle of the isolated test host; Vite's development transforms are outside the measured interval. */
export async function buildDocumentPerformanceHarness(): Promise<string> {
  const directory = resolve('test-results/document-performance/harness')
  await build({
    configFile: false,
    root: resolve('apps/web'),
    base: '/link/',
    build: {
      copyPublicDir: false,
      outDir: directory,
      emptyOutDir: true,
      rollupOptions: { input: resolve('apps/web/test/document-performance.html') },
    },
  })
  return directory
}
