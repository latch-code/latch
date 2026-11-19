import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hostBundleOptions, REPOSITORY_ROOT } from './host-bundle.ts'
import { buildNetworkHelper } from './build-network.ts'
import { buildNativeTlsHelper } from './build-native-tls.ts'
import { buildFilesHelper } from './build-files.ts'
import { buildHomeHelper } from './build-home.ts'
import { buildTerminalHelper } from './build-terminal.ts'
import { buildSimulatorHelper } from './build-simulator.ts'

// Entry points and dist/ are paths in the repository root whatever the working directory: package.json's exports and
// the start:built and desktop scripts find the bundles there.
await mkdir(join(REPOSITORY_ROOT, 'dist'), { recursive: true })
// Host entry points only. hostBundleOptions() fails the build if any of them reaches test code (@latch/testkit, with
// the test presence backend, tests/, or a project's test/ directory).
await build({
  ...(await hostBundleOptions()),
  absWorkingDir: REPOSITORY_ROOT,
  entryPoints: {
    start: 'apps/host/scripts/start.ts',
    stop: 'apps/host/scripts/stop.ts',
    latch: 'apps/host/scripts/latch.ts',
    'host/index': 'apps/host/src/server.ts',
    // The `import` targets of ./plugin-sdk and ./harness-sdk in package.json.
    'core/plugins': 'src/plugin-sdk.ts',
    'core/harness': 'src/harness-sdk.ts',
    // The Cursor SDK route's runner (packages/harness-acp/src/wires/cursor.ts finds it in dist/harness/). It loads
    // @cursor/sdk at run time from the root's node_modules, never bundled.
    'harness/cursor-runner': 'packages/harness-acp/src/cursor-runner.ts',
  },
  outdir: 'dist',
  sourcemap: true,
})
await buildNativeTlsHelper(REPOSITORY_ROOT)

await buildNetworkHelper(REPOSITORY_ROOT)
await buildFilesHelper(REPOSITORY_ROOT)
await buildHomeHelper(REPOSITORY_ROOT)
await buildTerminalHelper(REPOSITORY_ROOT)
await buildSimulatorHelper(REPOSITORY_ROOT)
