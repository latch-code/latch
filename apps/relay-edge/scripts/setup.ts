import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { nodeCrypto } from '@latch/link-client/crypto'
import { EDGE_RELAY_AVAILABLE, isRelayLocation, RELAY_LOCATIONS } from '@latch/link-wire'
import { buildEdgeBundle } from './bundle.ts'
import { runSetup, SetupError, setupPaths } from './setup-core.ts'
import { wranglerRunner } from './wrangler.ts'

/**
 * `pnpm relay-edge:setup --name <name> [--location <hint>] [--out <absolute path>] [--check]`: the source checkout's
 * entry to the setup module, which `latch relay setup cloudflare` runs with `--check`. It builds the bundles here; the
 * module takes their paths, the wrangler on PATH (`--wrangler` names another) and the paths `setupPaths` picks under
 * ~/.latch/relays (the relay file `<name>.json` unless `--out`, the deploy directory). `--check` runs the acceptance
 * checks against the fresh node and exits with their result. `--region ne|se` is the earlier spelling of
 * `--name ne --location apac-ne` and `--name se --location apac-se`.
 */
const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    location: { type: 'string' },
    region: { type: 'string' },
    out: { type: 'string' },
    wrangler: { type: 'string' },
    check: { type: 'boolean' },
    'next-accept': { type: 'string' },
  },
  strict: true,
})
const fail = (message: string): void => {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
if (!EDGE_RELAY_AVAILABLE) {
  fail('这个版本关闭了 Cloudflare Workers 中继。')
  process.exit()
}
const legacy = values.region === 'ne' || values.region === 'se' ? values.region : undefined
if ((values.region !== undefined && !legacy) || (legacy && (values.name !== undefined || values.location !== undefined))) {
  fail('--region 只有 ne 与 se，且不与 --name、--location 同用；新的写法是 --name <名称> [--location <位置>]')
  process.exit()
}
const name = legacy ?? values.name
const location = legacy ? (`apac-${legacy}` as const) : values.location
if (!name) {
  fail('用 --name <名称> 给这个中继起名（小写字母、数字与连字符）')
  process.exit()
}
if (location !== undefined && !isRelayLocation(location)) {
  fail(`--location 是 ${RELAY_LOCATIONS.join('、')} 之一；不给时由 Cloudflare 放在离第一次请求最近的地方`)
  process.exit()
}
const paths = await setupPaths({
  name,
  ...(values.out === undefined ? {} : { out: values.out }),
  ...(values['next-accept'] === undefined ? {} : { accept: values['next-accept'] }),
}).catch((error: unknown) => {
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
      name,
      ...(location === undefined ? {} : { location }),
      out: paths.out,
      workerBundle: join(bundles, 'worker.js'),
      workBundle: join(bundles, 'work.js'),
      workDir: paths.workDir,
      next: values.check ? '验收这个中继' : paths.next,
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
  if (values.check) {
    // The acceptance entry as its own process, with this one's hardening flags: nothing is added to a Mac before it passes.
    const code = await new Promise<number>(done => {
      const child = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(new URL('./accept.ts', import.meta.url)), '--file', paths.out],
        { stdio: 'inherit' },
      )
      child.once('error', () => done(1))
      child.once('exit', status => done(status ?? 1))
    })
    if (code !== 0) fail('验收没有通过：不要添加这个中继。')
    else process.stdout.write('验收通过。在 Latch 的「设置 › 连接转发 › 添加转发服务」里添加它。\n')
  }
} catch (error) {
  fail(error instanceof SetupError ? error.message : '设置没有完成')
} finally {
  await rm(bundles, { recursive: true, force: true })
}
