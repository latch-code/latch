import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  MAX_SESSION_SKILLS_BYTES,
  type AppSnapshot,
  type HarnessCommandCatalogue,
  type TaskDetail,
  type WorkspaceInfo,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { createRuntime } from '@latch/core'
import type { Bridge, CreateTaskInput, HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { HarnessHub } from '../src/hub.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('keeps a folder-aware cache reader on its original own-folder input without an incomplete project scope', async () => {
  const seen: CreateTaskInput[] = []
  const plugin: HarnessPlugin = {
    id: 'all-cache',
    name: 'All cache',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerHarness({
        id: 'all-cache',
        name: 'All cache',
        version: '1',
        projectFolders: 'all',
        create(options) {
          const bridge: Bridge = createRuntime(options)
          const create = bridge.createTask.bind(bridge)
          bridge.createTask = async input => {
            seen.push(input)
            return create(input)
          }
          bridge.commandCatalogue = async () => undefined
          return bridge
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin], sessionFolders: true })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { harnessId: 'all-cache', mode: 'agent', workspaceId: 'default', prompt: 'Hi', requestId: randomUUID() },
  })
  await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
  expect(seen).toHaveLength(1)
  expect(seen[0]?.folders).toBeUndefined()
  expect(seen[0]?.workspaceId).toBeUndefined()
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.sessionFolder).toBeDefined()
})

