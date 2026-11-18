import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionsResponse, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { Bridge } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, FAKE_PI_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(preset?: 'codex' | 'pi', sessionFolders = false) {
  const codex = preset === 'codex'
  const pi = preset === 'pi'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-extensions-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const log = join(root, 'agent.jsonl')
  const commands = join(root, 'commands.json')
  await writeFile(commands, JSON.stringify([{ name: 'public-plan', description: '检查计划' }]))
  const skills = join(root, 'skills.json')
  await writeFile(
    skills,
    JSON.stringify([{ name: 'review', description: '审查', path: join(root, 'review', 'SKILL.md'), scope: 'repo', enabled: true }]),
  )
  const bin = join(root, 'bin')
  const program = join(bin, preset ?? 'unused')
  if (preset) {
    await mkdir(bin)
    await writeFile(program, `#!/bin/sh\nexec '${process.execPath}' '${codex ? FAKE_CODEX_APP_SERVER : FAKE_PI_AGENT}' "$@"\n`)
    await chmod(program, 0o755)
  }
  const start = () =>
    startTestHost({
      dataDir: join(root, 'data'),
      workspaceRoot: join(root, 'default'),
      sessionFolders,
      ...(preset
        ? {
            commandDirectories: () => [bin],
            loginPrograms: (name: string) => (name === preset ? program : undefined),
            detectPreset: ({ id }: { id: string }) => (id === preset ? { found: true, path: program } : { found: false }),
          }
        : {}),
    })
  const host = await start()
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const workspace = ((await (await owner.addFolders({ paths: [project], name: '扩展项目' })).json()) as { workspace: WorkspaceInfo })
    .workspace
  await owner.confirmedJson('agents', {
    body: {
      id: 'fake',
      ...(preset ? { presetId: preset } : {}),
      name: 'Fake',
      command: preset ?? process.execPath,
      args: preset ? [] : [FAKE_ACP_AGENT],
      env: {
        FAKE_ACP_LOG: log,
        FAKE_ACP_COMMANDS_FILE: commands,
        ...(codex ? { FAKE_CODEX_SKILLS_FILE: skills, FAKE_CODEX_STATE: join(root, 'threads.json') } : {}),
        ...(pi ? { FAKE_PI_COMMANDS_FILE: commands, FAKE_PI_LOG: log } : {}),
      },
    },
  })
  const starts = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string })
      .filter(line => line.event === 'start').length
  const create = async (workspaceId = workspace.id) => {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake', workspaceId, prompt: 'plan', requestId: randomUUID() },
    })
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    return sessionId
  }
  const createPrivate = async () => {
    const bridge = host.host.bridge
    const scope = { workspaceId: workspace.id, folders: workspace.folders!.map(({ id, path }) => ({ id, path })) }
    const preview = await bridge.launchPreviewOf('fake', project, scope)
    const { sessionId } = await bridge.createTask({
      harnessId: 'fake',
      cwd: project,
      ...scope,
      prompt: 'plan',
      requestId: randomUUID(),
      expectedLaunchHash: preview!.launchHash,
      agentContext: { instructions: 'PRIVATE SOURCE CONTEXT', revision: 'a'.repeat(64) },
    })
    await vi.waitFor(async () => {
      const { summary } = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      expect(summary.status).toBe('idle')
      expect(summary.commandsVersion).toBeDefined()
      expect(summary.agentPrivate).toBe(true)
    })
    return sessionId
  }
  const read = () => owner.json<ExtensionsResponse>('extensions')
  const reopen = async () => {
    await host.close()
    const restored = await start()
    cleanups.push(() => restored.close())
    return restored.enroll({ listener: 'unix' })
  }
  return { root, host, owner, workspace, commands, log, starts, create, createPrivate, read, reopen }
}

it('lists per Harness only what a session reported, for admin devices only, and starts no program to read it', async () => {
  const f = await fixture()
  expect(await f.read()).toEqual({ harnesses: [{ harnessId: 'fake' }] })
  expect(await f.starts()).toBe(0)

  for (const scopes of [['view'], ['view', 'run']] as const) {
    const device = await f.host.enroll({ scopes: [...scopes] })
    expect((await device.request('extensions')).status).toBe(403)
  }

  const id = await f.create()
  const started = await f.starts()
  await vi.waitFor(async () =>
    expect((await f.read()).harnesses[0]?.report).toMatchObject({
      commands: [{ name: 'public-plan', description: '检查计划' }],
      projectId: f.workspace.id,
    }),
  )
  const body = JSON.stringify(await f.read())
  expect(body).not.toContain(id)
  expect(body).not.toContain(f.root)
  expect((await f.read()).harnesses[0]?.report?.skills).toBeUndefined()
  expect(await f.starts()).toBe(started)
})

