import type { FileTrackingInput, FileTrackingResult } from '@latch/sdk'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReservedAgentEnvName, type TaskDetail } from '@latch/protocol'
import type { HarnessHostOptions, HarnessDriver, HarnessSecurityEvent, HarnessPlugin, Bridge, HostProject, ProjectFolder } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { AgentConnection, ConnectionStopping } from '../src/connection.ts'
import { agentEnvironment } from '../src/environment.ts'
import { commandName } from '../src/mapping.ts'
import { createAcpAgentPlugin, forgetCommandLookups, resolveCommand, type AcpAgentOptions, type AgentRecord } from '../src/index.ts'
import { classifyMode, filterPermissionOptions, launchHash, selectProfile, validateAgentDefinition } from '../src/permission.ts'
import { profileFor } from '../src/profiles/index.ts'
import { fingerprintProjectConfig, PROJECT_CONFIG_LIMITS } from '../src/project-config.ts'
import { initializeResult } from '../src/protocol.ts'
import { AgentHealth } from '../src/types.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000 }
const QWEN_MODES = 'plan,default,auto-edit,yolo,auto'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface LogEntry {
  pid: number
  event: string
  method?: string | null
  id?: number | string | null
  params?: Record<string, unknown>
  result?: { outcome?: Record<string, unknown> } & Record<string, unknown>
  [key: string]: unknown
}

let requests = 0
const rid = () => `request-${++requests}`

async function activate(plugin: HarnessPlugin): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: driver => {
      drivers.push(driver)
    },
    registerProvider: () => {
      throw new Error('unexpected provider')
    },
    registerTool: () => {
      throw new Error('unexpected tool')
    },
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {
      throw new Error('unexpected panel')
    },
    onDispose: dispose => {
      disposers.push(dispose)
    },
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]
}

/** An executable file (a shell script that does nothing) at `directory/command`, made with its directories. */
async function installCommand(directory: string, command: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, command), '#!/bin/sh\n')
  await chmod(join(directory, command), 0o755)
  return join(directory, command)
}

/** Sets Host environment variables for one test. */
function hostEnv(values: Record<string, string>): void {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  cleanups.push(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function setup(
  env: Record<string, string> = {},
  options: AcpAgentOptions = {},
  overrides: Partial<AgentRecord> = {},
  attachmentOptions: Pick<HarnessHostOptions, 'readAttachment' | 'saveAttachment' | 'trackFiles' | 'clock'> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'latch-acp-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(tmpRoot, { mode: 0o700 })
  const logFile = join(root, 'agent.log')
  const stateFile = join(root, 'agent-state.json')
  const record: AgentRecord = {
    id: 'fake',
    name: 'Fake',
    command: process.execPath,
    args: [FAKE_ACP_AGENT],
    enabled: true,
    env: { FAKE_ACP_STATE: stateFile, FAKE_ACP_LOG: logFile, FAKE_ACP_STORE: join(dataDir, 'acp.json'), ...env },
    ...overrides,
  }
  /** What the driver wrote to the owner-only Host log. */
  const diagnostics: string[] = []
  const events: HarnessSecurityEvent[] = []
  const build = (definition: AgentRecord) =>
    activate(
      createAcpAgentPlugin(definition, {
        ...FAST,
        log: text => {
          diagnostics.push(text)
        },
        ...options,
      }),
    )
  const driver = await build(record)
  async function openWith(target: HarnessDriver, workspaces?: () => string[], projects?: () => HostProject[]): Promise<Bridge> {
    const bridge = target.create({
      ...attachmentOptions,
      dataDir,
      workspaceRoot: workspace,
      tmpRoot,
      ...(workspaces ? { workspaces } : {}),
      ...(projects ? { projects } : {}),
      providerId: 'unused',
      registry: {
        acquire() {
          throw new Error('ACP sessions do not lease Host providers')
        },
      },
      securityEvent: event => {
        events.push(event)
      },
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    // Stands in for the Host's local confirmation: the launch fingerprint of the preview, unless a test passes its own.
    const create = bridge.createTask.bind(bridge)
    bridge.createTask = async input =>
      'expectedLaunchHash' in input
        ? create(input)
        : create({
            ...input,
            expectedLaunchHash: (
              await bridge.launchPreview!({
                cwd: input.cwd ?? workspace,
                ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
                ...(input.folders ? { folders: input.folders } : {}),
              })
            ).launchHash,
          })
    return bridge
  }
  return {
    root,
    workspace,
    dataDir,
    tmpRoot,
    record,
    driver,
    diagnostics,
    events,
    async agentSessions(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as Record<string, unknown>
    },
    open: (workspaces?: () => string[], projects?: () => HostProject[]) => openWith(driver, workspaces, projects),
    /** The same data directory under a changed definition. */
    async redefine(changes: Partial<AgentRecord>): Promise<Bridge> {
      return openWith(await build({ ...record, ...changes }))
    },
    async log(): Promise<LogEntry[]> {
      const text = await readFile(logFile, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
    },
  }
}

/** A preset profile applied to the fake agent: selected by presetId, so not a verified definition. */
function preset(presetId: string, env: Record<string, string> = {}, options: AcpAgentOptions = {}) {
  return setup(env, options, { presetId })
}

function received(log: LogEntry[], method: string | null): LogEntry[] {
  return log.filter(entry => entry.event === 'recv' && entry.method === method)
}

async function until(bridge: Bridge, id: string, predicate: (detail: TaskDetail) => boolean): Promise<TaskDetail> {
  await vi.waitFor(async () => expect(predicate(await bridge.detail(id))).toBe(true), { timeout: 8_000, interval: 10 })
  return bridge.detail(id)
}

function settled(bridge: Bridge, id: string): Promise<TaskDetail> {
  return until(bridge, id, detail => detail.summary.status !== 'running' && detail.summary.status !== 'waiting-approval')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const assistants = (detail: TaskDetail) => detail.messages.filter(message => message.role === 'assistant')
const systemText = (detail: TaskDetail) =>
  detail.messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join('\n')
const tool = (detail: TaskDetail, id: string) => detail.messages.find(message => message.id === id)
const userTexts = (detail: TaskDetail) => detail.messages.filter(message => message.role === 'user').map(message => message.text)
/** pid of the process that received the prompt starting with `text`. */
const promptPid = (log: LogEntry[], text: string) =>
  received(log, 'session/prompt').find(entry => (entry.params?.prompt as Array<{ text: string }>)[0].text.startsWith(text))!.pid
const answers = (log: LogEntry[]) => log.filter(entry => entry.event === 'permission-answer').map(entry => entry.outcome)

describe('real ACP attachment exchange', () => {
  it('passes image and embedded text blocks after negotiation and persists Agent image refs across restart', async () => {
    const inputRef = {
      id: 'abcdefghijklmnopqrstuv',
      name: 'image.png',
      kind: 'image' as const,
      mime: 'image/png' as const,
      size: 4,
      sha256: 'a'.repeat(64),
    }
    const outputRef = { ...inputRef, id: 'zyxwvutsrqponmlkjihgfe', name: 'Agent-image.png' }
    const saved: unknown[] = []
    const fixture = await setup(
      { FAKE_ACP_CAPS: 'images,embedded,resume' },
      {},
      {},
      {
        readAttachment: async () => ({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }),
        saveAttachment: async input => {
          saved.push(input)
          return outputRef
        },
      },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'image-output', requestId: rid(), attachments: [inputRef] })
    const detail = await settled(bridge, sessionId)
    expect(detail.messages[0]!.attachments).toEqual([inputRef])
    expect(detail.messages.find(message => message.role === 'assistant' && message.attachments)?.attachments).toEqual([outputRef])
    expect(saved).toEqual([
      {
        sessionId,
        mime: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=',
      },
    ])
    const request = received(await fixture.log(), 'session/prompt')[0]!
    expect((request.params?.prompt as Array<{ type: string }>).map(block => block.type)).toEqual(['text', 'image'])
    expect(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).not.toContain(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=',
    )
    await bridge.close()
    const reopened = await fixture.open()
    expect((await reopened.detail(sessionId)).messages[0]!.attachments).toEqual([inputRef])
  })
})

describe('ACP driver registration and readiness', () => {
  it('registers one agent-mode driver and reports missing commands without spawning anything', async () => {
    expect(resolveCommand(process.execPath)).toBe(process.execPath)
    expect(resolveCommand('node')).toMatch(/node(\.exe)?$/)
    expect(resolveCommand('latch-no-such-agent')).toBeUndefined()
    expect(resolveCommand('./node')).toBeUndefined()
    expect(resolveCommand('')).toBeUndefined()

    const plugin = createAcpAgentPlugin({
      id: 'missing',
      name: 'Missing',
      presetId: 'codex',
      command: 'latch-no-such-agent',
      args: [],
      env: {},
      enabled: true,
    })
    expect(plugin.id).toBe('agent-missing')
    const driver = await activate(plugin)
    expect(driver).toMatchObject({ id: 'missing', name: 'Missing', capabilities: { modes: ['agent'], models: 'agent' } })
    const status = driver.status?.()
    expect(status?.status).toBe('unavailable')
    expect(status?.statusMessage).toContain('latch-no-such-agent')
    expect(status?.statusMessage).toContain('npm i -g @agentclientprotocol/codex-acp')

    const { driver: present } = await setup()
    expect(present.status?.()).toEqual({ status: 'ready' })
    // Pickers show a short command line; the full paths stay in the agent settings.
    expect(present.description).toBe('通过 ACP 运行 node fake-acp-agent.mjs；模型、登录与工具权限由该 Harness 自身管理。')
  })

  it('finds commands in the global bin directories of Node version and package managers in the home directory', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'latch-acp-home-')))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const custom = join(home, 'custom-fnm')
    const pnpmHome = join(home, 'pnpm-home')
    hostEnv({ HOME: home, PATH: '/usr/bin:/bin', FNM_DIR: '', PNPM_HOME: '' })
    const install = installCommand
    const layouts: Array<[string, string]> = [
      [join(home, '.local/share/fnm/aliases/default/bin'), 'agent-fnm'],
      [join(home, '.volta/bin'), 'agent-volta'],
      [join(home, '.asdf/shims'), 'agent-asdf'],
      [join(home, '.local/share/mise/shims'), 'agent-mise'],
      [join(home, 'Library/pnpm'), 'agent-pnpm'],
      [join(home, '.yarn/bin'), 'agent-yarn'],
    ]
    for (const [directory, command] of layouts) {
      expect(resolveCommand(command)).toBeUndefined()
      await install(directory, command)
      expect(resolveCommand(command)).toBe(join(directory, command))
    }

    // fnm's and pnpm's directories may be moved by a variable, which counts only as an absolute path.
    const moved = await install(join(custom, 'aliases/default/bin'), 'agent-fnm-moved')
    const pnpmMoved = await install(pnpmHome, 'agent-pnpm-moved')
    hostEnv({ FNM_DIR: 'custom-fnm', PNPM_HOME: 'pnpm-home' })
    expect(resolveCommand('agent-fnm-moved')).toBeUndefined()
    expect(resolveCommand('agent-pnpm-moved')).toBeUndefined()
    hostEnv({ FNM_DIR: custom, PNPM_HOME: pnpmHome })
    expect(resolveCommand('agent-fnm-moved')).toBe(moved)
    expect(resolveCommand('agent-pnpm-moved')).toBe(pnpmMoved)

    // nvm's default alias, followed through aliases such as lts/*, names the version whose bin is searched.
    const nvm = join(home, '.nvm')
    await install(join(nvm, 'versions/node/v20.11.1/bin'), 'agent-nvm-old')
    const newest = await install(join(nvm, 'versions/node/v22.12.0/bin'), 'agent-nvm')
    await install(join(nvm, 'versions/node/v22.3.0/bin'), 'agent-nvm-older')
    await mkdir(join(nvm, 'alias/lts'), { recursive: true })
    await writeFile(join(nvm, 'alias/default'), 'lts/*\n')
    await writeFile(join(nvm, 'alias/lts/*'), 'lts/jod\n')
    await writeFile(join(nvm, 'alias/lts/jod'), 'v22\n')
    expect(resolveCommand('agent-nvm')).toBe(newest)
    expect(resolveCommand('agent-nvm-old')).toBeUndefined()
    expect(resolveCommand('agent-nvm-older')).toBeUndefined()
    await writeFile(join(nvm, 'alias/default'), '20\n')
    expect(resolveCommand('agent-nvm-old')).toBe(join(nvm, 'versions/node/v20.11.1/bin/agent-nvm-old'))
    await writeFile(join(nvm, 'alias/default'), '../../versions/node/v22.12.0\n')
    expect(resolveCommand('agent-nvm')).toBeUndefined()

    // A file that is not executable, and a directory with the command's name, are not commands.
    await writeFile(join(home, '.volta/bin/not-executable'), 'x')
    await mkdir(join(home, '.yarn/bin/a-directory'))
    expect(resolveCommand('not-executable')).toBeUndefined()
    expect(resolveCommand('a-directory')).toBeUndefined()
  })

  it('says which part of an adapter preset is missing, and looks again after a re-check', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'latch-acp-home-')))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const bin = join(home, '.volta/bin')
    await mkdir(bin, { recursive: true })
    hostEnv({ HOME: home, PATH: '/usr/bin:/bin' })
    const driver = await activate(
      createAcpAgentPlugin({ id: 'pi', name: 'pi', presetId: 'pi', command: 'pi-acp', args: [], env: {}, enabled: true }),
    )
    const install = (command: string) => installCommand(bin, command)
    expect(driver.status?.()).toEqual({ status: 'unavailable', statusMessage: '未找到 pi 和它的适配器 pi-acp。安装：npm i -g pi-acp' })
    await install('pi')
    // The lookup is cached for a few seconds; a re-check drops it.
    forgetCommandLookups()
    expect(driver.status?.()).toEqual({
      status: 'unavailable',
      statusMessage: '已安装 pi，还差让 Latch 连接它的适配器 pi-acp。安装：npm i -g pi-acp',
    })
    await install('pi-acp')
    expect(driver.status?.().status).toBe('unavailable')
    forgetCommandLookups()
    expect(driver.status?.()).toEqual({ status: 'ready' })
    await rm(join(bin, 'pi'))
    forgetCommandLookups()
    expect(driver.status?.()).toEqual({
      status: 'unavailable',
      statusMessage: '已找到适配器 pi-acp，还没找到 pi',
    })
  })

  it('refuses definitions that set variables Latch manages', () => {
    for (const name of [
      'PATH',
      'HOME',
      'TMPDIR',
      'NODE_OPTIONS',
      'HTTPS_PROXY',
      'http_proxy',
      'Https_Proxy',
      'LATCH_API_KEY',
      'latch_data_dir',
      'npm_config_registry',
      'NPM_CONFIG_REGISTRY',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_PARAMETERS',
      'INITIAL_AGENT_MODE',
      'GOOSE_MODE',
      'DSH_PERMISSION_MODE',
      'OPENCODE_CONFIG_CONTENT',
      'PI_ACP_PI_COMMAND',
      'CODEX_HOME',
      'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_EXTRA_CA_CERTS',
      // Each of these makes OpenCode load permission rules from somewhere else.
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_DIR',
      'OPENCODE_PERMISSION',
      'OPENCODE_TEST_HOME',
      'opencode_permission',
    ]) {
      expect(isReservedAgentEnvName(name), name).toBe(true)
    }
    for (const name of ['OPENAI_API_KEY', 'FAKE_SECRET', 'MY_LD_PATH', 'MY_LATCH_KEY', 'GIT_AUTHOR_NAME', 'LANG'])
      expect(isReservedAgentEnvName(name), name).toBe(false)

    const record: AgentRecord = {
      id: 'goose',
      name: 'goose',
      presetId: 'goose',
      command: 'goose',
      args: ['acp'],
      env: { GOOSE_MODE: 'auto' },
      enabled: true,
    }
    const result = validateAgentDefinition(record)
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatchObject({
        status: 400,
        code: 'agent-env-reserved',
        message: '环境变量 GOOSE_MODE 由 Latch 管理，不能在 Agent 定义中设置',
      })
    expect(() => createAcpAgentPlugin(record)).toThrow(expect.objectContaining({ code: 'agent-env-reserved' }))
    expect(validateAgentDefinition({ ...record, env: { LATCH_API_KEY: 'x' } })).toMatchObject({
      ok: false,
      error: { code: 'agent-env-reserved', message: '环境变量 LATCH_API_KEY 由 Latch 管理，不能在 Agent 定义中设置' },
    })
    expect(validateAgentDefinition({ ...record, env: { GOOSE_PROVIDER: 'x' } })).toEqual({ ok: true, verified: true })
  })

  it('selects profiles by preset or command name and verifies only exact preset launches', () => {
    const base = { id: 'a', name: 'A', env: {}, enabled: true }
    expect(selectProfile({ ...base, presetId: 'codex', command: 'codex-acp', args: [] })).toMatchObject({
      verified: true,
      profile: { presetId: 'codex' },
      preset: { id: 'codex' },
    })
    // An absolute path counts only where the Host's own lookup finds the preset's command (see the next test).
    expect(selectProfile({ ...base, presetId: 'codex', command: '/opt/homebrew/bin/codex-acp', args: [] }, () => undefined).verified).toBe(
      false,
    )
    expect(selectProfile({ ...base, presetId: 'gemini', command: 'gemini', args: ['--acp'] })).toMatchObject({
      verified: false,
      profile: { presetId: 'gemini' },
    })
    expect(selectProfile({ ...base, command: '/usr/local/bin/goose', args: ['acp'] })).toMatchObject({
      verified: false,
      profile: { presetId: 'goose' },
    })
    expect(selectProfile({ ...base, presetId: 'qwen', command: process.execPath, args: [FAKE_ACP_AGENT] })).toMatchObject({
      verified: false,
      profile: { presetId: 'qwen' },
    })
    const unknown = selectProfile({ ...base, command: 'mystery-agent', args: [] })
    expect(unknown).toEqual({ verified: false })
  })

  it("verifies a preset's command only at the location the Host finds it, never a same-named file elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-preset-command-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const make = async (directory: string) => {
      await mkdir(join(root, directory), { recursive: true })
      const path = join(root, directory, 'codex-acp')
      await writeFile(path, '#!/bin/sh\n')
      await chmod(path, 0o755)
      return path
    }
    const found = await make('bin')
    const planted = await make('project/node_modules/.bin')
    await mkdir(join(root, 'links'))
    const link = join(root, 'links', 'codex-acp')
    await symlink(found, link)
    const locate = (command: string) => (command === 'codex-acp' ? found : undefined)
    const record = { id: 'codex', name: 'Codex', presetId: 'codex', args: [], env: {}, enabled: true }
    expect(selectProfile({ ...record, command: 'codex-acp' }, locate).verified).toBe(true)
    expect(selectProfile({ ...record, command: found }, locate).verified).toBe(true)
    // A link to the file the lookup finds is the same executable.
    expect(selectProfile({ ...record, command: link }, locate).verified).toBe(true)
    expect(selectProfile({ ...record, command: planted }, locate)).toMatchObject({ verified: false, preset: { id: 'codex' } })
    expect(validateAgentDefinition({ ...record, command: planted }, locate)).toEqual({ ok: true, verified: false })
    // Nothing found under the preset's name: no absolute path can be the preset's own.
    expect(selectProfile({ ...record, command: found }, () => undefined).verified).toBe(false)
  })

  it('does not verify an OpenCode definition whose variables move where OpenCode reads its configuration', () => {
    const record: AgentRecord = {
      id: 'oc',
      name: 'OpenCode',
      presetId: 'opencode',
      command: 'opencode',
      args: ['acp'],
      env: {},
      enabled: true,
    }
    expect(selectProfile(record)).toMatchObject({ verified: true, profile: { presetId: 'opencode' } })
    expect(selectProfile(record).notes).toBeUndefined()
    expect(validateAgentDefinition({ ...record, env: { OPENAI_API_KEY: 'x' } })).toEqual({ ok: true, verified: true })
    for (const name of [
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'xdg_config_home',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'USERPROFILE',
    ]) {
      expect(validateAgentDefinition({ ...record, env: { [name]: '/tmp/elsewhere' } }), name).toEqual({ ok: true, verified: false })
      const selection = selectProfile({ ...record, env: { [name]: '/tmp/elsewhere', OPENAI_API_KEY: 'x' } })
      expect(selection.verified, name).toBe(false)
      expect(selection.notes, name).toEqual([
        `定义设置了 ${name}，OpenCode 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设`,
      ])
    }
    expect(selectProfile({ ...record, env: { XDG_DATA_HOME: '/a', XDG_CONFIG_HOME: '/b' } }).notes?.[0]).toContain(
      'XDG_CONFIG_HOME、XDG_DATA_HOME',
    )
    // A custom definition running the OpenCode command gets the same notes; other presets do not read these variables for permissions.
    expect(
      selectProfile({ ...record, presetId: undefined, args: ['acp', '--print-logs'], env: { XDG_CONFIG_HOME: '/b' } }).notes,
    ).toHaveLength(1)
    expect(
      selectProfile({
        id: 'g',
        name: 'goose',
        presetId: 'goose',
        command: 'goose',
        args: ['acp'],
        env: { XDG_CONFIG_HOME: '/b' },
        enabled: true,
      }),
    ).toMatchObject({ verified: true })
  })

  it('fingerprints the command, arguments, variable names and values, preset and profile version', () => {
    const input = {
      resolvedCommand: '/usr/bin/agent',
      args: ['acp'],
      definitionEnv: { B: '2', A: '1' },
      presetId: 'goose',
      profileVersion: 1 as const,
    }
    const hash = launchHash(input)
    expect(hash).toBe(
      sha256Hex(
        canonicalJson({
          v: 1,
          command: '/usr/bin/agent',
          args: ['acp'],
          envNames: ['A', 'B'],
          envValues: sha256Hex(canonicalJson({ A: '1', B: '2' })),
          presetId: 'goose',
          profileVersion: 1,
        }),
      ),
    )
    expect(launchHash({ ...input, definitionEnv: { A: '1', B: '2' } })).toBe(hash)
    for (const changed of [
      { resolvedCommand: '/opt/agent' },
      { args: ['acp', '--yolo'] },
      { definitionEnv: { A: '1', B: '3' } },
      { presetId: undefined },
    ])
      expect(launchHash({ ...input, ...changed })).not.toBe(hash)
  })

  it('classifies modes against the expected one with the preset ladder', () => {
    const qwen = profileFor('qwen')!.permission
    expect(classifyMode(qwen, 'default', 'default')).toBe('neutral')
    expect(classifyMode(qwen, 'default', 'plan')).toBe('stricter')
    expect(classifyMode(qwen, 'default', 'auto-edit')).toBe('wider')
    expect(classifyMode(qwen, 'default', 'yolo')).toBe('wider')
    expect(classifyMode(qwen, 'default', 'auto')).toBe('forbidden')
    expect(classifyMode(qwen, 'default', 'turbo')).toBe('wider')
    expect(classifyMode(qwen, undefined, 'plan')).toBe('wider')
    expect(classifyMode(undefined, 'build', 'build')).toBe('neutral')
    expect(classifyMode(undefined, 'build', 'plan')).toBe('wider')
    expect(classifyMode(profileFor('dsh')!.permission, 'x', 'y')).toBe('wider')
  })

  it('keeps only one-time options that the profile does not hide', () => {
    const option = (optionId: string, kind: string) => ({ optionId, name: optionId, kind })
    expect(
      filterPermissionOptions(undefined, [
        option('a', 'allow_once'),
        option('A', 'allow_always'),
        option('r', 'reject_once'),
        option('R', 'reject_always'),
      ]),
    ).toEqual({ visible: [option('a', 'allow_once'), option('r', 'reject_once')] })
    expect(
      filterPermissionOptions(undefined, [option('A', 'allow_always'), option('R', 'reject_always'), option('r', 'reject_once')]),
    ).toEqual({ visible: [option('r', 'reject_once')], autoReject: { reason: 'persistent-only', optionId: 'r' } })
    expect(filterPermissionOptions(undefined, [option('A', 'allow_always')])).toEqual({
      visible: [],
      autoReject: { reason: 'persistent-only' },
    })
    expect(filterPermissionOptions(undefined, [option('w', 'allow_folder'), option('r', 'reject_once')])).toEqual({
      visible: [option('r', 'reject_once')],
      autoReject: { reason: 'unknown-kind', optionId: 'r' },
    })
    const codex = profileFor('codex')!.permission
    expect(
      filterPermissionOptions(codex, [
        option('approved', 'allow_once'),
        option('accept_execpolicy_amendment', 'allow_once'),
        option('apply_network_policy_amendment-x', 'allow_once'),
        option('abort', 'reject_once'),
      ]),
    ).toEqual({ visible: [option('approved', 'allow_once'), option('abort', 'reject_once')] })
    expect(filterPermissionOptions(codex, [option('accept_execpolicy_amendment', 'allow_once'), option('abort', 'reject_once')])).toEqual({
      visible: [option('abort', 'reject_once')],
      autoReject: { reason: 'persistent-only', optionId: 'abort' },
    })
  })
})

