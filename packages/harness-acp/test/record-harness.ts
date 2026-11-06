/**
 * `pnpm harness:record --harness <preset> --scenario <name>`: records one scenario from the agent installed on this
 * computer, for its owner to run by hand. It lives with the tests because it drives the driver through the test kit.
 * See docs/TESTING.md「回放与录制」.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { AGENT_PRESETS } from '@latch/protocol'
import { redactSecrets } from '@latch/core/node-kit'
import { RECORD_SCENARIOS, recordHarness } from '@latch/testkit'
import { createAcpAgentPlugin, personCommandDirectories, resolveCommand, setCommandSearch } from '../src/index.ts'
import { profileFor } from '../src/profiles/index.ts'
import { activate, openBridge } from './helpers/replay.ts'

const USAGE = `用法：pnpm harness:record -- --harness <预设> --scenario <场景> [--out <目录>] [--env 名=值]... [--home-file 路径=本地文件]...

在只放行本机地址的沙箱里启动这台电脑上安装的 Agent，让它连接本地假模型服务，按场景操作一遍并记录 ACP 帧。
Agent 用一个临时的家目录；沙箱只放行本机连接，并挡住你家目录里的钥匙串文件与各 Agent 的登录目录。没有沙箱，或沙箱没挡住外部连接时拒绝运行。
结果经过规范化与脱敏，写到 --out（默认一个新的临时目录），由人读过后再移入 packages/testkit/fixtures/replay/。
--env 与 --home-file 告诉 Agent 去用假模型服务，值里的 {{MODEL_ORIGIN}} 换成它的地址（如 http://127.0.0.1:端口）。

预设：${AGENT_PRESETS.map(preset => preset.id).join('、')}
场景：${Object.keys(RECORD_SCENARIOS).join('、')}`

const pairs = (values: string[] | undefined, what: string): Record<string, string> =>
  Object.fromEntries(
    (values ?? []).map(value => {
      const at = value.indexOf('=')
      if (at <= 0) throw new Error(`${what} 应写成 名=值：${value}`)
      return [value.slice(0, at), value.slice(at + 1)]
    }),
  )

const cleanups: Array<() => Promise<void> | void> = []

async function main(): Promise<void> {
  const { values } = parseArgs({
    // `pnpm harness:record -- …` may pass the separator on.
    args: process.argv.slice(2).filter(arg => arg !== '--'),
    options: {
      harness: { type: 'string' },
      scenario: { type: 'string' },
      out: { type: 'string' },
      env: { type: 'string', multiple: true },
      'home-file': { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
  })
  const preset = AGENT_PRESETS.find(item => item.id === values.harness)
  if (values.help || !preset || !values.scenario || !RECORD_SCENARIOS[values.scenario]) {
    console.log(USAGE)
    process.exitCode = values.help ? 0 : 2
    return
  }
  // Like the start script: the person's own programs, where their shell would find them.
  setCommandSearch(personCommandDirectories)
  const command = resolveCommand(preset.command)
  if (!command) throw new Error(`没有找到 ${preset.command}；先安装它`)
  const profile = profileFor(preset.id)
  const keep = [
    ...Object.keys(profile?.permission.defaultEnv ?? {}),
    ...Object.keys(profile?.permission.programEnv ?? {}),
    ...(profile?.materialize ? ['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] : []),
  ]
  const homeFiles = Object.fromEntries(
    Object.entries(pairs(values['home-file'], '--home-file')).map(([path, file]) => [path, readFileSync(file, 'utf8')]),
  )
  const outDir = values.out ?? (await mkdtemp(join(tmpdir(), 'latch-recording-')))
  const { path } = await recordHarness({
    harness: preset.id,
    scenario: values.scenario,
    command,
    args: preset.args,
    env: pairs(values.env, '--env'),
    homeFiles,
    keep,
    outDir,
    redact: redactSecrets,
    open: async ({ definition, dataDir, workspace, tmpRoot }) => {
      const plugin = createAcpAgentPlugin({ id: preset.id, name: preset.name, presetId: preset.id, enabled: true, ...definition })
      return openBridge(await activate(plugin, cleanups), { dataDir, workspace, tmpRoot }, cleanups)
    },
  })
  console.log(`已写入 ${path}。读过后再移入 packages/testkit/fixtures/replay/${preset.id}/。`)
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
