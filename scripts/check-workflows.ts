import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTool, WORKFLOW_TOOLS, type WorkflowTool } from './workflow-tools.ts'

const ARGUMENTS: Record<WorkflowTool['name'], string[]> = {
  // Reads .github/workflows/ and .github/actionlint.yaml from the working directory.
  actionlint: [],
  // Collects workflows and actions outside .gitignore and reads .github/zizmor.yml; a file it cannot parse fails the run.
  zizmor: ['--strict-collection', '.'],
}

/**
 * `pnpm check:workflows`: actionlint and zizmor over the GitHub Actions files, at the versions pinned in
 * workflow-tools.ts. zizmor adds its online audits when GH_TOKEN or GITHUB_TOKEN is set. Exits 1 on any finding.
 */
async function main(): Promise<number> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const cacheDir = join(root, 'node_modules', '.cache', 'workflow-tools')
  const failed: string[] = []
  for (const tool of WORKFLOW_TOOLS) {
    console.log(`${tool.name} ${tool.version}`)
    let binary: string
    try {
      binary = await ensureTool(tool, { cacheDir })
    } catch (error) {
      console.log(`  失败  ${error instanceof Error ? error.message : String(error)}`)
      failed.push(tool.name)
      continue
    }
    const code = await runTool(binary, ARGUMENTS[tool.name], root)
    if (code === 0) console.log('  通过')
    else failed.push(tool.name)
  }
  console.log(failed.length === 0 ? '工作流检查通过。' : `工作流检查失败：${failed.join('、')}。`)
  return failed.length === 0 ? 0 : 1
}

function runTool(binary: string, args: string[], cwd: string): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(binary, args, { cwd, stdio: 'inherit' })
    child.on('error', error => {
      console.log(`  失败  无法运行 ${binary}：${error.message}`)
      resolve(1)
    })
    child.on('exit', code => resolve(code ?? 1))
  })
}

process.exitCode = await main()
