import { fileURLToPath } from 'node:url'
import { BUDGET, checkAgentDocs } from './agent-docs.ts'
import { readWorkspaceProjects } from './boundaries.ts'
import { openRepository } from './repository.ts'

/**
 * `pnpm check:agents`: structural facts about the agent instructions, skills and docs/ — byte budgets, CLAUDE.md
 * imports, links, the paths and tests the instructions name, skill links and the docs' front matter — and what must not
 * be committed there (`doc-hygiene.ts`). The only wording it looks at is that list of blocked phrases. Exits 1 on any problem.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const repo = await openRepository(root)
const { projects } = await readWorkspaceProjects(root)
const problems = await checkAgentDocs(repo, { projects: projects.map(project => project.dir) })
const agents = [...repo.files].filter(file => file.endsWith('AGENTS.md')).length
for (const problem of problems) console.log(`  失败  ${problem}`)
console.log(
  problems.length === 0
    ? `Agent 说明检查通过：${agents} 个 AGENTS.md（根不超过 ${BUDGET.root} 字节，其余不超过 ${BUDGET.project} 字节，每条路径合计不超过 ${BUDGET.path} 字节）。`
    : `Agent 说明检查失败：${problems.length} 项。`,
)
process.exitCode = problems.length === 0 ? 0 : 1
