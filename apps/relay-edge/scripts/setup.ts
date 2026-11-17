import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { nodeCrypto } from '@latch/link-client/crypto'
import { buildEdgeBundle } from './bundle.ts'
import { runSetup, SetupError } from './setup-core.ts'

/**
 * `pnpm relay-edge:setup --region ne|se --out <absolute path>`: the source checkout's entry to the setup module. It builds
 * the bundles here; the module takes their paths, the wrangler on PATH (`--wrangler` names another) and a work
 * directory outside the repository (~/.latch-relay).
 */
const { values } = parseArgs({
  options: { region: { type: 'string' }, out: { type: 'string' }, wrangler: { type: 'string' } },
  strict: true,
})
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
if (values.region !== 'ne' && values.region !== 'se') fail('--region 应为 ne（东京）或 se（新加坡）')
const program = values.wrangler ?? 'wrangler'
const bundles = await mkdtemp(join(tmpdir(), 'latch-relay-bundle-'))
try {
  process.stdout.write('构建 Worker\n')
  await buildEdgeBundle(bundles)
  await runSetup(
    {
      region: values.region as 'ne' | 'se',
      out: values.out ?? '',
      workerBundle: join(bundles, 'worker.js'),
      workBundle: join(bundles, 'work.js'),
      workDir: join(homedir(), '.latch-relay'),
    },
    {
      wrangler: (args, options) =>
        new Promise(resolve => {
          const child = spawn(program, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'inherit'] })
          let stdout = ''
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
          })
          child.once('error', () => resolve({ code: -1, stdout: '' }))
          child.once('close', code => resolve({ code: code ?? -1, stdout }))
          child.stdin.end(options.input ?? '')
        }),
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
