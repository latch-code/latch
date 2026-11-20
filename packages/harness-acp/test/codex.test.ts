// Codex over its own app-server (`wires/codex.ts`), driven against the fake app-server: no network, no model.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SESSION_SKILLS_BYTES, readSessionSkills, type DriverTaskDetail } from '@latch/protocol'
import type {
  Bridge,
  HarnessDriver,
  HarnessHostOptions,
  HarnessPlugin,
  HarnessSecurityEvent,
  HostProject,
  ModelGateway,
  ServiceDeclaration,
  ToolGateway,
} from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, startFakeModels } from '@latch/testkit'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  presetRoute,
  resolveCommand,
  selectProfile,
  setCommandSearch,
  setLoginPrograms,
  withHarnessPromptSource,
  type AcpAgentOptions,
  type AgentRecord,
} from '../src/index.ts'
import { CodexWire, codexMcpServer, codexVersion, setCodexStopLimits } from '../src/wires/codex.ts'
import { codexOptions, gatewayEffortOption } from '../src/codex-models.ts'
import { configFromOptions } from '../src/mapping.ts'
import { MCP_STATUS_METHOD } from '../src/protocol.ts'
import { IMAGE_NOT_MADE, settleToolMessage } from '../src/mapping.ts'
import { RequestTimeout, setProcessLister } from '../src/wires/process.ts'
import { cliTree, seedCliFiles } from './helpers/cli-config.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 2_000, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})

let requests = 0
const rid = () => `codex-${++requests}`

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

interface LogEntry {
  pid: number
  argv?: string[]
  answer?: { decision?: string } & Record<string, unknown>
  event: string
  method?: string | null
  params?: Record<string, unknown>
  result?: unknown
}

