import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { checkExceptions, checkPackageManagerPin, PUBLIC_REGISTRY, utcDate } from './supply-chain.ts'
import { CANARIES, canaryHeld, CONTROL, pnpmFromEnvironment, pnpmVersion, runCanaries } from './supply-canaries.ts'

/**
 * `pnpm check:supply`: dated exceptions, the sha512 of the pinned pnpm, and install canaries proving that
 * pnpm-workspace.yaml still makes risky installs fail. Exits 1 on any problem.
 */
async function main(): Promise<number> {
  const root = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url))
  const workspaceYaml = await readFile(root('pnpm-workspace.yaml'), 'utf8')
  const lockfile = await readFile(root('pnpm-lock.yaml'), 'utf8').catch(() => undefined)
  const manifest = JSON.parse(await readFile(root('package.json'), 'utf8')) as { packageManager?: unknown }
  let failures = 0
  const fail = (lines: string[]) => {
    failures += lines.length
    for (const line of lines) console.log(`  失败  ${line}`)
  }

  const exceptions = checkExceptions(workspaceYaml, lockfile, utcDate())
  console.log('例外')
  fail(exceptions.problems)
  if (exceptions.problems.length === 0) {
    for (const group of exceptions.groups)
      console.log(`  通过  ${group.setting}：${group.entries.length} 条，${group.expires} 到期，审阅人 ${group.reviewer}`)
    if (exceptions.groups.length === 0) console.log('  通过  没有例外')
  }

  console.log('packageManager')
  const { pin, problems } = await checkPackageManagerPin(manifest.packageManager, fetchJson)
  fail(problems)
  if (pin && problems.length === 0) console.log(`  通过  pnpm@${pin.version} 的 sha512 与 ${PUBLIC_REGISTRY} 一致`)

  console.log('安装金丝雀')
  const pnpm = pnpmFromEnvironment()
  const running = pnpm ? await pnpmVersion(pnpm).catch((error: Error) => error) : undefined
  if (!pnpm || running instanceof Error) {
    fail([`找不到运行本脚本的 pnpm，请用 pnpm check:supply 运行${running instanceof Error ? `（${running.message}）` : ''}`])
  } else if (pin && running !== pin.version) {
    fail([`金丝雀要在 packageManager 指定的 pnpm ${pin.version} 上运行，当前是 ${running}`])
  } else {
    for (const result of await runCanaries({ pnpm, workspaceYaml })) {
      const canary = [CONTROL, ...CANARIES].find(item => item.id === result.id)!
      const passed = canary === CONTROL ? result.installed : canaryHeld(canary, result)
      if (passed) {
        console.log(`  通过  ${result.title}：${canary === CONTROL ? '已安装' : `安装失败，${canary.expectedCode}`}`)
        continue
      }
      const why =
        canary === CONTROL
          ? '安装失败，其余金丝雀的结果不可信'
          : result.scriptRan
            ? '依赖的安装脚本运行了'
            : result.installed
              ? '安装成功，对应的保护已失效'
              : `安装因其他原因失败（${result.codes.join('、') || '没有错误码'}），预期 ${canary.expectedCode}`
      fail([`${result.title}：${why}`])
      console.log(
        result.output
          .trim()
          .split('\n')
          .slice(-20)
          .map(line => `        ${line}`)
          .join('\n'),
      )
    }
  }

  console.log(failures === 0 ? '供应链检查通过。' : `供应链检查失败：${failures} 项。`)
  return failures === 0 ? 0 : 1
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

process.exitCode = await main()
