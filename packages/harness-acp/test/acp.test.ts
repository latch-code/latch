import type { FileTrackingInput, FileTrackingResult } from '@latch/sdk'
import { AppError } from '@latch/sdk'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isReservedAgentEnvName,
  LADDER_MODE,
  ownChoice,
  serviceChoice,
  simulatorInputName,
  simulatorInputTool,
  type DriverTaskDetail,
  type Message,
  type SessionConfigOption,
} from '@latch/protocol'
import type {
  ConsultationGuardEvidence,
  HarnessHostOptions,
  HarnessDriver,
  HarnessSecurityEvent,
  HarnessTurnRecord,
  MemoryProposalInput,
  ScheduleProposalInput,
  HarnessPlugin,
  Bridge,
  HostProject,
  ModelGateway,
  ModelRoute,
  ToolGateway,
  ToolGatewayCallContext,
  ProjectFolder,
} from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { FAKE_ACP_AGENT, FAKE_PI_AGENT, startFakeModels, type FakeModels } from '@latch/testkit'
import { AcpWire } from '../src/wires/acp.ts'
import {
  PROPOSAL_LIMITS,
  readProposals,
  readRounds,
  skillsServer,
  TEAM_FILE,
  writeRoundAnswer,
  writeTeamRoster,
} from '../src/skills-server.ts'
import { ownTool, proposalTurn } from '../src/runtime.ts'
import { ConnectionStopping, isRecord } from '../src/wires/process.ts'
import { agentEnvironment, programPaths } from '../src/environment.ts'
import { commandName } from '../src/mapping.ts'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  personCommandDirectories,
  resolveCommand,
  setCommandSearch,
  setLoginPrograms,
  type AcpAgentOptions,
  type AgentRecord,
  type CliStoreAccess,
} from '../src/index.ts'
import { classifyMode, filterPermissionOptions, launchHash, selectProfile, validateAgentDefinition } from '../src/permission.ts'
import { FALLBACK_PROFILES, HARNESS_PROFILES, profileFor } from '../src/profiles/index.ts'
import { fingerprintProjectConfig, PROJECT_CONFIG_LIMITS } from '../src/project-config.ts'
import { agentProbePreview } from '../src/probe.ts'
import { initializeResult } from '../src/protocol.ts'
import { AgentHealth } from '../src/types.ts'
import * as commandCache from '../src/command-cache.ts'
import { withHarnessPromptSource } from '../src/prompt-source.ts'
import { cliTree, fakeCli, seedCliFiles } from './helpers/cli-config.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000 }
const QWEN_MODES = 'plan,default,auto-edit,yolo,auto'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})

interface LogEntry {
  textOnly?: boolean
  pid: number
  event: string
  method?: string | null
  id?: number | string | null
  params?: Record<string, unknown>
  result?: { outcome?: Record<string, unknown> } & Record<string, unknown>
  [key: string]: unknown
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(finish => {
    resolve = finish
  })
  return { promise, resolve }
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

/**
 * The profile a fixture of this preset runs with: these fixtures launch `node`, not the preset's own program, so a preset
 * with an adapter runs on the adapter's profile.
 */
const fixtureProfile = (presetId: string) => FALLBACK_PROFILES.get(presetId) ?? profileFor(presetId)

/** What a preset's own profile adds to its launch fingerprint. */
const launchExtras = (presetId: string) => {
  const permission = fixtureProfile(presetId)!.permission
  return { ...(permission.inheritEnv ? { inheritEnv: permission.inheritEnv } : {}), programs: programPaths(permission) }
}

async function setup(
  env: Record<string, string> = {},
  options: AcpAgentOptions = {},
  overrides: Partial<AgentRecord> = {},
  attachmentOptions: Pick<
    HarnessHostOptions,
    | 'readAttachment'
    | 'saveAttachment'
    | 'trackFiles'
    | 'clock'
    | 'securityEvent'
    | 'modelGateway'
    | 'proposeMemory'
    | 'proposeSchedule'
    | 'toolGateway'
    | 'turnEnded'
  > = {},
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
        return attachmentOptions.securityEvent?.(event)
      },
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    // Stands in for the Host's start, which records the launch fingerprint of the preview, unless a test passes its own.
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
                ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
                ...(input.config ? { config: input.config } : {}),
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

async function until(bridge: Bridge, id: string, predicate: (detail: DriverTaskDetail) => boolean): Promise<DriverTaskDetail> {
  await vi.waitFor(async () => expect(predicate(await bridge.detail(id))).toBe(true), { timeout: 8_000, interval: 10 })
  return bridge.detail(id)
}

function settled(bridge: Bridge, id: string): Promise<DriverTaskDetail> {
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

const assistants = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'assistant')
const systemText = (detail: DriverTaskDetail) =>
  detail.messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join('\n')
const tool = (detail: DriverTaskDetail, id: string) => detail.messages.find(message => message.id === id)
const userTexts = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'user').map(message => message.text)
/** pid of the process that received the prompt starting with `text`. */
const promptPid = (log: LogEntry[], text: string) =>
  received(log, 'session/prompt').find(entry => (entry.params?.prompt as Array<{ text: string }>)[0].text.startsWith(text))!.pid
const answers = (log: LogEntry[]) => log.filter(entry => entry.event === 'permission-answer').map(entry => entry.outcome)
/** The step id of call `callId` of the fake's subagent (`<session>:child`): a hash, so ids never collide across sessions. */
const childStepId = async (fixture: { dataDir: string }, sessionId: string, callId: string) => {
  const { acpSessionId } = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).tasks[sessionId].acp
  return `tool:${sha256Hex(JSON.stringify([sessionId, `${acpSessionId}:child`, callId]))}`
}

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
    // Until the start script turns the search on, a bare name finds nothing, so no test reaches a real program.
    expect(resolveCommand('node')).toBeUndefined()
    const bin = await realpath(await mkdtemp(join(tmpdir(), 'latch-acp-bin-')))
    cleanups.push(() => rm(bin, { recursive: true, force: true }))
    await symlink(process.execPath, join(bin, 'node'))
    setCommandSearch(() => [bin])
    expect(resolveCommand('node')).toBe(join(bin, 'node'))
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
    expect(driver).toMatchObject({ id: 'missing', name: 'Missing', capabilities: { modes: ['agent'], models: { owner: 'harness' } } })
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
    // Every directory the start script would search, but only those in the stand-in home are looked in: the fixed
    // install directories hold whatever is installed on the computer running the test.
    expect(personCommandDirectories()).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/usr/local/bin', join(home, '.volta/bin')]))
    setCommandSearch(() => personCommandDirectories().filter(directory => directory.startsWith(`${home}/`)))
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

  it('says when only the adapter of an installed program is missing, and looks again after a re-check', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'latch-acp-home-')))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const bin = join(home, '.volta/bin')
    await mkdir(bin, { recursive: true })
    hostEnv({ HOME: home, PATH: '/usr/bin:/bin' })
    // Only this directory: a real Codex installed on this computer must not count.
    setCommandSearch(() => [bin])
    const driver = await activate(
      createAcpAgentPlugin({ id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {}, enabled: true }),
    )
    const install = (command: string) => installCommand(bin, command)
    expect(driver.status?.()).toEqual({
      status: 'unavailable',
      statusMessage: '未找到命令 codex-acp。安装：npm i -g @agentclientprotocol/codex-acp',
    })
    await install('codex')
    // The lookup is cached for a few seconds; a re-check drops it.
    forgetCommandLookups()
    expect(driver.status?.()).toEqual({
      status: 'unavailable',
      statusMessage: '已安装 codex，还差让 Latch 连接它的适配器 codex-acp。安装：npm i -g @agentclientprotocol/codex-acp',
    })
    await install('codex-acp')
    expect(driver.status?.().status).toBe('unavailable')
    forgetCommandLookups()
    expect(driver.status?.()).toEqual({ status: 'ready' })
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
      'CODEX_HOME',
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
    // A definition of a preset Latch no longer has gets no profile, not even another preset's by its command's name.
    expect(selectProfile({ ...base, presetId: 'gemini', command: 'gemini', args: ['--acp'] })).toEqual({ verified: false })
    expect(selectProfile({ ...base, presetId: 'gemini', command: 'qwen', args: ['--acp'] })).toEqual({ verified: false })
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
      profileVersion: 1,
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
      { profileVersion: 2 },
    ])
      expect(launchHash({ ...input, ...changed })).not.toBe(hash)
  })

  it('classifies modes against the expected one with the preset ladder', () => {
    const qwen = profileFor('qwen')!.permission
    expect(classifyMode(qwen, 'default', 'default')).toBe('neutral')
    expect(classifyMode(qwen, 'default', 'plan')).toBe('stricter')
    expect(classifyMode(qwen, 'default', 'auto-edit')).toBe('wider')
    expect(classifyMode(qwen, 'default', 'yolo')).toBe('wider')
    // A mode where a model approves ranks between asking and never asking; the agent moving itself there is still wider.
    expect(classifyMode(qwen, 'default', 'auto')).toBe('wider')
    expect(classifyMode(qwen, 'yolo', 'auto')).toBe('stricter')
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
    const codex = FALLBACK_PROFILES.get('codex')!.permission
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
    setCommandSearch(() => (process.env.PATH ?? '').split(delimiter))

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
      SSL_CERT_FILE: '/tmp/ca.pem',
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
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
        'OPENAI_BASE_URL',
      ]) {
        expect(env[name], name).toBeUndefined()
      }
      expect(env).toMatchObject({
        HTTPS_PROXY: 'http://proxy.invalid:3128',
        SSL_CERT_FILE: '/tmp/latch-ca.pem',
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
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

  it('advertises no client file system or terminal, and that it shows notices, compaction, subagents and terminal logins', async () => {
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
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { notices: {}, compaction: {} },
        subagents: {},
        auth: { terminal: true },
      },
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

  it("warms a reclaimed session's process without a turn and leaves an already warm process alone", async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' }, { maxProcesses: 1, idleMs: 80 })
    const bridge = await fixture.open()
    const wires: AcpWire[] = []
    const spawn = AcpWire.spawn
    const started = vi.spyOn(AcpWire, 'spawn').mockImplementation((...args) => {
      const wire = spawn(...args)
      wires.push(wire)
      return wire
    })
    const restore = () => {
      vi.useRealTimers()
      started.mockRestore()
    }
    cleanups.push(restore)
    try {
      const first = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
      await settled(bridge, first.sessionId)
      expect(wires).toHaveLength(1)
      // The fixture logs `exit` before its process actually closes. Only `exited` also waits for the runtime's
      // exit handler to release the slot, after the real idle timer has reclaimed the process.
      expect((await wires[0]!.exited).reason).toBe('stop')
      const prompts = received(await fixture.log(), 'session/prompt').length
      // Keep the newly warmed process in its idle window while checking it, regardless of test-runner load.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      expect(await bridge.warm!(first.sessionId)).toBe(true)
      expect(await bridge.warm!(first.sessionId)).toBe(false)
      const log = await fixture.log()
      expect(log.filter(entry => entry.event === 'start')).toHaveLength(2)
      expect(received(log, 'session/resume')).toHaveLength(1)
      expect(received(log, 'session/prompt')).toHaveLength(prompts)
    } finally {
      restore()
    }
  })

  it("warms only under the process limit, never stopping another session's process", async () => {
    const busy = await setup({ FAKE_ACP_CAPS: 'resume' }, { maxProcesses: 1, idleMs: 60_000 })
    const kept = await busy.open()
    const a = await kept.createTask({ prompt: 'echo a', requestId: rid() })
    await settled(kept, a.sessionId)
    const b = await kept.createTask({ prompt: 'echo b', requestId: rid() })
    await settled(kept, b.sessionId)
    let log = await busy.log()
    const bPid = promptPid(log, 'echo b')
    expect(await kept.warm!(a.sessionId)).toBe(false)
    log = await busy.log()
    expect(log.some(entry => entry.event === 'stdin-end' && entry.pid === bPid)).toBe(false)
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(2)
    expect(await kept.warm!('missing-session')).toBe(false)
  })

  it('warms nothing in a folder, under a definition or with a command a turn would refuse', async () => {
    // A folder the Host no longer lists.
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' }, { idleMs: 80 })
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
    expect(await bridge.warm!(sessionId)).toBe(false)
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)

    // A definition changed since the session was confirmed.
    const defined = await setup({ FAKE_ACP_CAPS: 'resume' })
    const first = await defined.open()
    const started = await first.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(first, started.sessionId)
    await first.close()
    const changed = await defined.redefine({ env: { ...defined.record.env, FAKE_EXTRA: '1' } })
    expect(await changed.warm!(started.sessionId)).toBe(false)
    expect((await defined.log()).filter(entry => entry.event === 'start')).toHaveLength(1)
    expect(received(await defined.log(), 'session/resume')).toEqual([])
  })

  it('reclaims an unattended run of 我的 Agent as soon as a Code session, even where it cannot propose', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' }, { idleMs: 60, agentIdleMs: 60_000 })
    const bridge = await fixture.open()
    const run = await bridge.createTask({
      prompt: 'echo scheduled',
      requestId: rid(),
      agentContext: { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', revision: 'a'.repeat(64), unattended: true },
    })
    await settled(bridge, run.sessionId)
    const pid = promptPid(await fixture.log(), 'echo scheduled')
    await vi.waitFor(async () => expect((await fixture.log()).some(entry => entry.event === 'stdin-end' && entry.pid === pid)).toBe(true), {
      timeout: 5_000,
      interval: 20,
    })
  })

  it("keeps an idle process of one of 我的 Agent longer than a Code session's", async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' }, { idleMs: 60, agentIdleMs: 60_000 })
    const bridge = await fixture.open()
    const agent = await bridge.createTask({
      prompt: 'echo helper',
      requestId: rid(),
      agentContext: { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', revision: 'a'.repeat(64) },
    })
    await settled(bridge, agent.sessionId)
    const code = await bridge.createTask({ prompt: 'echo code', requestId: rid() })
    await settled(bridge, code.sessionId)
    const log = await fixture.log()
    const codePid = promptPid(log, 'echo code'),
      agentPid = promptPid(log, 'echo helper')
    await vi.waitFor(
      async () => expect((await fixture.log()).some(entry => entry.event === 'stdin-end' && entry.pid === codePid)).toBe(true),
      {
        timeout: 5_000,
        interval: 20,
      },
    )
    expect((await fixture.log()).some(entry => entry.event === 'stdin-end' && entry.pid === agentPid)).toBe(false)
  })
})

describe('ACP launch fingerprint', () => {
  it('starts a session only with a launch fingerprint on record', async () => {
    const fixture = await setup({ FAKE_SECRET: 'top-secret-value' })
    const bridge = await fixture.open()
    await expect(bridge.createTask({ prompt: 'echo', requestId: rid(), expectedLaunchHash: undefined })).rejects.toMatchObject({
      status: 409,
      code: 'l3-confirmation-missing',
      message: '此会话缺少启动记录，不能启动。',
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
      envNames: expect.arrayContaining(['FAKE_SECRET', 'FAKE_ACP_LOG', 'PATH', 'TMPDIR', 'GIT_CONFIG_COUNT']),
      // Only what the definition sets; the launch environment's own names stay out.
      definitionEnvNames: Object.keys(fixture.record.env).sort(),
      verified: false,
      approvals: 'prompts',
      readback: 'none',
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
    // A new session starts under the changed definition.
    const fresh = await changed.createTask({ prompt: 'echo three', requestId: rid() })
    expect((await settled(changed, fresh.sessionId)).summary.status).toBe('idle')
  })

  it('keeps sessions created before launch fingerprints were recorded read-only', async () => {
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
      message: '此会话创建于安全升级之前，不能继续。请新建会话。',
    }
    await expect(bridge.prompt('old', 'echo again', rid())).rejects.toMatchObject(missing)
    await expect(bridge.setConfig!('old', 'model', 'large')).rejects.toMatchObject(missing)
    expect((await bridge.detail('old')).messages).toHaveLength(1)
    expect(await fixture.log()).toEqual([])
  })
})

describe('ACP project configuration', () => {
  it.each(['.agents/hooks.json', '.agent/hooks.json', '_agents/hooks.json', '_agent/hooks.json', '.gemini/config.json'])(
    'refuses Antigravity input after changing the loaded project configuration %s',
    async file => {
      const fixture = await preset('antigravity', {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_MODES: 'default,auto',
        FAKE_ACP_INITIAL_MODE: 'default',
      })
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'echo before configuration', requestId: rid() })
      await settled(bridge, sessionId)
      const path = join(fixture.workspace, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '{}')
      await expect(bridge.prompt(sessionId, 'echo after configuration', rid())).rejects.toMatchObject({
        status: 409,
        code: 'project-config-changed',
      })
      expect(received(await fixture.log(), 'session/prompt')).toHaveLength(1)
    },
  )
  const opencode = (options: AcpAgentOptions = {}, env: Record<string, string> = {}) =>
    preset('opencode', { FAKE_ACP_CONFIG: 'legacy', ...env }, options)
  const definitionHash = (record: AgentRecord) =>
    launchHash({
      resolvedCommand: process.execPath,
      args: [FAKE_ACP_AGENT],
      definitionEnv: record.env,
      presetId: record.presetId,
      profileVersion: fixtureProfile(record.presetId!)!.version,
      ...launchExtras(record.presetId!),
    })
  const CHANGED = {
    status: 409,
    code: 'project-config-changed',
    message: '项目中的 OpenCode 配置与会话启动时不同，该会话不能继续。请新建会话。',
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

  it('binds the content of the configuration found in or above the project into the launch fingerprint', async () => {
    const fixture = await opencode()
    const bridge = await fixture.open()
    const preview = () => bridge.launchPreview!({ cwd: fixture.workspace })
    const base = definitionHash(fixture.record)
    expect(await preview()).toMatchObject({ launchHash: base })

    await writeFile(join(fixture.workspace, 'opencode.json'), '{}')
    const added = await preview()
    expect(added.launchHash).not.toBe(base)
    await writeFile(join(fixture.workspace, 'opencode.json'), '{"permission":"allow"}')
    expect((await preview()).launchHash).not.toBe(added.launchHash)

    // A directory counts with everything below it, except what OpenCode writes there itself.
    const own = join(fixture.workspace, '.opencode')
    await mkdir(join(own, 'agent'), { recursive: true })
    await writeFile(join(own, 'agent', 'build.md'), 'permission: allow')
    const agent = await preview()
    expect(agent.launchHash).not.toBe(added.launchHash)
    await openCodeOwnWrites(own)
    expect(await preview()).toEqual(agent)
    await writeFile(
      join(own, 'package.json'),
      JSON.stringify({ scripts: { postinstall: 'node run.js' }, dependencies: { '@opencode-ai/plugin': '1.1.25' } }),
    )
    const scripted = await preview()
    expect(scripted.launchHash).not.toBe(agent.launchHash)
    await rm(own, { recursive: true })
    await rm(join(fixture.workspace, 'opencode.json'))

    // Above the project it counts too; the home directory holds user configuration and is skipped.
    await writeFile(join(fixture.root, 'opencode.jsonc'), '{}')
    expect((await preview()).launchHash).not.toBe(base)
    hostEnv({ HOME: fixture.root })
    expect(await preview()).toMatchObject({ launchHash: base })

    // Other harnesses do not read these files.
    const goose = await preset('goose')
    await writeFile(join(goose.workspace, 'opencode.json'), '{}')
    expect(await (await goose.open()).launchPreview!({ cwd: goose.workspace })).toMatchObject({
      launchHash: definitionHash(goose.record),
    })
  })

  it("counts Qwen Code's project skills and MCP servers, and goose's project recipes and agent sources", async () => {
    for (const [presetId, files] of [
      ['qwen', ['.mcp.json', '.agents/skills/review/SKILL.md']],
      ['goose', ['.goose/recipes/ship.yaml', '.agents/recipes/ship.yaml', '.agents/agents/helper.md']],
    ] as const) {
      for (const file of files) {
        const fixture = await preset(presetId)
        const bridge = await fixture.open()
        const before = (await bridge.launchPreview!({ cwd: fixture.workspace })).launchHash
        await mkdir(dirname(join(fixture.workspace, file)), { recursive: true })
        await writeFile(join(fixture.workspace, file), 'model: elsewhere\n')
        expect((await bridge.launchPreview!({ cwd: fixture.workspace })).launchHash, `${presetId} ${file}`).not.toBe(before)
      }
    }
    // Claude's own agent definitions are Claude's settings: goose's fingerprint does not read them.
    const goose = await preset('goose')
    await mkdir(join(goose.workspace, '.claude', 'agents'), { recursive: true })
    await writeFile(join(goose.workspace, '.claude', 'agents', 'helper.md'), 'model: elsewhere\n')
    expect(await (await goose.open()).launchPreview!({ cwd: goose.workspace })).toMatchObject({ launchHash: definitionHash(goose.record) })
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
    expect(found.launchHash).not.toBe(definitionHash(fixture.record))
    const realParent = join(await realpath(fixture.root), 'b', 'opencode.jsonc')
    await writeFile(realParent, '{}')
    expect((await preview()).launchHash).not.toBe(found.launchHash)

    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), cwd: given })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(received(await fixture.log(), 'session/new')[0].params?.cwd).toBe(given)
    await rm(literalParent)
    await expect(bridge.prompt(sessionId, 'echo two', rid())).rejects.toMatchObject(CHANGED)
  })

  it('refuses to start a session whose project configuration changed after its launch was previewed', async () => {
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

    // A new session records the configuration as it is now; the old one is deleted without starting its agent.
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
    for (const presetId of ['qwen'])
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
      // The definition's own fingerprint does not move; the launch with folders does.
      const launched = {
        resolvedCommand: process.execPath,
        args: [FAKE_ACP_AGENT],
        definitionEnv: fixture.record.env,
        presetId: 'codex',
        profileVersion: 1 as const,
        ...launchExtras('codex'),
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

    // codex-acp loads the skills of every folder it receives; they count in the fingerprint.
    const skill = join(scope.reals[1]!, '.agents', 'skills', 'deploy')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '# deploy')
    const skilled = await bridge.launchPreview!(scope.input)
    expect(skilled.launchHash).not.toBe(base.launchHash)
    const settings = join(scope.reals[2]!, '.codex')
    await mkdir(settings)
    await writeFile(join(settings, 'config.toml'), '')
    const configured = await bridge.launchPreview!(scope.input)
    expect(configured.launchHash).not.toBe(skilled.launchHash)
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

  it('passes Qwen Code one --include-directories per other folder after the definition arguments', async () => {
    for (const [presetId, env, name] of [['qwen', QWEN, 'Qwen Code']] as const) {
      const fixture = await preset(presetId, env)
      const scope = await project(fixture)
      const bridge = await fixture.open(scope.workspaces, scope.projects)
      const others = scope.reals.slice(1)
      const preview = await bridge.launchPreview!(scope.input)
      expect(preview, name).toMatchObject({ args: [FAKE_ACP_AGENT], folders: others })
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

      // Configuration the harness loads from the other folders is fingerprinted.
      const settings = join(scope.folders[2]!.path, `.${presetId}`)
      await mkdir(settings)
      await writeFile(join(settings, 'settings.json'), '{}')
      const configured = await bridge.launchPreview!(scope.input)
      expect(configured.launchHash).not.toBe(preview.launchHash)
      await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'project-config-changed' })
    }

    // At most four other folders, refused before anything starts.
    const fixture = await preset('qwen', QWEN)
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

  it('never passes other folders to OpenCode, DeepSeek Harness or goose', async () => {
    for (const [presetId, env] of [
      ['opencode', { FAKE_ACP_CONFIG: 'legacy' }],
      ['dsh', { FAKE_ACP_PROCESS_MODE: '1' }],
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
      const detail = await settled(bridge, sessionId)
      const { summary } = detail
      expect(summary.status, `${presetId}: ${systemText(detail)}`).toBe('idle')
      expect([summary.workspaceId, summary.folders, summary.folderAccess], presetId).toEqual([undefined, undefined, undefined])
      const log = await fixture.log()
      expect(log.find(entry => entry.event === 'start')!.argv, presetId).toEqual(presetId === 'dsh' ? ['--patch', expect.any(String)] : [])
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
  const agyEnv = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'default,accept-edits,auto,plan', FAKE_ACP_CAPS: 'resume' }
  const skipPermissions = '--dangerously-skip-permissions'
  const agyCommand = (args: string[]) =>
    setup(
      { ...agyEnv, FAKE_ACP_AGENT },
      { idleMs: 60_000 },
      { presetId: 'antigravity', args: [join(import.meta.dirname, 'fixtures', 'antigravity-permissions.mjs'), ...args] },
    )

  it('reads Antigravity default before prompting and treats its instruction-only plan as no narrower permission', async () => {
    const fixture = await preset('antigravity', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'default,accept-edits,auto,plan',
      FAKE_ACP_INITIAL_MODE: 'auto',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo native mode', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(detail.permission).toMatchObject({ expectedMode: 'default', readback: 'mode', modeTiers: { default: { name: '默认' } } })
    expect(detail.permission?.modeTiers?.plan).toBeUndefined()
    expect(detail.config?.find(option => option.category === 'mode')?.options.some(option => option.value === 'plan')).toBe(true)
    expect((await fixture.log()).find(entry => entry.event === 'prompt-mode')?.mode).toBe('default')
    expect(classifyMode(profileFor('antigravity')!.permission, 'default', 'plan')).toBe('wider')
    await bridge.setConfig!(sessionId, 'mode', 'plan')
    await bridge.prompt(sessionId, 'echo chosen plan', rid())
    expect((await settled(bridge, sessionId)).config?.find(option => option.id === 'mode')?.currentValue).toBe('plan')
  })

  it('uses the Antigravity bypass flag only in Turbo and waits for approval before executing the same command after switching back', async () => {
    const args = ['acp', '--disable-telemetry', '--process-per-session']
    const fixture = await agyCommand(args)
    const command = 'opencode-tool command'
    const marker = join(fixture.workspace, 'opencode-tool-ran')
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hello', requestId: rid() })
    const first = await settled(bridge, sessionId)
    expect(first.permission).toMatchObject({ expectedMode: 'default', readback: 'mode' })
    expect(first.config?.find(option => option.category === 'mode')?.options.map(option => option.value)).toEqual(
      expect.arrayContaining(['default', 'accept-edits', 'auto', 'plan', 'turbo']),
    )

    await bridge.setConfig!(sessionId, 'mode', 'auto')
    await bridge.prompt(sessionId, command, rid())
    const auto = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    expect(auto.permission).toMatchObject({ expectedMode: 'auto', readback: 'mode' })
    expect(await bridge.decide(auto.approvals[0]!.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fixture.log()).filter(entry => entry.event === 'start').map(entry => entry.argv)).toEqual([args])

    await bridge.setConfig!(sessionId, 'mode', 'turbo')
    await bridge.prompt(sessionId, command, rid())
    const turbo = await settled(bridge, sessionId)
    expect(turbo.summary.status).toBe('idle')
    expect(turbo.config?.find(option => option.category === 'mode')).toMatchObject({ currentValue: 'turbo', source: 'launch' })
    expect(turbo.permission).toMatchObject({ expectedMode: 'turbo', readback: 'none', modeTiers: { turbo: { tier: 'never' } } })
    expect(await readFile(marker, 'utf8')).toBe('bash')
    expect(await bridge.readConfig!(sessionId, 'mode', 'turbo')).toEqual({ kind: 'unread' })
    await rm(marker)

    await bridge.setConfig!(sessionId, 'mode', 'default')
    await bridge.prompt(sessionId, command, rid())
    const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    expect(waiting.summary.status).toBe('waiting-approval')
    expect(waiting.permission).toMatchObject({ expectedMode: 'default', readback: 'mode' })
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await bridge.decide(waiting.approvals[0]!.id, 'allow')).toBe(true)
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(await readFile(marker, 'utf8')).toBe('bash')

    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start').map(entry => entry.argv)).toEqual([args, [...args, skipPermissions], args])
    const agentSessionId = received(log, 'session/prompt')[0]!.params?.sessionId
    expect(agentSessionId).toEqual(expect.any(String))
    expect(received(log, 'session/resume').map(entry => entry.params?.sessionId)).toEqual([agentSessionId, agentSessionId])
    expect(received(log, 'session/set_config_option').map(entry => entry.params?.value)).not.toContain('turbo')
  })

  it('retains Turbo across a restart when chosen for the first turn and still offers default to the next draft', async () => {
    const fixture = await preset('antigravity', agyEnv)
    let bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo first',
      requestId: rid(),
      config: [{ configId: LADDER_MODE, value: 'turbo' }],
    })
    const first = await settled(bridge, sessionId)
    expect(first.summary.status).toBe('idle')
    expect(first.config?.find(option => option.category === 'mode')).toMatchObject({ currentValue: 'turbo', source: 'launch' })
    const draftMode = bridge.catalogue!()?.options.find(option => option.category === 'mode')
    expect(draftMode?.currentValue).toBe('default')
    expect(draftMode?.source).toBeUndefined()

    await bridge.close()
    bridge = await fixture.open()
    await bridge.prompt(sessionId, 'recall', rid())
    const restored = await settled(bridge, sessionId)
    expect(assistants(restored).at(-1)?.text).toBe('recall: 1 earlier')
    expect(restored.config?.find(option => option.category === 'mode')).toMatchObject({ currentValue: 'turbo', source: 'launch' })
    expect((await fixture.log()).filter(entry => entry.event === 'start').map(entry => entry.argv)).toEqual([
      [skipPermissions],
      [skipPermissions],
    ])
  })

  it('keeps the committed Antigravity mode visible and closes the replacement when authorization for the change is revoked', async () => {
    const fixture = await preset('antigravity', agyEnv)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo first',
      requestId: rid(),
      config: [{ configId: LADDER_MODE, value: 'turbo' }],
    })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    const wire = vi.spyOn(AcpWire.prototype, 'request')
    let checksAfterResume = 0
    try {
      await expect(
        bridge.setConfig!(sessionId, 'mode', 'default', {
          authorize() {
            // The replacement has answered with default. Revoke after attachment, just before the new launch is committed.
            const resume = wire.mock.calls.findIndex(([method]) => method === 'session/resume')
            if (wire.mock.settledResults[resume]?.type === 'fulfilled' && ++checksAfterResume === 2)
              throw new AppError(403, 'permission-denied', 'revoked')
          },
        }),
      ).rejects.toMatchObject({ code: 'permission-denied' })
    } finally {
      wire.mockRestore()
    }
    const failed = await bridge.detail(sessionId)
    expect(failed.permission?.expectedMode).toBe('turbo')
    expect(failed.config?.find(option => option.category === 'mode')).toMatchObject({ currentValue: 'turbo', source: 'launch' })
    const log = await fixture.log()
    const replacement = received(log, 'session/resume')[0]!.pid
    expect(log).toContainEqual(expect.objectContaining({ event: 'start', pid: replacement, argv: [] }))
    expect(log).toContainEqual(expect.objectContaining({ event: 'exit', pid: replacement }))
    await bridge.prompt(sessionId, 'recall', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('recall: 1 earlier')
    const after = await fixture.log()
    const resumed = received(after, 'session/prompt').at(-1)!.pid
    expect(resumed).not.toBe(replacement)
    expect(after).toContainEqual(expect.objectContaining({ event: 'start', pid: resumed, argv: [skipPermissions] }))
  })

  it('keeps native Antigravity modes available and describes their permissions when the definition already bypasses prompts', async () => {
    const fixture = await agyCommand(['acp', skipPermissions])
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'opencode-tool command', requestId: rid() })
    const first = await settled(bridge, sessionId)
    expect(assistants(first).at(-1)?.text).toBe('executed')
    expect(first.permission?.expectedMode).toBe('default')
    const nativeModes = ['default', 'accept-edits', 'auto', 'plan']
    expect(first.config?.find(option => option.category === 'mode')?.options.map(option => option.value)).toEqual(nativeModes)
    expect(nativeModes.map(native => first.permission?.modeTiers?.[native])).toMatchObject([
      { tier: 'never', name: '默认' },
      { tier: 'never', name: 'Accept edits' },
      { tier: 'never', name: 'Auto' },
      { tier: 'never', name: 'Plan' },
    ])
    expect(first.permission?.modeGlyphs?.plan).toBe('plan')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'plan')).toBe('wider')
    for (const native of ['plan', 'auto']) {
      await bridge.setConfig!(sessionId, 'mode', native)
      await bridge.prompt(sessionId, 'opencode-tool command', rid())
      const detail = await settled(bridge, sessionId)
      expect(detail.config?.find(option => option.category === 'mode')?.currentValue).toBe(native)
      expect(assistants(detail).at(-1)?.text).toBe('executed')
    }
    expect((await fixture.log()).filter(entry => entry.event === 'start').map(entry => entry.argv)).toEqual([['acp', skipPermissions]])
  })

  it('honors an explicit false Antigravity flag and inserts the chosen Turbo flag before the end of options', async () => {
    const definitionArgs = ['acp', skipPermissions, `${skipPermissions}=false`, '--', skipPermissions]
    const fixture = await setup(agyEnv, {}, { presetId: 'antigravity', args: [FAKE_ACP_AGENT, ...definitionArgs] })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const first = await settled(bridge, sessionId)
    expect(first.permission?.modeTiers?.default?.tier).toBe('ask')
    expect(first.config?.find(option => option.category === 'mode')?.options.map(option => option.value)).toContain('turbo')
    await bridge.setConfig!(sessionId, 'mode', 'turbo')
    await bridge.prompt(sessionId, 'recall', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('recall: 1 earlier')
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').map(entry => entry.argv)
    expect(starts).toEqual([definitionArgs, ['acp', skipPermissions, `${skipPermissions}=false`, skipPermissions, '--', skipPermissions]])
  })

  describe('a turn Antigravity terminated without a reason', () => {
    const TERMINATED = '⚠ Agent execution terminated due to error.'
    const MODES = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'default,accept-edits,auto', FAKE_ACP_INITIAL_MODE: 'default' }
    /** The fake agent says each queued text as its whole reply and ends the turn with `end_turn`. */
    const replying = async (presetId: string | undefined, replies: string[]) => {
      const queue = join(await mkdtemp(join(tmpdir(), 'latch-acp-replies-')), 'queue.json')
      cleanups.push(() => rm(dirname(queue), { recursive: true, force: true }))
      await writeFile(queue, JSON.stringify(replies))
      const env = { ...MODES, FAKE_ACP_REPLY_QUEUE: queue }
      return (await (presetId ? preset(presetId, env) : setup(env))).open()
    }
    const replies = (detail: DriverTaskDetail) => detail.messages.filter(message => message.role === 'assistant')

    it('ends the turn as failed under the same message ID, with Latch’s own words, and the next turn runs', async () => {
      const bridge = await replying('antigravity', [TERMINATED, 'fine'])
      const { sessionId } = await bridge.createTask({ prompt: 'hello', requestId: rid() })
      // The reply streams under one ID before the turn ends, and keeps it once the turn is failed.
      const live = await until(bridge, sessionId, detail => replies(detail).length > 0 || detail.summary.status !== 'running')
      const detail = await settled(bridge, sessionId)
      expect(detail.summary).toMatchObject({ status: 'failed', runOutcome: 'failed' })
      expect(detail.summary.runEnd).toBeUndefined()
      expect(replies(detail)).toMatchObject([{ text: TERMINATED, state: 'failed' }])
      if (replies(live)[0]) expect(replies(detail)[0]!.id).toBe(replies(live)[0]!.id)
      expect(detail.messages.at(-1)).toMatchObject({ role: 'system', state: 'failed', text: 'Fake 中止了这一轮，没有给出原因' })
      await bridge.prompt(sessionId, 'again', rid())
      const next = await settled(bridge, sessionId)
      expect(next.summary.status).toBe('idle')
      expect(replies(next).at(-1)).toMatchObject({ text: 'fine', state: 'completed' })
    })

    it('leaves a reply that only contains the text a reply', async () => {
      const bridge = await replying('antigravity', [`It printed “${TERMINATED}” and stopped.`, `${TERMINATED} Then it went on.`])
      const { sessionId } = await bridge.createTask({ prompt: 'hello', requestId: rid() })
      expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
      await bridge.prompt(sessionId, 'again', rid())
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(replies(detail).map(message => message.state)).toEqual(['completed', 'completed'])
      expect(detail.messages.some(message => message.role === 'system' && message.state === 'failed')).toBe(false)
    })

    it.each([undefined, 'qwen'])('leaves the same reply from another Harness a reply (%s)', async presetId => {
      const bridge = await replying(presetId, [TERMINATED])
      const { sessionId } = await bridge.createTask({ prompt: 'hello', requestId: rid() })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(replies(detail)).toMatchObject([{ text: TERMINATED, state: 'completed' }])
    })
  })

  it('says an internal error of the agent without the JSON-RPC class, keeping the reply it wrote', async () => {
    const queue = join(await mkdtemp(join(tmpdir(), 'latch-acp-replies-')), 'queue.json')
    cleanups.push(() => rm(dirname(queue), { recursive: true, force: true }))
    const refusal = 'API Error: 400 这个模型服务没有声明所请求的思考档位'
    await writeFile(queue, JSON.stringify([{ text: refusal, error: refusal, code: -32603 }]))
    const bridge = await (await setup({ FAKE_ACP_REPLY_QUEUE: queue })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'hello', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(detail.messages.filter(message => message.role === 'assistant')).toMatchObject([{ text: refusal }])
    expect(detail.messages.at(-1)).toMatchObject({ role: 'system', state: 'failed', text: `Fake 返回错误：${refusal}` })
  })

  it('refuses Antigravity input when its reported permission cannot be brought back to default', async () => {
    const fixture = await preset('antigravity', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'default,accept-edits,auto,plan',
      FAKE_ACP_INITIAL_MODE: 'auto',
      FAKE_ACP_STICKY_MODE: '1',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo refused mode', requestId: rid() })
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    expect(received(await fixture.log(), 'session/prompt')).toEqual([])
    expect(fixture.events).toContainEqual({ type: 'permission-unverified', sessionId })
  })

  it('does not open an Antigravity session again to read its model, which would come back as the default', async () => {
    const fixture = await preset('antigravity', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'default,accept-edits,auto,plan',
      FAKE_ACP_INITIAL_MODE: 'default',
      FAKE_ACP_CAPS: 'resume',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo model reading', requestId: rid() })
    await settled(bridge, sessionId)
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
    expect(await bridge.readConfig!(sessionId, 'model', 'large')).toEqual({ kind: 'unread' })
    expect((await fixture.log()).filter(entry => entry.event === 'start').length).toBe(starts)
    expect(received(await fixture.log(), 'session/resume')).toEqual([])
  })

  it('uses Grok model options without inventing permission readback or sending a mode setter', async () => {
    const fixture = await preset('grok', { FAKE_ACP_CONFIG: 'options' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo grok model', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(detail.permission?.readback).toBe('none')
    expect(detail.permission?.expectedMode).toBeUndefined()
    expect(detail.config?.some(option => option.category === 'mode')).toBe(false)
    await bridge.setConfig!(sessionId, 'model', 'large')
    await bridge.prompt(sessionId, 'echo changed model', rid())
    expect((await settled(bridge, sessionId)).config?.find(option => option.category === 'model')?.currentValue).toBe('large')
    expect(received(await fixture.log(), 'session/set_config_option').map(entry => entry.params?.configId)).toEqual(['model'])
  })

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

  it("reports the mode a session starts in and Latch's word for each mode", async () => {
    const fixture = await qwen()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.permission).toMatchObject({
      defaultMode: 'default',
      modeTiers: {
        plan: { tier: 'plan' },
        default: { tier: 'ask' },
        'auto-edit': { tier: 'rule' },
        auto: { tier: 'model' },
        yolo: { tier: 'never' },
      },
    })
  })

  it('records each call that ran unasked while the model decides, and none while it asks or when it was asked', async () => {
    const fixture = await qwen()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'review', requestId: rid() })
    let detail = await settled(bridge, sessionId)
    // In the asking mode nothing is judged, not even what the agent reports as its own review.
    expect(detail.messages.filter(message => message.tool?.judged)).toEqual([])
    expect(fixture.events.filter(event => event.type === 'tool-judged')).toEqual([])

    await bridge.setConfig!(sessionId, 'mode', 'auto')
    await bridge.prompt(sessionId, 'review', rid())
    detail = await settled(bridge, sessionId)
    const judged = detail.messages.filter(message => message.tool?.judged)
    // Qwen Code reports no verdicts, so every call that ran is recorded as run unasked, its review rows too.
    expect(judged.map(message => [message.id.split(':').at(-1), message.tool!.judged])).toEqual([
      ['r1', { by: 'Fake', outcome: 'unasked' }],
      ['r2', { by: 'Fake', outcome: 'unasked' }],
      ['call_1', { by: 'Fake', outcome: 'unasked' }],
    ])
    const recorded = fixture.events.filter(event => event.type === 'tool-judged')
    expect(recorded).toEqual([
      {
        type: 'tool-judged',
        sessionId,
        callHash: sha256Hex(judged[0]!.id),
        modeHash: sha256Hex('auto'),
        kind: 'think',
        outcome: 'ran-unasked',
        source: 'no-ask-seen',
      },
      expect.objectContaining({ callHash: sha256Hex(judged[1]!.id), kind: 'think', outcome: 'ran-unasked' }),
      expect.objectContaining({ callHash: sha256Hex(judged[2]!.id), kind: 'execute', outcome: 'ran-unasked' }),
    ])
    // A call a person was asked about is theirs, not the model's.
    await bridge.prompt(sessionId, 'permission', rid())
    const approval = await vi.waitFor(async () => {
      const [first] = await bridge.approvals()
      expect(first).toBeDefined()
      return first!
    })
    await bridge.decide(approval.id, 'allow')
    detail = await settled(bridge, sessionId)
    expect(fixture.events.filter(event => event.type === 'tool-judged')).toHaveLength(3)
    const asked = detail.messages.findLast(message => message.tool?.decision)
    expect(asked?.tool).toMatchObject({ decision: { outcome: 'allowed' } })
    expect(asked?.tool?.judged).toBeUndefined()
  })

  it("shows Codex's own reviews with their verdicts, records each once, and not its other calls", async () => {
    const fixture = await preset('codex', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
      FAKE_ACP_INITIAL_MODE: 'read-only',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'mode', 'agent')
    await bridge.prompt(sessionId, 'review', rid())
    const detail = await settled(bridge, sessionId)
    const rows = detail.messages.filter(message => message.role === 'tool')
    expect(rows.map(message => [message.id.split(':').at(-1), message.state, message.tool?.judged])).toEqual([
      ['r1', 'completed', { by: 'Fake', outcome: 'approved' }],
      ['r2', 'failed', { by: 'Fake', outcome: 'denied' }],
      // In-project work runs without an ask in this mode; only what Codex's model decided is its judgement.
      ['call_1', 'completed', undefined],
    ])
    // Never a person's approval, and the agent's own words stay its text.
    expect(rows.every(message => message.tool?.decision === undefined)).toBe(true)
    expect(rows[1]!.tool?.output).toContain('<b>denied</b>')
    const recorded = fixture.events.filter(event => event.type === 'tool-judged')
    expect(recorded).toEqual([
      {
        type: 'tool-judged',
        sessionId,
        callHash: sha256Hex(rows[0]!.id),
        modeHash: sha256Hex('agent'),
        kind: 'think',
        outcome: 'approved',
        source: 'agent-report',
      },
      expect.objectContaining({ callHash: sha256Hex(rows[1]!.id), outcome: 'denied', source: 'agent-report' }),
    ])
    // No text of the agent's reaches the record.
    expect(JSON.stringify(recorded)).not.toContain('example.com')
    expect(detail.permission?.modeTiers?.agent).toMatchObject({ tier: 'model' })
    // The verdicts are still the model's after the Host restarts.
    await bridge.close()
    const reopened = await fixture.open()
    const kept = (await reopened.detail(sessionId)).messages.filter(message => message.role === 'tool')
    expect(kept.map(message => message.tool?.judged)).toEqual(rows.map(message => message.tool?.judged))
  })

  it('gives each mode of a profile one tier, in the order of its ladder, with a line', () => {
    const order = ['plan', 'ask', 'rule', 'model', 'never']
    for (const profile of HARNESS_PROFILES.values()) {
      const { modeTiers, modeLadder, expectedMode } = profile.permission
      if (!modeTiers) continue
      const modes = Object.keys(modeTiers)
      expect(
        modes.every(mode => modeLadder?.includes(mode)),
        profile.presetId,
      ).toBe(true)
      const tiers = modeLadder!.filter(mode => modes.includes(mode)).map(mode => order.indexOf(modeTiers[mode]!.tier))
      expect(tiers, profile.presetId).toEqual([...tiers].toSorted((a, b) => a - b))
      expect(
        modes.every(mode => modeTiers[mode]!.line.length > 0),
        profile.presetId,
      ).toBe(true)
      // A profile may default to read-only; it never preselects a mode wider than asking.
      expect(['plan', 'ask'], profile.presetId).toContain(modeTiers[expectedMode!]?.tier)
    }
    expect(FALLBACK_PROFILES.get('codex')!.permission.modeTiers?.agent?.line).toContain('它的模型判断')
  })

  it("keeps OpenCode's plan agent from changing files or running commands under Latch's rules", () => {
    const config = JSON.parse(profileFor('opencode')!.permission.defaultEnv!.OPENCODE_CONFIG_CONTENT!) as {
      agent: Record<'build' | 'plan', { permission: Record<string, string | Record<string, string>> }>
    }
    // As OpenCode reads these rules: in the order written, the last one matching the tool and its argument wins.
    const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u')
    // 2.x reads a 1.x key under its new name (`task` as `subagent`).
    const renamed: Record<string, string> = { task: 'subagent', bash: 'shell' }
    const decide = (agent: 'build' | 'plan', tool: string, argument: string, v2 = false) => {
      let action = 'ask'
      for (const [written, rule] of Object.entries(config.agent[agent].permission)) {
        const key = v2 ? (renamed[written] ?? written) : written
        if (!glob(key).test(tool)) continue
        if (typeof rule === 'string') action = rule
        else for (const [pattern, value] of Object.entries(rule)) if (glob(pattern).test(argument)) action = value
      }
      return action
    }
    // OpenCode checks `edit` for its write and patch tools too, and `bash` for every command.
    expect([decide('plan', 'edit', 'a.txt'), decide('plan', 'bash', 'ls')]).toEqual(['deny', 'deny'])
    expect([decide('plan', 'read', 'a.txt'), decide('plan', 'read', '.env'), decide('plan', 'webfetch', 'https://a.test')]).toEqual([
      'allow',
      'deny',
      'ask',
    ])
    expect([decide('build', 'edit', 'a.txt'), decide('build', 'bash', 'ls')]).toEqual(['ask', 'ask'])
    // Subagents: off in 1.x, whose ACP leaves their requests unanswered; in 2.x starting one asks in build, and plan
    // starts none, since a subagent works under its own agent's rules rather than plan's.
    expect([decide('build', 'task', 'general'), decide('plan', 'task', 'general')]).toEqual(['deny', 'deny'])
    expect([decide('build', 'subagent', 'general', true), decide('plan', 'subagent', 'general', true)]).toEqual(['ask', 'deny'])
    expect([decide('plan', 'shell', 'ls', true), decide('plan', 'edit', 'a.txt', true)]).toEqual(['deny', 'deny'])
  })

  it('passes OpenCode rules that block plan, ask in build, permit edits only in auto-edit and commands in yolo', async () => {
    const fixture = await preset(
      'opencode',
      {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_MODES: 'plan,build,auto-edit,yolo',
        FAKE_ACP_INITIAL_MODE: 'build',
        FAKE_ACP_VERSION: '2.2.6',
      },
      { idleMs: 60_000 },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'opencode-tool edit',
      requestId: rid(),
      config: [{ configId: '~mode', value: 'plan' }],
    })
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('blocked')
    const marker = join(fixture.workspace, 'opencode-tool-ran')
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await bridge.setConfig!(sessionId, 'mode', 'build')
    await bridge.prompt(sessionId, 'opencode-tool edit', rid())
    const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('blocked')
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await bridge.setConfig!(sessionId, 'mode', 'auto-edit')
    await bridge.prompt(sessionId, 'opencode-tool edit', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('executed')
    expect(await readFile(marker, 'utf8')).toBe('edit')
    await bridge.prompt(sessionId, 'opencode-tool command', rid())
    const command = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    await bridge.decide(command.approvals[0]!.id, 'reject')
    await settled(bridge, sessionId)
    expect(await readFile(marker, 'utf8')).toBe('edit')
    await bridge.setConfig!(sessionId, 'mode', 'yolo')
    await bridge.prompt(sessionId, 'opencode-tool command', rid())
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('executed')
    expect(await readFile(marker, 'utf8')).toBe('bash')
  })

  it("fingerprints a preset's launch with its profile's version", async () => {
    const fixture = await preset('opencode', { FAKE_ACP_VERSION: '1.4.2', FAKE_ACP_CONFIG: 'legacy' })
    const preview = await (await fixture.open()).launchPreview!({ cwd: fixture.workspace })
    const definition = {
      resolvedCommand: process.execPath,
      args: [FAKE_ACP_AGENT],
      definitionEnv: fixture.record.env,
      presetId: 'opencode',
      profileVersion: fixtureProfile('opencode')!.version,
      ...launchExtras('opencode'),
    }
    expect(preview.definitionHash).toBe(launchHash(definition))
    expect(preview.definitionHash).not.toBe(launchHash({ ...definition, profileVersion: definition.profileVersion - 1 }))
    // A check of the definition starts only the process a session would.
    const probed = await agentProbePreview(fixture.record, { dataDir: fixture.dataDir, cwd: fixture.workspace })
    expect(probed.launchHash).toBe(preview.launchHash)
  })

  it('stops the turn when a judged call cannot be recorded', async () => {
    const fixture = await setup(
      { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default' },
      {},
      { presetId: 'qwen' },
      { securityEvent: event => (event.type === 'tool-judged' ? Promise.reject(new Error('disk full')) : undefined) },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'mode', 'auto')
    await bridge.prompt(sessionId, 'review', rid())
    const detail = await vi.waitFor(async () => {
      const current = await bridge.detail(sessionId)
      expect(systemText(current)).toContain('Latch 没能记下一次由 Fake 的模型代你决定的调用，已取消本轮。')
      return current
    })
    await settled(bridge, sessionId)
    expect(detail.messages.some(message => message.tool?.judged?.outcome === 'unasked')).toBe(true)
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

  it('classifies mode changes and expects the mode a change widens to', async () => {
    const fixture = await qwen()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'default')).toBe('neutral')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'plan')).toBe('stricter')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'yolo')).toBe('wider')
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'auto')).toBe('wider')
    expect(await bridge.classifyConfigChange!(sessionId, 'model', 'large')).toBe('neutral')
    await expect(bridge.classifyConfigChange!(sessionId, 'missing', 'x')).rejects.toMatchObject({ status: 404 })

    await bridge.setConfig!(sessionId, 'mode', 'plan')
    expect((await bridge.detail(sessionId)).permission?.expectedMode).toBe('plan')
    // Widening is measured against the mode now expected.
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'default')).toBe('wider')
    await bridge.setConfig!(sessionId, 'mode', 'yolo')
    const widened = await bridge.detail(sessionId)
    expect(widened.permission?.expectedMode).toBe('yolo')
    expect(widened.config?.find(option => option.id === 'mode')?.currentValue).toBe('yolo')
    await bridge.prompt(sessionId, 'echo two', rid())
    const started = await settled(bridge, sessionId)
    expect(started.summary.status, systemText(started)).toBe('idle')
    const log = await fixture.log()
    expect(received(log, 'session/set_config_option').map(entry => entry.params?.value)).toEqual(['plan', 'yolo'])
    expect(log.filter(entry => entry.event === 'prompt-mode').map(entry => entry.mode)).toEqual(['default', 'yolo'])
    expect(fixture.events).toEqual([])
  })

  it('refuses OpenCode versions outside the checked major versions', async () => {
    const fixture = await preset('opencode', { FAKE_ACP_VERSION: '3.0.0' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('Fake 版本 3.0.0 未经验证（OpenCode 仅支持 1.x 与 2.x），已拒绝启动。')
    const log = await fixture.log()
    expect(received(log, 'session/new')).toEqual([])
    await vi.waitFor(() => expect(alive(log.find(entry => entry.event === 'start')!.pid)).toBe(false), { timeout: 5_000, interval: 20 })

    const unknown = await preset('opencode', { FAKE_ACP_VERSION: 'none' })
    const other = await unknown.open()
    const task = await other.createTask({ prompt: 'echo', requestId: rid() })
    expect(systemText(await settled(other, task.sessionId))).toContain('Fake 版本 未知 未经验证')

    for (const version of ['2.2.5', '1.19.5']) {
      const opened = await (await preset('opencode', { FAKE_ACP_VERSION: version, FAKE_ACP_CONFIG: 'legacy' })).open()
      const started = await opened.createTask({ prompt: 'echo', requestId: rid() })
      expect((await settled(opened, started.sessionId)).summary.status, version).toBe('idle')
    }
    const supported = await preset('opencode', { FAKE_ACP_VERSION: '1.4.2', FAKE_ACP_CONFIG: 'legacy', FAKE_ACP_DUMP_ENV: '1' })
    const ok = await supported.open()
    const accepted = await ok.createTask({ prompt: 'echo', requestId: rid() })
    const ran = await settled(ok, accepted.sessionId)
    expect(ran.summary.status).toBe('idle')
    const env = (await supported.log()).find(entry => entry.event === 'env')!.env as Record<string, string>
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      permission: { '*': 'ask', task: 'deny' },
      agent: { build: { permission: { '*': 'ask' } } },
    })
    // OpenCode also reads project and user configuration, which can replace these rules; the session's permission says so.
    expect((await ok.launchPreview!({ cwd: supported.workspace })).approvals).toBe('prompts')
    expect(ran.permission?.notes.join('\n')).toContain('.opencode')
  })

  it('notes OpenCode definitions whose variables move where it reads its configuration', async () => {
    const redirected = await preset('opencode', { FAKE_ACP_VERSION: '1.4.2', FAKE_ACP_CONFIG: 'legacy', XDG_CONFIG_HOME: '/elsewhere' })
    const other = await redirected.open()
    const preview = await other.launchPreview!({ cwd: redirected.workspace })
    const note =
      '定义设置了 XDG_CONFIG_HOME，OpenCode 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设'
    expect(preview).toMatchObject({ verified: false })
    const { sessionId } = await other.createTask({ prompt: 'echo', requestId: rid() })
    expect((await settled(other, sessionId)).permission?.notes).toEqual([...fixtureProfile('opencode')!.permission.notes, note])
  })

  it('describes a preset launch', async () => {
    const piFixture = await preset('pi')
    const pi = await piFixture.open()
    expect(await pi.launchPreview!({ cwd: piFixture.workspace })).toMatchObject({
      presetId: 'pi',
      verified: false,
      approvals: 'prompts',
      readback: 'mode',
    })
  })
})

describe('ACP turn mapping', () => {
  it('requires corroborated simulator arguments and identity for a qualified ACP title', () => {
    const title = 'mcp__latch-browser__device_type_text'
    const input = { udid: '22222222-2222-4222-8222-222222222222', text: 'draft label' }
    expect(simulatorInputTool('device_type_text', undefined, input, title)).toBe('device_type_text')
    expect(simulatorInputTool('device_type_text', undefined, input)).toBeUndefined()
    expect(simulatorInputTool('shell', undefined, input, title)).toBeUndefined()
    expect(simulatorInputTool(undefined, 'execute', input, title)).toBeUndefined()
    expect(simulatorInputTool(undefined, undefined, { ...input, command: 'echo draft' }, title)).toBeUndefined()
    expect(
      simulatorInputTool('device_type_text', undefined, { ...input, server: 'editing', tool: 'device_type_text' }, title),
    ).toBeUndefined()
    expect(simulatorInputTool(undefined, undefined, { udid: input.udid }, title)).toBeUndefined()
  })

  it('shows a call named as simulator input with other arguments as any other tool, whichever way it is named', () => {
    const udid = '22222222-2222-4222-8222-222222222222'
    const tap = { udid, x: 10, y: 20 }
    for (const name of ['latch-browser.device_tap', 'mcp__latch-browser__device_tap']) {
      expect(simulatorInputTool(name, 'other', tap)).toBe('device_tap')
      expect(simulatorInputTool(name, 'other', JSON.stringify(tap))).toBe('device_tap')
      expect(simulatorInputTool(name, 'other', { ...tap, path: '/etc/hosts' })).toBeUndefined()
      expect(simulatorInputTool(name, 'other', { command: 'rm -rf ~' })).toBeUndefined()
      expect(simulatorInputTool(name, 'other', { x: 10, y: 20 })).toBeUndefined()
      expect(simulatorInputTool(name, 'other', { udid: 'a2222222-2222-4222-8222-22222222222b', x: 10, y: 20 })).toBeUndefined()
      expect(simulatorInputTool(name, 'other')).toBeUndefined()
    }
    // Codex's shape: server and tool, the arguments inside (as JSON text on its approvals).
    const wrapped = (args: unknown) => ({ server: 'latch-browser', tool: 'device_tap', arguments: args })
    expect(simulatorInputTool('latch-browser.device_tap', 'other', wrapped(tap))).toBe('device_tap')
    expect(simulatorInputTool('调用 latch-browser.device_tap', 'other', wrapped(JSON.stringify(tap)))).toBe('device_tap')
    expect(simulatorInputTool('latch-browser.device_tap', 'other', wrapped({ ...tap, note: 'other words' }))).toBeUndefined()
    expect(simulatorInputTool(undefined, 'other', { server: 'latch-browser', tool: 'device_tap' })).toBeUndefined()
    // A row saved earlier holds only its counts, which still read as that tool; anything else shows as it is.
    expect(simulatorInputTool('latch-browser.device_tap', 'other', '1 个触点')).toBe('device_tap')
    expect(simulatorInputTool('latch-browser.device_type_text', 'other', '12 个字符')).toBe('device_type_text')
    expect(simulatorInputTool('latch-browser.device_tap', 'other', '12 个字符')).toBeUndefined()
    // Identity alone, for a call's name: no say over how its row is shown.
    expect(simulatorInputName('latch-browser.device_tap')).toBe('device_tap')
    expect(simulatorInputName('latch-browser.device_list')).toBeUndefined()
  })

  it('names a session by the Host’s title when given, not by the record its prompt begins with, and a retry keeps the session', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const prompt = '以下是会话「a」到第 1 轮为止的记录\n<会话记录>…</会话记录>\n\ncount 2'
    const created = await bridge.createTask({ prompt, requestId: 'titled', title: 'Profile slow note opening' })
    expect((await bridge.listTasks()).find(task => task.id === created.sessionId)?.title).toBe('Profile slow note opening')
    await settled(bridge, created.sessionId)
    expect(await bridge.createTask({ prompt, requestId: 'titled', title: 'Renamed since' })).toEqual(created)
    expect((await bridge.detail(created.sessionId)).summary.title).toBe('Profile slow note opening')
  })

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

  it("drops a command classification an ordinary ACP agent sends: only Latch's Codex wire may say what a command does", async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'classify', requestId: rid() })
    const row = (await settled(bridge, sessionId)).messages.find(message => message.role === 'tool')
    expect(row?.tool).toMatchObject({ kind: 'execute', title: 'rm -rf build', output: 'gone' })
    expect(row?.tool?.actions).toBeUndefined()
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

  it('reports each own-login turn to the Host with the usage its prompt carries, a session total as the turn’s part', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' }, {}, {}, { turnEnded: turn => void turns.push(turn) })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'plan', rid())
    const detail = await settled(bridge, sessionId)
    const prompts = detail.messages.filter(message => message.role === 'user')
    expect(turns).toHaveLength(2)
    expect(turns.map(turn => turn.usage)).toEqual(prompts.map(prompt => prompt.turn?.usage))
    // The fake reports the session's total each time: the first turn is all of it, the second nothing more.
    expect(turns.map(turn => turn.usage)).toEqual([
      { inputTokens: 10, outputTokens: 20 },
      { inputTokens: 0, outputTokens: 0 },
    ])
    for (const [index, turn] of turns.entries()) {
      expect(turn).toMatchObject({ sessionId, endedAt: prompts[index]!.turn!.endedAt, activeMs: prompts[index]!.turn!.activeMs })
      expect(Date.parse(turn.startedAt)).toBeLessThanOrEqual(Date.parse(turn.endedAt))
      expect(turn.steps).toBe(0)
    }
  })

  it('reports the turn’s part of the cost the Harness says its session has cost so far', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy', FAKE_ACP_COST: '0.25' }, {}, {}, { turnEnded: turn => void turns.push(turn) })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'plan', rid())
    await settled(bridge, sessionId)
    // The session's cost went 0.25, then 0.5: each turn is a quarter.
    expect(turns.map(turn => turn.cost)).toEqual([
      { amount: 0.25, currency: 'USD' },
      { amount: 0.25, currency: 'USD' },
    ])
  })

  it('leaves out a session total that has nothing before it to subtract, unless the turn is the session’s first', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy', FAKE_ACP_COST: '0.25' }, {}, {}, { turnEnded: turn => void turns.push(turn) })
    const bridge = await fixture.open()
    // The first turn reports nothing; the second reports the session's totals, which may hold more than this turn.
    const { sessionId } = await bridge.createTask({ prompt: 'echo first', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'plan', rid())
    const detail = await settled(bridge, sessionId)
    expect(turns).toHaveLength(2)
    expect(turns[0]).not.toHaveProperty('usage')
    // The session shows what it was told; the record keeps only what is surely this turn's: its time and steps.
    expect(detail.summary.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(detail.messages.filter(message => message.role === 'user')[1]?.turn?.usage).toBeUndefined()
    expect(turns[1]).not.toHaveProperty('usage')
    expect(turns[1]).not.toHaveProperty('cost')
    expect(turns[1]).toMatchObject({ sessionId, steps: 0 })
  })

  it('accumulates session-scoped tokens and fresh cost across clearContext, and names the model consistently without a reply', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_COST: '0.25' }, {}, {}, { turnEnded: turn => void turns.push(turn) })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'plan', rid(), { freshContext: true })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.usage).toEqual({ inputTokens: 20, outputTokens: 40 })
    // The fake agent multiplies FAKE_ACP_COST by its process-wide turn count (0.25 on turn 1, 0.5 on turn 2); clearing context resets costBase so turn 2 takes the new session's full 0.5.
    expect(turns.map(turn => [turn.usage, turn.cost, turn.model])).toEqual([
      [{ inputTokens: 10, outputTokens: 20 }, { amount: 0.25, currency: 'USD' }, 'Small'],
      [{ inputTokens: 10, outputTokens: 20 }, { amount: 0.5, currency: 'USD' }, 'Small'],
    ])
  })

  it('adds up the turns of a Harness that counts each turn, with its cached input put back in the input', async () => {
    // OpenCode's answer as a real one sent it (2026-11-16): this turn only, cache reads beside the input.
    const usage = { inputTokens: 429, outputTokens: 124, totalTokens: 39_721, cachedReadTokens: 39_168 }
    const fixture = await preset('opencode', { FAKE_ACP_CONFIG: 'legacy', FAKE_ACP_USAGE: JSON.stringify(usage) })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'plan', rid())
    const detail = await settled(bridge, sessionId)
    const turn = { inputTokens: 39_597, outputTokens: 124, cacheReadTokens: 39_168 }
    expect(detail.summary.usage).toEqual({ inputTokens: 79_194, outputTokens: 248, cacheReadTokens: 78_336 })
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.turn?.usage)).toEqual([turn, turn])
    await bridge.close()
    expect((await (await fixture.open()).detail(sessionId)).summary.usage).toEqual(detail.summary.usage)
  })

  it('sums the model calls a Harness reports one by one into the turn, when its answer carries none', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' }, {}, { presetId: 'qwen' }, { turnEnded: turn => void turns.push(turn) })
    const bridge = await fixture.open()
    // Qwen Code's per-call usage (0.26.8): cached input inside the input; the second call reports no cache, so none is kept.
    const calls = [
      { inputTokens: 1200, outputTokens: 40, totalTokens: 1240, cachedReadTokens: 1000, thoughtTokens: 5 },
      { inputTokens: 1300, outputTokens: 60, totalTokens: 1360, thoughtTokens: 7 },
    ]
    const { sessionId } = await bridge.createTask({ prompt: `calls ${JSON.stringify(calls)}`, requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'echo nothing reported', rid())
    const detail = await settled(bridge, sessionId)
    const turn = { inputTokens: 2500, outputTokens: 100, reasoningTokens: 12 }
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.turn?.usage)).toEqual([turn, undefined])
    expect(detail.summary.usage).toEqual(turn)
    expect(turns.map(item => item.usage)).toEqual([turn, undefined])
  })

  it('takes no call count that is not a whole safe number, and no sum that stops being exact', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' }, {}, { presetId: 'qwen' }, { turnEnded: turn => void turns.push(turn) })
    const bridge = await fixture.open()
    const big = Number.MAX_SAFE_INTEGER - 1
    // A fractional or oversized count is not a count: that call is left out, the others stand.
    const odd = [
      { inputTokens: 10.5, outputTokens: 1 },
      { inputTokens: 1e300, outputTokens: 1 },
      { inputTokens: 100, outputTokens: 20 },
    ]
    const { sessionId } = await bridge.createTask({ prompt: `calls ${JSON.stringify(odd)}`, requestId: rid() })
    await settled(bridge, sessionId)
    // Two counts each in range whose sum is not: the turn's tokens are not known.
    await bridge.prompt(
      sessionId,
      `calls ${JSON.stringify([
        { inputTokens: big, outputTokens: 1 },
        { inputTokens: big, outputTokens: 1 },
      ])}`,
      rid(),
    )
    const detail = await settled(bridge, sessionId)
    expect(turns.map(turn => turn.usage)).toEqual([{ inputTokens: 100, outputTokens: 20 }, undefined])
    expect(detail.summary.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
    // Whatever was said, the session still opens after a restart.
    await bridge.close()
    expect((await (await fixture.open()).detail(sessionId)).summary.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('asks the Host for a turn’s tokens only when the agent reported none, and records the turn once with them', async () => {
    const turns: HarnessTurnRecord[] = []
    const asked: Array<{ sessionId: string; cwd: string; from: number; to: number }> = []
    const fixture = await setup(
      { FAKE_ACP_CONFIG: 'legacy' },
      {
        readTurnUsage: async ({ signal: _signal, ...input }) => {
          asked.push(input)
          return { inputTokens: 7, outputTokens: 3 }
        },
      },
      {},
      { turnEnded: turn => void turns.push(turn) },
    )
    const bridge = await fixture.open()
    // The agent reports this turn's usage: the Host is not asked, and nothing is counted twice.
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    await settled(bridge, sessionId)
    expect(asked).toEqual([])
    await bridge.prompt(sessionId, 'echo silent', rid())
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.sessionId).toMatch(/^sess-/u)
    expect(asked[0]!.from).toBeLessThanOrEqual(asked[0]!.to)
    expect(turns[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(turns[1]!.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
    // The session itself shows only what the agent said.
    expect((await bridge.detail(sessionId)).summary.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it("never takes goose's prompt usage for the turn's, and asks the Host for the turn's tokens instead", async () => {
    const turns: HarnessTurnRecord[] = []
    const asked: string[] = []
    const fixture = await setup(
      { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'chat,approve,auto', FAKE_ACP_INITIAL_MODE: 'approve' },
      {
        readTurnUsage: async ({ sessionId }) => {
          asked.push(sessionId)
          return { inputTokens: 7, outputTokens: 3, cacheReadTokens: 5 }
        },
      },
      { presetId: 'goose' },
      { turnEnded: turn => void turns.push(turn) },
    )
    const bridge = await fixture.open()
    // The fake reports usage with its answer, as goose reports its last call's context.
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(asked).toHaveLength(1)
    expect(turns[0]!.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 5 })
    expect((await bridge.detail(sessionId)).summary.usage).toBeUndefined()
  })

  it('records the turn without tokens and closes when the Host’s read never settles', async () => {
    const turns: HarnessTurnRecord[] = []
    const fixture = await setup(
      { FAKE_ACP_CONFIG: 'legacy' },
      { turnUsageReadMs: 50, readTurnUsage: () => new Promise(() => {}) },
      {},
      { turnEnded: turn => void turns.push(turn) },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo silent', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.close()
    expect(turns).toHaveLength(1)
    expect(turns[0]).not.toHaveProperty('usage')
  })

  it('records the turn without tokens when the Host’s read finds none, and waits for it before closing', async () => {
    const turns: HarnessTurnRecord[] = []
    let release!: () => void
    const fixture = await setup(
      { FAKE_ACP_CONFIG: 'legacy' },
      { readTurnUsage: () => new Promise(resolve => (release = () => resolve(undefined))) },
      {},
      { turnEnded: turn => void turns.push(turn) },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo silent', requestId: rid() })
    await settled(bridge, sessionId)
    expect(turns).toEqual([])
    const closing = bridge.close()
    release()
    await closing
    expect(turns).toHaveLength(1)
    expect(turns[0]).not.toHaveProperty('usage')
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
    expect(await bridge.classifyConfigChange!(sessionId, 'mode', 'agent')).toBe('wider')
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

  it('never says an allowed call that reported nothing more did not start: its result is unknown', async () => {
    const bridge = await (await setup()).open()
    const { sessionId } = await bridge.createTask({ prompt: 'quiet', requestId: rid() })
    const asked = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    await bridge.decide(asked.approvals[0]!.id, 'allow')
    await until(bridge, sessionId, detail => detail.liveText.includes('running'))
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.summary.status).toBe('cancelled')
    const row = tool(detail, 'tool:1:call_1')
    expect(row).toMatchObject({ state: 'failed', text: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') })
    expect(row?.text).not.toContain('TOOL_NOT_STARTED')
    expect(detail.summary.runEnd?.unknownResults).toEqual([{ messageId: 'tool:1:call_1', name: 'sleep 40' }])
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

  it('shows a prompt to a session being loaded as starting at once, and records a stop then as a stopped turn', async () => {
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
    const starting = await until(bridge, restored.sessionId, detail => detail.summary.status === 'running')
    expect(starting.messages).toHaveLength(2)
    expect(starting.summary).toMatchObject({ status: 'running', live: { activity: 'starting' } })
    expect(starting.activity?.phase).toBe('starting')
    expect((await bridge.listTasks()).find(task => task.id === restored.sessionId)?.status).toBe('running')
    await vi.waitFor(async () => expect(received(await fixture.log(), 'session/load')).toHaveLength(1), { timeout: 5_000, interval: 10 })
    await bridge.cancel(restored.sessionId)
    await prompted
    const stopped = await bridge.detail(restored.sessionId)
    expect(stopped.summary).toMatchObject({ status: 'cancelled', runOutcome: 'cancelled' })
    expect(stopped.messages.map(message => message.text)).toEqual(['echo one', 'echo: echo one', 'echo two'])
    expect(received(await fixture.log(), 'session/prompt').filter(entry => JSON.stringify(entry.params).includes('echo two'))).toHaveLength(
      0,
    )
    await new Promise(resolve => setTimeout(resolve, 500))
    expect((await bridge.detail(busy.sessionId)).summary.status).toBe('running')
    const log = await fixture.log()
    const load = received(log, 'session/load')[0]
    expect(
      received(log, '$/cancel_request')
        .filter(entry => entry.pid === load.pid)
        .map(entry => entry.params?.requestId),
    ).toContain(load.id)

    // Recorded, so the same request is the same turn; a new one runs.
    await bridge.prompt(restored.sessionId, 'echo two', requestId)
    expect((await bridge.detail(restored.sessionId)).messages).toEqual(stopped.messages)
    await bridge.prompt(restored.sessionId, 'echo three', rid())
    expect(assistants(await settled(bridge, restored.sessionId)).at(-1)?.text).toBe('echo: echo three')
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

  it('uses one event timestamp for an unrecognised request even when every clock read advances', async () => {
    let clock = 1_000_000
    const bridge = await (await setup({}, {}, {}, { clock: () => ++clock })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'unknownhang', requestId: rid() })
    const { live } = (await until(bridge, sessionId, item => (item.summary.live?.unrecognized?.count ?? 0) === 2)).summary
    expect(live!.unrecognized!.at).toBe(live!.lastEventAt)
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
    expect(note).toContain('已记入日志')
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

  it('refuses the next prompt of a session whose agent cannot start, with a code that says nothing was accepted', async () => {
    const fixture = await setup({ FAKE_ACP_INIT_ERROR: '1' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const before = await settled(bridge, sessionId)
    const requestId = rid()
    await expect(bridge.prompt(sessionId, 'echo again', requestId)).rejects.toMatchObject({ status: 503, code: 'agent-start-failed' })
    const after = await bridge.detail(sessionId)
    // Refused before the turn was recorded: no user message carries the request.
    expect(after.messages.some(message => message.requestId === requestId)).toBe(false)
    expect(after.messages).toHaveLength(before.messages.length)
  })

  it('says a session whose agent exits while it is being loaded accepted nothing (agent-start-failed, not agent-exited)', async () => {
    const exitFile = join(await mkdtemp(join(tmpdir(), 'latch-load-exit-')), 'exit')
    const fixture = await setup({ FAKE_ACP_CAPS: 'load', FAKE_ACP_LOAD_EXIT_FILE: exitFile })
    const first = await fixture.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    const before = await settled(first, sessionId)
    await first.close()
    await writeFile(exitFile, '1')
    const bridge = await fixture.open()
    const requestId = rid()
    await expect(bridge.prompt(sessionId, 'echo two', requestId)).rejects.toMatchObject({ status: 503, code: 'agent-start-failed' })
    const after = await bridge.detail(sessionId)
    expect(after.messages.some(message => message.requestId === requestId)).toBe(false)
    expect(after.messages).toHaveLength(before.messages.length)
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

  it('picks up the same session in a new process once a login that expired is renewed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-login-file-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const loginFile = join(root, 'login')
    await writeFile(loginFile, 'yes')
    const fixture = await setup({ FAKE_ACP_LOGIN_FILE: loginFile, FAKE_ACP_CAPS: 'resume' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')

    await rm(loginFile)
    await bridge.prompt(sessionId, 'echo two', rid())
    const expired = await settled(bridge, sessionId)
    expect(expired.summary.status).toBe('failed')
    expect(expired.summary.runEnd?.reason).toBe('login-required')
    expect(systemText(expired)).toContain('还没登录')

    // The process stops by itself, because a real one reads its login only once. Logged in again, the next turn goes on.
    await writeFile(loginFile, 'yes')
    await vi.waitFor(
      async () => {
        const started = (await fixture.log()).filter(entry => entry.event === 'start')
        expect(alive(started[0]!.pid)).toBe(false)
      },
      { timeout: 8_000 },
    )
    await bridge.prompt(sessionId, 'echo three', rid())
    const resumed = await settled(bridge, sessionId)
    expect(resumed.summary.status).toBe('idle')
    expect(resumed.summary.runEnd).toBeUndefined()
    const log = await fixture.log()
    expect(received(log, 'session/new')).toHaveLength(1)
    expect(received(log, 'session/resume')).toHaveLength(1)
    expect(received(log, 'authenticate')).toEqual([])
  })

  it('fails with login guidance instead of authenticating, and rejects other protocol versions', async () => {
    const fixture = await setup({ FAKE_ACP_AUTH: 'new' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('还没登录。按它自己的方式登录后重试。')
    expect(detail.summary.runEnd?.reason).toBe('login-required')
    await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ status: 409, code: 'agent-auth-required' })
    expect(received(await fixture.log(), 'authenticate')).toEqual([])
    // Each try after a refusal starts a new process, which is what reads a login made in between.
    await vi.waitFor(async () => expect(received(await fixture.log(), 'initialize').length).toBe(2), { timeout: 8_000 })

    const promptAuth = await (await setup({ FAKE_ACP_AUTH: 'prompt' })).open()
    const gated = await promptAuth.createTask({ prompt: 'echo', requestId: rid() })
    expect(systemText(await settled(promptAuth, gated.sessionId))).toContain('还没登录')

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
    const connection = AcpWire.spawn(
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

  it('never lists or sends Grok\u2019s /always-approve, which changes its mode without saying so over ACP', async () => {
    const commands = [
      { name: 'compact', description: 'Compress conversation history' },
      { name: 'always-approve', description: 'Toggle always-approve mode', input: { hint: 'on|off' } },
    ]
    const fixture = await preset('grok', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_COMMANDS: JSON.stringify(commands) })
    const bridge = await fixture.open()
    await expect(bridge.createTask({ prompt: '/always-approve on', requestId: rid() })).rejects.toMatchObject({
      status: 409,
      code: 'mode-command-refused',
    })
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.commands?.map(command => command.name)).toEqual(['compact'])
    await expect(bridge.prompt(sessionId, '  /always-approve on', rid())).rejects.toMatchObject({ code: 'mode-command-refused' })
    // Only the word itself: text that merely mentions it is a prompt like any other.
    await bridge.prompt(sessionId, 'echo what does /always-approve do', rid())
    await settled(bridge, sessionId)
    const sent = received(await fixture.log(), 'session/prompt').map(entry => JSON.stringify(entry.params?.prompt))
    expect(sent).toHaveLength(2)
    expect(sent.some(text => text.includes('"/always-approve on"'))).toBe(false)
    await bridge.close()
  })

  it('tells a Grok session that the project has answers saved in Grok\u2019s own home', async () => {
    const fixture = await preset('grok', { FAKE_ACP_CONFIG: 'options' })
    const home = join(fixture.root, 'grok-home')
    const saved = join(home, 'sessions', encodeURIComponent(await realpath(fixture.workspace)))
    await mkdir(saved, { recursive: true })
    await writeFile(join(saved, 'permission.toml'), 'remembered')
    vi.stubEnv('GROK_HOME', home)
    cleanups.push(async () => void vi.unstubAllEnvs())
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await vi.waitFor(async () =>
      expect((await bridge.detail(sessionId)).permission?.notes.some(note => note.includes('permission.toml'))).toBe(true),
    )
    expect(JSON.stringify(await bridge.detail(sessionId))).not.toContain('remembered')
    await bridge.close()
  })

  it('deletes a removed Grok session with its own delete, also one recorded before that was known', async () => {
    const env = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_XAI_DELETE: '1' }
    const fixture = await preset('grok', env)
    let bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    const agentSession = received(await fixture.log(), 'session/prompt')[0]!.params?.sessionId as string
    await bridge.close()
    // As a session bound before Grok's delete was known stored it.
    const store = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')) as {
      tasks: Record<string, { acp: { deletable?: boolean } }>
    }
    store.tasks[sessionId]!.acp.deletable = false
    await writeFile(join(fixture.dataDir, 'acp.json'), JSON.stringify(store))
    bridge = await fixture.open()
    await bridge.remove!(sessionId)
    await vi.waitFor(
      async () =>
        expect(received(await fixture.log(), '_x.ai/session/delete').map(entry => entry.params?.sessionId)).toEqual([agentSession]),
      { timeout: 5_000, interval: 10 },
    )
    await vi.waitFor(async () => expect(await fixture.agentSessions()).toEqual({}), { timeout: 5_000, interval: 10 })
    expect(received(await fixture.log(), 'session/delete')).toEqual([])
    await bridge.close()
  })

  it('removes the folder Cursor keeps for a session Latch started, and only that one, once the process is gone', async () => {
    const config = await mkdtemp(join(tmpdir(), 'latch-cursor-config-'))
    cleanups.push(() => rm(config, { recursive: true, force: true }))
    const fixture = await preset('cursor', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'agent,plan,ask',
      FAKE_ACP_INITIAL_MODE: 'agent',
      FAKE_ACP_CAPS: 'load',
      CURSOR_CONFIG_DIR: config,
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    const first = await settled(bridge, sessionId)
    expect(first.summary.status, systemText(first)).toBe('idle')
    const own = received(await fixture.log(), 'session/prompt')[0]!.params?.sessionId as string
    const folder = (id: string) => join(config, 'acp-sessions', id)
    const cwd = (await bridge.detail(sessionId)).summary.cwd!
    await mkdir(folder(own), { recursive: true })
    await writeFile(join(folder(own), 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))
    await writeFile(join(folder(own), 'store.db'), 'x')
    // Another client's session, and a folder whose record names another place, stay.
    await mkdir(folder('someone-else'), { recursive: true })
    await writeFile(join(folder('someone-else'), 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))
    await bridge.remove!(sessionId)
    await vi.waitFor(
      async () =>
        expect(
          await stat(folder(own)).then(
            () => true,
            () => false,
          ),
        ).toBe(false),
      { timeout: 5_000, interval: 20 },
    )
    expect(
      await stat(folder('someone-else')).then(
        () => true,
        () => false,
      ),
    ).toBe(true)

    // A folder whose record says another place is not this session's.
    const second = await bridge.createTask({ prompt: 'echo two', requestId: rid() })
    await settled(bridge, second.sessionId)
    const other = received(await fixture.log(), 'session/prompt').at(-1)!.params?.sessionId as string
    await mkdir(folder(other), { recursive: true })
    await writeFile(join(folder(other), 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd: '/elsewhere' }))
    await bridge.remove!(second.sessionId)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(
      await stat(folder(other)).then(
        () => true,
        () => false,
      ),
    ).toBe(true)
    // A link in its place is followed by nothing: neither the link nor what it points at goes.
    const third = await bridge.createTask({ prompt: 'echo three', requestId: rid() })
    await settled(bridge, third.sessionId)
    const linked = received(await fixture.log(), 'session/prompt').at(-1)!.params?.sessionId as string
    const target = join(config, 'elsewhere')
    await mkdir(target)
    await writeFile(join(target, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))
    await symlink(target, folder(linked))
    await bridge.remove!(third.sessionId)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await lstat(folder(linked))).isSymbolicLink()).toBe(true)
    expect((await stat(join(target, 'meta.json'))).isFile()).toBe(true)
    await bridge.close()
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
    expect(detail.summary).toMatchObject({ status: 'interrupted', runOutcome: 'interrupted' })
    expect(systemText(detail)).toContain('Latch 重启时中断')
    expect(detail.messages.at(-1)).toMatchObject({ role: 'system', state: 'cancelled', interrupted: true })
    expect(tool(detail, 'tool:1:call_1')).toMatchObject({ state: 'failed', interrupted: true })
    expect(detail.summary.runEnd).toMatchObject({ reason: 'host-stopped', unknownResults: [{ messageId: 'tool:1:call_1' }] })
  })

  it("marks a turn the agent ended on the Host's stop as interrupted, not cancelled, and keeps what its tools reported", async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'endturn', requestId: rid() })
    await until(bridge, sessionId, detail => tool(detail, 'tool:1:call_1')?.state === 'running')
    await bridge.close()
    const detail = await (await fixture.open()).detail(sessionId)
    expect(detail.summary).toMatchObject({ status: 'interrupted', runOutcome: 'interrupted', runEnd: { reason: 'host-stopped' } })
    // The agent reported this one finished as it stopped: that stays true.
    expect(tool(detail, 'tool:1:call_1')).toMatchObject({ state: 'completed' })
    expect(tool(detail, 'tool:1:call_1')).not.toHaveProperty('interrupted')
    // This one never started.
    expect(tool(detail, 'tool:1:call_2')).toMatchObject({ state: 'cancelled', interrupted: true })
    expect(systemText(detail)).toContain('Latch 重启时中断')
    expect(systemText(detail)).not.toContain('已按取消处理')
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
              // Allowed, it may run though it never said so.
              {
                id: 'tool:1:c',
                role: 'tool',
                toolName: 'execute',
                text: '',
                state: 'queued',
                tool: { title: 'C', decision: { outcome: 'allowed', at: updatedAt } },
              },
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
    expect(tool(detail, 'tool:1:a')?.interrupted).toBe(true)
    expect(tool(detail, 'tool:1:b')).toMatchObject({ state: 'cancelled', interrupted: true })
    expect(detail.summary.runOutcome).toBe('interrupted')
    expect(systemText(detail)).toContain('Latch 重启时中断')
    expect(tool(detail, 'tool:1:c')).toMatchObject({ state: 'failed', tool: { output: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') } })
    expect(detail.summary.runEnd).toMatchObject({
      reason: 'host-stopped',
      unknownResults: [
        { messageId: 'tool:1:a', name: 'A' },
        { messageId: 'tool:1:c', name: 'C' },
      ],
    })
    const stored = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8'))
    expect(stored.tasks.stale.summary.status).toBe('interrupted')
    expect(await fixture.log()).toEqual([])
  })
})

describe('ACP session configuration', () => {
  it.skipIf(process.platform === 'win32')('refuses the legacy Qwen model setter that persists the original CLI settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-qwen-cli-config-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'home')
    const command = join(root, 'bin', 'qwen')
    await seedCliFiles(home, {
      '.qwen/settings.json': '{"model":{"name":"small"},"hooks":{}}\n',
      '.zshrc': '# fixture shell configuration\n',
    })
    await fakeCli(command, FAKE_ACP_AGENT, home, {
      QWEN_HOME: join(home, '.qwen'),
      QWEN_RUNTIME_DIR: join(home, '.local', 'state', 'qwen'),
    })
    const fixture = await setup(
      {
        FAKE_ACP_CONFIG: 'legacy',
        FAKE_ACP_CAPS: 'resume',
        FAKE_ACP_MODES: QWEN_MODES,
        FAKE_ACP_INITIAL_MODE: 'default',
        FAKE_QWEN_PERSIST_LEGACY_MODEL: '1',
      },
      { idleMs: 60_000 },
      { command, args: [], presetId: 'qwen' },
    )
    await seedCliFiles(fixture.workspace, {
      '.qwen/settings.json': '{"permissions":{"deny":["Shell"]}}\n',
      '.qwen/hooks.json': '{}\n',
    })
    const before = await Promise.all([cliTree(home), cliTree(fixture.workspace)])
    let bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo first', requestId: rid() })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(await Promise.all([cliTree(home), cliTree(fixture.workspace)])).toEqual(before)

    const change = await bridge.setConfig!(sessionId, 'model', 'large').catch((error: unknown) => error)
    expect(await Promise.all([cliTree(home), cliTree(fixture.workspace)])).toEqual(before)
    expect(change).toMatchObject({ status: 501, code: 'not-supported', details: { configOutcome: 'not-sent' } })
    await bridge.setConfig!(sessionId, 'mode', 'plan')
    expect((await bridge.detail(sessionId)).permission?.expectedMode).toBe('plan')
    await bridge.close()

    bridge = await fixture.open()
    await bridge.prompt(sessionId, 'echo restored', rid())
    const resumed = await settled(bridge, sessionId)
    expect(resumed.summary.status).toBe('idle')
    expect(resumed.permission?.expectedMode).toBe('plan')
    expect(resumed.config?.find(option => option.category === 'model')?.currentValue).toBe('small')
    const attempted = await bridge.createTask({
      prompt: 'echo must not be sent',
      requestId: rid(),
      config: [{ configId: 'model', value: 'large' }],
    })
    const refused = await settled(bridge, attempted.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('可能改写原来的模型默认值')
    await bridge.close()
    const log = await fixture.log()
    expect(received(log, 'session/set_model')).toHaveLength(0)
    expect(received(log, 'session/resume')).toHaveLength(1)
    expect(received(log, 'session/prompt')).toHaveLength(2)
    expect(await Promise.all([cliTree(home), cliTree(fixture.workspace)])).toEqual(before)
  })

  it('starts dsh in its chosen process mode, changes it only while idle, and checks without applying it again', async () => {
    const fixture = await preset('dsh', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_PROCESS_MODE: '1', FAKE_ACP_CAPS: 'resume,close' })
    const bridge = await fixture.open()
    const readonly = await bridge.launchPreview!({ cwd: fixture.workspace })
    const writable = await bridge.launchPreview!({ cwd: fixture.workspace, config: [{ configId: LADDER_MODE, value: 'workspace-write' }] })
    expect(writable.launchHash).not.toBe(readonly.launchHash)
    expect(writable.definitionHash).toBe(readonly.definitionHash)
    const { sessionId } = await bridge.createTask({
      prompt: 'echo',
      requestId: rid(),
      config: [{ configId: LADDER_MODE, value: 'workspace-write' }],
    })
    await settled(bridge, sessionId)
    const first = await bridge.detail(sessionId)
    expect(first.permission?.expectedMode).toBe('workspace-write')
    expect(first.config?.find(option => option.category === 'mode')?.currentValue).toBe('workspace-write')
    await bridge.setConfig!(sessionId, 'mode', 'read-only')
    expect((await bridge.detail(sessionId)).permission?.expectedMode).toBe('read-only')
    const before = (await fixture.log()).filter(entry => entry.event === 'process-mode-set').length
    expect(await bridge.readConfig!(sessionId, 'mode', 'read-only')).toEqual({ kind: 'read', currentValue: 'read-only', asked: true })
    expect((await fixture.log()).filter(entry => entry.event === 'process-mode-set')).toHaveLength(before)
    expect(received(await fixture.log(), 'session/set_config_option')).toHaveLength(0)
    expect(received(await fixture.log(), 'session/set_mode')).toHaveLength(0)
    await bridge.close()
    const resumed = await fixture.open()
    await resumed.prompt(sessionId, 'echo after restart', rid())
    await settled(resumed, sessionId)
    expect((await resumed.detail(sessionId)).permission?.expectedMode).toBe('read-only')
  })

  it('refuses a dsh prompt when its permission service does not report the selected mode', async () => {
    const fixture = await preset('dsh', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    const result = await settled(bridge, sessionId)
    expect(result.summary.status).toBe('failed')
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
  })

  it('reserves a process-mode restart against prompts, other writes and checks, and rechecks authorization before spawn', async () => {
    const fixture = await preset(
      'dsh',
      {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_PROCESS_MODE: '1',
        FAKE_ACP_CAPS: 'resume',
        FAKE_ACP_RESUME_DELAY: '150',
      },
      { idleMs: 60_000 },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    await settled(bridge, sessionId)
    const changing = bridge.setConfig!(sessionId, 'mode', 'workspace-write')
    await vi.waitFor(async () => expect(received(await fixture.log(), 'session/resume')).toHaveLength(1))
    await expect(bridge.prompt(sessionId, 'must not run', rid())).rejects.toMatchObject({ code: 'config-check-running' })
    await expect(bridge.setConfig!(sessionId, 'mode', 'read-only')).rejects.toMatchObject({ code: 'config-check-running' })
    expect(await bridge.readConfig!(sessionId, 'mode', 'workspace-write')).toEqual({ kind: 'busy', reason: 'running' })
    await changing
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
    let checks = 0
    await expect(
      bridge.setConfig!(sessionId, 'mode', 'danger-full-access', {
        authorize: () => {
          if (++checks >= 4) throw new AppError(403, 'permission-denied', 'revoked')
        },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(starts)
    expect((await bridge.detail(sessionId)).permission?.expectedMode).toBe('workspace-write')
  })

  it.each([
    ['assertLaunch', 'large'],
    ['assertWorkspace', 'large'],
    ['assertLaunch', 'small'],
  ] as const)('refuses %s preparation of %s that finishes while config is being checked', async (preparation, value) => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo', requestId: rid() })
    await settled(bridge, sessionId)
    const prepared = deferred(),
      continueWrite = deferred(),
      resuming = deferred(),
      continueRead = deferred()
    // Pause only the asynchronous preparation: both operations still use the real session and fake Agent protocol.
    const runtime = bridge as unknown as Record<typeof preparation, (...args: unknown[]) => Promise<unknown>>
    const prepare = runtime[preparation].bind(runtime)
    const preparationSpy = vi.spyOn(runtime, preparation).mockImplementationOnce(async (...args) => {
      const result = await prepare(...args)
      prepared.resolve()
      await continueWrite.promise
      return result
    })
    const request = AcpWire.prototype.request
    const requestSpy = vi.spyOn(AcpWire.prototype, 'request').mockImplementation(async function (this: AcpWire, ...args) {
      if (args[0] === 'session/resume') {
        resuming.resolve()
        await continueRead.promise
      }
      return request.apply(this, args)
    })
    let outcome: unknown
    const writing = bridge.setConfig!(sessionId, 'model', value).then(
      () => {
        outcome = { applied: true }
      },
      (error: unknown) => {
        outcome = error
      },
    )
    let reading: ReturnType<NonNullable<Bridge['readConfig']>> | undefined
    try {
      await prepared.promise
      reading = bridge.readConfig!(sessionId, 'model', 'small')
      await resuming.promise
      continueWrite.resolve()
      await expect
        .poll(() => outcome, { timeout: 1_000 })
        .toMatchObject({
          status: 409,
          code: 'config-check-running',
          details: { configOutcome: 'not-sent' },
        })
      continueRead.resolve()
      await expect(reading).resolves.toEqual({ kind: 'read', currentValue: 'small', asked: true })
      expect(received(await fixture.log(), 'session/set_config_option')).toHaveLength(0)
      expect((await bridge.detail(sessionId)).config?.find(option => option.id === 'model')?.currentValue).toBe('small')
    } finally {
      continueWrite.resolve()
      continueRead.resolve()
      await Promise.allSettled([writing, reading])
      preparationSpy.mockRestore()
      requestSpy.mockRestore()
    }
  })

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
    await bridge.setConfig!(sessionId, 'mode', 'plan')
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
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.usageReport).toEqual({ contextUsed: 10, contextSize: 100, contextSource: 'acp', contextEpoch: 0, at: expect.any(String) })
    const firstWindow = { at: detail.usageReport!.at, used: 10, size: 100, source: 'acp', epoch: 0 }
    expect(detail.messages.find(message => message.role === 'user')?.turn?.contextWindow).toEqual(firstWindow)
    expect(detail.summary.createdAt).toEqual(expect.any(String))
    await bridge.close()
    const reopened = await fixture.open()
    const restored = await reopened.detail(sessionId)
    expect(restored.usageReport).toEqual(detail.usageReport)
    expect(restored.messages).toEqual(detail.messages)
    expect(restored.messages.find(message => message.role === 'user')?.requestId).toEqual(expect.any(String))
    await reopened.prompt(sessionId, 'hello', rid())
    const next = await settled(reopened, sessionId)
    expect(next.messages.filter(message => message.role === 'user').map(message => message.turn?.contextWindow)).toEqual([
      firstWindow,
      undefined,
    ])
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

describe('command cache from real sessions', () => {
  it('keeps proven user input separate from brief and replay text, and never invents provenance for a direct SDK prompt', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const calls = vi.spyOn(AcpWire.prototype, 'request')
    try {
      const requestId = rid()
      const { sessionId } = await withHarnessPromptSource({ method: 'create', requestId, text: 'echo $actual' }, () =>
        bridge.createTask({
          prompt: 'echo $actual',
          requestId,
          agentContext: {
            agent: { customAgentId: 'agt_source' },
            instructions: '',
            brief: { segments: [{ source: 'user', text: 'Brief example $brief-only' }] },
            revision: 'a'.repeat(64),
          },
        }),
      )
      await settled(bridge, sessionId)
      const first = calls.mock.calls.find(call => call[0] === 'session/prompt')!
      expect(JSON.stringify(first[1])).toContain('$brief-only')
      expect((first as readonly unknown[])[5]).toEqual({ userText: 'echo $actual', messageId: expect.any(String) })
      calls.mockClear()
      const seeded = await bridge.createTask({ prompt: '', seed: 'Historical example $history-only\n', requestId: rid() })
      const later = rid()
      await withHarnessPromptSource({ method: 'prompt', sessionId: seeded.sessionId, requestId: later, text: 'echo current' }, () =>
        bridge.prompt(seeded.sessionId, 'echo current', later),
      )
      await settled(bridge, seeded.sessionId)
      const second = calls.mock.calls.find(call => call[0] === 'session/prompt')!
      expect(JSON.stringify(second[1])).toContain('$history-only')
      expect((second as readonly unknown[])[5]).toEqual({ userText: 'echo current', messageId: expect.any(String) })
      calls.mockClear()
      await bridge.prompt(sessionId, 'echo $unproven', rid())
      await settled(bridge, sessionId)
      // No proven input: only the message the prompt opens, never words of the person's.
      expect((calls.mock.calls.find(call => call[0] === 'session/prompt') as readonly unknown[])[5]).toEqual({
        messageId: expect.any(String),
      })
    } finally {
      calls.mockRestore()
    }
  })

  it('excludes file-reference and attachment bodies, preserves empty input, and does not persist provenance across recovery', async () => {
    const fixture = await setup(
      { FAKE_ACP_CAPS: 'embedded,load' },
      {},
      {},
      {
        readAttachment: async () => ({ type: 'text', name: 'note.txt', text: 'Attachment $attachment-only' }),
      },
    )
    let bridge = await fixture.open()
    const calls = vi.spyOn(AcpWire.prototype, 'request')
    const attachment = {
      id: 'abcdefghijklmnopqrstuv',
      name: 'note.txt',
      kind: 'text' as const,
      mime: 'text/plain' as const,
      size: 4,
      sha256: 'a'.repeat(64),
    }
    const requestId = rid()
    const input = { prompt: 'echo current', requestId, attachments: [attachment], fileRefs: [{ root: 'default', path: '$file-only.txt' }] }
    try {
      const first = await withHarnessPromptSource({ method: 'create', requestId, text: input.prompt }, () => bridge.createTask(input))
      await settled(bridge, first.sessionId)
      const sent = calls.mock.calls.find(call => call[0] === 'session/prompt')!
      expect(JSON.stringify(sent[1])).toContain('$file-only')
      expect(JSON.stringify(sent[1])).toContain('$attachment-only')
      expect((sent as readonly unknown[])[5]).toEqual({ userText: 'echo current', messageId: expect.any(String) })
      expect(
        (await fixture.log()).filter(row => row.method === 'session/prompt').every(row => !JSON.stringify(row.params).includes('userText')),
      ).toBe(true)
      calls.mockClear()
      // The receipt is unchanged: replay without provenance never starts another model turn.
      expect(await bridge.createTask(input)).toEqual(first)
      expect(calls.mock.calls.some(call => call[0] === 'session/prompt')).toBe(false)
      const emptyId = rid()
      const empty = await withHarnessPromptSource({ method: 'create', requestId: emptyId, text: '' }, () =>
        bridge.createTask({ prompt: '', requestId: emptyId, attachments: [attachment] }),
      )
      await settled(bridge, empty.sessionId)
      expect((calls.mock.calls.find(call => call[0] === 'session/prompt') as readonly unknown[])[5]).toEqual({
        userText: '',
        messageId: expect.any(String),
      })
      await bridge.close()
      const saved = JSON.parse(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')) as { tasks: Record<string, { acp: object }> }
      for (const task of Object.values(saved.tasks)) {
        expect(task).not.toHaveProperty('userText')
        expect(task.acp).not.toHaveProperty('userText')
      }
      bridge = await fixture.open()
      calls.mockClear()
      await bridge.prompt(first.sessionId, 'echo $unproven-after-recovery', rid())
      await settled(bridge, first.sessionId)
      // No proven input: only the message the prompt opens, never words of the person's.
      expect((calls.mock.calls.find(call => call[0] === 'session/prompt') as readonly unknown[])[5]).toEqual({
        messageId: expect.any(String),
      })
    } finally {
      calls.mockRestore()
    }
  })

  it('removes only the current validated fork prefix from proven input', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const calls = vi.spyOn(AcpWire.prototype, 'request')
    const prefix = 'Earlier transcript $history-only\n'
    const prompt = `${prefix}echo $current`
    const requestId = rid()
    try {
      const { sessionId } = await withHarnessPromptSource({ method: 'create', requestId, text: prompt }, () =>
        bridge.createTask({ prompt, requestId, fork: { taskId: 'past', upToMessageId: 'earlier', prefixLength: prefix.length } }),
      )
      await settled(bridge, sessionId)
      const sent = calls.mock.calls.find(call => call[0] === 'session/prompt')!
      expect(JSON.stringify(sent[1])).toContain('$history-only')
      expect((sent as readonly unknown[])[5]).toEqual({ userText: 'echo $current', messageId: expect.any(String) })
      calls.mockClear()
      await expect(
        bridge.createTask({
          prompt,
          requestId: rid(),
          fork: { taskId: 'past', upToMessageId: 'earlier', prefixLength: prompt.length + 1 },
        }),
      ).rejects.toMatchObject({ code: 'fork-invalid' })
      expect(calls.mock.calls.some(call => call[0] === 'session/prompt')).toBe(false)
    } finally {
      calls.mockRestore()
    }
  })

  it('publishes a durable command-report version after cache validation, without changing it for ordinary messages', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const context = { cwd: fixture.workspace }
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect((await bridge.detail(sessionId)).summary.commandsVersion).toBeTypeOf('string'))
    const version = (await bridge.detail(sessionId)).summary.commandsVersion
    expect(await bridge.commandCatalogue?.(context)).toMatchObject({ sourceSessionId: sessionId })
    await bridge.prompt(sessionId, 'hello', rid())
    await settled(bridge, sessionId)
    expect((await bridge.detail(sessionId)).summary.commandsVersion).toBe(version)
    await bridge.prompt(sessionId, 'plan', rid())
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect((await bridge.detail(sessionId)).summary.commandsVersion).not.toBe(version))
    const updated = (await bridge.detail(sessionId)).summary.commandsVersion
    await bridge.close()
    const restored = await fixture.open()
    expect((await restored.detail(sessionId)).summary.commandsVersion).toBe(updated)
  })

  it.each([0, 257])('does not persist an invalid optional SDK cache scope (length %i)', async length => {
    const workspaceId = 'x'.repeat(length)
    const fixture = await setup()
    const bridge = await fixture.open()
    const context = { cwd: fixture.workspace, workspaceId }
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
    await settled(bridge, sessionId)
    await bridge.close()
    const restored = await fixture.open()
    expect((await restored.detail(sessionId)).commands).toEqual([{ name: 'init', description: 'init' }])
    expect(await restored.commandCatalogue?.(context)).toBeUndefined()
    expect(await restored.commandCatalogue?.({ cwd: fixture.workspace })).toBeUndefined()
  })

  it.each(['command', 'project'] as const)(
    'discards a lookup when its %s fingerprint changes during directory validation',
    async change => {
      const binRoot = await mkdtemp(join(tmpdir(), 'latch-cache-command-'))
      cleanups.push(() => rm(binRoot, { recursive: true, force: true }))
      const bins = [join(binRoot, 'a'), join(binRoot, 'b')]
      for (const bin of bins) {
        await mkdir(bin)
        await symlink(process.execPath, join(bin, 'cache-node'))
      }
      let currentBin = bins[0]!
      setCommandSearch(() => [currentBin])
      const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' }, {}, { presetId: 'opencode', command: 'cache-node' })
      const bridge = await fixture.open()
      const context = { cwd: fixture.workspace }
      const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
      await settled(bridge, sessionId)
      await vi.waitFor(async () => expect(await bridge.commandCatalogue?.(context)).toMatchObject({ sourceSessionId: sessionId }))
      const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
      let entered!: () => void
      let release!: () => void
      const waiting = new Promise<void>(done => {
        entered = done
      })
      const held = new Promise<void>(done => {
        release = done
      })
      const readDirectory = commandCache.commandDirectory
      const spy = vi.spyOn(commandCache, 'commandDirectory').mockImplementationOnce(async cwd => {
        const identity = await readDirectory(cwd)
        entered()
        await held
        return identity
      })
      const reading = bridge.commandCatalogue!(context)
      try {
        await waiting
        if (change === 'command') currentBin = bins[1]!
        else await writeFile(join(fixture.workspace, 'opencode.json'), '{}')
        release()
        expect(await reading).toBeUndefined()
        expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(starts)
      } finally {
        release()
        await reading.catch(() => {})
        spy.mockRestore()
      }
    },
  )

  it.each(['command', 'project'] as const)(
    'discards a real report when its %s fingerprint changes during directory validation',
    async change => {
      const binRoot = await mkdtemp(join(tmpdir(), 'latch-cache-command-'))
      cleanups.push(() => rm(binRoot, { recursive: true, force: true }))
      const bins = [join(binRoot, 'a'), join(binRoot, 'b')]
      for (const bin of bins) {
        await mkdir(bin)
        await symlink(process.execPath, join(bin, 'cache-node'))
      }
      let currentBin = bins[0]!
      setCommandSearch(() => [currentBin])
      const fixture = await setup({ FAKE_ACP_CONFIG: 'legacy' }, {}, { presetId: 'opencode', command: 'cache-node' })
      const bridge = await fixture.open()
      const context = { cwd: fixture.workspace }
      const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
      await settled(bridge, sessionId)
      await vi.waitFor(async () => expect(await bridge.commandCatalogue?.(context)).toMatchObject({ sourceSessionId: sessionId }))
      let entered!: () => void
      let release!: () => void
      const waiting = new Promise<void>(done => {
        entered = done
      })
      const held = new Promise<void>(done => {
        release = done
      })
      const readDirectory = commandCache.commandDirectory
      const spy = vi.spyOn(commandCache, 'commandDirectory').mockImplementationOnce(async cwd => {
        const identity = await readDirectory(cwd)
        entered()
        await held
        return identity
      })
      const runtime = bridge as unknown as { noteCommandCatalogue(...args: unknown[]): Promise<void> | undefined }
      const note = vi.spyOn(runtime, 'noteCommandCatalogue')
      const remember = vi.spyOn(commandCache.CommandCache.prototype, 'remember')
      const reporting = bridge.prompt(sessionId, 'plan', rid())
      try {
        await waiting
        if (change === 'command') currentBin = bins[1]!
        else await writeFile(join(fixture.workspace, 'opencode.json'), '{}')
        expect(await bridge.commandCatalogue!(context)).toBeUndefined()
        release()
        await reporting
        await Promise.all(note.mock.results.map(result => result.value))
        expect(remember).not.toHaveBeenCalled()
        await settled(bridge, sessionId)
      } finally {
        release()
        await reporting.catch(() => {})
        await Promise.allSettled(note.mock.results.map(result => Promise.resolve(result.value)))
        remember.mockRestore()
        note.mockRestore()
        spy.mockRestore()
      }
    },
  )

  it('separates project IDs and actual directory identities even when launch hashes are equal', async () => {
    const fixture = await setup()
    const other = join(fixture.root, 'other')
    await mkdir(other)
    const bridge = await fixture.open(() => [fixture.workspace, other])
    const a = { cwd: fixture.workspace, workspaceId: 'project-a' }
    const b = { cwd: fixture.workspace, workspaceId: 'project-b' }
    expect((await bridge.launchPreview!(a)).launchHash).toBe((await bridge.launchPreview!(b)).launchHash)
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...a })
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect(await bridge.commandCatalogue?.(a)).toMatchObject({ sourceSessionId: sessionId }))
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
    expect(await bridge.commandCatalogue?.(b)).toBeUndefined()
    expect(await bridge.commandCatalogue?.({ ...a, cwd: other })).toBeUndefined()
    await rename(fixture.workspace, join(fixture.root, 'replaced-workspace'))
    await mkdir(fixture.workspace)
    expect(await bridge.commandCatalogue?.(a)).toBeUndefined()
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(starts)
  })

  it('preserves an empty report and removes a deleted source without reading a new CLI', async () => {
    const fixture = await setup({ FAKE_ACP_COMMANDS: '[]' })
    const bridge = await fixture.open()
    const context = { cwd: fixture.workspace }
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
    await settled(bridge, sessionId)
    await vi.waitFor(async () =>
      expect(await bridge.commandCatalogue?.(context)).toMatchObject({
        sourceSessionId: sessionId,
        catalogue: { commands: [] },
      }),
    )
    await bridge.remove!(sessionId)
    expect(await bridge.commandCatalogue?.(context)).toBeUndefined()
    await bridge.close()
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
    const restored = await fixture.open()
    expect(await restored.commandCatalogue?.(context)).toBeUndefined()
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(starts)
  })

  it('rejects a previous definition without probing and treats mismatched stored source commands as a miss', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const context = { cwd: fixture.workspace }
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
    await settled(bridge, sessionId)
    await vi.waitFor(async () => expect(await bridge.commandCatalogue?.(context)).toMatchObject({ sourceSessionId: sessionId }))
    await bridge.close()
    const file = join(fixture.dataDir, 'harness-commands.json')
    const saved = JSON.parse(await readFile(file, 'utf8')) as { entries: Array<{ commands: unknown[] }> }
    saved.entries[0]!.commands = [{ name: 'never-reported' }]
    await writeFile(file, JSON.stringify(saved), { mode: 0o600 })
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
    const mismatched = await fixture.open()
    expect(await mismatched.commandCatalogue?.(context)).toBeUndefined()
    await mismatched.close()
    const changed = await fixture.redefine({ env: { ...fixture.record.env, CACHE_DEFINITION_CHANGED: '1' } })
    expect(await changed.commandCatalogue?.(context)).toBeUndefined()
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(starts)
  })

  it('does not launch a probe and keeps a reported catalogue across a Host restart', async () => {
    const fixture = await setup({ FAKE_ACP_COMMANDS: JSON.stringify([{ name: 'public-plan', description: 'Public plan' }]) })
    const bridge = await fixture.open()
    const context = { cwd: fixture.workspace }
    expect(await bridge.commandCatalogue?.(context)).toBeUndefined()
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(0)
    const { sessionId } = await bridge.createTask({ prompt: 'plan', requestId: rid(), ...context })
    await settled(bridge, sessionId)
    expect((await bridge.detail(sessionId)).commands).toEqual([{ name: 'public-plan', description: 'Public plan' }])
    await vi.waitFor(async () =>
      expect(await bridge.commandCatalogue?.(context)).toMatchObject({
        sourceSessionId: sessionId,
        catalogue: { source: 'previous-session', commands: [{ name: 'public-plan', description: 'Public plan' }] },
      }),
    )
    const starts = (await fixture.log()).filter(entry => entry.event === 'start').length
    await bridge.close()
    const restored = await fixture.open()
    expect(await restored.commandCatalogue?.(context)).toMatchObject({ sourceSessionId: sessionId })
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(starts)
  })
})

describe('agent context', () => {
  const brief = {
    segments: [
      { source: 'latch' as const, text: '这是用户为「代码审阅」写的指令，第一轮发给 Fake。' },
      { source: 'user' as const, text: 'ONLY REVIEW' },
    ],
  }
  const skills = [{ id: 'plugin:list', name: '审阅清单', description: '逐项检查', content: 'SKILL BODY' }]
  const context = (extra = {}) => ({
    agent: { customAgentId: `agt_${randomUUID()}` },
    instructions: '',
    brief,
    revision: 'a'.repeat(64),
    ...extra,
  })

  it('sends the block once with the first turn, shows it on that message, and leaves the text alone', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const agentContext = context()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hello', requestId: rid(), agentContext })
    await settled(bridge, sessionId)
    const prompt = received(await fixture.log(), 'session/prompt')[0]!
    expect((prompt.params as { prompt: unknown[] }).prompt).toEqual([
      { type: 'text', text: '这是用户为「代码审阅」写的指令，第一轮发给 Fake。\nONLY REVIEW' },
      { type: 'text', text: 'echo hello' },
    ])
    const detail = await bridge.detail(sessionId)
    expect(detail.messages[0]).toMatchObject({ text: 'echo hello', agentBrief: brief })
    expect(detail.summary.agent).toEqual(agentContext.agent)
    await bridge.prompt(sessionId, 'echo again', rid(), {})
    await settled(bridge, sessionId)
    const second = received(await fixture.log(), 'session/prompt')[1]!
    expect((second.params as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: 'echo again' }])
    expect((await bridge.detail(sessionId)).messages.filter(message => message.agentBrief)).toHaveLength(1)
    await bridge.close()
    const restored = await fixture.open()
    expect((await restored.detail(sessionId)).summary.agent).toEqual(agentContext.agent)
  })

  it('passes the authoring guide as a separate ACP block only in a creation session, including after reopening it', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'load' })
    const bridge = await fixture.open()
    const input = { prompt: 'echo one', requestId: rid() }
    const { sessionId } = await bridge.createTask({ ...input, pluginCreation: true })
    await settled(bridge, sessionId)
    const prompts = () =>
      fixture.log().then(log => received(log, 'session/prompt').map(entry => (entry.params as { prompt: unknown[] }).prompt))
    const guide = { type: 'text', text: expect.stringContaining('latch-authoring/SKILL.md') }
    expect((await prompts())[0]).toEqual([guide, { type: 'text', text: input.prompt }])
    expect((await bridge.detail(sessionId)).messages[0]?.text).toBe(input.prompt)
    await expect(bridge.createTask(input)).rejects.toMatchObject({ code: 'request-conflict' })
    await bridge.close()
    const restored = await fixture.open()
    await restored.prompt(sessionId, 'echo two', rid())
    await settled(restored, sessionId)
    expect((await prompts())[1]).toEqual([guide, { type: 'text', text: 'echo two' }])
    const normal = await restored.createTask({ prompt: 'echo ordinary', requestId: rid() })
    await settled(restored, normal.sessionId)
    expect((await prompts())[2]).toEqual([{ type: 'text', text: 'echo ordinary' }])
  })

  it('sends the digest note before the turn whenever it changed, once per context, and again after the context is cleared', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const note = (text: string) => ({
      key: createHash('sha256').update(text).digest('hex'),
      segments: [
        { source: 'latch' as const, text: '你最近做过的事：' },
        { source: 'material' as const, text },
      ],
    })
    const first = note('- 定时「晨报」完成')
    const agentContext = context({ brief: undefined, note: first })
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid(), agentContext })
    await settled(bridge, sessionId)
    const prompts = () =>
      fixture.log().then(log => received(log, 'session/prompt').map(entry => (entry.params as { prompt: unknown[] }).prompt))
    expect((await prompts())[0]).toEqual([
      { type: 'text', text: '你最近做过的事：\n- 定时「晨报」完成' },
      { type: 'text', text: 'echo one' },
    ])
    // The same note again: not repeated.
    const turn = { agent: agentContext.agent, instructions: '', revision: 'a'.repeat(64) }
    await bridge.prompt(sessionId, 'echo two', rid(), { agentContext: { ...turn, note: first } })
    await settled(bridge, sessionId)
    expect((await prompts())[1]).toEqual([{ type: 'text', text: 'echo two' }])
    // A new one goes with the next turn, and only the turn's text is the message.
    const second = note('- 定时「晨报」失败')
    await bridge.prompt(sessionId, 'echo three', rid(), { agentContext: { ...turn, note: second } })
    await settled(bridge, sessionId)
    expect((await prompts())[2]).toEqual([
      { type: 'text', text: '你最近做过的事：\n- 定时「晨报」失败' },
      { type: 'text', text: 'echo three' },
    ])
    expect((await bridge.detail(sessionId)).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([
      'echo one',
      'echo two',
      'echo three',
    ])
    // Another Agent's note never lands on this session.
    await bridge.prompt(sessionId, 'echo four', rid(), {
      agentContext: { ...turn, agent: { customAgentId: `agt_${randomUUID()}` }, note: note('别人的') },
    })
    await settled(bridge, sessionId)
    expect((await prompts())[3]).toEqual([{ type: 'text', text: 'echo four' }])
  })

  it('keeps the block for the first turn that reaches the engine, across a restart, and only then records it', async () => {
    const fixture = await setup({ FAKE_ACP_SLOW_SETUP: '300' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo first', requestId: rid(), agentContext: context() })
    expect(await bridge.cancel(sessionId)).toBe(true)
    await settled(bridge, sessionId)
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
    const stopped = await bridge.detail(sessionId)
    expect(stopped.messages.filter(message => message.agentBrief)).toHaveLength(0)
    await bridge.close()
    const restored = await fixture.open()
    await restored.prompt(sessionId, 'echo second', rid(), {})
    await settled(restored, sessionId)
    const sent = received(await fixture.log(), 'session/prompt')
    expect(sent).toHaveLength(1)
    expect((sent[0]!.params as { prompt: unknown[] }).prompt).toEqual([
      { type: 'text', text: '这是用户为「代码审阅」写的指令，第一轮发给 Fake。\nONLY REVIEW' },
      { type: 'text', text: 'echo second' },
    ])
    const users = (await restored.detail(sessionId)).messages.filter(message => message.role === 'user')
    expect(users.map(message => message.agentBrief)).toEqual([undefined, brief])
    await restored.prompt(sessionId, 'echo third', rid(), {})
    await settled(restored, sessionId)
    expect((received(await fixture.log(), 'session/prompt')[1]!.params as { prompt: unknown[] }).prompt).toEqual([
      { type: 'text', text: 'echo third' },
    ])
  })

  it('attaches a read-only skills server that lists and reads exactly the given skills, and removes it with the session', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), agentContext: context({ skillBodies: skills }) })
    await settled(bridge, sessionId)
    const params = received(await fixture.log(), 'session/new')[0]!.params as {
      mcpServers: Array<{ name: string; command: string; args: string[]; env: unknown[] }>
    }
    const server = params.mcpServers[0]!
    expect(server).toMatchObject({ name: 'latch-skills', command: process.execPath, env: [] })
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>)
        buffer = buffer.slice(end + 1)
      }
    })
    const ask = async (id: number, method: string, params?: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      await vi.waitFor(() => expect(lines.some(line => line.id === id)).toBe(true))
      return lines.find(line => line.id === id)!
    }
    expect((await ask(1, 'initialize', { protocolVersion: '2025-06-18' })).result).toMatchObject({ capabilities: { tools: {} } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const listed = (await ask(2, 'tools/list')).result as { tools: Array<{ name: string }> }
    expect(listed.tools.map(tool => tool.name)).toEqual(['list_skills', 'read_skill'])
    const names = (await ask(3, 'tools/call', { name: 'list_skills', arguments: {} })).result as { content: Array<{ text: string }> }
    expect(JSON.parse(names.content[0]!.text)).toEqual([{ id: 'plugin:list', name: '审阅清单', description: '逐项检查' }])
    expect(JSON.stringify((await ask(4, 'tools/call', { name: 'read_skill', arguments: { id: 'plugin:list' } })).result)).toContain(
      'SKILL BODY',
    )
    expect((await ask(5, 'tools/call', { name: 'read_skill', arguments: { id: 'x' } })).result).toMatchObject({ isError: true })
    expect((await ask(6, 'tools/call', { name: 'write_file', arguments: {} })).error).toMatchObject({ code: -32602 })
    expect((await ask(7, 'resources/list')).error).toMatchObject({ code: -32601 })
    child.stdin.end()
    await once(child, 'exit')
    await bridge.remove!(sessionId)
    await expect(stat(server.args.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('gives DeepSeek Harness the skills server, which it starts and lists before each session it opens or resumes', async () => {
    const fixture = await preset('dsh', {
      FAKE_ACP_PROCESS_MODE: '1',
      FAKE_ACP_MCP: 'dsh',
      FAKE_ACP_CAPS: 'resume',
      FAKE_ACP_DUMP_ENV: '1',
    })
    expect(fixture.driver.skills).toBe('server')
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), agentContext: context({ skillBodies: skills }) })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    await bridge.prompt(sessionId, 'skills', rid(), {})
    const listed = '[{"id":"plugin:list","name":"审阅清单","description":"逐项检查"}]'
    expect((await settled(bridge, sessionId)).messages.at(-1)).toMatchObject({ role: 'assistant', text: `latch-skills: ${listed}` })
    const mounted = { event: 'mcp-mounted', name: 'latch-skills', protocolVersion: '2025-11-25' }
    expect((await fixture.log()).filter(entry => entry.event.startsWith('mcp-'))).toEqual([
      expect.objectContaining({ ...mounted, tools: ['list_skills', 'read_skill'] }),
    ])
    const env = (await fixture.log()).find(entry => entry.event === 'env')!.env as Record<string, string>
    expect([env.DSH_PERMISSION_MODE, env.DSH_TELEMETRY_DISABLED]).toEqual(['read-only', '1'])

    await bridge.close()
    const restored = await fixture.open()
    await restored.prompt(sessionId, 'skills', rid(), {})
    expect((await settled(restored, sessionId)).messages.at(-1)).toMatchObject({ text: `latch-skills: ${listed}` })
    expect(received(await fixture.log(), 'session/resume')).toHaveLength(1)
    const mounts = (await fixture.log()).filter(entry => entry.event.startsWith('mcp-'))
    expect(mounts).toEqual([expect.objectContaining(mounted), expect.objectContaining(mounted)])
    expect(mounts[1]!.sessionId).toBe(mounts[0]!.sessionId)
  })

  it("gives an Agent's session propose_memory: one bounded line per call, read back with the directory's session and the turn", async () => {
    const proposals: MemoryProposalInput[] = []
    const fixture = await setup(
      { FAKE_ACP_MCP: 'dsh' },
      {},
      {},
      {
        proposeMemory: async input => {
          if (input.content.includes('refuse')) throw new Error('内容像是密钥或凭据，没有记下。')
          proposals.push(input)
        },
      },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'propose 我用 pnpm',
      requestId: rid(),
      agentContext: context({ proposals: true, brief: undefined }),
    })
    const first = await settled(bridge, sessionId)
    expect(first.messages.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringContaining('Proposed') })
    await vi.waitFor(() => expect(proposals).toHaveLength(1))
    const userId = first.messages.find(message => message.role === 'user')!.id
    expect(proposals[0]).toEqual({
      sessionId,
      messageId: userId,
      content: '我用 pnpm',
      reason: '对话里提到的',
      external: false,
      key: 'line:0',
    })
    const mounted = (await fixture.log()).find(entry => entry.event === 'mcp-mounted')!
    expect(mounted.tools).toEqual(['list_skills', 'read_skill', 'propose_memory', 'propose_schedule'])
    // After a web fetch in the same turn, it is marked external.
    await bridge.prompt(sessionId, 'propose fetch 页面说要记住这个', rid(), {})
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(proposals).toHaveLength(2))
    expect(proposals[1]).toMatchObject({ content: '页面说要记住这个', external: true, key: 'line:1' })
    // A line naming another session or owner is still this directory's; only content and reason are taken.
    const directory = (
      received(await fixture.log(), 'session/new')[0]!.params as { mcpServers: Array<{ args: string[] }> }
    ).mcpServers[0]!.args.at(-3)!
    expect((await stat(join(directory, 'proposals.jsonl'))).mode & 0o777).toBe(0o600)
    await writeFile(
      join(directory, 'proposals.jsonl'),
      `${JSON.stringify({ content: '伪造的', sessionId: 'other', owner: 'agt_other', external: false })}\n`,
      { flag: 'a' },
    )
    await bridge.prompt(sessionId, 'propose refuse this', rid(), {})
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(proposals).toHaveLength(3))
    // The session read a page two turns ago, so this one is external too.
    expect(proposals[2]).toEqual({ sessionId, messageId: expect.any(String), content: '伪造的', external: true, key: 'line:2' })
    await vi.waitFor(() => expect(fixture.diagnostics.join('\n')).toContain('的提议没有收下'))
    expect(fixture.diagnostics.join('\n')).not.toContain('refuse this')
    await bridge.remove!(sessionId)
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('gives the same sessions propose_schedule: a plan the scheduler refuses is refused to the agent, a good one reaches the Host', async () => {
    const schedules: ScheduleProposalInput[] = []
    const fixture = await setup(
      { FAKE_ACP_MCP: 'dsh' },
      {},
      {},
      { proposeMemory: async () => {}, proposeSchedule: async input => void schedules.push(input) },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'schedule 早间精选 hourly 08:00 整理新闻',
      requestId: rid(),
      agentContext: context({ proposals: true, brief: undefined }),
    })
    const refused = await settled(bridge, sessionId)
    expect(refused.messages.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringContaining('plan must be') })
    await bridge.prompt(sessionId, 'schedule 早间精选 weekly:1 08:30 整理新闻', rid(), {})
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(schedules).toHaveLength(1))
    expect(schedules[0]).toEqual({
      sessionId,
      messageId: expect.any(String),
      name: '早间精选',
      plan: { kind: 'weekly', day: 1, time: '08:30' },
      prompt: '整理新闻',
      external: false,
      key: 'line:0',
    })
    const directory = (
      received(await fixture.log(), 'session/new')[0]!.params as { mcpServers: Array<{ args: string[] }> }
    ).mcpServers[0]!.args.at(-3)!
    // A schedule line takes only its name, plan and prompt; the Host checks the plan again.
    await writeFile(
      join(directory, 'proposals.jsonl'),
      `${JSON.stringify({ kind: 'schedule', name: '伪造', plan: 'often', prompt: 'x', owner: 'other' })}\n`,
      {
        flag: 'a',
      },
    )
    const all = await readProposals(directory, { line: 0, offset: 0 })
    expect(all.lines.at(-1)).toEqual({ index: 1, kind: 'schedule', name: '伪造', plan: 'often', prompt: 'x' })
  })

  it('reads the proposals file only as a private regular file, from where it stopped, and never a line still being written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-proposals-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'proposals.jsonl')
    const start = { line: 0, offset: 0 }
    // A FIFO, a symlink and a second link are refused without blocking.
    expect(spawnSync('mkfifo', [file]).status).toBe(0)
    expect(await readProposals(directory, start)).toEqual({ lines: [], next: start, skipped: [] })
    await rm(file)
    const elsewhere = join(directory, 'elsewhere.jsonl')
    await writeFile(elsewhere, '{"content":"via a link"}\n', { mode: 0o600 })
    await symlink(elsewhere, file)
    expect((await readProposals(directory, start)).lines).toEqual([])
    await rm(file)
    await link(elsewhere, file)
    expect((await readProposals(directory, start)).lines).toEqual([])
    await rm(file)
    await rm(elsewhere)
    // A line still being written waits; the next read goes on from the stored offset; a bad line is skipped by kind.
    await writeFile(file, '{"content":"one"}\nnot json\n{"content":"bell\\u0007"}\n{"content":"tw', { mode: 0o600 })
    const first = await readProposals(directory, start)
    expect(first.lines.map(line => (line.kind === undefined ? line.content : line.kind === 'schedule' ? line.name : line.kind))).toEqual([
      'one',
    ])
    expect(first.skipped).toEqual(['not-json', 'invalid'])
    expect(first.next).toEqual({ line: 3, offset: Buffer.byteLength('{"content":"one"}\nnot json\n{"content":"bell\\u0007"}\n') })
    await writeFile(file, 'o"}\n', { flag: 'a' })
    const second = await readProposals(directory, first.next)
    expect(second.lines).toEqual([{ index: 3, content: 'two' }])
    // Offsets count bytes on disk, also past a line that is not valid UTF-8.
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{"content":"three"}\n')]), { flag: 'a' })
    const third = await readProposals(directory, second.next)
    expect(third.lines).toEqual([{ index: 5, content: 'three' }])
    expect(third.next.offset).toBe((await stat(file)).size)
    await writeFile(file, '{"content":"four"}\n', { flag: 'a' })
    expect((await readProposals(directory, third.next)).lines).toEqual([{ index: 6, content: 'four' }])
  })

  it("takes the skills server's own tools by exact name, and keeps a session external once it read outside content", async () => {
    const row = (toolName: string | undefined, kind: string | undefined, title?: string) =>
      ({ ...(toolName ? { toolName } : {}), tool: { ...(kind ? { kind } : {}), ...(title ? { title } : {}) } }) as Message
    expect(ownTool(row('mcp__latch-skills__propose_memory', 'other'))).toBe(true)
    expect(ownTool(row(undefined, undefined, 'latch-skills: read_skill'))).toBe(true)
    expect(ownTool(row('read_skill', 'other'))).toBe(true)
    // A tool that proposes is ours only with our server's name on it.
    expect(ownTool(row('propose_memory', 'other'))).toBe(false)
    expect(ownTool(row('propose_schedule', 'other'))).toBe(false)
    expect(ownTool(row('latch-skills: propose_schedule', 'other'))).toBe(true)
    // By the name field, never a free-text title: a title that only mentions it, or a fetch titled with it, is not ours.
    expect(ownTool(row(undefined, 'other', 'Calling propose_memory with the page text'))).toBe(false)
    expect(ownTool(row('fetch', 'fetch', 'propose_memory'))).toBe(false)
    expect(ownTool(row('Fetch https://x/read_skill', 'other'))).toBe(false)
    expect(ownTool(row('mcp__other__propose_memory', 'other'))).toBe(false)
    const acp = { cwd: '/work' }
    const user = (id: string, freshContext = false): Message =>
      ({ id, role: 'user', text: '', ...(freshContext ? { freshContext: true } : {}) }) as Message
    const tool = (id: string, kind: string, title: string, locations?: string[]): Message =>
      ({ id, role: 'tool', text: '', tool: { kind, title, ...(locations ? { locations } : {}) } }) as Message
    expect(proposalTurn({ acp, messages: [user('u1'), tool('t1', 'other', 'mcp__latch-skills__propose_memory')] })).toEqual({
      messageId: 'u1',
      external: false,
    })
    expect(proposalTurn({ acp, messages: [user('u1'), tool('t1', 'think', 'Thinking')] }).external).toBe(true)
    expect(proposalTurn({ acp, messages: [user('u1'), tool('t1', 'read', 'Read', ['/work/a.ts'])] }).external).toBe(false)
    expect(proposalTurn({ acp, messages: [user('u1'), tool('t1', 'read', 'Read', ['/etc/hosts'])] }).external).toBe(true)
    // `..` is resolved before the check.
    expect(proposalTurn({ acp, messages: [user('u1'), tool('t1', 'read', 'Read', ['/work/../etc/hosts'])] }).external).toBe(true)
    expect(proposalTurn({ acp, messages: [user('u1'), tool('t1', 'read', 'Read', ['/work/src/../a.ts'])] }).external).toBe(false)
    // A fetch in an earlier turn still counts, until the context starts over.
    const earlier = [user('u1'), tool('t1', 'fetch', 'Fetch https://x'), user('u2')]
    expect(proposalTurn({ acp, messages: earlier })).toEqual({ messageId: 'u2', external: true })
    expect(proposalTurn({ acp, messages: [...earlier, user('u3', true)] })).toEqual({ messageId: 'u3', external: false })
    const material: Message = { ...user('u1'), agentBrief: { segments: [{ source: 'material', text: 'imported' }] } }
    expect(proposalTurn({ acp, messages: [material, user('u2')] })).toEqual({ messageId: 'u2', external: true })
    const fresh = user('u3', true)
    expect(proposalTurn({ acp, messages: [material, fresh] })).toEqual({ messageId: 'u3', external: false })
    expect(proposalTurn({ acp, messages: [material, { ...fresh, agentBrief: material.agentBrief! }] })).toEqual({
      messageId: 'u3',
      external: true,
    })

    // A turn during which the agent fetched an MCP prompt read outside content, until the context starts over.
    const prompted: Message = { ...user('p1'), origin: 'mcp-prompt' }
    expect(proposalTurn({ acp, messages: [prompted] })).toEqual({ messageId: 'p1', external: true })
    expect(proposalTurn({ acp, messages: [prompted, user('p2')] })).toEqual({ messageId: 'p2', external: true })
    expect(proposalTurn({ acp, messages: [prompted, user('p3', true)] })).toEqual({ messageId: 'p3', external: false })
    // The Host's word that a prompt was fetched through a bridge, which no tool row shows.
    expect(proposalTurn({ acp: { ...acp, outsideRead: true }, messages: [user('b1')] })).toEqual({ messageId: 'b1', external: true })
    expect(proposalTurn({ acp, messages: [material, prompted, fresh] })).toEqual({ messageId: 'u3', external: false })
  })

  it('rejects marking MCP prompt provenance for a missing session', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    await expect(bridge.markOutsideContent!('missing')).rejects.toMatchObject({ code: 'task-not-found' })
  })

  it('marks a proposal external when the turn before read a page', async () => {
    const proposals: MemoryProposalInput[] = []
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { proposeMemory: async input => void proposals.push(input) })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'fetch',
      requestId: rid(),
      agentContext: context({ proposals: true, brief: undefined }),
    })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'propose 页面上说的', rid(), {})
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(proposals).toEqual([expect.objectContaining({ content: '页面上说的', external: true })]))
  })

  it('marks proposals external once the Host says a prompt entered the context, until the context starts over', async () => {
    const proposals: MemoryProposalInput[] = []
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { proposeMemory: async input => void proposals.push(input) })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo hi',
      requestId: rid(),
      agentContext: context({ proposals: true, brief: undefined }),
    })
    await settled(bridge, sessionId)
    await bridge.markOutsideContent!(sessionId)
    // No turn was running: no message is marked, the session is.
    expect((await bridge.detail(sessionId)).messages.some(message => message.origin)).toBe(false)
    await bridge.prompt(sessionId, 'propose 提示里说的', rid(), {})
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(proposals).toEqual([expect.objectContaining({ content: '提示里说的', external: true })]))
  })

  it("empties the proposals file before the session's servers start again once every line was taken, and keeps counting", async () => {
    const proposals: MemoryProposalInput[] = []
    const fixture = await setup(
      { FAKE_ACP_MCP: 'dsh', FAKE_ACP_CAPS: 'resume' },
      {},
      {},
      { proposeMemory: async input => void proposals.push(input) },
    )
    const bridge = await fixture.open()
    const agentContext = context({ proposals: true, brief: undefined })
    const { sessionId } = await bridge.createTask({ prompt: 'propose 第一条', requestId: rid(), agentContext })
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(proposals).toHaveLength(1))
    const directory = (
      received(await fixture.log(), 'session/new')[0]!.params as { mcpServers: Array<{ args: string[] }> }
    ).mcpServers[0]!.args.at(-3)!
    expect(await readFile(join(directory, 'proposals.jsonl'), 'utf8')).toContain('第一条')
    await bridge.close()
    const restored = await fixture.open()
    await restored.prompt(sessionId, 'propose 第二条', rid(), {})
    await settled(restored, sessionId)
    await vi.waitFor(() => expect(proposals).toHaveLength(2))
    const text = await readFile(join(directory, 'proposals.jsonl'), 'utf8')
    expect(text).not.toContain('第一条')
    expect(proposals[1]).toMatchObject({ content: '第二条', key: 'line:1' })
    const args = (
      received(await fixture.log(), 'session/load').concat(received(await fixture.log(), 'session/resume'))[0]!.params as {
        mcpServers: Array<{ args: string[] }>
      }
    ).mcpServers[0]!.args
    expect(args.slice(-2)).toEqual(['propose', '1'])
  })

  it('marks everything a scheduled run proposes external', async () => {
    const proposals: MemoryProposalInput[] = []
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { proposeMemory: async input => void proposals.push(input) })
    const bridge = await fixture.open()
    const agentContext = context({ proposals: true, unattended: true, brief: undefined })
    const { sessionId } = await bridge.createTask({ prompt: 'propose 每周一汇总', requestId: rid(), agentContext })
    await settled(bridge, sessionId)
    await vi.waitFor(() => expect(proposals).toEqual([expect.objectContaining({ content: '每周一汇总', external: true })]))
  })

  it('the skills server refuses proposals past its limits, over stdio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-propose-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, 'skills.json'), '[]')
    const plain = skillsServer(directory)
    expect(plain.args).not.toContain('propose')
    const server = skillsServer(directory, true)
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>)
        buffer = buffer.slice(end + 1)
      }
    })
    let next = 1
    const ask = async (method: string, params?: unknown) => {
      const id = next++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      await vi.waitFor(() => expect(lines.some(line => line.id === id)).toBe(true))
      return lines.find(line => line.id === id)!
    }
    await ask('initialize', { protocolVersion: '2025-06-18' })
    const listed = (await ask('tools/list')).result as { tools: Array<{ name: string }> }
    expect(listed.tools.map(tool => tool.name)).toEqual(['list_skills', 'read_skill', 'propose_memory', 'propose_schedule'])
    const propose = (args: unknown) => ask('tools/call', { name: 'propose_memory', arguments: args })
    expect((await propose({ content: '' })).result).toMatchObject({ isError: true })
    expect((await propose({ content: 'x'.repeat(4001) })).result).toMatchObject({ isError: true })
    // A whole 4000-character proposal in CJK text fits one line; the board's tools are not offered without `board`.
    expect(listed.tools.map(tool => tool.name)).not.toContain('propose_todo')
    for (let index = 0; index < PROPOSAL_LIMITS.count; index++)
      expect((await propose({ content: `第 ${index} 条`, extra: 'ignored' })).result).not.toMatchObject({ isError: true })
    expect((await propose({ content: '再一条' })).result).toMatchObject({ isError: true })
    child.stdin.end()
    await once(child, 'exit')
    const read = await readProposals(directory, { line: 30, offset: 0 })
    expect(read.lines.map(line => line.index)).toEqual([30, 31])
    expect(read.lines[0]).toMatchObject({ content: '第 0 条' })
    const all = await readProposals(directory, { line: 0, offset: 0 })
    expect(all.next.line).toBe(PROPOSAL_LIMITS.count)
    expect(await readProposals(directory, all.next)).toEqual({ lines: [], next: all.next, skipped: [] })
  })

  it('the skills server with team lists its tools only while the roster is there, says so when it changes, and answers a round', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-team-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, 'skills.json'), '[]')
    const server = skillsServer(directory, false, 0, true, 2_000, { roundsTaken: 3 })
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>)
        buffer = buffer.slice(end + 1)
      }
    })
    let next = 1
    const ask = async (method: string, params?: unknown) => {
      const id = next++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      await vi.waitFor(() => expect(lines.some(line => line.id === id)).toBe(true), { timeout: 5_000 })
      return lines.find(line => line.id === id)!
    }
    const started = await ask('initialize', { protocolVersion: '2025-06-18' })
    expect(started.result).toMatchObject({ capabilities: { tools: { listChanged: true } } })
    const names = async () => ((await ask('tools/list')).result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)
    expect(await names()).not.toContain('send_to_members')
    const call = (name: string, args: unknown) => ask('tools/call', { name, arguments: args })
    expect((await call('send_to_members', { sends: [{ member: 'm1', prompt: 'x' }] })).result).toMatchObject({ isError: true })

    await writeTeamRoster(directory, { members: [{ id: 'm1', name: '一', title: '一', harness: 'Alpha', state: 'done' }], open: false })
    expect((await stat(join(directory, TEAM_FILE))).mode & 0o777).toBe(0o600)
    await vi.waitFor(() => expect(lines.some(line => line.method === 'notifications/tools/list_changed')).toBe(true), { timeout: 5_000 })
    expect(await names()).toEqual(expect.arrayContaining(['list_members', 'send_to_members']))
    expect(JSON.stringify((await call('list_members', {})).result)).toContain('\\"open\\":false')
    expect((await call('send_to_members', { sends: [{ member: 'x1', prompt: 'x' }] })).result).toMatchObject({ isError: true })
    expect((await call('send_to_members', { sends: [{ member: 'm1', prompt: '' }] })).result).toMatchObject({ isError: true })

    // A round waits for the Host's word, by its first line, which goes on from the lines taken before.
    const asked = ask('tools/call', {
      name: 'send_to_members',
      arguments: {
        sends: [
          { member: 'm1', prompt: '做甲' },
          { member: 'm2', prompt: '做乙' },
        ],
      },
    })
    let read: Awaited<ReturnType<typeof readRounds>> | undefined
    await vi.waitFor(async () => {
      read = await readRounds(directory, { line: 3, offset: 0 })
      expect(read.calls).toHaveLength(1)
    })
    expect(read!.calls[0]).toEqual({
      first: 3,
      sends: [
        { member: 'm1', prompt: '做甲' },
        { member: 'm2', prompt: '做乙' },
      ],
    })
    await writeRoundAnswer(directory, 3, true, 'Sent as round 2.')
    expect((await asked).result).toEqual({ content: [{ type: 'text', text: 'Sent as round 2.' }] })

    await writeTeamRoster(directory, undefined)
    await vi.waitFor(async () => expect(await names()).not.toContain('list_members'), { timeout: 5_000 })
    child.stdin.end()
    await once(child, 'exit')
  })

  it('the skills server with board offers only the board tools, refuses priority and extra fields, and writes a group as lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-board-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, 'skills.json'), '[]')
    // No driver answers here: a short wait, after which the server says it was written.
    const server = skillsServer(directory, false, 0, true, 50)
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        lines.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>)
        buffer = buffer.slice(end + 1)
      }
    })
    let next = 1
    const ask = async (method: string, params?: unknown) => {
      const id = next++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      await vi.waitFor(() => expect(lines.some(line => line.id === id)).toBe(true))
      return lines.find(line => line.id === id)!
    }
    await ask('initialize', { protocolVersion: '2025-06-18' })
    const listed = (await ask('tools/list')).result as { tools: Array<{ name: string; description: string }> }
    expect(listed.tools.map(tool => tool.name)).toEqual(['list_skills', 'read_skill', 'propose_todo', 'propose_todos', 'propose_card'])
    // The guidance travels in the tool's own description.
    expect(listed.tools.find(tool => tool.name === 'propose_todo')!.description).toContain('nothing starts, until the user accepts')
    const call = (name: string, args: unknown) => ask('tools/call', { name, arguments: args })
    expect((await call('propose_memory', { content: 'x' })).error).toBeDefined()
    expect((await call('propose_todo', { title: 'x', prompt: 'y', priority: 'high' })).result).toMatchObject({ isError: true })
    expect((await call('propose_card', { target: 'session', priority: 'high' })).result).toMatchObject({ isError: true })
    expect((await call('propose_card', { target: 'other', note: 'x' })).result).toMatchObject({ isError: true })
    expect((await call('propose_todo', { title: '一行\n两行', prompt: 'y' })).result).toMatchObject({ isError: true })
    expect((await call('propose_todo', { title: '加一节', prompt: '一'.repeat(4000), tags: ['文档'] })).result).not.toMatchObject({
      isError: true,
    })
    const items = [
      { title: '甲', prompt: '做甲' },
      { title: '乙', prompt: '做乙' },
    ]
    expect((await call('propose_todos', { goal: '两步', items })).result).not.toMatchObject({ isError: true })
    expect((await call('propose_card', { target: 'todo', note: '还差文档' })).result).not.toMatchObject({ isError: true })
    // Tabs and CRLF stay in a 要求, as the Host keeps them; a format character is refused at once.
    expect((await call('propose_todo', { title: '缩进', prompt: 'run:\r\n\tpnpm test' })).result).not.toMatchObject({ isError: true })
    expect((await call('propose_todo', { title: '藏字', prompt: 'a\u200bb' })).result).toMatchObject({ isError: true })
    // With the driver's answers, the agent hears whether the board took it, and never why.
    await writeFile(
      join(directory, 'answers.jsonl'),
      `${JSON.stringify({ line: 5, ok: true })}\n${JSON.stringify({ line: 6, ok: false })}\n`,
      { mode: 0o600 },
    )
    const taken = (await call('propose_todo', { title: '再一条', prompt: 'p' })).result as { content: Array<{ text: string }> }
    expect(taken.content[0]!.text).toMatch(/^Proposed\./u)
    const refusedAnswer = (await call('propose_card', { target: 'session', note: 'n' })).result as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(refusedAnswer).toMatchObject({ isError: true })
    expect(refusedAnswer.content[0]!.text).not.toContain('n"')
    child.stdin.end()
    await once(child, 'exit')
    const read = await readProposals(directory, { line: 0, offset: 0 })
    expect(read.skipped).toEqual([])
    expect(read.lines.map(line => line.kind)).toEqual(['todo', 'todo', 'todo', 'card', 'todo', 'todo', 'card'])
    expect((read.lines[4] as Extract<(typeof read.lines)[number], { kind: 'todo' }>).todo.prompt).toBe('run:\r\n\tpnpm test')
    const [single, first, second] = read.lines as Array<Extract<(typeof read.lines)[number], { kind: 'todo' }>>
    expect(single!.todo).toEqual({ title: '加一节', prompt: '一'.repeat(4000), tags: ['文档'] })
    expect(first!.todo.group).toEqual({ label: second!.todo.group!.label, goal: '两步' })
    // A line naming priority is refused whole when the Host reads it, whoever wrote it.
    await writeFile(
      join(directory, 'proposals.jsonl'),
      `${JSON.stringify({ kind: 'todo', title: 'x', prompt: 'y', priority: 'high' })}\n`,
      { flag: 'a' },
    )
    expect((await readProposals(directory, read.next)).skipped).toEqual(['invalid'])
  })

  it('attaches no server without skills', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), agentContext: context() })
    await settled(bridge, sessionId)
    expect((received(await fixture.log(), 'session/new')[0]!.params as { mcpServers: unknown[] }).mcpServers).toEqual([])
  })
})

describe('what a Harness offers before a session, and choosing it before the first prompt', () => {
  const CODEX = {
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'read-only,workspace-write,agent-full-access',
    FAKE_ACP_INITIAL_MODE: 'workspace-write',
    FAKE_ACP_EFFORT_BY_MODEL: '1',
  }
  const values = (option: SessionConfigOption | undefined) => option?.options.map(item => item.value)
  const option = (options: readonly SessionConfigOption[] | undefined, id: string) => options?.find(item => item.id === id)
  const set = (log: LogEntry[]) =>
    received(log, 'session/set_config_option').map(entry => [entry.params?.configId, entry.params?.value] as const)

  it('keeps what new sessions offered, with thinking per model, across a restart, until the definition changes', async () => {
    const fixture = await preset('codex', CODEX)
    let bridge = await fixture.open()
    expect(bridge.catalogue!()).toBeUndefined()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    const first = bridge.catalogue!()!
    expect(values(option(first.options, 'model'))).toEqual(['small', 'large'])
    // The mode a new session is set to before its first prompt, not the one the agent happened to start in.
    expect(option(first.options, 'mode')).toMatchObject({ category: 'mode', currentValue: 'read-only' })
    expect(first.perModel).toEqual([{ model: 'small', options: [expect.objectContaining({ id: 'effort' })] }])
    expect(values(first.perModel[0]!.options[0])).toEqual(['low', 'high'])

    await bridge.setConfig!(sessionId, 'model', 'large')
    const second = bridge.catalogue!()!
    expect(second.perModel.map(entry => entry.model)).toEqual(['large', 'small'])
    expect(values(second.perModel[0]!.options[0])).toEqual(['low', 'high', 'max'])
    // The default the next draft opens on is still what a new session offers.
    expect(option(second.options, 'model')?.currentValue).toBe('small')

    await bridge.close()
    bridge = await fixture.open()
    expect(bridge.catalogue!()).toEqual(second)
    await bridge.close()
    const changed = await fixture.redefine({ env: { ...fixture.record.env, EXTRA: '1' } })
    expect(changed.catalogue!()).toBeUndefined()
  })

  it('sets the model, then what it offers, then the mode, and reads each back before the first prompt', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_INITIAL_MODE: 'read-only' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo hi',
      requestId: rid(),
      config: [
        { configId: 'mode', value: 'workspace-write' },
        { configId: 'effort', value: 'max' },
        { configId: 'model', value: 'large' },
      ],
    })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    const log = await fixture.log()
    // Max exists only on the large model, so it can only be set after it; the mode is set last.
    expect(set(log)).toEqual([
      ['model', 'large'],
      ['effort', 'max'],
      ['mode', 'workspace-write'],
    ])
    const order = log.filter(entry => entry.event === 'recv').map(entry => entry.method)
    expect(order.lastIndexOf('session/set_config_option')).toBeLessThan(order.indexOf('session/prompt'))
    expect(detail.config?.map(item => [item.id, item.currentValue])).toEqual([
      ['mode', 'workspace-write'],
      ['model', 'large'],
      ['effort', 'max'],
    ])
    expect(detail.permission?.expectedMode).toBe('workspace-write')
    expect(detail.messages.filter(message => message.role === 'system')).toEqual([])
  })

  it.each(['read-only', 'workspace-write'])(
    'keeps the later %s choice instead of a wide draft after another start option times out',
    async value => {
      const answerDir = await mkdtemp(join(tmpdir(), 'latch-start-answer-'))
      cleanups.push(() => rm(answerDir, { recursive: true, force: true }))
      const answerFile = join(answerDir, 'answer')
      await writeFile(answerFile, 'silent-drop')
      const fixture = await preset(
        'codex',
        {
          ...CODEX,
          FAKE_ACP_INITIAL_MODE: 'read-only',
          FAKE_ACP_CAPS: 'resume',
          FAKE_ACP_CONFIG_ANSWER_FILE: answerFile,
        },
        { idleMs: 60_000 },
      )
      const bridge = await fixture.open()
      // Give only the unanswered write a short deadline. Handshake and recovery still use the regular fixture timeouts.
      const request = AcpWire.prototype.request
      const deadline = vi.spyOn(AcpWire.prototype, 'request').mockImplementation(function (this: AcpWire, ...args) {
        const [method, params] = args
        if (method === 'session/set_config_option' && isRecord(params) && params.configId === 'effort' && params.value === 'high')
          args[2] = 150
        return request.apply(this, args)
      })
      cleanups.push(() => void deadline.mockRestore())
      const { sessionId } = await bridge.createTask({
        prompt: 'echo first',
        requestId: rid(),
        config: [
          { configId: 'effort', value: 'high' },
          { configId: LADDER_MODE, value: 'agent-full-access' },
        ],
      })
      expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
      await vi.waitFor(async () => {
        const log = await fixture.log()
        const unanswered = received(log, 'session/set_config_option').find(entry => entry.params?.configId === 'effort')
        expect(unanswered?.params?.value).toBe('high')
        expect(unanswered?.id).toEqual(expect.any(Number))
        expect(received(log, '$/cancel_request')).toContainEqual(expect.objectContaining({ params: { requestId: unanswered?.id } }))
        expect(received(log, 'session/prompt')).toHaveLength(0)
      })
      deadline.mockRestore()
      await writeFile(answerFile, '')
      await bridge.setConfig!(sessionId, 'mode', value)
      const selected = await bridge.detail(sessionId)
      expect(selected.permission?.expectedMode).toBe(value)
      expect(selected.config?.find(item => item.category === 'mode')?.currentValue).toBe(value)

      await bridge.prompt(sessionId, 'echo retry', rid())
      const next = await settled(bridge, sessionId)
      expect(next.summary.status).toBe('idle')
      expect(next.permission?.expectedMode).toBe(value)
      expect(next.config?.find(item => item.category === 'mode')?.currentValue).toBe(value)
      const log = await fixture.log()
      expect(received(log, 'session/prompt')).toHaveLength(1)
      expect(set(log).some(([id, selected]) => id === 'mode' && selected === 'agent-full-access')).toBe(false)
    },
  )

  it('keeps a later process mode instead of the draft after another start option times out', async () => {
    const answerDir = await mkdtemp(join(tmpdir(), 'latch-start-process-answer-'))
    cleanups.push(() => rm(answerDir, { recursive: true, force: true }))
    const answerFile = join(answerDir, 'answer')
    await writeFile(answerFile, 'silent-drop')
    const fixture = await preset(
      'dsh',
      {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_PROCESS_MODE: '1',
        FAKE_ACP_CAPS: 'resume',
        FAKE_ACP_CONFIG_ANSWER_FILE: answerFile,
      },
      { idleMs: 60_000 },
    )
    const bridge = await fixture.open()
    const request = AcpWire.prototype.request
    const deadline = vi.spyOn(AcpWire.prototype, 'request').mockImplementation(function (this: AcpWire, ...args) {
      const [method, params] = args
      if (method === 'session/set_config_option' && isRecord(params) && params.configId === 'effort' && params.value === 'high')
        args[2] = 150
      return request.apply(this, args)
    })
    cleanups.push(() => void deadline.mockRestore())
    const { sessionId } = await bridge.createTask({
      prompt: 'echo first',
      requestId: rid(),
      config: [
        { configId: 'effort', value: 'high' },
        { configId: LADDER_MODE, value: 'danger-full-access' },
      ],
    })
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    await vi.waitFor(async () => {
      const log = await fixture.log()
      const unanswered = received(log, 'session/set_config_option').find(entry => entry.params?.configId === 'effort')
      expect(unanswered?.params?.value).toBe('high')
      expect(unanswered?.id).toEqual(expect.any(Number))
      expect(received(log, '$/cancel_request')).toContainEqual(expect.objectContaining({ params: { requestId: unanswered?.id } }))
      expect(received(log, 'session/prompt')).toHaveLength(0)
    })
    deadline.mockRestore()
    await writeFile(answerFile, '')
    await bridge.setConfig!(sessionId, 'mode', 'read-only')
    await bridge.close()
    const resumed = await fixture.open()
    await resumed.prompt(sessionId, 'echo retry', rid())
    const next = await settled(resumed, sessionId)
    expect(next.summary.status).toBe('idle')
    expect(next.permission?.expectedMode).toBe('read-only')
    expect(next.config?.find(item => item.category === 'mode')?.currentValue).toBe('read-only')
  })

  it('refuses the turn when the chosen model is gone, and the next send runs on the model the session shows', async () => {
    const fixture = await preset('codex', CODEX)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), config: [{ configId: 'model', value: 'gone' }] })
    const failed = await settled(bridge, sessionId)
    expect(failed.summary.status).toBe('failed')
    expect(failed.messages.at(-1)?.text).toContain(
      'Fake 现在没有模型「gone」，这条消息没有发出。再发送会用「Small」，也可以先在模型里换一个。',
    )
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
    expect(failed.config?.find(item => item.id === 'model')?.currentValue).toBe('small')

    await bridge.prompt(sessionId, 'echo again', rid())
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(1)
  })

  it('settles the rest of the draft when its model is gone, so the session shows what the next send runs on', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_MODELS: 'small', FAKE_ACP_INITIAL_MODE: 'agent-full-access' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo hi',
      requestId: rid(),
      config: [
        { configId: 'model', value: 'large' },
        { configId: 'effort', value: 'high' },
        { configId: 'mode', value: 'workspace-write' },
      ],
    })
    const failed = await settled(bridge, sessionId)
    expect(failed.summary.status).toBe('failed')
    expect(failed.messages.at(-1)?.text).toContain('Fake 现在没有模型「large」，这条消息没有发出。再发送会用「Small」')
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
    const shown = failed.config?.map(item => [item.id, item.currentValue])
    expect(shown).toEqual([
      ['mode', 'workspace-write'],
      ['model', 'small'],
      ['effort', 'high'],
    ])
    const writes = set(await fixture.log()).length

    await bridge.prompt(sessionId, 'echo again', rid())
    const done = await settled(bridge, sessionId)
    expect(done.summary.status).toBe('idle')
    expect(done.config?.map(item => [item.id, item.currentValue])).toEqual(shown)
    expect(set(await fixture.log())).toHaveLength(writes)
  })

  it("takes an option picked in the session in place of the draft's", async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_MODELS: 'small' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo hi',
      requestId: rid(),
      config: [
        { configId: 'model', value: 'large' },
        { configId: 'effort', value: 'high' },
      ],
    })
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    await bridge.setConfig!(sessionId, 'effort', 'low')
    await bridge.prompt(sessionId, 'echo again', rid())
    const done = await settled(bridge, sessionId)
    expect(done.summary.status).toBe('idle')
    expect(done.config?.find(item => item.id === 'effort')?.currentValue).toBe('low')
  })

  it('refuses the turn when the chosen mode is gone', async () => {
    const fixture = await preset('codex', CODEX)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), config: [{ configId: 'mode', value: 'yolo' }] })
    const failed = await settled(bridge, sessionId)
    expect(failed.summary.status).toBe('failed')
    expect(failed.messages.at(-1)?.text).toContain(
      'Fake 现在没有「yolo」这个权限模式，这条消息没有发出。再发送会用「read-only」，也可以先在权限里换一个。',
    )
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
    // The session shows the mode the next send runs in, not the one the agent happened to start in.
    expect(failed.config?.find(item => item.id === 'mode')?.currentValue).toBe('read-only')
  })

  it('refuses the first prompt when the chosen thinking is no longer offered', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_EFFORT_BY_MODEL: '0' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), config: [{ configId: 'effort', value: 'max' }] })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(detail.messages.find(message => message.role === 'system')?.text).toContain('这条消息没有发出')
    expect(set(await fixture.log()).filter(([id]) => id === 'effort')).toEqual([])
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
  })

  it('refuses the first prompt when the Agent acknowledges but does not take the chosen thinking', async () => {
    const fixture = await preset('codex', { ...CODEX, FAKE_ACP_IGNORE_CONFIG: 'effort' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), config: [{ configId: 'effort', value: 'high' }] })
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
  })

  it('takes a choice into the request the way it takes the prompt', async () => {
    const fixture = await preset('codex', CODEX)
    const bridge = await fixture.open()
    const requestId = rid()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId, config: [{ configId: 'model', value: 'large' }] })
    await expect(
      bridge.createTask({ prompt: 'echo hi', requestId, config: [{ configId: 'model', value: 'small' }] }),
    ).rejects.toMatchObject({
      code: 'request-conflict',
    })
    expect((await bridge.createTask({ prompt: 'echo hi', requestId, config: [{ configId: 'model', value: 'large' }] })).sessionId).toBe(
      sessionId,
    )
    await expect(
      bridge.createTask({
        prompt: 'echo hi',
        requestId: rid(),
        config: [
          { configId: 'model', value: 'large' },
          { configId: 'model', value: 'small' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'config-value-invalid' })
    await settled(bridge, sessionId)
  })
})

describe('reading what a Harness offers without a turn, and model IDs a person types', () => {
  const OPTIONS = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'delete' }
  const models = (catalogue: ReturnType<NonNullable<Bridge['catalogue']>>) =>
    catalogue?.options.find(option => option.category === 'model')?.options.map(item => item.value)

  it('takes Grok Build\u2019s models and thinking from its answer to initialize, without a session', async () => {
    const fixture = await preset('grok', { ...OPTIONS, FAKE_ACP_GROK_INIT: '1', FAKE_ACP_VERSION: '1.0.89' })
    const bridge = await fixture.open()
    expect(bridge.catalogueRead!()).toEqual({ when: 'select', modes: false })
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: true })
    const catalogue = bridge.catalogue!()!
    expect(models(catalogue)).toEqual(['small', 'large'])
    expect(catalogue.options.find(option => option.category === 'thought_level')).toMatchObject({
      id: 'reasoning_effort',
      currentValue: 'high',
    })
    expect(catalogue.perModel).toEqual([
      { model: 'small', options: [expect.objectContaining({ id: 'reasoning_effort' })] },
      { model: 'large', options: [] },
    ])
    const log = await fixture.log()
    expect(received(log, 'initialize')).toHaveLength(1)
    expect(received(log, 'session/new')).toEqual([])
    expect(received(log, 'session/prompt')).toEqual([])
    // Every model's thinking is known already: picking one opens nothing.
    await expect(bridge.readCatalogue!({ auto: false, model: 'large' })).rejects.toMatchObject({ code: 'catalogue-model-unsupported' })
  })

  it('opens one empty session in a private folder, sends no prompt and no MCP server, deletes it, and keeps the list', async () => {
    const fixture = await setup(OPTIONS)
    const bridge = await fixture.open()
    // An empty session reports the modes a session starts with, as well as its models.
    expect(bridge.catalogueRead!()).toEqual({ when: 'select', modes: true })
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: true })
    const catalogue = bridge.catalogue!()!
    expect(catalogue.source).toBe('check')
    expect(models(catalogue)).toEqual(['small', 'large'])
    expect(bridge.catalogueRead!()).toMatchObject({ when: 'select', last: { ok: true } })
    const log = await fixture.log()
    const opened = received(log, 'session/new')
    expect(opened).toHaveLength(1)
    const cwd = opened[0]!.params!.cwd as string
    expect(opened[0]!.params!.mcpServers).toEqual([])
    expect(cwd.startsWith(await realpath(fixture.tmpRoot))).toBe(true)
    expect(received(log, 'session/prompt')).toEqual([])
    expect(received(log, 'session/delete')).toHaveLength(1)
    expect(Object.keys(await fixture.agentSessions())).toEqual([])
    await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.waitFor(async () => expect((await fixture.log()).some(entry => entry.event === 'stdin-end')).toBe(true))

    // A selection never reads twice; a person can.
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: false })
    expect(await bridge.readCatalogue!({ auto: false })).toEqual({ ran: true })
    expect(received(await fixture.log(), 'session/new')).toHaveLength(2)
  })

  it('closes the session when the agent cannot delete it, and shares one read between requests', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'close,resume' })
    const bridge = await fixture.open()
    const [first, second] = await Promise.all([bridge.readCatalogue!({ auto: true }), bridge.readCatalogue!({ auto: false })])
    expect(first).toEqual({ ran: true })
    expect(second).toEqual({ ran: true })
    const log = await fixture.log()
    expect(received(log, 'session/new')).toHaveLength(1)
    expect(received(log, 'session/close')).toHaveLength(1)
  })

  it('keeps a failed read, says why, and a selection does not start the agent again', async () => {
    const fixture = await setup({ ...OPTIONS, FAKE_ACP_AUTH: 'new' })
    const bridge = await fixture.open()
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: true })
    expect(bridge.catalogue!()).toBeUndefined()
    // The agent's own error code says it is a login that is missing; a client does not read the words for it.
    expect(bridge.catalogueRead!()).toMatchObject({
      last: { ok: false, loginRequired: true, message: 'Fake 还没登录。按它自己的方式登录后重试。' },
    })
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: false })
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)
    await bridge.close()
    // Kept across a restart, and forgotten once the definition changes.
    const reopened = await fixture.open()
    expect(reopened.catalogueRead!()).toMatchObject({ last: { ok: false, loginRequired: true } })
    await reopened.close()
    expect((await fixture.redefine({ env: { ...fixture.record.env, EXTRA: '1' } })).catalogueRead!()).toEqual({
      when: 'select',
      modes: true,
    })
  })

  it('does not call a read that failed for another reason a missing login', async () => {
    const fixture = await setup({ ...OPTIONS, FAKE_ACP_INIT_ERROR: '1' })
    const bridge = await fixture.open()
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: true })
    const last = bridge.catalogueRead!()!.last!
    expect(last).toMatchObject({ ok: false, message: expect.stringContaining('provider rejected API key') })
    expect(last.loginRequired).toBeUndefined()
  })

  it('queues a different model behind the initial catalogue and shares only reads of the same model', async () => {
    const fixture = await setup({ ...OPTIONS, FAKE_ACP_EFFORT_BY_MODEL: '1' })
    const bridge = await fixture.open()
    const first = bridge.readCatalogue!({ auto: true })
    const large = bridge.readCatalogue!({ auto: true, model: 'large' })
    const repeated = bridge.readCatalogue!({ auto: true, model: 'large' })
    await Promise.all([first, large, repeated])
    const catalogue = bridge.catalogue!()!
    expect(catalogue.perModel.find(entry => entry.model === 'large')?.options[0]?.options.map(item => item.value)).toEqual([
      'low',
      'high',
      'max',
    ])
    const log = await fixture.log()
    expect(received(log, 'session/new')).toHaveLength(2)
    expect(received(log, 'session/prompt')).toHaveLength(0)
  })

  it("lists Codex's models through the adapter's own app-server, with no session or thread", async () => {
    const fixture = await preset('codex', { ...OPTIONS, FAKE_CODEX_MODEL: 'gpt-fake-mini' })
    const bridge = await fixture.open()
    // Codex's model list says nothing of its modes; those come with a session.
    expect(bridge.catalogueRead!()).toEqual({ when: 'select', modes: false })
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: true })
    const catalogue = bridge.catalogue!()!
    expect(catalogue.source).toBe('check')
    expect(models(catalogue)).toEqual(['gpt-fake', 'gpt-fake-mini'])
    const model = catalogue.options.find(option => option.id === 'model')!
    const effort = catalogue.options.find(option => option.id === 'reasoning_effort')!
    expect(model.currentValue).toBe('gpt-fake-mini')
    expect(effort).toMatchObject({ category: 'thought_level', currentValue: 'low' })
    expect(effort.options.map(item => item.value)).toEqual(['low', 'medium'])
    expect(catalogue.perModel.map(entry => [entry.model, entry.options[0]!.options.map(item => item.value)])).toEqual([
      ['gpt-fake', ['low', 'medium', 'high']],
      ['gpt-fake-mini', ['low', 'medium']],
    ])
    const log = await fixture.log()
    const started = log.filter(entry => entry.event === 'start')
    expect(started.map(entry => entry.argv)).toEqual([['cli', 'app-server']])
    expect(log.filter(entry => entry.event === 'recv').map(entry => entry.method)).toEqual(['initialize', 'config/read', 'model/list'])
    // The test Host finds no program of its own: the adapter is told of no Codex, so it can run none.
    expect(started[0]).toMatchObject({ codexPath: null })
    expect(fixture.record.command).toBe(process.execPath)
  })

  it('says why Codex listed nothing', async () => {
    // The definition's own values never reach the message, and this one names the error.
    const fixture = await preset('codex', { ...OPTIONS, FAKE_CODEX_LIST_ERROR: 'login' })
    const bridge = await fixture.open()
    await bridge.readCatalogue!({ auto: false })
    expect(bridge.catalogue!()).toBeUndefined()
    expect(bridge.catalogueRead!()!.last).toMatchObject({ ok: false, message: 'Fake 返回错误：login' })
  })

  it('sends a typed model the agent does not list, and fails the turn when the agent refuses it', async () => {
    const fixture = await setup({ ...OPTIONS, FAKE_ACP_STRICT_MODELS: '1' })
    const bridge = await fixture.open()
    await expect(bridge.setCustomModels!(['ok', 'two\nlines'])).rejects.toMatchObject({ code: 'model-id-invalid' })
    await bridge.setCustomModels!([' vendor/custom ', 'vendor/custom', 'other'])
    expect(bridge.customModels!()).toEqual(['vendor/custom', 'other'])
    await bridge.readCatalogue!({ auto: true })
    const refused = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), config: [{ configId: 'model', value: 'other' }] })
    const detail = await settled(bridge, refused.sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(JSON.stringify(detail.messages)).toContain('没有换到模型「other」')
    expect(received(await fixture.log(), 'session/prompt')).toEqual([])
    await bridge.close()

    const lenient = await setup(OPTIONS)
    const open = await lenient.open()
    await open.setCustomModels!(['vendor/custom'])
    const { sessionId } = await open.createTask({
      prompt: 'echo hi',
      requestId: rid(),
      config: [{ configId: 'model', value: 'vendor/custom' }],
    })
    expect((await settled(open, sessionId)).summary.status).toBe('idle')
    const sent = received(await lenient.log(), 'session/set_config_option').map(entry => [entry.params?.configId, entry.params?.value])
    expect(sent).toContainEqual(['model', 'vendor/custom'])
    await open.setConfig!(sessionId, 'model', 'small')
    await open.setConfig!(sessionId, 'model', 'vendor/custom')
    await expect(open.setConfig!(sessionId, 'model', 'not-typed')).rejects.toMatchObject({ code: 'config-value-invalid' })
    await open.setCustomModels!([])
    expect(open.customModels!()).toEqual([])
  })

  it('runs the next send on the model the session shows once the agent refuses a typed one', async () => {
    const fixture = await setup({ ...OPTIONS, FAKE_ACP_STRICT_MODELS: '1' })
    const bridge = await fixture.open()
    await bridge.setCustomModels!(['other'])
    await bridge.readCatalogue!({ auto: true })
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), config: [{ configId: 'model', value: 'other' }] })
    const failed = await settled(bridge, sessionId)
    expect(failed.summary.status).toBe('failed')
    expect(failed.messages.at(-1)?.text).toContain(
      'Fake 没有换到模型「other」，这条消息没有发出。再发送会用「Small」，也可以先在模型里换一个。',
    )
    expect(failed.config?.find(item => item.id === 'model')?.currentValue).toBe('small')

    await bridge.prompt(sessionId, 'echo again', rid())
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    const log = await fixture.log()
    expect(received(log, 'session/prompt')).toHaveLength(1)
    expect(received(log, 'session/set_config_option').filter(entry => entry.params?.configId === 'model')).toHaveLength(1)
  })
})

describe('ACP steering', () => {
  it('rechecks direct image delivery after reading it and keeps an unreadable acknowledgment unknown', async () => {
    const image = {
      id: 'abcdefghijklmnopqrstuv',
      name: 'image.png',
      kind: 'image',
      mime: 'image/png',
      size: 3,
      sha256: 'a'.repeat(64),
    } as const
    const events: string[] = []
    const fixture = await setup(
      { FAKE_ACP_CAPS: 'steer,steerAttachments,images' },
      {},
      {},
      {
        readAttachment: async () => {
          events.push('read')
          return { type: 'image', data: 'cG5n', mimeType: 'image/png' }
        },
      },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    await until(bridge, sessionId, state => state.steerAttachments === true)
    const requestId = rid()
    const request = vi.spyOn(AcpWire.prototype, 'request').mockResolvedValueOnce({ outcome: 'unrecognized' })
    try {
      await expect(
        bridge.steerWithAttachments!(sessionId, '', requestId, [image], {
          authorize: async () => {
            events.push('denied')
            throw new AppError(403, 'scope-required', '没有运行权限')
          },
        }),
      ).rejects.toMatchObject({ code: 'scope-required' })
      expect(request).not.toHaveBeenCalled()
      const options = {
        authorize: async () => {
          events.push('allowed')
        },
      }
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(bridge.steerWithAttachments!(sessionId, '', requestId, [image], options)).rejects.toMatchObject({
          code: 'steer-unknown',
        })
      expect(request).toHaveBeenCalledTimes(1)
      expect(events).toEqual(['read', 'denied', 'read', 'allowed'])
    } finally {
      request.mockRestore()
    }
    await bridge.cancel(sessionId)
    await bridge.prompt(sessionId, 'elicit', rid())
    const next = await settled(bridge, sessionId)
    expect(systemText(next)).toContain('elicitation/create')
    expect(systemText(next)).not.toContain('How should I approach this?')
  })

  it.each(['direct', 'queued'])('keeps an unrecognized %s steer reply unknown on retry', async mode => {
    const bridge = await (await setup({ FAKE_ACP_CAPS: 'steer' })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    const detail = await until(bridge, sessionId, state => state.steer === true)
    const request = vi.spyOn(AcpWire.prototype, 'request').mockResolvedValueOnce({ outcome: 'unrecognized' })
    try {
      const requestId = rid()
      const options = { runId: detail.summary.runId!, queuedAt: new Date().toISOString(), authorize: async () => {} }
      const steer = () =>
        mode === 'queued' ? bridge.steerQueued!(sessionId, 'more', requestId, options) : bridge.steer!(sessionId, 'more', requestId)
      for (let attempt = 0; attempt < 2; attempt++) await expect(steer()).rejects.toMatchObject({ code: 'steer-unknown' })
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      request.mockRestore()
    }
  })

  it('adds a queued message only to its chosen run, even if authorization outlasts that run', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'steer' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    const first = await until(bridge, sessionId, detail => detail.steer === true)
    const queuedAt = new Date(0).toISOString()
    const checking = deferred()
    const release = deferred()
    const pending = bridge.steerQueued!(sessionId, 'queued text', rid(), {
      queuedAt,
      runId: first.summary.runId!,
      authorize() {
        checking.resolve()
        return release.promise
      },
    })
    await checking.promise
    await bridge.cancel(sessionId)
    await bridge.prompt(sessionId, 'steerable', rid())
    const next = await until(bridge, sessionId, detail => detail.steer === true)
    release.resolve()
    expect(await pending).toBe('prompt-required')
    expect(received(await fixture.log(), '_session/steering')).toHaveLength(0)

    const requestId = rid()
    const options = { runId: next.summary.runId!, queuedAt, authorize: async () => {} }
    const refused = () => Promise.reject(new AppError(403, 'scope-required', '没有运行权限'))
    await expect(bridge.steerQueued!(sessionId, 'queued text', requestId, { ...options, authorize: refused })).rejects.toMatchObject({
      code: 'scope-required',
    })
    expect(received(await fixture.log(), '_session/steering')).toHaveLength(0)
    expect(await bridge.steerQueued!(sessionId, 'queued text', requestId, options)).toBe('injected')
    expect(await bridge.steerQueued!(sessionId, 'queued text', requestId, options)).toBe('injected')
    expect((await settled(bridge, sessionId)).messages.filter(message => message.steered)).toMatchObject([
      { text: 'queued text', requestId, queuedAt },
    ])
    expect(received(await fixture.log(), '_session/steering')).toHaveLength(1)
  })

  it('adds text to a running turn only when the agent says it takes it, and never starts a turn with it', async () => {
    const plain = await (await setup()).open()
    const first = await plain.createTask({ prompt: 'steerable', requestId: rid() })
    await until(plain, first.sessionId, detail => assistants(detail).length > 0 || detail.liveText === 'working')
    expect((await plain.detail(first.sessionId)).steer).toBeUndefined()
    expect(await plain.steer!(first.sessionId, 'also this', rid())).toBe('prompt-required')
    await plain.cancel(first.sessionId)

    const fixture = await setup({ FAKE_ACP_CAPS: 'steer' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    const running = await until(bridge, sessionId, detail => detail.liveText === 'working')
    expect(running.steer).toBe(true)
    expect(running.steerAttachments).toBeUndefined()
    const image = {
      id: 'abcdefghijklmnopqrstuv',
      name: 'image.png',
      kind: 'image',
      mime: 'image/png',
      size: 4,
      sha256: 'a'.repeat(64),
    } as const
    expect(await bridge.steerWithAttachments!(sessionId, '', rid(), [image])).toBe('prompt-required')
    expect(received(await fixture.log(), '_session/steering')).toHaveLength(0)
    const requestId = rid()
    expect(await bridge.steer!(sessionId, 'look at b.txt too', requestId)).toBe('injected')
    const detail = await settled(bridge, sessionId)
    expect(detail.steer).toBeUndefined()
    expect(detail.summary.runOutcome).toBe('completed')
    // The reply so far, then the added text, then what the agent made of it: one turn.
    expect(detail.messages.map(message => [message.role, message.text, message.steered])).toEqual([
      ['user', 'steerable', undefined],
      ['assistant', 'working', undefined],
      ['user', 'look at b.txt too', true],
      ['assistant', 'steered: look at b.txt too', undefined],
    ])
    expect(detail.messages[2]).toMatchObject({ requestId })
    const [steer] = received(await fixture.log(), '_session/steering')
    expect(steer.params).toEqual({
      sessionId: expect.any(String),
      prompt: [{ type: 'text', text: 'look at b.txt too' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    })
    // A retry answers what the first got; the same ID with other text is refused; nothing is sent again.
    expect(await bridge.steer!(sessionId, 'look at b.txt too', requestId)).toBe('injected')
    await expect(bridge.steer!(sessionId, 'other', requestId)).rejects.toMatchObject({ code: 'request-conflict' })
    // No turn runs: nothing goes to the agent, and the text is left for a turn of its own.
    expect(await bridge.steer!(sessionId, 'later', rid())).toBe('prompt-required')
    expect(received(await fixture.log(), '_session/steering')).toHaveLength(1)
    expect((await bridge.detail(sessionId)).messages).toHaveLength(4)
  })

  it('splits the turn at the added text when the reply comes in the same read as the answer to it', async () => {
    const bridge = await (await setup({ FAKE_ACP_CAPS: 'steer', FAKE_ACP_STEER: 'reply' })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    await until(bridge, sessionId, detail => detail.liveText === 'working')
    expect(await bridge.steer!(sessionId, 'look at b.txt too', rid())).toBe('injected')
    const detail = await settled(bridge, sessionId)
    expect(detail.messages.map(message => [message.role, message.text, message.steered])).toEqual([
      ['user', 'steerable', undefined],
      ['assistant', 'working', undefined],
      ['user', 'look at b.txt too', true],
      ['assistant', 'steered: look at b.txt too', undefined],
    ])
  })

  it('leaves a steer the agent did not answer unknown, and never sends it again', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'steer', FAKE_ACP_STEER: 'hang' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    await until(bridge, sessionId, detail => detail.liveText === 'working')
    const request = AcpWire.prototype.request
    const deadline = vi.spyOn(AcpWire.prototype, 'request').mockImplementation(function (this: AcpWire, ...args) {
      if (args[0] === '_session/steering') args[2] = 300
      return request.apply(this, args)
    })
    cleanups.push(() => void deadline.mockRestore())
    const requestId = rid()
    await expect(bridge.steer!(sessionId, 'more', requestId)).rejects.toMatchObject({ status: 409, code: 'steer-unknown' })
    await expect(bridge.steer!(sessionId, 'more', requestId)).rejects.toMatchObject({ code: 'steer-unknown' })
    deadline.mockRestore()
    expect(received(await fixture.log(), '_session/steering')).toHaveLength(1)
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.messages.filter(message => message.steered)).toEqual([])
    // The stop is told that text was added this turn, since nobody knows whether the agent read it.
    expect(systemText(detail)).toContain('可能没有读到')
    await bridge.close()
    const reopened = await fixture.open()
    await expect(reopened.prompt(sessionId, 'more', requestId)).rejects.toMatchObject({ code: 'steer-unknown' })
  })

  it('does not warn on a stop when the agent went on after what was added', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'steer' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable hold', requestId: rid() })
    await until(bridge, sessionId, detail => detail.liveText === 'working')
    expect(await bridge.steer!(sessionId, 'and the logs', rid())).toBe('injected')
    await until(bridge, sessionId, detail => detail.liveText.includes('steered: and the logs'))
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.summary.status).toBe('cancelled')
    expect(systemText(detail)).not.toContain('可能没有读到')
  })

  it('says when the agent refuses a steer, and stops taking them once the turn is being stopped', async () => {
    const refusing = await (await setup({ FAKE_ACP_CAPS: 'steer', FAKE_ACP_STEER: 'failed' })).open()
    const first = await refusing.createTask({ prompt: 'steerable', requestId: rid() })
    await until(refusing, first.sessionId, detail => detail.liveText === 'working')
    const requestId = rid()
    await expect(refusing.steer!(first.sessionId, 'more', requestId)).rejects.toMatchObject({ status: 409, code: 'steer-failed' })
    await refusing.cancel(first.sessionId)
    // A refusal leaves no receipt, and the stop has nothing to warn about.
    expect(systemText(await refusing.detail(first.sessionId))).not.toContain('可能没有读到')

    const fixture = await setup({ FAKE_ACP_CAPS: 'steer' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable', requestId: rid() })
    await until(bridge, sessionId, detail => detail.liveText === 'working')
    const stopping = bridge.cancel(sessionId)
    expect((await bridge.detail(sessionId)).steer).toBeUndefined()
    const lateId = rid()
    expect(await bridge.steer!(sessionId, 'too late', lateId)).toBe('prompt-required')
    await stopping
    expect(received(await fixture.log(), '_session/steering')).toEqual([])
    // The text went to the queue. A retry of that request while a later turn takes steers keeps the first answer.
    await bridge.prompt(sessionId, 'steerable', rid())
    await until(bridge, sessionId, detail => detail.liveText === 'working')
    expect(await bridge.steer!(sessionId, 'too late', lateId)).toBe('prompt-required')
    expect(received(await fixture.log(), '_session/steering')).toEqual([])
    await bridge.cancel(sessionId)
  })

  it('keeps a taken steer across a restart, and does not count it as a turn', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'steer,resume' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'steerable drop', requestId: rid() })
    await until(bridge, sessionId, detail => detail.liveText === 'working')
    const requestId = rid()
    expect(await bridge.steer!(sessionId, 'and this', requestId)).toBe('injected')
    // The agent ended its turn without reading it: the row still says only that it was added.
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.runOutcome).toBe('completed')
    expect(detail.messages.filter(message => message.steered).map(message => message.text)).toEqual(['and this'])
    await bridge.close()
    const again = await fixture.open()
    expect((await again.detail(sessionId)).messages.filter(message => message.steered)).toHaveLength(1)
    expect(await again.steer!(sessionId, 'and this', requestId)).toBe('injected')
    await again.prompt(sessionId, 'echo next', rid())
    const next = await settled(again, sessionId)
    expect(assistants(next).at(-1)?.text).toBe('echo: echo next')
    expect(
      received(await fixture.log(), 'session/prompt').map(entry => (entry.params?.prompt as Array<{ text: string }>).at(-1)!.text),
    ).toEqual(['steerable drop', 'echo next'])
  })
})

describe('ACP subagents', () => {
  const subagents = (detail: DriverTaskDetail) => detail.messages.filter(message => message.subagent)

  it('shows a subagent where it began, with what it said and did, and its own report of how it ended', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'delegate nest', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    const [row] = subagents(detail)
    expect(row).toMatchObject({ role: 'tool', toolName: 'subagent', state: 'completed' })
    expect(row!.subagent).toMatchObject({ title: 'Test runner', description: 'Runs the tests', status: 'done' })
    // Its text in one step, its call merged into one step, its own subagent nested; never its reasoning.
    const steps = row!.subagent!.steps
    expect(steps.map(step => [step.role, step.text || step.subagent?.title])).toEqual([
      ['assistant', 'running the tests'],
      ['tool', 'all passed'],
      ['tool', 'Linter'],
      ['assistant', 'tests pass'],
    ])
    expect(steps[2]!.subagent).toMatchObject({ status: 'done', steps: [{ role: 'assistant', text: 'lint clean' }] })
    expect(JSON.stringify(detail)).not.toContain('hidden reasoning')
    // The session's own reply follows, and the subagent's words are not the session's.
    expect(assistants(detail).map(message => message.text)).toEqual(['the subagent says the tests pass'])
    // Kept across a restart as it was.
    await bridge.close()
    expect(subagents(await (await fixture.open()).detail(sessionId))[0]!.subagent!.steps).toHaveLength(4)
  })

  it("asks for a subagent's call in the session that started it, by the subagent's name", async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'delegate ask', requestId: rid() })
    const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    const [approval] = waiting.approvals
    expect(approval).toMatchObject({
      sessionId,
      subagent: 'Test runner',
      subagentId: subagents(waiting)[0]?.id,
      toolName: expect.any(String),
    })
    expect(approval!.toolCallId).toBeUndefined()
    expect(waiting.summary.status).toBe('waiting-approval')
    expect(subagents(waiting)[0]).toMatchObject({ state: 'awaiting-approval', subagent: { status: 'waiting' } })
    expect(
      subagents(waiting)[0]!.subagent!.steps.find(step => step.text === 'Edit a.txt' || step.tool?.title === 'Edit a.txt')?.state,
    ).toBe('awaiting-approval')
    expect(await bridge.decide(approval!.id, 'allow')).toBe(true)
    const detail = await settled(bridge, sessionId)
    const edit = subagents(detail)[0]!.subagent!.steps.find(step => step.tool?.title === 'Edit a.txt')
    expect(edit).toMatchObject({ state: 'completed', tool: { decision: { outcome: 'allowed' } } })
    // The session's own transcript has no row for the subagent's call.
    expect(detail.messages.some(message => message.tool?.title === 'Edit a.txt')).toBe(false)
    expect(answers(await fixture.log())).toEqual([])
    expect((await fixture.log()).find(entry => entry.event === 'child-permission-answer')).toMatchObject({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
  })

  it('still asks for a subagent past the limits on rows and steps, and says what it did not show', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const allowed = async (sessionId: string) => {
      const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
      const [approval] = waiting.approvals
      expect(approval).toMatchObject({ subagent: 'Test runner', reason: 'Edit a.txt' })
      expect(await bridge.decide(approval!.id, 'allow')).toBe(true)
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.runOutcome).toBe('completed')
      expect((await fixture.log()).filter(entry => entry.event === 'child-permission-answer').at(-1)).toMatchObject({
        outcome: { outcome: 'selected', optionId: 'allow' },
      })
      return detail
    }
    // A 65th subagent in one turn has no row, but its request is still the person's to answer.
    const { sessionId } = await bridge.createTask({ prompt: 'delegate crowd', requestId: rid() })
    let detail = await allowed(sessionId)
    expect(subagents(detail)).toHaveLength(64)
    expect(subagents(detail).some(row => row.subagent!.title === 'Test runner')).toBe(false)
    expect(systemText(detail)).toContain('没有单独显示')
    // Subagents that ended in an earlier turn of the same process no longer count toward the limit.
    await bridge.prompt(sessionId, 'delegate ask', rid())
    detail = await allowed(sessionId)
    expect(subagents(detail)).toHaveLength(65)
    expect(subagents(detail).at(-1)!.subagent).toMatchObject({ title: 'Test runner', status: 'done' })

    // A call past a subagent's 200 steps is asked about too, though its step is not kept.
    const long = await bridge.createTask({ prompt: 'delegate long', requestId: rid() })
    detail = await allowed(long.sessionId)
    const row = subagents(detail)[0]!.subagent!
    expect(row.steps).toHaveLength(200)
    expect(row.truncated).toBe(true)
  })

  it("marks and records the calls of a subagent that the Harness's model decided, as it does the session's own", async () => {
    const judgedEvents = (fixture: Awaited<ReturnType<typeof setup>>, sessionId: string) =>
      fixture.events.filter(event => event.type === 'tool-judged' && event.sessionId === sessionId)
    const toolSteps = (detail: DriverTaskDetail) => subagents(detail)[0]!.subagent!.steps.filter(step => step.role === 'tool')
    const allowAll = async (bridge: Bridge, sessionId: string) => {
      const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
      expect(await bridge.decide(waiting.approvals[0]!.id, 'allow')).toBe(true)
      return settled(bridge, sessionId)
    }

    // Codex reports its model's reviews of a subagent's requests on the subagent's own session.
    const codex = await preset('codex', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
      FAKE_ACP_INITIAL_MODE: 'read-only',
    })
    let bridge = await codex.open()
    let { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'mode', 'agent')
    await bridge.prompt(sessionId, 'delegate review', rid())
    let detail = await settled(bridge, sessionId)
    let steps = toolSteps(detail)
    expect(steps.map(step => [step.id, step.state, step.tool?.judged])).toEqual([
      [await childStepId(codex, sessionId, 'call_1'), 'completed', undefined],
      [await childStepId(codex, sessionId, 'guardian_assessment:r1'), 'completed', { by: 'Fake', outcome: 'approved' }],
      [await childStepId(codex, sessionId, 'guardian_assessment:r2'), 'failed', { by: 'Fake', outcome: 'denied' }],
    ])
    expect(judgedEvents(codex, sessionId)).toEqual([
      {
        type: 'tool-judged',
        sessionId,
        callHash: sha256Hex(steps[1]!.id),
        modeHash: sha256Hex('agent'),
        kind: 'think',
        outcome: 'approved',
        source: 'agent-report',
      },
      expect.objectContaining({ callHash: sha256Hex(steps[2]!.id), outcome: 'denied', source: 'agent-report' }),
    ])

    // A Harness that reports no verdicts: what a subagent ran unasked is recorded, what it asked about is the person's.
    const qwen = await preset('qwen', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default' })
    bridge = await qwen.open()
    const inAuto = async (prompt: string) => {
      const task = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
      await settled(bridge, task.sessionId)
      await bridge.setConfig!(task.sessionId, 'mode', 'auto')
      await bridge.prompt(task.sessionId, prompt, rid())
      return { sessionId: task.sessionId, detail: await allowAll(bridge, task.sessionId) }
    }
    ;({ sessionId, detail } = await inAuto('delegate ask'))
    steps = toolSteps(detail)
    expect(steps.map(step => [step.tool?.title, step.tool?.judged, step.tool?.decision?.outcome])).toEqual([
      ['Run pnpm test', { by: 'Fake', outcome: 'unasked' }, undefined],
      ['Edit a.txt', undefined, 'allowed'],
    ])
    expect(judgedEvents(qwen, sessionId)).toEqual([
      expect.objectContaining({ callHash: sha256Hex(steps[0]!.id), kind: 'execute', outcome: 'ran-unasked', source: 'no-ask-seen' }),
    ])

    // Past a subagent's 200 steps its calls have no step, and are recorded all the same.
    ;({ sessionId, detail } = await inAuto('delegate long'))
    expect(toolSteps(detail)[0]!.id).toBe(await childStepId(qwen, sessionId, 'call_1'))
    const hashes = judgedEvents(qwen, sessionId).map(event => (event as { callHash: string }).callHash)
    expect(hashes).toHaveLength(201)
    expect(hashes).toContain(sha256Hex(await childStepId(qwen, sessionId, 'read_199')))
    expect(hashes).not.toContain(sha256Hex(await childStepId(qwen, sessionId, 'call_2')))

    // So are those of a subagent with no row.
    ;({ sessionId } = await inAuto('delegate crowd'))
    expect(judgedEvents(qwen, sessionId)).toEqual([expect.objectContaining({ kind: 'execute', outcome: 'ran-unasked' })])
  })

  it("answers a subagent's open request as cancelled when the session is stopped, and leaves no subagent running", async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'delegate ask', requestId: rid() })
    await until(bridge, sessionId, detail => detail.approvals.length === 1)
    await bridge.cancel(sessionId)
    const detail = await bridge.detail(sessionId)
    expect(detail.approvals).toEqual([])
    expect(subagents(detail)[0]).toMatchObject({ state: 'cancelled', subagent: { status: 'cancelled' } })
    expect((await fixture.log()).find(entry => entry.event === 'child-permission-answer')).toMatchObject({
      outcome: { outcome: 'cancelled' },
    })
    // Its own calls end with the turn as the session's do: the running one unknown, the asked one never run.
    const stepStates = (row: Message) =>
      row.subagent!.steps.filter(step => step.role === 'tool').map(step => [step.tool?.title, step.state])
    const settledSteps = [
      ['Run pnpm test', 'failed'],
      ['Edit a.txt', 'cancelled'],
    ]
    expect(stepStates(subagents(detail)[0]!)).toEqual(settledSteps)

    // A subagent that never says it stopped is not shown as still working once its turn has ended.
    const { sessionId: second } = await bridge.createTask({ prompt: 'delegate silent', requestId: rid() })
    await until(bridge, second, detail => subagents(detail)[0]?.subagent?.status === 'running')
    await bridge.cancel(second)
    const row = subagents(await bridge.detail(second))[0]!
    expect(row.subagent!.status).toBe('unknown')
    expect(row.state).toBeUndefined()
    expect(stepStates(row)).toEqual([['Run pnpm test', 'failed']])

    // Stored that way.
    await bridge.close()
    const again = await fixture.open()
    expect(stepStates(subagents(await again.detail(sessionId))[0]!)).toEqual(settledSteps)
    expect(stepStates(subagents(await again.detail(second))[0]!)).toEqual([['Run pnpm test', 'failed']])
  })

  it('asks for a subagent that goes on after its turn, keeps its process for the answer, and lets a stop answer it', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'resume' }, { idleMs: 150 })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'delegate late', requestId: rid() })
    const waiting = await until(bridge, sessionId, detail => detail.approvals.length === 1)
    // The turn is over; only the subagent's request is open, and the session waits on the person for it.
    expect(waiting.messages.find(message => message.role === 'user')?.turn).toBeDefined()
    expect(waiting.summary.status).toBe('waiting-approval')
    expect(waiting.activity).toBeUndefined()
    expect(waiting.approvals[0]).toMatchObject({ sessionId, subagent: 'Test runner', reason: 'Edit b.txt' })
    expect(subagents(waiting)[0]!.subagent!.status).toBe('unknown')
    // The idle process is not stopped while the person has a request to answer.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect((await fixture.log()).some(entry => entry.event === 'stdin-end')).toBe(false)
    expect(await bridge.decide(waiting.approvals[0]!.id, 'allow')).toBe(true)
    const answered = await bridge.detail(sessionId)
    expect(answered.summary.status).toBe('idle')
    expect(subagents(answered)[0]!.subagent!.steps.find(step => step.tool?.title === 'Edit b.txt')).toMatchObject({
      tool: { decision: { outcome: 'allowed' } },
    })
    await vi.waitFor(
      async () =>
        expect((await fixture.log()).filter(entry => entry.event === 'child-permission-answer').map(entry => entry.outcome)).toEqual([
          { outcome: 'selected', optionId: 'allow' },
        ]),
      { timeout: 5_000, interval: 20 },
    )
    // Idle again, the process stops as any idle one does.
    await vi.waitFor(async () => expect((await fixture.log()).some(entry => entry.event === 'stdin-end')).toBe(true), {
      timeout: 5_000,
      interval: 20,
    })

    // Stopping the session answers such a request as cancelled, though no turn runs; a stop naming another run does not.
    const { sessionId: second } = await bridge.createTask({ prompt: 'delegate late', requestId: rid() })
    const open = await until(bridge, second, detail => detail.approvals.length === 1)
    expect(await bridge.cancel(second, { runId: 'another-run' })).toBe(false)
    expect(await bridge.cancel(second, { runId: open.summary.runId! })).toBe(true)
    const stopped = await bridge.detail(second)
    expect(stopped.approvals).toEqual([])
    expect(stopped.summary.status).toBe('idle')
    expect(subagents(stopped)[0]!.subagent!.steps.find(step => step.tool?.title === 'Edit b.txt')?.state).toBe('cancelled')
    await vi.waitFor(
      async () =>
        expect((await fixture.log()).filter(entry => entry.event === 'child-permission-answer').at(-1)?.outcome).toEqual({
          outcome: 'cancelled',
        }),
      { timeout: 5_000, interval: 20 },
    )
    expect(await bridge.cancel(second)).toBe(false)

    // A request still open when the turn ends by itself stays open; it is answered after the turn as one that came then.
    const { sessionId: third } = await bridge.createTask({ prompt: 'delegate outlive', requestId: rid() })
    const outlived = await until(bridge, third, detail => detail.summary.status === 'waiting-approval' && !!detail.messages[0]?.turn)
    expect(outlived.approvals).toHaveLength(1)
    const step = () => subagents(outlived)[0]!.subagent!.steps.find(item => item.tool?.title === 'Edit b.txt')
    expect(step()?.state).toBe('awaiting-approval')
    expect(await bridge.decide(outlived.approvals[0]!.id, 'reject')).toBe(true)
    const rejected = await bridge.detail(third)
    expect(rejected.summary.status).toBe('idle')
    expect(subagents(rejected)[0]!.subagent!.steps.find(item => item.tool?.title === 'Edit b.txt')).toMatchObject({
      state: 'cancelled',
      tool: { decision: { outcome: 'rejected' } },
    })
  })

  it("never offers the person a subagent's request wider than the session's own mode, and records each one refused", async () => {
    const refused = (fixture: Awaited<ReturnType<typeof setup>>, sessionId: string) =>
      fixture.events.filter(event => event.type === 'approval-auto-rejected' && event.sessionId === sessionId)
    const childAnswers = async (fixture: Awaited<ReturnType<typeof setup>>) =>
      (await fixture.log()).filter(entry => entry.event === 'child-permission-answer').map(entry => entry.outcome)
    const inMode = async (bridge: Bridge, mode: string) => {
      const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
      await settled(bridge, sessionId)
      await bridge.setConfig!(sessionId, 'mode', mode)
      return sessionId
    }

    // In 只看不改 the session's own agent changes nothing, so a subagent asking to edit is refused, never shown.
    const qwen = await preset('qwen', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default' })
    let bridge = await qwen.open()
    let sessionId = await inMode(bridge, 'plan')
    await bridge.prompt(sessionId, 'delegate ask', rid())
    let detail = await settled(bridge, sessionId)
    expect(detail.approvals).toEqual([])
    expect(bridge.approvals()).toEqual([])
    expect(await childAnswers(qwen)).toEqual([{ outcome: 'selected', optionId: 'reject' }])
    expect(systemText(detail)).toContain('已拒绝：子 Agent「Test runner」请求「Edit a.txt」，这个会话是「只看不改」，Latch 没有交给你。')
    expect(refused(qwen, sessionId)).toEqual([{ type: 'approval-auto-rejected', sessionId, reason: 'subagent-wider' }])
    expect(subagents(detail)[0]!.subagent!.steps.find(step => step.tool?.title === 'Edit a.txt')?.tool?.decision).toBeUndefined()
    // A tool whose kind says nothing, or that has none, may change something too: refused the same way. A read is offered.
    for (const [argument, title] of [
      ['other', 'Call mcp tool'],
      ['bare', 'Call bare tool'],
    ] as const) {
      await bridge.prompt(sessionId, `delegate ${argument}`, rid())
      detail = await settled(bridge, sessionId)
      expect(detail.approvals).toEqual([])
      expect(systemText(detail)).toContain(`请求「${title}」，这个会话是「只看不改」，Latch 没有交给你。`)
    }
    expect(refused(qwen, sessionId)).toHaveLength(3)
    await bridge.prompt(sessionId, 'delegate read', rid())
    const reading = await until(bridge, sessionId, item => item.approvals.length === 1)
    expect(reading.approvals[0]).toMatchObject({ subagent: 'Test runner', reason: 'Read a.txt' })
    expect(await bridge.decide(reading.approvals[0]!.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
    // The same request in 先问你 is the person's, as the session's own would be.
    await bridge.setConfig!(sessionId, 'mode', 'default')
    await bridge.prompt(sessionId, 'delegate ask', rid())
    const waiting = await until(bridge, sessionId, item => item.approvals.length === 1)
    expect(waiting.approvals[0]).toMatchObject({ subagent: 'Test runner', reason: 'Edit a.txt' })
    expect(await bridge.decide(waiting.approvals[0]!.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
    expect(refused(qwen, sessionId)).toHaveLength(3)

    // An answer that would move the subagent to a wider mode is not offered; one that keeps it within the session's is.
    const claude = await preset('claude-agent', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'default,acceptEdits,plan,auto,bypassPermissions',
      FAKE_ACP_INITIAL_MODE: 'auto',
      FAKE_ACP_VERSION: '0.101.0',
    })
    bridge = await claude.open()
    sessionId = await inMode(bridge, 'plan')
    await bridge.prompt(sessionId, 'delegate exit', rid())
    detail = await settled(bridge, sessionId)
    expect(await childAnswers(claude)).toEqual([{ outcome: 'selected', optionId: 'reject' }])
    expect(systemText(detail)).toContain('请求「Ready to code?」，会把权限换得比这个会话宽，或换到 Latch 认不出的模式，Latch 没有交给你。')
    expect(refused(claude, sessionId)).toEqual([{ type: 'approval-auto-rejected', sessionId, reason: 'subagent-wider' }])
    await bridge.prompt(sessionId, 'delegate enter', rid())
    let asked = await until(bridge, sessionId, item => item.approvals.length === 1)
    expect(asked.approvals[0]!.options!.map(option => option.id)).toEqual(['allow-once', 'reject'])
    expect(await bridge.decide(asked.approvals[0]!.id, 'allow')).toBe(true)
    detail = await settled(bridge, sessionId)
    // A subagent's answer is never the person choosing the session's mode.
    expect(detail.permission?.expectedMode).toBe('plan')
    // An answer naming an option the ceiling dropped is refused by the driver itself, and the request stays open.
    await bridge.prompt(sessionId, 'delegate either', rid())
    asked = await until(bridge, sessionId, item => item.approvals.length === 1)
    expect(asked.approvals[0]!.options!.map(option => option.id)).toEqual(['allow-once', 'reject'])
    await expect(bridge.decide(asked.approvals[0]!.id, 'allow', { optionId: 'exit-plan-default' })).rejects.toMatchObject({
      code: 'approval-option-hidden',
      message: expect.stringContaining('权限模式'),
    })
    expect(bridge.approvals()).toHaveLength(1)
    expect(await bridge.decide(asked.approvals[0]!.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'mode', 'default')
    await bridge.prompt(sessionId, 'delegate exit', rid())
    asked = await until(bridge, sessionId, item => item.approvals.length === 1)
    expect(asked.approvals[0]!.options!.map(option => option.id)).toEqual(['exit-plan-default', 'reject'])
    expect(await bridge.decide(asked.approvals[0]!.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
    expect(refused(claude, sessionId)).toHaveLength(1)

    // Without a profile Latch cannot tell where a mode-switching answer leads, so it is not offered either.
    const plain = await setup()
    bridge = await plain.open()
    ;({ sessionId } = await bridge.createTask({ prompt: 'delegate enter', requestId: rid() }))
    detail = await settled(bridge, sessionId)
    expect(await childAnswers(plain)).toEqual([{ outcome: 'selected', optionId: 'reject' }])
    expect(refused(plain, sessionId)).toEqual([{ type: 'approval-auto-rejected', sessionId, reason: 'subagent-wider' }])
  })

  it("stops the session as its own widening when a subagent reports a mode wider than the session's", async () => {
    const env = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default' }
    const stricter = await preset('qwen', { ...env, FAKE_ACP_CHILD_MODE: 'plan' })
    let bridge = await stricter.open()
    let { sessionId } = await bridge.createTask({ prompt: 'delegate mode', requestId: rid() })
    let detail = await settled(bridge, sessionId)
    expect(detail.summary.runOutcome).toBe('completed')
    expect(detail.permission?.drift).toBeUndefined()

    const wider = await preset('qwen', { ...env, FAKE_ACP_CHILD_MODE: 'yolo' })
    bridge = await wider.open()
    ;({ sessionId } = await bridge.createTask({ prompt: 'delegate mode', requestId: rid() }))
    detail = await settled(bridge, sessionId)
    expect(detail.summary.runOutcome).toBe('cancelled')
    expect(detail.permission?.drift).toMatchObject({ observed: 'yolo' })
    expect(systemText(detail)).toContain('子 Agent「Test runner」报告的权限模式比这个会话宽（default → yolo）')
    expect(wider.events).toContainEqual({ type: 'permission-drift', sessionId, observedHash: sha256Hex('yolo') })
    await expect(bridge.prompt(sessionId, 'echo again', rid())).rejects.toMatchObject({ code: 'permission-drift' })
  })

  it('stops one subagent alone where it says it can be, and says it stopped only once it did', async () => {
    const fixture = await setup({ FAKE_ACP_CHILD_STOP_MS: '300' })
    const bridge = await fixture.open()
    const row = (detail: DriverTaskDetail) => subagents(detail)[0]!
    const { sessionId } = await bridge.createTask({ prompt: 'delegate stop', requestId: rid() })
    const working = await until(bridge, sessionId, detail => detail.approvals.length === 1 && row(detail).subagent?.stoppable === true)
    expect(row(working).subagent).toMatchObject({ status: 'waiting', stoppable: true })
    // A row that is not the session's subagent, or no row, is nothing to stop.
    expect(await bridge.cancelSubagent!(sessionId, 'subagent:unknown')).toBe(false)

    expect(await bridge.cancelSubagent!(sessionId, row(working).id)).toBe(true)
    const stopping = await bridge.detail(sessionId)
    // Sent, not yet taken effect: the row says so, and its request is answered as a stop of the session would answer it.
    expect(row(stopping).subagent).toMatchObject({ status: 'waiting', stopping: true })
    expect(row(stopping).subagent!.stoppable).toBeUndefined()
    expect(stopping.approvals).toEqual([])
    expect(stopping.summary.status).toBe('running')
    expect(await bridge.cancelSubagent!(sessionId, row(working).id)).toBe(true)
    // The agent writes what it received as it reads it: the stop reaches it after this call returns.
    await vi.waitFor(async () => expect(received(await fixture.log(), 'session/cancel')).toHaveLength(1), { timeout: 5_000, interval: 20 })
    expect(String(received(await fixture.log(), 'session/cancel')[0]!.params?.sessionId)).toMatch(/:child$/u)

    const detail = await settled(bridge, sessionId)
    expect(row(detail).subagent).toMatchObject({ status: 'cancelled' })
    expect(row(detail).subagent!.stopping).toBeUndefined()
    expect(row(detail).subagent!.steps.find(step => step.tool?.title === 'Edit a.txt')).toMatchObject({
      state: 'cancelled',
      tool: { decision: { outcome: 'cancelled', subagentStopped: true } },
    })
    // The session's turn went on and ended by itself.
    expect(detail.summary.runOutcome).toBe('completed')
    expect(assistants(detail).at(-1)?.text).toBe('the session goes on without it')
    expect((await fixture.log()).find(entry => entry.event === 'child-permission-answer')).toMatchObject({
      outcome: { outcome: 'cancelled' },
    })
    expect(received(await fixture.log(), 'session/cancel')).toHaveLength(1)
    expect(await bridge.cancelSubagent!(sessionId, row(detail).id)).toBe(false)

    // One that never says it stopped is stopping until its turn ends, and then its state is unknown, never 已停止.
    const quiet = await bridge.createTask({ prompt: 'delegate stopquiet', requestId: rid() })
    const open = await until(bridge, quiet.sessionId, item => row(item).subagent?.stoppable === true)
    expect(await bridge.cancelSubagent!(quiet.sessionId, row(open).id)).toBe(true)
    expect(row(await bridge.detail(quiet.sessionId)).subagent!.stopping).toBe(true)
    const ended = await settled(bridge, quiet.sessionId)
    expect(row(ended).subagent).toMatchObject({ status: 'unknown' })
    expect(row(ended).subagent!.stopping).toBeUndefined()

    // One that says it cannot tell how it ended is no longer stopping, and its unfinished calls are not settled as stopped.
    const unsure = await bridge.createTask({ prompt: 'delegate stopunknown', requestId: rid() })
    const asking = await until(bridge, unsure.sessionId, item => row(item).subagent?.stoppable === true)
    expect(await bridge.cancelSubagent!(unsure.sessionId, row(asking).id)).toBe(true)
    const told = await until(bridge, unsure.sessionId, item => row(item).subagent?.status === 'unknown')
    expect(told.summary.status).toBe('running')
    expect(row(told).subagent!.stopping).toBeUndefined()
    expect(row(told).subagent!.steps.find(step => step.tool?.title === 'Run pnpm test')?.state).toBe('running')
    await settled(bridge, unsure.sessionId)

    // A subagent that never said it can be stopped alone offers nothing, and a stop of it is refused.
    const plain = await bridge.createTask({ prompt: 'delegate hang', requestId: rid() })
    const hanging = await until(bridge, plain.sessionId, item => row(item)?.subagent?.status === 'running')
    expect(row(hanging).subagent!.stoppable).toBeUndefined()
    expect(await bridge.cancelSubagent!(plain.sessionId, row(hanging).id)).toBe(false)
    // Stopping the session still stops it and every other.
    await bridge.cancel(plain.sessionId)
    expect(row(await bridge.detail(plain.sessionId)).subagent!.status).toBe('cancelled')

    // Stopping the session stops a stoppable one as well, as before.
    const other = await (await setup()).open()
    const whole = await other.createTask({ prompt: 'delegate stop', requestId: rid() })
    await until(other, whole.sessionId, item => item.approvals.length === 1)
    await other.cancel(whole.sessionId)
    const stopped = await other.detail(whole.sessionId)
    expect(stopped.summary.runOutcome).toBe('cancelled')
    expect(row(stopped).subagent!.stoppable).toBeUndefined()
  })

  it("refuses a request marked as a subagent's that names no subagent, never asking it as the session's own", async () => {
    const fixture = await preset('opencode', { FAKE_ACP_CONFIG: 'legacy' })
    const bridge = await fixture.open()
    for (const argument of ['empty', 'self']) {
      const { sessionId } = await bridge.createTask({ prompt: `projected ${argument}`, requestId: rid() })
      const detail = await settled(bridge, sessionId)
      expect(detail.approvals, argument).toEqual([])
      expect(assistants(detail).at(-1)?.text).toBe('answered')
    }
    expect(bridge.approvals()).toEqual([])
    expect((await fixture.log()).filter(entry => entry.event === 'projected-permission-answer').map(entry => entry.outcome)).toEqual([
      { outcome: 'selected', optionId: 'reject' },
      { outcome: 'selected', optionId: 'reject' },
    ])
  })
})

describe('Claude Agent and Cursor presets', () => {
  const CLAUDE = {
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'default,acceptEdits,plan,auto,bypassPermissions',
    // The adapter starts a session in Auto unless the person's settings say otherwise.
    FAKE_ACP_INITIAL_MODE: 'auto',
    FAKE_ACP_VERSION: '0.101.0',
  }
  const CURSOR = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'agent,plan,ask', FAKE_ACP_INITIAL_MODE: 'agent' }
  const modeSets = (log: LogEntry[]) =>
    received(log, 'session/set_config_option')
      .filter(entry => entry.params?.configId === 'mode')
      .map(entry => entry.params?.value)

  it("sets Claude Agent to Manual before every turn, names its modes in Latch's words, and never asks in Bypass only", async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(assistants(detail).at(-1)?.text).toBe('echo: echo hi')
    const log = await fixture.log()
    expect(modeSets(log)).toEqual(['default'])
    const set = log.findIndex(entry => entry.event === 'recv' && entry.method === 'session/set_config_option')
    const prompt = log.findIndex(entry => entry.event === 'recv' && entry.method === 'session/prompt')
    expect(set).toBeLessThan(prompt)
    expect(detail.permission).toMatchObject({
      expectedMode: 'default',
      defaultMode: 'default',
      readback: 'mode',
      modeTiers: {
        plan: { tier: 'plan' },
        default: { tier: 'ask' },
        acceptEdits: { tier: 'rule' },
        auto: { tier: 'model' },
        bypassPermissions: { tier: 'never' },
      },
    })
    expect(detail.config?.find(option => option.category === 'mode')?.options.map(option => option.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'bypassPermissions',
    ])
  })

  it('marks what Claude Agent refused before it ran, and records only what its model refused in auto mode', async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'denied', requestId: rid() })
    const rows = (detail: DriverTaskDetail) =>
      detail.messages
        .filter(message => message.role === 'tool')
        .map(message => [message.id.split(':').at(-1), message.state, message.tool?.blocked, message.tool?.judged])
    // In Manual nothing is the model's decision: the blocks are marked, nothing is recorded.
    let detail = await settled(bridge, sessionId)
    const blocked = {
      rule: { by: 'Fake', source: 'rule', reason: 'Denied by rule Bash(rm:*)' },
      mode: { by: 'Fake', source: 'rule', reason: 'dontAsk mode denies tools that require approval' },
      model: { by: 'Fake', source: 'model', reason: '<b>Downloads and runs a remote script</b>' },
    }
    expect(rows(detail)).toEqual([
      ['call_rule', 'failed', blocked.rule, undefined],
      ['call_mode', 'failed', blocked.mode, undefined],
      ['call_model', 'failed', blocked.model, undefined],
      // A source Latch cannot name stays an ordinary failure.
      ['call_other', 'failed', undefined, undefined],
      ['call_ran', 'completed', undefined, undefined],
    ])
    expect(fixture.events.filter(event => event.type === 'tool-judged')).toEqual([])

    await bridge.setConfig!(sessionId, 'mode', 'auto')
    await bridge.prompt(sessionId, 'denied', rid())
    detail = await settled(bridge, sessionId)
    const latest = rows(detail).slice(-5)
    expect(latest).toEqual([
      ['call_rule', 'failed', blocked.rule, undefined],
      ['call_mode', 'failed', blocked.mode, undefined],
      // The result the SDK sends after the refusal does not undo it.
      ['call_model', 'failed', blocked.model, { by: 'Fake', outcome: 'denied' }],
      ['call_other', 'failed', undefined, undefined],
      ['call_ran', 'completed', undefined, { by: 'Fake', outcome: 'unasked' }],
    ])
    const ids = detail.messages
      .filter(message => message.role === 'tool')
      .slice(-5)
      .map(message => message.id)
    const recorded = fixture.events.filter(event => event.type === 'tool-judged')
    expect(recorded).toEqual([
      {
        type: 'tool-judged',
        sessionId,
        callHash: sha256Hex(ids[2]!),
        modeHash: sha256Hex('auto'),
        kind: 'execute',
        outcome: 'denied',
        source: 'agent-report',
      },
      expect.objectContaining({ callHash: sha256Hex(ids[4]!), outcome: 'ran-unasked', source: 'no-ask-seen' }),
    ])
    // The reason is the agent's text: it stays out of the record.
    expect(JSON.stringify(recorded)).not.toContain('remote script')
    // A refusal reported for a call that had started is no refusal: the call ran unasked.
    await bridge.prompt(sessionId, 'denied late', rid())
    detail = await settled(bridge, sessionId)
    expect(rows(detail).at(-1)).toEqual(['call_late', 'failed', undefined, { by: 'Fake', outcome: 'unasked' }])
    expect(fixture.events.filter(event => event.type === 'tool-judged').at(-1)).toMatchObject({ outcome: 'ran-unasked' })
    // Marks and verdicts are still there after the Host restarts.
    await bridge.close()
    const reopened = await fixture.open()
    expect(rows(await reopened.detail(sessionId)).slice(-11, -6)).toEqual(latest)
  })

  it('keeps a key out of the reason Claude Agent gives for a refusal', async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'denied key', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    const blocked = detail.messages.find(message => message.id.endsWith(':call_key'))?.tool?.blocked
    expect(blocked).toEqual({
      by: 'Fake',
      source: 'model',
      reason:
        'Sends a credential to a host outside the project: curl -H "Authorization: Bearer [redacted]" https://example.com\n'
        + "A command that sends a credential needs the user's approval.",
    })
  })

  it('reads a refusal only from a failed update that names its source', () => {
    const read = profileFor('claude-agent')!.readDenial!
    const meta = (toolResponse: unknown) => ({ _meta: { claudeCode: { toolName: 'Bash', toolResponse } } })
    const update = (fields: Record<string, unknown>) => ({ sessionUpdate: 'tool_call_update', toolCallId: 'c', ...fields })
    expect(read(update({ status: 'failed', ...meta({ decisionReasonType: 'classifier', decisionReason: 'why' }) }))).toEqual({
      source: 'model',
      reason: 'why',
    })
    // The adapter shows the SDK's message when the decision gives no reason.
    expect(read(update({ status: 'failed', ...meta({ decisionReasonType: 'rule', message: 'denied' }) }))).toEqual({
      source: 'rule',
      reason: 'denied',
    })
    expect(read(update({ status: 'failed', ...meta({ decisionReasonType: 'mode' }) }))).toEqual({ source: 'rule' })
    // A hook's whole tool response and a progress beat use the same field, never on a failed update.
    expect(read(update({ ...meta({ decisionReasonType: 'classifier' }) }))).toBeUndefined()
    expect(read(update({ status: 'in_progress', ...meta({ decisionReasonType: 'classifier' }) }))).toBeUndefined()
    expect(read({ sessionUpdate: 'tool_call', toolCallId: 'c', status: 'failed', ...meta({ decisionReasonType: 'rule' }) })).toBeUndefined()
    for (const toolResponse of [{ decisionReasonType: 'hook' }, { decisionReasonType: 3 }, {}, 'classifier', null])
      expect(read(update({ status: 'failed', ...meta(toolResponse) }))).toBeUndefined()
    expect(read(update({ status: 'failed' }))).toBeUndefined()
    // No other preset reads Claude's words; Codex's direct route reads only its own wire's mark.
    const refusedByClaude = update({ status: 'failed', ...meta({ decisionReasonType: 'classifier', decisionReason: 'why' }) })
    for (const profile of HARNESS_PROFILES.values())
      if (profile.presetId !== 'claude-agent') expect(profile.readDenial?.(refusedByClaude)).toBeUndefined()
  })

  it("marks a Claude subagent's refused calls, and records its model's in auto mode", async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'mode', 'auto')
    await bridge.prompt(sessionId, 'delegate denied', rid())
    const detail = await settled(bridge, sessionId)
    const steps = detail.messages.find(message => message.subagent)!.subagent!.steps.filter(step => step.role === 'tool')
    expect(steps.map(step => [step.id, step.tool?.blocked?.source, step.tool?.judged?.outcome])).toEqual([
      [await childStepId(fixture, sessionId, 'call_1'), undefined, 'unasked'],
      [await childStepId(fixture, sessionId, 'call_rule'), 'rule', undefined],
      [await childStepId(fixture, sessionId, 'call_mode'), 'rule', undefined],
      [await childStepId(fixture, sessionId, 'call_model'), 'model', 'denied'],
    ])
    expect(fixture.events.filter(event => event.type === 'tool-judged' && event.outcome === 'denied')).toEqual([
      expect.objectContaining({ callHash: sha256Hex(steps[3]!.id), source: 'agent-report' }),
    ])
  })

  it('refuses a Claude Agent adapter older than the one its modes were read from', async () => {
    const bridge = await (await preset('claude-agent', { ...CLAUDE, FAKE_ACP_VERSION: '0.50.0' })).open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('未经验证（Claude Agent 适配器需要 0.99 或之后的 0.x 版本），已拒绝启动。')
  })

  it('takes a person entering and leaving Claude plan mode through its own asks as their choice, not as drift', async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'enter-plan', requestId: rid() })
    const [enter] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    expect(await bridge.decide(enter.id, 'allow')).toBe(true)
    let detail = await settled(bridge, sessionId)
    expect(detail.summary.permissionDrift).toBeFalsy()
    expect(assistants(detail).at(-1)?.text).toBe('mode=plan')
    expect(detail.permission?.expectedMode).toBe('plan')

    // The next turn stays in plan: Latch does not put the session back into Manual.
    await bridge.prompt(sessionId, 'exit-plan', rid())
    const [exit] = (await until(bridge, sessionId, item => item.approvals.length === 1)).approvals
    // The choices that would store a mode for good are not offered; leaving with a question before each edit is.
    expect(exit.options?.map(option => option.id)).toEqual(['exit-plan-default', 'reject'])
    // Shown as a plan, in full, and the plan stays on its row with how it was answered.
    expect(exit.plan).toBe('1. Do it')
    expect(await bridge.decide(exit.id, 'allow')).toBe(true)
    detail = await settled(bridge, sessionId)
    expect(detail.messages.find(message => message.tool?.plan)?.tool).toMatchObject({
      plan: '1. Do it',
      decision: { outcome: 'allowed' },
    })
    expect(detail.summary.permissionDrift).toBeFalsy()
    expect(assistants(detail).at(-1)?.text).toBe('mode=default')
    expect(detail.permission?.expectedMode).toBe('default')
    expect(modeSets(await fixture.log())).toEqual(['default'])
    // The plan and its answer are the session's record: they come back after a restart.
    await bridge.close()
    const reopened = await fixture.open()
    expect((await reopened.detail(sessionId)).messages.find(message => message.tool?.plan)?.tool).toMatchObject({
      plan: '1. Do it',
      decision: { outcome: 'allowed' },
    })
  })

  it('answers a plan only with the exit its profile names: a widening or unknown one-time allow is never offered', async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'exit-plan wide', requestId: rid() })
    const [wide] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    expect(wide.plan).toBe('1. Do it')
    expect(wide.options?.map(option => option.id)).toEqual(['exit-plan-default', 'reject'])
    expect(await bridge.decide(wide.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'exit-plan unknown', rid())
    const [unknown] = (await until(bridge, sessionId, detail => detail.approvals.length === 1)).approvals
    // Nothing allows: the plan can only be planned on.
    expect(unknown.options?.map(option => option.id)).toEqual(['reject'])
    expect(await bridge.decide(unknown.id, 'reject')).toBe(true)
    await settled(bridge, sessionId)
  })

  it('still stops a Claude session that leaves plan mode without the person', async () => {
    const fixture = await preset('claude-agent', CLAUDE)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'mode', 'plan')
    await bridge.prompt(sessionId, 'drift acceptEdits', rid())
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.permissionDrift).toBe(true)
    expect(systemText(detail)).toContain('plan → acceptEdits')
  })

  it('tells a person to sign in to Claude Code themselves, and offers no login of its own', async () => {
    const fixture = await preset('claude-agent', { ...CLAUDE, FAKE_ACP_AUTH: 'prompt' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.runEnd?.reason).toBe('login-required')
    expect(JSON.stringify(detail.messages)).toContain(
      'Fake 还没登录。在终端里按 Claude Code 自己的方式登录（或在它的设置里使用你自己的 API key）后重试。',
    )
    expect(received(await fixture.log(), 'authenticate')).toEqual([])
    const init = received(await fixture.log(), 'initialize')[0]!
    // Without a terminal-auth capability the adapter lists no login methods for Latch to offer.
    expect(JSON.stringify(init.params?.clientCapabilities)).not.toMatch(/terminal-auth|"auth"/u)
  })

  it('puts a Cursor plan to the person as an approval and answers in Cursor’s own words', async () => {
    const fixture = await preset('cursor', CURSOR)
    const bridge = await fixture.open()
    const accepted = await bridge.createTask({ prompt: 'cursor-plan', requestId: rid() })
    const [plan] = (await until(bridge, accepted.sessionId, detail => detail.approvals.length === 1)).approvals
    expect(plan).toMatchObject({
      reason: '计划：Tidy up',
      arguments: 'Two steps\n\n1. Read the code\n2. Change it',
      plan: 'Two steps\n\n1. Read the code\n2. Change it',
    })
    expect(plan.options?.map(option => [option.id, option.label])).toEqual([
      ['accept', '接受计划'],
      ['reject', '不接受'],
    ])
    expect(await bridge.decide(plan.id, 'allow')).toBe(true)
    expect(assistants(await settled(bridge, accepted.sessionId)).at(-1)?.text).toBe('plan=accepted')

    await bridge.prompt(accepted.sessionId, 'cursor-plan', rid())
    const [again] = (await until(bridge, accepted.sessionId, detail => detail.approvals.length === 1)).approvals
    expect(await bridge.decide(again.id, 'reject')).toBe(true)
    const kept = await settled(bridge, accepted.sessionId)
    expect(assistants(kept).at(-1)?.text).toBe('plan=rejected')
    expect(kept.messages.filter(message => message.tool?.plan).map(message => message.tool?.decision?.outcome)).toEqual([
      'allowed',
      'rejected',
    ])

    await bridge.prompt(accepted.sessionId, 'cursor-plan', rid())
    await until(bridge, accepted.sessionId, detail => detail.approvals.length === 1)
    await bridge.cancel(accepted.sessionId)
    await settled(bridge, accepted.sessionId)
    const replies = received(await fixture.log(), null)
      .map(entry => entry.result?.outcome)
      .filter(Boolean)
    expect(replies).toEqual([{ outcome: 'accepted' }, { outcome: 'rejected' }, { outcome: 'cancelled' }])
  })

  it('starts Cursor force only when chosen, retains explicit denies, and removes the flag when switching to a read-only mode', async () => {
    const fixture = await preset('cursor', { ...CURSOR, FAKE_ACP_CAPS: 'resume', FAKE_CURSOR_STARTUP: '1' }, { idleMs: 60_000 })
    let bridge = await fixture.open()
    const normal = await bridge.createTask({ prompt: 'cursor-command', requestId: rid() })
    const waiting = await until(bridge, normal.sessionId, detail => detail.approvals.length === 1)
    expect((await fixture.log()).filter(entry => entry.event === 'start').at(-1)?.argv).not.toContain('--force')
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    await settled(bridge, normal.sessionId)

    const force = await bridge.createTask({
      prompt: 'cursor-command',
      requestId: rid(),
      config: [{ configId: '~mode', value: 'agent-force' }],
    })
    let detail = await settled(bridge, force.sessionId)
    expect(assistants(detail).at(-1)?.text).toBe('allowed')
    expect(detail.config?.find(option => option.id === 'mode')).toMatchObject({ currentValue: 'agent-force', source: 'launch' })
    expect(detail.permission?.readback).toBe('none')
    expect(detail.approvals).toHaveLength(0)
    expect((await fixture.log()).filter(entry => entry.event === 'start').at(-1)?.argv).toContain('--force')
    expect(await bridge.readConfig!(force.sessionId, 'mode', 'agent-force')).toEqual({ kind: 'unread' })
    await bridge.prompt(force.sessionId, 'cursor-command deny', rid())
    expect(assistants(await settled(bridge, force.sessionId)).at(-1)?.text).toBe('rejected')
    await bridge.close()
    bridge = await fixture.open()
    await bridge.prompt(force.sessionId, 'cursor-command restored', rid())
    expect(assistants(await settled(bridge, force.sessionId)).at(-1)?.text).toBe('allowed')
    await bridge.setConfig!(force.sessionId, 'mode', 'ask')
    await bridge.prompt(force.sessionId, 'cursor-command read-only', rid())
    detail = await settled(bridge, force.sessionId)
    expect(assistants(detail).at(-1)?.text).toBe('rejected')
    expect(detail.config?.find(option => option.id === 'mode')).toMatchObject({ currentValue: 'ask' })
    expect(detail.permission?.readback).toBe('mode')
    expect((await fixture.log()).filter(entry => entry.event === 'start').at(-1)?.argv).toEqual(expect.arrayContaining(['--mode', 'ask']))
    expect((await fixture.log()).filter(entry => entry.event === 'start').at(-1)?.argv).not.toContain('--force')
    expect((await fixture.log()).filter(entry => entry.event === 'cursor-command').map(entry => entry.executed)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ])
  })

  it('says a Cursor question was skipped, shows it in the session, and turns its todos into the plan', async () => {
    const fixture = await preset('cursor', CURSOR)
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'cursor-ask', requestId: rid() })
    let detail = await settled(bridge, sessionId)
    expect(assistants(detail).at(-1)?.text).toBe('ask=skipped')
    expect(systemText(detail)).toContain('Fake 问：Which one?\n- Pick a colour（Red / Blue）\nLatch 不能在这里回答这个提问')
    expect(systemText(detail)).not.toContain('看不懂')

    await bridge.prompt(sessionId, 'cursor-todos', rid())
    detail = await settled(bridge, sessionId)
    expect(detail.plan).toEqual([
      { content: 'Read', status: 'completed' },
      { content: 'Write', status: 'completed' },
      { content: 'Ship', status: 'pending' },
    ])
  })

  it('reads a Cursor question from any harness, and without a Host to ask it says what it asked', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'cursor-ask', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    expect(assistants(detail).at(-1)?.text).toBe('ask=skipped')
    expect(systemText(detail)).toContain('Fake 问：Which one?')
  })

  it('names an unknown request and says it is not supported, and offers no question form it cannot show', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'elicit', requestId: rid() })
    const detail = await settled(bridge, sessionId)
    // Without a Host to put it to the person, elicitation is neither offered nor understood.
    expect(assistants(detail).at(-1)?.text).toBe('elicit=error -32601')
    expect(systemText(detail)).toContain('Fake 发来请求 elicitation/create：Latch 不支持这个请求')
    expect(systemText(detail)).not.toContain('看不懂')
  })

  it('never finds the vendors’ programs on the Host’s PATH without the start script’s search', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'latch-vendor-bin-'))
    cleanups.push(() => rm(bin, { recursive: true, force: true }))
    for (const command of ['claude-agent-acp', 'claude', 'cursor-agent', 'agent']) await installCommand(bin, command)
    hostEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` })
    setCommandSearch(undefined)
    for (const command of ['claude-agent-acp', 'claude', 'cursor-agent', 'agent']) expect(resolveCommand(command)).toBeUndefined()
    setCommandSearch(() => [bin])
    expect(resolveCommand('cursor-agent')).toBe(join(bin, 'cursor-agent'))
  })
})

describe('sessions on a model service through the gateway', () => {
  /** OpenCode's preset on the fake agent: a Harness pointed at the gateway by what its launch is given. */
  const LAUNCHED = {
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'plan,build,auto-edit,yolo',
    FAKE_ACP_INITIAL_MODE: 'build',
    FAKE_ACP_VERSION: '2.2.6',
    FAKE_ACP_GATEWAY: 'opencode',
  }
  const CODEX = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'read-only,workspace-write', FAKE_ACP_INITIAL_MODE: 'read-only' }

  async function dshCommand(version = '0.2.2-rc.1'): Promise<Partial<AgentRecord> & { command: string }> {
    const bin = await mkdtemp(join(tmpdir(), 'latch-dsh-gateway-version-'))
    cleanups.push(() => rm(bin, { recursive: true, force: true }))
    const command = join(bin, 'dsh')
    await writeFile(
      command,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
    )
    await chmod(command, 0o755)
    setLoginPrograms(name => (name === 'dsh' ? command : undefined))
    return { command, args: [] }
  }

  it('binds text-only DSH consultations to one process and cannot replay them as ordinary prompts', async () => {
    const fake = await dshCommand('0.2.2-rc.5')
    setCommandSearch(() => [dirname(fake.command)])
    const fixture = await setup(
      { FAKE_ACP_PROCESS_MODE: '1', FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close' },
      {},
      { ...fake, args: ['--profile', 'acp'], presetId: 'dsh', confirmedCommand: fake.command },
    )
    const bridge = await fixture.open()
    expect(bridge.canReceiveConsultation?.()).toBe(true)
    const agentContext = { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', revision: 'a'.repeat(64) }
    const evidence: ConsultationGuardEvidence[] = []
    const recordConsultationGuard = async (value: ConsultationGuardEvidence) => {
      evidence.push(value)
    }
    const guarded = { consultation: true as const, authorizeConsultation: () => {}, recordConsultationGuard }
    const { sessionId } = await bridge.createTask({
      ...guarded,
      agentContext,
      config: [
        { configId: 'model', value: 'large' },
        { configId: 'effort', value: 'high' },
      ],
      prompt: 'echo first',
      requestId: rid(),
    })
    const first = await settled(bridge, sessionId)
    expect(first.summary.status).toBe('idle')
    expect(first.config?.find(item => item.id === 'model')?.currentValue).toBe('large')
    expect(first.config?.find(item => item.id === 'effort')?.currentValue).toBe('high')
    const requestId = rid()
    await bridge.prompt(sessionId, 'only-always', requestId, guarded)
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    await bridge.prompt(sessionId, 'only-always', requestId, guarded)
    await expect(bridge.prompt(sessionId, 'only-always', requestId)).rejects.toMatchObject({ code: 'request-conflict' })
    await bridge.prompt(sessionId, 'echo human', rid())
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    const log = await fixture.log()
    // Even a client request outside DSH's tool pipeline cannot reuse an always-allow choice.
    expect(answers(log)).toEqual([{ outcome: 'cancelled' }])
    const prompts = received(log, 'session/prompt')
    expect(new Set(prompts.map(item => item.pid)).size).toBe(3)
    expect(evidence).toHaveLength(2)
    expect(new Set(evidence.map(item => item.executionId)).size).toBe(2)
    for (const item of evidence)
      expect(item).toMatchObject({ sessionId, version: 1, executionId: expect.stringMatching(/^[a-f0-9]{64}$/u) })

    expect(log.filter(item => item.event === 'prompt-mode').map(item => item.textOnly)).toEqual([true, true, false])
    for (const item of prompts.slice(0, 2)) {
      const open = log.find(row => row.pid === item.pid && /session\/(?:new|load|resume)/u.test(row.method ?? ''))
      expect(open?.params?.mcpServers).toEqual([])
    }
  })

  it('does not open a DSH chat or send its prompt when authorization expires during initialize', async () => {
    const fake = await dshCommand('0.2.2-rc.5')
    setCommandSearch(() => [dirname(fake.command)])
    const fixture = await setup(
      { FAKE_ACP_PROCESS_MODE: '1', FAKE_ACP_INIT_DELAY: '300' },
      {},
      { ...fake, args: ['--profile', 'acp'], presetId: 'dsh', confirmedCommand: fake.command },
    )
    const bridge = await fixture.open()
    let allowed = true
    const { sessionId } = await bridge.createTask({
      agentContext: { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', revision: 'a'.repeat(64) },
      consultation: true,
      recordConsultationGuard: async () => {},
      authorizeConsultation: () => {
        if (!allowed) throw new Error('Consent expired')
      },
      prompt: 'echo after revocation',
      requestId: rid(),
    })
    await vi.waitFor(async () => expect(received(await fixture.log(), 'initialize')).toHaveLength(1), { interval: 5 })
    allowed = false
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    const log = await fixture.log()
    expect(received(log, 'session/new')).toHaveLength(0)
    expect(received(log, 'session/prompt')).toHaveLength(0)
  })

  it.each(['failed audit', 'withdrawn consent'])('sends no DSH prompt after %s at the verified guard', async failure => {
    const fake = await dshCommand('0.2.2-rc.5')
    setCommandSearch(() => [dirname(fake.command)])
    const fixture = await setup(
      { FAKE_ACP_PROCESS_MODE: '1', FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close' },
      {},
      { ...fake, args: ['--profile', 'acp'], presetId: 'dsh', confirmedCommand: fake.command },
    )
    const bridge = await fixture.open()
    let allowed = true
    const record = vi.fn(async () => {
      if (failure === 'failed audit') throw new Error('Audit unavailable')
      allowed = false
    })
    const { sessionId } = await bridge.createTask({
      agentContext: { agent: { customAgentId: 'agt_' + randomUUID() }, instructions: '', revision: 'a'.repeat(64) },
      consultation: true,
      recordConsultationGuard: record,
      authorizeConsultation: () => {
        if (!allowed) throw new Error('Consent withdrawn')
      },
      prompt: 'echo must not reach the model',
      requestId: rid(),
    })
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    expect(record).toHaveBeenCalledOnce()
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
  })

  it.each(['missing', 'stale'])('withholds a DSH consultation with %s process guard evidence', async proof => {
    const fake = await dshCommand('0.2.2-rc.5')
    setCommandSearch(() => [dirname(fake.command)])
    const fixture = await setup(
      { FAKE_ACP_PROCESS_MODE: '1', FAKE_ACP_CONSULTATION_PROOF: proof, FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close' },
      {},
      { ...fake, args: ['--profile', 'acp'], presetId: 'dsh', confirmedCommand: fake.command },
    )
    const bridge = await fixture.open()
    const agentContext = { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', revision: 'a'.repeat(64) }
    const recordConsultationGuard = vi.fn(async () => {})
    const { sessionId } = await bridge.createTask({
      agentContext,
      consultation: true,
      recordConsultationGuard,
      authorizeConsultation: () => {},
      prompt: 'echo withheld',
      requestId: rid(),
    })
    expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(0)
    expect(recordConsultationGuard).not.toHaveBeenCalled()
  })

  /** Stands in for the Host's gateway: the fake service itself, with a token that only it is told to expect. */
  function gateway(models: FakeModels, allowedModels = ['fake-model', 'fake-model-large']) {
    const leases: Array<{ sessionId: string; token: string; closed: boolean; closes: number }> = []
    let usable = true
    /** Requests of the next turn taken still under way, as the gateway counts them when a turn ends before its replies. */
    let open = 0
    const access: ModelGateway = {
      open({ sessionId, route }) {
        const lease = { sessionId, token: `lmg1.${randomUUID().replaceAll('-', '')}${'t'.repeat(11)}`, closed: false, closes: 0 }
        leases.push(lease)
        const mine = () => models.requests.filter(request => request.key === lease.token)
        let taken = 0
        return {
          baseURL: route.wire === 'responses' || route.wire === 'chat-completions' ? `${models.origin}/v1` : models.origin,
          token: lease.token,
          requests: () => mine().length,
          // By the model each request named, as the gateway counts them; what the replies said is the gateway's own test.
          takeTurn: () => {
            const fresh = mine().slice(taken)
            taken += fresh.length
            const counts = new Map<string, number>()
            for (const request of fresh) counts.set(request.model ?? '', (counts.get(request.model ?? '') ?? 0) + 1)
            const models = [...counts].map(([model, requests], index) => ({ model, requests, ...(index === 0 && open ? { open } : {}) }))
            if (fresh.length) open = 0
            return { requests: fresh.length, models }
          },
          models: allowedModels,
          active: () => usable && !lease.closed,
          close: () => {
            lease.closes++
            lease.closed = true
          },
        }
      },
    }
    return {
      access,
      leases,
      revoke() {
        usable = false
      },
      leaveOpen(count: number) {
        open = count
      },
    }
  }

  async function routed(
    presetId: string,
    env: Record<string, string>,
    route: Omit<ModelRoute, 'origin'>,
    options: AcpAgentOptions = {},
    host: Pick<HarnessHostOptions, 'turnEnded'> = {},
  ) {
    const models = await startFakeModels({ replies: [{ text: 'from the service' }] })
    cleanups.push(() => models.close())
    const stub = gateway(models)
    const events: HarnessSecurityEvent[] = []
    const fixture = await setup(
      { ...env, FAKE_ACP_DUMP_ENV: '1' },
      { idleMs: 60_000, ...options },
      { presetId, ...(presetId === 'dsh' ? await dshCommand() : {}) },
      { modelGateway: stub.access, securityEvent: event => void events.push(event), ...host },
    )
    return { fixture, models, stub, events, route: { ...route, origin: models.origin } satisfies ModelRoute }
  }

  const envOf = (log: LogEntry[]) => log.filter(entry => entry.event === 'env').map(entry => entry.env as Record<string, string>)

  it('checks the Claude binary behind the adapter on every gateway spawn and leaves its own model route usable', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'latch-claude-gateway-version-'))
    cleanups.push(() => rm(bin, { recursive: true, force: true }))
    const command = join(bin, 'claude-agent-acp')
    const version = join(bin, 'version')
    await writeFile(version, '2.1.318 (Claude Code)')
    await writeFile(
      command,
      `#!/bin/sh\nif [ "$1" = --cli ] && [ "$2" = --version ]; then cat '${version}'; exit 0; fi\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
    )
    await chmod(command, 0o755)
    setLoginPrograms(name => (name === 'claude-agent-acp' ? command : undefined))
    const models = await startFakeModels({ replies: [{ text: 'must not be requested' }] })
    cleanups.push(() => models.close())
    const stub = gateway(models)
    const fixture = await setup(
      {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_VERSION: '0.101.0',
        FAKE_ACP_MODELS: 'fake-model,fake-model-large',
        FAKE_ACP_MODES: 'default,plan,acceptEdits,auto,bypassPermissions',
        FAKE_ACP_INITIAL_MODE: 'default',
      },
      {},
      { presetId: 'claude-agent', command, args: [] },
      { modelGateway: stub.access },
    )
    const bridge = await fixture.open()
    const modelRoute = { providerId: 'svc', model: 'fake-model', wire: 'anthropic-messages' as const, origin: models.origin }
    const accepted = await bridge.createTask({ prompt: 'plan', requestId: rid(), modelRoute })
    const acceptedDetail = await settled(bridge, accepted.sessionId)
    expect(acceptedDetail.summary.status, systemText(acceptedDetail)).toBe('idle')
    expect(acceptedDetail.usageReport?.contextUsed).toBe(10)
    expect(acceptedDetail.usageReport?.contextSize).toBeUndefined()
    expect(acceptedDetail.usageReport?.cost).toBeUndefined()
    const settings = received(await fixture.log(), 'session/new')[0]!.params?._meta
    expect(settings).toEqual({
      claudeCode: {
        options: {
          settings: {
            apiKeyHelper: '',
            availableModels: ['fake-model', 'fake-model-large'],
            modelPicker: {
              replaceBuiltInOptions: true,
              options: [
                { model: 'fake-model', label: 'fake-model' },
                { model: 'fake-model-large', label: 'fake-model-large' },
              ],
            },
          },
        },
      },
    })
    expect(JSON.stringify(settings)).not.toContain('lmg1.')
    // Replacing the SDK's binary need not change the adapter entry point: a cached success cannot prove it still works.
    for (const value of ['2.1.317 (Claude Code)', '0.101.0']) {
      await writeFile(version, value)
      const attempted = await bridge.createTask({ prompt: 'model must not run', requestId: rid(), modelRoute })
      const refused = await settled(bridge, attempted.sessionId)
      expect(refused.summary.status).toBe('failed')
      expect(systemText(refused)).toContain('需要 2.1.318 或更高版本')
    }
    const native = await bridge.createTask({ prompt: 'echo native', requestId: rid() })
    expect((await settled(bridge, native.sessionId)).summary.status).toBe('idle')
    expect(received(await fixture.log(), 'session/new').at(-1)?.params).not.toHaveProperty('_meta')
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(2)
    expect(models.requests).toHaveLength(0)
    await bridge.close()
    expect(stub.leases.every(lease => lease.closed)).toBe(true)
  })

  it('says what the service said on a routed turn that failed in the harness’s own words, once, and keeps it out of the turn', async () => {
    const models = await startFakeModels({ replies: [{ text: 'not asked' }] })
    cleanups.push(() => models.close())
    const queue = join(await mkdtemp(join(tmpdir(), 'latch-routed-failure-')), 'queue.json')
    cleanups.push(() => rm(dirname(queue), { recursive: true, force: true }))
    await writeFile(
      queue,
      JSON.stringify([
        { error: 'We are currently experiencing high demand', code: -32603 },
        { error: 'The server had an error (500)', code: -32603 },
      ]),
    )
    const said = ['500 The server had an error', '500 The server had an error']
    const access: ModelGateway = {
      open: () => ({
        baseURL: `${models.origin}/v1`,
        token: `lmg1.${randomUUID().replaceAll('-', '')}${'t'.repeat(11)}`,
        requests: () => 1,
        takeTurn: () => ({ requests: 1, models: [{ model: 'fake-model', requests: 1, failed: 1 }], failure: said.shift() }),
        models: ['fake-model'],
        active: () => true,
        close: () => {},
      }),
    }
    const fixture = await setup(
      { ...LAUNCHED, FAKE_ACP_CAPS: 'resume', FAKE_ACP_REPLY_QUEUE: queue },
      { idleMs: 60_000 },
      { presetId: 'opencode' },
      { modelGateway: access },
    )
    const bridge = await fixture.open()
    const route = { providerId: 'svc', model: 'fake-model', wire: 'chat-completions', origin: models.origin } as const
    const { sessionId } = await bridge.createTask({ prompt: 'hello', requestId: rid(), modelRoute: route })
    let detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('模型服务：500 The server had an error')
    const prompt = detail.messages.find(message => message.role === 'user')!
    expect(prompt.turn?.routed).toEqual({ requests: 1, models: [{ model: 'fake-model', requests: 1, failed: 1 }], chosen: 'fake-model' })
    // A harness that already said the service's words gets no second line of them.
    await bridge.prompt(sessionId, 'again', rid())
    detail = await settled(bridge, sessionId)
    expect(systemText(detail).match(/The server had an error/gu), systemText(detail)).toHaveLength(2)
    await bridge.close()
  })

  it('refuses a gateway on an older OpenCode report while its native model route remains usable', async () => {
    const { fixture, stub, route, models } = await routed(
      'opencode',
      {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_VERSION: '1.15.5',
        FAKE_ACP_MODES: 'plan,build',
        FAKE_ACP_INITIAL_MODE: 'build',
      },
      { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' },
    )
    const bridge = await fixture.open()
    const native = await bridge.createTask({ prompt: 'echo native', requestId: rid() })
    expect((await settled(bridge, native.sessionId)).summary.status).toBe('idle')
    const attempted = await bridge.createTask({ prompt: 'model must not run', requestId: rid(), modelRoute: route })
    const refused = await settled(bridge, attempted.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('需要 2.2.6 或更高版本')
    expect(models.requests).toHaveLength(0)
    expect(received(await fixture.log(), 'session/prompt')).toHaveLength(1)
    await bridge.close()
    expect(stub.leases.every(lease => lease.closed)).toBe(true)
  })

  it('refuses a pi gateway wrapper whose version neither the official command nor its RPC can verify', async () => {
    const models = await startFakeModels({ replies: [{ text: 'must not be requested' }] })
    cleanups.push(() => models.close())
    const stub = gateway(models)
    const fixture = await setup(
      { FAKE_PI_GATEWAY: '1', PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' },
      {},
      { presetId: 'pi', args: [FAKE_PI_AGENT] },
      { modelGateway: stub.access },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'model must not run',
      requestId: rid(),
      modelRoute: { providerId: 'svc', model: 'fake-model', wire: 'responses', origin: models.origin },
    })
    const refused = await settled(bridge, sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('当前版本无法确认')
    expect(models.requests).toHaveLength(0)
    await bridge.close()
    expect(stub.leases.every(lease => lease.closed)).toBe(true)
  })

  it('requires a dsh CLI version for the gateway even when a wrapper reports an ACP application version', async () => {
    const models = await startFakeModels({ replies: [{ text: 'must not be requested' }] })
    cleanups.push(() => models.close())
    const stub = gateway(models)
    const fixture = await setup(
      {
        FAKE_ACP_PROCESS_MODE: '1',
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_VERSION: '0.2.2-rc.1',
        FAKE_ACP_MODES: 'read-only,workspace-write,danger-full-access',
        FAKE_ACP_INITIAL_MODE: 'read-only',
      },
      {},
      { presetId: 'dsh' },
      { modelGateway: stub.access },
    )
    const bridge = await fixture.open()
    const native = await bridge.createTask({ prompt: 'echo native', requestId: rid() })
    expect((await settled(bridge, native.sessionId)).summary.status).toBe('idle')
    const attempted = await bridge.createTask({
      prompt: 'model must not run',
      requestId: rid(),
      modelRoute: { providerId: 'svc', model: 'fake-model', wire: 'responses', origin: models.origin },
    })
    const refused = await settled(bridge, attempted.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('当前版本无法确认')
    expect(models.requests).toHaveLength(0)
    await bridge.close()
    expect(stub.leases.every(lease => lease.closed)).toBe(true)
  })

  it.skipIf(process.platform === 'win32').each(['responses', 'chat-completions', 'anthropic-messages'] as const)(
    'keeps pi gateway model identity and the original CLI configuration through changes and recovery over %s',
    async wire => {
      const models = await startFakeModels({ replies: [{ text: 'pi service answer' }] })
      cleanups.push(() => models.close())
      const stub = gateway(models)
      const sessions = await mkdtemp(join(tmpdir(), 'latch-pi-routed-'))
      cleanups.push(() => rm(sessions, { recursive: true, force: true }))
      const command = join(sessions, 'pi')
      const home = join(sessions, 'home')
      const piHome = join(home, '.pi', 'agent')
      const log = join(sessions, 'pi.log')
      await seedCliFiles(home, {
        '.pi/agent/settings.json': '{"defaultProvider":"openai","defaultModel":"gpt-5.5","defaultThinkingLevel":"low"}\n',
        '.pi/agent/extensions/user-extension.ts': 'export default function fixture() {}\n',
        '.zshrc': '# fixture shell configuration\n',
      })
      await fakeCli(command, FAKE_PI_AGENT, home, { PI_CODING_AGENT_DIR: piHome })
      setLoginPrograms(name => (name === 'pi' ? command : undefined))
      const fixture = await setup(
        {
          FAKE_PI_GATEWAY: '1',
          FAKE_PI_LOG: log,
          FAKE_PI_SESSIONS: sessions,
          PI_GATEWAY_CONTEXT_TOKENS: '32768',
          PI_GATEWAY_OUTPUT_TOKENS: '4096',
        },
        {},
        { presetId: 'pi', command, args: [] },
        {
          modelGateway: {
            open(input) {
              return {
                ...stub.access.open(input),
                modelCapabilities: { 'fake-model-large': { thinking: ['low', 'high'], contextTokens: 64_000 } },
              }
            },
          },
        },
      )
      await seedCliFiles(fixture.workspace, {
        '.pi/settings.json': '{"defaultThinkingLevel":"minimal"}\n',
        '.pi/extensions/project-extension.ts': 'export default function fixture() {}\n',
      })
      const original = await Promise.all([cliTree(home), cliTree(fixture.workspace)])
      const route: ModelRoute = { providerId: 'svc', model: 'fake-model', wire, origin: models.origin }
      let bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
      let detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(assistants(detail).at(-1)?.text).toBe('model: pi service answer')
      const option = detail.config?.find(item => item.category === 'model')
      expect(option?.options.map(item => item.value)).toEqual(['latch-gateway/fake-model', 'latch-gateway/fake-model-large'])
      expect(detail.usageReport?.contextSize).toBeUndefined()
      expect(detail.usageReport?.cost).toBeUndefined()
      expect(await Promise.all([cliTree(home), cliTree(fixture.workspace)])).toEqual(original)
      const generated = (await cliTree(fixture.tmpRoot)).filter(entry => entry.name.endsWith('.ts') || entry.name.endsWith('.json'))
      expect(generated.map(entry => [entry.name.split('/').at(-1), entry.mode & 0o777n]).sort()).toEqual([
        ['latch-permission.ts', 0o600n],
        ['pi-gateway.json', 0o600n],
        ['pi-gateway.ts', 0o600n],
      ])
      await expect(bridge.setConfig!(sessionId, option!.id, 'openai/fake-model-large')).rejects.toMatchObject({ status: 400 })
      await bridge.setConfig!(sessionId, option!.id, 'latch-gateway/fake-model-large')
      const thinking = (await bridge.detail(sessionId)).config?.find(option => option.category === 'thought_level')
      await bridge.setConfig!(sessionId, thinking!.id, 'high')
      await bridge.setConfig!(sessionId, 'mode', 'plan')
      expect((await bridge.detail(sessionId)).permission?.expectedMode).toBe('plan')
      await bridge.prompt(sessionId, 'fail deliberately', rid())
      expect((await settled(bridge, sessionId)).summary.status).toBe('failed')
      expect(await Promise.all([cliTree(home), cliTree(fixture.workspace)])).toEqual(original)
      await bridge.close()
      bridge = await fixture.open()
      await bridge.prompt(sessionId, 'model restored', rid())
      detail = await settled(bridge, sessionId)
      expect(detail.config?.find(item => item.category === 'model')?.currentValue).toBe('latch-gateway/fake-model-large')
      expect(detail.usageReport).toMatchObject({ contextSize: 64_000, configuredContextSize: true })
      expect(detail.messages.findLast(message => message.role === 'user')?.turn?.contextWindow?.size).toBeUndefined()
      expect(detail.config?.find(item => item.category === 'thought_level')?.currentValue).toBe('high')
      expect(detail.permission?.expectedMode).toBe('plan')
      expect(assistants(detail).at(-1)?.text).toBe('model: pi service answer')
      expect(models.requests.map(request => ({ model: request.model, wire: request.wire }))).toEqual([
        { model: 'fake-model', wire },
        { model: 'fake-model-large', wire },
      ])
      await bridge.close()
      expect(stub.leases.every(lease => lease.closed)).toBe(true)
      const trace = await readFile(log, 'utf8')
      expect(trace).toContain('"type":"switch_session"')
      expect(trace).toContain('"type":"set_model"')
      expect(trace).toContain('"type":"set_thinking_level"')
      expect(await Promise.all([cliTree(home), cliTree(fixture.workspace)])).toEqual(original)
    },
  )

  it.each(['opencode', 'dsh'])(
    'keeps %s on its declared service model through changes and process restoration over every supported wire',
    async presetId => {
      for (const wire of ['responses', 'chat-completions', 'anthropic-messages'] as const) {
        const env: Record<string, string> =
          presetId === 'dsh'
            ? {
                FAKE_ACP_PROCESS_MODE: '1',
                FAKE_ACP_MODES: 'read-only,workspace-write,danger-full-access',
                FAKE_ACP_INITIAL_MODE: 'read-only',
              }
            : { FAKE_ACP_MODES: 'plan,build,auto-edit,yolo', FAKE_ACP_INITIAL_MODE: 'build' }
        const { fixture, models, stub, route } = await routed(
          presetId,
          {
            ...env,
            FAKE_ACP_CONFIG: 'options',
            FAKE_ACP_CAPS: 'resume',
            FAKE_ACP_VERSION: presetId === 'dsh' ? '0.2.2-rc.1' : '2.2.6',
            FAKE_ACP_GATEWAY: presetId,
          },
          { providerId: 'svc', model: 'fake-model', wire },
        )
        const value = (id: string) => (presetId === 'opencode' ? `latch/${id}` : JSON.stringify(['latch-gateway', id]))
        let bridge = await fixture.open()
        const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
        let detail = await settled(bridge, sessionId)
        expect(detail.summary.status).toBe('idle')
        expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
        const model = detail.config?.find(option => option.category === 'model')
        expect(model?.currentValue).toBe(value('fake-model'))
        expect(model?.options.map(option => option.value)).toEqual([value('fake-model'), value('fake-model-large')])
        await expect(bridge.setConfig!(sessionId, model!.id, 'other/fake-model-large')).rejects.toMatchObject({ status: 400 })
        await bridge.setConfig!(sessionId, model!.id, value('fake-model-large'))
        await bridge.close()
        bridge = await fixture.open()
        await bridge.prompt(sessionId, 'model restored', rid())
        detail = await settled(bridge, sessionId)
        expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe(value('fake-model-large'))
        expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
        expect(models.requests.map(request => ({ model: request.model, wire: request.wire }))).toEqual([
          { model: 'fake-model', wire },
          { model: 'fake-model-large', wire },
        ])
        expect(models.requests.map(request => request.key)).toEqual(stub.leases.map(lease => lease.token))
        await bridge.close()
        expect(stub.leases.every(lease => lease.closed)).toBe(true)
      }
    },
  )

  describe('moving a session to another route', () => {
    /** A gateway whose services each have their own models; `broken` refuses every token, as a service gone since. */
    function services(models: FakeModels) {
      const leases: Array<{ providerId: string; token: string; closed: boolean }> = []
      const lists: Record<string, string[]> = { svc: ['fake-model', 'fake-model-large'], other: ['other-model'] }
      const access: ModelGateway = {
        open({ sessionId: _session, route }) {
          if (route.providerId === 'broken') throw new AppError(409, 'model-route-unavailable', '这个模型服务现在不能用。')
          const lease = { providerId: route.providerId, token: `lmg1.${randomUUID().replaceAll('-', '')}${'t'.repeat(11)}`, closed: false }
          leases.push(lease)
          const mine = () => models.requests.filter(request => request.key === lease.token)
          let taken = 0
          return {
            baseURL: `${models.origin}/v1`,
            token: lease.token,
            requests: () => mine().length,
            takeTurn: () => {
              const fresh = mine().slice(taken)
              taken += fresh.length
              return { requests: fresh.length, models: fresh.length ? [{ model: fresh[0]!.model ?? '', requests: fresh.length }] : [] }
            },
            models: lists[route.providerId] ?? [],
            active: () => !lease.closed,
            close: () => {
              lease.closed = true
            },
          }
        },
      }
      return { access, leases }
    }

    async function moving(env: Record<string, string> = {}) {
      const models = await startFakeModels({ replies: [{ text: 'from the service' }] })
      cleanups.push(() => models.close())
      const stub = services(models)
      const turns: Array<{ model?: string }> = []
      const fixture = await setup(
        { ...LAUNCHED, FAKE_ACP_CAPS: 'resume', ...env },
        { idleMs: 60_000 },
        { presetId: 'opencode' },
        { modelGateway: stub.access, turnEnded: turn => void turns.push(turn) },
      )
      const routeTo = (providerId: string, model: string): ModelRoute => ({
        providerId,
        model,
        wire: 'chat-completions',
        origin: models.origin,
      })
      return { models, stub, turns, fixture, routeTo }
    }

    it('moves between its own login and services, each turn on the route it ran on', async () => {
      const { models, stub, turns, fixture, routeTo } = await moving()
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'own first', requestId: rid() })
      let detail = await settled(bridge, sessionId)
      const modelId = detail.config!.find(option => option.category === 'model')!.id
      expect(detail.summary.modelRoute).toBeUndefined()
      expect(turns).toHaveLength(1)

      // Own → service: the process restarts on the route, the session resumes, the model is set and read back.
      await bridge.setConfig!(sessionId, modelId, serviceChoice({ providerId: 'svc', model: 'fake-model-large' }), {
        route: routeTo('svc', 'fake-model-large'),
      })
      detail = await bridge.detail(sessionId)
      expect(detail.summary.modelRoute).toMatchObject({ providerId: 'svc', model: 'fake-model-large' })
      expect(detail.config!.find(option => option.category === 'model')?.currentValue).toBe('latch/fake-model-large')
      expect(systemText(detail)).toContain('模型改为 fake-model-large · 经 Latch')
      await expect(
        bridge.readConfig!(sessionId, modelId, serviceChoice({ providerId: 'svc', model: 'fake-model-large' })),
      ).resolves.toEqual({
        kind: 'read',
        currentValue: 'latch/fake-model-large',
        asked: true,
      })
      await bridge.prompt(sessionId, 'model on the service', rid())
      detail = await settled(bridge, sessionId)
      expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
      expect(models.requests.map(request => ({ model: request.model, key: request.key }))).toEqual([
        { model: 'fake-model-large', key: stub.leases[0]!.token },
      ])
      // Its turn is in the gateway's ledger, not the record of turns on the Harness's own login.
      expect(turns).toHaveLength(1)

      // Service → service: the first service's token ends with its process.
      await bridge.setConfig!(sessionId, modelId, serviceChoice({ providerId: 'other', model: 'other-model' }), {
        route: routeTo('other', 'other-model'),
      })
      expect(stub.leases.map(lease => ({ providerId: lease.providerId, closed: lease.closed }))).toEqual([
        { providerId: 'svc', closed: true },
        { providerId: 'other', closed: false },
      ])
      await bridge.prompt(sessionId, 'model on the other', rid())
      detail = await settled(bridge, sessionId)
      expect(models.requests.at(-1)).toMatchObject({ model: 'other-model', key: stub.leases[1]!.token })
      expect(detail.summary.modelRoute).toMatchObject({ providerId: 'other', model: 'other-model' })

      // Service → own: every token is gone, and the next turn is the Harness's own again.
      await bridge.setConfig!(sessionId, modelId, ownChoice('large'))
      detail = await bridge.detail(sessionId)
      expect(stub.leases.every(lease => lease.closed)).toBe(true)
      expect(detail.summary.modelRoute).toBeUndefined()
      expect(detail.config!.find(option => option.category === 'model')?.currentValue).toBe('large')
      expect(systemText(detail)).toContain('模型改为 Large')
      const served = models.requests.length
      await bridge.prompt(sessionId, 'model own again', rid())
      detail = await settled(bridge, sessionId)
      expect(models.requests).toHaveLength(served)
      expect(turns).toHaveLength(2)
    })

    it('answers 核对 only once a move has settled, from the route on record', async () => {
      const { fixture, routeTo } = await moving({ FAKE_ACP_RESUME_DELAY: '400' })
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'own first', requestId: rid() })
      await settled(bridge, sessionId)
      const modelId = (await bridge.detail(sessionId)).config!.find(option => option.category === 'model')!.id
      const choice = serviceChoice({ providerId: 'svc', model: 'fake-model' })
      const move = bridge.setConfig!(sessionId, modelId, choice, { route: routeTo('svc', 'fake-model') })
      await vi.waitFor(async () =>
        expect(await bridge.readConfig!(sessionId, modelId, choice)).toEqual({ kind: 'busy', reason: 'running' }),
      )
      await expect(bridge.prompt(sessionId, 'model too soon', rid())).rejects.toMatchObject({ status: 409 })
      await move
      await expect(bridge.readConfig!(sessionId, modelId, choice)).resolves.toMatchObject({ kind: 'read', asked: true })
    })

    it('lets a move settle before the session is deleted, with its process and token gone', async () => {
      const { stub, fixture, routeTo } = await moving({ FAKE_ACP_RESUME_DELAY: '400' })
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'own first', requestId: rid() })
      await settled(bridge, sessionId)
      const modelId = (await bridge.detail(sessionId)).config!.find(option => option.category === 'model')!.id
      const move = bridge.setConfig!(sessionId, modelId, serviceChoice({ providerId: 'svc', model: 'fake-model' }), {
        route: routeTo('svc', 'fake-model'),
      })
      await vi.waitFor(() => expect(stub.leases).toHaveLength(1))
      await bridge.remove!(sessionId)
      await expect(move).resolves.toBeUndefined()
      await expect(bridge.detail(sessionId)).rejects.toMatchObject({ status: 404 })
      await vi.waitFor(() => expect(stub.leases.every(lease => lease.closed)).toBe(true))
      expect(fixture.diagnostics.join('\n')).not.toContain('没能退回')
    })

    it('goes back to the route it left when the Host stopped in the middle of a move', async () => {
      const { models, stub, fixture, routeTo } = await moving({ FAKE_ACP_RESUME_DELAY: '600' })
      let bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'own first', requestId: rid() })
      await settled(bridge, sessionId)
      const before = (await bridge.detail(sessionId)).config!.find(option => option.category === 'model')!
      const store = join(fixture.dataDir, 'acp.json')
      const move = bridge.setConfig!(sessionId, before.id, serviceChoice({ providerId: 'svc', model: 'fake-model' }), {
        route: routeTo('svc', 'fake-model'),
      })
      // What the record held at the moment the new route was written, before the agent's session was open on it.
      let halfway = ''
      await vi.waitFor(async () => {
        halfway = await readFile(store, 'utf8')
        expect(halfway).toContain('"routeMove"')
      })
      await move
      await bridge.close()
      await writeFile(store, halfway)
      bridge = await fixture.open()
      const detail = await bridge.detail(sessionId)
      expect(detail.summary.modelRoute).toBeUndefined()
      expect(JSON.stringify(detail)).not.toContain('routeMove')
      await bridge.prompt(sessionId, 'model back on its own', rid())
      const after = await settled(bridge, sessionId)
      expect(after.summary.status).toBe('idle')
      expect(after.config!.find(option => option.category === 'model')?.currentValue).toBe(before.currentValue)
      expect(models.requests).toHaveLength(0)
      expect(stub.leases.every(lease => lease.closed)).toBe(true)
    })

    it('refuses while a turn runs, and stays on the previous route when the new one cannot start', async () => {
      const { stub, fixture, routeTo } = await moving()
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'hang', requestId: rid() })
      await vi.waitFor(async () => expect(promptPid(await fixture.log(), 'hang')).toBeGreaterThan(0))
      const modelId = (await bridge.detail(sessionId)).config!.find(option => option.category === 'model')!.id
      await expect(
        bridge.setConfig!(sessionId, modelId, serviceChoice({ providerId: 'svc', model: 'fake-model' }), {
          route: routeTo('svc', 'fake-model'),
        }),
      ).rejects.toMatchObject({ status: 409, code: 'task-running', details: { configOutcome: 'not-sent' } })
      await bridge.cancel(sessionId)
      let detail = await settled(bridge, sessionId)
      const before = detail.config!.find(option => option.category === 'model')!.currentValue

      // The service refuses its token: the move fails as refused, and the session is on its own login as before.
      const choice = serviceChoice({ providerId: 'broken', model: 'fake-model' })
      await expect(bridge.setConfig!(sessionId, modelId, choice, { route: routeTo('broken', 'fake-model') })).rejects.toMatchObject({
        details: { configOutcome: 'refused' },
      })
      detail = await bridge.detail(sessionId)
      expect(detail.summary.modelRoute).toBeUndefined()
      expect(detail.config!.find(option => option.category === 'model')?.currentValue).toBe(before)
      await expect(bridge.readConfig!(sessionId, modelId, choice)).resolves.toEqual({ kind: 'read', currentValue: before, asked: false })
      expect(stub.leases).toHaveLength(0)
      await bridge.prompt(sessionId, 'still own', rid())
      expect((await settled(bridge, sessionId)).summary.status).toBe('idle')

      // Without a route the Host built, a service choice is not taken.
      await expect(bridge.setConfig!(sessionId, modelId, serviceChoice({ providerId: 'svc', model: 'fake-model' }))).rejects.toMatchObject({
        status: 400,
        details: { configOutcome: 'not-sent' },
      })
    })
  })

  it('says which Harnesses move a session between their own login and services, and which only between services', async () => {
    const moves = async (presetId: string, command: string) =>
      (await activate(createAcpAgentPlugin({ id: presetId, name: presetId, presetId, command, args: [], env: {}, enabled: true })))
        .capabilities?.models?.routeSwitch
    // Grok keeps a routed session in its private home; Codex carries its thread across by a fork.
    expect(await moves('grok', 'grok')).toBe('services')
    // goose, resumed off its service, keeps reporting that model and cannot say whether its own login took over.
    expect(await moves('goose', 'goose')).toBe('services')
    expect(await moves('codex', 'codex')).toBe('any')
    for (const [presetId, command] of [
      ['opencode', 'opencode'],
      ['codex', 'codex-acp'],
      ['claude-agent', 'claude-agent-acp'],
      ['pi', 'pi'],
    ] as const)
      expect(await moves(presetId, command)).toBe('any')
    // One that never reaches a service has nowhere to move.
    expect(await moves('cursor', 'cursor-agent')).toBeUndefined()
  })

  it('revokes a newly prepared gateway credential exactly once when all process slots are busy', async () => {
    const { fixture, stub, route } = await routed(
      'opencode',
      LAUNCHED,
      { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' },
      { maxProcesses: 1 },
    )
    const bridge = await fixture.open()
    const first = await bridge.createTask({ prompt: 'hang', requestId: rid(), modelRoute: route })
    await vi.waitFor(async () => expect(promptPid(await fixture.log(), 'hang')).toBeGreaterThan(0))
    expect((await bridge.detail(first.sessionId)).summary.status).toBe('running')
    const second = await bridge.createTask({ prompt: 'model must not start', requestId: rid(), modelRoute: route })
    const refused = await settled(bridge, second.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('会话过多')
    expect(stub.leases).toHaveLength(2)
    expect(stub.leases.map(lease => ({ closed: lease.closed, closes: lease.closes }))).toEqual([
      { closed: false, closes: 0 },
      { closed: true, closes: 1 },
    ])
  })

  it('remembers what a session on a service model reported, for drafts on that pair while its declaration holds', async () => {
    const models = await startFakeModels({ replies: [{ text: 'from the service' }] })
    cleanups.push(() => models.close())
    const stub = gateway(models)
    const capabilities = { 'fake-model': { thinking: ['low', 'high'] } }
    const fixture = await setup(
      LAUNCHED,
      { idleMs: 60_000 },
      { presetId: 'opencode' },
      { modelGateway: { open: input => ({ ...stub.access.open(input), modelCapabilities: capabilities }) } },
    )
    const route: ModelRoute = { providerId: 'svc', model: 'fake-model', wire: 'chat-completions', origin: models.origin }
    const service = {
      providerId: 'svc',
      entry: 'chat-completions' as const,
      upstream: 'chat-completions' as const,
      models: ['fake-model', 'fake-model-large'],
      modelCapabilities: capabilities,
    }
    let bridge = await fixture.open()
    // Nothing ran on it yet: nothing to show, and nothing derived for a Harness Latch has not checked.
    expect(bridge.serviceOptions!([service])).toEqual([])
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    const reported = detail.config!.find(option => option.category === 'thought_level')!
    const kept = [{ providerId: 'svc', model: 'fake-model', options: [reported], source: 'session' }]
    expect(bridge.serviceOptions!([service])).toEqual(kept)
    // Kept on disk with the rest of the Harness's state.
    await bridge.close()
    bridge = await fixture.open()
    expect(bridge.serviceOptions!([service])).toEqual(kept)
    // Another declaration of the same pair, another protocol, or another service: not what that session ran with.
    expect(bridge.serviceOptions!([{ ...service, modelCapabilities: { 'fake-model': { thinking: ['high'] } } }])).toEqual([])
    expect(bridge.serviceOptions!([{ ...service, upstream: 'responses' }])).toEqual([])
    expect(bridge.serviceOptions!([{ ...service, providerId: 'other' }])).toEqual([])
    // A session that opens on another model and is switched to the route's: kept under the route's model, from the
    // report on that model, never the one it opened on.
    const large = await bridge.createTask({ prompt: 'model large', requestId: rid(), modelRoute: { ...route, model: 'fake-model-large' } })
    const switched = await settled(bridge, large.sessionId)
    expect(switched.summary.status).toBe('idle')
    expect(switched.config?.find(option => option.category === 'model')?.currentValue).toBe('latch/fake-model-large')
    expect(bridge.serviceOptions!([service]).map(entry => entry.model)).toEqual(['fake-model', 'fake-model-large'])
    await bridge.close()
  })

  const QWEN = {
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'plan,default,auto-edit,auto,yolo',
    FAKE_ACP_INITIAL_MODE: 'default',
    FAKE_ACP_CAPS: 'resume',
    FAKE_ACP_GATEWAY: 'qwen',
  }
  const GOOSE = {
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'chat,approve,smart_approve,auto',
    FAKE_ACP_INITIAL_MODE: 'approve',
    FAKE_ACP_CAPS: 'resume',
    FAKE_ACP_GATEWAY: 'goose',
    FAKE_ACP_VERSION: '1.57.0',
  }

  it('still deletes a routed session of a harness whose record is not in a private home (goose)', async () => {
    const { fixture, route } = await routed(
      'goose',
      { ...GOOSE, FAKE_ACP_CAPS: 'resume,delete' },
      { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' },
    )
    let bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    const own = received(await fixture.log(), 'session/prompt')[0]!.params?.sessionId as string
    await bridge.close()
    bridge = await fixture.open()
    await bridge.remove!(sessionId)
    await vi.waitFor(
      async () => expect(received(await fixture.log(), 'session/delete').map(entry => entry.params?.sessionId)).toEqual([own]),
      {
        timeout: 5_000,
        interval: 10,
      },
    )
    await bridge.close()
  })

  it('routes Qwen Code through private system settings over each protocol, the token in LMG_TOKEN alone', async () => {
    for (const wire of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
      const auth = wire === 'anthropic-messages' ? 'anthropic' : 'openai'
      const { fixture, models, stub, route } = await routed('qwen', QWEN, { providerId: 'svc', model: 'fake-model', wire })
      let bridge = await fixture.open()
      const own = await bridge.launchPreview!({ cwd: fixture.workspace })
      const preview = await bridge.launchPreview!({ cwd: fixture.workspace, modelRoute: route })
      // The fingerprint is made before any token or gateway address exists, from names and template versions.
      expect(stub.leases).toHaveLength(0)
      expect(preview.launchHash).not.toBe(own.launchHash)
      expect((await bridge.launchPreview!({ cwd: fixture.workspace, modelRoute: route })).launchHash).toBe(preview.launchHash)
      expect(preview.envNames).toEqual(expect.arrayContaining(['LMG_TOKEN', 'QWEN_CODE_SYSTEM_SETTINGS_PATH', 'NO_PROXY']))

      const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
      let detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
      expect(systemText(detail)).not.toContain('没有经过 Latch')
      const model = detail.config?.find(option => option.category === 'model')
      // A Responses entry is in the `openai` list and is named by its effective protocol.
      const listed = wire === 'responses' ? 'openai-responses' : auth
      expect(model?.currentValue).toBe(`fake-model(${listed})`)
      expect(model?.options.map(option => option.value)).toEqual([`fake-model(${listed})`, `fake-model-large(${listed})`])
      await expect(bridge.setConfig!(sessionId, model!.id, 'fake-model-large(qwen-oauth)')).rejects.toMatchObject({ status: 400 })
      await bridge.setConfig!(sessionId, model!.id, `fake-model-large(${listed})`)
      await bridge.close()
      bridge = await fixture.open()
      await bridge.prompt(sessionId, 'model restored', rid())
      detail = await settled(bridge, sessionId)
      expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
      expect(models.requests.map(request => ({ model: request.model, wire: request.wire, key: request.key }))).toEqual([
        { model: 'fake-model', wire, key: stub.leases[0]!.token },
        { model: 'fake-model-large', wire, key: stub.leases[1]!.token },
      ])

      const log = await fixture.log()
      // The model is set for the session alone, and never through the methods that write the person's settings.
      const sets = received(log, 'session/set_config_option').filter(entry => entry.params?.configId === model!.id)
      expect(sets.length).toBeGreaterThan(0)
      for (const set of sets) expect(set.params?._meta).toEqual({ 'qwen.session.modelPersistDefault': false })
      for (const method of ['session/set_model', 'authenticate']) expect(received(log, method)).toHaveLength(0)

      const [agentEnv] = envOf(log)
      const [lease] = stub.leases
      expect(agentEnv!.LMG_TOKEN).toBe(lease!.token)
      expect(Object.entries(agentEnv!).filter(([, value]) => value.includes(lease!.token))).toEqual([['LMG_TOKEN', lease!.token]])
      const path = agentEnv!.QWEN_CODE_SYSTEM_SETTINGS_PATH!
      expect(path.startsWith(fixture.tmpRoot)).toBe(true)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const text = await readFile(path, 'utf8')
      expect(text).not.toContain('lmg1.')
      const settings = JSON.parse(text) as Record<string, any>
      expect(settings.security.auth.selectedType).toBe(auth)
      expect(settings.modelProviders[auth].map((entry: { envKey: string }) => entry.envKey)).toEqual(['LMG_TOKEN', 'LMG_TOKEN'])
      for (const name of ['fastModel', 'visionModel', 'compactionModel', 'advisorModel', 'modelFallbacks']) expect(settings[name]).toBe('')
      // The token is in no argument, no stored record and nothing the session shows.
      for (const held of stub.leases) {
        expect(JSON.stringify(log.filter(entry => entry.event === 'start'))).not.toContain(held.token)
        expect(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).not.toContain(held.token)
        expect(JSON.stringify(detail)).not.toContain(held.token)
      }
      await bridge.close()
      expect(stub.leases.every(held => held.closed)).toBe(true)
    }
  })

  it('refuses a Qwen Code older than the checked version before it gets a token, and leaves its own models usable', async () => {
    const { fixture, models, stub, route } = await routed(
      'qwen',
      { ...QWEN, FAKE_ACP_VERSION: '0.26.7' },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    const bridge = await fixture.open()
    const native = await bridge.createTask({ prompt: 'echo native', requestId: rid() })
    expect((await settled(bridge, native.sessionId)).summary.status).toBe('idle')
    const attempted = await bridge.createTask({ prompt: 'model must not run', requestId: rid(), modelRoute: route })
    const refused = await settled(bridge, attempted.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('0.26.8')
    expect(models.requests).toHaveLength(0)
    await bridge.close()
    expect(stub.leases.every(lease => lease.closed)).toBe(true)
  })

  it('leaves a turn on a route out of the own-login record: the gateway counted its requests', async () => {
    const turns: HarnessTurnRecord[] = []
    const { fixture, route } = await routed(
      'qwen',
      QWEN,
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
      {},
      {
        turnEnded: turn => void turns.push(turn),
      },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    // The gateway's ledger has its requests: the turn's own count is shown, never recorded a second time.
    expect(detail.summary.status).toBe('idle')
    expect(detail.messages.find(message => message.role === 'user')?.turn?.routed?.requests).toBe(1)
    expect(turns).toEqual([])
  })

  it('says so when a Qwen Code turn on a route answered without the gateway', async () => {
    const { fixture, events, route } = await routed('qwen', QWEN, { providerId: 'svc', model: 'fake-model', wire: 'responses' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo elsewhere', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    expect(systemText(detail)).toContain('这一轮没有经过 Latch')
    expect(detail.summary.modelRoute).toMatchObject({ bypassed: true })
    expect(events).toContainEqual({ type: 'model-route-bypassed', sessionId })
  })

  it('leaves Qwen Code no route of the person’s own for a side call: other protocols, grades and subagents', async () => {
    const elsewhere = await startFakeModels({ replies: [{ text: 'from their own service' }] })
    cleanups.push(() => elsewhere.close())
    const home = await mkdtemp(join(tmpdir(), 'latch-qwen-own-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const own = (id: string) => ({ id, baseUrl: elsewhere.origin, envKey: 'OWN_SERVICE_KEY' })
    // What a person may have in their own Qwen Code settings, as the fake merges them under the system settings.
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'own-claude', baseUrl: elsewhere.origin },
        modelProviders: {
          openai: [
            { ...own('fake-model'), baseUrl: `${elsewhere.origin}/v1` },
            { ...own('own-gpt'), baseUrl: `${elsewhere.origin}/v1` },
          ],
          anthropic: [own('own-claude')],
          gemini: [own('own-gemini')],
          'vertex-ai': [own('own-vertex')],
          'openai-responses': [{ ...own('own-legacy'), baseUrl: `${elsewhere.origin}/v1` }],
        },
        fastModel: 'own-claude',
        modelFallbacks: 'own-gpt',
        agents: { modelGrades: { smart: 'anthropic:own-claude' }, builtin: { exploreModel: 'anthropic:own-claude' } },
        permissions: { deny: ['Bash(rm -rf *)'] },
      }),
    )
    const { fixture, models, stub, route } = await routed(
      'qwen',
      { ...QWEN, FAKE_QWEN_USER_SETTINGS: join(home, 'settings.json'), OWN_SERVICE_KEY: 'own-service-key' },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model main', requestId: rid(), modelRoute: route })
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('model: from the service')
    for (const [selector, answer] of [
      // The grade is theirs, and no grade is allowed.
      ['grade:smart', 'no such grade'],
      // Their lists under every built-in key were replaced: by the service's models, or by nothing.
      ['anthropic:own-claude', 'no such model route'],
      ['gemini:own-gemini', 'no such model route'],
      ['vertex-ai:own-vertex', 'no such model route'],
      ['openai-responses:own-legacy', 'no such model route'],
      ['openai:own-gpt', 'no such model route'],
      // And a subagent on the service's own model is still no subagent: the tool is denied, beside their own rule.
      ['openai:fake-model', 'the Agent tool is denied'],
    ] as const) {
      await bridge.prompt(sessionId, `model side:${selector}`, rid())
      expect(assistants(await settled(bridge, sessionId)).at(-1)?.text, selector).toBe(`side: ${answer}`)
    }
    expect(elsewhere.requests).toEqual([])
    expect(models.requests.map(request => request.key)).toEqual([stub.leases[0]!.token])
    const [agentEnv] = envOf(await fixture.log())
    const settings = JSON.parse(await readFile(agentEnv!.QWEN_CODE_SYSTEM_SETTINGS_PATH!, 'utf8')) as Record<string, any>
    expect(settings.modelProviders).toMatchObject({ anthropic: [], gemini: [], 'vertex-ai': [], 'openai-responses': [] })
    expect(settings.agents).toEqual({ builtin: { exploreModel: 'inherit' }, allowedGrades: [] })
    expect(settings.permissions).toEqual({ deny: ['Agent'] })
  })

  it('routes goose by its own variables over Chat, Responses and Anthropic, the token under the name its provider reads', async () => {
    for (const wire of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
      const provider = wire === 'anthropic-messages' ? 'anthropic' : 'openai'
      const tokenName = wire === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
      const { fixture, models, stub, route } = await routed('goose', GOOSE, { providerId: 'svc', model: 'fake-model', wire })
      let bridge = await fixture.open()
      const own = await bridge.launchPreview!({ cwd: fixture.workspace })
      const preview = await bridge.launchPreview!({ cwd: fixture.workspace, modelRoute: route })
      expect(stub.leases).toHaveLength(0)
      expect(preview.launchHash).not.toBe(own.launchHash)
      expect(preview.envNames).toEqual(expect.arrayContaining([tokenName, 'GOOSE_PROVIDER', 'GOOSE_MODEL', 'NO_PROXY']))
      expect(preview.envNames).not.toContain(wire === 'anthropic-messages' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY')

      const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
      let detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
      expect(systemText(detail)).not.toContain('没有经过 Latch')
      const model = detail.config?.find(option => option.category === 'model')
      expect(model?.currentValue).toBe('fake-model')
      expect(model?.options.map(option => option.value)).toEqual(['fake-model', 'fake-model-large'])
      // goose's own `provider` option would move the session to a service the person set up in goose.
      expect(detail.config?.some(option => option.id === 'provider')).toBe(false)
      await expect(bridge.setConfig!(sessionId, 'provider', 'ollama')).rejects.toMatchObject({ code: 'config-not-found' })
      await bridge.setConfig!(sessionId, model!.id, 'fake-model-large')
      await bridge.close()
      bridge = await fixture.open()
      await bridge.prompt(sessionId, 'model restored', rid())
      detail = await settled(bridge, sessionId)
      expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
      expect(models.requests.map(request => ({ model: request.model, wire: request.wire, key: request.key }))).toEqual([
        { model: 'fake-model', wire, key: stub.leases[0]!.token },
        { model: 'fake-model-large', wire, key: stub.leases[1]!.token },
      ])

      const log = await fixture.log()
      // No provider on the session itself: goose would then start it on that provider's default model, not GOOSE_MODEL.
      expect(received(log, 'session/new')[0]?.params).not.toHaveProperty('_meta')
      // Nothing but ACP's own methods: goose's configuration methods write its config file.
      expect(log.filter(entry => entry.event === 'received' && String(entry.method).startsWith('_goose/'))).toHaveLength(0)
      const [agentEnv] = envOf(log)
      const [lease] = stub.leases
      expect(agentEnv).toMatchObject({
        GOOSE_PROVIDER: provider,
        GOOSE_MODEL: 'fake-model',
        GOOSE_SUBAGENT_PROVIDER: provider,
        GOOSE_SUBAGENT_MODEL: 'fake-model',
        GOOSE_MODE: 'approve',
        GOOSE_TOOLSHIM: 'false',
        ...(provider === 'anthropic'
          ? { ANTHROPIC_HOST: models.origin }
          : { OPENAI_HOST: models.origin, OPENAI_BASE_PATH: wire === 'responses' ? 'v1/responses' : '/v1/chat/completions' }),
      })
      expect(Object.entries(agentEnv!).filter(([, value]) => value.includes(lease!.token))).toEqual([[tokenName, lease!.token]])
      expect(agentEnv).not.toHaveProperty('GOOGLE_HOST')
      for (const held of stub.leases) {
        expect(JSON.stringify(log.filter(entry => entry.event === 'start'))).not.toContain(held.token)
        expect(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).not.toContain(held.token)
        expect(JSON.stringify(detail)).not.toContain(held.token)
      }
      await bridge.close()
      expect(stub.leases.every(held => held.closed)).toBe(true)
    }
  })

  it('says so when a goose turn on a route answered without the gateway, and refuses a goose older than the checked version', async () => {
    const { fixture, events, route } = await routed('goose', GOOSE, { providerId: 'svc', model: 'fake-model', wire: 'responses' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo elsewhere', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    expect(systemText(detail)).toContain('这一轮没有经过 Latch')
    expect(events).toContainEqual({ type: 'model-route-bypassed', sessionId })
    await bridge.close()

    const older = await routed(
      'goose',
      { ...GOOSE, FAKE_ACP_VERSION: '1.56.9' },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    const second = await older.fixture.open()
    const attempted = await second.createTask({ prompt: 'model must not run', requestId: rid(), modelRoute: older.route })
    const refused = await settled(second, attempted.sessionId)
    expect(refused.summary.status).toBe('failed')
    expect(systemText(refused)).toContain('1.57.0')
    expect(older.models.requests).toHaveLength(0)
  })

  it('routes Grok Build through custom models in a home of the session\u2019s own, the token in LMG_TOKEN alone', async () => {
    for (const wire of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
      const { fixture, models, stub, route } = await routed(
        'grok',
        { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_GATEWAY: 'grok' },
        { providerId: 'svc', model: 'fake-model', wire },
      )
      let bridge = await fixture.open()
      const preview = await bridge.launchPreview!({ cwd: fixture.workspace, modelRoute: route })
      expect(stub.leases).toHaveLength(0)
      expect(preview.envNames).toEqual(expect.arrayContaining(['LMG_TOKEN', 'GROK_HOME', 'NO_PROXY']))
      const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
      let detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('idle')
      expect(assistants(detail).at(-1)?.text).toBe('model: from the service')
      const model = detail.config?.find(option => option.category === 'model')
      expect(model?.currentValue).toBe('fake-model')
      expect(model?.options.map(option => option.value)).toEqual(['fake-model', 'fake-model-large'])
      await bridge.setConfig!(sessionId, model!.id, 'fake-model-large')
      await bridge.close()
      bridge = await fixture.open()
      await bridge.prompt(sessionId, 'model restored', rid())
      detail = await settled(bridge, sessionId)
      expect(models.requests.map(request => ({ model: request.model, wire: request.wire, key: request.key }))).toEqual([
        { model: 'fake-model', wire, key: stub.leases[0]!.token },
        { model: 'fake-model-large', wire, key: stub.leases[1]!.token },
      ])
      const log = await fixture.log()
      const [agentEnv] = envOf(log)
      const [lease] = stub.leases
      expect(Object.entries(agentEnv!).filter(([, value]) => value.includes(lease!.token))).toEqual([['LMG_TOKEN', lease!.token]])
      // Its home is the session's own directory, and the configuration there names the key's variable only.
      expect(agentEnv!.GROK_HOME!.startsWith(fixture.tmpRoot)).toBe(true)
      const path = join(agentEnv!.GROK_HOME!, 'config.toml')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const text = await readFile(path, 'utf8')
      expect(text).not.toContain('lmg1.')
      expect(text).toContain('env_key = "LMG_TOKEN"')
      for (const held of stub.leases) {
        expect(JSON.stringify(log.filter(entry => entry.event === 'start'))).not.toContain(held.token)
        expect(await readFile(join(fixture.dataDir, 'acp.json'), 'utf8')).not.toContain(held.token)
        expect(JSON.stringify(detail)).not.toContain(held.token)
      }
      await bridge.close()
      expect(stub.leases.every(held => held.closed)).toBe(true)
    }
  })

  it('keeps the token of a routed Grok session from other tools’ MCP servers and hooks, and from the servers Latch gives it', async () => {
    const { fixture, stub, route } = await routed(
      'grok',
      // A definition of the person's own may not turn a compatibility source back on for a routed session.
      { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_GATEWAY: 'grok', GROK_CURSOR_MCPS_ENABLED: '1' },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    const bridge = await fixture.open()
    const agentContext = {
      agent: { customAgentId: `agt_${randomUUID()}` },
      instructions: '',
      revision: 'a'.repeat(64),
      skillBodies: [{ id: 'plugin:list', name: '审阅清单', description: '逐项检查', content: 'SKILL BODY' }],
    }
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route, agentContext })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    const log = await fixture.log()
    const [agentEnv] = envOf(log)
    expect(agentEnv).toMatchObject({
      GROK_CLAUDE_MCPS_ENABLED: '0',
      GROK_CURSOR_MCPS_ENABLED: '0',
      GROK_CLAUDE_HOOKS_ENABLED: '0',
      GROK_CURSOR_HOOKS_ENABLED: '0',
    })
    const text = await readFile(join(agentEnv!.GROK_HOME!, 'config.toml'), 'utf8')
    for (const line of ['[claude_compat]\nimported = true', '[compat.cursor]\nmcps = false\nhooks = false', 'exclude = ["LMG_TOKEN"]'])
      expect(text).toContain(line)
    const servers = (received(log, 'session/new')[0]!.params as { mcpServers: Array<{ name: string; env: unknown[] }> }).mcpServers
    expect(servers.map(server => server.name)).toContain('latch-skills')
    for (const server of servers) expect(server.env).toEqual([{ name: 'LMG_TOKEN', value: '' }])
    expect(JSON.stringify(servers)).not.toContain(stub.leases[0]!.token)
    // Its own login gives no token to blank.
    const native = await bridge.createTask({ prompt: 'echo native', requestId: rid(), agentContext })
    expect((await settled(bridge, native.sessionId)).summary.status).toBe('idle')
    for (const server of (received(await fixture.log(), 'session/new').at(-1)!.params as { mcpServers: Array<{ env: unknown[] }> })
      .mcpServers)
      expect(server.env).toEqual([])
    await bridge.close()
  })

  it('starts nothing to delete a routed Grok session, whose record goes with its private home', async () => {
    const { fixture, route } = await routed(
      'grok',
      { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_GATEWAY: 'grok', FAKE_ACP_XAI_DELETE: '1' },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    let bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    await bridge.close()
    bridge = await fixture.open()
    await bridge.remove!(sessionId)
    await new Promise(resolve => setTimeout(resolve, 200))
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(1)
    expect(received(log, '_x.ai/session/delete')).toEqual([])
    await bridge.close()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a resumed gateway whose private directory points at the original CLI configuration',
    async () => {
      const { fixture, models, stub, route } = await routed(
        'grok',
        { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_GATEWAY: 'grok' },
        { providerId: 'svc', model: 'fake-model', wire: 'responses' },
      )
      const originalHome = join(fixture.root, 'original-home')
      const originalConfig = '[models]\ndefault = "cli-model"\n'
      await seedCliFiles(originalHome, { '.grok/config.toml': originalConfig, '.grok/hooks.toml': '# fixture hooks\n' })
      const before = await cliTree(originalHome)
      let bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
      expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
      await bridge.close()

      const privateGateway = join(fixture.tmpRoot, sha256Hex(sessionId).slice(0, 16), 'gateway')
      expect(envOf(await fixture.log())[0]?.GROK_HOME).toBe(privateGateway)
      await rm(privateGateway, { recursive: true })
      await symlink(join(originalHome, '.grok'), privateGateway)
      bridge = await fixture.open()
      await expect(bridge.prompt(sessionId, 'model must not run', rid())).rejects.toMatchObject({
        code: 'agent-start-failed',
        message: expect.stringContaining('网关配置目录的属主或权限不安全'),
      })
      expect(await readFile(join(originalHome, '.grok', 'config.toml'), 'utf8')).toBe(originalConfig)
      expect(await cliTree(originalHome)).toEqual(before)
      expect((await bridge.detail(sessionId)).summary.status).toBe('idle')
      expect(models.requests).toHaveLength(1)
      expect(stub.leases.every(lease => lease.closed)).toBe(true)
      expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)

      await rm(privateGateway)
      await bridge.prompt(sessionId, 'model recovered', rid())
      expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
      expect(models.requests).toHaveLength(2)
      await bridge.close()
      expect(await cliTree(originalHome)).toEqual(before)
    },
  )

  it.skipIf(process.platform === 'win32')('never writes or removes a session through a redirected temporary root', async () => {
    const { fixture, models, route } = await routed(
      'grok',
      { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_GATEWAY: 'grok' },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    let bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    await bridge.close()

    const originalHome = join(fixture.root, 'original-home')
    const name = sha256Hex(sessionId).slice(0, 16)
    const originalConfig = '[models]\ndefault = "cli-model"\n'
    await seedCliFiles(originalHome, { [`${name}/gateway/config.toml`]: originalConfig, '.zshrc': '# fixture shell configuration\n' })
    const original = await cliTree(originalHome)
    await rename(fixture.tmpRoot, join(fixture.root, 'previous-tmp-root'))
    await symlink(originalHome, fixture.tmpRoot)
    bridge = await fixture.open()
    await expect(bridge.prompt(sessionId, 'model must not run', rid())).rejects.toMatchObject({
      code: 'agent-start-failed',
      message: expect.stringContaining('会话临时根目录的属主或权限不安全'),
    })
    expect(await readFile(join(originalHome, name, 'gateway', 'config.toml'), 'utf8')).toBe(originalConfig)
    expect((await bridge.detail(sessionId)).summary.status).toBe('idle')
    expect(models.requests).toHaveLength(1)

    await bridge.remove!(sessionId)
    await bridge.close()
    expect(await cliTree(originalHome)).toEqual(original)
  })

  it('does not ask Grok Build for its billing on a model service, where it runs in a home with no login', async () => {
    const billing = JSON.stringify({ config: { creditUsagePercent: 82 }, subscriptionTier: 'SuperGrok' })
    const { fixture, route } = await routed(
      'grok',
      { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume', FAKE_ACP_GATEWAY: 'grok', FAKE_ACP_BILLING: billing },
      { providerId: 'svc', model: 'fake-model', wire: 'responses' },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model first', requestId: rid(), modelRoute: route })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    await bridge.prompt(sessionId, 'echo again', rid())
    await settled(bridge, sessionId)
    expect(received(await fixture.log(), '_x.ai/billing')).toHaveLength(0)
    expect(bridge.quota?.()).toBeUndefined()
  })

  it('records on each turn what went through the gateway, with the chosen model as the service names it, and keeps it', async () => {
    const { fixture, stub, route } = await routed('opencode', LAUNCHED, {
      providerId: 'svc',
      model: 'fake-model',
      wire: 'chat-completions',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model one', requestId: rid(), modelRoute: route })
    const first = await settled(bridge, sessionId)
    const prompts = () => first.messages.filter(message => message.role === 'user')
    expect(prompts()[0]!.turn?.routed).toEqual({ requests: 1, chosen: 'fake-model', models: [{ model: 'fake-model', requests: 1 }] })
    // A turn that sent nothing through Latch has no record of it.
    await bridge.prompt(sessionId, 'echo two', rid())
    const second = await until(bridge, sessionId, item => assistants(item).length === 2 && item.summary.status === 'idle')
    const [, echo] = second.messages.filter(message => message.role === 'user')
    expect(echo!.turn?.endedAt).toBeDefined()
    expect(echo!.turn?.routed).toBeUndefined()
    // A turn that asked for another model of the service counts it under that model.
    await bridge.prompt(sessionId, 'model as:fake-model-large', rid())
    const third = await until(bridge, sessionId, item => assistants(item).length === 3 && item.summary.status === 'idle')
    expect(third.messages.filter(message => message.role === 'user')[2]!.turn?.routed).toEqual({
      requests: 1,
      chosen: 'fake-model',
      models: [{ model: 'fake-model-large', requests: 1 }],
    })
    // A request still under way when the turn ended is kept as such.
    stub.leaveOpen(1)
    await bridge.prompt(sessionId, 'model four', rid())
    const fourth = await until(bridge, sessionId, item => assistants(item).length === 4 && item.summary.status === 'idle')
    const unsettled = fourth.messages.filter(message => message.role === 'user')[3]!.turn?.routed
    expect(unsettled).toEqual({ requests: 1, chosen: 'fake-model', models: [{ model: 'fake-model', requests: 1, open: 1 }] })
    await bridge.close()
    const reopened = await fixture.open()
    const stored = await reopened.detail(sessionId)
    const storedPrompts = stored.messages.filter(message => message.role === 'user')
    expect(storedPrompts[0]!.turn?.routed).toEqual(prompts()[0]!.turn?.routed)
    expect(storedPrompts[3]!.turn?.routed).toEqual(unsettled)
    await reopened.close()
  })

  it('says a turn that replied without the gateway did not go through Latch, records it, and takes the next turn', async () => {
    const { fixture, events, route } = await routed('opencode', LAUNCHED, {
      providerId: 'svc',
      model: 'fake-model',
      wire: 'chat-completions',
    })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo hi', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    expect(systemText(detail)).toBe('这一轮没有经过 Latch：Fake 可能用了它自己的登录或配置，这一轮的内容可能发给了别的服务。')
    expect(detail.summary.modelRoute).toEqual({ providerId: 'svc', model: 'fake-model', bypassed: true })
    expect(events).toEqual([{ type: 'model-route-bypassed', sessionId }])
    await bridge.prompt(sessionId, 'model again', rid())
    const next = await until(bridge, sessionId, item => assistants(item).length === 2 && item.summary.status === 'idle')
    expect(assistants(next).at(-1)!.text).toBe('model: from the service')
    expect(events).toHaveLength(1)
  })

  it('replaces a process whose token stopped working before its next turn', async () => {
    const { fixture, stub, route } = await routed(
      'opencode',
      { ...LAUNCHED, FAKE_ACP_CAPS: 'load' },
      { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model one', requestId: rid(), modelRoute: route })
    await settled(bridge, sessionId)
    stub.revoke()
    let refreshed = false
    stub.access.open = (original => input => {
      refreshed = true
      return { ...original(input), active: () => true }
    })(stub.access.open.bind(stub.access))
    await bridge.prompt(sessionId, 'model two', rid())
    await until(bridge, sessionId, item => assistants(item).length === 2 && item.summary.status === 'idle')
    expect(refreshed).toBe(true)
    expect(stub.leases).toHaveLength(2)
    expect(stub.leases[0]!.closed).toBe(true)
    const tokens = envOf(await fixture.log()).map(env => env.LMG_TOKEN)
    expect(new Set(tokens).size).toBe(2)
  })

  it('sets Codex up over providers/set with the token in a header, then chooses the route model from what it lists', async () => {
    const { fixture, models, stub, route } = await routed(
      'codex',
      { ...CODEX, FAKE_ACP_PROVIDERS: '1', FAKE_ACP_MODELS: 'fake-model,fake-model-large,codex-only' },
      { providerId: 'openai-svc', model: 'fake-model-large', wire: 'responses' },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model hi', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    expect(
      assistants(detail)
        .map(message => message.text)
        .join(''),
    ).toBe('model: from the service')
    const [lease] = stub.leases
    expect(models.requests).toMatchObject([{ wire: 'responses', model: 'fake-model-large', key: lease!.token }])
    const log = await fixture.log()
    expect(log.filter(entry => entry.event === 'providers-set')).toEqual([
      expect.objectContaining({ providerId: 'openai', baseUrl: `${models.origin}/v1`, headerNames: ['authorization'] }),
    ])
    // Codex lists only the service's models it knows; the route's is chosen before the first prompt.
    expect(detail.config?.find(option => option.category === 'model')).toMatchObject({
      currentValue: 'fake-model-large',
      options: [{ value: 'fake-model' }, { value: 'fake-model-large' }],
    })
    // Codex's own program is never looked up in a test, and nothing but the header carries the token.
    expect(envOf(log)[0]).not.toHaveProperty('CODEX_PATH')
    expect(JSON.stringify(envOf(log))).not.toContain(lease!.token)
    expect(fixture.diagnostics.join('\n')).not.toContain(lease!.token)
  })

  it('names the setup step that timed out after initialize, stops the process and keeps no token open', async () => {
    const { fixture, stub, route } = await routed(
      'codex',
      { ...CODEX, FAKE_ACP_PROVIDERS: '1', FAKE_ACP_PROVIDERS_SILENT: '1' },
      { providerId: 'openai-svc', model: 'fake-model', wire: 'responses' },
      { requestTimeoutMs: 400 },
    )
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'model hi', requestId: rid(), modelRoute: route })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('failed')
    expect(systemText(detail)).toContain('Fake 1 秒内没有完成启动设置（providers/list），已停止它。')
    const [started] = (await fixture.log()).filter(entry => entry.event === 'start')
    await vi.waitFor(() => expect(alive(started!.pid)).toBe(false))
    await bridge.close()
    expect(stub.leases.every(lease => lease.closed)).toBe(true)
  })

  it('refuses a Codex route the agent cannot take, saying why, and keeps no token open', async () => {
    for (const [env, message] of [
      [{}, 'Fake 这个版本不接受 Latch 设置模型服务，不能经 Latch 使用这个模型服务。'],
      [{ FAKE_ACP_PROVIDERS: '1', FAKE_ACP_PROVIDER_ID: 'other' }, 'Fake 没有可以设置的模型服务，不能经 Latch 使用这个模型服务。'],
      [
        { FAKE_ACP_PROVIDERS: '1', FAKE_ACP_MODELS: 'codex-only' },
        'Fake 没有列出模型「fake-model」：经 Latch 时它只用自己认识的模型。这条消息没有发出。',
      ],
    ] as const) {
      const { fixture, stub, route, models } = await routed(
        'codex',
        { ...CODEX, ...env },
        { providerId: 'openai-svc', model: 'fake-model', wire: 'responses' },
      )
      const bridge = await fixture.open()
      const { sessionId } = await bridge.createTask({ prompt: 'model hi', requestId: rid(), modelRoute: route })
      const detail = await settled(bridge, sessionId)
      expect(detail.summary.status).toBe('failed')
      expect(systemText(detail)).toContain(message)
      expect(models.requests.filter(request => request.wire === 'responses')).toEqual([])
      await bridge.close()
      expect(stub.leases.every(lease => lease.closed)).toBe(true)
    }
  })

  it('refuses a route for a harness Latch cannot point at the gateway, or over a protocol it does not speak', async () => {
    // Antigravity has a profile and no gateway delivery: it takes no model provider of another's.
    const { fixture, route } = await routed(
      'antigravity',
      { FAKE_ACP_CONFIG: 'options' },
      { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' },
    )
    const bridge = await fixture.open()
    const refusal = { status: 400, code: 'model-route-unsupported' }
    await expect(bridge.launchPreview!({ cwd: fixture.workspace, modelRoute: route })).rejects.toMatchObject(refusal)
    await expect(
      bridge.createTask({ prompt: 'echo', requestId: rid(), modelRoute: route, expectedLaunchHash: 'a'.repeat(64) }),
    ).rejects.toMatchObject(refusal)
    const codex = await routed('codex', CODEX, { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' })
    await expect(
      (await codex.fixture.open()).launchPreview!({ cwd: codex.fixture.workspace, modelRoute: codex.route }),
    ).rejects.toMatchObject(refusal)
    // A protocol Latch does not forward at all is no harness's: refused the same way, before anything starts.
    const launched = await routed('opencode', LAUNCHED, { providerId: 'svc', model: 'fake-model', wire: 'chat-completions' })
    const unknown = { ...launched.route, wire: 'gemini' } as unknown as ModelRoute
    const opened = await launched.fixture.open()
    await expect(opened.createTask({ prompt: 'echo', requestId: rid(), modelRoute: unknown })).rejects.toMatchObject(refusal)
    expect(launched.stub.leases).toEqual([])
    expect(await launched.fixture.log()).toEqual([])
    expect(await fixture.log()).toEqual([])
  })
})

describe('a new context in a session', () => {
  const said = (detail: DriverTaskDetail) => assistants(detail).at(-1)?.text

  it('opens a new agent session with the same choices, closes the old one and marks the message, once per request', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'close,resume' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'model', 'large')
    await bridge.setConfig!(sessionId, 'effort', 'high')
    await bridge.prompt(sessionId, 'recall', rid())
    expect(said(await settled(bridge, sessionId))).toBe('recall: 1 earlier')
    expect(received(await fixture.log(), 'session/new')).toHaveLength(1)
    const requestId = rid()
    await bridge.prompt(sessionId, 'recall', requestId, { freshContext: true })
    const detail = await settled(bridge, sessionId)
    expect(said(detail)).toBe('recall: 0 earlier')
    // The history stays; only the agent starts over, on what the person had chosen.
    expect(userTexts(detail)).toEqual(['echo one', 'recall', 'recall'])
    expect(detail.messages.filter(message => message.freshContext).map(message => message.text)).toEqual(['recall'])
    expect(detail.messages.findLast(message => message.role === 'user')?.freshContext).toBe(true)
    expect(detail.config?.map(option => option.currentValue)).toEqual(['large', 'high'])
    expect(assistants(detail).at(-1)).toMatchObject({ model: 'Large', thinking: 'High' })
    const log = await fixture.log()
    expect(received(log, 'session/new')).toHaveLength(2)
    const closed = received(log, 'session/close').map(entry => (entry.params as { sessionId: string }).sessionId)
    expect(closed).toHaveLength(1)
    const prompts = received(log, 'session/prompt').map(entry => (entry.params as { sessionId: string }).sessionId)
    expect(prompts.at(-1)).not.toBe(prompts[0])
    expect(closed[0]).toBe(prompts[0])
    // A retry is answered, never a second new session; the same request without it is another request.
    await bridge.prompt(sessionId, 'recall', requestId, { freshContext: true })
    await expect(bridge.prompt(sessionId, 'recall', requestId)).rejects.toMatchObject({ status: 409, code: 'request-conflict' })
    expect(received(await fixture.log(), 'session/new')).toHaveLength(2)
    expect(detail.clearContext).toBe(true)
    // The boundary is part of the record and the next turn continues the new context.
    await bridge.close()
    const restored = await fixture.open()
    expect((await restored.detail(sessionId)).messages.filter(message => message.freshContext)).toHaveLength(1)
    await restored.prompt(sessionId, 'recall', rid())
    expect(said(await settled(restored, sessionId))).toBe('recall: 1 earlier')
  })

  it('sends an agent its instructions again with the first turn of the new context', async () => {
    const fixture = await setup()
    const bridge = await fixture.open()
    const brief = { segments: [{ source: 'user' as const, text: 'ONLY REVIEW' }] }
    const agentContext = { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', brief, revision: 'a'.repeat(64) }
    const { sessionId } = await bridge.createTask({ prompt: 'echo hello', requestId: rid(), agentContext })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'echo again', rid(), { agentContext })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'echo fresh', rid(), { agentContext, freshContext: true })
    const detail = await settled(bridge, sessionId)
    const sent = received(await fixture.log(), 'session/prompt').map(entry => (entry.params as { prompt: Array<{ text: string }> }).prompt)
    expect(sent.map(blocks => blocks.map(block => block.text))).toEqual([
      ['ONLY REVIEW', 'echo hello'],
      ['echo again'],
      ['ONLY REVIEW', 'echo fresh'],
    ])
    expect(detail.messages.filter(message => message.agentBrief).map(message => message.text)).toEqual(['echo hello', 'echo fresh'])
  })

  it('keeps the boundary when the new session refuses the turn, so the next message shows where the context began', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODELS_FILE: '' })
    const modelsFile = join(fixture.root, 'models.txt')
    await writeFile(modelsFile, 'small,large')
    const bridge = await fixture.redefine({ env: { ...fixture.record.env, FAKE_ACP_MODELS_FILE: modelsFile } })
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'model', 'large')
    await writeFile(modelsFile, 'small')
    await expect(bridge.prompt(sessionId, 'recall', rid(), { freshContext: true })).rejects.toMatchObject({
      status: 409,
      code: 'model-unavailable',
    })
    const refused = await bridge.detail(sessionId)
    expect(userTexts(refused)).toEqual(['echo one'])
    // The old context is gone already, so the page cannot offer to keep it.
    expect(refused.contextCleared).toBe(true)
    await bridge.prompt(sessionId, 'recall', rid())
    const detail = await settled(bridge, sessionId)
    expect(said(detail)).toBe('recall: 0 earlier')
    expect(detail.messages.findLast(message => message.role === 'user')?.freshContext).toBe(true)
    expect(detail.contextCleared).toBeUndefined()
  })

  it('deletes the agent sessions from before each clear when the session is removed, after a restart too', async () => {
    const fixture = await setup({ FAKE_ACP_CAPS: 'close,resume,delete' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'recall', rid(), { freshContext: true })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'recall', rid(), { freshContext: true })
    await settled(bridge, sessionId)
    const sessions = [...new Set(received(await fixture.log(), 'session/prompt').map(entry => entry.params?.sessionId as string))]
    expect(sessions).toHaveLength(3)
    expect(Object.keys(await fixture.agentSessions()).sort()).toEqual([...sessions].sort())
    await bridge.close()
    const restored = await fixture.open()
    await restored.remove!(sessionId)
    await vi.waitFor(async () => expect(await fixture.agentSessions()).toEqual({}), { timeout: 5_000, interval: 10 })
    const deleted = received(await fixture.log(), 'session/delete').map(entry => entry.params?.sessionId as string)
    expect(deleted.sort()).toEqual([...sessions].sort())
  })

  it('deletes the session from before the clear when the session is removed before another turn starts', async () => {
    const fixture = await setup({ FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODELS_FILE: '', FAKE_ACP_CAPS: 'close,delete' })
    const modelsFile = join(fixture.root, 'models.txt')
    await writeFile(modelsFile, 'small,large')
    const bridge = await fixture.redefine({ env: { ...fixture.record.env, FAKE_ACP_MODELS_FILE: modelsFile } })
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.setConfig!(sessionId, 'model', 'large')
    await writeFile(modelsFile, 'small')
    await expect(bridge.prompt(sessionId, 'recall', rid(), { freshContext: true })).rejects.toMatchObject({ code: 'model-unavailable' })
    expect(Object.keys(await fixture.agentSessions())).toHaveLength(2)
    await bridge.remove!(sessionId)
    await vi.waitFor(async () => expect(await fixture.agentSessions()).toEqual({}), { timeout: 5_000, interval: 10 })
  })
})

/**
 * A stand-in for the Host's tool gateway: real tokens in real 0600 files, on a real socket. `browser_wait` holds until the
 * call is stopped and the test releases it, optionally recording an unknown result; any other tool
 * answers at once with a tab. Every call records what `describe` said of it.
 */
async function recordingToolGateway(options: { admit?: { now: boolean }; beforeStopReply?: () => Promise<void>; unknown?: boolean } = {}) {
  const firstCall = deferred()
  const admit = options.admit ?? { now: true }
  const directory = await mkdtemp(join(tmpdir(), 'lbt-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'g.sock')
  interface Lease {
    sessionId: string
    token: string
    tokenFile: string
    closed: boolean
    cancels: number
    inflight: number
    unknown: boolean
    idle: Set<() => void>
    stops: Set<() => void>
    describe?: any
  }
  const leases: Lease[] = []
  const calls: Array<{ tool: string; args: Record<string, unknown>; context: ToolGatewayCallContext }> = []
  const refused: string[] = []
  const settle = (lease: Lease) => {
    if (!lease.inflight) for (const done of [...lease.idle]) done()
  }
  const server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8').on('data', chunk => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        const write = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`)
        const lease = leases.find(item => item.token === request.token && !item.closed)
        if (!lease) {
          refused.push(request.method)
          write({ id: request.id, error: { code: -32001, message: 'token not valid' } })
          continue
        }
        if (request.method === 'tools/list') {
          write({ id: request.id, result: { tools: [{ name: 'browser_tabs', description: 'tabs', inputSchema: { type: 'object' } }] } })
          continue
        }
        if (request.method !== 'tools/call') continue
        const { name, arguments: args } = request.params
        const { waitForUser: _wait, ...context } = lease.describe?.(name, args) ?? {}
        calls.push({ tool: name, args, context })
        firstCall.resolve()
        if (name !== 'browser_wait') {
          write({ id: request.id, result: { content: [{ type: 'text', text: `tab brw_${'A'.repeat(22)}` }] } })
          continue
        }
        lease.inflight++
        const stop = async () => {
          await options.beforeStopReply?.()
          if (options.unknown) lease.unknown = true
          write({ id: request.id, result: { content: [{ type: 'text', text: 'stopped' }], isError: true } })
          lease.inflight--
          settle(lease)
        }
        lease.stops.add(stop)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const toolGateway: ToolGateway = {
    open({ sessionId, describe }) {
      if (!admit.now) return undefined
      const token = `lbt1.${randomUUID().replaceAll('-', '').padEnd(43, 'x')}`
      const tokenFile = join(directory, `${randomUUID()}.lbt`)
      writeFileSync(tokenFile, token, { mode: 0o600 })
      const lease: Lease = {
        sessionId,
        token,
        tokenFile,
        closed: false,
        cancels: 0,
        inflight: 0,
        unknown: false,
        idle: new Set(),
        stops: new Set(),
        describe,
      }
      leases.push(lease)
      const stopAll = () => {
        for (const stop of lease.stops) stop()
        lease.stops.clear()
      }
      return {
        socketPath,
        tokenFile,
        token,
        active: () => !lease.closed,
        cancel: () => {
          lease.cancels++
          stopAll()
        },
        settled: () =>
          new Promise(resolve => {
            const done = () => {
              lease.idle.delete(done)
              resolve({ resultUnknown: lease.unknown })
            }
            if (!lease.inflight) done()
            else lease.idle.add(done)
          }),
        close: () => {
          lease.closed = true
          stopAll()
        },
      }
    },
  }
  return { toolGateway, leases, calls, refused, socketPath, firstCall: firstCall.promise }
}

const browserEntry = (entry: LogEntry) =>
  (entry.params as { mcpServers: Array<{ name: string; args: string[]; env: unknown[] }> }).mcpServers.find(
    server => server.name === 'latch-browser',
  )
const TAB = `brw_${'A'.repeat(22)}`

describe('the browser tools for ACP sessions', () => {
  it('gives a session latch-browser with a fresh token file, revoked when its process ends or the session resumes', async () => {
    const gateway = await recordingToolGateway()
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh', FAKE_ACP_CAPS: 'resume' }, {}, {}, { toolGateway: gateway.toolGateway })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'browser [{"tool":"browser_tabs"}]', requestId: rid() })
    const first = await settled(bridge, sessionId)
    expect(assistants(first).at(-1)?.text).toBe(`browser_tabs: ok: tab ${TAB}`)
    expect(gateway.leases).toHaveLength(1)
    const [lease] = gateway.leases
    expect(lease!.sessionId).toBe(sessionId)
    const opened = received(await fixture.log(), 'session/new')[0]!
    const entry = browserEntry(opened)!
    // Only the paths travel: no token in the arguments, the environment or anything the agent was sent.
    expect(entry.args.slice(-2)).toEqual([gateway.socketPath, lease!.tokenFile])
    expect(entry.env).toEqual([])
    expect(JSON.stringify(opened)).not.toContain('lbt1.')
    // The server that listed the tools took the token and deleted its file.
    await expect(stat(lease!.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(first)).not.toContain(lease!.token)
    expect(fixture.diagnostics.join('\n')).not.toContain(lease!.token)

    // The process ends with the bridge: its token goes with it. The session resumes on a new process with a new token.
    await bridge.close()
    expect(lease!.closed).toBe(true)
    const restored = await fixture.open()
    await restored.prompt(sessionId, 'browser [{"tool":"browser_tabs"}]', rid(), {})
    await settled(restored, sessionId)
    expect(gateway.leases).toHaveLength(2)
    const second = gateway.leases[1]!
    expect(second.token).not.toBe(lease!.token)
    expect(second.closed).toBe(false)
    expect(browserEntry(received(await fixture.log(), 'session/resume')[0]!)!.args.at(-1)).toBe(second.tokenFile)
    expect(gateway.refused).toEqual([])
  })

  it('mints a new token on the same process when the context is cleared, and revokes the old one', async () => {
    const gateway = await recordingToolGateway()
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { toolGateway: gateway.toolGateway })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    await bridge.prompt(sessionId, 'browser [{"tool":"browser_tabs"}]', rid(), { freshContext: true })
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe(`browser_tabs: ok: tab ${TAB}`)
    const opens = received(await fixture.log(), 'session/new')
    expect(opens).toHaveLength(2)
    expect(new Set(opens.map(entry => entry.pid)).size).toBe(1)
    expect(gateway.leases.map(lease => lease.closed)).toEqual([true, false])
    expect(browserEntry(opens[1]!)!.args.at(-1)).toBe(gateway.leases[1]!.tokenFile)
  })

  it('attaches no server while the Host declines, and attaches it when the session next resumes', async () => {
    const admit = { now: false }
    const gateway = await recordingToolGateway({ admit })
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh', FAKE_ACP_CAPS: 'resume' }, {}, {}, { toolGateway: gateway.toolGateway })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'browser [{"tool":"browser_tabs"}]', requestId: rid() })
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('no latch-browser')
    expect((received(await fixture.log(), 'session/new')[0]!.params as { mcpServers: unknown[] }).mcpServers).toEqual([])
    expect(gateway.leases).toEqual([])
    // The desktop app is open now; the session's process is not new, so nothing changes until the session resumes.
    admit.now = true
    await bridge.prompt(sessionId, 'browser [{"tool":"browser_tabs"}]', rid(), {})
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe('no latch-browser')
    await bridge.close()
    const restored = await fixture.open()
    await restored.prompt(sessionId, 'browser [{"tool":"browser_tabs"}]', rid(), {})
    expect(assistants(await settled(restored, sessionId)).at(-1)?.text).toBe(`browser_tabs: ok: tab ${TAB}`)
    expect(browserEntry(received(await fixture.log(), 'session/resume')[0]!)!.args.at(-1)).toBe(gateway.leases[0]!.tokenFile)
  })

  it("names the agent's own ask on the one call it then makes, and says the turn runs", async () => {
    const gateway = await recordingToolGateway()
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { toolGateway: gateway.toolGateway })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: `browser [{"tool":"browser_click","args":{"tabId":"${TAB}","ref":"e1"},"ask":true}]`,
      requestId: rid(),
    })
    const approval = await vi.waitFor(async () => {
      const [first] = await bridge.approvals()
      expect(first).toBeDefined()
      return first!
    })
    expect(approval).toMatchObject({ toolName: 'mcp__latch-browser__browser_click', advisory: true })
    await bridge.decide(approval.id, 'allow')
    const { runId } = (await settled(bridge, sessionId)).summary
    expect(runId).toEqual(expect.any(String))
    expect(gateway.calls).toEqual([
      {
        tool: 'browser_click',
        args: { tabId: TAB, ref: 'e1' },
        context: { turn: 'running', runId, toolCallId: approval.toolCallId, approvalId: approval.id },
      },
    ])
  })

  it('names no approval when two identical calls cannot be told apart, and none from another server’s tool of the same name', async () => {
    const gateway = await recordingToolGateway()
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { toolGateway: gateway.toolGateway })
    const bridge = await fixture.open()
    const click = { tool: 'browser_click', args: { tabId: TAB, ref: 'e1' }, ask: true }
    const { sessionId } = await bridge.createTask({ prompt: `browser ${JSON.stringify([{ ...click, twin: true }])}`, requestId: rid() })
    const allow = async () => {
      const { approvals } = await until(bridge, sessionId, detail => detail.approvals.length === 1)
      const approval = approvals[0]!
      await bridge.decide(approval.id, 'allow')
      return approval
    }
    const twin = await allow()
    const firstRun = (await settled(bridge, sessionId)).summary.runId
    expect(firstRun).toEqual(expect.any(String))
    // The oldest row is named; the approval is not, since its twin could be the call that ran.
    expect(gateway.calls[0]!.context).toEqual({ turn: 'running', runId: firstRun, toolCallId: twin.toolCallId })
    await bridge.prompt(sessionId, `browser ${JSON.stringify([{ ...click, title: 'mcp__playwright__browser_click' }])}`, rid(), {})
    await allow()
    const secondRun = (await settled(bridge, sessionId)).summary.runId
    expect(secondRun).toEqual(expect.any(String))
    expect(secondRun).not.toBe(firstRun)
    expect(gateway.calls).toHaveLength(2)
    expect(gateway.calls[1]!.context).toEqual({ turn: 'running', runId: secondRun })
  })

  it('confirms a stop only once the browser call settled, and says when its result is unknown', async () => {
    const stopRequested = deferred()
    const releaseReply = deferred()
    const gateway = await recordingToolGateway({
      unknown: true,
      beforeStopReply: () => {
        stopRequested.resolve()
        return releaseReply.promise
      },
    })
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { toolGateway: gateway.toolGateway })
    const bridge = await fixture.open()
    cleanups.push(releaseReply.resolve)
    const { sessionId } = await bridge.createTask({
      prompt: `browser [{"tool":"browser_wait","args":{"tabId":"${TAB}","text":"never"}}]`,
      requestId: rid(),
    })
    await gateway.firstCall
    expect(gateway.calls).toHaveLength(1)
    let inflightAtConfirmation: number | undefined
    const cancel = bridge.cancel(sessionId).then(() => {
      inflightAtConfirmation = gateway.leases[0]!.inflight
    })
    try {
      await stopRequested.promise
      expect((await bridge.detail(sessionId)).summary.status).not.toBe('cancelled')
      expect(inflightAtConfirmation).toBeUndefined()
    } finally {
      releaseReply.resolve()
    }
    await cancel
    expect(inflightAtConfirmation).toBe(0)
    const stopped = await settled(bridge, sessionId)
    expect(stopped.summary.status).toBe('cancelled')
    expect(gateway.leases[0]!.cancels).toBeGreaterThanOrEqual(1)
    expect(systemText(stopped)).toContain('浏览器调用结果未知')
  })

  it('gives 我的 Agent both its memory server and the same session-bound browser gateway', async () => {
    const gateway = await recordingToolGateway()
    const fixture = await setup({ FAKE_ACP_MCP: 'dsh' }, {}, {}, { toolGateway: gateway.toolGateway, proposeMemory: async () => {} })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'browser [{"tool":"browser_tabs"}]',
      requestId: rid(),
      agentContext: { agent: { customAgentId: `agt_${randomUUID()}` }, instructions: '', revision: 'a'.repeat(64), proposals: true },
    })
    expect(assistants(await settled(bridge, sessionId)).at(-1)?.text).toBe(`browser_tabs: ok: tab ${TAB}`)
    expect(gateway.leases).toHaveLength(1)
    const servers = (received(await fixture.log(), 'session/new')[0]!.params as { mcpServers: Array<{ name: string }> }).mcpServers
    expect(servers.map(server => server.name).sort()).toEqual(['latch-browser', 'latch-skills'])
  })
})

describe("what the Host reads and removes in a Harness CLI's own record", () => {
  const GOOSE = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'chat,approve,auto', FAKE_ACP_INITIAL_MODE: 'approve' }
  const QWEN = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: QWEN_MODES, FAKE_ACP_INITIAL_MODE: 'default' }

  /** A session of `presetId`'s profile that ran one turn, and the bridge of a Host started again on the same data. */
  async function afterRestart(presetId: string | undefined, env: Record<string, string>, options: AcpAgentOptions = {}) {
    const fixture = await setup(env, options, presetId ? { presetId } : {})
    const first = await fixture.open()
    const { sessionId } = await first.createTask({ prompt: 'echo one', requestId: rid() })
    expect(systemText(await settled(first, sessionId))).toBe('')
    await first.close()
    const agentSession = received(await fixture.log(), 'session/prompt')[0]!.params!.sessionId as string
    return { fixture, bridge: await fixture.open(), sessionId, agentSession }
  }

  it('opens a goose session again only once its record shows no tool confirmation left, and never without reading it', async () => {
    // Without the Host's read nothing says what goose would go on with, so it is never asked to load.
    const unread = await afterRestart('goose', { ...GOOSE, FAKE_ACP_CAPS: 'load' })
    await expect(unread.bridge.prompt(unread.sessionId, 'echo two', rid())).rejects.toMatchObject({
      status: 409,
      code: 'harness-resume-unchecked',
    })
    expect(received(await unread.fixture.log(), 'session/load')).toEqual([])
    // Clearing the context lets the session go on in Latch with a new goose session, and nothing is loaded.
    await unread.bridge.prompt(unread.sessionId, 'echo fresh', rid(), { freshContext: true })
    expect(systemText(await settled(unread.bridge, unread.sessionId))).toBe('')
    expect(received(await unread.fixture.log(), 'session/load')).toEqual([])
    expect(received(await unread.fixture.log(), 'session/new')).toHaveLength(2)

    // A record that stopped on a confirmation: goose would go on with that turn by itself, one nobody sent here.
    let verdict: 'clear' | 'blocked' = 'blocked'
    const asked: unknown[] = []
    const cliStore: CliStoreAccess = {
      resumeState: async input => {
        asked.push(input)
        return verdict
      },
    }
    const held = await afterRestart('goose', { ...GOOSE, FAKE_ACP_CAPS: 'load' }, { storeAccess: cliStore })
    const requestId = rid()
    await expect(held.bridge.prompt(held.sessionId, 'echo two', requestId)).rejects.toMatchObject({
      status: 409,
      code: 'harness-resume-pending-tool',
    })
    expect(received(await held.fixture.log(), 'session/load')).toEqual([])
    expect(asked).toMatchObject([{ presetId: 'goose', sessionId: held.agentSession }])
    const detail = await held.bridge.detail(held.sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(detail.messages).toHaveLength(2)

    // Nothing left to go on with: the session opens and the turn runs.
    verdict = 'clear'
    await held.bridge.prompt(held.sessionId, 'echo two', rid())
    expect((await settled(held.bridge, held.sessionId)).messages.map(message => message.text)).toEqual([
      'echo one',
      'echo: echo one',
      'echo two',
      'echo: echo two',
    ])
    expect(received(await held.fixture.log(), 'session/load')).toHaveLength(1)

    // A harness that resumes without going on with a turn is not asked about.
    const plain = await afterRestart(undefined, { FAKE_ACP_CAPS: 'load' })
    await plain.bridge.prompt(plain.sessionId, 'echo two', rid())
    await settled(plain.bridge, plain.sessionId)
    expect(received(await plain.fixture.log(), 'session/load')).toHaveLength(1)
  })

  it("removes Latch's MCP servers from goose's record of a session before its process stops", async () => {
    const fixture = await setup({ ...GOOSE, FAKE_ACP_CAPS: 'load' }, { idleMs: 80, agentIdleMs: 80 }, { presetId: 'goose' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({
      prompt: 'echo hi',
      requestId: rid(),
      agentContext: {
        agent: { customAgentId: `agt_${randomUUID()}` },
        instructions: '',
        skillBodies: [{ id: 'plugin:list', name: '审阅清单', description: '逐项检查', content: 'SKILL BODY' }],
        revision: 'a'.repeat(64),
      },
    })
    await settled(bridge, sessionId)
    const log = await vi.waitFor(
      async () => {
        const current = await fixture.log()
        expect(current.some(entry => entry.event === 'stdin-end')).toBe(true)
        return current
      },
      { timeout: 5_000, interval: 20 },
    )
    const agentSession = received(log, 'session/new')[0]!.params as { mcpServers: Array<{ name: string }> }
    expect(agentSession.mcpServers.map(server => server.name)).toEqual(['latch-skills'])
    const removed = received(log, '_goose/unstable/session/extensions/remove')
    expect(removed.map(entry => entry.params)).toEqual([
      { sessionId: received(log, 'session/prompt')[0]!.params!.sessionId, extensionKey: 'latch-skills' },
    ])
    // Asked while the process still read its input.
    expect(log.indexOf(removed[0]!)).toBeLessThan(log.findIndex(entry => entry.event === 'stdin-end'))
  })

  it("deletes a goose session's subagent sessions with it, as the Host found them in goose's record", async () => {
    const asked: unknown[] = []
    const cliStore: CliStoreAccess = {
      resumeState: async () => 'clear',
      childSessions: async input => {
        asked.push(input)
        return ['child-1']
      },
    }
    const { fixture, bridge, sessionId, agentSession } = await afterRestart(
      'goose',
      { ...GOOSE, FAKE_ACP_CAPS: 'load,delete' },
      { storeAccess: cliStore },
    )
    await bridge.remove!(sessionId)
    await vi.waitFor(
      async () =>
        expect(received(await fixture.log(), 'session/delete').map(entry => entry.params?.sessionId)).toEqual(['child-1', agentSession]),
      { timeout: 5_000, interval: 10 },
    )
    expect(asked).toMatchObject([{ presetId: 'goose', sessionIds: [agentSession] }])
  })

  it("deletes a Qwen Code session with its own request, which takes the session's folder", async () => {
    const { fixture, bridge, sessionId, agentSession } = await afterRestart('qwen', { ...QWEN, FAKE_ACP_CAPS: 'resume' })
    expect(Object.keys(await fixture.agentSessions())).toEqual([agentSession])
    await bridge.remove!(sessionId)
    await vi.waitFor(async () => expect(await fixture.agentSessions()).toEqual({}), { timeout: 5_000, interval: 10 })
    const log = await fixture.log()
    expect(received(log, 'deleteSession').map(entry => entry.params)).toEqual([{ sessionId: agentSession, cwd: fixture.workspace }])
    expect(received(log, 'session/delete')).toEqual([])
  })

  it('has the Host remove the DeepSeek Harness record of a removed session, and of a list read, once the process is gone', async () => {
    const removed: Array<{ sessionId: string; cwd: string; alive: boolean }> = []
    let pids: number[] = []
    const cliStore: CliStoreAccess = {
      removeSession: async ({ sessionId, cwd }) => {
        removed.push({ sessionId, cwd, alive: pids.some(alive) })
        return true
      },
    }
    const env = { FAKE_ACP_CONFIG: 'options', FAKE_ACP_PROCESS_MODE: '1', FAKE_ACP_CAPS: 'resume,close' }
    const fixture = await setup(env, { storeAccess: cliStore }, { presetId: 'dsh' })
    const bridge = await fixture.open()
    const { sessionId } = await bridge.createTask({ prompt: 'echo one', requestId: rid() })
    await settled(bridge, sessionId)
    pids = (await fixture.log()).filter(entry => entry.event === 'start').map(entry => entry.pid)
    const agentSession = received(await fixture.log(), 'session/prompt')[0]!.params!.sessionId as string
    await bridge.remove!(sessionId)
    await vi.waitFor(() => expect(removed).toHaveLength(1), { timeout: 5_000, interval: 10 })
    expect(removed[0]).toEqual({ sessionId: agentSession, cwd: fixture.workspace, alive: false })
    // dsh offers no deletion, so no process is started to ask.
    expect((await fixture.log()).filter(entry => entry.event === 'start')).toHaveLength(1)

    // The empty session of a list read goes too, after its process.
    expect(await bridge.readCatalogue!({ auto: false })).toEqual({ ran: true })
    const log = await fixture.log()
    const read = received(log, 'session/new').at(-1)!
    pids = log.filter(entry => entry.event === 'start').map(entry => entry.pid)
    await vi.waitFor(() => expect(removed).toHaveLength(2), { timeout: 5_000, interval: 10 })
    expect(removed[1]).toMatchObject({ cwd: read.params!.cwd, alive: false })
    expect(received(log, 'session/close')).toHaveLength(1)
  })

  it("counts what Qwen Code's own update runs in its launch fingerprint, and nothing when it runs itself", async () => {
    let code: string | undefined
    const calls: unknown[] = []
    const cliStore: CliStoreAccess = {
      launchCode: input => {
        calls.push(input)
        return code
      },
    }
    const fixture = await setup(QWEN, { storeAccess: cliStore }, { presetId: 'qwen' })
    const bridge = await fixture.open()
    const plain = await bridge.launchPreview!({ cwd: fixture.workspace })
    code = 'a'.repeat(64)
    const updated = await bridge.launchPreview!({ cwd: fixture.workspace })
    expect(calls.at(-1)).toMatchObject({ presetId: 'qwen', command: process.execPath })
    expect(updated.definitionHash).not.toBe(plain.definitionHash)
    code = 'b'.repeat(64)
    expect((await bridge.launchPreview!({ cwd: fixture.workspace })).definitionHash).not.toBe(updated.definitionHash)
    // Back to running itself, it is the launch it was, as for a Host that reads no store.
    code = undefined
    expect((await bridge.launchPreview!({ cwd: fixture.workspace })).definitionHash).toBe(plain.definitionHash)
    expect(plain.definitionHash).toBe(
      launchHash({
        resolvedCommand: process.execPath,
        args: [FAKE_ACP_AGENT],
        definitionEnv: fixture.record.env,
        presetId: 'qwen',
        profileVersion: profileFor('qwen')!.version,
        ...launchExtras('qwen'),
      }),
    )
  })
})
