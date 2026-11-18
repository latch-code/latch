import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildEdgeBundle, ROOT } from './bundle.ts'

/**
 * Bundles the two Workers into dist/relay-edge/ with the reviewed deploy configs beside them, to read or diff.
 * `pnpm relay-edge:setup` builds, deploys and writes the secrets in one go through its hardened wrangler runner.
 */
const out = resolve(ROOT, 'dist/relay-edge')
await buildEdgeBundle(out)
for (const name of ['wrangler.jsonc', 'work.wrangler.jsonc'])
  await copyFile(resolve(ROOT, 'apps/relay-edge/deploy', name), resolve(out, name))
process.stdout.write('已生成 dist/relay-edge/：worker.js、work.js 与两份部署配置。\n')
