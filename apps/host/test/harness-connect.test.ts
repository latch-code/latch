// What the Host says and does for a harness that cannot work yet: a command too old for its preset, an agent that never
// answers its handshake, and pi as 1.5 answers. Every case ends in a reason a person can act on, never a session that
// keeps running.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import type { AgentPresetSettings, AgentSettings, AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_PI_AGENT } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'latch-connect-')))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

const systemText = (detail: TaskDetail) =>
  detail.messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join('\n')

/** A Host whose only `dsh` prints the version in a file, marks each start, and may run the person's programs. */
async function dshHost(version: string) {
  const root = await directory()
  const bin = join(root, 'bin')
  await mkdir(bin)
  const versionFile = join(root, 'version')
  const started = join(root, 'started')
  await writeFile(versionFile, version)
  const path = join(bin, 'dsh')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      `if [ "$1" = --version ]; then cat '${versionFile}'; echo; exit 0; fi`,
      `printf x >> '${started}'`,
      `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      '',
    ].join('\n'),
  )
  await chmod(path, 0o755)
  const t: TestHost = await startTestHost({
    detectPreset: preset => (preset.id === 'dsh' ? { found: true, path } : { found: false }),
    loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    commandDirectories: () => [bin],
  })
  cleanups.push(() => t.close())
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
  })
  return { t, owner, path, versionFile, started }
}

const TOO_OLD = 'DeepSeek Harness 需要 0.2.1-rc.1 或更高版本（当前 0.1.1-rc.2）。升级：npm i -g @deepseek-ai/dsh@latest'

describe('a saved DeepSeek Harness found too old', () => {
  it('refuses an existing session, and a test start, with the same code and words', async () => {
    const { owner, versionFile } = await dshHost('0.2.2-rc.1')
    const created = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'dsh', prompt: 'echo one', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
    await writeFile(versionFile, '0.1.1-rc.2')
    await owner.json('agents')
    const prompted = await owner.request(`tasks/${created.sessionId}/prompt`, {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: 'echo two' },
    })
    expect(prompted.status).toBe(409)
    expect(await prompted.json()).toEqual({ error: 'harness-version-unsupported', message: TOO_OLD })
    const probed = await owner.request('agents/dsh/probe', { method: 'POST', body: { requestId: randomUUID() } })
    expect(probed.status).toBe(409)
    expect(await probed.json()).toEqual({ error: 'harness-version-unsupported', message: TOO_OLD })
  })

  it('starts a new session without 重新检测 once a shim reports a new version, reading it once more', async () => {
    const { owner, path, versionFile, started } = await dshHost('0.2.2-rc.1')
    await writeFile(versionFile, '0.1.1-rc.2')
    await owner.json('agents')
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')?.status).toBe('unavailable')
    // Upgraded behind a shim: the same file, the same time stamp, a new version.
    const before = await stat(path)
    await writeFile(versionFile, '0.2.2-rc.1')
    await utimes(path, before.atime, before.mtime)
    const created = await owner.request('tasks', {
      method: 'POST',
      body: { harnessId: 'dsh', prompt: 'echo one', requestId: randomUUID() },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    expect(existsSync(started)).toBe(true)
  })
})

describe('a DeepSeek Harness older than its preset supports', () => {
  it('shows the version it needs in settings and the catalog, and refuses a session without starting it', async () => {
    const root = await directory()
    const bin = join(root, 'bin')
    await mkdir(bin)
    const versionFile = join(root, 'version')
    const started = join(root, 'started')
    const versionsRead = join(root, 'versions-read')
    await writeFile(versionFile, '0.1.1-rc.2')
    await writeFile(
      join(bin, 'dsh'),
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then printf x >> '${versionsRead}'; cat '${versionFile}'; echo; exit 0; fi`,
        `printf x >> '${started}'`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'dsh'), 0o755)
    const t: TestHost = await startTestHost({
      detectPreset: preset => (preset.id === 'dsh' ? { found: true, path: join(bin, 'dsh') } : { found: false }),
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      commandDirectories: () => [bin],
    })
    cleanups.push(() => t.close())
    const owner = await t.enroll({ listener: 'unix' })
    const text = '需要 0.2.1-rc.1 或更高版本（当前 0.1.1-rc.2）。升级：npm i -g @deepseek-ai/dsh@latest'
    const outdated = { need: '需要 0.2.1-rc.1 或更高版本（当前 0.1.1-rc.2）', upgrade: 'npm i -g @deepseek-ai/dsh@latest' }

    // Before a definition exists nothing runs it, not even for its version: the draft's offer is all there is.
    const listed = await owner.json<{ presets: AgentPresetSettings[] }>('agents')
    // Settings says it was found, and that its version is not read yet.
    expect(listed.presets.find(preset => preset.id === 'dsh')?.detected).toEqual({
      found: true,
      path: join(bin, 'dsh'),
      versionUnread: true,
    })
    expect(existsSync(versionsRead)).toBe(false)

    // Chosen from a draft: saving its definition reads the version once and refuses, so no session and no definition.
    const body = { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} }
    const chosen = await owner.confirmed('agents', { method: 'POST', body })
    expect(chosen.status).toBe(409)
    expect(await chosen.json()).toEqual({ error: 'harness-version-unsupported', message: `DeepSeek Harness ${text}` })
    expect((await readFile(versionsRead, 'utf8')).length).toBe(1)
    const unsaved = await owner.json<{ agents: AgentSettings[]; presets: AgentPresetSettings[] }>('agents')
    expect(unsaved.agents).toEqual([])
    // Kept: the preset now says it needs an upgrade, and a draft lists it greyed, never as a choice.
    expect(unsaved.presets.find(preset => preset.id === 'dsh')?.detected).toMatchObject({ found: true, outdated })
    expect(unsaved.presets.find(preset => preset.id === 'dsh')?.detected?.versionUnread).toBeUndefined()
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')).toMatchObject({
      status: 'unavailable',
      statusReason: 'outdated',
      statusMessage: `DeepSeek Harness ${text}`,
    })
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toEqual([])
    expect(existsSync(started)).toBe(false)

    // Saved while new enough, then found too old on 重新检测: a session is refused the same way.
    await writeFile(versionFile, '0.2.2-rc.1')
    await owner.confirmedJson('agents', { method: 'POST', body })
    await writeFile(versionFile, '0.1.1-rc.2')
    const saved = await owner.json<{ agents: AgentSettings[] }>('agents')
    expect(saved.agents.find(agent => agent.id === 'dsh')?.detected).toMatchObject({ found: true, outdated })
    const harness = (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')
    expect(harness).toMatchObject({ status: 'unavailable', statusMessage: `DeepSeek Harness ${text}` })
    const refused = await owner.request('tasks', { method: 'POST', body: { harnessId: 'dsh', prompt: 'hello', requestId: randomUUID() } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'harness-version-unsupported', message: `DeepSeek Harness ${text}` })
    expect(existsSync(started)).toBe(false)
    // Turned off, it is not read again.
    const reads = (await readFile(versionsRead, 'utf8')).length
    await owner.json('agents/dsh', { method: 'PUT', body: { enabled: false } })
    await owner.json('agents')
    expect((await readFile(versionsRead, 'utf8')).length).toBe(reads)
    await owner.json('agents/dsh', { method: 'PUT', body: { enabled: true } })

    // Upgraded in a terminal, then 重新检测: ready again and a session runs.
    await writeFile(versionFile, '0.2.2-rc.1')
    const again = await owner.json<{ agents: AgentSettings[] }>('agents')
    expect(again.agents.find(agent => agent.id === 'dsh')?.detected.outdated).toBeUndefined()
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')?.status).toBe('ready')
  })
})

