import { realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildOptions, Plugin } from 'esbuild'
import { z } from 'zod'

const Dependencies = z.record(z.string(), z.string()).optional()
const Manifest = z.object({
  dependencies: Dependencies,
  devDependencies: Dependencies,
  optionalDependencies: Dependencies,
  peerDependencies: Dependencies,
})

/** The repository root: the bundles go to its dist/ and load the packages they leave external from its node_modules. */
export const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
// esbuild runs plugin filters as Go regular expressions, which take no flags.
const TEST_KIT = /^@latch\/testkit(?:\/|$)/
/**
 * Test code by path from the repository root: the root's tests/, the end-to-end tests, the test kit, and each workspace
 * project's test/.
 */
const TEST_CODE = /^(?:tests\/|e2e\/|packages\/testkit\/|(?:apps|packages)\/[^/]+\/test\/)/u

/**
 * Fails the build when a Host entry reaches test code: @latch/testkit by name, or any file under packages/testkit/,
 * tests/, e2e/ or a workspace project's test/ however it is imported. esbuild reports paths after resolving symlinks, so
 * the workspace link counts too.
 */
const testCodeGuard: Plugin = {
  name: 'latch-test-code-guard',
  setup(build) {
    build.onResolve({ filter: TEST_KIT }, args => ({
      errors: [{ text: `${relative(REPOSITORY_ROOT, args.importer) || args.importer} 导入了 ${args.path}：@latch/testkit 只供测试使用` }],
    }))
    build.onLoad({ filter: /.*/ }, args => {
      const path = relative(REPOSITORY_ROOT, args.path).split(sep).join('/')
      if (!TEST_CODE.test(path)) return undefined
      return { errors: [{ text: `${path} 是测试代码，不能进入 Host 构建` }] }
    })
  },
}

/** esbuild options for every bundle of a Host entry point: `pnpm build:host` and tests that bundle an entry the same way. */
export async function hostBundleOptions(): Promise<BuildOptions> {
  const manifest = Manifest.parse(JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8')))
  // Installed dependencies stay imports that Node resolves at run time from the repository root's node_modules, next to
  // dist/, so the list comes from the root manifest, which declares every package the bundled code loads; a package name
  // also covers its subpaths. Workspace packages (`workspace:` versions) export TypeScript sources, so they are bundled
  // like the Host's own modules.
  const external = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
    .flatMap(field => Object.entries(field ?? {}))
    .filter(([, version]) => !version.startsWith('workspace:'))
    .map(([name]) => name)
  const digest = createHash('sha256')
  async function source(path: string): Promise<void> {
    const entries = await readdir(join(REPOSITORY_ROOT, path), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) await source(child)
      else if (entry.isSymbolicLink()) throw new Error('Execution source links must be resolved before building')
      else if (entry.isFile()) {
        const bytes = await readFile(join(REPOSITORY_ROOT, child))
        digest.update(JSON.stringify([child, bytes.length]))
        digest.update(bytes)
      }
    }
  }
  for (const path of [
    'apps/host/src',
    'packages/core/src',
    'packages/sdk/src',
    'packages/protocol/src',
    'packages/harness-acp/src',
    'packages/link-client/src',
    'packages/link-wire/src',
  ])
    await source(path)
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/host/scripts/host-bundle.ts', 'tsconfig.host.json']) {
    digest.update(path)
    digest.update(await readFile(join(REPOSITORY_ROOT, path)))
  }
  digest.update(process.version)
  return {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // The root tsconfig.json is a solution without compiler options, and esbuild does not follow its references.
    tsconfig: join(REPOSITORY_ROOT, 'tsconfig.host.json'),
    external,
    define: { __LATCH_EXECUTION_BUILD__: JSON.stringify(digest.digest('hex')) },
    plugins: [testCodeGuard],
  }
}