describe('ACP agent environment', () => {
  it('puts the directory of a command found outside PATH first, so its shim finds the interpreter beside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-acp-path-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const oldBin = join(root, 'old-bin')
    const agentBin = join(root, 'agent-bin')
    await mkdir(oldBin)
    await mkdir(agentBin)
    await writeFile(join(oldBin, 'node'), '#!/bin/sh\necho old node >&2\nexit 7\n')
    await chmod(join(oldBin, 'node'), 0o755)
    await symlink(process.execPath, join(agentBin, 'node'))
    const agent = join(agentBin, 'my-agent')
    await writeFile(agent, '#!/usr/bin/env node\nprocess.stdout.write("ok")\n')
    await chmod(agent, 0o755)
    const environment = (command: string, path: string) =>
      agentEnvironment({ resolvedCommand: command, definitionEnv: {}, sessionTmpDir: root, hostEnv: { PATH: path } })

    const env = environment(resolveCommand(agent)!, [oldBin, 'relative/bin', '/usr/bin', '/bin'].join(delimiter))
    expect(env.PATH.split(delimiter).slice(0, 2)).toEqual([agentBin, oldBin])
    expect(env.PATH.split(delimiter).every(entry => isAbsolute(entry))).toBe(true)
    const run = spawnSync(agent, [], { env, encoding: 'utf8' })
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: 'ok' })

    // A command found on PATH keeps the order a terminal would use.
    hostEnv({ PATH: [oldBin, agentBin, '/usr/bin', '/bin'].join(delimiter) })
    expect(environment(resolveCommand('my-agent')!, process.env.PATH!).PATH.split(delimiter).slice(0, 2)).toEqual([oldBin, agentBin])
  })

  it('applies the definition, then the profile, then the forced values, and removes loader and npm variables', () => {
    const env = agentEnvironment({
      resolvedCommand: '/usr/bin/true',
      profile: profileFor('goose')!.permission,
      materializedEnv: { EXTRA_PATH_FILE: '/data/x.json', LATCH_DATA_DIR: '/data' },
      definitionEnv: {
        GOOSE_MODE: 'auto',
        HTTPS_PROXY: 'http://proxy.invalid',
        GOOSE_PROVIDER: 'openai',
        LD_PRELOAD: '/x.so',
        LATCH_API_KEY: 'definition-key',
      },
      sessionTmpDir: '/tmp/latch-session',
      hostEnv: {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'UTF-8',
        TERM: 'xterm',
        USER: 'me',
        SHELL: '/bin/zsh',
        AWS_SECRET_ACCESS_KEY: 'aws',
        OPENAI_BASE_URL: 'http://127.0.0.1:1',
        SSL_CERT_FILE: '/tmp/ca.pem',
        TMPDIR: '/var/tmp',
        NODE_OPTIONS: '--inspect',
        LATCH_API_KEY: 'host-key',
        LATCH_BASE_URL: 'http://127.0.0.1:2',
      },
    })
    expect(env).toEqual({
      PATH: expect.stringMatching(/^\/usr\/bin/),
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm',
      USER: 'me',
      SHELL: '/bin/zsh',
      GOOSE_MODE: 'approve',
      GOOSE_PROVIDER: 'openai',
      EXTRA_PATH_FILE: '/data/x.json',
      TMPDIR: '/tmp/latch-session',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      no_proxy: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
      NODE_EXTRA_CA_CERTS: '',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'safe.bareRepository',
      GIT_CONFIG_VALUE_2: 'explicit',
    })
  })

  it('starts every session in its own process with an allowlisted environment and a private TMPDIR', async () => {
    hostEnv({
      AWS_SECRET_ACCESS_KEY: 'aws-secret-value-1234',
      NODE_OPTIONS: '--max-old-space-size=4096',
      LATCH_API_KEY: 'latch-key-value-1234',
      LATCH_DATA_DIR: '/latch/data',
      latch_model: 'latch-model',
      npm_config_x: 'npm-x',
      DYLD_X: 'dyld-x',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      SSL_CERT_FILE: '/tmp/latch-ca.pem',
      OPENAI_BASE_URL: 'http://127.0.0.1:9',
      LANG: 'en_US.UTF-8',
      PATH: `relative/bin${delimiter}${process.env.PATH ?? ''}`,
    })
    const fixture = await setup({ FAKE_ACP_DUMP_ENV: '1', FAKE_SECRET: 'configured' })
    const bridge = await fixture.open()
    const first = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    const second = await bridge.createTask({ prompt: 'echo two', requestId: rid() })
    await settled(bridge, first.sessionId)
    await settled(bridge, second.sessionId)

    const log = await fixture.log()
    const dumps = log.filter(entry => entry.event === 'env').map(entry => entry.env as Record<string, string>)
    expect(dumps).toHaveLength(2)
    expect(new Set(log.filter(entry => entry.event === 'start').map(entry => entry.pid)).size).toBe(2)
    expect(promptPid(log, 'echo one')).not.toBe(promptPid(log, 'echo two'))
    for (const env of dumps) {
      for (const name of [
        'AWS_SECRET_ACCESS_KEY',
        'NODE_OPTIONS',
        'LATCH_API_KEY',
        'LATCH_DATA_DIR',
        'latch_model',
        'npm_config_x',
        'DYLD_X',
        'SSL_CERT_FILE',
        'OPENAI_BASE_URL',
      ]) {
        expect(env[name], name).toBeUndefined()
      }
      expect(env).toMatchObject({
        HTTPS_PROXY: '',
        https_proxy: '',
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        NODE_EXTRA_CA_CERTS: '',
        LANG: 'en_US.UTF-8',
        FAKE_SECRET: 'configured',
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_1: 'core.hooksPath',
        GIT_CONFIG_VALUE_1: '/dev/null',
      })
      expect(env.PATH.split(delimiter).every(entry => isAbsolute(entry))).toBe(true)
      expect(env.TMPDIR.startsWith(`${fixture.tmpRoot}/`)).toBe(true)
      expect((await stat(env.TMPDIR)).mode & 0o777).toBe(0o700)
    }
    expect(dumps[0].TMPDIR).not.toBe(dumps[1].TMPDIR)
    expect(log.filter(entry => entry.event === 'start').map(entry => entry.latchEnv)).toEqual([[], []])
    expect(JSON.stringify(dumps)).not.toContain('latch-key-value-1234')
    expect(JSON.stringify(await bridge.detail(first.sessionId))).not.toContain('aws-secret-value-1234')

    // Removing a session stops its process and deletes its TMPDIR.
    const removedPid = promptPid(log, 'echo one')
    const removedTmp = log.find(entry => entry.event === 'start' && entry.pid === removedPid)!.tmpdir as string
    await bridge.remove!(first.sessionId)
    await vi.waitFor(
      async () => {
        expect(alive(removedPid)).toBe(false)
        await expect(stat(removedTmp)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 5_000, interval: 20 },
    )
    expect(alive(promptPid(log, 'echo two'))).toBe(true)
  })

  it('advertises no client file system or terminal', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'probe', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(assistants(detail).at(-1)?.text).toBe('fs:-32601')

    await bridge.prompt(sessionId, 'echo a b c', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo a b c')

    const log = await fixture.log()
    expect(log.find(entry => entry.event === 'start')).toMatchObject({ latchEnv: [] })
    expect(log.some(entry => entry.event === 'raw-separator')).toBe(false)
    expect(received(log, 'initialize')[0].params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'latch', title: 'Latch', version: expect.any(String) },
    })
    expect(received(log, 'session/new')[0].params).toEqual({ cwd: fixture.workspace, mcpServers: [] })
    expect(received(log, 'authenticate')).toEqual([])
  })

  it('rejects chat mode and directories outside the Host workspaces', async () => {
    const fixture = await setup()
    const other = join(fixture.root, 'other')
    await mkdir(other)
    const bridge = await fixture.open(() => [fixture.workspace, other])
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), mode: 'chat' })).rejects.toMatchObject({
      status: 400,
      code: 'mode-unsupported',
    })
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), cwd: fixture.root })).rejects.toMatchObject({
      status: 400,
      code: 'workspace-unavailable',
    })
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid(), cwd: other })
    expect((await settled(bridge, sessionId)).summary).toMatchObject({ status: 'idle', cwd: other })
    expect(received(await fixture.log(), 'session/new')[0].params?.cwd).toBe(other)
  })

  it('limits processes per definition, stopping the least recently used idle resumable one', async () => {
    const resumable = await setup({ FAKE_ACP_CAPS: 'resume' }, { maxProcesses: 1 })
    const bridge = await resumable.open()
    const first = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, first.sessionId)
    const second = await bridge.createTask({ prompt: 'echo two', requestId: rid() })
    expect((await settled(bridge, second.sessionId)).summary.status).toBe('idle')
    let log = await resumable.log()
    const firstPid = promptPid(log, 'echo one')
    expect(log.some(entry => entry.event === 'stdin-end' && entry.pid === firstPid)).toBe(true)
    await bridge.prompt(first.sessionId, 'echo three', rid())
    expect(assistants(await settled(bridge, first.sessionId)).at(-1)?.text).toBe('echo: echo three')
    log = await resumable.log()
    expect(received(log, 'session/resume')).toHaveLength(1)
    expect(log.some(entry => entry.event === 'stdin-end' && entry.pid === promptPid(log, 'echo two'))).toBe(true)

    // Sessions that cannot be restored keep their process, so a new one has to wait.
    const pinned = await setup({}, { maxProcesses: 1 })
    const kept = await pinned.open()
    const a = await kept.createTask({ prompt: 'echo a', requestId: rid() })
    await settled(kept, a.sessionId)
    const b = await kept.createTask({ prompt: 'echo b', requestId: rid() })
    const refused = await settled(kept, b.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('同时运行的 Fake 会话过多，请先结束一些会话')
    await expect(kept.prompt(b.sessionId, 'echo b again', rid())).rejects.toMatchObject({ status: 503, code: 'agent-busy' })
    await kept.remove!(a.sessionId)
    await vi.waitFor(async () => expect(alive(promptPid(await pinned.log(), 'echo a'))).toBe(false), { timeout: 5_000, interval: 20 })
    await kept.prompt(b.sessionId, 'echo b again', rid())
    expect(assistants(await settled(kept, b.sessionId)).at(-1)?.text).toBe('echo: echo b again')
  })
})

