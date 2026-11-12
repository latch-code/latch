import { fileURLToPath } from 'node:url'
import { checkBoundaries, checkScreensOnly, PROJECTS, readIosSources, readWorkspaceProjects } from './boundaries.ts'

/**
 * `pnpm check:boundaries`: every workspace project declares the environment it runs in, and lists only the workspace
 * packages that scripts/boundaries.ts allows it; the iOS LatchScreens target's own code stays out of the Latch product.
 * Exits 1 on any problem.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const { projects, problems: listing } = await readWorkspaceProjects(root)
const ios = await readIosSources(root)
const problems = [...listing, ...checkBoundaries(projects), ...checkScreensOnly(ios.files, ios.project)]
for (const project of projects) {
  const name = typeof project.manifest.name === 'string' ? project.manifest.name : project.dir
  const env = PROJECTS[name]?.env
  console.log(`  ${project.dir}  ${name}${env ? `（${env}）` : ''}`)
}
for (const problem of problems) console.log(`  失败  ${problem}`)
console.log(problems.length === 0 ? `依赖边界检查通过：${projects.length} 个项目。` : `依赖边界检查失败：${problems.length} 项。`)
process.exitCode = problems.length === 0 ? 0 : 1