it.each(['missing', 'throwing'] as const)('isolates a %s report guard from the other Harnesses', async kind => {
  const f = await fixture()
  await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report).toBeDefined())
  const sourceSessionId = 'legacy-report-session'
  const at = new Date().toISOString()
  const guard = vi.fn(() => {
    throw new Error('Could not verify this legacy report')
  })
  let accepted: unknown
  const legacy: Bridge = {
    async start() {},
    async close() {},
    async createTask() {
      return { sessionId: sourceSessionId }
    },
    async listTasks() {
      return [{ id: sourceSessionId, status: 'idle', title: 'Legacy session', updatedAt: at }]
    },
    async detail() {
      throw new Error('No detail is read for this report')
    },
    async prompt() {},
    async cancel() {},
    approvals: () => [],
    async decide() {
      return false
    },
    subscribe: () => () => {},
    async commandCatalogue() {
      return undefined
    },
    async latestCommandReport(accept) {
      accepted = accept?.(sourceSessionId)
      if (accepted !== true) return undefined
      return {
        sourceSessionId,
        workspaceId: 'default',
        catalogue: { commands: [{ name: 'legacy-plan' }], source: 'previous-session', reportedAt: at },
        ...(kind === 'throwing' ? { current: guard } : {}),
      }
    },
  }
  const hub = f.host.host.bridge
  const create = () => legacy
  await hub.attach({ id: 'legacy', name: 'Legacy', version: '1', create }, { kind: 'plugin', create, release: () => {} })
  await hub.createTask({ harnessId: 'legacy', workspaceId: 'default', requestId: randomUUID(), prompt: 'plan' })

  expect((await f.read()).harnesses).toEqual([
    expect.objectContaining({
      harnessId: 'fake',
      report: expect.objectContaining({ commands: [{ name: 'public-plan', description: '检查计划' }] }),
    }),
    { harnessId: 'legacy' },
  ])
  expect(accepted).toBe(true)
  expect(guard).toHaveBeenCalledTimes(kind === 'throwing' ? 1 : 0)
})

it('falls back to an older usable project report when only the newest project’s additional folder is missing', async () => {
  const f = await fixture()
  await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.projectId).toBe(f.workspace.id))
  const primary = join(f.root, 'newer-primary')
  const additional = join(f.root, 'newer-additional')
  await mkdir(primary)
  await mkdir(additional)
  const { workspace } = (await (await f.owner.addFolders({ paths: [primary, additional] })).json()) as { workspace: WorkspaceInfo }
  expect(workspace.folders).toHaveLength(2)
  await writeFile(f.commands, JSON.stringify([{ name: 'newer-plan' }]))
  await f.create(workspace.id)
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.projectId).toBe(workspace.id))

  await rename(additional, join(f.root, 'moved-additional'))
  expect((await f.read()).harnesses[0]?.report).toMatchObject({ commands: [{ name: 'public-plan' }], projectId: f.workspace.id })
})

it('reads nothing from any CLI home: the same answer with every CLI home absent or unreadable', async () => {
  const f = await fixture()
  await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report).toBeDefined())
  const before = await f.read()
  const locked = join(f.root, 'locked-home')
  await mkdir(join(locked, '.codex'), { recursive: true })
  await chmod(locked, 0o000)
  const names = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR'] as const
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    for (const home of [locked, join(f.root, 'absent-home')]) {
      for (const name of names) process.env[name] = name === 'HOME' ? home : join(home, name.toLowerCase())
      expect(await f.read()).toEqual(before)
    }
  } finally {
    for (const name of names) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await chmod(locked, 0o755)
  }
})

it.each(['default', 'registered', 'session-owned'] as const)(
  'withdraws a %s directory report after its path is replaced, including after a restart',
  async kind => {
    const own = kind === 'session-owned'
    const f = await fixture(own ? 'codex' : undefined, own)
    const workspaceId = kind === 'registered' ? f.workspace.id : 'default'
    const id = await f.create(workspaceId)
    await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report).toBeDefined())
    const { summary } = await f.owner.json<TaskDetail>(`tasks/${id}`)
    expect(summary.workspaceId).toBe(workspaceId)
    if (own) expect(summary.sessionFolder).toBe(true)
    const cwd = summary.cwd!
    const hub = f.host.host.bridge
    const load = hub.latestCommandReportOf.bind(hub)
    let replaced = false
    vi.spyOn(hub, 'latestCommandReportOf').mockImplementationOnce(async (...args) => {
      const found = await load(...args)
      if (found) {
        await rename(cwd, join(f.root, 'previous-directory'))
        await mkdir(cwd)
        replaced = true
      }
      return found
    })
    const starts = await f.starts()
    expect(await f.read()).toEqual({ harnesses: [{ harnessId: 'fake' }] })
    expect(replaced).toBe(true)
    expect(await f.read()).toEqual({ harnesses: [{ harnessId: 'fake' }] })
    const restored = await f.reopen()
    expect(await restored.json<ExtensionsResponse>('extensions')).toEqual({ harnesses: [{ harnessId: 'fake' }] })
    expect(await f.starts()).toBe(starts)
  },
)

