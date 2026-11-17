import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildEdgeBundle, ROOT } from './bundle.ts'

/**
 * Bundles the two Workers into dist/relay-edge/ with the deploy templates beside them, for deploying by hand with your own
 * wrangler (`no_bundle`). `pnpm relay-edge:setup` does all of it in one go.
 */
const out = resolve(ROOT, 'dist/relay-edge')
await buildEdgeBundle(out)
for (const name of ['wrangler.jsonc', 'work.wrangler.jsonc'])
  await copyFile(resolve(ROOT, 'apps/relay-edge/deploy', name), resolve(out, name))
process.stdout.write('已生成 dist/relay-edge/：worker.js、work.js 与两份部署模板。\n')