describe('ACP launch confirmation', () => {
  it('starts a session only with the launch fingerprint the owner confirmed', async () => {
    const fixture = await setup({ FAKE_SECRET: 'top-secret-value' })
    const bridge = await fixture.open()
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), expectedLaunchHash: undefined })).rejects.toMatchObject({
      status: 409,
      code: 'l3-confirmation-missing',
      message: '此会话没有经过本机确认，不能启动。',
    })
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), expectedLaunchHash: 'f'.repeat(64) })).rejects.toMatchObject({
      status: 409,
      code: 'agent-definition-changed',
    })
    expect(await bridge.listTasks()).toEqual([])
    expect(await fixture.log()).toEqual([])

    const preview = await bridge.launchPreview!({ cwd: fixture.workspace })
    expect(preview).toEqual({
      launchHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      // Without project configuration the two fingerprints are the same.
      definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      cwd: await realpath(fixture.workspace),
      envNames: expect.arrayContaining(['FAKE_SECRET', 'FAKE_ACP_LOG', 'PATH', 'TMPDIR', 'HTTPS_PROXY', 'GIT_CONFIG_COUNT']),
      // Only what the definition sets, for the system sheet; the launch environment's own names stay out.
      definitionEnvNames: Object.keys(fixture.record.env).sort(),
      verified: false,
      approvals: 'prompts',
      readback: 'none',
      notes: [],
    })
    expect(preview.envNames).toEqual([...preview.envNames].sort())
    expect(JSON.stringify(preview)).not.toContain('top-secret-value')
    expect(preview.launchHash).toBe(
      launchHash({ resolvedCommand: process.execPath, args: [FAKE_ACP_AGENT], definitionEnv: fixture.record.env, profileVersion: 1 }),
    )
    expect(preview.definitionHash).toBe(preview.launchHash)

    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid(), expectedLaunchHash: preview.launchHash })
    const detail = await settled(bridge, sessionId)
    expect(detail.permission).toEqual({
      level: 'L3',
      enforcer: 'NONE',
      readback: 'none',
      verifiedDefinition: false,
      approvals: 'prompts',
      notes: [],
    })
    const stored = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8'))
    expect(stored.tasks[sessionId].acp.launchHash).toBe(preview.launchHash)
  })

  it('refuses to continue a session after its definition changed', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' })
    const first = await fixture.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, sessionId)
    await first.close()

    const changed = await fixture.redefine({ env: { ...fixture.record.env, FAKE_EXTRA: '1' } })
    await expect(changed.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject({ status: 409, code: 'agent-definition-changed' })
    const detail = await changed.detail(sessionId)
    expect(userTexts(detail)).toEqual(['echo one'])
    expect(received(await fixture.log(), 'session/resume')).toEqual([])
    // New sessions under the changed definition need a new confirmation.
    const fresh = await changed.createTask({ prompt: 'echo three', requestId: rid() })
    expect((await settled(changed, fresh.sessionId)).summary.status).toBe('idle')
  })

  it('keeps sessions created before launch confirmation read-only', async () => {
    const fixture = await setup()
    await mkdir(fixture.dataDir, { recursive: true })
    const updatedAt = new Date(0).toISOString()
    await writeFile(
      join(fixture.dataDir, 'acp.json'),
      JSON.stringify({
        version: 1,
        tasks: {
          old: {
            summary: { id: 'old', title: 'old', status: 'idle', updatedAt, cwd: fixture.workspace, mode: 'agent' },
            messages: [{ id: 'u', role: 'user', text: 'old' }],
            config: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                currentValue: 'small',
                options: [
                  { value: 'small', name: 'Small' },
                  { value: 'large', name: 'Large' },
                ],
              },
            ],
            revision: 1,
            acp: { acpSessionId: 'sess-old', cwd: fixture.workspace, turnSeq: 1 },
          },
        },
        receipts: {},
      }),
    )
    const bridge = await fixture.open()
    const missing = {
      status: 409,
      code: 'l3-confirmation-missing',
      message: '此会话创建于安全升级之前，不能继续。请新建会话（需要本机确认）。',
    }
    await expect(bridge.prompt('old', 'echo again', rid())).rejects.toMatchObject(missing)
    await expect(bridge.setConfig!('old', 'model', 'large')).rejects.toMatchObject(missing)
    expect((await bridge.detail('old')).messages).toHaveLength(1)
    expect(await fixture.log()).toEqual([])
  })
})

describe('ACP project configuration', () => {
  const opencode = (options: AcpAgentOptions = {}, env: Record<string, string> = {}) =>
    preset('opencode', { FAKE_ACP_CONFIG: 'legacy', ...env }, options)
  const definitionHash = (record: AgentRecord) =>
    launchHash({
      resolvedCommand: process.execPath,
      args: [FAKE_ACP_AGENT],
      definitionEnv: record.env,
      presetId: record.presetId,
      profileVersion: 1,
    })
  const projectNote = (names: string) =>
    `项目中有 OpenCode 配置：${names}。启动指纹包含这些配置的内容，确认后如有增删或修改，该会话不能继续`
  const CHANGED = {
    status: 409,
    code: 'project-config-changed',
    message: '项目中的 OpenCode 配置在确认后发生了变化，该会话不能继续。请新建会话（需要本机确认）。',
  }
  const stoppedIdle = (fixture: Awaited<ReturnType<typeof setup>>) =>
    vi.waitFor(async () => expect((await fixture.log()).some(entry => entry.event === 'stdin-end')).toBe(true), {
      timeout: 5_000,
      interval: 20,
    })

  /** What OpenCode writes into a `.opencode` directory when it starts (its plugin package) and while planning. */
  async function openCodeOwnWrites(directory: string): Promise<void> {
    await mkdir(join(directory, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true })
    await writeFile(join(directory, 'node_modules', '@opencode-ai', 'plugin', 'index.js'), 'export {}')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.1.25' } }, null, 2))
    await writeFile(join(directory, 'bun.lock'), '{}')
    await writeFile(join(directory, '.gitignore'), 'node_modules\npackage.json\nbun.lock\n.gitignore')
    await mkdir(join(directory, 'plans'), { recursive: true })
    await writeFile(join(directory, 'plans', 'plan.md'), '# plan')
  }

  it('names the configuration found in or above the project and binds its content into the launch fingerprint', async () => {
    const fixture = await opencode()
    const bridge = await fixture.open()
    const preview = () => bridge.launchPreview!({ cwd: fixture.workspace })
    const base = definitionHash(fixture.record)
    const notes = profileFor('opencode')!.permission.notes
    expect(await preview()).toMatchObject({ launchHash: base, notes })

    await writeFile(join(fixture.workspace, 'opencode.json'), '{}')
    const added = await preview()
    expect(added.notes).toEqual([...notes, projectNote('opencode.json')])
    expect(added.launchHash).not.toBe(base)
    await writeFile(join(fixture.workspace, 'opencode.json'), '{"permission":"allow"}')
    expect((await preview()).launchHash).not.toBe(added.launchHash)

    // A directory counts with everything below it, except what OpenCode writes there itself.
    const own = join(fixture.workspace, '.opencode')
    await mkdir(join(own, 'agent'), { recursive: true })
    await writeFile(join(own, 'agent', 'build.md'), 'permission: allow')
    const agent = await preview()
    expect(agent.notes.at(-1)).toBe(projectNote('.opencode/agent/build.md、opencode.json'))
    await openCodeOwnWrites(own)
    expect(await preview()).toEqual(agent)
    await writeFile(
      join(own, 'package.json'),
      JSON.stringify({ scripts: { postinstall: 'node run.js' }, dependencies: { '@opencode-ai/plugin': '1.1.25' } }),
    )
    const scripted = await preview()
    expect(scripted.launchHash).not.toBe(agent.launchHash)
    expect(scripted.notes.at(-1)).toBe(projectNote('.opencode/agent/build.md、.opencode/package.json、opencode.json'))
    await rm(own, { recursive: true })
    await rm(join(fixture.workspace, 'opencode.json'))

    // Above the project it is named by its full path; the home directory holds user configuration and is skipped.
    await writeFile(join(fixture.root, 'opencode.jsonc'), '{}')
    expect((await preview()).notes.at(-1)).toBe(projectNote(join(fixture.root, 'opencode.jsonc')))
    hostEnv({ HOME: fixture.root })
    expect(await preview()).toMatchObject({ launchHash: base, notes })

    // Other harnesses do not read these files.
    const goose = await preset('goose')
    await writeFile(join(goose.workspace, 'opencode.json'), '{}')
    expect(await (await goose.open()).launchPreview!({ cwd: goose.workspace })).toMatchObject({
      launchHash: definitionHash(goose.record),
      notes: [],
    })
  })

  it('looks above both the path the agent is given and its real path', async () => {
    const fixture = await opencode({}, { FAKE_ACP_CAPS: 'resume' })
    const given = join(fixture.root, 'a', 'link')
    const real = join(fixture.root, 'b', 'project')
    await mkdir(join(fixture.root, 'a'))
    await mkdir(real, { recursive: true })
    await symlink(real, given)
    const bridge = await fixture.open(() => [given])
    // The Host asks with the real path; the agent is given the registered one.
    const preview = async () => bridge.launchPreview!({ cwd: await realpath(given) })
    expect((await preview()).launchHash).toBe(definitionHash(fixture.record))

    const literalParent = join(fixture.root, 'a', 'opencode.json')
    await writeFile(literalParent, '{}')
    const found = await preview()
    expect(found.notes.at(-1)).toBe(projectNote(literalParent))
    expect(found.launchHash).not.toBe(definitionHash(fixture.record))
    const realParent = join(await realpath(fixture.root), 'b', 'opencode.jsonc')
    await writeFile(realParent, '{}')
    const both = (await preview()).notes.at(-1)!
    expect(both).toContain(literalParent)
    expect(both).toContain(realParent)

    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), cwd: given })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(received(await fixture.log(), 'session/new')[0].params?.cwd).toBe(given)
    await rm(literalParent)
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject(CHANGED)
  })

  it('refuses to start a session whose project configuration changed during the confirmation', async () => {
    const fixture = await opencode()
    const bridge = await fixture.open()
    const preview = await bridge.launchPreview!({ cwd: fixture.workspace })
    await writeFile(join(fixture.workspace, 'opencode.jsonc'), '{}')
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), expectedLaunchHash: preview.launchHash })).rejects.toMatchObject(
      CHANGED,
    )
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), expectedLaunchHash: 'f'.repeat(64) })).rejects.toMatchObject({
      status: 409,
      code: 'agent-definition-changed',
    })
    expect(await bridge.listTasks()).toEqual([])
    expect(await fixture.log()).toEqual([])
  })

  it('refuses to restart, resume or delete a session once configuration was added to its project', async () => {
    const fixture = await opencode({ idleMs: 80 }, { FAKE_ACP_CAPS: 'resume,delete' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await stoppedIdle(fixture)

    await mkdir(join(fixture.workspace, '.opencode', 'agent'), { recursive: true })
    await writeFile(join(fixture.workspace, '.opencode', 'agent', 'build.md'), 'permission: allow')
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject(CHANGED)
    await bridge.close()
    const restarted = await fixture.open()
    await expect(restarted.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject(CHANGED)
    expect(userTexts(await restarted.detail(sessionId))).toEqual(['echo one'])

    // A new session confirms the configuration as it is now; the old one is deleted without starting its agent.
    const fresh = await restarted.createTask({ prompt: 'echo three', requestId: rid() })
    expect((await settled(restarted, fresh.sessionId)).summary.status).toBe('idle')
    await restarted.remove!(sessionId)
    await restarted.close()
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(2)
    expect(received(log, 'session/resume')).toEqual([])
    expect(received(log, 'session/delete')).toEqual([])
  })

  it('reads the project configuration again right before a process starts', async () => {
    const fixture = await opencode({ restartDelayMs: 1_500 })
    const bridge = await fixture.open()
    const crashed = await bridge.createTask({ prompt: 'crash', requestId: rid() })
    expect((await settled(bridge, crashed.sessionId)).summary.status).toBe('failed')
    // After a crash the next start waits out the restart delay; the configuration appears meanwhile.
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    await new Promise(resolve => setTimeout(resolve, 300))
    await writeFile(join(fixture.workspace, 'opencode.json'), '{}')
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toBe(CHANGED.message)
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)
  })

  it('reads linked files, never opens special files and counts unreadable entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-acp-project-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const config = join(project, '.opencode')
    await mkdir(join(config, 'agent'), { recursive: true })
    const fingerprint = () => fingerprintProjectConfig(project, ['.opencode'], {}, join(root, 'home'))
    const outside = join(root, 'shared.md')
    await writeFile(outside, 'one')
    await symlink(outside, join(config, 'agent', 'linked.md'))
    const linked = await fingerprint()
    await writeFile(outside, 'two')
    expect((await fingerprint()).digest).not.toBe(linked.digest)

    expect(spawnSync('mkfifo', [join(config, 'pipe')]).status).toBe(0)
    await symlink(join(config, 'pipe'), join(config, 'pipe-link'))
    expect((await fingerprint()).entries.map(entry => entry.path)).toEqual(
      ['agent/linked.md', 'pipe', 'pipe-link'].map(name => join(config, name)),
    )

    if (process.getuid?.() !== 0) {
      await mkdir(join(config, 'locked'))
      await chmod(join(config, 'locked'), 0o000)
      cleanups.push(() => chmod(join(config, 'locked'), 0o700))
      const locked = await fingerprint()
      expect(locked.entries).toContainEqual({ path: join(config, 'locked'), unreadable: true })
      await chmod(join(config, 'locked'), 0o700)
      expect((await fingerprint()).digest).not.toBe(locked.digest)
    }
  })

  it('stops at its entry and depth limits and compares a file past the byte budget by size and time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-acp-project-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const config = join(project, '.opencode')
    await mkdir(config, { recursive: true })
    // Small limits: a real 2,000 files cost seconds of file creation on a busy machine, not anything the walk does.
    const fingerprint = (limits: { entries?: number; bytes?: number; depth?: number }) =>
      fingerprintProjectConfig(project, ['.opencode'], {}, join(root, 'home'), { ...PROJECT_CONFIG_LIMITS, ...limits })

    for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(join(config, name), 'text')
    expect(await fingerprint({ entries: 4 })).toMatchObject({ truncated: false })
    const capped = await fingerprint({ entries: 3 })
    expect(capped.truncated).toBe(true)
    expect(capped.entries.length).toBeLessThanOrEqual(3)

    await mkdir(join(config, 'one', 'two'), { recursive: true })
    expect(await fingerprint({ depth: 3 })).toMatchObject({ truncated: false })
    expect(await fingerprint({ depth: 2 })).toMatchObject({ truncated: true })

    // Four bytes fit a.md, so b.md and c.md count by size and time: their text can change unseen, a.md's cannot.
    const budget = () => fingerprint({ bytes: 4 })
    const before = await budget()
    const when = new Date('2026-01-01T00:00:00Z')
    await utimes(join(config, 'b.md'), when, when)
    const stamped = await budget()
    expect(stamped.digest).not.toBe(before.digest)
    expect(stamped.truncated).toBe(false)
    await writeFile(join(config, 'b.md'), 'TEXT')
    await utimes(join(config, 'b.md'), when, when)
    expect((await budget()).digest).toBe(stamped.digest)
    await writeFile(join(config, 'a.md'), 'TEXT')
    expect((await budget()).digest).not.toBe(stamped.digest)
  })

  it('resumes a session whose project configuration is unchanged, whatever OpenCode wrote there itself', async () => {
    const fixture = await opencode({ idleMs: 80 }, { FAKE_ACP_CAPS: 'resume' })
    const own = join(fixture.workspace, '.opencode')
    await mkdir(join(own, 'agent'), { recursive: true })
    await writeFile(join(own, 'agent', 'review.md'), 'review')
    await writeFile(join(fixture.workspace, 'opencode.json'), '{}')
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await stoppedIdle(fixture)

    await openCodeOwnWrites(own)
    await bridge.prompt(sessionId, 'echo two', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo two')
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(2)
    expect(received(log, 'session/resume')).toHaveLength(1)
  })
})

