import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { z } from 'zod'
import { relayGoEnvironment } from './go-environment.ts'
const execute = promisify(execFile),
  root = fileURLToPath(new URL('../../..', import.meta.url))
const { values } = parseArgs({ strict: true, options: { stage: { type: 'string' }, arch: { type: 'string' } } })
if (!values.stage || !isAbsolute(values.stage) || !['amd64', 'arm64'].includes(values.arch ?? ''))
  throw new Error('Use a new absolute --stage and --arch amd64|arm64')
const stage = resolve(values.stage),
  arch = values.arch as 'amd64' | 'arm64'
const lock = z
  .object({
    version: z.literal(1),
    node: z
      .object({
        version: z.literal('24.22.1'),
        source: z.string(),
        amd64: z.string().regex(/^[a-f0-9]{64}$/u),
        arm64: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    runtimeImage: z
      .object({
        reference: z.string().regex(/^gcr\.io\/distroless\/cc-debian13@sha256:[a-f0-9]{64}$/u),
        uploadedAt: z.string().datetime(),
        source: z.string(),
      })
      .strict(),
  })
  .strict()
  .parse(JSON.parse(await readFile(join(root, 'apps/relay/deploy/runtime.lock.json'), 'utf8')) as unknown)
if (Date.now() - Date.parse(lock.runtimeImage.uploadedAt) < 7 * 86400000) throw new Error('Runtime image must mature seven days')
await mkdir(stage, { mode: 0o700 })
const sdk = process.env.LATCH_RELAY_GO ?? 'go',
  environment = relayGoEnvironment()
await execute(process.execPath, ['--import', import.meta.resolve('tsx'), join(root, 'apps/relay/scripts/build.ts')], {
  env: { ...environment, LATCH_RELAY_GO: sdk },
  timeout: 120000,
  maxBuffer: 32768,
})
await copyFile(join(root, 'dist/relay/latch-relay.mjs'), join(stage, 'latch-relay.mjs'))
await execute(
  sdk,
  [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-ldflags=-s -w -buildid=',
    '-o',
    join(stage, 'latch-relay-tls'),
    join(root, 'apps/relay/gateway/main.go'),
    join(root, 'apps/relay/gateway/supervisor.go'),
  ],
  { env: relayGoEnvironment(arch), timeout: 120000 },
)
await copyFile(join(root, 'apps/relay/gateway/GO-LICENSE'), join(stage, 'latch-relay-tls.LICENSE'))
const platform = arch === 'amd64' ? 'x64' : 'arm64',
  filename = `node-v${lock.node.version}-linux-${platform}`,
  archive = join(stage, 'node.tar.xz')
const response = await fetch(`https://nodejs.org/dist/v${lock.node.version}/${filename}.tar.xz`, { signal: AbortSignal.timeout(120000) })
if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > 128 * 1024 * 1024)
  throw new Error('Official Node archive unavailable')
const file = await open(archive, 'wx', 0o600),
  hash = createHash('sha256')
let count = 0
try {
  for await (const chunk of response.body) {
    count += chunk.length
    if (count > 128 * 1024 * 1024) throw new Error('Archive limit')
    hash.update(chunk)
    let offset = 0
    while (offset < chunk.length) {
      const wrote = await file.write(chunk, offset, chunk.length - offset)
      if (!wrote.bytesWritten) throw new Error('Archive write failed')
      offset += wrote.bytesWritten
    }
  }
} finally {
  await file.close()
}
if (hash.digest('hex') !== lock.node[arch]) throw new Error('Official Node archive integrity mismatch')
await execute('tar', ['-xJf', archive, '--strip-components=2', '-C', stage, `${filename}/bin/node`], { env: environment, timeout: 30000 })
const license = await execute('tar', ['-xJOf', archive, `${filename}/LICENSE`], {
  env: environment,
  timeout: 30000,
  maxBuffer: 2 * 1024 * 1024,
})
await writeFile(join(stage, 'NODE-LICENSE'), license.stdout, { flag: 'wx', mode: 0o644 })
await unlink(archive)
const elf = await open(join(stage, 'node'), 'r')
try {
  const header = Buffer.alloc(20)
  await elf.read(header, 0, 20, 0)
  if (!header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || header.readUInt16LE(18) !== (arch === 'amd64' ? 62 : 183))
    throw new Error('Unexpected Node architecture')
} finally {
  await elf.close()
}
await copyFile(join(root, 'apps/relay/deploy/Dockerfile'), join(stage, 'Dockerfile'))
const hashes: Record<string, string> = {}
for (const path of ['node', 'latch-relay.mjs', 'latch-relay-tls', 'latch-relay-tls.LICENSE', 'NODE-LICENSE'])
  hashes[path] = createHash('sha256')
    .update(await readFile(join(stage, path)))
    .digest('hex')
await writeFile(
  join(stage, 'build.json'),
  `${JSON.stringify({ version: 1, platform: `linux/${arch}`, runtimeBase: lock.runtimeImage.reference, hashes }, null, 2)}\n`,
  { flag: 'wx', mode: 0o644 },
)
process.stdout.write(`${JSON.stringify({ prepared: true, stage, platform: `linux/${arch}`, runtimeBase: lock.runtimeImage.reference })}\n`)
