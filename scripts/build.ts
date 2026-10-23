import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
// Host entry points only; tests and their helpers (including the test presence backend) are never bundled.
await build({
  entryPoints: {
    start: 'scripts/start.ts',
    stop: 'scripts/stop.ts',
    latch: 'scripts/latch.ts',
    'host/index': 'src/host/server.ts',
    'core/plugins': 'src/core/plugins.ts',
    'core/harness': 'src/core/harness.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The root tsconfig.json is a solution without compiler options, and esbuild does not follow its references.
  tsconfig: 'tsconfig.host.json',
  packages: 'external',
  outdir: 'dist',
  sourcemap: true,
})
