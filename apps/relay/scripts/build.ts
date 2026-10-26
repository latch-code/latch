import { build } from 'esbuild'
import { relayGoEnvironment } from './go-environment.ts'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['apps/relay/src/cli.ts'],
  outfile: 'dist/relay/latch-relay.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  metafile: true,
  write: false,
})
for (const input of Object.keys(result.metafile.inputs))
  if (/(?:^|\/)(?:tests?|e2e)\/|packages\/testkit|@latch\/testkit/u.test(input)) throw new Error('Relay bundle includes test code')
const { copyFile, mkdir, writeFile } = await import('node:fs/promises')
await mkdir(resolve(root, 'dist/relay'), { recursive: true })
for (const file of result.outputFiles) await writeFile(file.path, file.contents)

// Go is a build prerequisite, never fetched at runtime. No third-party Go modules.
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const execute = promisify(execFile)
const gatewayPath = resolve(root, 'dist/relay/latch-relay-tls')
await execute(
  process.env.LATCH_RELAY_GO ?? 'go',
  [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-ldflags=-s -w -buildid=',
    '-o',
    gatewayPath,
    resolve(root, 'apps/relay/gateway/main.go'),
    resolve(root, 'apps/relay/gateway/supervisor.go'),
  ],
  {
    env: relayGoEnvironment(),
    timeout: 120_000,
  },
)
const { checkGateway } = await import('../src/gateway.ts')
await checkGateway(gatewayPath)

await copyFile(resolve(root, 'apps/relay/gateway/GO-LICENSE'), `${gatewayPath}.LICENSE`)
