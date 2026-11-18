import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { nodeCrypto } from '@latch/link-client/crypto'
import { EDGE_RELAY_AVAILABLE } from '@latch/link-wire'
import { buildEdgeBundle } from './bundle.ts'
import { runSetup, SetupError, setupPaths } from './setup-core.ts'
import { wranglerRunner } from './wrangler.ts'

/**
 * `pnpm relay-edge:setup --region ne|se [--out <absolute path>]`: the source checkout's entry to the setup module. It
 * builds the bundles here; the module takes their paths, the wrangler on PATH (`--wrangler` names another) and the
 * paths `setupPaths` picks under ~/.latch/relays (the relay file `<region>.json` unless `--out`, the deploy directory).
 */
const { values } = parseArgs({
  options: { region: { type: 'string' }, out: { type: 'string' }, wrangler: { type: 'string' } },
  strict: true,
})
const fail = (message: string): void => {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
const region = values.region
if (!EDGE_RELAY_AVAILABLE) {
  fail('这个版本关闭了 Cloudflare Workers 中继。')
  process.exit()
}
if (region !== 'ne' && region !== 'se') {
  fail('--region 应为 ne（东京）或 se（新加坡）')
  process.exit()
}
const paths = await setupPaths({ region, ...(values.out === undefined ? {} : { out: values.out }) }).catch((error: unknown) => {
  fail(error instanceof SetupError ? error.message : '设置没有完成')
  process.exit()
})
for (const note of paths.notes) process.stdout.write(`${note}\n`)
const bundles = await mkdtemp(join(tmpdir(), 'latch-relay-bundle-'))
try {
  process.stdout.write('构建 Worker\n')
  await buildEdgeBundle(bundles)
  await runSetup(
    {
      region,
      out: paths.out,
      workerBundle: join(bundles, 'worker.js'),
      workBundle: join(bundles, 'work.js'),
      workDir: paths.workDir,
      next: paths.next,
    },
    {
      wrangler: wranglerRunner(values.wrangler ?? 'wrangler'),
      status: url =>
        fetch(url, { signal: AbortSignal.timeout(10_000) }).then(
          response => response.status,
          () => 0,
        ),
      publicKey: seed => nodeCrypto.publicKey(seed),
      progress: line => process.stdout.write(`${line}\n`),
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    },
  )
} catch (error) {
  fail(error instanceof SetupError ? error.message : '设置没有完成')
} finally {
  await rm(bundles, { recursive: true, force: true })
}