describe('ACP project folders', () => {
  const CODEX = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'read-only,workspace-write', FAKE_ACP_INITIAL_MODE: 'read-only' }
  const GEMINI = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'plan,default,autoEdit,yolo', FAKE_ACP_INITIAL_MODE: 'default' }
  const QWEN = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default' }
  const CHANGED = {
    status: 409,
    code: 'workspace-changed',
    message: '这个会话使用的文件夹已不在项目中或找不到了，不能继续。请新建会话。',
  }
  const stoppedIdle = (fixture: Awaited<ReturnType<typeof setup>>, count = 1) =>
    vi.waitFor(
      async () => expect((await fixture.log()).filter(entry => entry.event === 'stdin-end').length).toBeGreaterThanOrEqual(count),
      {
        timeout: 5_000,
        interval: 20,
      },
    )

  /**
   * A project `proj` of folders under the fixture's root (the first is its primary folder), beside the start directory,
   * as the Host lists them; tests edit `listed` to move, replace or drop folders.
   */
  async function project(fixture: Awaited<ReturnType<typeof setup>>, names = ['api', 'web', 'docs']) {
    const folders: ProjectFolder[] = []
    for (const name of names) {
      const path = join(fixture.root, name)
      await mkdir(path, { recursive: true })
      folders.push({ id: name, path })
    }
    const listed: HostProject[] = [
      { id: 'default', folders: [{ id: 'default', path: fixture.workspace }] },
      { id: 'proj', folders: [...folders] },
    ]
    return {
      folders,
      /** Real paths, in the same order. */
      reals: await Promise.all(folders.map(folder => realpath(folder.path))),
      listed,
      projects: () => structuredClone(listed),
      workspaces: () => listed.map(item => item.folders[0]!.path),
      input: { cwd: folders[0]!.path, workspaceId: 'proj', folders },
    }
  }

  it('reads additionalDirectories as a session capability without failing on other shapes', () => {
    const parse = (sessionCapabilities: unknown) =>
      initializeResult.parse({ protocolVersion: 1, agentCapabilities: { sessionCapabilities } }).agentCapabilities?.sessionCapabilities
    expect(parse({ resume: {}, additionalDirectories: {} })).toEqual({ resume: {}, additionalDirectories: {} })
    expect(parse({ additionalDirectories: null })).toEqual({ additionalDirectories: null })
    expect(parse({ resume: {} })).toEqual({ resume: {} })
    expect(parse('everything')).toBeUndefined()
  })

  it('declares which presets take a project folders and what clients are told about the others', async () => {
    const declared = async (presetId?: string) => {
      const driver = await activate(
        createAcpAgentPlugin({
          id: `agent-${presetId ?? 'custom'}`,
          name: 'Agent',
          ...(presetId ? { presetId } : {}),
          command: 'latch-no-such-agent',
          args: [],
          env: {},
          enabled: true,
        }),
      )
      return { projectFolders: driver.projectFolders, folderAccess: driver.folderAccess }
    }
    expect(await declared('codex')).toEqual({ projectFolders: 'all', folderAccess: { access: 'all' } })
    for (const presetId of ['gemini', 'qwen'])
      expect(await declared(presetId)).toEqual({ projectFolders: 'all', folderAccess: { access: 'all', max: 5 } })
    expect(await declared('opencode')).toEqual({ projectFolders: undefined, folderAccess: { access: 'primary-asks' } })
    expect(await declared('dsh')).toEqual({ projectFolders: undefined, folderAccess: { access: 'primary' } })
    for (const presetId of ['pi', 'goose'])
      expect(await declared(presetId)).toEqual({ projectFolders: undefined, folderAccess: { access: 'primary-unbounded' } })
    expect(await declared()).toEqual({ projectFolders: undefined, folderAccess: undefined })
  })

  it('fingerprints the folders a session passes only when there are some', () => {
    const input = {
      resolvedCommand: '/usr/bin/agent',
      args: ['acp'],
      definitionEnv: { A: '1' },
      presetId: 'codex',
      profileVersion: 1 as const,
    }
    const base = launchHash(input)
    expect(launchHash({ ...input, folders: { via: 'acp', paths: [] } })).toBe(base)
    const two = launchHash({ ...input, folders: { via: 'acp', paths: ['/w/web', '/w/docs'] } })
    expect(two).toBe(
      sha256Hex(
        canonicalJson({
          v: 1,
          command: '/usr/bin/agent',
          args: ['acp'],
          envNames: ['A'],
          envValues: sha256Hex(canonicalJson({ A: '1' })),
          presetId: 'codex',
          profileVersion: 1,
          folders: { via: 'acp', paths: ['/w/web', '/w/docs'] },
        }),
      ),
    )
    for (const folders of [
      { via: 'args' as const, paths: ['/w/web', '/w/docs'] },
      { via: 'acp' as const, paths: ['/w/docs', '/w/web'] },
      { via: 'acp' as const, paths: ['/w/web'] },
    ])
      expect(launchHash({ ...input, folders })).not.toBe(two)
  })

  it('gives Codex the full list of other folders over ACP on new, resumed and loaded sessions', async () => {
    for (const restore of ['resume', 'load']) {
      const fixture = await preset('codex', { ...CODEX, FAKE_ACP_CAPS: `dirs,${restore}` }, { idleMs: 80 })
      const scope = await project(fixture)
      const bridge = await fixture.open(scope.workspaces, scope.projects)
      const others = scope.reals.slice(1)

      const preview = await bridge.launchPreview!(scope.input)
      expect(preview).toMatchObject({ cwd: scope.reals[0], args: [FAKE_ACP_AGENT], folders: others })
      expect(preview.notes).toContain(
        '其他 2 个文件夹经 ACP 的 additionalDirectories 传给 Fake；它的当前版本没有声明支持时，会话不会开始。文件夹范围由 Fake 自己执行，不是隔离',
      )
      // The definition's own fingerprint does not move; the launch with folders does.
      const launched = {
        resolvedCommand: process.execPath,
        args: [FAKE_ACP_AGENT],
        definitionEnv: fixture.record.env,
        presetId: 'codex',
        profileVersion: 1 as const,
      }
      const definition = launchHash(launched)
      expect((await bridge.launchPreview!({ cwd: scope.folders[0]!.path })).launchHash).toBe(definition)
      expect(preview.launchHash).toBe(launchHash({ ...launched, folders: { via: 'acp', paths: others } }))

      const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), ...scope.input })
      expect((await settled(bridge, sessionId)).summary).toMatchObject({
        status: 'idle',
        cwd: scope.folders[0]!.path,
        workspaceId: 'proj',
        folders: scope.folders,
        folderAccess: 'all',
      })
      const stored = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).tasks[sessionId].acp
      expect(stored).toMatchObject({ folders: others, folderVia: 'acp', launchHash: preview.launchHash, definitionHash: definition })
      expect(received(await fixture.log(), 'session/new')[0]!.params).toEqual({
        cwd: scope.folders[0]!.path,
        mcpServers: [],
        additionalDirectories: others,
      })

      // Once its idle process stopped, and again after a restart, the session is restored with the same list.
      await stoppedIdle(fixture)
      await bridge.prompt(sessionId, 'echo two', rid())
      await settled(bridge, sessionId)
      await bridge.close()
      const restarted = await fixture.open(scope.workspaces, scope.projects)
      await restarted.prompt(sessionId, 'echo three', rid())
      expect(assistants(await settled(restarted, sessionId)).at(-1)?.text).toBe('echo: echo three')
      const restored = received(await fixture.log(), `session/${restore}`)
      expect(restored).toHaveLength(2)
      for (const entry of restored)
        expect(entry.params).toEqual({
          sessionId: expect.any(String),
          cwd: scope.folders[0]!.path,
          mcpServers: [],
          additionalDirectories: others,
        })
    }
  })

  it('fingerprints the Codex configuration and skills in every folder it receives', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_CAPS: 'dirs' })
    const scope = await project(fixture)
    const bridge = await fixture.open(scope.workspaces, scope.projects)
    const primaryOnly = { cwd: scope.folders[0]!.path }
    const alone = (await bridge.launchPreview!(primaryOnly)).launchHash
    const base = await bridge.launchPreview!(scope.input)

    // codex-acp loads the skills of every folder it receives; they are named by their full path.
    const skill = join(scope.reals[1]!, '.agents', 'skills', 'deploy')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '# deploy')
    const skilled = await bridge.launchPreview!(scope.input)
    expect(skilled.launchHash).not.toBe(base.launchHash)
    expect(skilled.notes.at(-1)).toContain(join(skill, 'SKILL.md'))
    const settings = join(scope.reals[2]!, '.codex')
    await mkdir(settings)
    await writeFile(join(settings, 'config.toml'), '')
    const configured = await bridge.launchPreview!(scope.input)
    expect(configured.launchHash).not.toBe(skilled.launchHash)
    expect(configured.notes.at(-1)).toContain(join(settings, 'config.toml'))
    // A session of the primary folder alone looks only along that folder, as before.
    expect((await bridge.launchPreview!(primaryOnly)).launchHash).toBe(alone)

    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), ...scope.input })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    await writeFile(join(skill, 'SKILL.md'), '# deploy, changed')
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject({ status: 409, code: 'project-config-changed' })
  })

  it('does not start a session of several folders when the agent does not advertise them, and stops its process', async () => {
    const capsFile = join(await mkdtemp(join(tmpdir(), 'latch-acp-caps-')), 'caps')
    cleanups.push(() => rm(dirname(capsFile), { recursive: true, force: true }))
    await writeFile(capsFile, 'resume')
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_CAPS_FILE: capsFile }, { idleMs: 80 })
    const scope = await project(fixture, ['api', 'web'])
    const bridge = await fixture.open(scope.workspaces, scope.projects)
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), ...scope.input })).rejects.toMatchObject({
      status: 409,
      code: 'agent-folders-unsupported',
      message: 'Fake 的当前版本没有声明支持多个文件夹，会话没有开始。请更新它，或使用只有一个文件夹的项目。',
    })
    expect(await bridge.listTasks()).toEqual([])
    let log = await fixture.log()
    expect(received(log, 'initialize')).toHaveLength(1)
    expect(received(log, 'session/new')).toEqual([])
    await vi.waitFor(() => expect(alive(log.find(entry => entry.event === 'start')!.pid)).toBe(false), { timeout: 5_000, interval: 20 })
    await vi.waitFor(async () => expect(await readdir(fixture.tmpRoot)).toEqual([]), { timeout: 5_000, interval: 20 })

    // A project of one folder needs nothing from the agent.
    const single = { cwd: fixture.workspace, workspaceId: 'default', folders: [{ id: 'default', path: fixture.workspace }] }
    const alone = await bridge.createTask({ prompt: 'echo alone', requestId: rid(), ...single })
    expect((await settled(bridge, alone.sessionId)).summary).toMatchObject({
      status: 'idle',
      workspaceId: 'default',
      folders: single.folders,
    })
    expect(received(await fixture.log(), 'session/new')[0]!.params).toEqual({ cwd: fixture.workspace, mcpServers: [] })

    // An agent that stops advertising them after a restart gets no turn, and its process is stopped.
    await writeFile(capsFile, 'dirs,resume')
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), ...scope.input })
    await settled(bridge, sessionId)
    await stoppedIdle(fixture, 3)
    await writeFile(capsFile, 'resume')
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject({
      status: 409,
      code: 'agent-folders-unsupported',
      message: 'Fake 的当前版本没有声明支持多个文件夹，本轮没有发送。请更新它，或在只有一个文件夹的项目中新建会话。',
    })
    log = await fixture.log()
    expect(received(log, 'session/resume')).toEqual([])
    expect(userTexts(await bridge.detail(sessionId))).toEqual(['echo one'])
    const last = log.filter(entry => entry.event === 'start').at(-1)!.pid
    await vi.waitFor(() => expect(alive(last)).toBe(false), { timeout: 5_000, interval: 20 })
  })

  it('starts the agent of a new session of several folders once per request', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_CAPS: 'dirs' })
    const scope = await project(fixture)
    const bridge = await fixture.open(scope.workspaces, scope.projects)
    const expectedLaunchHash = (await bridge.launchPreview!(scope.input)).launchHash
    const input = { prompt: 'echo once', requestId: rid(), ...scope.input, expectedLaunchHash }
    const [first, again, other] = await Promise.allSettled([
      bridge.createTask(input),
      bridge.createTask(input),
      bridge.createTask({ ...input, prompt: 'echo other' }),
    ])
    if (first.status === 'rejected') throw first.reason
    expect(first).toMatchObject({ status: 'fulfilled' })
    expect(again).toEqual(first)
    expect(other).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'request-conflict' } })
    const { sessionId } = (first as PromiseFulfilledResult<{ sessionId: string }>).value
    await settled(bridge, sessionId)
    expect(await bridge.createTask(input)).toEqual({ sessionId })
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)
  })

  it('passes Gemini CLI and Qwen Code one --include-directories per other folder after the definition arguments', async () => {
    for (const [presetId, env, name] of [
      ['gemini', GEMINI, 'Gemini CLI'],
      ['qwen', QWEN, 'Qwen Code'],
    ] as const) {
      const fixture = await preset(presetId, env)
      const scope = await project(fixture)
      const bridge = await fixture.open(scope.workspaces, scope.projects)
      const others = scope.reals.slice(1)
      const preview = await bridge.launchPreview!(scope.input)
      expect(preview).toMatchObject({ args: [FAKE_ACP_AGENT], folders: others })
      expect(preview.notes, name).toContain(
        '其他 2 个文件夹以 --include-directories 参数传给 Fake，排在定义的参数之后。文件夹范围由 Fake 自己执行，不是隔离',
      )
      const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid(), ...scope.input })
      expect((await settled(bridge, sessionId)).summary).toMatchObject({ status: 'idle', folders: scope.folders, folderAccess: 'all' })
      const log = await fixture.log()
      expect(log.find(entry => entry.event === 'start')!.argv).toEqual([
        '--include-directories',
        others[0],
        '--include-directories',
        others[1],
      ])
      expect(received(log, 'session/new')[0]!.params).toEqual({ cwd: scope.folders[0]!.path, mcpServers: [] })
      const stored = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).tasks[sessionId].acp
      expect(stored).toMatchObject({ folders: others, folderVia: 'args' })

      // Configuration the harness loads from the other folders is named by its full path and fingerprinted.
      const settings = join(scope.folders[2]!.path, `.${presetId}`)
      await mkdir(settings)
      await writeFile(join(settings, 'settings.json'), '{}')
      const configured = await bridge.launchPreview!(scope.input)
      expect(configured.launchHash).not.toBe(preview.launchHash)
      expect(configured.notes.at(-1)).toContain(join(others[1]!, `.${presetId}`, 'settings.json'))
      await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'project-config-changed' })
    }

    // At most four other folders, refused before anything starts.
    const fixture = await preset('gemini', GEMINI)
    const scope = await project(fixture, ['a', 'b', 'c', 'd', 'e', 'f'])
    const bridge = await fixture.open(scope.workspaces, scope.projects)
    const limit = { status: 409, code: 'harness-folder-limit', message: 'Fake 最多使用 5 个文件夹，这个项目有 6 个，会话没有开始' }
    await expect(bridge.launchPreview!(scope.input)).rejects.toMatchObject(limit)
    await expect(
      bridge.createTask({ prompt: 'echo', requestId: rid(), ...scope.input, expectedLaunchHash: 'f'.repeat(64) }),
    ).rejects.toMatchObject(limit)
    const five = { ...scope.input, folders: scope.folders.slice(0, 5) }
    expect((await bridge.launchPreview!(five)).folders).toEqual(scope.reals.slice(1, 5))
    expect(await fixture.log()).toEqual([])
  })

  it('never passes other folders to OpenCode, DeepSeek Harness, pi or goose', async () => {
    for (const [presetId, env] of [
      ['opencode', { FAKE_ACP_CONFIG: 'legacy' }],
      ['dsh', {}],
      ['pi', {}],
      ['goose', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'chat,approve,auto', FAKE_ACP_INITIAL_MODE: 'approve' }],
    ] as const) {
      // Even when the agent advertises them, and when folders reach the driver anyway.
      const fixture = await preset(presetId, { ...env, FAKE_ACP_CAPS: 'dirs' })
      expect(fixture.driver.projectFolders, presetId).toBeUndefined()
      const scope = await project(fixture)
      const bridge = await fixture.open(scope.workspaces, scope.projects)
      const preview = await bridge.launchPreview!(scope.input)
      expect(preview.folders, presetId).toBeUndefined()
      expect(preview.launchHash, presetId).toBe((await bridge.launchPreview!({ cwd: scope.folders[0]!.path })).launchHash)
      const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid(), ...scope.input })
      const { summary } = await settled(bridge, sessionId)
      expect(summary.status, presetId).toBe('idle')
      expect([summary.workspaceId, summary.folders, summary.folderAccess], presetId).toEqual([undefined, undefined, undefined])
      const log = await fixture.log()
      expect(log.find(entry => entry.event === 'start')!.argv, presetId).toEqual([])
      expect(received(log, 'session/new')[0]!.params, presetId).toEqual({ cwd: scope.folders[0]!.path, mcpServers: [] })
    }
  })

  it('refuses folders that are not the ones the Host lists for the project', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_CAPS: 'dirs' })
    const scope = await project(fixture)
    const bridge = await fixture.open(scope.workspaces, scope.projects)
    const [api, web, docs] = scope.folders as [ProjectFolder, ProjectFolder, ProjectFolder]
    for (const input of [
      { ...scope.input, workspaceId: 'other' },
      { ...scope.input, workspaceId: 'default' },
      { ...scope.input, folders: [] },
      { ...scope.input, folders: [web, api, docs] },
      { ...scope.input, folders: [api, { id: 'web', path: fixture.workspace }] },
      { ...scope.input, folders: [api, { id: 'ghost', path: web.path }] },
      { ...scope.input, folders: [api, web, web] },
      { ...scope.input, folders: [api, { id: 'web', path: 'relative/web' }] },
    ]) {
      await expect(bridge.launchPreview!(input)).rejects.toMatchObject({ status: 400, code: 'workspace-unavailable' })
      await expect(
        bridge.createTask({ prompt: 'echo', requestId: rid(), ...input, expectedLaunchHash: 'f'.repeat(64) }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'workspace-unavailable',
      })
    }
    expect(await fixture.log()).toEqual([])
  })

  it('stops input once a folder leaves the project, is replaced or is gone, whatever the primary folder is now', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_CAPS: 'dirs,resume,delete' }, { idleMs: 80 })
    const scope = await project(fixture)
    const bridge = await fixture.open(scope.workspaces, scope.projects)
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), ...scope.input })
    await settled(bridge, sessionId)
    await stoppedIdle(fixture)
    const listed = scope.listed[1]!
    const [api, web, docs] = scope.folders as [ProjectFolder, ProjectFolder, ProjectFolder]

    // Another primary folder, and a folder added later, do not move the session.
    const extra = join(fixture.root, 'extra')
    await mkdir(extra)
    listed.folders = [web, api, docs, { id: 'extra', path: extra }]
    await bridge.prompt(sessionId, 'echo two', rid())
    await settled(bridge, sessionId)
    expect(received(await fixture.log(), 'session/resume').at(-1)!.params?.additionalDirectories).toEqual(scope.reals.slice(1))
    await stoppedIdle(fixture, 2)

    listed.folders = [api, web]
    await expect(bridge.prompt(sessionId, 'echo removed', rid())).rejects.toMatchObject(CHANGED)
    const elsewhere = join(fixture.root, 'elsewhere')
    await mkdir(elsewhere)
    listed.folders = [api, web, { id: 'docs', path: elsewhere }]
    await expect(bridge.prompt(sessionId, 'echo replaced', rid())).rejects.toMatchObject(CHANGED)
    scope.listed.splice(1, 1)
    await expect(bridge.prompt(sessionId, 'echo unlisted', rid())).rejects.toMatchObject(CHANGED)
    scope.listed.push({ id: 'proj', folders: [api, web, docs] })
    await bridge.prompt(sessionId, 'echo three', rid())
    await settled(bridge, sessionId)
    await stoppedIdle(fixture, 3)

    await rm(docs.path, { recursive: true })
    await expect(bridge.prompt(sessionId, 'echo gone', rid())).rejects.toMatchObject(CHANGED)
    await expect(bridge.setConfig!(sessionId, 'model', 'large')).rejects.toMatchObject(CHANGED)
    expect(userTexts(await bridge.detail(sessionId))).toEqual(['echo one', 'echo two', 'echo three'])
    expect(received(await fixture.log(), 'session/resume')).toHaveLength(2)

    // Deleting it starts no agent to delete its own copy: that agent would receive a folder the project lost.
    await bridge.remove!(sessionId)
    await vi.waitFor(() => expect(fixture.diagnostics.join('\n')).toContain('未启动 Fake 删除它自己保存的会话副本'), {
      timeout: 5_000,
      interval: 20,
    })
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(3)
    expect(received(log, 'session/delete')).toEqual([])
  })
})