describe('an agent that never answers its handshake', () => {
  it('fails the session within the bound, with a Host-defined reason', async () => {
    const t: TestHost = await startTestHost({
      agentPlugin: agent => createAcpAgentPlugin(agent, { handshakeTimeoutMs: 500, stopGraceMs: 200, log: () => {} }),
    })
    cleanups.push(() => t.close())
    const owner = await t.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'stuck', name: 'Stuck', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_INIT_SILENT: '1' } },
    })
    const began = Date.now()
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { harnessId: 'stuck', prompt: 'hello', requestId: randomUUID() },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 5_000 }).toBe('failed')
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(systemText(await owner.json<TaskDetail>(`tasks/${sessionId}`))).toContain(
      'Stuck 1 秒内没有完成启动握手（initialize），已停止它。',
    )
  })
})

describe('pi 1.5', () => {
  it('runs a session as it answers: an event before the first answer, and answers out of order', async () => {
    const t: TestHost = await startTestHost()
    cleanups.push(() => t.close())
    const owner = await t.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'pi', name: 'pi', presetId: 'pi', command: process.execPath, args: [FAKE_PI_AGENT], env: { FAKE_PI_SHAPE: '1.5' } },
    })
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { harnessId: 'pi', prompt: 'say hello', requestId: randomUUID() },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.some(message => message.role === 'assistant' && message.text.length > 0)).toBe(true)
  })
})

