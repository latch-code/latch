import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { addedLines, changedFiles, openRepository } from './repository.ts'
import { coChangeReminders, scanAddedLines } from './security-rules.ts'

/**
 * `pnpm security:scan [-- --base <ref>]`: the mechanical half of a security review of the working tree's change
 * against `--base` (HEAD by default). It lists secret-shaped text and APIs AGENTS.md rules out in the lines the change
 * adds, files that must change together, and the AGENTS.md files whose invariants the change falls under. Exits 1 on a
 * finding outside test code; judging the change against those invariants is still the reviewer's job.
 */
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const { values } = parseArgs({ args, options: { base: { type: 'string', default: 'HEAD' } } })
const root = fileURLToPath(new URL('..', import.meta.url))
const base = values.base
const changes = await changedFiles(root, base)
const findings = scanAddedLines(await addedLines(root, changes, base))
const paths = changes.map(change => change.path)
const reminders = coChangeReminders(paths)
const repo = await openRepository(root)
const instructions = [...repo.files]
  .filter(file => file === 'AGENTS.md' || file.endsWith('/AGENTS.md'))
  .filter(file => file === 'AGENTS.md' || paths.some(path => path.startsWith(file.slice(0, -'AGENTS.md'.length))))
  .toSorted()

console.log(`相对 ${base} 的改动：${changes.length} 个文件。`)
const failing = findings.filter(finding => !finding.inTest)
const review = findings.filter(finding => finding.inTest)
console.log(failing.length === 0 ? '发现：无' : '发现：')
for (const finding of failing) console.log(`  ${finding.path}  [${finding.rule}] ${finding.message}\n      ${finding.line}`)
if (review.length > 0) {
  console.log('测试代码中的匹配（确认是伪造值或有意的用例）：')
  for (const finding of review) console.log(`  ${finding.path}  [${finding.rule}] ${finding.line}`)
}
if (reminders.length > 0) {
  console.log('一起修改的文件：')
  for (const reminder of reminders)
    console.log(
      `  ${reminder.message}\n      已改：${reminder.changed.join('、')}${reminder.unchanged.length > 0 ? `\n      未改：${reminder.unchanged.join('、')}` : ''}`,
    )
}
console.log(`按这些说明中的不变量审阅：${instructions.join('、')}`)
process.exitCode = failing.length === 0 ? 0 : 1