describe('ACP permission mode', () => {
  const qwen = (env: Record<string, string> = {}, options: AcpAgentOptions = {}) =>
    preset('qwen', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default', ...env }, options)

  it('sets the expected mode once when the session starts in another one', async () => {
    const fixture = await qwen({ FAKE_ACP_INITIAL_MODE: 'yolo' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(detail.config?.find(option => option.id === 'mode')?.currentValue).toBe('default')
    expect(detail.permission).toMatchObject({
      level: 'L3',
      enforcer: 'NONE',
      readback: 'mode',
      expectedMode: 'default',
      notes: ['恢复会话会恢复旧模式，Latch 每轮前重新设置'],
    })
    const log = await fixture.log()
    const order = log.filter(
      entry => entry.event === 'recv' && ['session/new', 'session/set_config_option', 'session/prompt'].includes(entry.method ?? ''),
    )
    expect(order.map(entry => [entry.method, entry.params?.value])).toEqual([
      ['session/new', undefined],
      ['session/set_config_option', 'default'],
      ['session/prompt', undefined],
    ])
    expect(log.find(entry => entry.event === 'prompt-mode')?.mode).toBe('default')
    expect(fixture.events).toEqual([])
  })

  it('refuses the turn when the agent does not take the expected mode', async () => {
    for (const config of ['options', 'legacy']) {
      const fixture = await qwen({ FAKE_ACP_CONFIG: config, FAKE_ACP_INITIAL_MODE: 'yolo', FAKE_ACP_STICKY_MODE: '1' })
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('failed')
      expect(systemText(detail)).toContain('无法确认 Fake 已进入预期的权限模式，未发送本轮输入。')
      await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'permission-unverified' })
      expect(userTexts(await bridge.detail(sessionId))).toEqual(['echo hi'])
      const log = await fixture.log()
      expect(received(log, 'session/prompt')).toEqual([])
      expect(received(log, config === 'options' ? 'session/set_config_option' : 'session/set_mode').length).toBeGreaterThanOrEqual(1)
      expect(fixture.events).toContainEqual({ type: 'permission-unverified', sessionId })
    }
  })

  it('refuses a profile mode it cannot read back', async () => {
    const fixture = await preset('qwen')
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
    expect(systemText(await settled(bridge, sessionId))).toContain('无法确认 Fake 已进入预期的权限模式')
    expect(received(await fixture.log(), 'session/prompt')).toEqual([])
  })

  it('cancels the turn, rejects pending asks and stops input when the agent widens its own mode', async () => {
    const fixture = await qwen()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'drift yolo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary).toMatchObject({ status: 'cancelled', permissionDrift: true })
    expect(detail.permission?.drift).toEqual({ at: expect.any(String), observed: 'yolo' })
    expect(systemText(detail)).toContain(
      '检测到权限模式变化（default → yolo），已取消本轮并拒绝挂起的询问。该会话不再接受输入，请新建会话。',
    )
    // Latch refused the open ask itself: it is recorded as cancelled, never as the person's rejection.
    const outcomes = detail.messages.filter(message => message.role === 'tool').map(message => message.tool?.decision?.outcome)
    expect(outcomes).toContain('cancelled')
    expect(outcomes).not.toContain('rejected')
    const log = await fixture.log()
    expect(answers(log)).toEqual([{ outcome: 'selected', optionId: 'reject' }])
    expect(received(log, 'session/cancel')).toHaveLength(1)
    expect(fixture.events).toContainEqual({ type: 'permission-drift', sessionId, observedHash: sha256Hex('yolo') })
    const drift = { status: 409, code: 'permission-drift', message: '该会话检测到权限模式漂移，已停止接收输入。请新建会话。' }
    await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject(drift)
    await expect(bridge.setConfig!(sessionId, 'mode', 'default')).rejects.toMatchObject(drift)
    // The drifted session's process has nothing left to do.
    await vi.waitFor(() => expect(alive(promptPid(log, 'drift'))).toBe(false), { timeout: 5_000, interval: 20 })
    const reopened = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8'))
    expect(reopened.tasks[sessionId]).toMatchObject({ summary: { permissionDrift: true }, acp: { drift: { observed: 'yolo' } } })
  })

  it('treats an unknown mode as drift', async () => {
    const fixture = await qwen({ FAKE_ACP_CONFIG: 'legacy' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'drift turbo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.permissionDrift).toBe(true)
    expect(systemText(detail)).toContain('default → turbo')
    expect(answers(await fixture.log())).toEqual([{ outcome: 'selected', optionId: 'reject' }])
  })

  it('treats any mode change as drift for an agent without a profile', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'drift plan', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.permissionDrift).toBe(true)
    expect(systemText(detail)).toContain('build → plan')
  })

  it('accepts a stricter mode and sets the expected one again before the next prompt', async () => {
    const fixture = await qwen()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'drift plan', requestId: rid() })
    await until(bridge, sessionId, detail => detail.config?.find(option => option.id === 'mode')?.currentValue === 'plan')
    const waiting = await bridge.detail(sessionId)
    expect(waiting.summary.status).toBe('waiting-approval')
    expect(waiting.summary.permissionDrift).toBeUndefined()
    await bridge.cancel(sessionId)
    await bridge.prompt(sessionId, 'echo next', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo next')
    const log = await fixture.log()
    const sets = received(log, 'session/set_config_option')
    expect(sets.map(entry => entry.params?.value)).toEqual(['default'])
    expect(log.indexOf(sets[0])).toBeLessThan(log.indexOf(received(log, 'session/prompt')[1]))
    expect(log.filter(entry => entry.event === 'prompt-mode').map(entry => entry.mode)).toEqual(['default', 'default'])
    expect(fixture.events).toEqual([])
  })

  it('sets the expected mode again after a resume restored an old one', async () => {
    const fixture = await qwen({ FAKE_ACP_CAPS: 'resume', FAKE_ACP_RESUME_MODE: 'yolo' })
    const first = await fixture.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, sessionId)
    await first.close()
    const bridge = await fixture.open()
    await bridge.prompt(sessionId, 'echo two', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo two')
    const log = await fixture.log()
    const second = log.filter(
      entry => entry.event === 'recv' && entry.pid === promptPid(log, 'echo two') && entry.method?.startsWith('session/'),
    )
    expect(second.map(entry => entry.method)).toEqual(['session/resume', 'session/set_config_option', 'session/prompt'])
    expect(log.filter(entry => entry.event === 'prompt-mode').map(entry => entry.mode)).toEqual(['default', 'default'])
  })

  it('sets and reads back the mode after a resume or load that does not report it', async () => {
    for (const [config, method] of [
      ['options', 'resume'],
      ['legacy', 'resume'],
      ['options', 'load'],
      ['legacy', 'load'],
    ]) {
      const fixture = await qwen({
        FAKE_ACP_CONFIG: config,
        FAKE_ACP_CAPS: method,
        FAKE_ACP_RESUME_MODE: 'yolo',
        FAKE_ACP_RESUME_SILENT: '1',
      })
      const first = await fixture.open()
      const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
      await settled(first, sessionId)
      await first.close()
      const bridge = await fixture.open()
      await bridge.prompt(sessionId, 'echo two', rid())
      expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo two')
      const log = await fixture.log()
      const second = log.filter(
        entry => entry.event === 'recv' && entry.pid === promptPid(log, 'echo two') && entry.method?.startsWith('session/'),
      )
      expect(
        second.map(entry => entry.method),
        `${config} ${method}`,
      ).toEqual([`session/${method}`, config === 'options' ? 'session/set_config_option' : 'session/set_mode', 'session/prompt'])
      expect(log.filter(entry => entry.event === 'prompt-mode').map(entry => entry.mode)).toEqual(['default', 'default'])
      expect(fixture.events).toEqual([])
    }

    // An agent that keeps the restored mode is refused rather than trusted on the mode recorded before.
    const sticky = await qwen({
      FAKE_ACP_CAPS: 'resume',
      FAKE_ACP_RESUME_MODE: 'yolo',
      FAKE_ACP_RESUME_SILENT: '1',
      FAKE_ACP_STICKY_MODE: '1',
    })
    const first = await sticky.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, sessionId)
    await first.close()
    const bridge = await sticky.open()
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject({ status: 409, code: 'permission-unverified' })
    expect(received(await sticky.log(), 'session/prompt')).toHaveLength(1)
    expect(sticky.events).toContainEqual({ type: 'permission-unverified', sessionId })
  })

  it('treats a mode wider than the old and the requested one as drift while Latch changes it mid-turn', async () => {
    for (const [config, report] of [
      ['options', 'full'],
      ['options', 'none'],
      ['legacy', 'full'],
    ]) {
      const fixture = await qwen({ FAKE_ACP_CONFIG: config, FAKE_ACP_SELF_MODE: 'yolo', FAKE_ACP_MODE_REPORT: report })
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'count 400', requestId: rid() })
      await until(bridge, sessionId, detail => detail.liveText.length > 0)
      await expect(bridge.setConfig!(sessionId, 'mode', 'plan'), `${config} ${report}`).rejects.toMatchObject({
        status: 409,
        code: 'permission-drift',
      })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary).toMatchObject({ status: 'cancelled', permissionDrift: true })
      expect(detail.permission?.drift?.observed).toBe('yolo')
      expect(received(await fixture.log(), 'session/cancel')).toHaveLength(1)
      expect(fixture.events).toContainEqual({ type: 'permission-drift', sessionId, observedHash: sha256Hex('yolo') })
      await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'permission-drift' })
    }
  })

  it('cancels the turn and refuses input when the agent does not take a stricter mode chosen mid-turn', async () => {
    const fixture = await qwen({ FAKE_ACP_STICKY_MODE: '1' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'count 400', requestId: rid() })
    await until(bridge, sessionId, detail => detail.liveText.length > 0)
    await expect(bridge.setConfig!(sessionId, 'mode', 'plan')).rejects.toMatchObject({ status: 409, code: 'permission-unverified' })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('cancelled')
    expect(detail.summary.permissionDrift).toBeUndefined()
    expect(detail.permission?.expectedMode).toBe('plan')
    expect(systemText(detail)).toContain('无法确认 Fake 已切换到 plan 模式，已取消本轮。')
    expect(fixture.events).toContainEqual({ type: 'permission-unverified', sessionId })
    await expect(bridge.prompt(sessionId, 'echo next', rid())).rejects.toMatchObject({ status: 409, code: 'permission-unverified' })
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(1)
  })

  it('keeps tracking a mode option whose category disappears and treats a missing one as drift', async () => {
    const uncategorized = await qwen({ FAKE_ACP_MODE_REPORT: 'uncategorized' })
    let bridge = await uncategorized.open()
    let task = await bridge.createTask({ prompt: 'drift yolo', requestId: rid() })
    let detail = await settled(bridge, task.sessionId)
    expect(detail.summary).toMatchObject({ status: 'cancelled', permissionDrift: true })
    expect(systemText(detail)).toContain('default → yolo')
    expect(answers(await uncategorized.log())).toEqual([{ outcome: 'selected', optionId: 'reject' }])

    const unlisted = await qwen({ FAKE_ACP_MODE_REPORT: 'unlisted' })
    bridge = await unlisted.open()
    task = await bridge.createTask({ prompt: 'drift yolo', requestId: rid() })
    detail = await settled(bridge, task.sessionId)
    expect(detail.summary).toMatchObject({ status: 'cancelled', permissionDrift: true })
    expect(systemText(detail)).toContain('default → 未报告')
    expect(unlisted.events).toContainEqual({ type: 'permission-drift', sessionId: task.sessionId, observedHash: sha256Hex('未报告') })

    // A stricter mode reported without its category is still the mode: kept, then set back before the next prompt.
    const stricter = await qwen({ FAKE_ACP_MODE_REPORT: 'uncategorized' })
    bridge = await stricter.open()
    task = await bridge.createTask({ prompt: 'drift plan', requestId: rid() })
    await until(
      bridge,
      task.sessionId,
      waiting =>
        waiting.summary.status === 'waiting-approval' && waiting.config?.find(option => option.id === 'mode')?.currentValue === 'plan',
    )
    await bridge.cancel(task.sessionId)
    await bridge.prompt(task.sessionId, 'echo next', rid())
    expect(assistants(await settled(bridge, task.sessionId)).at(-1)?.text).toBe('echo: echo next')
    expect(received(await stricter.log(), 'session/set_config_option').map(entry => entry.params?.value)).toEqual(['default'])
    expect(stricter.events).toEqual([])
  })

  it('classifies mode changes and widens only with local confirmation', async () => {
    const fixture = await qwen()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'default')).toBe('neutral')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'plan')).toBe('stricter')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'yolo')).toBe('wider')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'auto')).toBe('forbidden')
    expect(await bridge.classifyConfigChange!(sessionId, 'model', 'large')).toBe('neutral')
    await expect(bridge.classifyConfigChange!(sessionId, 'missing', 'x')).rejects.toMatchObject({ status: 404 })

    await expect(bridge.setConfig!(sessionId, 'mode', 'auto', { allowWiden: true })).rejects.toMatchObject({
      status: 400,
      code: 'mode-forbidden',
      message: '该模式由模型代为批准，Latch 不提供',
    })
    await expect(bridge.setConfig!(sessionId, 'mode', 'yolo')).rejects.toMatchObject({ status: 403, code: 'stepup-required' })
    expect(received(await fixture.log(), 'session/set_config_option')).toEqual([])

    await bridge.setConfig!(sessionId, 'mode', 'plan')
    expect((await bridge.detail(sessionId)).permission?.expectedMode).toBe('plan')
    // Widening is measured against the mode now expected.
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'default')).toBe('wider')
    await bridge.setConfig!(sessionId, 'mode', 'yolo', { allowWiden: true })
    const widened = await bridge.detail(sessionId)
    expect(widened.permission?.expectedMode).toBe('yolo')
    expect(widened.config?.find(option => option.id === 'mode')?.currentValue).toBe('yolo')
    await bridge.prompt(sessionId, 'echo two', rid())
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    const log = await fixture.log()
    expect(received(log, 'session/set_config_option').map(entry => entry.params?.value)).toEqual(['plan', 'yolo'])
    expect(log.filter(entry => entry.event === 'prompt-mode').map(entry => entry.mode)).toEqual(['default', 'yolo'])
    expect(fixture.events).toEqual([])
  })

  it('refuses OpenCode versions outside the checked major version', async () => {
    const fixture = await preset('opencode', { FAKE_ACP_VERSION: '2.0.0' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('Fake 版本 2.0.0 未经验证（OpenCode 仅支持 1.x（V1）），已拒绝启动。')
    const log = await fixture.log()
    expect(received(log, 'session/new')).toEqual([])
    await vi.waitFor(() => expect(alive(log.find(entry => entry.event === 'start')!.pid)).toBe(false), { timeout: 5_000, interval: 20 })

    const unknown = await preset('opencode', { FAKE_ACP_VERSION: 'none' })
    const other = await unknown.open()
    const task = await other.createTask({ prompt: 'echo', requestId: rid() })
    expect(systemText(await settled(other, task.sessionId))).toContain('Fake 版本 未知 未经验证')

    const supported = await preset('opencode', { FAKE_ACP_VERSION: '1.4.2', FAKE_ACP_CONFIG: 'legacy', FAKE_ACP_DUMP_ENV: '1' })
    const ok = await supported.open()
    const accepted = await ok.createTask({ prompt: 'echo', requestId: rid() })
    expect((await settled(ok, accepted.sessionId)).summary.status).toBe('idle')
    const env = (await supported.log()).find(entry => entry.event === 'env')!.env as Record<string, string>
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      permission: { '*': 'ask', task: 'deny' },
      agent: { build: { permission: { '*': 'ask' } } },
    })
    // OpenCode also reads project and user configuration, which can replace these rules; the confirmation says so.
    const preview = await ok.launchPreview!({ cwd: supported.workspace })
    expect(preview.approvals).toBe('prompts')
    expect(preview.notes.join('\n')).toContain('.opencode')
  })

  it('notes OpenCode definitions whose variables move where it reads its configuration', async () => {
    const redirected = await preset('opencode', { FAKE_ACP_VERSION: '1.4.2', FAKE_ACP_CONFIG: 'legacy', XDG_CONFIG_HOME: '/elsewhere' })
    const other = await redirected.open()
    const preview = await other.launchPreview!({ cwd: redirected.workspace })
    const note =
      '定义设置了 XDG_CONFIG_HOME，OpenCode 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设'
    expect(preview).toMatchObject({ verified: false, notes: [...profileFor('opencode')!.permission.notes, note] })
    const { sessionId } = await other.createTask({ prompt: 'echo', requestId: rid() })
    expect((await settled(other, sessionId)).permission?.notes).toEqual([...profileFor('opencode')!.permission.notes, note])
  })

  it('describes preset launches and writes Gemini system settings for the Host only', async () => {
    const fixture = await preset('gemini')
    const bridge = await fixture.open()
    const preview = await bridge.launchPreview!({ cwd: fixture.workspace })
    expect(preview).toMatchObject({ presetId: 'gemini', verified: false, readback: 'mode', approvals: 'prompts' })
    expect(preview.envNames).toContain('GEMINI_CLI_SYSTEM_SETTINGS_PATH')
    const file = join(fixture.dataDir, 'gemini-system-settings.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ security: { disableAlwaysAllow: true, enablePermanentToolApproval: false } })
    expect(preview.launchHash).toBe(
      launchHash({
        resolvedCommand: process.execPath,
        args: [FAKE_ACP_AGENT],
        definitionEnv: fixture.record.env,
        presetId: 'gemini',
        profileVersion: 1,
      }),
    )

    const piFixture = await preset('pi')
    const pi = await piFixture.open()
    expect(await pi.launchPreview!({ cwd: piFixture.workspace })).toMatchObject({
      presetId: 'pi',
      verified: false,
      approvals: 'none',
      readback: 'none',
      notes: ['pi 执行工具前不请求审批'],
    })
  })
})

