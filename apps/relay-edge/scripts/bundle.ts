import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, from this file's place in it. */
export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** Bundles the relay Worker and the work Worker into `out` as worker.js and work.js; refuses test code and Node modules. */
export async function buildEdgeBundle(out: string): Promise<void> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: { worker: 'apps/relay-edge/src/worker.ts', work: 'apps/relay-edge/src/work.ts' },
    outdir: out,
    bundle: true,
    platform: 'neutral',
    target: 'es2023',
    format: 'esm',
    metafile: true,
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  })
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/(?:^|\/)(?:tests?|e2e)\/|packages\/testkit|@latch\/testkit/u.test(input)) throw new Error('Edge bundle includes test code')
    if (/^node:|node_modules/u.test(input)) throw new Error(`Edge bundle must not include ${input}`)
  }
  await mkdir(out, { recursive: true })
  for (const file of result.outputFiles) await writeFile(file.path, file.contents)
}