describe('Codex chosen from a draft', () => {
  async function codexHost(programs: Record<string, string>) {
    const root = await directory()
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const [name, body] of Object.entries(programs)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`)
      await chmod(join(bin, name), 0o755)
    }
    const t: TestHost = await startTestHost({
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      commandDirectories: () => [bin],
    })
    cleanups.push(() => t.close())
    return t.enroll({ listener: 'unix' })
  }
  const body = { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} }
  const acp = `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`

  it('is saved on Codex itself when it is new enough', async () => {
    const owner = await codexHost({ codex: `[ "$1" = --version ] && { echo 'codex-cli 0.167.0'; exit 0; }\n${acp}`, 'codex-acp': acp })
    const saved = await owner.confirmedJson<{ agent: AgentSettings }>('agents', { method: 'POST', body })
    expect(saved.agent).toMatchObject({ command: 'codex', args: [], verified: true })
  })

  it('is refused when Codex is too old, even with its adapter installed: the adapter would run that same Codex', async () => {
    const owner = await codexHost({ codex: `[ "$1" = --version ] && { echo 'codex-cli 0.150.0'; exit 0; }\n${acp}`, 'codex-acp': acp })
    const refused = await owner.confirmed('agents', { method: 'POST', body })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'harness-version-unsupported' })
    expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toEqual([])
  })

  it('is saved on its adapter only when Codex is not installed, and the list says what the adapter runs', async () => {
    const owner = await codexHost({ 'codex-acp': acp })
    const listed = await owner.json<{ presets: Array<{ id: string; command: string; description: string }> }>('agents')
    expect(listed.presets.find(preset => preset.id === 'codex')).toMatchObject({
      command: 'codex-acp',
      description: '经适配器 codex-acp 运行它自带的 Codex；模型、登录与沙箱由 Codex 自身配置。',
    })
    expect((await owner.confirmedJson<{ agent: AgentSettings }>('agents', { method: 'POST', body })).agent).toMatchObject({
      command: 'codex-acp',
      verified: true,
    })
  })

  it('stays Codex itself, to install, when neither is installed', async () => {
    const owner = await codexHost({})
    const listed = await owner.json<{ presets: Array<{ id: string; command: string; install?: string; detected?: unknown }> }>('agents')
    expect(listed.presets.find(preset => preset.id === 'codex')).toMatchObject({
      command: 'codex',
      install: 'npm i -g @openai/codex',
      detected: { found: false },
    })
    const saved = (await owner.confirmedJson<{ agent: AgentSettings }>('agents', { method: 'POST', body })).agent
    expect(saved).toMatchObject({ command: 'codex' })
    const harness = (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'codex')
    expect(harness).toMatchObject({ status: 'unavailable', statusMessage: '未找到命令 codex。安装：npm i -g @openai/codex' })
  })

  it('is refused when Codex is too old and no adapter is installed', async () => {
    const owner = await codexHost({ codex: `[ "$1" = --version ] && { echo 'codex-cli 0.150.0'; exit 0; }\n${acp}` })
    const refused = await owner.confirmed('agents', { method: 'POST', body })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: 'harness-version-unsupported',
      message: 'Codex 需要 0.156.0 或更高版本（当前 0.150.0）。升级：npm i -g @openai/codex@latest',
    })
  })
})