/** A computer whose only `codex` is the fake app-server, found as the start script finds programs. */
async function computer(
  env: Record<string, string> = {},
  extra: string[] = [],
  options: AcpAgentOptions = {},
  host: Pick<HarnessHostOptions, 'toolGateway' | 'modelGateway' | 'saveAttachment'> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const main = join(root, 'main')
  const docs = join(root, 'docs')
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(bin)
  await mkdir(main)
  await mkdir(docs)
  await mkdir(tmpRoot, { mode: 0o700 })
  const logFile = join(root, 'codex.log')
  const exports = Object.entries({
    FAKE_ACP_LOG: logFile,
    FAKE_CODEX_STATE: join(root, 'threads.json'),
    FAKE_CODEX_IMAGE_DIR: join(root, 'codex-home', 'generated_images'),
    ...env,
  })
    .map(([name, value]) => `export ${name}='${value}'`)
    .join('\n')
  await writeFile(join(bin, 'codex'), `#!/bin/sh\n${exports}\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(join(bin, 'codex'), 0o755)
  for (const name of extra) {
    await writeFile(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`)
    await chmod(join(bin, name), 0o755)
  }
  setCommandSearch(() => [bin])
  setLoginPrograms(resolveCommand)
  forgetCommandLookups()
  const record: AgentRecord = { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {}, enabled: true }
  const projects: HostProject[] = [
    {
      id: 'proj',
      folders: [
        { id: 'app', path: main },
        { id: 'docs', path: docs },
      ],
    },
  ]
  const driver = await activate(createAcpAgentPlugin(record, { ...FAST, ...options }))
  const events: HarnessSecurityEvent[] = []
  const open = async (): Promise<Bridge> => {
    const bridge = driver.create({
      ...host,
      dataDir,
      workspaceRoot: main,
      tmpRoot,
      workspaces: () => [main],
      projects: () => structuredClone(projects),
      providerId: 'unused',
      registry: {
        acquire() {
          throw new Error('unused')
        },
      },
      securityEvent: event => void events.push(event),
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    return bridge
  }
  const log = async (): Promise<LogEntry[]> =>
    (await readFile(logFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as LogEntry)
  return { root, bin, main, docs, record, driver, open, log, events }
}

async function start(bridge: Bridge, cwd: string, prompt: string, folders?: HostProject['folders']): Promise<string> {
  const where = folders ? { workspaceId: 'proj', folders } : {}
  const { launchHash } = await bridge.launchPreview!({ cwd, ...where })
  return (await bridge.createTask({ prompt, requestId: rid(), cwd, ...where, expectedLaunchHash: launchHash })).sessionId
}

async function until(bridge: Bridge, id: string, predicate: (detail: DriverTaskDetail) => boolean): Promise<DriverTaskDetail> {
  await vi.waitFor(async () => expect(predicate(await bridge.detail(id))).toBe(true), { timeout: 8_000, interval: 10 })
  return bridge.detail(id)
}
const settled = (bridge: Bridge, id: string) =>
  until(bridge, id, detail => detail.summary.status !== 'running' && detail.summary.status !== 'waiting-approval')
const said = (detail: DriverTaskDetail, role: string) =>
  detail.messages
    .filter(message => message.role === role)
    .map(message => message.text)
    .join('\n')
const sent = (log: LogEntry[], method: string) => log.filter(entry => entry.event === 'recv' && entry.method === method)

describe('Codex over its app-server', () => {
  it.skipIf(process.platform === 'win32')('keeps original CLI configuration out of thread startup, turn changes and recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'latch-codex-cli-config-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    await seedCliFiles(home, {
      '.codex/config.toml': 'model = "gpt-fake"\nmodel_reasoning_effort = "high"\n',
      '.codex/hooks.json': '{}\n',
      '.zshrc': '# fixture shell configuration\n',
      'Library/LaunchAgents/fixture.plist': '<plist version="1.0"><dict/></plist>\n',
    })
    const t = await computer({ HOME: home, CODEX_HOME: join(home, '.codex'), FAKE_CODEX_PERSIST_START_TRUST: '1' })
    await seedCliFiles(t.main, {
      '.codex/config.toml': '# fixture project configuration\n',
      '.codex/hooks.json': '{}\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/hooks/pre-commit': '# fixture hook configuration\n',
    })
    const before = await Promise.all([cliTree(home), cliTree(t.main), cliTree(t.bin)])
    let bridge = await t.open()
    const config = [{ configId: 'mode', value: 'workspace-write' }]
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main, config })
    const { sessionId } = await bridge.createTask({
      prompt: 'echo first',
      requestId: rid(),
      cwd: t.main,
      config,
      expectedLaunchHash: launchHash,
    })
    const started = await settled(bridge, sessionId)
    expect(started.summary.status).toBe('idle')
    expect(started.permission?.expectedMode).toBe('workspace-write')
    expect(await Promise.all([cliTree(home), cliTree(t.main), cliTree(t.bin)])).toEqual(before)

    await bridge.setConfig!(sessionId, 'model', 'gpt-fake-mini')
    const thinking = (await bridge.detail(sessionId)).config?.find(option => option.category === 'thought_level')
    expect(thinking?.options.map(option => option.value)).toContain('medium')
    await bridge.setConfig!(sessionId, thinking!.id, 'medium')
    await bridge.setConfig!(sessionId, 'mode', 'read-only')
    await bridge.prompt(sessionId, 'fail deliberately', rid())
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    expect(await Promise.all([cliTree(home), cliTree(t.main), cliTree(t.bin)])).toEqual(before)
    await bridge.close()

    bridge = await t.open()
    await bridge.prompt(sessionId, 'echo recovered', rid())
    const resumed = await settled(bridge, sessionId)
    expect(resumed.summary.status).toBe('idle')
    expect(resumed.config?.find(option => option.category === 'model')?.currentValue).toBe('gpt-fake-mini')
    expect(resumed.config?.find(option => option.category === 'thought_level')?.currentValue).toBe('medium')
    expect(resumed.permission?.expectedMode).toBe('read-only')
    await bridge.close()

    const trace = await t.log()
    expect(sent(trace, 'thread/start').map(entry => entry.params?.sandbox)).toEqual(['read-only'])
    expect(sent(trace, 'thread/resume').map(entry => entry.params?.sandbox)).toEqual(['read-only'])
    expect(sent(trace, 'turn/start').map(entry => (entry.params?.sandboxPolicy as { type: string }).type)).toEqual([
      'workspaceWrite',
      'readOnly',
      'readOnly',
    ])
    expect(sent(trace, 'config/value/write')).toHaveLength(0)
    expect(sent(trace, 'config/batchWrite')).toHaveLength(0)
    expect((await stat(join(t.root, 'data', 'acp.json'))).mode & 0o777).toBe(0o600)
    expect(await Promise.all([cliTree(home), cliTree(t.main), cliTree(t.bin)])).toEqual(before)
  })

  it('publishes only public skills and sends a native skill item from proven current user text and the official directory', async () => {
    const privatePath = '/private/official-skill-directory/public-work/SKILL.md'
    const fixture = await computer({
      FAKE_CODEX_SKILLS: JSON.stringify([
        { name: 'public-work', description: 'Public work', path: privatePath, scope: 'repo', enabled: true, pluginId: null },
        {
          name: 'disabled-work',
          description: 'Disabled',
          path: '/private/disabled/SKILL.md',
          scope: 'user',
          enabled: false,
          pluginId: null,
        },
      ]),
    })
    const bridge = await fixture.open()
    const requestId = rid()
    const prompt = 'hello $public-work'
    const { launchHash } = await bridge.launchPreview!({ cwd: fixture.main })
    const { sessionId } = await withHarnessPromptSource({ method: 'create', requestId, text: prompt }, () =>
      bridge.createTask({ prompt, requestId, cwd: fixture.main, expectedLaunchHash: launchHash }),
    )
    const detail = await until(bridge, sessionId, value => value.summary.status === 'idle')
    expect(detail.skills).toEqual([{ name: 'public-work', description: 'Public work', invocation: '$public-work', scope: 'project' }])
    expect(detail.commands?.map(command => command.name)).toEqual(['compact'])
    expect(JSON.stringify(detail)).not.toContain(privatePath)
    const log = await fixture.log()
    expect(log.filter(row => row.method === 'skills/list').map(row => row.params)).toEqual([{ cwds: [fixture.main], forceReload: true }])
    expect(log.find(row => row.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: prompt, text_elements: [] },
      { type: 'skill', name: 'public-work', path: privatePath },
    ])
    await vi.waitFor(async () => expect((await bridge.commandCatalogue?.({ cwd: fixture.main }))?.catalogue.skills).toEqual(detail.skills))
    await bridge.close()
    const restored = await fixture.open()
    expect((await restored.detail(sessionId)).skills).toEqual(detail.skills)
    expect((await restored.commandCatalogue?.({ cwd: fixture.main }))?.catalogue.skills).toEqual(detail.skills)
  })

  it('never selects a disabled, prefixed, quoted, escaped or unproven skill name', async () => {
    const fixture = await computer({
      FAKE_CODEX_SKILLS: JSON.stringify([
        { name: 'known', description: 'Known', path: '/private/known/SKILL.md', scope: 'user', enabled: true },
        { name: 'twice', description: 'A', path: '/private/a/SKILL.md', scope: 'repo', enabled: true },
        { name: 'twice', description: 'B', path: '/private/b/SKILL.md', scope: 'user', enabled: true },
        { name: 'off', description: 'Off', path: '/private/off/SKILL.md', scope: 'user', enabled: false },
      ]),
    })
    const bridge = await fixture.open()
    const { launchHash } = await bridge.launchPreview!({ cwd: fixture.main })
    const requestId = rid()
    const prompt = 'hello $off $known-extra `$known` \\$known $unknown'
    const { sessionId } = await withHarnessPromptSource({ method: 'create', requestId, text: prompt }, () =>
      bridge.createTask({ prompt, requestId, cwd: fixture.main, expectedLaunchHash: launchHash }),
    )
    const detail = await until(bridge, sessionId, value => value.summary.status === 'idle')
    expect(detail.skills?.map(skill => skill.invocation)).toEqual(['$known'])
    expect((await fixture.log()).find(row => row.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: prompt, text_elements: [] },
    ])
    await bridge.prompt(sessionId, 'hello $known', rid())
    await until(bridge, sessionId, value => value.summary.status === 'idle')
    expect((await fixture.log()).filter(row => row.method === 'turn/start').at(-1)?.params?.input).toEqual([
      { type: 'text', text: 'hello $known', text_elements: [] },
    ])
    const next = rid()
    await withHarnessPromptSource({ method: 'prompt', sessionId, requestId: next, text: 'hello $known $known' }, () =>
      bridge.prompt(sessionId, 'hello $known $known', next),
    )
    await until(bridge, sessionId, value => value.summary.status === 'idle')
    expect((await fixture.log()).filter(row => row.method === 'turn/start').at(-1)?.params?.input).toEqual([
      { type: 'text', text: 'hello $known $known', text_elements: [] },
      { type: 'skill', name: 'known', path: '/private/known/SKILL.md' },
    ])
  })

  it('rejects an explicitly named ambiguous skill before sending any model input', async () => {
    const fixture = await computer({
      FAKE_CODEX_SKILLS: JSON.stringify([
        { name: 'twice', path: '/private/a/SKILL.md', scope: 'repo', enabled: true },
        { name: 'twice', path: '/private/b/SKILL.md', scope: 'user', enabled: true },
      ]),
    })
    const bridge = await fixture.open()
    const requestId = rid()
    const prompt = 'hello $twice'
    const { launchHash } = await bridge.launchPreview!({ cwd: fixture.main })
    const { sessionId } = await withHarnessPromptSource({ method: 'create', requestId, text: prompt }, () =>
      bridge.createTask({ prompt, requestId, cwd: fixture.main, expectedLaunchHash: launchHash }),
    )
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('技能名称不唯一')
    expect((await fixture.log()).filter(row => row.method === 'turn/start')).toEqual([])
    expect(JSON.stringify(detail)).not.toContain('/private/a/')
    expect(JSON.stringify(detail)).not.toContain('/private/b/')
  })

  it('clears private paths and public suggestions on changed or failed skill reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-skill-reports-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'skills.json')
    await writeFile(
      file,
      JSON.stringify([{ name: 'known', description: 'Known', path: '/private/old/SKILL.md', scope: 'user', enabled: true }]),
    )
    const fixture = await computer({ FAKE_CODEX_SKILLS_FILE: file })
    const bridge = await fixture.open()
    const sessionId = await start(bridge, fixture.main, 'hello')
    await until(bridge, sessionId, value => value.summary.status === 'idle')
    expect((await bridge.detail(sessionId)).skills?.map(skill => skill.name)).toEqual(['known'])
    for (const report of [[], { error: true }]) {
      await writeFile(file, JSON.stringify(report))
      await bridge.prompt(sessionId, 'skills-changed', rid())
      await until(bridge, sessionId, value => value.summary.status === 'idle')
      await vi.waitFor(async () => expect((await bridge.detail(sessionId)).skills).toEqual(Array.isArray(report) ? [] : undefined))
      const requestId = rid()
      await withHarnessPromptSource({ method: 'prompt', sessionId, requestId, text: 'hello $known' }, () =>
        bridge.prompt(sessionId, 'hello $known', requestId),
      )
      await until(bridge, sessionId, value => value.summary.status === 'idle')
      expect((await fixture.log()).filter(row => row.method === 'turn/start').at(-1)?.params?.input).toEqual([
        { type: 'text', text: 'hello $known', text_elements: [] },
      ])
      expect(JSON.stringify(await bridge.detail(sessionId))).not.toContain('/private/old/SKILL.md')
      expect(JSON.stringify(await bridge.detail(sessionId))).not.toContain('/private/catalogue-error')
    }
  })

  it('rejects ambiguous skill steering instead of converting the local refusal into a new prompt', async () => {
    const fixture = await computer({
      FAKE_CODEX_SKILLS: JSON.stringify([
        { name: 'twice', path: '/private/a/SKILL.md', scope: 'repo', enabled: true },
        { name: 'twice', path: '/private/b/SKILL.md', scope: 'user', enabled: true },
      ]),
    })
    const bridge = await fixture.open()
    const sessionId = await start(bridge, fixture.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await fixture.log(), 'turn/start')).toHaveLength(1), { timeout: 8_000 })
    const requestId = rid()
    await expect(
      withHarnessPromptSource({ method: 'steer', sessionId, requestId, text: 'hello $twice' }, () =>
        bridge.steer!(sessionId, 'hello $twice', requestId),
      ),
    ).rejects.toThrow('没有接受这条追加')
    expect(sent(await fixture.log(), 'turn/steer')).toEqual([])
    expect(sent(await fixture.log(), 'turn/start')).toHaveLength(1)
    await bridge.cancel(sessionId)
    await settled(bridge, sessionId)
  })

  it('invalidates paths before a delayed directory read and discards it after another changed notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-skill-refresh-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'skills.json')
    const release = join(root, 'release')
    const row = (name: string) => ({ name, path: `/private/${name}/SKILL.md`, scope: 'user', enabled: true })
    await writeFile(file, JSON.stringify([row('old')]))
    const fixture = await computer({ FAKE_CODEX_SKILLS_FILE: file })
    const bridge = await fixture.open()
    const sessionId = await start(bridge, fixture.main, 'hello')
    await settled(bridge, sessionId)
    expect((await bridge.detail(sessionId)).skills?.map(skill => skill.name)).toEqual(['old'])
    try {
      await writeFile(file, JSON.stringify({ skills: [row('stale')], waitFor: release }))
      await bridge.prompt(sessionId, 'skills-changed', rid())
      await settled(bridge, sessionId)
      await vi.waitFor(async () => expect((await fixture.log()).filter(row => row.method === 'skills/list')).toHaveLength(2))
      expect((await bridge.detail(sessionId)).skills).toBeUndefined()
      const requestId = rid()
      await withHarnessPromptSource({ method: 'prompt', sessionId, requestId, text: 'hello $old' }, () =>
        bridge.prompt(sessionId, 'hello $old', requestId),
      )
      await settled(bridge, sessionId)
      expect((await fixture.log()).filter(row => row.method === 'turn/start').at(-1)?.params?.input).toEqual([
        { type: 'text', text: 'hello $old', text_elements: [] },
      ])
      await writeFile(file, JSON.stringify([row('fresh')]))
      await bridge.prompt(sessionId, 'skills-changed', rid())
      await settled(bridge, sessionId)
      await writeFile(release, '')
      await vi.waitFor(async () => expect((await bridge.detail(sessionId)).skills?.map(skill => skill.name)).toEqual(['fresh']))
      expect((await fixture.log()).filter(row => row.method === 'skills/list')).toHaveLength(3)
      const next = rid()
      await withHarnessPromptSource({ method: 'prompt', sessionId, requestId: next, text: 'hello $fresh $old $stale' }, () =>
        bridge.prompt(sessionId, 'hello $fresh $old $stale', next),
      )
      await settled(bridge, sessionId)
      expect((await fixture.log()).filter(row => row.method === 'turn/start').at(-1)?.params?.input).toEqual([
        { type: 'text', text: 'hello $fresh $old $stale', text_elements: [] },
        { type: 'skill', name: 'fresh', path: '/private/fresh/SKILL.md' },
      ])
    } finally {
      await writeFile(release, '')
    }
  })

  it.each(['long-descriptions', 'unicode-names', 'count'] as const)(
    'bounds %s in UTF-8 without using the public cutoff for native lookup',
    async kind => {
      const root = await mkdtemp(join(tmpdir(), 'latch-skills-budget-'))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const file = join(root, 'skills.json')
      const rows = Array.from({ length: kind === 'count' ? 205 : 200 }, (_, index) => ({
        name: kind === 'unicode-names' ? `${'界'.repeat(90)}${index}` : `public-${index}`,
        description: kind === 'long-descriptions' ? '界'.repeat(1000) : '',
        path: `/private/official-budget/${index}/SKILL.md`,
        scope: 'repo',
        enabled: true,
      }))
      await writeFile(file, JSON.stringify(rows))
      const fixture = await computer({ FAKE_CODEX_SKILLS_FILE: file })
      const bridge = await fixture.open()
      const requestId = rid()
      const prompt = `hello $${rows.at(-1)!.name}`
      const { launchHash } = await bridge.launchPreview!({ cwd: fixture.main })
      const { sessionId } = await withHarnessPromptSource({ method: 'create', requestId, text: prompt }, () =>
        bridge.createTask({ prompt, requestId, cwd: fixture.main, expectedLaunchHash: launchHash }),
      )
      const detail = await until(bridge, sessionId, value => value.summary.status === 'idle')
      expect(readSessionSkills(detail.skills)).toEqual(detail.skills)
      const publicData = { skills: detail.skills, ...(detail.skillsTruncated ? { skillsTruncated: true } : {}) }
      expect(Buffer.byteLength(JSON.stringify(publicData))).toBeLessThanOrEqual(MAX_SESSION_SKILLS_BYTES)
      expect(JSON.stringify(publicData)).not.toContain('/private/official-budget/')
      if (kind === 'long-descriptions') {
        expect(detail.skills).toHaveLength(200)
        expect(detail.skills?.at(-1)?.name).toBe(rows.at(-1)!.name)
        expect(detail.skills?.some(skill => skill.description === undefined)).toBe(true)
        expect(detail.skillsTruncated).toBeUndefined()
      } else {
        expect(detail.skillsTruncated).toBe(true)
        expect(detail.skills!.length).toBeLessThan(rows.length)
      }
      const sent = (await fixture.log()).find(row => row.method === 'turn/start')?.params?.input as Array<Record<string, unknown>>
      expect(sent.filter(item => item.type === 'skill')).toEqual([{ type: 'skill', name: rows.at(-1)!.name, path: rows.at(-1)!.path }])
      await vi.waitFor(async () => expect((await bridge.commandCatalogue?.({ cwd: fixture.main }))?.catalogue).toMatchObject(publicData))
      await bridge.close()
      const restored = await fixture.open()
      expect((await restored.detail(sessionId)).skillsTruncated).toBe(detail.skillsTruncated)
      expect((await restored.commandCatalogue?.({ cwd: fixture.main }))?.catalogue).toMatchObject(publicData)
    },
  )

  it('keeps gateway thinking fixed for the active turn and applies high or default only to its successor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-thinking-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const logFile = join(root, 'codex.jsonl')
    const setThinking = vi.fn<(model: string, effort: string | null) => void>()
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      { request: async () => ({ outcome: { outcome: 'cancelled' } }), notification: () => {}, exit: () => {} },
      { model: 'service-model', models: ['service-model'], modelCapabilities: { 'service-model': { thinking: ['high'] } }, setThinking },
    )
    cleanups.push(async () => {
      await wire.stop('kill', 100)
    })
    const turns = async () =>
      sent(
        (await readFile(logFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as LogEntry),
        'turn/start',
      )
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as {
      sessionId: string
      configOptions: Array<{ id: string; currentValue: string; options: Array<{ value: string }> }>
    }
    expect(opened.configOptions.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: '~default',
      options: [{ value: '~default' }, { value: 'high' }],
    })
    const prompt = (text: string) =>
      wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text }] }, 5_000)
    const choose = (value: string) =>
      wire.request('session/set_config_option', { sessionId: opened.sessionId, configId: 'reasoning_effort', value }, 5_000)
    const first = prompt('sleep first').catch(error => error)
    await vi.waitFor(async () => expect(await turns()).toHaveLength(1))
    expect(setThinking).toHaveBeenLastCalledWith('service-model', null)
    const beforeHigh = setThinking.mock.calls.length
    await choose('high')
    expect(setThinking).toHaveBeenCalledTimes(beforeHigh)
    wire.notify('session/cancel')
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })

    const second = prompt('sleep second').catch(error => error)
    await vi.waitFor(async () => expect(await turns()).toHaveLength(2))
    expect(setThinking).toHaveBeenLastCalledWith('service-model', 'high')
    expect((await turns())[1]?.params).toHaveProperty('effort', 'high')
    const beforeDefault = setThinking.mock.calls.length
    await choose('~default')
    expect(setThinking).toHaveBeenCalledTimes(beforeDefault)
    wire.notify('session/cancel')
    await expect(second).resolves.toMatchObject({ stopReason: 'cancelled' })

    await expect(prompt('echo third')).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(setThinking).toHaveBeenLastCalledWith('service-model', null)
    expect(setThinking).toHaveBeenCalledTimes(beforeDefault + 1)
  })

  describe('thinking on a service model, known before the start', () => {
    const capabilities = { 'fake-model': { thinking: ['low', 'high'] } }
    /** The Host's gateway, standing in: the fake service itself, with the levels the service declared. */
    async function onService() {
      const models = await startFakeModels({ replies: [{ text: 'from the service' }] })
      cleanups.push(() => models.close())
      const thinking: Array<[string, string | null]> = []
      const gateway: ModelGateway = {
        open() {
          let closed = false
          return {
            baseURL: `${models.origin}/v1`,
            token: `lmg1.${'t'.repeat(43)}`,
            requests: () => models.requests.length,
            takeTurn: () => ({ requests: 0, models: [] }),
            models: ['fake-model'],
            modelCapabilities: capabilities,
            setThinking: (model, effort) => void thinking.push([model, effort]),
            active: () => !closed,
            close: () => {
              closed = true
            },
          }
        },
      }
      const t = await computer({}, [], {}, { modelGateway: gateway })
      const route = { providerId: 'svc', model: 'fake-model', wire: 'responses' as const, origin: models.origin }
      const service: ServiceDeclaration = {
        providerId: 'svc',
        entry: 'responses',
        upstream: 'responses',
        models: ['fake-model', 'plain'],
        modelCapabilities: capabilities,
      }
      return { t, models, thinking, route, service }
    }

    it('projects to a draft the option the session then offers, and the picked level reaches the service', async () => {
      const { t, models, thinking, route, service } = await onService()
      const bridge = await t.open()
      // Declared levels: 默认 and each; a model with none declared has nothing to project.
      const projected = bridge.serviceOptions!([service])
      expect(projected).toEqual([
        { providerId: 'svc', model: 'fake-model', options: [gatewayEffortOption(['low', 'high'])], source: 'declared' },
      ])
      // Not over a protocol on which the gateway does not set Codex's thinking.
      expect(bridge.serviceOptions!([{ ...service, entry: 'chat-completions' }])).toEqual([])
      const { sessionId } = await bridge.createTask({
        prompt: 'echo hi',
        requestId: rid(),
        cwd: t.main,
        modelRoute: route,
        expectedLaunchHash: (await bridge.launchPreview!({ cwd: t.main, modelRoute: route })).launchHash,
        config: [{ configId: 'reasoning_effort', value: 'high' }],
      })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      // The same option, ID and values, as the session reports it.
      const { currentValue, ...offered } = detail.config!.find(option => option.id === 'reasoning_effort')!
      const { currentValue: _default, ...draft } = projected[0]!.options[0]!
      expect(offered).toEqual(draft)
      expect(currentValue).toBe('high')
      expect(thinking.at(-1)).toEqual(['fake-model', 'high'])
      expect(models.requests.at(-1)?.body).toMatchObject({ reasoning: { effort: 'high' } })
    })

    it('refuses a level the service no longer declares, naming it, and sends no prompt', async () => {
      const { t, models, route } = await onService()
      const bridge = await t.open()
      const { sessionId } = await bridge.createTask({
        prompt: 'echo hi',
        requestId: rid(),
        cwd: t.main,
        modelRoute: route,
        expectedLaunchHash: (await bridge.launchPreview!({ cwd: t.main, modelRoute: route })).launchHash,
        config: [{ configId: 'reasoning_effort', value: 'xhigh' }],
      })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('failed')
      expect(said(detail, 'system')).toContain('Codex 现在没有思考档位「xhigh」，这条消息没有发出。')
      expect(detail.messages.find(message => message.role === 'user')?.text).toBe('echo hi')
      expect(sent(await t.log(), 'turn/start')).toEqual([])
      expect(models.requests).toEqual([])
    })
  })

  it('is the preset’s route for `codex`, and the adapter only for any other command', () => {
    expect(selectProfile({ id: 'c', name: 'C', presetId: 'codex', command: 'codex', args: [], env: {}, enabled: true }).profile?.wire).toBe(
      'codex',
    )
    const adapter = selectProfile({ id: 'c', name: 'C', presetId: 'codex', command: 'codex-acp', args: [], env: {}, enabled: true })
    expect(adapter.profile?.wire).toBeUndefined()
    expect(adapter.verified).toBe(true)
    expect(codexVersion('latch/0.167.0 (Mac OS 27.3.0; arm64) unknown (latch; 0.1.0)')).toBe('0.167.0')
  })

  it('streams a reply in pieces, with the read-only mode’s approval policy and sandbox on the turn', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo hello there')
    const detail = await settled(bridge, id)
    expect(detail.summary.status).toBe('idle')
    expect(said(detail, 'assistant')).toBe('echo: echo hello there')
    const log = await t.log()
    expect(log.find(entry => entry.event === 'start')?.argv).toEqual(['app-server'])
    expect(sent(log, 'thread/start')[0]!.params).toMatchObject({
      cwd: t.main,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      approvalsReviewer: 'user',
    })
    expect(sent(log, 'turn/start')[0]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: 'echo hello there' }],
    })
    expect(detail.config?.find(option => option.category === 'mode')?.currentValue).toBe('read-only')
    expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe('gpt-fake')
  })

  describe('its image tool', () => {
    const picture = (n = 0) =>
      ({
        id: `abcdefghijklmnopqrstu${n}`,
        name: 'Agent-image.png',
        mime: 'image/png',
        kind: 'image',
        size: 1,
        sha256: 'b'.repeat(64),
      }) as const
    async function imaging(how: string, save?: (input: { sessionId: string; mime: string; data: string }) => Promise<unknown>) {
      const saved: Array<{ sessionId: string; mime: string; data: string }> = []
      const t = await computer(
        {},
        [],
        {},
        {
          saveAttachment: async input => {
            saved.push(input)
            await save?.(input)
            return picture(saved.length - 1)
          },
        },
      )
      const bridge = await t.open()
      const id = await start(bridge, t.main, `image ${how}`)
      const detail = await settled(bridge, id)
      const rows = detail.messages.filter(message => message.role === 'tool' && message.tool?.imageGeneration)
      return { t, bridge, id, detail, saved, rows, row: rows[0], log: await t.log() }
    }
    const png = (data: string) =>
      Buffer.from(data, 'base64')
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    /** No reply message carries a picture: the picture is the image tool's row. */
    const noReplyPicture = (detail: DriverTaskDetail) =>
      expect(detail.messages.filter(message => message.role !== 'tool' && message.attachments?.length)).toEqual([])

    it('keeps the picture in the item’s result on the image tool’s row, which was its place while it ran', async () => {
      const { detail, saved, row, rows, log } = await imaging('result')
      expect(detail.summary.status).toBe('idle')
      expect(saved).toHaveLength(1)
      expect(saved[0]!.mime).toBe('image/png')
      expect(png(saved[0]!.data)).toBe(true)
      expect(rows).toHaveLength(1)
      expect(row).toMatchObject({ state: 'completed', attachments: [picture(0)], tool: { title: '生成图片', imageGeneration: true } })
      // The bytes are the attachment's alone: never the row's text or output.
      expect(JSON.stringify(row)).not.toContain(saved[0]!.data.slice(0, 64))
      noReplyPicture(detail)
      // The bytes were in the item: Codex is not asked to read anything.
      expect(sent(log, 'fs/readFile')).toHaveLength(0)
    })

    it('holds the row running until its picture is kept, then settles it with the picture', async () => {
      let release!: () => void
      const held = new Promise<void>(resolve => (release = resolve))
      let saving = false
      const t = await computer(
        {},
        [],
        {},
        {
          saveAttachment: async () => {
            saving = true
            await held
            return picture(0)
          },
        },
      )
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'image result')
      await vi.waitFor(() => expect(saving).toBe(true), { timeout: 8_000, interval: 10 })
      const during = (await bridge.detail(id)).messages.find(message => message.tool?.imageGeneration)
      expect(during).toMatchObject({ state: 'running', tool: { imageGeneration: true } })
      expect(during?.attachments).toBeUndefined()
      release()
      const detail = await settled(bridge, id)
      expect(detail.messages.find(message => message.tool?.imageGeneration)).toMatchObject({
        state: 'completed',
        attachments: [picture(0)],
      })
    })

    it('asks Codex itself for a picture it only saved, through fs/readFile on the path it reported', async () => {
      const { detail, saved, row, log } = await imaging('saved')
      const reads = sent(log, 'fs/readFile')
      expect(reads).toHaveLength(1)
      expect(String(reads[0]!.params?.path)).toMatch(/\/generated_images\/thread-[^/]+\/ig_[^/]+\.png$/u)
      expect(saved).toHaveLength(1)
      expect(png(saved[0]!.data)).toBe(true)
      // The turn waited for the read: the picture is on its row in this turn, before its reply settled.
      expect(row).toMatchObject({ state: 'completed', attachments: [picture(0)] })
      noReplyPicture(detail)
    })

    it('keeps each of two pictures of one turn on its own row, in order', async () => {
      const { detail, saved, rows } = await imaging('two')
      expect(saved).toHaveLength(2)
      expect(rows.map(row => [row.state, row.attachments])).toEqual([
        ['completed', [picture(0)]],
        ['completed', [picture(1)]],
      ])
      expect(new Set(rows.map(row => row.id)).size).toBe(2)
      noReplyPicture(detail)
    })

    it('keeps the picture on its row when the session is read again and goes on in a new process', async () => {
      const { t, bridge, id, row } = await imaging('result')
      await bridge.close()
      const again = await t.open()
      const reread = await again.detail(id)
      expect(reread.messages.find(message => message.id === row!.id)).toMatchObject({
        state: 'completed',
        attachments: [picture(0)],
        tool: { imageGeneration: true },
      })
      await again.prompt(id, 'echo after', rid())
      const resumed = await settled(again, id)
      expect(resumed.messages.find(message => message.id === row!.id)).toMatchObject({
        attachments: [picture(0)],
        tool: { imageGeneration: true },
      })
      expect(resumed.messages.filter(message => message.tool?.imageGeneration)).toHaveLength(1)
    })

    it('passes on a GIF, as Codex 0.170 may make one, with its own type', async () => {
      const { detail, saved } = await imaging('gif')
      expect(detail.summary.status).toBe('idle')
      expect(saved).toHaveLength(1)
      expect(saved[0]!.mime).toBe('image/gif')
      expect(Buffer.from(saved[0]!.data, 'base64').toString('latin1', 0, 6)).toBe('GIF89a')
    })

    it('shows a failed generation as a failed row with a short line, and keeps nothing', async () => {
      const { detail, saved, row } = await imaging('failed')
      expect(detail.summary.status).toBe('idle')
      expect(saved).toHaveLength(0)
      expect(row).toMatchObject({ state: 'failed', tool: { imageGeneration: true } })
      expect(row?.attachments).toBeUndefined()
      expect(JSON.stringify(row?.tool)).toContain('图片生成失败：已达用量上限')
    })

    it('says so on the row when the Host cannot keep the picture', async () => {
      const { saved, row, detail } = await imaging('result', async () => {
        throw new Error('store unavailable')
      })
      expect(saved).toHaveLength(1)
      expect(row).toMatchObject({ state: 'completed', tool: { imageGeneration: true } })
      expect(row?.attachments).toBeUndefined()
      expect(row?.tool?.output).toContain('图片未保存')
      noReplyPicture(detail)
    })

    it('ends the row of a picture a stopped turn never made quietly, with no result to check', async () => {
      // A gate nobody opens, in a folder of this test: the item stays in progress.
      const gate = await mkdtemp(join(tmpdir(), 'latch-image-gate-'))
      cleanups.push(() => rm(gate, { recursive: true, force: true }))
      const t = await computer({ FAKE_CODEX_IMAGE_GATE: join(gate, 'open') })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'image result')
      await until(bridge, id, detail => detail.messages.some(message => message.tool?.imageGeneration && message.state === 'running'))
      await bridge.cancel(id)
      const done = await settled(bridge, id)
      expect(done.summary.status).toBe('cancelled')
      const row = done.messages.find(message => message.tool?.imageGeneration)
      expect(row).toMatchObject({ state: 'cancelled', tool: { output: '图片未生成' } })
      expect(row?.attachments).toBeUndefined()
    })

    it('ends a stored image row the Host stopped under quietly, not as a result to check', () => {
      const row = {
        id: 'tool:1:ig',
        role: 'tool' as const,
        text: '生成图片',
        state: 'running' as const,
        tool: { title: '生成图片', imageGeneration: true as const },
      }
      expect(settleToolMessage(row, '2026-11-20T00:00:00.000Z')).toBe(true)
      expect(row).toMatchObject({ state: 'cancelled', text: IMAGE_NOT_MADE, tool: { output: IMAGE_NOT_MADE, imageGeneration: true } })
    })

    for (const [how, note] of [
      ['big', '图片超过 5 MB，未显示'],
      ['bad', '生成的图片格式无效，未显示'],
    ] as const)
      it(`keeps no ${how === 'big' ? 'picture over 5 MiB' : 'bytes that are not a PNG, JPEG, GIF or WebP'}, and says so on the row`, async () => {
        const { saved, row } = await imaging(how)
        expect(saved).toHaveLength(0)
        expect(row).toMatchObject({ state: 'completed', tool: { imageGeneration: true } })
        expect(row?.attachments).toBeUndefined()
        expect(JSON.stringify(row?.tool)).toContain(note)
      })
  })

  it('offers 速度 only for a model with the Fast tier, sends the tier once picked, and reads it back from the thread', async () => {
    const t = await computer({ FAKE_CODEX_TIERS: '1' })
    let bridge = await t.open()
    const id = await start(bridge, t.main, 'echo first')
    let detail = await settled(bridge, id)
    const speed = () => detail.config?.find(option => option.id === 'service_tier')
    expect(speed()).toMatchObject({
      name: '速度',
      category: 'model_config',
      currentValue: 'default',
      options: [
        { value: 'default', name: '标准' },
        { value: 'priority', name: '快速', description: '1.5x speed, increased usage' },
      ],
    })
    // Nothing picked: the turn names no tier, so the thread keeps what the person's own configuration says.
    expect(sent(await t.log(), 'turn/start')[0]!.params).not.toHaveProperty('serviceTier')

    await bridge.setConfig!(id, 'service_tier', 'priority')
    await bridge.prompt(id, 'echo fast', rid())
    detail = await settled(bridge, id)
    expect(sent(await t.log(), 'turn/start').at(-1)!.params).toMatchObject({ serviceTier: 'priority' })
    expect(speed()?.currentValue).toBe('priority')
    await expect(bridge.setConfig!(id, 'service_tier', 'ultrafast')).rejects.toThrow()

    // A model without the tier offers no 速度, and its turns name none.
    await bridge.setConfig!(id, 'model', 'gpt-fake-mini')
    detail = await bridge.detail(id)
    expect(speed()).toBeUndefined()
    await bridge.prompt(id, 'echo mini', rid())
    await settled(bridge, id)
    expect(sent(await t.log(), 'turn/start').at(-1)!.params).not.toHaveProperty('serviceTier')
    await bridge.setConfig!(id, 'model', 'gpt-fake')
    await bridge.setConfig!(id, 'service_tier', 'priority')
    await bridge.prompt(id, 'echo back', rid())
    await settled(bridge, id)
    await bridge.close()

    // A new process reads the tier back from the resumed thread, as Codex reports it.
    bridge = await t.open()
    await bridge.prompt(id, 'echo again', rid())
    detail = await settled(bridge, id)
    expect(sent(await t.log(), 'thread/resume').length).toBeGreaterThan(0)
    expect(speed()?.currentValue).toBe('priority')
  })

  it('lists 速度 per model for a draft only on Codex’s own wire, the configured tier read as its current value', () => {
    const fast = { id: 'priority', name: 'Fast', description: '2x speed, increased usage' }
    const listed = {
      models: [
        { id: 'a', isDefault: true, supportedReasoningEfforts: [], serviceTiers: [fast, { id: 'ultrafast', name: 'Ultrafast' }] },
        { id: 'b', supportedReasoningEfforts: [] },
      ],
      tier: 'priority',
    }
    const own = codexOptions(listed, true)
    expect(own.options.find(option => option.id === 'service_tier')?.currentValue).toBe('priority')
    expect(own.perModel.map(entry => [entry.model, entry.options.map(option => option.id)])).toEqual([['a', ['service_tier']]])
    // Ultrafast is no choice of its own here; a thread already on it shows it.
    expect(own.options.find(option => option.id === 'service_tier')?.options.map(option => option.value)).toEqual(['default', 'priority'])
    expect(
      codexOptions({ ...listed, tier: 'ultrafast' }, true)
        .options.at(-1)
        ?.options.map(option => option.name),
    ).toEqual(['标准', '快速', 'Ultrafast'])
    expect(codexOptions(listed).perModel).toEqual([])
  })

  it('reads a configured tier as the thread’s and offers no 速度 without the tier', async () => {
    const configured = await computer({ FAKE_CODEX_TIERS: '1', FAKE_CODEX_SERVICE_TIER: 'fast' })
    const bridge = await configured.open()
    const detail = await settled(bridge, await start(bridge, configured.main, 'echo hi'))
    expect(detail.config?.find(option => option.id === 'service_tier')?.currentValue).toBe('priority')
    const plain = await computer()
    const other = await plain.open()
    const none = await settled(other, await start(other, plain.main, 'echo hi'))
    expect(none.config?.some(option => option.id === 'service_tier')).toBe(false)
  })

  it("carries Codex's own classification of a command only when it classified every part of it", async () => {
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'look around'))
    const rows = detail.messages.filter(message => message.role === 'tool').map(message => [message.tool?.title, message.tool?.actions])
    expect(rows).toEqual([
      ["/bin/zsh -lc 'cat notes.txt'", [{ kind: 'read', path: `${t.main}/notes.txt` }]],
      ["/bin/zsh -lc 'ls -la docs'", [{ kind: 'list', path: 'docs' }]],
      [`/bin/zsh -lc "rg -n 'alpha' notes.txt"`, [{ kind: 'search', query: 'alpha', path: 'notes.txt' }]],
      ["/bin/zsh -lc 'cat notes.txt | wc -l'", [{ kind: 'read', path: `${t.main}/notes.txt` }]],
      // Not classified, or only partly: a command, with nothing derived from its text.
      ["/bin/zsh -lc 'echo ok'", undefined],
      ["/bin/zsh -lc 'cat notes.txt && rm notes.txt'", undefined],
    ])
    // The reported command is kept whole whatever Codex made of it.
    for (const message of detail.messages.filter(item => item.role === 'tool'))
      expect(JSON.parse(message.tool!.input!)).toMatchObject({ command: message.tool!.title })
  })

  it('takes the thread’s token count as the session’s, with its cached input, and this turn’s as the difference', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    const first = await settled(bridge, id)
    expect(first.summary.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
    await bridge.prompt(id, 'echo two', rid())
    const second = await settled(bridge, id)
    expect(second.summary.usage).toMatchObject({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 16 })
    // Codex's own times for its messages, for the turn's speed.
    expect(second.messages.filter(message => message.role === 'user').every(message => (message.turn?.stream?.ms ?? 0) >= 400)).toBe(true)
    expect(second.messages.filter(message => message.role === 'user').map(message => message.turn?.usage)).toEqual([
      { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      { inputTokens: 20, outputTokens: 10, cacheReadTokens: 16, cacheWriteTokens: 0, reasoningTokens: 0 },
    ])
  })

  it('keeps the parts of a streamed reasoning summary apart as sections', async () => {
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'sections please'))
    expect(said(detail, 'assistant').trim()).toBe('planned')
    expect(detail.messages.find(message => message.reasoning)?.reasoning).toBe(
      '**Checking the project**\n\nReading `AGENTS.md` first.\n\n**Planning the page**\n\n- one\n- two',
    )
  })

  it('runs /compact as an idle native operation and preserves a first-turn brief for the next message', async () => {
    const t = await computer()
    const bridge = await t.open()
    const brief = { segments: [{ source: 'user' as const, text: 'Keep the public plan.' }] }
    const agentContext = { agent: { customAgentId: 'agt_slash' }, instructions: '', brief, revision: 'a'.repeat(64) }
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId: id } = await bridge.createTask({
      prompt: '/compact',
      requestId: rid(),
      cwd: t.main,
      expectedLaunchHash: launchHash,
      agentContext,
    })
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(done.commands).toContainEqual(expect.objectContaining({ name: 'compact', idleOnly: true }))
    expect(said(done, 'system')).toContain('Codex 已压缩上下文')
    expect(done.messages.find(message => message.role === 'user')?.agentBrief).toBeUndefined()
    expect(sent(await t.log(), 'turn/start')).toHaveLength(0)
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(1)
    await bridge.prompt(id, 'Continue with the plan.', rid())
    const next = await settled(bridge, id)
    expect(next.messages.filter(message => message.role === 'user').at(-1)?.agentBrief).toEqual(brief)
    expect(sent(await t.log(), 'turn/start')[0]!.params?.input).toEqual([
      { type: 'text', text: 'Keep the public plan.', text_elements: [] },
      { type: 'text', text: 'Continue with the plan.', text_elements: [] },
    ])
  })

  it('does not settle a compact ACK or item completion before the actual cancelled turn', async () => {
    const t = await computer({ FAKE_CODEX_COMPACT_HOLD: '1', FAKE_CODEX_INTERRUPT_MS: '120' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact')
    await until(bridge, id, detail => said(detail, 'system').includes('正在压缩上下文'))
    expect((await bridge.detail(id)).summary.status).toBe('running')
    await bridge.cancel(id)
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('cancelled')
    expect(said(done, 'system')).toContain('Codex 已取消压缩上下文')
    expect(said(done, 'system')).not.toContain('Codex 已压缩上下文')
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(1)
  })

  it('keeps a failed compaction failed even when its item was completed', async () => {
    const t = await computer({ FAKE_CODEX_COMPACT_FAIL: '1' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact')
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('failed')
    expect(said(done, 'system')).toContain('Codex 压缩上下文失败')
    expect(said(done, 'system')).not.toContain('Codex 已压缩上下文')
  })

  it.each([
    ['mode', 'workspace-write'],
    ['model', 'gpt-fake-mini'],
    ['reasoning_effort', 'high'],
  ])('refuses /compact after an unapplied %s change, then accepts after an ordinary turn', async (configId, value) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo setup')
    await settled(bridge, id)
    await bridge.setConfig!(id, configId!, value!)
    await bridge.prompt(id, '/compact', rid())
    const refused = await settled(bridge, id)
    expect(refused.summary.status).toBe('failed')
    expect(said(refused, 'system')).toContain('与选择不一致')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
    expect(sent(await t.log(), 'turn/start')).toHaveLength(1)
    await bridge.prompt(id, 'echo apply settings', rid())
    await settled(bridge, id)
    await bridge.prompt(id, '/compact', rid())
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(1)
  })

  it('does not start compact when cancellation arrives while its native context is being read', async () => {
    const t = await computer({ FAKE_CODEX_CONTEXT_MS: '250' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact')
    // The app-server is started for this prompt: that took 0.1 to 1.3 seconds here, past the default wait of one.
    await vi.waitFor(async () => expect(sent(await t.log(), 'thread/resume').some(entry => entry.params?.cwd === undefined)).toBe(true), {
      timeout: 5_000,
    })
    await bridge.cancel(id)
    expect((await settled(bridge, id)).summary.status).toBe('cancelled')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(0)
  })

  it('rejects compact arguments without treating them as a model prompt', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact keep the plan')
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('failed')
    expect(said(done, 'system')).toContain('不接受参数或附件')
    expect(sent(await t.log(), 'turn/start')).toHaveLength(0)
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
  })

  it.each([
    ['auto-compact-unsettled', 'Codex 压缩上下文结果未知'],
    ['auto-compact-complete', 'Codex 已压缩上下文'],
  ])('uses the automatic compaction item outcome for %s, independently of the ordinary turn', async (prompt, expected) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, prompt!)
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(said(done, 'assistant')).toBe('Ordinary turn completed.')
    const notes = done.messages.filter(message => message.role === 'system' && message.text.includes('压缩上下文'))
    expect(notes.map(message => message.text)).toEqual([expected])
  })

  it.each(['/review', '/review check the public plan'])(
    'refuses %s locally without a model turn or consuming the pending brief',
    async prompt => {
      const t = await computer()
      const bridge = await t.open()
      const brief = { segments: [{ source: 'user' as const, text: 'PUBLIC REVIEW BRIEF' }] }
      const agentContext = { agent: { customAgentId: 'agt_review' }, instructions: '', brief, revision: 'a'.repeat(64) }
      const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
      const { sessionId: id } = await bridge.createTask({
        prompt,
        requestId: rid(),
        cwd: t.main,
        expectedLaunchHash: launchHash,
        agentContext,
      })
      const refused = await settled(bridge, id)
      expect(refused.summary.status).toBe('failed')
      expect(said(refused, 'system')).toContain('原生审阅不会先询问')
      expect(refused.commands?.some(command => command.name === 'review')).toBe(false)
      expect(refused.messages.find(message => message.role === 'user')?.agentBrief).toBeUndefined()
      expect(sent(await t.log(), 'turn/start')).toHaveLength(0)
      expect(sent(await t.log(), 'review/start')).toHaveLength(0)
      await bridge.prompt(id, 'Hello', rid())
      const next = await settled(bridge, id)
      expect(next.messages.filter(message => message.role === 'user').at(-1)?.agentBrief).toEqual(brief)
      expect(sent(await t.log(), 'turn/start')[0]?.params?.input).toEqual([
        { type: 'text', text: 'PUBLIC REVIEW BRIEF', text_elements: [] },
        { type: 'text', text: 'Hello', text_elements: [] },
      ])
    },
  )

  it('does not send /review as steering text during another turn', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await expect(bridge.steer!(id, '/review the public plan', rid())).rejects.toThrow('没有接受这条追加')
    expect(sent(await t.log(), 'turn/steer')).toHaveLength(0)
    expect(sent(await t.log(), 'review/start')).toHaveLength(0)
    await bridge.cancel(id)
    await settled(bridge, id)
  })

  it('does not interpret a context block as the person invoking a native command', async () => {
    const t = await computer()
    const bridge = await t.open()
    const brief = { segments: [{ source: 'user' as const, text: '/compact is an example in this instruction.' }] }
    const agentContext = { agent: { customAgentId: 'agt_context' }, instructions: '', brief, revision: 'a'.repeat(64) }
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId: id } = await bridge.createTask({
      prompt: 'Hello',
      requestId: rid(),
      cwd: t.main,
      expectedLaunchHash: launchHash,
      agentContext,
    })
    expect((await settled(bridge, id)).summary.status).toBe('idle')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
    expect(sent(await t.log(), 'turn/start')[0]?.params?.input).toEqual([
      { type: 'text', text: brief.segments[0]!.text, text_elements: [] },
      { type: 'text', text: 'Hello', text_elements: [] },
    ])
  })

  it('gives the thread latch-browser as Codex config with paths only, and a fresh token file when it resumes', async () => {
    const leases: Array<{ token: string; tokenFile: string; closed: boolean }> = []
    const toolGateway: ToolGateway = {
      open() {
        const lease = {
          token: `lbt1.${String(leases.length).repeat(43)}`,
          tokenFile: `/tmp/latch-test/tools/${leases.length}.lbt`,
          closed: false,
        }
        leases.push(lease)
        return {
          socketPath: '/tmp/latch-test/tools/gateway.sock',
          tokenFile: lease.tokenFile,
          token: lease.token,
          active: () => !lease.closed,
          cancel() {},
          settled: async () => ({ resultUnknown: false }),
          close: () => void (lease.closed = true),
        }
      },
    }
    const t = await computer({}, [], {}, { toolGateway })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo hello')
    await settled(bridge, id)
    const started = sent(await t.log(), 'thread/start')[0]!.params as { config: { mcp_servers: Record<string, any> } }
    const server = started.config.mcp_servers['latch-browser']
    expect(server).toMatchObject({ command: process.execPath, env: {} })
    expect(server.args.slice(-2)).toEqual(['/tmp/latch-test/tools/gateway.sock', leases[0]!.tokenFile])
    // Codex may keep the thread's config in its own files: only the paths are in it.
    expect(JSON.stringify(started)).not.toContain('lbt1.')
    await bridge.close()
    expect(leases[0]!.closed).toBe(true)
    const again = await t.open()
    await again.prompt(id, 'echo again', rid())
    await settled(again, id)
    const resumed = sent(await t.log(), 'thread/resume')[0]!.params as { config: { mcp_servers: Record<string, any> } }
    expect(resumed.config.mcp_servers['latch-browser'].args.at(-1)).toBe(leases[1]!.tokenFile)
  })

  it('gives the thread each of Latch’s MCP servers as a latch-mcp bridge: paths only, no secret, a longer start', async () => {
    const closed: string[] = []
    const toolGateway: ToolGateway = {
      open: () => undefined,
      async openMcp(input) {
        expect(input).toMatchObject({ projectId: 'default' })
        return [
          {
            name: 'github',
            socketPath: '/tmp/latch-test/tools/gateway.sock',
            tokenFile: '/tmp/latch-test/tools/github.lbt',
            token: `lbt1.${'g'.repeat(43)}`,
            close: () => void closed.push('github'),
          },
        ]
      },
    }
    const t = await computer({}, [], {}, { toolGateway })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo hello')
    await settled(bridge, id)
    const started = sent(await t.log(), 'thread/start')[0]!.params as { config: { mcp_servers: Record<string, any> } }
    const server = started.config.mcp_servers.github
    expect(server).toMatchObject({ command: process.execPath, env: {}, startup_timeout_sec: 60 })
    expect(server.args.slice(-2)).toEqual(['/tmp/latch-test/tools/gateway.sock', '/tmp/latch-test/tools/github.lbt'])
    expect(JSON.stringify(started)).not.toContain('lbt1.')
    await bridge.close()
    expect(closed).toEqual(['github'])
  })

  it('puts Codex’s approvals to the person with one-time answers, and tells Codex what they chose', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'run the listing')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const [approval] = waiting.approvals
    expect(approval?.options?.map(option => option.id)).toEqual(['accept', 'decline'])
    await bridge.decide(approval!.id, 'allow')
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(done.messages.find(message => message.role === 'tool')).toMatchObject({ state: 'completed' })
    expect(JSON.stringify(done.messages)).toContain('file-b')
    const answered = (await t.log()).filter(entry => entry.event === 'recv' && entry.method === null && entry.result)
    expect(answered.map(entry => entry.result)).toEqual([{ decision: 'accept' }])

    await bridge.prompt(id, 'edit the notes', rid())
    const asked = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(asked.approvals[0]!.id, 'reject')
    const declined = await settled(bridge, id)
    expect(said(declined, 'assistant')).toContain('not edited')
    expect(declined.messages.filter(message => message.role === 'tool').at(-1)).toMatchObject({ state: 'failed' })
    await bridge.prompt(id, 'edit the notes', rid())
    const writing = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(writing.approvals[0]!.id, 'allow')
    const edited = await settled(bridge, id)
    expect(edited.messages.filter(message => message.tool?.kind === 'edit').at(-1)?.tool).toMatchObject({
      output: expect.stringContaining('+hello'),
      outputWithoutFiles: '',
    })
    await bridge.close()
    const restored = await t.open()
    expect((await restored.detail(id)).messages.filter(message => message.tool?.kind === 'edit').at(-1)?.tool).toMatchObject({
      output: expect.stringContaining('+hello'),
      outputWithoutFiles: '',
    })
  })

  it('sends each mode’s policy with every turn and thread, the project’s other folders writable only in a writing mode', async () => {
    const t = await computer({}, [], { idleMs: 300 })
    const bridge = await t.open()
    const folders = [
      { id: 'app', path: t.main },
      { id: 'docs', path: t.docs },
    ]
    const id = await start(bridge, t.main, 'echo one', folders)
    await settled(bridge, id)
    expect(sent(await t.log(), 'turn/start')[0]!.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    for (const [mode, expected] of [
      [
        'workspace-write',
        {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [t.docs], networkAccess: false },
        },
      ],
      [
        'agent',
        {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [t.docs], networkAccess: false },
        },
      ],
      ['agent-full-access', { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }],
    ] as const) {
      await bridge.setConfig!(id, 'mode', mode)
      await bridge.prompt(id, 'echo again', rid())
      await settled(bridge, id)
      expect(sent(await t.log(), 'turn/start').at(-1)!.params).toMatchObject(expected)
    }
    // An idle process stops; the next turn resumes the thread at the strictest mode, then sets the chosen one on the turn.
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'exit')).toBe(true), { timeout: 5_000 })
    await bridge.prompt(id, 'echo after', rid())
    await settled(bridge, id)
    const log = await t.log()
    expect(sent(log, 'thread/resume')[0]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      approvalsReviewer: 'user',
    })
    expect(sent(log, 'turn/start').at(-1)!.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
  })

  it('answers a stop only once Codex reports the interrupted turn ended', async () => {
    const t = await computer({ FAKE_CODEX_INTERRUPT_MS: '600' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    let completedFirst = true
    await vi.waitFor(
      async () => {
        const status = (await bridge.detail(id)).summary.status
        if (status === 'cancelled' && !(await t.log()).some(entry => entry.event === 'completed')) completedFirst = false
        expect(status).toBe('cancelled')
      },
      { timeout: 5_000, interval: 10 },
    )
    expect(completedFirst).toBe(true)
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(1)
  })

  it('interrupts once when the stop comes before Codex has named the turn', async () => {
    // The answer to `turn/start` and `turn/started` both name the turn after the stop.
    const t = await computer({ FAKE_CODEX_START_MS: '300', FAKE_CODEX_INTERRUPT_MS: '300' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    await vi.waitFor(async () => expect((await bridge.detail(id)).summary.status).toBe('cancelled'), { timeout: 5_000 })
    expect((await t.log()).some(entry => entry.event === 'completed')).toBe(true)
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(1)
  })

  it('stops a process whose interrupted turn never ends, and says so', async () => {
    const t = await computer({ FAKE_CODEX_INTERRUPT_NEVER: '1' }, [], { cancelGraceMs: 500 })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    const detail = await settled(bridge, id)
    expect(said(detail, 'system')).toContain('取消未在 1 秒内完成，已强制结束 Codex 进程')
  })

  it('answers cancel to an approval Codex asks after the stop', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep late')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    await settled(bridge, id)
    const late = (await t.log()).find(entry => entry.event === 'answered' && entry.method === 'late')
    expect(late?.answer).toEqual({ decision: 'cancel' })
  })

  describe('a stop while an allowed command runs', () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const killGroup = (pid: number) => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* ended */
      }
    }
    /** Starts `prompt` (a `hold`), allows its command, and returns the pid Codex runs it as after an interrupt. */
    async function holding(prompt: string, env: Record<string, string>, options: AcpAgentOptions = {}) {
      const t = await computer(env, [], options)
      const bridge = await t.open()
      const id = await start(bridge, t.main, prompt)
      const asked = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
      await bridge.decide(asked.approvals[0]!.id, 'allow')
      let pid = 0
      await vi.waitFor(
        async () => {
          pid = ((await t.log()).find(entry => entry.event === 'command-started') as (LogEntry & { osPid: number }) | undefined)?.osPid ?? 0
          expect(pid).toBeGreaterThan(0)
        },
        { timeout: 5_000 },
      )
      cleanups.push(() => killGroup(pid))
      // Allowed, it runs, though it prints nothing.
      await until(bridge, id, detail => detail.messages.some(message => message.role === 'tool' && message.state === 'running'))
      return { t, bridge, id, pid }
    }
    const row = (detail: DriverTaskDetail) => detail.messages.find(message => message.role === 'tool')
    const quick = (limits: Parameters<typeof setCodexStopLimits>[0]) => {
      setCodexStopLimits(limits)
      cleanups.push(() => setCodexStopLimits(undefined))
    }
    /** Stops it and says how long the stop took. */
    async function stop(bridge: Bridge, id: string): Promise<{ detail: DriverTaskDetail; ms: number }> {
      const began = Date.now()
      await bridge.cancel(id)
      return { detail: await settled(bridge, id), ms: Date.now() - began }
    }

    it('answers only once Codex has ended the command, and never says it did not start', async () => {
      const { t, bridge, id, pid } = await holding('hold on', {}, { cancelGraceMs: 10_000 })
      const { detail } = await stop(bridge, id)
      expect(detail.summary.status).toBe('cancelled')
      expect(alive(pid)).toBe(false)
      const log = await t.log()
      expect(log.findIndex(entry => entry.event === 'command-ended')).toBeGreaterThan(log.findIndex(entry => entry.event === 'interrupted'))
      expect(sent(log, 'thread/backgroundTerminals/terminate')).toHaveLength(1)
      expect(row(detail)?.state).toBe('failed')
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
      expect(said(detail, 'system')).not.toContain('强制结束')
    })

    it('ends the command’s own process group itself when Codex does not, before answering', async () => {
      quick({ commandMs: 300 })
      const { t, bridge, id, pid } = await holding('hold on', { FAKE_CODEX_TERMINALS: 'ignore' }, { cancelGraceMs: 10_000 })
      const { detail, ms } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(ms).toBeLessThan(5_000)
      expect(detail.summary.status).toBe('cancelled')
      expect((await t.log()).some(entry => entry.event === 'terminate')).toBe(true)
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
      expect(said(detail, 'system')).not.toContain('强制结束')
    })

    it.each(['hold quiet', 'hold sub quiet'])('waits for an accepted command with no started notification: %s', async prompt => {
      const { t, bridge, id, pid } = await holding(prompt, {}, { cancelGraceMs: 10_000 })
      const { detail } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(detail.summary.status).toBe('cancelled')
      expect(sent(await t.log(), 'thread/backgroundTerminals/terminate')).toHaveLength(1)
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
    })

    it('ends a subagent’s command through the subagent’s thread', async () => {
      const { t, bridge, id, pid } = await holding('hold sub', {}, { cancelGraceMs: 10_000 })
      const { detail, ms } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(ms).toBeLessThan(5_000)
      expect(detail.summary.status).toBe('cancelled')
      const listed = sent(await t.log(), 'thread/backgroundTerminals/list').map(entry => entry.params?.threadId)
      expect(listed).toHaveLength(2)
      expect(listed[1]).toMatch(/^thread-sub-/u)
    })

    it('waits for the command too when Codex ends the stopped turn failed', async () => {
      const { bridge, id, pid } = await holding('hold on', { FAKE_CODEX_INTERRUPT_STATUS: 'failed' }, { cancelGraceMs: 10_000 })
      await bridge.cancel(id)
      expect(alive(pid)).toBe(false)
      expect((await settled(bridge, id)).summary.status).toBe('cancelled')
    })

    it('does not wait for a command whose ask the stop left unanswered', async () => {
      const t = await computer({}, [], { cancelGraceMs: 10_000 })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'hold early')
      await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
      const { detail, ms } = await stop(bridge, id)
      expect(ms).toBeLessThan(3_000)
      expect(detail.summary.status).toBe('cancelled')
      expect((await t.log()).some(entry => entry.event === 'command-started')).toBe(false)
    })

    it('ends Codex when its own interrupted turn leaves a command running past the bound', async () => {
      quick({ commandMs: 200, unaskedMs: 800 })
      const { bridge, id, pid } = await holding('hold self', { FAKE_CODEX_TERMINALS: 'none' })
      const detail = await settled(bridge, id)
      expect(detail.summary.status).toBe('interrupted')
      expect(detail.summary.runEnd).toMatchObject({
        reason: 'forced-stop',
        unknownResults: [expect.objectContaining({ messageId: row(detail)?.id })],
      })
      expect(row(detail)).toMatchObject({ state: 'failed', text: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') })
      expect(alive(pid)).toBe(false)
    })

    describe('never confirmed while it may still run: left to the cancel limit', () => {
      async function unconfirmed(prompt: string, env: Record<string, string>, ready?: (pid: number) => Promise<void>) {
        quick({ commandMs: 200 })
        const found = await holding(prompt, { FAKE_CODEX_TERMINALS: 'ignore', ...env }, { cancelGraceMs: 2_000 })
        await ready?.(found.pid)
        const { detail, ms } = await stop(found.bridge, found.id)
        expect(ms).toBeGreaterThanOrEqual(1_900)
        expect(detail.summary.status).toBe('interrupted')
        expect(said(detail, 'system')).toContain('已强制结束 Codex 进程')
        expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
        return found
      }

      it('when the process Codex names is not one of its own, which is left alone', async () => {
        const foreign = spawn('sleep', ['600'], { stdio: 'ignore' })
        cleanups.push(() => void foreign.kill('SIGKILL'))
        const { pid } = await unconfirmed('hold on', { FAKE_CODEX_OS_PID: String(foreign.pid) })
        expect(alive(foreign.pid!)).toBe(true)
        // The limit ends Codex with the command it started in a group of its own.
        expect(alive(pid)).toBe(false)
      })

      it('when the process list cannot be read', async () => {
        setProcessLister(async () => undefined)
        cleanups.push(() => setProcessLister(undefined))
        await unconfirmed('hold on', {})
      })

      it('when the command’s group outlives its leader', async () => {
        // The shell in front has to be gone first: while it still leads the group, the stop rightly ends the whole group
        // and answers at once (seen once, at 343 ms, with the Mac busy).
        const { pid } = await unconfirmed('hold orphan', {}, leader =>
          vi.waitFor(() => expect(alive(leader)).toBe(false), { timeout: 5_000 }),
        )
        expect(alive(pid)).toBe(false)
      })
    })

    it('with no way to find the command, ends Codex and what it started once the grace runs out, and says so', async () => {
      const { bridge, id, pid } = await holding('hold on', { FAKE_CODEX_TERMINALS: 'none' }, { cancelGraceMs: 800 })
      const { detail } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(detail.summary.status).toBe('interrupted')
      expect(said(detail, 'system')).toContain('已强制结束 Codex 进程')
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
    })
  })

  it('adds text to the running turn with turn/steer', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    expect(await bridge.steer!(id, 'also this', rid())).toBe('injected')
    const [steered] = sent(await t.log(), 'turn/steer')
    expect(steered!.params).toMatchObject({ input: [{ type: 'text', text: 'also this' }] })
    expect(steered!.params!.expectedTurnId).toEqual(expect.stringMatching(/^turn-/u))
    await bridge.cancel(id)
    await settled(bridge, id)
  })

  it('fails the turn when Codex exits in the middle of it', async () => {
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'crash now'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('Codex')
  })

  it('says and records each request it answers without asking, and names one it does not know', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'widen please')
    await settled(bridge, id)
    for (const prompt of ['elicit please', 'odd please']) {
      await bridge.prompt(id, prompt, rid())
      await settled(bridge, id)
    }
    const detail = await bridge.detail(id)
    const notes = said(detail, 'system')
    expect(notes).toContain('已自动拒绝：Codex 请求联网。权限只随你在「权限」里选的模式变。')
    expect(notes).toContain('已自动拒绝：Codex 的 MCP 服务器「docs」想问你「Which page?」')
    expect(notes).toContain('item/tool/requestUserInput')
    const answered = (await t.log()).filter(entry => entry.event === 'answered')
    expect(answered.map(entry => entry.answer)).toEqual([{ permissions: {}, scope: 'turn' }, { action: 'decline' }, undefined])
    expect(t.events.filter(event => event.type === 'approval-auto-rejected')).toEqual([
      { type: 'approval-auto-rejected', sessionId: id, reason: 'harness-declined' },
      { type: 'approval-auto-rejected', sessionId: id, reason: 'harness-declined' },
    ])
  })

  it('shows what allowing a network request grants', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'fetch the page')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const [approval] = waiting.approvals
    expect(approval!.reason).toBe('联网：example.com')
    expect(approval!.arguments).toContain('允许后，这条命令可以访问 example.com（https）')
    await bridge.decide(approval!.id, 'reject')
    expect(said(await settled(bridge, id), 'assistant')).toContain('network decline')
  })

  it('projects native Team members and their results once, with only their own approvals', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await until(bridge, id, detail => detail.codexTeam === 'available' && detail.summary.status === 'idle')
    await bridge.prompt(id, 'team 真实委派', rid())
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const members = waiting.messages.filter(message => message.subagent?.team)
    expect(members.map(member => member.subagent?.title)).toEqual(['Cedar', 'Maple'])
    expect(members.map(member => member.subagent?.description)).toEqual(['检查窄屏', '核对回执'])
    expect(new Set(members.map(member => member.subagent?.team?.id)).size).toBe(1)
    expect(new Set(members.map(member => member.subagent?.team?.memberId)).size).toBe(2)
    expect(members[0]?.subagent?.team?.userMessageId).toBe(waiting.messages.findLast(message => message.role === 'user')?.id)
    expect(waiting.approvals).toHaveLength(1)
    expect(waiting.approvals[0]).toMatchObject({ subagent: 'Maple', subagentId: members[1]?.id })
    const other = await start(bridge, t.main, 'echo unrelated root')
    expect(await bridge.cancelSubagent!(other, members[1]!.id)).toBe(false)
    expect(await bridge.cancelSubagent!(id, 'arbitrary-upstream-thread')).toBe(false)
    expect((await bridge.detail(other)).messages.some(message => message.subagent?.team)).toBe(false)
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    const done = await settled(bridge, id)
    expect(done.messages.filter(message => message.subagent?.team).map(message => message.subagent)).toEqual([
      expect.objectContaining({ status: 'done', team: expect.objectContaining({ result: '已核对手机布局' }) }),
      expect.objectContaining({ status: 'failed', team: expect.objectContaining({ result: '回执检查被拒绝' }) }),
    ])
    expect(JSON.stringify(done.messages)).not.toMatch(/child-[a-f0-9]|不属于这次任务|外部成员/u)
    await settled(bridge, other)
    const log = await t.log()
    expect(log.find(entry => entry.event === 'answered' && entry.method === 'foreign-team-approval')?.answer).toEqual({
      decision: 'cancel',
    })
    expect(sent(log, 'turn/start')).toHaveLength(3)
  })

  it('links a native Team approval that arrived before its parent finished spawning the member', async () => {
    const t = await computer({ FAKE_CODEX_TEAM_EARLY_APPROVAL: '1' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'team 真实委派')
    const early = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    expect(early.approvals[0]?.subagentId).toBeUndefined()
    const later = await until(bridge, id, detail => detail.messages.filter(message => message.subagent?.team).length === 2)
    const maple = later.messages.find(message => message.subagent?.title === 'Maple')
    expect(later.approvals[0]).toMatchObject({ id: early.approvals[0]?.id, subagent: 'Maple', subagentId: maple?.id })
    await bridge.decide(later.approvals[0]!.id, 'reject')
    await settled(bridge, id)
  })

  it('recognizes native Team v2 activity and rejects a delayed earlier member turn', async () => {
    const t = await computer({ FAKE_CODEX_TEAM: 'v2' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'team 真实委派')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    expect(waiting.approvals[0]?.subagent).toBe('Maple')
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    const done = await settled(bridge, id)
    const cedar = done.messages.find(message => message.subagent?.title === 'Cedar')
    expect(cedar?.subagent).toMatchObject({ status: 'done', team: { result: '已核对手机布局' } })
    expect(JSON.stringify(done.messages)).not.toContain('旧轮迟到')
  })

  it('holds native Team interruption while a member command has not settled', async () => {
    const t = await computer({ FAKE_CODEX_TEAM_SETTLE_MS: '500' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'team 真实委派')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(waiting.approvals[0]!.id, 'allow')
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'team-command-started')).toBe(true))
    const cancellation = bridge.cancel(id)
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'team-child-interrupted')).toBe(true))
    const member = (detail: DriverTaskDetail) => detail.messages.find(message => message.subagent?.title === 'Maple')?.subagent
    expect(member(await bridge.detail(id))?.status).not.toBe('cancelled')
    await cancellation
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('cancelled')
    expect(member(done)?.status).toBe('cancelled')
    const log = await t.log()
    expect(log.filter(entry => entry.event === 'team-command-ended')).toHaveLength(1)
    expect(sent(log, 'turn/interrupt')).toHaveLength(2)
  })

  it('clears a native Team member’s previous result when its newly reported work fails', async () => {
    const t = await computer({ FAKE_CODEX_TEAM_SECOND_TURN: '1' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'team 真实委派')
    const waiting = await until(bridge, id, value => value.summary.status === 'waiting-approval')
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    const cedar = (await settled(bridge, id)).messages.find(message => message.subagent?.title === 'Cedar')
    expect(cedar?.subagent).toMatchObject({ status: 'failed', team: { failure: '下一轮失败' } })
    expect(cedar?.subagent?.team?.result).toBeUndefined()
  })

  it('recovers only known native Team results and never treats a restart as a stop receipt', async () => {
    const t = await computer({ FAKE_CODEX_TEAM_RECOVERY: '1' })
    let bridge = await t.open()
    const id = await start(bridge, t.main, 'team 真实委派')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'completed')).toBe(true))
    const rows = (await bridge.detail(id)).messages.filter(message => message.subagent?.team)
    expect(rows).toHaveLength(2)
    expect(rows.every(message => message.subagent?.status === 'running' && message.subagent.team?.result === undefined)).toBe(true)
    await bridge.close()

    // The same member did another turn outside the one this Host witnessed. Its newest output cannot stand in for the tracked turn.
    const statePath = join(t.root, 'threads.json')
    const threads = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, { agentNickname?: string; turns: unknown[] }>
    Object.values(threads)
      .find(thread => thread.agentNickname === 'Cedar')!
      .turns.push({
        id: 'unrelated-later-turn',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'unrelated-result', text: '这轮属于别的工作' }],
      })
    await writeFile(statePath, JSON.stringify(threads))
    bridge = await t.open()
    expect((await bridge.detail(id)).messages.filter(message => message.subagent?.team).map(message => message.id)).toEqual(
      rows.map(row => row.id),
    )
    await bridge.prompt(id, 'echo after reconnect', rid())
    const restored = await until(
      bridge,
      id,
      detail => detail.summary.status === 'idle' && detail.messages.some(message => message.subagent?.status === 'done'),
    )
    const members = restored.messages.filter(message => message.subagent?.team)
    expect(members.map(member => member.id)).toEqual(rows.map(row => row.id))
    expect(members[0]?.subagent).toMatchObject({ status: 'done', team: { result: '已核对手机布局' } })
    expect(members[1]?.subagent?.status).toBe('unknown')
    expect(members[1]?.subagent?.team?.result).toBeUndefined()
    const log = await t.log()
    expect(sent(log, 'thread/turns/list')).toHaveLength(2)
    expect(sent(log, 'turn/start')).toHaveLength(2)
  })

  it('does not show native Team availability after reconnect until this process reports it', async () => {
    const t = await computer()
    let bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await until(bridge, id, detail => detail.codexTeam === 'available')
    await bridge.close()
    bridge = await t.open()
    expect((await bridge.detail(id)).codexTeam).toBeUndefined()
  })

  it.each(['completed', 'cancelled'] as const)(
    'holds the same native Team run when the root finishes and a member is later %s',
    async result => {
      const t = await computer(
        {
          FAKE_CODEX_TEAM_BACKGROUND_MS: result === 'cancelled' ? '5000' : '1800',
          ...(result === 'cancelled' ? { FAKE_CODEX_TEAM_BACKGROUND_COMMAND: '1', FAKE_CODEX_TEAM_NESTED: '1' } : {}),
        },
        [],
        { maxProcesses: 1, idleMs: 100 },
      )
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'team 真实委派')
      const member = (detail: DriverTaskDetail) => detail.messages.find(message => message.subagent?.title === 'Cedar')?.subagent
      const rootDone = await until(
        bridge,
        id,
        detail =>
          detail.messages
            .filter(message => message.role === 'assistant' && message.state === 'completed')
            .map(message => message.text)
            .join('') === 'Lead finished before Cedar',
      )
      expect(rootDone.summary).toMatchObject({ status: 'running', runId: expect.any(String) })
      expect(member(rootDone)?.status).toBe('running')
      const competitor = await start(bridge, t.main, 'echo competing root')
      const refused = await settled(bridge, competitor)
      expect(refused.summary.status).toBe('failed')
      expect(said(refused, 'system')).toContain('同时运行的 Codex 会话过多')
      expect(member(await bridge.detail(id))?.status).toBe('running')
      if (result === 'cancelled') {
        const cancellation = bridge.cancel(id, { runId: rootDone.summary.runId! })
        await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'background-member-interrupted')).toBe(true))
        expect((await bridge.detail(id)).summary.status).toBe('running')
        expect(member(await bridge.detail(id))?.status).toBe('running')
        await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'background-command-ended')).toBe(true))
        expect((await bridge.detail(id)).summary.status).toBe('running')
        expect(await cancellation).toBe(true)
        const after = await settled(bridge, id)
        expect(after.summary.status).toBe('cancelled')
        expect(member(after)?.status).toBe('cancelled')
        const log = await t.log()
        const interrupts = sent(log, 'turn/interrupt')
        expect(interrupts).toHaveLength(2)
        for (const interrupt of interrupts)
          expect(interrupt.params).toMatchObject({
            threadId: expect.stringMatching(/^child-/u),
            turnId: expect.stringMatching(/^turn-child-/u),
          })
        expect(log.some(entry => entry.event === 'nested-member-interrupted')).toBe(true)
      } else {
        const after = await settled(bridge, id)
        expect(member(after)?.team?.result).toBe('Cedar finished after the lead')
      }
      const next = await start(bridge, t.main, 'echo after members finish')
      expect((await settled(bridge, next)).summary.status).toBe('idle')
    },
  )

  it('reads native Team capability without changing a user-disabled feature', async () => {
    const t = await computer({ FAKE_CODEX_TEAM: 'off' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await until(bridge, id, detail => detail.codexTeam === 'disabled')
    const log = await t.log()
    expect(sent(log, 'experimentalFeature/list')).toHaveLength(1)
    expect(log.some(entry => entry.method === 'experimentalFeature/enable' || entry.method === 'config/batchWrite')).toBe(false)
  })

  it('shows a subagent’s calls as its own and asks about them as its', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sub task')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    expect(waiting.approvals[0]).toMatchObject({ subagent: expect.any(String) })
    expect(waiting.approvals[0]!.toolCallId).toBeUndefined()
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    const done = await settled(bridge, id)
    expect(said(done, 'assistant')).toContain('subagent done')
    expect(JSON.stringify(done.messages)).toContain('rm -rf build')
    const answer = (await t.log()).find(entry => entry.event === 'answered' && entry.method === 'subagent')?.answer
    expect(answer).toEqual({ decision: 'decline' })
  })

  it('in the model-reviewed mode, shows the review of a subagent’s call as the subagent’s, and records its verdict', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await settled(bridge, id)
    await bridge.setConfig!(id, 'mode', 'agent')
    await bridge.prompt(id, 'sub task', rid())
    const done = await settled(bridge, id)
    expect(said(done, 'assistant')).toContain('subagent done')
    expect(JSON.stringify(done.messages)).toContain('Removes the build')
    expect(t.events.filter(event => event.type === 'tool-judged').map(event => event.type === 'tool-judged' && event.outcome)).toContain(
      'denied',
    )
    expect(t.events.some(event => event.type === 'tool-judged' && event.outcome === 'ran-unasked')).toBe(false)
  })

  it('asks the person before an MCP tool runs, showing the server, the tool and its arguments', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'tool please')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const [approval] = waiting.approvals
    expect(approval!.reason).toBe('调用 docs.search')
    expect(approval!.arguments).toContain('允许后，Codex 调用 MCP 服务器「docs」的工具「search」一次')
    expect(approval!.arguments).toContain('latch')
    // Started before it asked, it is not shown as running yet.
    expect(waiting.messages.filter(message => message.role === 'tool').every(message => message.state !== 'running')).toBe(true)
    await bridge.decide(approval!.id, 'allow')
    const done = await settled(bridge, id)
    expect(said(done, 'assistant')).toContain('tool ran')
    expect(done.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(done.messages.find(message => message.role === 'tool')).toMatchObject({ state: 'completed' })
    expect(done.summary.runEnd?.unknownResults ?? []).toEqual([])
    expect((await t.log()).find(entry => entry.event === 'answered' && entry.method === 'tool')?.answer).toEqual({
      action: 'accept',
      content: {},
    })
  })

  it('keeps only simulator input counts in native Codex tool rows, approvals and saved history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-input-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const gate = join(root, 'ask')
    const t = await computer({ FAKE_CODEX_SIMULATOR_APPROVAL_GATE: gate })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'tool-simulator-input')
    const noInput = (value: unknown) => {
      const shown = JSON.stringify(value)
      for (const argument of ['violet ocean note', '91.125', '213.375', '197.25', '433.625']) expect(shown).not.toContain(argument)
    }
    const rows = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'tool')
    try {
      const started = await until(bridge, id, detail => rows(detail).length === 3)
      expect(rows(started).map(row => row.tool?.input)).toEqual(['17 个字符', '1 个触点', '2 个触点'])
      noInput(rows(started))
    } finally {
      await writeFile(gate, '')
    }
    const waiting = await until(bridge, id, detail => detail.approvals.length === 3)
    noInput(rows(waiting))
    noInput(waiting.approvals)
    const calls = waiting.approvals.map(approval => ({
      id: approval.toolCallId,
      tool: approval.toolName,
      decision: approval.toolName.endsWith('.device_tap') ? ('reject' as const) : ('allow' as const),
    }))
    expect(waiting.approvals.map(approval => approval.arguments)).toEqual(['17 个字符', '1 个触点', '2 个触点'])
    expect(waiting.approvals.every(approval => approval.risk === 'R2' && approval.advisory)).toBe(true)
    for (const approval of [...waiting.approvals].reverse()) {
      expect(rows(waiting).find(row => row.id === `tool:${approval.toolCallId}`)?.toolName).toBe(approval.toolName)
      const decision = calls.find(call => call.id === approval.toolCallId)!.decision
      await bridge.decide(approval.id, decision)
    }
    const done = await settled(bridge, id)
    noInput(rows(done))
    for (const call of calls)
      expect(rows(done).find(row => row.id === `tool:${call.id}`)).toMatchObject({
        toolName: call.tool,
        tool: { decision: { outcome: call.decision === 'allow' ? 'allowed' : 'rejected' } },
        state: call.decision === 'allow' ? 'completed' : 'failed',
      })
    await bridge.close()
    const saved = await readFile(join(t.root, 'data', 'acp.json'), 'utf8')
    noInput(saved)
    expect(saved).toContain('17 个字符')
  })

  it.each([
    { prompt: 'tool-fail', action: 'allow', state: 'failed', unknown: 0 },
    { prompt: 'tool', action: 'reject', state: 'failed', unknown: 0 },
    { prompt: 'tool-unsettled', action: 'allow', state: 'failed', unknown: 1 },
  ] as const)('settles MCP $prompt only from its own native result after $action', async ({ prompt, action, state, unknown }) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, prompt)
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(waiting.approvals[0]!.id, action)
    const done = await settled(bridge, id)
    const tools = done.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.state).toBe(state)
    expect(done.summary.runEnd?.unknownResults ?? []).toHaveLength(unknown)
  })

  it('keeps opposite decisions for parallel same-name MCP calls with different arguments and reverse completion', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'tool-parallel')
    const waiting = await until(bridge, id, detail => detail.approvals.length === 2)
    const first = waiting.approvals.find(item => item.arguments?.includes('latch-0'))!
    const second = waiting.approvals.find(item => item.arguments?.includes('latch-1'))!
    await bridge.decide(second.id, 'reject')
    await bridge.decide(first.id, 'allow')
    const done = await settled(bridge, id)
    const tools = done.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools.find(item => item.tool?.input?.includes('latch-0'))).toMatchObject({
      state: 'completed',
      tool: { decision: { outcome: 'allowed' } },
    })
    expect(tools.find(item => item.tool?.input?.includes('latch-1'))).toMatchObject({
      state: 'failed',
      tool: { decision: { outcome: 'rejected' } },
    })
    expect(done.summary.runEnd?.unknownResults ?? []).toEqual([])
  })

  it.each([
    { prompt: 'tool-ambiguous', count: 2 },
    { prompt: 'tool-wrong-turn', count: 1 },
    { prompt: 'tool-missing-fields', count: 1 },
    { prompt: 'tool-not-started', count: 1 },
  ])('does not attach an MCP approval to $prompt without unique same-turn evidence', async ({ prompt, count }) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, prompt)
    const waiting = await until(bridge, id, detail => detail.approvals.length === count)
    for (const approval of waiting.approvals) await bridge.decide(approval.id, 'allow')
    const done = await settled(bridge, id)
    const tools = done.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(count * 2)
    expect(tools.filter(item => item.state === 'completed')).toHaveLength(count)
    expect(done.summary.runEnd?.unknownResults ?? []).toHaveLength(count)
  })

  it('keeps parent and child MCP approvals separate even when their native IDs and arguments match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-child-mcp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const asks: Array<{ toolCall: { toolCallId: string; _meta?: Record<string, unknown> } }> = []
    const updates: Array<{ update?: { toolCallId?: string; status?: string; _meta?: Record<string, unknown> } }> = []
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      {
        request: async (_method, params) => {
          asks.push(params as (typeof asks)[number])
          return { outcome: { outcome: 'selected', optionId: 'accept' } }
        },
        notification: (_method, params) => {
          updates.push(params as (typeof updates)[number])
        },
        exit: () => {},
      },
    )
    cleanups.push(() => void wire.stop('kill', 100))
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as { sessionId: string }
    await wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'tool-child' }] }, 5_000)
    expect(asks).toHaveLength(2)
    expect(asks[0]!.toolCall.toolCallId).toBe(asks[1]!.toolCall.toolCallId)
    expect(asks[0]!.toolCall.toolCallId).not.toContain('approval')
    expect(asks[0]!.toolCall._meta?.['latch/codexChild']).toBeUndefined()
    expect(asks[1]!.toolCall._meta?.['latch/codexChild']).toMatchObject({ id: 'thread-mcp-child', parentID: opened.sessionId })
    const completed = updates.filter(item => item.update?.status === 'completed')
    expect(completed).toHaveLength(2)
    expect(completed[0]!.update?._meta?.['latch/codexChild']).toMatchObject({ id: 'thread-mcp-child' })
    expect(completed[1]!.update?._meta?.['latch/codexChild']).toBeUndefined()
  })

  it('does not let a late MCP answer from a stopped turn approve the next same-name call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-late-mcp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const logFile = join(root, 'codex.jsonl')
    const answers: Array<(value: unknown) => void> = []
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      { request: () => new Promise(resolve => answers.push(resolve)), notification: () => {}, exit: () => {} },
    )
    cleanups.push(() => void wire.stop('kill', 100))
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as { sessionId: string }
    const prompt = () => wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'tool' }] }, 5_000)
    const old = prompt().catch(error => error)
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    wire.notify('session/cancel')
    await expect(old).resolves.toMatchObject({ stopReason: 'cancelled' })
    const next = prompt().catch(error => error)
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    answers[0]!({ outcome: { outcome: 'selected', optionId: 'accept' } })
    await vi.waitFor(async () => {
      const rows = (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
      expect(
        rows.find(entry => entry.event === 'recv' && entry.result && (entry.result as { action?: string }).action === 'cancel'),
      ).toBeDefined()
    })
    answers[1]!({ outcome: { outcome: 'selected', optionId: 'accept' } })
    await expect(next).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('cancels a late MCP allow while the same turn is cancelling but has not settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-cancelling-mcp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const logFile = join(root, 'codex.jsonl')
    let answer: ((value: unknown) => void) | undefined
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile, FAKE_CODEX_INTERRUPT_MS: '2000' },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      {
        request: () =>
          new Promise(resolve => {
            answer = resolve
          }),
        notification: () => {},
        exit: () => {},
      },
    )
    cleanups.push(() => void wire.stop('kill', 100))
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as { sessionId: string }
    const run = wire
      .request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'tool' }] }, 5_000)
      .catch(error => error)
    await vi.waitFor(() => expect(answer).toBeDefined())
    wire.notify('session/cancel')
    answer!({ outcome: { outcome: 'selected', optionId: 'accept' } })
    await expect(run).resolves.toMatchObject({ stopReason: 'cancelled' })
    const rows = (await readFile(logFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as LogEntry)
    expect(rows.find(entry => entry.event === 'answered' && entry.method === 'tool')?.answer).toEqual({ action: 'cancel' })
  })

  it('answers the two old-style approval requests itself, and says so', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'legacy asks')
    const done = await settled(bridge, id)
    const answered = (await t.log()).filter(entry => entry.event === 'answered')
    expect(answered.map(entry => [entry.method, entry.answer])).toEqual([
      ['execCommandApproval', { decision: 'abort' }],
      ['applyPatchApproval', { decision: 'abort' }],
    ])
    expect(said(done, 'system')).toContain('已自动拒绝：Codex 用旧式请求要求运行命令')
    expect(said(done, 'system')).toContain('已自动拒绝：Codex 用旧式请求要求改文件')
    expect(t.events.filter(event => event.type === 'approval-auto-rejected')).toHaveLength(2)
  })

  it('in the model-reviewed mode, shows Codex’s reviews and records a denied call as denied, never as run unasked', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await settled(bridge, id)
    await bridge.setConfig!(id, 'mode', 'agent')
    await bridge.prompt(id, 'run it', rid())
    await settled(bridge, id)
    await bridge.prompt(id, 'risky run', rid())
    const detail = await settled(bridge, id)
    const tools = detail.messages.filter(message => message.role === 'tool')
    expect(tools.filter(tool => tool.tool?.judged).map(tool => tool.tool?.judged?.outcome)).toEqual(
      expect.arrayContaining(['approved', 'denied']),
    )
    expect(tools.find(tool => tool.tool?.blocked)?.tool?.blocked).toMatchObject({ source: 'model', reason: 'Deletes too much' })
    const judged = t.events.flatMap(event => (event.type === 'tool-judged' ? [event.outcome] : []))
    expect(judged).toEqual(expect.arrayContaining(['approved', 'denied']))
    expect(judged).not.toContain('ran-unasked')
  })

  it('keeps Codex’s own reason when resuming fails for any reason but a missing thread', async () => {
    const t = await computer({ FAKE_CODEX_RESUME_ERROR: 'thread is in use by another client' }, [], { idleMs: 300 })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await settled(bridge, id)
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'exit')).toBe(true), { timeout: 5_000 })
    // Refused before the turn was recorded: a code that says nothing was accepted, with Codex's own words.
    await expect(bridge.prompt(id, 'echo two', rid())).rejects.toMatchObject({
      code: 'agent-refused',
      message: 'Codex 返回错误：thread is in use by another client',
    })
  })

  it('fails a turn Codex ends failed, with its reason, and reports its retry on the way', async () => {
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'fail now'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('The model service failed')
  })

  it('fails a turn whose thread Codex marked systemError and then left, with Codex’s own error, instead of hanging', async () => {
    setCodexStopLimits({ systemErrorMs: 200 })
    cleanups.push(() => setCodexStopLimits(undefined))
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'system-error')
    const detail = await settled(bridge, id)
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('The session hit an internal error')
    // The thread goes on: the next turn runs.
    await bridge.prompt(id, 'echo again', rid())
    expect((await settled(bridge, id)).summary.status).toBe('idle')
  })

  it('leaves a turn running when Codex marks its thread systemError for an error that does not end turns', async () => {
    setCodexStopLimits({ systemErrorMs: 100 })
    cleanups.push(() => setCodexStopLimits(undefined))
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'system-quiet'))
    expect(detail.summary.status).toBe('idle')
    expect(said(detail, 'assistant')).toBe('went on')
    expect(sent(await t.log(), 'turn/interrupt')).toEqual([])
  })

  it('says Codex is not logged in when its account says so, before any thread', async () => {
    const t = await computer({ FAKE_CODEX_LOGGED_OUT: '1' })
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'echo hi'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('Codex 还没登录')
    expect(sent(await t.log(), 'thread/start')).toEqual([])
  })

  it('lists and brings in Codex’s threads through its own requests', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo remember me')
    await settled(bridge, id)
    const listed = await bridge.listExternalSessions!()
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({ cwd: t.main, title: 'echo remember me' })
    const load = await bridge.loadExternalSession!({
      agentSessionId: listed.sessions[0]!.agentSessionId,
      cwd: t.main,
      workspaceId: 'proj',
      folders: [{ id: 'app', path: t.main }],
    })
    expect(load.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(load.messages[1]!.text).toBe('echo: echo remember me')
    const log = await t.log()
    // The interactive sources and `codex exec` runs, each by their latest update.
    expect(sent(log, 'thread/list').map(entry => entry.params)).toEqual([
      { limit: 50, modelProviders: [], sortKey: 'updated_at' },
      { limit: 50, modelProviders: [], sortKey: 'updated_at', sourceKinds: ['exec'] },
    ])
    expect(sent(log, 'thread/read')[0]!.params).toMatchObject({ includeTurns: true })
  })

  it('lists `codex exec` runs with the rest, once each, newest update first, and pages both queries', async () => {
    const exec = (id: string, updatedAt: number) => ({
      id,
      cwd: '/work/exec',
      model: 'gpt-fake',
      turns: [],
      preview: `exec ${id}`,
      createdAt: 1,
      updatedAt,
    })
    const t = await computer({
      FAKE_CODEX_EXEC_THREADS: JSON.stringify([exec('exec-new', 4_000_000_000), exec('exec-old', 1)]),
    })
    const bridge = await t.open()
    await settled(bridge, await start(bridge, t.main, 'echo terminal'))
    const listed = await bridge.listExternalSessions!()
    expect(listed.sessions.map(row => row.agentSessionId)).toEqual(['exec-new', expect.stringMatching(/^thread-/u), 'exec-old'])
    // Sixty `exec` runs: two pages, the cursor carrying where each query goes on.
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: t.root,
        env: {
          PATH: process.env.PATH ?? '',
          FAKE_CODEX_EXEC_THREADS: JSON.stringify(Array.from({ length: 60 }, (_, index) => exec(`e${index}`, index + 10))),
        },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      { request: async () => ({}), notification: () => {}, exit: () => {} },
    )
    cleanups.push(async () => {
      await wire.stop('kill', 100)
    })
    await wire.request('initialize', {}, 5_000)
    const first = (await wire.request('session/list', {}, 5_000)) as { sessions: Array<{ sessionId: string }>; nextCursor?: string }
    expect(first.sessions).toHaveLength(50)
    expect(first.nextCursor).toMatch(/^latch-list:/u)
    const second = (await wire.request('session/list', { cursor: first.nextCursor }, 5_000)) as { sessions: unknown[]; nextCursor?: string }
    expect(second.sessions).toHaveLength(10)
    expect(second.nextCursor).toBeUndefined()
    await expect(wire.request('session/list', { cursor: 'not-ours' }, 5_000)).rejects.toThrow('Invalid cursor')
  })

  describe('this computer’s Codex policy', () => {
    /** The wire on the fake app-server, with its own environment, as a session would drive it. */
    async function wired(env: Record<string, string>, route?: boolean) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-policy-')))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const logFile = join(root, 'codex.jsonl')
      const wire = CodexWire.spawn(
        {
          command: process.execPath,
          args: [
            FAKE_CODEX_APP_SERVER,
            ...(route ? ['-c', 'model_provider="latch"', '-c', 'model_providers.latch.base_url="http://127.0.0.1:9"'] : []),
          ],
          cwd: root,
          env: { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: logFile, ...env },
          maxLineBytes: 1 << 20,
          redact: text => text,
        },
        { request: async () => ({ outcome: { outcome: 'cancelled' } }), notification: () => {}, exit: () => {} },
        route ? { model: 'service-model', models: ['service-model'], modelCapabilities: {} } : undefined,
      )
      cleanups.push(async () => {
        await wire.stop('kill', 100)
      })
      const log = async () =>
        (await readFile(logFile, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as LogEntry)
      await wire.request('initialize', {}, 5_000)
      return { wire, root, log }
    }
    type Opened = {
      sessionId: string
      configOptions: Array<{ id: string; options: Array<{ value: string; _meta?: Record<string, unknown> }> }>
    }
    const unavailable = (opened: Opened) =>
      Object.fromEntries(
        opened.configOptions
          .find(option => option.id === 'mode')!
          .options.flatMap(entry => (entry._meta?.['latch/unavailable'] ? [[entry.value, entry._meta['latch/unavailable']]] : [])),
      )

    it('greys the modes the policy refuses, with why, refuses choosing one, and never sends one to Codex', async () => {
      const { wire, root, log } = await wired({
        FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only', 'workspace-write'] }),
      })
      const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as Opened
      expect(unavailable(opened)).toEqual({ 'agent-full-access': '这台电脑的 Codex 管理策略不允许不用沙箱' })
      await expect(
        wire.request('session/set_config_option', { sessionId: opened.sessionId, configId: 'mode', value: 'agent-full-access' }, 5_000),
      ).rejects.toThrow('这台电脑的 Codex 管理策略不允许不用沙箱')
      await wire.request('session/set_config_option', { sessionId: opened.sessionId, configId: 'mode', value: 'workspace-write' }, 5_000)
      await wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }, 5_000)
      const turns = sent(await log(), 'turn/start').map(entry => (entry.params?.sandboxPolicy as { type: string }).type)
      expect(turns).toEqual(['workspaceWrite'])
    })

    it('opens the thread without a setting the policy refuses, and sends no turn on a refused mode', async () => {
      const { wire, root, log } = await wired({
        FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedApprovalPolicies: ['on-request', 'never'] }),
      })
      const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as Opened
      expect(unavailable(opened)).toEqual({ 'read-only': '这台电脑的 Codex 管理策略不允许每次询问' })
      expect(sent(await log(), 'thread/start')[0]!.params).not.toHaveProperty('approvalPolicy')
      expect(sent(await log(), 'thread/start')[0]!.params).toMatchObject({ sandbox: 'read-only' })
      // Read-only is where a session starts: it stays, and nothing is narrowed or widened for the person.
      await expect(
        wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }, 5_000),
      ).rejects.toThrow('请在「权限」里换一档再发送')
      expect(sent(await log(), 'turn/start')).toEqual([])
    })

    it('on a model the policy has its review model decide, offers only the model-reviewed mode', async () => {
      const { wire, root } = await wired({ FAKE_CODEX_REQUIREMENTS: JSON.stringify({ autoReview: { requiredOnModels: ['gpt-fake'] } }) })
      const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as Opened
      expect(Object.keys(unavailable(opened)).sort()).toEqual(['agent-full-access', 'read-only', 'workspace-write'])
      expect(unavailable(opened)['read-only']).toBe('这台电脑的 Codex 管理策略要求 gpt-fake 由 Codex 的模型审阅')
    })

    it('says a turn Codex refused for a policy it did not report is the policy’s, and the turn never started', async () => {
      const { wire, root } = await wired({
        FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedApprovalPolicies: ['on-request'] }),
        FAKE_CODEX_REQUIREMENTS_HIDDEN: '1',
      })
      const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000).catch(error => error)) as Opened | Error
      // Unread, the policy refuses the thread's own setting too: Codex's words, as they are.
      expect(opened).toBeInstanceOf(Error)
      const second = await wired({
        FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only'] }),
        FAKE_CODEX_REQUIREMENTS_HIDDEN: '1',
      })
      const session = (await second.wire.request('session/new', { cwd: second.root, mcpServers: [] }, 5_000)) as Opened
      await second.wire.request(
        'session/set_config_option',
        { sessionId: session.sessionId, configId: 'mode', value: 'agent-full-access' },
        5_000,
      )
      await expect(
        second.wire.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'echo hi' }] }, 5_000),
      ).rejects.toThrow('这台电脑的 Codex 管理策略不允许当前的权限档，这一轮没有开始')
    })

    it('takes a greyed mode only from Latch’s own wire: an ACP agent cannot grey one out', () => {
      const reported = [
        {
          type: 'select',
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'a',
          options: [
            { value: 'a', name: 'A' },
            { value: 'b', name: 'B', _meta: { 'latch/unavailable': 'not now' } },
          ],
        },
      ]
      expect(configFromOptions(reported, true)[0]!.options[1]).toEqual({ value: 'b', name: 'B', unavailable: 'not now' })
      expect(configFromOptions(reported)[0]!.options[1]).toEqual({ value: 'b', name: 'B' })
    })

    it('carries the greyed modes to the session’s settings, and a choice of one is refused with why', async () => {
      const t = await computer({ FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only', 'workspace-write'] }) })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'echo hi')
      const detail = await settled(bridge, id)
      const mode = detail.config?.find(option => option.category === 'mode')
      expect(mode?.options.find(option => option.value === 'agent-full-access')?.unavailable).toBe(
        '这台电脑的 Codex 管理策略不允许不用沙箱',
      )
      expect(mode?.options.filter(option => option.unavailable).map(option => option.value)).toEqual(['agent-full-access'])
      await expect(bridge.setConfig!(id, 'mode', 'agent-full-access')).rejects.toMatchObject({
        message: expect.stringContaining('这台电脑的 Codex 管理策略不允许不用沙箱'),
      })
      expect((await bridge.detail(id)).permission?.expectedMode).toBe('read-only')
    })

    it('does not start a draft’s first turn in a mode the policy refuses, and says why', async () => {
      const t = await computer({ FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only', 'workspace-write'] }) })
      const bridge = await t.open()
      const config = [{ configId: 'mode', value: 'agent-full-access' }]
      const { launchHash } = await bridge.launchPreview!({ cwd: t.main, config })
      const outcome = await bridge
        .createTask({ prompt: 'echo hi', requestId: rid(), cwd: t.main, config, expectedLaunchHash: launchHash })
        .then(
          async ({ sessionId }) => {
            const detail = await settled(bridge, sessionId)
            return `${detail.summary.status}: ${said(detail, 'system')}`
          },
          (error: Error) => error.message,
        )
      expect(outcome).toContain('这台电脑的 Codex 管理策略不允许不用沙箱')
      expect(sent(await t.log(), 'turn/start')).toEqual([])
    })

    it('refuses a gateway session before its thread when the policy forces another provider', async () => {
      const { wire, root, log } = await wired({ FAKE_CODEX_REQUIREMENTS: JSON.stringify({ modelProvider: 'corp' }) }, true)
      await expect(wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)).rejects.toThrow('管理策略指定了它自己的模型服务')
      expect(sent(await log(), 'thread/start')).toEqual([])
    })

    it('refuses a gateway session when the person’s own provider by Latch’s name would merge into it, naming no value', async () => {
      const { wire, root, log } = await wired(
        { FAKE_CODEX_ORIGINS: JSON.stringify({ 'model_providers.latch.http_headers.X-Secret': { name: { type: 'user' }, version: 'v' } }) },
        true,
      )
      const refused = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000).catch(error => error)) as Error
      expect(refused.message).toContain('[model_providers.latch]')
      expect(refused.message).not.toContain('X-Secret')
      expect(sent(await log(), 'thread/start')).toEqual([])
    })

    it('refuses a gateway session when a layer above Latch’s arguments picks the provider', async () => {
      const { wire, root } = await wired(
        { FAKE_CODEX_ORIGINS: JSON.stringify({ model_provider: { name: { type: 'legacyManagedConfigTomlFromFile' }, version: 'v' } }) },
        true,
      )
      await expect(wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)).rejects.toThrow('更高优先级的配置')
    })
  })

  describe('deleting a session', () => {
    const deleted = (log: LogEntry[]) => sent(log, 'thread/delete').map(entry => entry.params?.threadId as string)
    const threadsOf = async (t: Awaited<ReturnType<typeof computer>>) =>
      Object.keys(JSON.parse(await readFile(join(t.root, 'threads.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>)

    it('deletes the thread through thread/delete, with the pictures Codex saved for it, and checks Codex no longer reads it', async () => {
      const t = await computer(
        {},
        [],
        {},
        { saveAttachment: async () => ({ id: 'a', kind: 'image', mime: 'image/png', size: 1, name: 'a.png' }) as never },
      )
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'image saved')
      await settled(bridge, id)
      const [thread] = await threadsOf(t)
      const pictures = join(t.root, 'codex-home', 'generated_images', thread!)
      // Something of the person's own beside it, in a name Codex never gives a picture: it stays.
      await writeFile(join(pictures, 'notes.txt'), 'mine')
      await bridge.remove!(id)
      const log = await vi.waitFor(
        async () => {
          const entries = await t.log()
          expect(deleted(entries)).toEqual([thread])
          const afterDelete = entries.slice(entries.findIndex(entry => entry.method === 'thread/delete') + 1)
          expect(sent(afterDelete, 'thread/read').at(-1)?.params).toEqual({ threadId: thread, includeTurns: false })
          return entries
        },
        { timeout: 5_000, interval: 20 },
      )
      expect(await threadsOf(t)).toEqual([])
      const removed = log.filter(entry => entry.event === 'removed') as Array<LogEntry & { path: string; recursive: boolean }>
      expect(removed).toHaveLength(2)
      expect(removed.every(entry => entry.recursive === false)).toBe(true)
      expect(removed[0]!.path).toMatch(new RegExp(`/generated_images/${thread}/ig_[^/]+\\.png$`, 'u'))
      await expect(readFile(removed[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(pictures, 'notes.txt'), 'utf8')).toBe('mine')
      // No thread was opened for it: the process only deleted.
      expect(sent(log, 'thread/resume')).toEqual([])
    })

    it('deletes the newest thread first, so a fork that refers to an older one does not stop it', async () => {
      const t = await computer({}, [], { idleMs: 200 })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'echo one')
      await settled(bridge, id)
      // A move to Codex's route and back forks the thread each time: three threads, each a fork of the one before.
      const one = (await threadsOf(t))[0]!
      const two = `thread-two-${rid()}`
      const three = `thread-three-${rid()}`
      const all = JSON.parse(await readFile(join(t.root, 'threads.json'), 'utf8')) as Record<string, Record<string, unknown>>
      all[two] = { ...all[one], id: two, forkedFrom: one }
      all[three] = { ...all[one], id: three, forkedFrom: two }
      await writeFile(join(t.root, 'threads.json'), JSON.stringify(all))
      const state = JSON.parse(await readFile(join(t.root, 'data', 'acp.json'), 'utf8')) as {
        tasks: Record<string, { acp: Record<string, unknown> }>
      }
      await bridge.close()
      state.tasks[id]!.acp.earlierSessionIds = [one, two]
      state.tasks[id]!.acp.acpSessionId = three
      await writeFile(join(t.root, 'data', 'acp.json'), JSON.stringify(state))
      const reopened = await t.open()
      await reopened.remove!(id)
      await vi.waitFor(async () => expect(deleted(await t.log())).toEqual([three, two, one]), { timeout: 5_000, interval: 20 })
      await vi.waitFor(async () => expect(await threadsOf(t)).toEqual([]), { timeout: 5_000, interval: 20 })
    })

    it('deletes a session recorded before the wire offered deletion, in a private empty folder', async () => {
      const t = await computer({}, [], { idleMs: 100 })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'echo one')
      await settled(bridge, id)
      await bridge.close()
      const file = join(t.root, 'data', 'acp.json')
      const state = JSON.parse(await readFile(file, 'utf8')) as { tasks: Record<string, { acp: Record<string, unknown> }> }
      state.tasks[id]!.acp.deletable = false
      await writeFile(file, JSON.stringify(state))
      const reopened = await t.open()
      const [thread] = await threadsOf(t)
      await reopened.remove!(id)
      await vi.waitFor(async () => expect(deleted(await t.log())).toEqual([thread]), { timeout: 5_000, interval: 20 })
      const deleting = (await t.log()).find(entry => entry.event === 'recv' && entry.method === 'thread/delete')!
      const spawned = (await t.log()).find(entry => entry.pid === deleting.pid && entry.argv) as (LogEntry & { cwd?: string }) | undefined
      expect(spawned?.cwd ?? '').not.toBe(t.main)
    })

    it('says in the Host log what Codex refused to delete, and leaves nothing half-done', async () => {
      const lines: string[] = []
      const t = await computer({ FAKE_CODEX_DELETE_FAIL: 'thread is in use by another process' }, [], {
        log: line => void lines.push(line),
      })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'echo one')
      await settled(bridge, id)
      await bridge.remove!(id)
      await vi.waitFor(() => expect(lines.join('\n')).toContain('自己保存的一份会话副本没有删除'), { timeout: 5_000, interval: 20 })
      expect(lines.join('\n')).toContain('thread is in use by another process')
      expect(await threadsOf(t)).toHaveLength(1)
      expect((await t.log()).filter(entry => entry.event === 'removed')).toEqual([])
    })

    it('never deletes a thread brought in from Codex’s own list', async () => {
      const t = await computer()
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'echo remember me')
      await settled(bridge, id)
      const original = (await threadsOf(t))[0]!
      await bridge.remove!(id)
      await vi.waitFor(async () => expect(await threadsOf(t)).toEqual([]), { timeout: 5_000, interval: 20 })
      // Brought back in from a copy of Codex's record, as a session started in its terminal would be.
      const other = `thread-terminal-${rid()}`
      await writeFile(
        join(t.root, 'threads.json'),
        JSON.stringify({
          [other]: { id: other, cwd: t.main, model: 'gpt-fake', turns: [], preview: 'from the terminal', createdAt: 1, updatedAt: 1 },
        }),
      )
      const place = { agentSessionId: other, cwd: t.main, workspaceId: 'proj', folders: [{ id: 'app', path: t.main }] }
      const load = await bridge.loadExternalSession!(place)
      const adopted = await bridge.adoptExternalSession!({
        ...place,
        sessionId: `task-${randomUUID()}`,
        loadId: load.loadId,
        title: 'Brought in',
      })
      await bridge.remove!(adopted.sessionId)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(deleted(await t.log())).toEqual([original])
      expect(await threadsOf(t)).toEqual([other])
    })
  })

  it('refuses a Codex below the floor, and offers the adapter only when Codex is not installed at all', async () => {
    const t = await computer({ FAKE_CODEX_VERSION: '0.150.0' }, ['codex-acp'])
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'echo hi'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('Codex 需要 0.156.0 或更高版本（当前 0.150.0）。升级：npm i -g @openai/codex@latest')
    // Still Codex itself: the adapter would run this same old Codex.
    expect(presetRoute('codex')?.command).toBe('codex')
    await rm(join(t.bin, 'codex'))
    forgetCommandLookups()
    expect(presetRoute('codex')).toMatchObject({ command: 'codex-acp', args: [] })
  })

  describe('Codex’s own MCP servers', () => {
    const OWN = JSON.stringify([
      {
        name: 'github',
        runtimeStatus: 'connected',
        httpOrigin: 'https://api.github.com/mcp?x=1',
        tools: { a: {}, b: {} },
        authStatus: 'bearerToken',
      },
      { name: 'linear', runtimeStatus: 'authenticationRequired', tools: {}, authStatus: 'notLoggedIn' },
      { name: 'plugin-docs', runtimeStatus: 'connected', tools: {}, authStatus: 'unsupported', threadOnly: true },
    ])

    it('reads the thread’s servers without starting any, leaves Latch’s own out, and follows each start Codex reports', async () => {
      const toolGateway: ToolGateway = {
        open: () => undefined,
        openMcp: async () => [
          {
            name: 'files',
            socketPath: '/tmp/latch-test/tools/gateway.sock',
            tokenFile: '/tmp/latch-test/tools/f.lbt',
            token: `lbt1.${'f'.repeat(43)}`,
            close() {},
          },
        ],
      }
      const t = await computer({ FAKE_CODEX_MCP: OWN }, [], {}, { toolGateway })
      const bridge = await t.open()
      expect(bridge.ownMcp?.()).toEqual({})
      await settled(bridge, await start(bridge, t.main, 'echo hi'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'github')?.state).toBe('ready'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'linear')?.state).toBe('needs-login'))
      const last = bridge.ownMcp!()!.last!
      expect(last.via).toBe('session')
      expect(last.servers.map(server => server.name).sort()).toEqual(['github', 'linear', 'plugin-docs'])
      expect(last.servers.find(server => server.name === 'github')).toMatchObject({ tools: 2, origin: 'https://api.github.com' })
      expect(last.servers.find(server => server.name === 'github')?.login).toBeUndefined()
      expect(last.servers.find(server => server.name === 'linear')?.login).toBe('codex mcp login linear')
      const log = await t.log()
      expect(sent(log, 'mcpServerStatus/list')[0]!.params).toMatchObject({ detail: 'toolsAndAuthOnly', threadId: expect.any(String) })
    })

    it('读取 asks a process with no thread, in an empty folder of its own, and keeps the names Codex gives without a state', async () => {
      const t = await computer({ FAKE_CODEX_MCP: OWN })
      const bridge = await t.open()
      await bridge.readOwnMcp!()
      const read = bridge.ownMcp!()!
      expect(read.running).toBeUndefined()
      expect(read.last).toMatchObject({ via: 'read', namesOnly: true })
      expect(read.last!.servers).toEqual([
        { name: 'github', state: 'unknown', origin: 'https://api.github.com' },
        { name: 'linear', state: 'unknown' },
      ])
      const log = await t.log()
      const listed = sent(log, 'mcpServerStatus/list')
      expect(listed).toHaveLength(1)
      expect(listed[0]!.params).not.toHaveProperty('threadId')
      const started = log.filter(entry => entry.event === 'start').at(-1) as LogEntry & { cwd: string }
      expect(started.cwd).not.toBe(t.main)
      expect(sent(log, 'thread/start')).toHaveLength(0)
    })

    const HOOKS = JSON.stringify([
      {
        key: 'managed:pre',
        eventName: 'userPromptSubmit',
        handlerType: 'command',
        command: '/opt/corp/audit --token sk-live-secret',
        source: 'mdm',
        sourcePath: '/Library/Managed Preferences/corp.plist',
        isManaged: true,
        enabled: true,
        trustStatus: 'managed',
        currentHash: 'h1',
        displayOrder: 0,
        timeoutSec: 30,
      },
      {
        key: 'user:post',
        eventName: 'postToolUse',
        handlerType: 'command',
        command: 'echo done',
        source: 'user',
        sourcePath: '/Users/someone/.codex/hooks.json',
        isManaged: false,
        enabled: false,
        trustStatus: 'untrusted',
        currentHash: 'h2',
        displayOrder: 1,
        timeoutSec: 30,
      },
    ])
    const shownHooks = [
      { event: 'userPromptSubmit', source: 'mdm', managed: true, enabled: true, trust: 'managed' },
      { event: 'postToolUse', source: 'user', managed: false, enabled: false, trust: 'untrusted' },
    ]

    it('lists the hooks Codex runs, in a 读取 and in a session’s report, with no command, path or key', async () => {
      const t = await computer({ FAKE_CODEX_MCP: OWN, FAKE_CODEX_HOOKS: HOOKS })
      const bridge = await t.open()
      await bridge.readOwnMcp!()
      expect(bridge.ownMcp!()!.last!.hooks).toEqual(shownHooks)
      expect(sent(await t.log(), 'hooks/list')[0]!.params).toEqual({})
      await settled(bridge, await start(bridge, t.main, 'echo hi'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.via).toBe('session'))
      expect(bridge.ownMcp!()!.last!.hooks).toEqual(shownHooks)
      expect(sent(await t.log(), 'hooks/list').at(-1)!.params).toEqual({ threadId: expect.any(String) })
      expect(JSON.stringify(bridge.ownMcp!())).not.toMatch(/sk-live|audit|Managed Preferences|hooks\.json|managed:pre/u)
    })

    it('names its servers and hooks before any session from the draft’s read of its configuration, starting none', async () => {
      const t = await computer({
        FAKE_CODEX_MCP: OWN,
        FAKE_CODEX_HOOKS: HOOKS,
        FAKE_CODEX_CONFIG: JSON.stringify({
          mcp_servers: {
            docs: { command: 'npx', args: ['docs-mcp'], env: { DOCS_TOKEN: 'secret-value' } },
            remote: { url: 'https://mcp.example.com/path?key=secret-value', http_headers: { Authorization: 'Bearer secret-value' } },
            off: { command: 'off-mcp', enabled: false },
          },
        }),
      })
      const bridge = await t.open()
      await bridge.readCatalogue!({ auto: true })
      const last = bridge.ownMcp!()!.last!
      expect(last).toMatchObject({ via: 'read', namesOnly: true, hooks: shownHooks })
      expect(last.servers).toEqual([
        { name: 'docs', state: 'unknown' },
        { name: 'remote', state: 'unknown', origin: 'https://mcp.example.com' },
        { name: 'off', state: 'disabled' },
      ])
      expect(JSON.stringify(last)).not.toContain('secret-value')
      // Named from the configuration: nothing asked Codex for their status, which would start them.
      expect(sent(await t.log(), 'mcpServerStatus/list')).toEqual([])
      expect(sent(await t.log(), 'thread/start')).toEqual([])
    })

    it('never replaces a session’s report with names alone', async () => {
      const t = await computer({ FAKE_CODEX_MCP: OWN })
      const bridge = await t.open()
      await settled(bridge, await start(bridge, t.main, 'echo hi'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'github')?.state).toBe('ready'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'linear')?.state).toBe('needs-login'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'plugin-docs')?.state).toBe('ready'))
      const session = bridge.ownMcp!()!.last!
      await bridge.readOwnMcp!()
      expect(bridge.ownMcp!()!.last).toEqual(session)
      expect(sent(await t.log(), 'mcpServerStatus/list').at(-1)!.params).not.toHaveProperty('threadId')
    })

    it('shows a name with hidden characters written out, and gives a login command only for a plain one Codex says needs it', () => {
      expect(codexMcpServer('evil\u202eserver', 'needs-login').name).not.toContain('\u202e')
      expect(codexMcpServer('evil\u202eserver', 'needs-login').login).toBeUndefined()
      expect(codexMcpServer('a;rm -rf ~', 'needs-login').login).toBeUndefined()
      expect(codexMcpServer('ok-name', 'failed').login).toBeUndefined()
      expect(codexMcpServer('ok-name', 'needs-login').login).toBe('codex mcp login ok-name')
      // A leading `-` would read as one of Codex's own options.
      expect(codexMcpServer('-h', 'needs-login').login).toBeUndefined()
      expect(codexMcpServer('--help', 'needs-login').login).toBeUndefined()
    })

    it('gives the whole read one deadline, not one per page', async () => {
      const cwd = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-deadline-')))
      cleanups.push(() => rm(cwd, { recursive: true, force: true }))
      const servers = JSON.stringify([1, 2, 3].map(at => ({ name: `s${at}`, runtimeStatus: 'connected', tools: {} })))
      const wire = (pageMs: string) =>
        CodexWire.spawn(
          {
            command: process.execPath,
            args: [FAKE_CODEX_APP_SERVER],
            cwd,
            env: { ...process.env, FAKE_CODEX_MCP: servers, FAKE_CODEX_MCP_LIMIT: '1', FAKE_CODEX_MCP_PAGE_MS: pageMs },
            maxLineBytes: 1 << 20,
            redact: text => text,
          },
          { request: async () => ({}), notification: () => {}, exit: () => {} },
        )
      const slow = wire('150')
      cleanups.push(() => void slow.stop('kill', 100))
      await slow.request('initialize', {}, 5_000)
      // Each page alone is well within 300 ms; the three together are not.
      await expect(slow.request(MCP_STATUS_METHOD, {}, 300)).rejects.toBeInstanceOf(RequestTimeout)
      const quick = wire('10')
      cleanups.push(() => void quick.stop('kill', 100))
      await quick.request('initialize', {}, 5_000)
      expect(((await quick.request(MCP_STATUS_METHOD, {}, 300)) as { servers: unknown[] }).servers).toHaveLength(3)
    })
  })
})
