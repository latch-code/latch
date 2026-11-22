import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { pnpmFromEnvironment } from './supply-canaries.ts'

const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const { values } = parseArgs({
  args,
  options: {
    plan: { type: 'boolean', default: false },
    boards: { type: 'string' },
    baseline: { type: 'string' },
    strict: { type: 'boolean', default: false },
  },
})
const root = fileURLToPath(new URL('..', import.meta.url))
const checks = [
  ['check:quick'],
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.config.ts',
    '--project',
    '@latch/ui',
    '--project',
    '@latch/ui-touch',
    '--project',
    '@latch/web',
  ],
  ['build'],
  ['exec', 'vitest', 'run', '--config', 'e2e/vitest.config.ts', 'e2e/design.e2e.ts', 'e2e/visual.e2e.ts'],
]
if (values.strict && !values.baseline) throw new Error('--strict 需要 --baseline <之前的截图目录>')
if (values.plan) {
  for (const check of checks) console.log(`pnpm ${check.join(' ')}`)
  console.log('截图：test-results/design、test-results/visual；比较：test-results/visual-diff/report.json')
} else {
  const pnpm = pnpmFromEnvironment()
  if (!pnpm) throw new Error('请通过 pnpm exec tsx scripts/ui-check.ts 运行。')
  const env = {
    ...process.env,
    ...(values.boards ? { LATCH_VISUAL_BOARDS: resolve(values.boards) } : {}),
    ...(values.baseline ? { LATCH_VISUAL_BASELINE: resolve(values.baseline) } : {}),
    ...(values.strict ? { LATCH_VISUAL_STRICT: '1' } : {}),
  }
  for (const check of checks) {
    console.log(`\n> pnpm ${check.join(' ')}`)
    const code = await new Promise<number>(done => {
      const child = spawn(pnpm.file, [...pnpm.args, ...check], { cwd: root, env, stdio: 'inherit' })
      child.on('error', () => done(1))
      child.on('exit', status => done(status ?? 1))
    })
    if (code !== 0) {
      process.exitCode = code
      break
    }
  }
}
