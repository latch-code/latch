// Connecting to a harness that cannot work: a command too old for its preset, and an agent that never answers the
// handshake or opening a session. Each must end in a Host-defined refusal, quickly, never in a session left running.
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PRESETS, type DriverTaskDetail } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_PI_AGENT } from '@latch/testkit'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  outdatedCommand,
  presetOffer,
  recheckVersions,
  resolveCommand,
  setCommandSearch,
  setLoginPrograms,
  type AcpAgentOptions,
  type AgentRecord,
} from '../src/index.ts'
import { agentProbePreview, probeAgent } from '../src/probe.ts'
import { bareVersion } from '../src/version-line.ts'
import { compareVersions } from '../src/version.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})

let requests = 0
const rid = () => `connect-${++requests}`

async function activate(plugin: HarnessPlugin): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: driver => void drivers.push(driver),
    registerProvider: () => {},
    registerTool: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: dispose => void disposers.push(dispose),
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]!
}

/**
 * A temporary computer: `bin/<name>` runs the fake agent, prints what the file `version` says for `--version` (fails
 * when it says `fail`), and is the only command the Host finds; reading versions is allowed, as the start script allows.
 */
async function computer(name: string, version = '0.2.2-rc.1', script?: (versionFile: string) => string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-connect-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(bin)
  await mkdir(workspace)
  await mkdir(tmpRoot, { mode: 0o700 })
  const path = join(bin, name)
  const versionFile = join(root, 'version')
  await writeFile(versionFile, version)
  await writeFile(
    path,
    script?.(versionFile)
      ?? [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then v=$(cat '${versionFile}'); [ "$v" = fail ] && exit 1; echo "$v"; exit 0; fi`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
  )
  await chmod(path, 0o755)
  setCommandSearch(() => [bin])
  setLoginPrograms(resolveCommand)
  forgetCommandLookups()
  return { root, bin, path, versionFile, workspace, dataDir, tmpRoot }
}

async function open(driver: HarnessDriver, where: { workspace: string; dataDir: string; tmpRoot: string }): Promise<Bridge> {
  const bridge = driver.create({
    dataDir: where.dataDir,
    workspaceRoot: where.workspace,
    tmpRoot: where.tmpRoot,
    providerId: 'unused',
    registry: {
      acquire() {
        throw new Error('ACP sessions do not lease Host providers')
      },
    },
    securityEvent: () => {},
  })
  cleanups.push(() => bridge.close())
  await bridge.start()
  return bridge
}

async function start(bridge: Bridge, workspace: string): Promise<string> {
  const { launchHash } = await bridge.launchPreview!({ cwd: workspace })
  const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), expectedLaunchHash: launchHash })
  return sessionId
}

async function ended(bridge: Bridge, id: string, timeout = 8_000): Promise<DriverTaskDetail> {
  await vi.waitFor(
    async () => {
      const status = (await bridge.detail(id)).summary.status
      expect(status === 'running' || status === 'waiting-approval').toBe(false)
    },
    { timeout, interval: 20 },
  )
  return bridge.detail(id)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const systemText = (detail: DriverTaskDetail) =>
  detail.messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join('\n')

describe('version order', () => {
  it.each([
    ['0.1.1-rc.2', '0.2.1-rc.2', -1],
    ['0.2.1-rc.2', '0.2.1-rc.2', 0],
    ['0.2.2-rc.1', '0.2.1-rc.2', 1],
    ['0.2.1', '0.2.1-rc.2', 1],
    ['0.2.1-rc.10', '0.2.1-rc.2', 1],
    ['0.2.2-alpha.3', '0.2.2-rc.1', -1],
    ['1.5.0', '0.84.4', 1],
    ['0.84.3', '0.84.4', -1],
  ])('%s against %s is %i', (a, b, order) => {
    expect(compareVersions(a, b)).toBe(order)
  })
  it('has no order for something that is not a version', () => {
    expect(compareVersions('unknown', '0.2.1-rc.2')).toBeUndefined()
  })
})

describe('reading a version line', () => {
  it.each([
    ['0.2.1-rc.2\n', '0.2.1-rc.2'],
    ['v0.2.2\n', '0.2.2'],
    ['\n  1.5.0  \n(more text)', '1.5.0'],
    ['Update available: 0.1.0 → 0.2.2\n0.1.0\n', undefined],
    ['dsh 0.1.0\n', undefined],
    ['', undefined],
  ])('%j reads as %s', (output, version) => {
    expect(bareVersion(output)).toBe(version)
  })
})

describe('a command older than its preset supports', () => {
  const dsh = (env: Record<string, string>): AgentRecord => ({
    id: 'dsh',
    name: 'DeepSeek Harness',
    presetId: 'dsh',
    command: 'dsh',
    args: ['--profile', 'acp'],
    env,
    enabled: true,
  })

  it('is not ready, says which version it needs and how to upgrade, and refuses to start without running it', async () => {
    const where = await computer('dsh', '0.1.1-rc.2')
    const log = join(where.root, 'agent.log')
    const record = dsh({ FAKE_ACP_LOG: log })
    const driver = await activate(createAcpAgentPlugin(record, FAST))
    await recheckVersions([record], 5_000)
    const text = '需要 0.2.1-rc.1 或更高版本（当前 0.1.1-rc.2）。升级：npm i -g @deepseek-ai/dsh@latest'
    expect(outdatedCommand(record, resolveCommand('dsh'))).toEqual({
      need: '需要 0.2.1-rc.1 或更高版本（当前 0.1.1-rc.2）',
      upgrade: 'npm i -g @deepseek-ai/dsh@latest',
    })
    expect(driver.status?.()).toEqual({ status: 'unavailable', statusMessage: `DeepSeek Harness ${text}`, statusReason: 'outdated' })
    const offer = presetOffer(AGENT_PRESETS.find(preset => preset.id === 'dsh')!)
    expect(offer).toMatchObject({ status: 'unavailable', statusMessage: `DeepSeek Harness ${text}`, statusReason: 'outdated' })

    const bridge = await open(driver, where)
    const detail = await ended(bridge, await start(bridge, where.workspace))
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain(`DeepSeek Harness ${text}`)
    // The version read ran the command; no ACP process was started.
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const options = { dataDir: where.dataDir, cwd: where.workspace }
    const preview = await agentProbePreview(record, options)
    await expect(probeAgent(record, { ...options, expectedLaunchHash: preview.launchHash })).rejects.toMatchObject({
      status: 409,
      code: 'harness-version-unsupported',
      message: `DeepSeek Harness ${text}`,
    })
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // Refused for its version, it is not the harness's last error: an upgrade ends it.
    expect(driver.status?.()).toEqual({ status: 'unavailable', statusMessage: `DeepSeek Harness ${text}`, statusReason: 'outdated' })
  })

  it('starts once upgraded, after 重新检测 reads the version again', async () => {
    const where = await computer('dsh', '0.1.1-rc.2')
    const record = dsh({})
    const driver = await activate(createAcpAgentPlugin(record, FAST))
    await recheckVersions([record], 5_000)
    expect(driver.status?.().status).toBe('unavailable')
    // Upgraded in place: the same file now prints a newer version.
    await writeFile(where.versionFile, '0.2.2-rc.1')
    forgetCommandLookups()
    await recheckVersions([record], 5_000)
    expect(driver.status?.()).toEqual({ status: 'ready' })
    const bridge = await open(driver, where)
    const detail = await ended(bridge, await start(bridge, where.workspace))
    expect(detail.summary.status).toBe('idle')
  })

  it('blocks nothing when the version cannot be read', async () => {
    const where = await computer('dsh', 'fail')
    const record = dsh({})
    const driver = await activate(createAcpAgentPlugin(record, FAST))
    await recheckVersions([record], 5_000)
    expect(driver.status?.()).toEqual({ status: 'ready' })
    const bridge = await open(driver, where)
    expect((await ended(bridge, await start(bridge, where.workspace))).summary.status).toBe('idle')
  })

  it('is not read on a Host that may not run the person’s programs', async () => {
    const where = await computer('dsh', '0.1.1-rc.2')
    setLoginPrograms(undefined)
    const record = dsh({})
    const driver = await activate(createAcpAgentPlugin(record, FAST))
    await recheckVersions([record], 5_000)
    expect(driver.status?.()).toEqual({ status: 'ready' })
    expect(outdatedCommand(record, where.path)).toBeUndefined()
  })

  it('reads only the preset’s own command, never a runtime that runs it', async () => {
    const where = await computer('dsh', '0.1.1-rc.2')
    const record = dsh({})
    const throughNode: AgentRecord = { ...record, command: process.execPath, args: [where.path, '--profile', 'acp'] }
    await recheckVersions([throughNode], 5_000)
    expect(outdatedCommand(throughNode, process.execPath)).toBeUndefined()
  })

  it.each([
    ['0.2.2-rc.1', '0.1.0', undefined],
    ['0.1.1-rc.2', '0.3.0', '当前 0.1.1-rc.2'],
  ])('reads standard output only: %s there, %s on standard error', async (out, err, need) => {
    const where = await computer('dsh', out, file =>
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then echo '${err}' >&2; cat '${file}'; echo; exit 0; fi`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    const record = dsh({})
    await recheckVersions([record], 5_000)
    const found = outdatedCommand(record, where.path)
    if (need) expect(found?.need).toContain(need)
    else expect(found).toBeUndefined()
  })

  it('never reads a command that is not the preset’s own program, wherever it is', async () => {
    const where = await computer('dsh', '0.1.1-rc.2')
    const elsewhere = join(where.workspace, 'tools')
    await mkdir(elsewhere)
    const copy = join(elsewhere, 'dsh')
    await writeFile(copy, `#!/bin/sh\n[ "$1" = --version ] && { printf x >> '${join(where.root, 'read')}'; echo 0.1.1-rc.2; exit 0; }\n`)
    await chmod(copy, 0o755)
    const record: AgentRecord = { ...dsh({}), command: copy }
    await recheckVersions([record], 5_000)
    expect(outdatedCommand(record, copy)).toBeUndefined()
    await expect(readFile(join(where.root, 'read'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // The same file under its full path is the preset's own program.
    const same: AgentRecord = { ...dsh({}), command: where.path }
    await recheckVersions([same], 5_000)
    expect(outdatedCommand(same, where.path)?.need).toContain('当前 0.1.1-rc.2')
  })

  it('stops a test start that was cancelled while its version was read, before anything runs', async () => {
    const where = await computer('dsh', '0.2.2-rc.1', file =>
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then sleep 1; cat '${file}'; echo; exit 0; fi`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    const log = join(where.root, 'agent.log')
    const record = dsh({ FAKE_ACP_LOG: log })
    const options = { dataDir: where.dataDir, cwd: where.workspace }
    const preview = await agentProbePreview(record, options)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    await expect(
      probeAgent(record, { ...options, expectedLaunchHash: preview.launchHash, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'probe-cancelled' })
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers when the program exits while a helper keeps its output open', async () => {
    const where = await computer('dsh', '0.1.1-rc.2', file =>
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then sleep 30 & cat '${file}'; echo; exit 0; fi`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    const record = dsh({})
    const began = Date.now()
    await recheckVersions([record], 8_000)
    expect(Date.now() - began).toBeLessThan(3_000)
    expect(outdatedCommand(record, where.path)?.need).toContain('当前 0.1.1-rc.2')
  })

  it('reads a cached "too old" again before refusing, as a shim stays the same file across an upgrade', async () => {
    const where = await computer('dsh', '0.1.1-rc.2')
    const record = dsh({})
    const driver = await activate(createAcpAgentPlugin(record, FAST))
    await recheckVersions([record], 5_000)
    expect(driver.status?.().status).toBe('unavailable')
    // The program behind the shim changed, the shim did not: no 重新检测, the start reads it again.
    const before = await stat(where.path)
    await writeFile(where.versionFile, '0.2.2-rc.1')
    await utimes(where.path, before.atime, before.mtime)
    const bridge = await open(driver, where)
    expect((await ended(bridge, await start(bridge, where.workspace))).summary.status).toBe('idle')
    expect(driver.status?.()).toEqual({ status: 'ready' })
  })

  it('refuses a start whose project configuration changed while its version was read', async () => {
    const where = await computer('pi', '1.5.0', file =>
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then sleep 1; cat '${file}'; echo; exit 0; fi`,
        `exec '${process.execPath}' '${FAKE_PI_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    const log = join(where.root, 'pi.log')
    const record: AgentRecord = { id: 'pi', name: 'pi', presetId: 'pi', command: 'pi', args: [], env: { FAKE_PI_LOG: log }, enabled: true }
    const driver = await activate(createAcpAgentPlugin(record, FAST))
    const bridge = await open(driver, where)
    const id = await start(bridge, where.workspace)
    await new Promise(resolve => setTimeout(resolve, 300))
    await mkdir(join(where.workspace, '.pi'))
    await writeFile(join(where.workspace, '.pi', 'settings.json'), '{"changed":true}')
    const detail = await ended(bridge, id)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('配置与会话启动时不同')
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('applies to pi by its own minimum', async () => {
    await computer('pi', '0.84.3')
    const record: AgentRecord = {
      id: 'pi',
      name: 'pi',
      presetId: 'pi',
      command: 'pi',
      args: [],
      env: {},
      enabled: true,
    }
    await recheckVersions([record], 5_000)
    expect(outdatedCommand(record, resolveCommand('pi'))).toEqual({
      need: '需要 0.84.4 或更高版本（当前 0.84.3）',
      upgrade: 'npm i -g @earendil-works/pi-coding-agent@latest',
    })
  })
})

describe('an agent that never answers', () => {
  const fake = (env: Record<string, string>): AgentRecord => ({
    id: 'fake',
    name: 'Fake',
    command: process.execPath,
    args: [FAKE_ACP_AGENT],
    env,
    enabled: true,
  })
  async function place() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-connect-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const where = { workspace: join(root, 'workspace'), dataDir: join(root, 'data'), tmpRoot: join(root, 'run-tmp') }
    await mkdir(where.workspace)
    await mkdir(where.tmpRoot, { mode: 0o700 })
    return where
  }

  it('is stopped when initialize is not answered in time, and the session fails with the reason', async () => {
    const where = await place()
    const driver = await activate(createAcpAgentPlugin(fake({ FAKE_ACP_INIT_SILENT: '1' }), { ...FAST, handshakeTimeoutMs: 400 }))
    const bridge = await open(driver, where)
    const began = Date.now()
    const detail = await ended(bridge, await start(bridge, where.workspace), 4_000)
    expect(Date.now() - began).toBeLessThan(4_000)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('Fake 1 秒内没有完成启动握手（initialize），已停止它。确认它能在终端里正常运行后重试。')
    expect(driver.status?.()).toMatchObject({ status: 'ready', statusMessage: expect.stringContaining('没有完成启动握手') })
  })

  it('is stopped when session/new is not answered in time', async () => {
    const where = await place()
    const log = join(where.workspace, '..', 'agent.log')
    const driver = await activate(
      createAcpAgentPlugin(
        // Slow to leave: it waits after stdin ends and ignores SIGTERM, so only SIGKILL after the grace ends it.
        fake({ FAKE_ACP_NEW_SILENT: '1', FAKE_ACP_LOG: log, FAKE_ACP_EXIT_DELAY: '5000', FAKE_ACP_IGNORE_TERM: '1' }),
        { ...FAST, sessionSetupTimeoutMs: 400, stopGraceMs: 400 },
      ),
    )
    const bridge = await open(driver, where)
    const id = await start(bridge, where.workspace)
    // The moment the session says it failed, the process is already gone.
    let pid: number | undefined
    let aliveAfterFailure = false
    await vi.waitFor(
      async () => {
        pid ??= (await readFile(log, 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as { event: string; pid: number })
          .find(entry => entry.event === 'start')?.pid
        const status = (await bridge.detail(id)).summary.status
        if (status === 'failed' && pid !== undefined && alive(pid)) aliveAfterFailure = true
        expect(status).toBe('failed')
      },
      { timeout: 6_000, interval: 10 },
    )
    expect(aliveAfterFailure).toBe(false)
    expect(pid !== undefined && alive(pid)).toBe(false)
    const detail = await bridge.detail(id)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('Fake 1 秒内没有完成建立会话（session/new），已停止它。')
  })
})
