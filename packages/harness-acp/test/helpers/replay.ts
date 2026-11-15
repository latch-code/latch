/** The driver opened the way a Host opens it, for replays, recordings and the recording command. */
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_PRESETS } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessHostOptions, HarnessPlugin } from '@latch/sdk'
import { playScenario, readReplayStatus, readTranscript, REPLAY_AGENT, replayEnv } from '@latch/testkit'
import { createAcpAgentPlugin, setCommandSearch, type AcpAgentOptions, type AgentRecord } from '../../src/index.ts'

type Cleanups = Array<() => Promise<void> | void>

export async function activate(plugin: HarnessPlugin, cleanups: Cleanups): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const refuse = () => {
    throw new Error('an agent plugin registers only its harness')
  }
  await plugin.activate({
    registerHarness: driver => void drivers.push(driver),
    registerProvider: refuse,
    registerTool: refuse,
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: refuse,
    onDispose: dispose => void disposers.push(dispose),
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]!
}

/** A bridge started on these directories, whose `createTask` carries the launch fingerprint a Host's start records. */
export async function openBridge(
  driver: HarnessDriver,
  paths: { dataDir: string; workspace: string; tmpRoot: string },
  cleanups: Cleanups,
  host: Pick<HarnessHostOptions, 'toolGateway' | 'projects' | 'workspaces'> = {},
): Promise<Bridge> {
  const bridge = driver.create({
    ...host,
    dataDir: paths.dataDir,
    workspaceRoot: paths.workspace,
    tmpRoot: paths.tmpRoot,
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
  const create = bridge.createTask.bind(bridge)
  bridge.createTask = async input =>
    create({
      ...input,
      expectedLaunchHash: (
        await bridge.launchPreview!({ cwd: input.cwd ?? paths.workspace, config: input.config, modelRoute: input.modelRoute })
      ).launchHash,
    })
  return bridge
}

/** Stands in for every program a preset names: running one leaves a mark, so a test can tell nothing real was reached. */
export async function fakePrograms(bin: string, marks: string): Promise<void> {
  await mkdir(bin, { recursive: true })
  const names = new Set(
    AGENT_PRESETS.flatMap(preset => [preset.command, preset.agentCommand, preset.login?.command].filter(Boolean) as string[]),
  )
  for (const name of names) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "$0 $*" > "${marks}/${name}-$$"\nexit 3\n`)
    await chmod(join(bin, name), 0o755)
  }
}

const FAST: AcpAgentOptions = { cancelGraceMs: 2_000, stopGraceMs: 300, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }

/**
 * Plays a transcript's scenario through the real driver against the replay agent. Bare command names resolve only to
 * fake programs, so a preset's programs are never what this computer has installed.
 */
export async function replayTranscript(path: string, cleanups: Cleanups, host: Pick<HarnessHostOptions, 'toolGateway'> = {}) {
  const transcript = readTranscript(path)
  const root = await mkdtemp(join(tmpdir(), 'latch-replay-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const paths = { dataDir: join(root, 'data'), workspace: await realpath(workspace), tmpRoot: join(root, 'run-tmp') }
  await mkdir(paths.tmpRoot, { mode: 0o700 })
  const bin = join(root, 'bin')
  const marks = join(root, 'marks')
  await mkdir(marks)
  await fakePrograms(bin, marks)
  setCommandSearch(() => [bin])
  const status = join(root, 'status.json')
  const record: AgentRecord = {
    id: transcript.header.harness,
    name: AGENT_PRESETS.find(preset => preset.id === transcript.header.harness)?.name ?? transcript.header.harness,
    presetId: transcript.header.harness,
    command: process.execPath,
    args: [REPLAY_AGENT],
    env: replayEnv({ transcript: path, status, workspace: paths.workspace }),
    enabled: true,
  }
  const driver = await activate(createAcpAgentPlugin(record, FAST), cleanups)
  // Only a scenario that brings a session in has a project: the others start in the bare workspace, as before.
  const project = transcript.header.steps.some(step => step.step === 'adopt')
    ? { id: 'replay', folders: [{ id: 'main', path: paths.workspace }] }
    : undefined
  const projects = project ? { projects: () => [structuredClone(project)], workspaces: () => [paths.workspace] } : {}
  const played = await playScenario({
    open: () => openBridge(driver, paths, cleanups, { ...host, ...projects }),
    steps: transcript.header.steps,
    cwd: paths.workspace,
    ...(project ? { project } : {}),
    stopped: () => {
      const failure = readReplayStatus(status)?.failure
      return failure && `${failure.detail} at entry ${failure.cursor}: ${JSON.stringify(failure.actual)}`
    },
  })
  const detail = await played.bridge.detail(played.sessionId)
  const pending = played.bridge.approvals().filter(approval => approval.sessionId === played.sessionId)
  await played.bridge.close()
  return {
    transcript,
    detail,
    pending,
    status: readReplayStatus(status),
    bin,
    marks: await readdir(marks),
    ...(played.listed ? { listed: played.listed } : {}),
  }
}
