import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSeo } from './seo-check.ts'

/** `pnpm --filter @latch/site check:seo [dist directory]`: the SEO and link checks over a built site; exits 1 on any problem. */
const dist = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist', import.meta.url))
const { pages, problems } = checkSeo(dist)
for (const page of pages)
  console.log(
    `${page.path.padEnd(14)} ${page.lang.padEnd(6)} title ${String(page.title).padStart(2)}  description ${String(page.description).padStart(3)}  h1 ${page.h1}`,
  )
console.log(problems.length > 0 ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nNo problems.')
process.exitCode = problems.length > 0 ? 1 : 0
