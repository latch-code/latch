import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { changedFiles } from './repository.ts'
import { pnpmFromEnvironment } from './supply-canaries.ts'
import { FULL_STEPS, QUICK_STEPS, testProjects, verificationPlan } from './verify-plan.ts'

/**
 * `pnpm check` runs the static checks and the unit tests; `pnpm check:quick` only the static checks, in seconds.
 * Every step runs even after one fails, and the summary names each result. `pnpm check -- --plan [--base <ref>]`
 * runs nothing: it lists the checks and tests the working tree's change against `--base` (HEAD by default) calls for,
 * by changed path, and the ones it does not; a path no rule knows calls for all of them. `--full` lists the whole set,
 * for the end of a batch of changes or a release.
 */
// pnpm passes a `--` that separates its own options from the script's on to the script.
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const { values } = parseArgs({
  args,
  options: {
    quick: { type: 'boolean', default: false },
    plan: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    base: { type: 'string', default: 'HEAD' },
  },
})
const root = fileURLToPath(new URL('..', import.meta.url))

if (values.plan) {
  const config: unknown = await import(pathToFileURL(`${root}vitest.config.ts`).href)
  const changes = await changedFiles(root, values.base)
  const e2e = (await readdir(`${root}e2e`)).filter(name => name.endsWith('.e2e.ts'))
  const plan = verificationPlan(
    changes,
    testProjects(typeof config === 'object' && config !== null && 'default' in config ? config.default : undefined),
    { base: values.base, full: values.full, e2e },
  )
  console.log(`相对 ${values.base} 的改动：${changes.length} 个文件。`)
  console.log(
    values.full
      ? '范围：全量，整批改动合入后或发布前运行一次。'
      : '范围：这次改动影响的部分。整批改动合入后或发布前运行一次 pnpm check -- --plan --full。',
  )
  if (plan.unknown.length > 0) console.log(`这些路径不在规则中，所以运行全部检查：${plan.unknown.join('、')}`)
  console.log('运行：')
  for (const item of plan.run) {
    const shown = item.because.slice(0, 4).join('、') + (item.because.length > 4 ? ` 等 ${item.because.length} 个` : '')
    console.log(`  ${item.command}`)
    console.log(`      ${item.note ? `${item.note}；` : ''}因为 ${shown || '（没有改动）'}`)
  }
  if (plan.skipped.length > 0) {
    console.log('不需要运行：')
    for (const command of plan.skipped) console.log(`  ${command}`)
  }
} else {
  const pnpm = pnpmFromEnvironment()
  if (!pnpm) {
    console.log('找不到运行本脚本的 pnpm，请用 pnpm check 或 pnpm check:quick 运行。')
    process.exitCode = 1
  } else {
    const steps = values.quick ? QUICK_STEPS : FULL_STEPS
    const results: Array<{ step: string; code: number }> = []
    for (const step of steps) {
      console.log(`\n> pnpm ${step}`)
      const code = await new Promise<number>(resolve => {
        const child = spawn(pnpm.file, [...pnpm.args, 'run', step], { cwd: root, stdio: 'inherit' })
        child.on('error', () => resolve(1))
        child.on('exit', status => resolve(status ?? 1))
      })
      results.push({ step, code })
    }
    console.log('')
    for (const { step, code } of results) console.log(`  ${code === 0 ? '通过' : '失败'}  pnpm ${step}`)
    const failed = results.filter(result => result.code !== 0).length
    console.log(failed === 0 ? `全部 ${results.length} 项检查通过。` : `${failed} 项检查失败。`)
    process.exitCode = failed === 0 ? 0 : 1
  }
}