async function fixture(presetId?: 'opencode' | 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-harness-commands-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const paths = [join(root, 'project-a'), join(root, 'project-b')]
  for (const path of paths) await mkdir(path)
  const log = join(root, 'agent.jsonl')
  const commandsFile = join(root, 'commands.json')
  await writeFile(
    commandsFile,
    JSON.stringify(
      presetId === 'codex'
        ? Array.from({ length: 205 }, (_, index) => ({
            name: `public-${index}`,
            description: 'Public skill',
            path: `/private/official-skills/${index}/SKILL.md`,
            scope: 'repo',
            enabled: true,
          }))
        : [{ name: 'public-plan', description: 'Project command' }],
    ),
  )
  const bin = join(root, 'bin')
  const command = join(bin, 'codex')
  if (presetId === 'codex') {
    await mkdir(bin)
    await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(command, 0o755)
  }
  const options = {
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'default'),
    ...(presetId === 'codex'
      ? {
          commandDirectories: () => [bin],
          loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
          detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
        }
      : {}),
  }
  let host = await startTestHost(options)
  cleanups.push(() => host.close())
  let owner = await host.enroll({ listener: 'unix' })
  let work = await host.enroll({ scopes: ['view', 'run'] })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const projects: WorkspaceInfo[] = []
  for (const path of paths)
    projects.push(((await (await owner.addFolders({ paths: [path] })).json()) as { workspace: WorkspaceInfo }).workspace)
  await owner.confirmedJson('agents', {
    body: {
      id: 'fake',
      ...(presetId ? { presetId } : {}),
      name: 'Fake',
      command: presetId === 'codex' ? 'codex' : process.execPath,
      args: presetId === 'codex' ? [] : [FAKE_ACP_AGENT],
      env: {
        FAKE_ACP_LOG: log,
        ...(presetId === 'opencode' ? { FAKE_ACP_CONFIG: 'legacy' } : {}),
        ...(presetId === 'codex' ? { FAKE_CODEX_SKILLS_FILE: commandsFile, FAKE_CODEX_STATE: join(root, 'threads.json') } : {}),
        FAKE_ACP_COMMANDS_FILE: commandsFile,
      },
    },
  })
  const starts = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string })
      .filter(line => line.event === 'start').length
  const read = (project = projects[0]!, device: TestDevice = work) =>
    device.json<{ catalogue: HarnessCommandCatalogue | null }>('agents/fake/commands', {
      method: 'POST',
      body: { workspaceId: project.id },
    })
  const create = async (device: TestDevice = work) => {
    const { sessionId } = await device.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake', workspaceId: projects[0]!.id, prompt: 'plan', requestId: randomUUID() },
    })
    await vi.waitFor(async () => expect((await device.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    return sessionId
  }
  return {
    root,
    paths,
    projects,
    starts,
    read,
    create,
    host: () => host,
    owner: () => owner,
    work: () => work,
    restart: async () => {
      await host.close()
      host = await startTestHost(options)
      owner = await host.enroll({ listener: 'unix' })
      work = await host.enroll({ scopes: ['view', 'run'] })
      await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    },
  }
}

it('reads a real session command cache for a normal view device, isolates projects, and survives restart without a CLI start', async () => {
  const f = await fixture()
  expect(await f.read()).toEqual({ catalogue: null })
  expect(
    (
      await f.work().request('agents/fake/commands', {
        method: 'POST',
        body: { workspaceId: f.projects[0]!.id, cwd: f.root },
      })
    ).status,
  ).toBe(400)
  expect(await f.starts()).toBe(0)
  const id = await f.create()
  await vi.waitFor(async () =>
    expect(await f.read()).toMatchObject({
      catalogue: { source: 'previous-session', commands: [{ name: 'public-plan', description: 'Project command' }] },
    }),
  )
  const before = await f.starts()
  expect(before).toBe(1)
  expect(await f.read(f.projects[1]!)).toEqual({ catalogue: null })
  const viewer = await f.host().enroll({ scopes: ['view'] })
  await f.owner().json(`devices/${viewer.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const publicResult = await f.read(f.projects[0]!, viewer)
  expect(publicResult.catalogue?.commands[0]?.name).toBe('public-plan')
  expect(JSON.stringify(publicResult)).not.toContain(id)
  expect(JSON.stringify(publicResult)).not.toContain(f.root)
  await f.restart()
  expect((await f.read()).catalogue?.commands[0]?.name).toBe('public-plan')
  expect(await f.starts()).toBe(before)
})

it('carries bounded native skills and truncation through authorized HTTP cache reads and restart without starting a CLI', async () => {
  const f = await fixture('codex')
  const id = await f.create()
  const expected = { name: 'public-0', description: 'Public skill', invocation: '$public-0', scope: 'project' }
  await vi.waitFor(async () => expect((await f.read()).catalogue?.skills?.[0]).toEqual(expected))
  const read = await f.read()
  expect(read.catalogue?.skills).toHaveLength(200)
  expect(read.catalogue?.skillsTruncated).toBe(true)
  expect(read.catalogue?.commands.map(command => command.name)).toEqual(['compact'])
  expect(Buffer.byteLength(JSON.stringify({ skills: read.catalogue?.skills, skillsTruncated: true }))).toBeLessThanOrEqual(
    MAX_SESSION_SKILLS_BYTES,
  )
  expect(JSON.stringify(read)).not.toContain('/private/official-skills')
  expect(JSON.stringify(read)).not.toContain(id)
  expect(await f.read(f.projects[1]!)).toEqual({ catalogue: null })
  const before = await f.starts()
  await f.restart()
  expect(await f.read()).toEqual(read)
  expect(await f.starts()).toBe(before)
  expect((await f.work().json<TaskDetail>(`tasks/${id}`)).skills?.[0]).toEqual(expected)
  await makePrivate(f, id)
  expect(await f.read()).toEqual({ catalogue: null })
  await writeFile(
    join(f.root, 'commands.json'),
    JSON.stringify([
      { name: 'private-note', description: 'Private new report', path: '/private/new-report/SKILL.md', scope: 'user', enabled: true },
    ]),
  )
  await f.owner().json(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'skills-changed', requestId: randomUUID() } })
  await vi.waitFor(async () => expect((await f.read(f.projects[0]!, f.owner())).catalogue?.skills?.[0]?.name).toBe('private-note'))
  expect(await f.read()).toEqual({ catalogue: null })
})

async function makePrivate(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  // Model a Host-owned private-context transition through its actual Bridge, not by editing session files.
  await f.host().host.bridge.prompt(id, 'Continue', randomUUID(), {
    agentContext: { instructions: 'PRIVATE SOURCE CONTEXT', revision: 'a'.repeat(64) },
  })
  await vi.waitFor(async () => expect((await f.owner().json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle'))
  expect((await f.work().request(`tasks/${id}`)).status).toBe(403)
}

it('changes the public cache generation when its confirmed driver definition is replaced, without starting a CLI', async () => {
  const f = await fixture()
  const generation = async () =>
    (await f.work().json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'fake')?.commandCatalogue?.generation
  const before = await generation()
  expect(before).toBeTypeOf('string')
  expect(
    (await f.work().json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'standard')?.commandCatalogue,
  ).toBeUndefined()
  await f.create()
  await vi.waitFor(async () => expect((await f.read()).catalogue).not.toBeNull())
  const started = await f.starts()
  expect(await generation()).toBe(before)
  await f.owner().confirmedJson('agents/fake', { method: 'PUT', body: { env: { PUBLIC_CACHE_REVISION: 'next' } } })
  const next = await generation()
  expect(next).toBeTypeOf('string')
  expect(next).not.toBe(before)
  expect(await f.read()).toEqual({ catalogue: null })
  expect(await f.starts()).toBe(started)
})

it('never exposes a private source through a work-scoped draft cache or without device authentication', async () => {
  const f = await fixture()
  const id = await f.create()
  await vi.waitFor(async () => expect((await f.read()).catalogue).not.toBeNull())
  await makePrivate(f, id)
  expect(await f.read()).toEqual({ catalogue: null })
  expect((await f.read(f.projects[0]!, f.owner())).catalogue?.commands[0]?.name).toBe('public-plan')
  await writeFile(join(f.root, 'commands.json'), JSON.stringify([{ name: 'private-plan', description: `Private note in ${f.root}` }]))
  await f.owner().json(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'plan', requestId: randomUUID() } })
  await vi.waitFor(async () => expect((await f.read(f.projects[0]!, f.owner())).catalogue?.commands[0]?.name).toBe('private-plan'))
  const hidden = await f.read()
  expect(hidden).toEqual({ catalogue: null })
  expect(JSON.stringify(hidden)).not.toContain(f.root)
  expect(JSON.stringify(hidden)).not.toContain('private-plan')
  expect(
    (
      await f.host().raw('loopback-tcp', 'api/agents/fake/commands', {
        method: 'POST',
        body: { workspaceId: f.projects[0]!.id },
      })
    ).status,
  ).toBe(401)
})

const changes = [
  'revoked',
  'narrowed',
  'source-private',
  'source-deleted',
  'directory-replaced',
  'project-config-changed',
  'harness-disabled',
] as const
it.each([
  ...changes.map(change => ({ change, pass: 1 })),
  ...(['revoked', 'narrowed', 'source-private'] as const).map(change => ({ change, pass: 2 })),
])('rechecks $change after cache read $pass', async ({ change, pass }) => {
  const f = await fixture(change === 'project-config-changed' ? 'opencode' : undefined)
  const id = await f.create()
  await vi.waitFor(async () => expect((await f.read()).catalogue).not.toBeNull())
  const caller = change === 'narrowed' ? await f.host().enroll({ scopes: ['view', 'run'] }) : f.work()
  if (change === 'narrowed') await f.owner().confirmedJson(`devices/${caller.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(done => {
    enter = done
  })
  const waiting = new Promise<void>(done => {
    release = done
  })
  const read = HarnessHub.prototype.commandCatalogueOf
  let reads = 0
  const spy = vi.spyOn(HarnessHub.prototype, 'commandCatalogueOf').mockImplementation(async function (this: HarnessHub, ...args) {
    const result = await read.apply(this, args)
    if (++reads === pass) {
      enter()
      await waiting
    }
    return result
  })
  const pending = caller.request('agents/fake/commands', { method: 'POST', body: { workspaceId: f.projects[0]!.id } })
  try {
    await entered
    if (change === 'revoked') await f.owner().json(`devices/${caller.id}`, { method: 'DELETE' })
    else if (change === 'narrowed') await f.owner().json(`devices/${caller.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    else if (change === 'source-private') await makePrivate(f, id)
    else if (change === 'source-deleted') await f.owner().json(`tasks/${id}`, { method: 'DELETE' })
    else if (change === 'directory-replaced') {
      await rename(f.paths[0]!, join(f.root, 'old-project'))
      await mkdir(f.paths[0]!)
    } else if (change === 'project-config-changed') await writeFile(join(f.paths[0]!, 'opencode.json'), '{}')
    else await f.owner().json('agents/fake', { method: 'PUT', body: { enabled: false } })
    release()
    const result = await pending
    if (change === 'revoked' || change === 'narrowed') expect(result.status).toBe(change === 'revoked' ? 401 : 403)
    else {
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ catalogue: null })
    }
  } finally {
    release()
    await pending.catch(() => {})
    spy.mockRestore()
  }
})