describe('ACP turn mapping', () => {
  it('streams a reply under one live message ID and settles it with that ID', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const live = new Set<string>()
    let sessionId = ''
    const unsubscribe = bridge.subscribe(id => {
      if (!sessionId || id !== sessionId) return
      void bridge.detail(sessionId).then(
        detail => {
          if (detail.liveMessageId && detail.liveText) live.add(detail.liveMessageId)
        },
        () => {},
      )
    })
    cleanups.push(unsubscribe)
    ;({ sessionId } = await bridge.createTask({ prompt: 'count 12', requestId: rid() }))
    const detail = await settled(bridge, sessionId)
    expect(detail.summary).toMatchObject({ status: 'idle', mode: 'agent', title: 'count 12', cwd: fixture.workspace })
    const replies = assistants(detail)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ text: Array.from({ length: 12 }, (_, index) => `${index} `).join(''), state: 'completed' })
    expect([...live]).toEqual([replies[0].id])
    expect(detail.liveText).toBe('')
    expect(detail.activity).toBeUndefined()
  })

  it('splits assistant messages on messageId changes and keeps reasoning apart from text', async () => {
    const bridge = await (await setup()).open()
    const ids = await bridge.createTask({ prompt: 'ids', requestId: rid() })
    expect(assistants(await settled(bridge, ids.sessionId)).map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'msg:m1', text: 'first part' },
      { id: 'msg:m2', text: 'second' },
    ])
    const thought = await bridge.createTask({ prompt: 'think', requestId: rid() })
    const [reply] = assistants(await settled(bridge, thought.sessionId))
    expect(reply).toMatchObject({ text: 'answer', reasoning: 'pondering deeply' })
  })

  it('maps a tool lifecycle with diff content and scopes reused tool IDs by turn', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'tool', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(tool(detail, 'tool:1:call_1')).toEqual({
      id: 'tool:1:call_1',
      role: 'tool',
      toolName: 'edit',
      state: 'completed',
      text: 'written',
      tool: {
        kind: 'edit',
        title: 'Edit a.txt',
        input: JSON.stringify({ path: '/w/a.txt' }, null, 2),
        output: 'written',
        locations: ['/w/a.txt:3'],
        diffs: [{ path: '/w/a.txt', oldText: 'old\n', newText: 'new\n', previous: 'text' }],
      },
      createdAt: expect.any(String),
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    })
    expect(assistants(detail).map(message => message.text)).toEqual(['before', 'after'])

    await bridge.prompt(sessionId, 'reuse first', rid())
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'reuse second', rid())
    const reused = await settled(bridge, sessionId)
    expect(tool(reused, 'tool:2:call_1')?.tool?.title).toBe('reuse first')
    expect(tool(reused, 'tool:3:call_1')?.tool?.title).toBe('reuse second')
  })

  it('records whether a diff target existed only as far as the agent said so, and keeps it across restarts', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'diffs', requestId: rid() })
    const expected = [
      { path: '/w/new.txt', newText: 'created\n', previous: 'none' },
      { path: '/w/a.txt', oldText: 'old\n', newText: 'new\n', previous: 'text' },
      { path: '/w/b.txt', newText: 'b\n' },
    ]
    expect(tool(await settled(bridge, sessionId), 'tool:1:call_1')?.tool?.diffs).toEqual(expected)
    await bridge.close()
    const reopened = await fixture.open()
    expect(tool(await reopened.detail(sessionId), 'tool:1:call_1')?.tool?.diffs).toEqual(expected)
  })

  it('applies plan, title, commands and usage updates, persists commands and ignores unknown update kinds', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary).toMatchObject({ status: 'idle', title: 'Fake title', usage: { inputTokens: 10, outputTokens: 20 } })
    expect(detail.plan).toEqual([
      { content: 'Read', status: 'completed', priority: 'high' },
      { content: 'Write', status: 'in_progress', priority: 'medium' },
    ])
    expect(assistants(detail).map(message => message.text)).toEqual(['planned'])
    expect(detail.commands).toEqual([{ name: 'init', description: 'init' }])
    await bridge.close()
    const reopened = await fixture.open()
    expect((await reopened.detail(sessionId)).commands).toEqual(detail.commands)
  })

  it('settles text sent outside a turn without changing the task status', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'stray', requestId: rid() })
    const detail = await until(bridge, sessionId, value =>
      value.messages.some(message => message.id === 'msg:stray-1' && message.text === 'late tail'),
    )
    expect(detail.summary.status).toBe('idle')
    expect(assistants(detail).map(message => message.text)).toEqual(['main', 'late tail'])
  })

  it('tolerates non-JSON stdout and drains a stderr flood', async () => {
    const bridge = await (await setup({ FAKE_ACP_STARTUP_NOISE: '1' })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'noise', requestId: rid() })
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('still fine')
    await bridge.prompt(sessionId, 'flood', rid())
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(assistants(detail).at(-1)?.text).toBe('survived')
  })

  it('reports refusal and unrecognised stop reasons as failures', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'refuse', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('拒绝')
  })
})

describe('ACP approvals', () => {
  it('shows one-time options as advisory and forwards the selected one once', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'permission', requestId: rid() })
    const waiting = await until(bridge, sessionId, detail => detail.summary.status === 'waiting-approval')
    expect(waiting.approvals).toHaveLength(1)
    const [approval] = waiting.approvals
    expect(approval).toMatchObject({
      sessionId,
      toolName: 'execute',
      toolCallId: '1:call_1',
      reason: 'Run ls',
      arguments: JSON.stringify({ command: 'ls' }, null, 2),
      options: [
        { id: 'allow', label: 'Allow once', kind: 'allow_once' },
        { id: 'reject', label: 'Reject', kind: 'reject_once' },
      ],
      tool: { kind: 'execute', title: 'Run ls' },
      risk: 'R2',
      advisory: true,
    })
    expect(tool(waiting, 'tool:1:call_1')?.state).toBe('awaiting-approval')
    expect(waiting.activity).toEqual({ phase: 'approval', toolName: 'execute', since: expect.any(String) })
    expect(bridge.approvals()).toEqual([approval])

    await expect(bridge.decide(approval.id, 'reject', { optionId: 'allow' })).rejects.toMatchObject({
      status: 400,
      code: 'approval-option-mismatch',
    })
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'missing' })).rejects.toMatchObject({
      status: 400,
      code: 'approval-option-invalid',
    })
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'always' })).rejects.toMatchObject({
      status: 400,
      code: 'approval-option-hidden',
      message: '该选项会持久保存授权，Latch 不提供',
    })
    expect(await Promise.all([bridge.decide(approval.id, 'allow', { via: 'this-mac' }), bridge.decide(approval.id, 'allow')])).toEqual([
      true,
      false,
    ])

    const done = await settled(bridge, sessionId)
    expect(done.summary.status).toBe('idle')
    expect(tool(done, 'tool:1:call_1')).toMatchObject({ state: 'completed', text: 'ran with allow' })
    expect(tool(done, 'tool:1:call_1')?.tool?.decision).toEqual({ outcome: 'allowed', at: expect.any(String), via: 'this-mac' })
    expect(assistants(done).at(-1)?.text).toBe('allowed')
    const replies = received(await fixture.log(), null).filter(entry => entry.result?.outcome)
    expect(replies.map(entry => entry.result?.outcome)).toEqual([{ outcome: 'selected', optionId: 'allow' }])
  })

  it('forwards a rejection and keeps several approvals of one session open at once', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const rejected = await bridge.createTask({ prompt: 'permission', requestId: rid() })
    const [single] = (await until(bridge, rejected.sessionId, detail => detail.approvals.length === 1)).approvals
    // An agent's permission answer carries no text: a note is not passed on and does not fail the rejection.
    expect(await bridge.decide(single.id, 'reject', { via: 'other-device', note: '改用 docs/' })).toBe(true)
    const afterReject = await settled(bridge, rejected.sessionId)
    expect(tool(afterReject, 'tool:1:call_1')?.state).toBe('failed')
    expect(tool(afterReject, 'tool:1:call_1')?.tool?.decision).toEqual({ outcome: 'rejected', at: expect.any(String), via: 'other-device' })
    expect(JSON.stringify(await fixture.log())).not.toContain('改用 docs/')
    expect(assistants(afterReject).at(-1)?.text).toBe('rejected')

    const parallel = await bridge.createTask({ prompt: 'parallel', requestId: rid() })
    const open = (await until(bridge, parallel.sessionId, detail => detail.approvals.length === 2)).approvals
    const a = open.find(item => item.toolCallId === '1:call_a')!
    const b = open.find(item => item.toolCallId === '1:call_b')!
    expect(await bridge.decide(a.id, 'allow', { optionId: 'allow' })).toBe(true)
    expect((await bridge.detail(parallel.sessionId)).summary.status).toBe('waiting-approval')
    expect(await bridge.decide(b.id, 'reject')).toBe(true)
    expect(assistants(await settled(bridge, parallel.sessionId)).at(-1)?.text).toBe('a=allow b=reject')
  })

  it('keeps an allowance on a call asked about twice when the later ask is rejected', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'twice', requestId: rid() })
    const [first] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    expect(await bridge.decide(first.id, 'allow', { via: 'this-mac' })).toBe(true)
    const [second] = (await until(bridge, sessionId, detail => detail.approvals.some(item => item.id !== first.id))).approvals
    expect(await bridge.decide(second.id, 'reject', { via: 'other-device' })).toBe(true)
    const done = await settled(bridge, sessionId)
    expect(assistants(done).at(-1)?.text).toBe('second=reject')
    // a.txt was written under the first answer: the call keeps that allowance, its start and the diff it reported.
    const call = tool(done, 'tool:1:call_1')
    expect(call).toMatchObject({ state: 'completed', startedAt: expect.any(String) })
    expect(call?.tool?.decision).toEqual({ outcome: 'allowed', at: expect.any(String), via: 'this-mac' })
    expect(call?.tool?.diffs?.map(diff => diff.path)).toEqual(['/w/a.txt'])
  })

  it('reports a call the agent ran after a rejection as it reported it, next to the rejection', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'ignore', requestId: rid() })
    const [approval] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    expect(await bridge.decide(approval.id, 'reject', { via: 'other-device' })).toBe(true)
    const done = await settled(bridge, sessionId)
    expect(assistants(done).at(-1)?.text).toBe('ignored reject')
    const call = tool(done, 'tool:1:call_1')
    expect(call?.state).toBe('completed')
    expect(call?.tool?.decision).toEqual({ outcome: 'rejected', at: expect.any(String), via: 'other-device' })
    expect(call?.tool?.diffs?.map(diff => diff.path)).toEqual(['/w/a.txt'])
  })

  it('drops an approval the agent withdraws and answers it as cancelled', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'withdraw', requestId: rid() })
    const [approval] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    await until(bridge, sessionId, detail => detail.approvals.length === 0)
    expect(await bridge.decide(approval.id, 'allow')).toBe(false)
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(assistants(detail).at(-1)?.text).toBe('withdrawn -32800')
    expect(tool(detail, 'tool:1:call_1')?.state).toBe('failed')
    // Nobody answered an ask the agent withdrew: it leaves no decision.
    expect(tool(detail, 'tool:1:call_1')?.tool?.decision).toBeUndefined()
  })

  it('answers requests that offer only persistent or unknown choices without asking', async () => {
    const cases = [
      { prompt: 'persistent-only', reason: 'persistent-only', outcome: { outcome: 'selected', optionId: 'reject' } },
      { prompt: 'only-always', reason: 'persistent-only', outcome: { outcome: 'cancelled' } },
      { prompt: 'unknown-only', reason: 'unknown-kind', outcome: { outcome: 'selected', optionId: 'reject' } },
    ] as const
    const fixture = await setup()
    const bridge = await fixture.open()
    for (const item of cases) {
      const { sessionId } = await bridge.createTask({ prompt: item.prompt, requestId: rid() })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(detail.approvals).toEqual([])
      expect(systemText(detail)).toBe('已自动拒绝：Fake 只提供会持久保存的选项或未知选项，Latch 不提供。')
      expect(fixture.events).toContainEqual({ type: 'approval-auto-rejected', sessionId, reason: item.reason })
    }
    expect(answers(await fixture.log())).toEqual(cases.map(item => item.outcome))
  })

  it('hides unknown kinds but still offers the one-time choices', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'unknown-kind', requestId: rid() })
    const [approval] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    expect(approval.options?.map(option => option.id)).toEqual(['allow', 'reject'])
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'weird' })).rejects.toMatchObject({
      status: 400,
      code: 'approval-option-hidden',
    })
    expect(await bridge.decide(approval.id, 'allow')).toBe(true)
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('outcome allow')
    expect(fixture.events).toEqual([])
  })

  it('hides the option IDs a preset marks as persistent', async () => {
    const fixture = await preset('codex', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'read-only,workspace-write,agent-full-access,agent',
      FAKE_ACP_INITIAL_MODE: 'read-only',
      FAKE_ACP_DUMP_ENV: '1',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'amendment', requestId: rid() })
    const [approval] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    expect(approval.options?.map(option => option.id)).toEqual(['approved', 'abort'])
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'accept_execpolicy_amendment' })).rejects.toMatchObject({
      status: 400,
      code: 'approval-option-hidden',
    })
    await expect(bridge.decide(approval.id, 'allow', { optionId: 'apply_network_policy_amendment-example.com' })).rejects.toMatchObject({
      code: 'approval-option-hidden',
    })
    expect(await bridge.decide(approval.id, 'allow')).toBe(true)
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('outcome approved')
    const env = (await fixture.log()).find(entry => entry.event === 'env')!.env as Record<string, string>
    expect(env.INITIAL_AGENT_MODE).toBe('read-only')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'agent')).toBe('forbidden')
  })
})

describe('ACP cancellation', () => {
  it('answers open permissions as cancelled and waits for the prompt to settle', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'permission', requestId: rid() })
    await until(bridge, sessionId, detail => detail.approvals.length === 1)
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.summary.status).toBe('cancelled')
    expect(detail.approvals).toEqual([])
    expect(bridge.approvals()).toEqual([])
    expect(tool(detail, 'tool:1:call_1')?.state).toBe('cancelled')
    // Stopping answered the ask for nobody: cancelled, never a rejection and never with a device.
    expect(tool(detail, 'tool:1:call_1')?.tool?.decision).toEqual({ outcome: 'cancelled', at: expect.any(String) })
    expect(systemText(detail)).toBe('')
    const log = await fixture.log()
    const cancel = log.findIndex(entry => entry.event === 'recv' && entry.method === 'session/cancel')
    const answer = log.findIndex(entry => entry.event === 'recv' && entry.method === null && entry.result?.outcome)
    expect(cancel).toBeGreaterThan(-1)
    expect(answer).toBeGreaterThan(cancel)
    expect(log[answer].result?.outcome).toEqual({ outcome: 'cancelled' })
  })

  it('treats a turn ended with end_turn after cancel as cancelled and lets late tool reports win', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'endturn', requestId: rid() })
    await until(bridge, sessionId, detail => tool(detail, 'tool:1:call_2') !== undefined)
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.summary.status).toBe('cancelled')
    expect(systemText(detail)).toContain('end_turn')
    expect(tool(detail, 'tool:1:call_1')).toMatchObject({ state: 'completed', text: 'stopped cleanly' })
    expect(tool(detail, 'tool:1:call_2')).toMatchObject({ state: 'cancelled', text: expect.stringContaining('TOOL_NOT_STARTED') })
    expect(assistants(detail)[0]).toMatchObject({ text: 'working', state: 'completed' })
  })

  it('names each turn on the session and leaves a turn alone when a cancel names another', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo x', requestId: rid() })
    await settled(bridge, sessionId)
    const first = (await bridge.detail(sessionId)).summary.runId
    expect(first).toEqual(expect.any(String))
    expect(await bridge.cancel(sessionId, { runId: first! })).toBe(false)

    await bridge.prompt(sessionId, 'count 200', rid())
    await until(bridge, sessionId, detail => detail.liveText.length > 0)
    const second = (await bridge.detail(sessionId)).summary.runId
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
    expect(await bridge.cancel(sessionId, { runId: first! })).toBe(false)
    expect((await bridge.detail(sessionId)).summary.status).toBe('running')
    expect(await bridge.cancel(sessionId, { runId: second! })).toBe(true)
    expect((await bridge.detail(sessionId)).summary.status).toBe('cancelled')
    expect(received(await fixture.log(), 'session/cancel')).toHaveLength(1)

    await bridge.close()
    const reopened = await fixture.open()
    expect((await reopened.listTasks()).find(task => task.id === sessionId)?.runId).toBe(second)
  })

  it('kills only the process group of a session whose cancel never settles', async () => {
    const fixture = await setup({ FAKE_ACP_IGNORE_TERM: '1' })
    const bridge = await fixture.open()
    const stuck = await bridge.createTask({ prompt: 'hang', requestId: rid() })
    const other = await bridge.createTask({ prompt: 'count 1000', requestId: rid() })
    await until(bridge, stuck.sessionId, detail => tool(detail, 'tool:1:call_1')?.state === 'running')
    await until(bridge, other.sessionId, detail => detail.liveText.length > 0)
    const started = Date.now()
    await bridge.cancel(stuck.sessionId)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)

    const detail = await bridge.detail(stuck.sessionId)
    expect(detail.summary.status).toBe('interrupted')
    expect(systemText(detail)).toContain('强制结束')
    expect(tool(detail, 'tool:1:call_1')).toMatchObject({ state: 'failed', text: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') })
    expect(detail.summary.runEnd).toMatchObject({
      reason: 'forced-stop',
      unknownResults: [{ messageId: 'tool:1:call_1', name: 'Stuck job' }],
    })
    expect(detail.summary.live).toBeUndefined()
    // The other session runs in its own process and is untouched.
    expect((await bridge.detail(other.sessionId)).summary.status).toBe('running')

    const log = await fixture.log()
    expect(log.some(entry => entry.event === 'sigterm-ignored')).toBe(true)
    expect(alive(promptPid(log, 'hang'))).toBe(false)
    expect(alive(promptPid(log, 'count'))).toBe(true)
    await expect(bridge.prompt(stuck.sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'harness-session-lost' })
    expect((await bridge.detail(stuck.sessionId)).messages).toEqual(detail.messages)
    await bridge.cancel(other.sessionId)
    expect((await bridge.detail(other.sessionId)).summary.status).toBe('cancelled')
  })
})

