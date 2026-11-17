import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { nodeCrypto } from '@latch/link-client/crypto'
import { EDGE_RELAY_AVAILABLE } from '@latch/link-wire'
import { buildEdgeBundle } from './bundle.ts'
import { runSetup, SetupError } from './setup-core.ts'
import { wranglerRunner } from './wrangler.ts'

/**
 * `pnpm relay-edge:setup --region ne|se --out <absolute path>`: the source checkout's entry to the setup module. It builds
 * the bundles here; the module takes their paths, the wrangler on PATH (`--wrangler` names another) and a work
 * directory outside the repository (~/.latch-relay).
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
  fail('Cloudflare Workers 中继尚未实现：平台暂无法提供消息组装前大小与连接释放约束。')
  process.exit()
}
if (region !== 'ne' && region !== 'se') {
  fail('--region 应为 ne（东京）或 se（新加坡）')
  process.exit()
}
const bundles = await mkdtemp(join(tmpdir(), 'latch-relay-bundle-'))
try {
  process.stdout.write('构建 Worker\n')
  await buildEdgeBundle(bundles)
  await runSetup(
    {
      region,
      out: values.out ?? '',
      workerBundle: join(bundles, 'worker.js'),
      workBundle: join(bundles, 'work.js'),
      workDir: join(homedir(), '.latch-relay'),
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