it('carries the skills Codex reported, with their scope and no private path', async () => {
  const f = await fixture('codex')
  await f.create()
  await vi.waitFor(async () =>
    expect((await f.read()).harnesses[0]?.report?.skills).toEqual([
      { name: 'review', description: '审查', invocation: '$review', scope: 'project' },
    ]),
  )
  const report = (await f.read()).harnesses[0]?.report
  expect(report?.plugins).toBeUndefined()
  expect(JSON.stringify(report)).not.toContain('SKILL.md')
  const called = (await readFile(f.log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line).method)
  expect(called).not.toContain('plugin/installed')
})

it('returns pi extension directory names from the cache after a restart and excludes private sources', async () => {
  const f = await fixture('pi')
  const makeCommands = async (name: string) => {
    const baseDir = join(f.root, 'package-cache', name)
    await writeFile(
      f.commands,
      JSON.stringify(
        ['check', 'preview'].map(command => ({
          name: command,
          source: 'extension',
          sourceInfo: { source: 'npm:private-source', origin: 'package', baseDir, path: join(baseDir, 'dist', `${command}.ts`) },
        })),
      ),
    )
  }
  await makeCommands('project-tools')
  const id = await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.plugins).toEqual({ names: ['project-tools'] }))
  expect(await f.owner.json<TaskDetail>(`tasks/${id}`)).not.toHaveProperty('plugins')
  const draft = await f.owner.json<{ catalogue: unknown }>('agents/fake/commands', {
    method: 'POST',
    body: { workspaceId: f.workspace.id },
  })
  expect(draft.catalogue).toBeTruthy()
  expect(draft.catalogue).not.toHaveProperty('plugins')
  await makeCommands('private-tools')
  const privateId = await f.createPrivate()
  const privateTask = await f.owner.json<TaskDetail>(`tasks/${privateId}`)
  expect(privateTask.summary.cwd).toBe((await f.owner.json<TaskDetail>(`tasks/${id}`)).summary.cwd)
  expect(privateTask.summary.workspaceId).toBe(f.workspace.id)
  expect((await f.read()).harnesses[0]?.report?.plugins).toEqual({ names: ['project-tools'] })
  const restored = await f.reopen()
  const snapshot = await restored.json<ExtensionsResponse>('extensions')
  expect(snapshot.harnesses[0]?.report?.plugins).toEqual({ names: ['project-tools'] })
  for (const unwanted of ['private-tools', 'private-source', 'package-cache', 'latch-permission', f.root])
    expect(JSON.stringify(snapshot)).not.toContain(unwanted)
})

it('never lists a report from a private session: it falls back to the newest ordinary one, or to none', async () => {
  const f = await fixture()
  const first = await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.projectId).toBe(f.workspace.id))
  await writeFile(f.commands, JSON.stringify([{ name: 'private-plan', description: '私有' }]))
  const id = await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.commands[0]?.name).toBe('private-plan'))
  // A Host-owned private-context transition through the real Bridge, as for the draft cache.
  const makePrivate = async (sessionId: string) => {
    await f.host.host.bridge.prompt(sessionId, 'Continue', randomUUID(), {
      agentContext: { instructions: 'PRIVATE SOURCE CONTEXT', revision: 'a'.repeat(64) },
    })
    await vi.waitFor(async () => expect((await f.owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
  }
  await makePrivate(id)
  const listed = await f.read()
  expect(listed.harnesses[0]?.report).toMatchObject({ commands: [{ name: 'public-plan' }], projectId: f.workspace.id })
  expect(JSON.stringify(listed)).not.toContain('private-plan')
  await writeFile(f.commands, JSON.stringify([{ name: 'temporary-plan' }]))
  const removed = await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.commands[0]?.name).toBe('temporary-plan'))
  expect((await f.owner.request(`tasks/${removed}`, { method: 'DELETE' })).status).toBe(200)
  expect((await f.read()).harnesses[0]?.report?.commands[0]?.name).toBe('public-plan')
  await makePrivate(first)
  expect(await f.read()).toEqual({ harnesses: [{ harnessId: 'fake' }] })
})