describe('ACP cancellation before the prompt is sent', () => {
  it('withdraws a slow session/new without killing its process or touching other sessions', async () => {
    const fixture = await setup({ FAKE_ACP_SLOW_SETUP: '1000' })
    const bridge = await fixture.open()
    const busy = await bridge.createTask({ prompt: 'count 1000', requestId: rid() })
    await until(bridge, busy.sessionId, detail => detail.liveText.length > 0)
    const starting = await bridge.createTask({ prompt: 'echo never sent', requestId: rid() })
    await vi.waitFor(async () => expect(received(await fixture.log(), 'session/new')).toHaveLength(2), { timeout: 5_000, interval: 10 })
    expect((await bridge.detail(starting.sessionId)).summary.status).toBe('running')
    await bridge.cancel(starting.sessionId)

    const cancelled = await bridge.detail(starting.sessionId)
    expect(cancelled.summary.status).toBe('cancelled')
    expect(systemText(cancelled)).toBe('')
    // Well past the 300 ms grace: both processes and the other turn are untouched.
    await new Promise(resolve => setTimeout(resolve, 600))
    const neighbour = await bridge.detail(busy.sessionId)
    expect(neighbour.summary.status).toBe('running')
    const log = await fixture.log()
    const setupEntry = received(log, 'session/new')[1]
    expect(alive(setupEntry.pid)).toBe(true)
    expect(alive(promptPid(log, 'count'))).toBe(true)
    expect(
      received(log, '$/cancel_request')
        .filter(entry => entry.pid === setupEntry.pid)
        .map(entry => entry.params?.requestId),
    ).toContain(setupEntry.id)
    expect(received(log, 'session/prompt')).toHaveLength(1)
    await bridge.cancel(busy.sessionId)
    expect((await bridge.detail(busy.sessionId)).summary.status).toBe('cancelled')
  })

  it('withdraws a slow session/load without recording the prompt or touching other sessions', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'load', FAKE_ACP_SLOW_SETUP: '800' })
    const first = await fixture.open()
    const restored = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, restored.sessionId)
    await first.close()
    const bridge = await fixture.open()
    const busy = await bridge.createTask({ prompt: 'count 1000', requestId: rid() })
    await until(bridge, busy.sessionId, detail => detail.liveText.length > 0)

    const requestId = rid()
    const prompted = bridge.prompt(restored.sessionId, 'echo two', requestId)
    prompted.catch(() => {})
    await vi.waitFor(async () => expect(received(await fixture.log(), 'session/load')).toHaveLength(1), { timeout: 5_000, interval: 10 })
    await bridge.cancel(restored.sessionId)
    await expect(prompted).rejects.toMatchObject({ status: 409, code: 'cancelled-before-send' })
    const untouched = await bridge.detail(restored.sessionId)
    expect(untouched.summary.status).toBe('idle')
    expect(untouched.messages.map(message => message.text)).toEqual(['echo one', 'echo: echo one'])
    await new Promise(resolve => setTimeout(resolve, 500))
    expect((await bridge.detail(busy.sessionId)).summary.status).toBe('running')
    const log = await fixture.log()
    const load = received(log, 'session/load')[0]
    expect(
      received(log, '$/cancel_request')
        .filter(entry => entry.pid === load.pid)
        .map(entry => entry.params?.requestId),
    ).toContain(load.id)

    // The prompt was never recorded, so the same request can be sent again.
    await bridge.prompt(restored.sessionId, 'echo two', requestId)
    expect(assistants(await settled(bridge, restored.sessionId)).at(-1)?.text).toBe('echo: echo two')
    await bridge.cancel(busy.sessionId)
  })
})

describe('what a turn is really doing', () => {
  it('reports the model, then a command by name, and stays on a command still running when another ends', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'overlap', requestId: rid() })
    const detail = await until(bridge, sessionId, item => item.liveText === 'still going')
    expect(detail.activity?.phase).toBe('tool')
    expect(detail.summary.live).toMatchObject({ activity: 'command', commandName: 'pnpm lint', runId: detail.summary.runId })
    expect(detail.summary.live!.runStartedAt).toBe(detail.runStartedAt)
    expect(Date.parse(detail.summary.live!.lastEventAt)).toBeGreaterThanOrEqual(Date.parse(detail.summary.live!.lastOutputAt!))
    const row = (await bridge.listTasks()).find(task => task.id === sessionId)
    expect(row?.live?.activity).toBe('command')
    expect(bridge.liveRuns?.()).toEqual([{ sessionId, live: expect.objectContaining({ runId: detail.summary.runId }) }])
    await bridge.cancel(sessionId)
    expect(bridge.liveRuns?.()).toEqual([])
    expect((await bridge.detail(sessionId)).summary.live).toBeUndefined()
  })

  it('puts a command on one line, preferring what it was given', () => {
    const state = { id: 'x', content: [], locations: [], awaiting: 0 }
    expect(commandName({ ...state, rawInput: { command: 'pnpm test\n--watch=false\u202e' } })).toBe('pnpm test --watch=false')
    expect(commandName({ ...state, title: 'Run', rawInput: { command: ['bash', '-lc', 'ls'] } })).toBe('bash -lc ls')
    expect(commandName({ ...state, title: 'Run', rawInput: { command: 7 } })).toBe('Run')
    expect(commandName({ ...state, kind: 'execute' })).toBe('execute')
  })

  it('surfaces a request Latch does not recognise, answers it, and keeps its record without the secret', async () => {
    const secret = 'super-secret-value-123'
    const bridge = await (await setup({ FAKE_SECRET: secret })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'unknown', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    // The agent got its answers and went on, so nothing was left waiting.
    expect(detail.summary.status).toBe('idle')
    expect(
      assistants(detail)
        .map(item => item.text)
        .join(''),
    ).toContain('codes -32601 -32602')
    const notes = detail.messages.filter(item => item.role === 'system').map(item => item.text)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain('terminal/create')
    expect(notes[0]).toContain('make')
    expect(notes[0]).not.toContain(secret)
    expect(notes[1]).toContain('session/request_permission')
  })

  it('keeps the request out of the transcript for a turn with attachments', async () => {
    const inputRef = {
      id: 'abcdefghijklmnopqrstuv',
      name: 'image.png',
      kind: 'image' as const,
      mime: 'image/png' as const,
      size: 4,
      sha256: 'a'.repeat(64),
    }
    const fixture = await setup(
      { FAKE_ACP_CAPS: 'images,embedded,resume' },
      {},
      {},
      { readAttachment: async () => ({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }) },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'unknown', requestId: rid(), attachments: [inputRef] })
    const notes = (await settled(bridge, sessionId)).messages.filter(item => item.role === 'system').map(item => item.text)
    expect(notes[0]).toContain('terminal/create')
    expect(notes[0]).not.toContain('make')
  })

  it('reports unrecognised requests on the live turn, with the method in detail', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'unknownhang', requestId: rid() })
    const detail = await until(bridge, sessionId, item => (item.summary.live?.unrecognized?.count ?? 0) === 2)
    const note = detail.messages.find(item => item.id === detail.summary.live?.unrecognized?.messageId)
    expect(note?.text).toContain('terminal/create')
    expect(detail.summary.live?.unrecognized).toMatchObject({ count: 2, method: 'terminal/create' })
    // Nothing has happened since, and a client can tell.
    expect(detail.summary.live?.unrecognized?.at).toBe(detail.summary.live?.lastEventAt)
    expect(detail.summary.status).toBe('running')
    await bridge.cancel(sessionId)
  })

  it('dates an unrecognised request no earlier than the last sign of life, however slowly its note is written', async () => {
    let clock = 1_000_000
    const bridge = await (await setup({}, {}, {}, { clock: () => ++clock })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'unknownhang', requestId: rid() })
    const { live } = (await until(bridge, sessionId, item => (item.summary.live?.unrecognized?.count ?? 0) === 2)).summary
    expect(Date.parse(live!.unrecognized!.at)).toBeGreaterThanOrEqual(Date.parse(live!.lastEventAt))
    await bridge.cancel(sessionId)
  })
})

describe('ACP process failures', () => {
  it('fails a turn when the agent crashes, names what was running, redacts stderr, and restarts lazily', async () => {
    const fixture = await setup({ FAKE_SECRET: 'super-secret-value-123' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'crash', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    // Nobody knows whether the running call took effect: automations must not treat this as a failure they can retry.
    expect(detail.summary.runOutcome).toBe('interrupted')
    expect(detail.summary.runEnd).toMatchObject({
      reason: 'process-exited',
      unknownResults: [{ messageId: 'tool:1:call_1', name: 'Running job' }],
    })
    const note = systemText(detail)
    expect(note).toContain('退出码 3')
    // The note states the same outcome as the status.
    expect(note).toContain('本轮失败')
    expect(note).not.toContain('已中断')
    expect(note).toContain('Host 日志')
    // stderr can print any inherited value, so it stays out of the transcript every paired device reads.
    expect(note).not.toContain('fatal')
    expect(fixture.diagnostics.join('\n')).toContain('fatal: token=[redacted]')
    expect(fixture.diagnostics.join('\n')).not.toContain('super-secret-value-123')
    expect(assistants(detail)[0]).toMatchObject({ text: 'partial', state: 'completed' })
    expect(tool(detail, 'tool:1:call_1')?.state).toBe('failed')
    expect(tool(detail, 'tool:1:call_2')?.state).toBe('cancelled')
    expect(fixture.driver.status?.()).toMatchObject({ status: 'ready', statusMessage: expect.stringContaining('意外退出') })

    const next = await bridge.createTask({ prompt: 'echo after crash', requestId: rid() })
    const after = await settled(bridge, next.sessionId)
    expect(after.summary.status).toBe('idle')
    expect(after.summary.runEnd).toBeUndefined()
    expect(fixture.driver.status?.()).toEqual({ status: 'ready' })
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(2)
  })

  it('redacts an initialize error and keeps the start-up stderr in the Host log', async () => {
    const secret = 'fake-provider-credential-0001'
    const fixture = await setup({ FAKE_ACP_INIT_ERROR: '1', FAKE_SECRET: secret })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('Fake 启动失败：provider rejected API key [redacted]')
    expect(systemText(detail)).not.toContain('startup diagnostics')
    const status = fixture.driver.status?.()
    expect(status?.statusMessage).toBe('上次运行异常：provider rejected API key [redacted]')
    expect(JSON.stringify([detail, status])).not.toContain(secret)
    expect(fixture.diagnostics.join('\n')).toContain('startup diagnostics [redacted]')
    expect(fixture.diagnostics.join('\n')).not.toContain(secret)
  })

  it('pauses restarts for a full minute after the third crash', () => {
    const health = new AgentHealth()
    health.crashed(0)
    health.crashed(30_000)
    expect(health.pausedUntil(30_000)).toBeUndefined()
    health.crashed(59_000)
    expect(health.pausedUntil(59_000)).toBe(119_000)
    // The first crash leaving the window does not end the pause early.
    expect(health.pausedUntil(60_500)).toBe(119_000)
    expect(health.pausedUntil(118_999)).toBe(119_000)
    expect(health.pausedUntil(119_000)).toBeUndefined()
    expect(health.restartDelay(500, 119_000)).toBe(0)
  })

  it('pauses restarts after three crashes within a minute', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sessionId } = await bridge.createTask({ prompt: 'crash', requestId: rid() })
      expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    }
    expect(fixture.driver.status?.()).toMatchObject({ status: 'unavailable', statusMessage: expect.stringContaining('暂停自动重启') })
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('暂停自动重启')
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(3)
  })

  it('kills an agent that writes an oversized line', async () => {
    const bridge = await (await setup({}, { maxLineBytes: 4096 })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'big 10000', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(detail.summary.runEnd?.reason).toBe('process-exited')
    expect(systemText(detail)).toContain('单行消息')
    const next = await bridge.createTask({ prompt: 'echo ok', requestId: rid() })
    expect((await settled(bridge, next.sessionId)).summary.status).toBe('idle')
  })

  it('fails with login guidance instead of authenticating, and rejects other protocol versions', async () => {
    const fixture = await setup({ FAKE_ACP_AUTH: 'new' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('请在运行 Latch 的电脑上完成该 Harness 的登录')
    expect(systemText(detail)).toContain('Fake login：Run `fake login` in a terminal')
    await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'agent-auth-required' })
    expect(received(await fixture.log(), 'authenticate')).toEqual([])

    const promptAuth = await (await setup({ FAKE_ACP_AUTH: 'prompt' })).open()
    const gated = await promptAuth.createTask({ prompt: 'echo', requestId: rid() })
    expect(systemText(await settled(promptAuth, gated.sessionId))).toContain('Fake login')

    const mismatch = await setup({ FAKE_ACP_PROTOCOL: '2' })
    const newer = await mismatch.open()
    const failed = await newer.createTask({ prompt: 'echo', requestId: rid() })
    const result = await settled(newer, failed.sessionId)
    expect(result.summary.status).toBe('failed')
    expect(systemText(result)).toContain('ACP 协议版本 2')
    expect(mismatch.driver.status?.().statusMessage).toContain('ACP 协议版本 2')
  })
})

