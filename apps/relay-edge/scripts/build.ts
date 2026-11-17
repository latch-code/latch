import { build } from 'esbuild'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bundles the two Workers into dist/relay-edge/ with the deploy templates beside them. The owner deploys that folder
 * with their own wrangler (`no_bundle`), so no Cloudflare tool is installed into the repository.
 */
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const out = resolve(root, 'dist/relay-edge')
const result = await build({
  absWorkingDir: root,
  entryPoints: { worker: 'apps/relay-edge/src/worker.ts', work: 'apps/relay-edge/src/work.ts' },
  outdir: out,
  bundle: true,
  platform: 'neutral',
  target: 'es2023',
  format: 'esm',
  metafile: true,
  write: false,
  legalComments: 'none',
})
for (const input of Object.keys(result.metafile.inputs)) {
  if (/(?:^|\/)(?:tests?|e2e)\/|packages\/testkit|@latch\/testkit/u.test(input)) throw new Error('Edge bundle includes test code')
  if (/^node:|node_modules/u.test(input)) throw new Error(`Edge bundle must not include ${input}`)
}
await mkdir(out, { recursive: true })
for (const file of result.outputFiles) await writeFile(file.path, file.contents)
for (const name of ['wrangler.jsonc', 'work.wrangler.jsonc'])
  await copyFile(resolve(root, 'apps/relay-edge/deploy', name), resolve(out, name))
process.stdout.write('已生成 dist/relay-edge/：worker.js、work.js 与两份部署模板。\n')
