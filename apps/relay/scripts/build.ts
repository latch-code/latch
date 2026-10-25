import { build } from 'esbuild'
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
const { mkdir, writeFile } = await import('node:fs/promises')
await mkdir(resolve(root, 'dist/relay'), { recursive: true })
for (const file of result.outputFiles) await writeFile(file.path, file.contents)