describe('ACP sessions across processes', () => {
  async function restart(env: Record<string, string>) {
    const fixture = await setup(env)
    const first = await fixture.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, sessionId)
    await first.close()
    const bridge = await fixture.open()
    return { fixture, bridge, sessionId }
  }

  it('resumes the ACP session after a Host restart', async () => {
    const { fixture, bridge, sessionId } = await restart({ FAKE_ACP_CAPS: 'resume' })
    expect(await bridge.listTasks()).toMatchObject([{ id: sessionId, status: 'idle' }])
    await bridge.prompt(sessionId, 'echo two', rid())
    const detail = await settled(bridge, sessionId)
    expect(detail.messages.map(message => message.text)).toEqual(['echo one', 'echo: echo one', 'echo two', 'echo: echo two'])
    const log = await fixture.log()
    const created = received(log, 'session/new')
    expect(created).toHaveLength(1)
    expect(received(log, 'session/resume')).toHaveLength(1)
    expect(received(log, 'session/load')).toEqual([])
  })

  it('loads the session and discards the replay when resume is unavailable', async () => {
    const { fixture, bridge, sessionId } = await restart({ FAKE_ACP_CAPS: 'load' })
    await bridge.prompt(sessionId, 'echo two', rid())
    const detail = await settled(bridge, sessionId)
    expect(detail.messages.map(message => message.text)).toEqual(['echo one', 'echo: echo one', 'echo two', 'echo: echo two'])
    expect(received(await fixture.log(), 'session/load')).toHaveLength(1)
  })

  it('refuses to continue a session the agent cannot restore', async () => {
    const { fixture, bridge, sessionId } = await restart({})
    const requestId = rid()
    await expect(bridge.prompt(sessionId, 'echo two', requestId)).rejects.toMatchObject({ status: 409, code: 'harness-session-lost' })
    await expect(bridge.prompt(sessionId, 'echo two', requestId)).rejects.toMatchObject({ status: 409, code: 'harness-session-lost' })
    const detail = await bridge.detail(sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(detail.messages).toHaveLength(2)
    expect(received(await fixture.log(), 'session/new')).toHaveLength(1)
  })

  it('stops an idle process only when its session can be resumed', async () => {
    const resumable = await setup({ FAKE_ACP_CAPS: 'resume' }, { idleMs: 80 })
    const bridge = await resumable.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect((await resumable.log()).some(entry => entry.event === 'stdin-end')).toBe(true), {
      timeout: 5_000,
      interval: 20,
    })
    await bridge.prompt(sessionId, 'echo two', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo two')
    const log = await resumable.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(2)
    expect(received(log, 'session/resume')).toHaveLength(1)

    const pinned = await setup({}, { idleMs: 40 })
    const kept = await pinned.open()
    const task = await kept.createTask({ prompt: 'echo', requestId: rid() })
    await settled(kept, task.sessionId)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await pinned.log()).some(entry => entry.event === 'stdin-end')).toBe(false)
  })

  it('starts a new process for work that arrives while an idle one is still exiting', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume', FAKE_ACP_EXIT_DELAY: '600' }, { idleMs: 80, stopGraceMs: 3_000 })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect((await fixture.log()).some(entry => entry.event === 'stdin-end')).toBe(true), {
      timeout: 5_000,
      interval: 10,
    })
    const firstPid = promptPid(await fixture.log(), 'echo one')
    expect((await fixture.log()).some(entry => entry.event === 'exit')).toBe(false)

    const [, created] = await Promise.all([
      bridge.prompt(sessionId, 'echo two', rid()),
      bridge.createTask({ prompt: 'echo three', requestId: rid() }),
    ])
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('echo: echo two')
    const fresh = await settled(bridge, created.sessionId)
    expect(fresh.summary.status).toBe('idle')
    expect(assistants(fresh).at(-1)?.text).toBe('echo: echo three')

    const log = await fixture.log()
    const successor = promptPid(log, 'echo two')
    expect(successor).not.toBe(firstPid)
    const exited = log.findIndex(entry => entry.event === 'exit' && entry.pid === firstPid)
    expect(exited).toBeGreaterThan(-1)
    expect(log.findIndex(entry => entry.event === 'start' && entry.pid === successor)).toBeGreaterThan(exited)
    expect(received(log, 'session/resume')).toHaveLength(1)
  })

  it('rejects a request at once when the connection is stopping instead of queuing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-acp-conn-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const connection = AgentConnection.spawn(
      {
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        cwd: root,
        maxLineBytes: 1 << 20,
        redact: text => text,
        env: { ...process.env, FAKE_ACP_EXIT_DELAY: '500', FAKE_ACP_LOG: join(root, 'agent.log') },
      },
      { request: () => Promise.resolve({}), notification: () => {}, exit: () => {} },
    )
    cleanups.push(async () => {
      await connection.stop('kill', 100)
    })
    await connection.request('initialize', { protocolVersion: 1 }, 5_000)
    const stopped = connection.stop('stop', 3_000)
    expect(connection.stopping).toBe(true)
    expect(connection.closed).toBe(false)
    await expect(connection.request('session/new', { cwd: root, mcpServers: [] }, 5_000)).rejects.toBeInstanceOf(ConnectionStopping)
    expect((await stopped).reason).toBe('stop')
  })

  it('makes a new ACP session durable before sending its first prompt', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    const checks = (await fixture.log()).filter(entry => entry.event === 'prompt-store')
    expect(checks).toHaveLength(1)
    expect(checks[0].durable).toBe(true)
  })

  it('deletes the agent copy of a removed session even when no process holds it', async () => {
    const { fixture, bridge, sessionId } = await restart({ FAKE_ACP_CAPS: 'resume,delete' })
    const agentSession = received(await fixture.log(), 'session/prompt')[0].params?.sessionId as string
    expect(Object.keys(await fixture.agentSessions())).toEqual([agentSession])
    await bridge.remove!(sessionId)
    await vi.waitFor(
      async () => expect(received(await fixture.log(), 'session/delete').map(entry => entry.params?.sessionId)).toEqual([agentSession]),
      { timeout: 5_000, interval: 10 },
    )
    await vi.waitFor(async () => expect(await fixture.agentSessions()).toEqual({}), { timeout: 5_000, interval: 10 })
    const starts = (await fixture.log()).filter(entry => entry.event === 'start')
    expect(starts).toHaveLength(2)
    // The short-lived process is stopped once it answered.
    await vi.waitFor(() => expect(alive(starts[1].pid)).toBe(false), { timeout: 5_000, interval: 20 })

    // An agent that never offered deletion is not started just to be told about it.
    const plain = await restart({ FAKE_ACP_CAPS: 'resume' })
    await plain.bridge.remove!(plain.sessionId)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await plain.fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)
  })

  it('does not start a process to delete a session whose project the Host no longer lists', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume,delete' }, { idleMs: 80 })
    const other = join(fixture.root, 'other')
    await mkdir(other)
    let workspaces = [fixture.workspace, other]
    const bridge = await fixture.open(() => workspaces)
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), cwd: other })
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect((await fixture.log()).some(entry => entry.event === 'exit')).toBe(true), {
      timeout: 5_000,
      interval: 20,
    })
    workspaces = [fixture.workspace]
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject({ status: 409, code: 'workspace-changed' })

    await bridge.remove!(sessionId)
    expect(await bridge.listTasks()).toEqual([])
    await vi.waitFor(() => expect(fixture.diagnostics.join('\n')).toContain('未启动 Fake 删除它自己保存的会话副本'), {
      timeout: 5_000,
      interval: 10,
    })
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(1)
    expect(received(log, 'session/delete')).toEqual([])
    expect(Object.keys(await fixture.agentSessions())).toHaveLength(1)
  })

  it('does not start a process to delete a session whose definition changed', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume,delete' })
    const first = await fixture.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, sessionId)
    await first.close()
    const changed = await fixture.redefine({ args: [FAKE_ACP_AGENT, '--changed'] })
    await changed.remove!(sessionId)
    await new Promise(resolve => setTimeout(resolve, 200))
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(1)
    expect(received(log, 'session/delete')).toEqual([])
  })

  it('marks turns interrupted on close and on recovery, and kills helper processes', async () => {
    const fixture = await setup({ FAKE_ACP_GRANDCHILD: '1' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'hang', requestId: rid() })
    await until(bridge, sessionId, detail => tool(detail, 'tool:1:call_1')?.state === 'running')
    const grandchild = (await fixture.log()).find(entry => entry.event === 'grandchild')!.grandchild as number
    expect(alive(grandchild)).toBe(true)
    await bridge.close()
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 3_000, interval: 20 })

    const reopened = await fixture.open()
    const detail = await reopened.detail(sessionId)
    expect(detail.summary.status).toBe('interrupted')
    expect(systemText(detail)).toContain('随 Latch 关闭')
    expect(tool(detail, 'tool:1:call_1')?.state).toBe('failed')
    expect(detail.summary.runEnd?.reason).toBe('host-stopped')
  })

  it('recovers tasks that were running when the Host stopped abruptly', async () => {
    const fixture = await setup()
    await mkdir(fixture.dataDir, { recursive: true })
    const updatedAt = new Date(0).toISOString()
    await writeFile(
      join(fixture.dataDir, 'acp.json'),
      JSON.stringify({
        version: 1,
        tasks: {
          stale: {
            summary: { id: 'stale', title: 'stale', status: 'waiting-approval', updatedAt, cwd: fixture.workspace, mode: 'agent' },
            messages: [
              { id: 'u', role: 'user', text: 'stale' },
              { id: 'tool:1:a', role: 'tool', toolName: 'execute', text: '', state: 'running', tool: { title: 'A' } },
              { id: 'tool:1:b', role: 'tool', toolName: 'execute', text: '', state: 'awaiting-approval' },
            ],
            revision: 3,
            acp: { acpSessionId: 'sess-gone', cwd: fixture.workspace, turnSeq: 1 },
          },
        },
        receipts: {},
      }),
    )
    const bridge = await fixture.open()
    const detail = await bridge.detail('stale')
    expect(detail.summary.status).toBe('interrupted')
    expect(detail.cursor).toBeGreaterThan(3)
    expect(tool(detail, 'tool:1:a')).toMatchObject({
      state: 'failed',
      tool: { title: 'A', output: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') },
    })
    expect(tool(detail, 'tool:1:b')?.state).toBe('cancelled')
    expect(systemText(detail)).toContain('上次运行被中断')
    expect(detail.summary.runEnd).toMatchObject({ reason: 'host-stopped', unknownResults: [{ messageId: 'tool:1:a', name: 'A' }] })
    const stored = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8'))
    expect(stored.tasks.stale.summary.status).toBe('interrupted')
    expect(await fixture.log()).toEqual([])
  })
})

describe('ACP session configuration', () => {
  it('folds legacy models and modes into config and routes changes to set_model and set_mode', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.config).toEqual([
      {
        id: 'model',
        name: '模型',
        category: 'model',
        currentValue: 'small',
        options: [
          { value: 'small', name: 'Fake Small' },
          { value: 'large', name: 'Fake Large' },
        ],
      },
      {
        id: 'mode',
        name: '模式',
        category: 'mode',
        currentValue: 'build',
        options: [
          { value: 'build', name: 'Build' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ])
    expect(detail.summary.model).toBe('Fake Small')

    await bridge.setConfig!(sessionId, 'model', 'large')
    // Without a profile every mode change counts as widening.
    await expect(bridge.setConfig!(sessionId, 'mode', 'plan')).rejects.toMatchObject({ status: 403, code: 'stepup-required' })
    await bridge.setConfig!(sessionId, 'mode', 'plan', { allowWiden: true })
    await expect(bridge.setConfig!(sessionId, 'model', 'huge')).rejects.toMatchObject({ status: 400 })
    await expect(bridge.setConfig!(sessionId, 'missing', 'x')).rejects.toMatchObject({ status: 404 })
    const changed = await bridge.detail(sessionId)
    expect(changed.summary.model).toBe('Fake Large')
    expect(changed.config?.map(option => option.currentValue)).toEqual(['large', 'plan'])
    expect(changed.permission).toMatchObject({ expectedMode: 'plan', readback: 'mode' })
    const log = await fixture.log()
    expect(received(log, 'session/set_model')[0].params).toMatchObject({ modelId: 'large' })
    expect(received(log, 'session/set_mode')[0].params).toMatchObject({ modeId: 'plan' })
    await bridge.prompt(sessionId, 'echo again', rid())
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(fixture.events).toEqual([])
  })

  it('uses configOptions exclusively and applies the full state set_config_option returns', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.config?.map(option => option.id)).toEqual(['model', 'effort'])
    expect(detail.config?.[1]).toMatchObject({
      category: 'thought_level',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    })
    expect(detail.summary.model).toBe('Small')
    expect(await bridge.classifyConfigChange!(sessionId, 'effort', 'high')).toBe('neutral')
    await bridge.setConfig!(sessionId, 'effort', 'high')
    await bridge.setConfig!(sessionId, 'model', 'large')
    const changed = await bridge.detail(sessionId)
    expect(changed.config?.map(option => option.currentValue)).toEqual(['large', 'high'])
    expect(changed.summary.model).toBe('Large')
    expect(received(await fixture.log(), 'session/set_config_option').map(entry => entry.params)).toMatchObject([
      { configId: 'effort', value: 'high' },
      { configId: 'model', value: 'large' },
    ])
  })
})

describe('ACP request identity and removal', () => {
  it('deduplicates create and prompt retries by requestId', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const requestId = rid()
    const [first, second] = await Promise.all([
      bridge.createTask({ prompt: 'echo x', requestId }),
      bridge.createTask({ prompt: 'echo x', requestId }),
    ])
    expect(second).toEqual(first)
    await expect(bridge.createTask({ prompt: 'echo y', requestId })).rejects.toMatchObject({ status: 409, code: 'request-conflict' })
    await settled(bridge, first.sessionId)

    const promptId = rid()
    await Promise.all([bridge.prompt(first.sessionId, 'count 20', promptId), bridge.prompt(first.sessionId, 'count 20', promptId)])
    await expect(bridge.prompt(first.sessionId, 'echo other', rid())).rejects.toMatchObject({ status: 409, code: 'task-running' })
    await settled(bridge, first.sessionId)
    await bridge.prompt(first.sessionId, 'count 20', promptId)
    await expect(bridge.prompt(first.sessionId, 'echo changed', promptId)).rejects.toMatchObject({ status: 409, code: 'request-conflict' })
    const detail = await settled(bridge, first.sessionId)
    expect(userTexts(detail)).toEqual(['echo x', 'count 20'])
    expect(await bridge.listTasks()).toHaveLength(1)
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(2)
  })

  it('removes settled sessions, keeps a tombstone for the creation request, and deletes advertised agent sessions', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'delete' })
    const bridge = await fixture.open()
    const requestId = rid()
    const { sessionId } = await bridge.createTask({ prompt: 'count 200', requestId })
    await until(bridge, sessionId, detail => detail.liveText.length > 0)
    await expect(bridge.remove!(sessionId)).rejects.toMatchObject({ status: 409, code: 'task-running' })
    await bridge.cancel(sessionId)
    expect((await bridge.detail(sessionId)).summary.status).toBe('cancelled')
    await bridge.remove!(sessionId)
    expect(await bridge.listTasks()).toEqual([])
    await expect(bridge.detail(sessionId)).rejects.toMatchObject({ status: 404 })
    await expect(bridge.createTask({ prompt: 'count 200', requestId })).rejects.toMatchObject({ status: 410, code: 'task-deleted' })
    await vi.waitFor(async () => expect(received(await fixture.log(), 'session/delete')).toHaveLength(1), { timeout: 5_000, interval: 10 })
    const deleted = received(await fixture.log(), 'session/delete')
    expect(deleted[0].params?.sessionId).toBe(received(await fixture.log(), 'session/prompt')[0].params?.sessionId)

    await bridge.close()
    const reopened = await fixture.open()
    await expect(reopened.createTask({ prompt: 'count 200', requestId })).rejects.toMatchObject({ status: 410 })
  })
})

const ms = (value: string | undefined) => Date.parse(value ?? '')

describe('ACP times and usage reports', () => {
  it('uses one approval wait timestamp even when every clock read advances', async () => {
    let clock = Date.parse('2026-10-26T00:00:00Z')
    const bridge = await (await setup({}, {}, {}, { clock: () => ++clock })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'permission', requestId: rid() })
    const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    expect(waiting.activity).toMatchObject({ phase: 'approval', since: waiting.runWaitingSince })
    await bridge.cancel(sessionId)
  })
  it('records reply, reasoning and tool times, and a turn without its approval wait', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'think', requestId: rid() })
    const thought = await settled(bridge, sessionId)
    const [user, answer] = thought.messages
    expect(user).toMatchObject({ role: 'user', createdAt: expect.any(String), turn: { endedAt: expect.any(String), waitMs: 0 } })
    expect(answer).toMatchObject({ role: 'assistant', text: 'answer', reasoning: 'pondering deeply', reasoningMs: expect.any(Number) })
    expect(ms(answer?.createdAt)).toBeLessThanOrEqual(ms(answer?.completedAt))
    expect(ms(user?.createdAt)).toBeLessThanOrEqual(ms(answer?.createdAt))
    expect(user?.turn?.activeMs).toBe(ms(user?.turn?.endedAt) - ms(user?.createdAt))

    await bridge.prompt(sessionId, 'tool', rid())
    const row = tool(await settled(bridge, sessionId), 'tool:2:call_1')
    expect(row).toMatchObject({
      state: 'completed',
      createdAt: expect.any(String),
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    })
    expect(ms(row?.createdAt)).toBeLessThanOrEqual(ms(row?.startedAt))
    expect(ms(row?.startedAt)).toBeLessThanOrEqual(ms(row?.completedAt))

    await bridge.prompt(sessionId, 'permission', rid())
    const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    expect(waiting).toMatchObject({
      runStartedAt: expect.any(String),
      runWaitingSince: expect.any(String),
      activity: { phase: 'approval', since: waiting.runWaitingSince },
    })
    await new Promise(done => setTimeout(done, 60))
    expect(await bridge.decide(waiting.approvals[0]?.id ?? '', 'allow')).toBe(true)
    const done = await settled(bridge, sessionId)
    const prompt = done.messages.findLast(message => message.role === 'user')
    expect(prompt?.turn?.waitMs).toBeGreaterThanOrEqual(50)
    expect(prompt?.turn?.activeMs).toBe(ms(prompt?.turn?.endedAt) - ms(prompt?.createdAt) - (prompt?.turn?.waitMs ?? 0))
    expect(done).not.toHaveProperty('runStartedAt')
  })

  it('keeps a queued input timestamp, request identity and explicit completion through restart', async () => {
    const fixture = await setup(),
      bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo first', requestId: rid() })
    await settled(bridge, sessionId)
    const requestId = rid(),
      queuedAt = '2026-10-25T06:00:00.000Z'
    await bridge.prompt(sessionId, 'echo queued', requestId, { queuedAt })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.runOutcome).toBe('completed')
    await bridge.close()
    const restored = await (await fixture.open()).detail(sessionId)
    expect(restored.summary.runOutcome).toBe('completed')
    expect(restored.messages.findLast(message => message.role === 'user')).toMatchObject({ requestId, queuedAt })
  })
  it('maps the agent usage report and keeps it across restarts', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.usageReport).toEqual({ contextUsed: 10, contextSize: 100, at: expect.any(String) })
    expect(detail.summary.createdAt).toEqual(expect.any(String))
    await bridge.close()
    const reopened = await fixture.open()
    const restored = await reopened.detail(sessionId)
    expect(restored.usageReport).toEqual(detail.usageReport)
    expect(restored.messages).toEqual(detail.messages)
    expect(restored.messages.find(message => message.role === 'user')?.requestId).toEqual(expect.any(String))
  })
})

describe('ACP file observation', () => {
  it('persists late files on their original reply while a newer turn retains its own projection and status', async () => {
    const inputs: FileTrackingInput[] = []
    const finishes: Array<{ promise: Promise<FileTrackingResult>; resolve: (value: FileTrackingResult) => void }> = []
    const f = await setup(
      {},
      {},
      {},
      {
        trackFiles: async input => {
          inputs.push(input)
          let resolve!: (value: FileTrackingResult) => void
          const promise = new Promise<FileTrackingResult>(done => {
            resolve = done
          })
          finishes.push({ promise, resolve })
          return { finish: () => promise, dispose: () => resolve({ files: [], truncated: true }) }
        },
      },
    )
    const bridge = await f.open()
    const { sessionId } = await bridge.createTask({ prompt: 'first', requestId: rid() })
    const first = await settled(bridge, sessionId)
    const reply = assistants(first).at(-1)!
    expect(reply.outputsPending).toBe(true)
    await bridge.prompt(sessionId, 'second', rid())
    const second = await settled(bridge, sessionId)
    inputs[1]!.onChange({ files: [{ root: 'default', path: 'second.md', change: 'modified' }] })
    inputs[0]!.onChange({ files: [{ root: 'default', path: 'wrong.md', change: 'modified' }] })
    finishes[0]!.resolve({ files: [{ root: 'default', path: 'first.md', change: 'modified' }] })
    await until(bridge, sessionId, detail => detail.messages.find(message => message.id === reply.id)?.outputsPending === undefined)
    const after = await bridge.detail(sessionId)
    expect(after.summary).toEqual(second.summary)
    expect(after.fileChanges).toMatchObject({ runId: inputs[1]!.runId, files: [{ path: 'second.md' }] })
    finishes[1]!.resolve({ files: [{ root: 'default', path: 'second.md', change: 'modified' }] })
    await until(bridge, sessionId, detail => detail.fileChanges === undefined)
    await bridge.close()
    const loaded = await (await f.open()).detail(sessionId)
    expect(loaded.messages.find(message => message.id === reply.id)?.outputs).toMatchObject([{ path: 'first.md' }])
  })
})

it('marks a recovered idle ACP file observation partial without changing the conversation order', async () => {
  const fixture = await setup()
  await mkdir(fixture.dataDir, { recursive: true })
  await writeFile(
    join(fixture.dataDir, 'acp.json'),
    JSON.stringify({
      version: 1,
      tasks: {
        idle: {
          summary: { id: 'idle', title: 'idle', status: 'idle', updatedAt: '2020-01-01T00:00:00Z', mode: 'agent' },
          messages: [
            {
              id: 'a',
              role: 'assistant',
              text: 'done',
              outputs: [{ root: 'default', path: 'result.txt', change: 'modified' }],
              outputsPending: true,
            },
          ],
          revision: 1,
          acp: { cwd: fixture.workspace, turnSeq: 1 },
        },
      },
      receipts: {},
    }),
  )
  const detail = await (await fixture.open()).detail('idle')
  expect(detail.summary.status).toBe('idle')
  expect(detail.summary.updatedAt).toBe('2020-01-01T00:00:00Z')
  expect(detail.messages[0]).toMatchObject({ outputs: [{ path: 'result.txt' }], outputsTruncated: true })
  expect(detail.messages[0]!.outputsPending).toBeUndefined()
})
