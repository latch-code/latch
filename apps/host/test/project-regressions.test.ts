import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { HostConfig } from '../src/config.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-project-regression-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function fixture(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost(options)
  cleanups.push(() => t.close())
  return t
}
async function settled(t: TestHost, id: string) {
  await vi.waitFor(async () => expect((await t.host.bridge.detail(id)).summary.status).toBe('idle'), { timeout: 5000 })
}
const primaryPlugin: HarnessPlugin = {
  id: 'primary-test',
  name: 'Primary only',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerHarness({ id: 'primary-test', name: 'Primary only', version: '1', create: options => createRuntime(options) })
  },
}

describe('project lifecycle regressions', () => {
  it('resolves files in every original session folder and retires the handles when one leaves its project', async () => {
    const root = await directory()
    const paths = ['api', 'web'].map(name => join(root, name))
    await Promise.all(paths.map(path => mkdir(path)))
    await writeFile(join(paths[1]!, 'notes.md'), '# Notes')
    const t = await fixture()
    const desktop = await t.enroll({ listener: 'unix' })
    const project = ((await (await desktop.addFolders({ paths })).json()) as { workspace: WorkspaceInfo }).workspace
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        prompt: 'Hello',
        requestId: randomUUID(),
        workspaceId: project.id,
        mode: 'chat',
      },
    })
    await settled(t, sessionId)
    const resolve = () =>
      desktop.request(`tasks/${sessionId}/files/resolve`, { method: 'POST', body: { paths: [join(paths[1]!, 'notes.md')] } })
    const before = await resolve()
    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({ files: [{ status: 'ok' }] })
    await desktop.json(`workspaces/${project.id}/folders/${project.folders![1]!.id}`, { method: 'DELETE' })
    expect((await resolve()).status).toBe(409)
  })

  it('keeps legacy and primary-only sessions usable after changing the primary, without changing their directory', async () => {
    const root = await directory()
    const paths = ['api', 'web'].map(name => join(root, name))
    await Promise.all(paths.map(path => mkdir(path)))
    const t = await fixture({ plugins: [primaryPlugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const project = ((await (await desktop.addFolders({ paths })).json()) as { workspace: WorkspaceInfo }).workspace
    const legacy = await t.host.bridge.createTask({ prompt: 'Legacy', requestId: randomUUID(), cwd: paths[0], mode: 'chat' })
    const primary = await desktop.confirmed('tasks', {
      method: 'POST',
      body: {
        prompt: 'Primary only',
        requestId: randomUUID(),
        harnessId: 'primary-test',
        workspaceId: project.id,
        mode: 'chat',
      },
    })
    expect(primary.status).toBe(201)
    const created = (await primary.json()) as { sessionId: string }
    for (const id of [legacy.sessionId, created.sessionId]) await settled(t, id)
    expect((await t.host.bridge.detail(created.sessionId)).summary).toMatchObject({ folderAccess: 'primary', cwd: paths[0] })
    await desktop.json(`workspaces/${project.id}`, {
      method: 'PATCH',
      body: { order: project.folders!.map(folder => folder.id).reverse() },
    })
    for (const id of [legacy.sessionId, created.sessionId]) {
      const answer = await desktop.request(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'Again', requestId: randomUUID() } })
      expect(answer.status).toBe(200)
      await settled(t, id)
      expect((await t.host.bridge.detail(id)).summary).toMatchObject({ cwd: paths[0], workspaceId: project.id })
    }
  })

  it('shows and binds every Host-passed folder for a plugin harness without launchPreview', async () => {
    const root = await directory()
    const paths = ['api', 'web', 'docs'].map(name => join(root, name))
    await Promise.all(paths.map(path => mkdir(path)))
    const plugin: HarnessPlugin = {
      id: 'all-test',
      name: 'All',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerHarness({ id: 'all-test', name: 'All', version: '1', projectFolders: 'all', create: options => createRuntime(options) })
      },
    }
    const t = await fixture({ plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const project = ((await (await desktop.addFolders({ paths: paths.slice(0, 2) })).json()) as { workspace: WorkspaceInfo }).workspace
    const start = () =>
      desktop.confirmed('tasks', {
        method: 'POST',
        body: {
          prompt: 'Hello',
          requestId: randomUUID(),
          harnessId: 'all-test',
          workspaceId: project.id,
          mode: 'chat',
        },
      })
    const first = await start()
    expect(first.status).toBe(201)
    const started = async () =>
      (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
        .findLast(record => record.action === 'task.l3.started')!.detail
    expect(await started()).toMatchObject({ folderCount: 2 })
    const before = await started()
    await settled(t, ((await first.json()) as { sessionId: string }).sessionId)
    await desktop.addFolders({ projectId: project.id, paths: [paths[2]!] })
    expect((await start()).status).toBe(201)
    const after = await started()
    expect(after).toMatchObject({ folderCount: 3 })
    expect(after.launchHash).not.toBe(before.launchHash)
  })

  it('keeps a hand-edited invalid project disabled through unrelated writes and only repairs it after selecting its primary again', async () => {
    const root = await directory()
    const paths = ['api', 'web'].map(name => join(root, name))
    await Promise.all(paths.map(path => mkdir(path)))
    const dataDir = join(root, 'data')
    await mkdir(dataDir)
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        defaults: {},
        plugins: { disabled: [] },
        agents: [],
        workspaces: [{ id: 'edited', name: 'Edited', path: paths[1], folders: [{ id: 'api', path: paths[0] }] }],
      }),
    )
    const t = await fixture({ dataDir, workspaceRoot: join(root, 'start') })
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.json('workspaces/edited', { method: 'PATCH', body: { name: 'Renamed' } })
    const input = { prompt: 'Hello', requestId: randomUUID(), workspaceId: 'edited', mode: 'chat' }
    expect((await desktop.request('tasks', { method: 'POST', body: input })).status).toBe(409)
    const loaded = await HostConfig.open(dataDir)
    expect(loaded.settings().workspaces[0]?.invalid).toBe(true)
    await desktop.addFolders({ projectId: 'edited', replace: 'api', paths: [paths[0]!] })
    expect((await desktop.request('tasks', { method: 'POST', body: input })).status).toBe(201)
    expect((await HostConfig.open(dataDir)).settings().workspaces[0]?.invalid).toBeUndefined()
  })

  it.each(['remove-project', 'remove-folder', 'replace-folder'] as const)('serializes %s with session creation', async action => {
    const root = await directory()
    const paths = ['api', 'web', 'docs'].map(name => join(root, name))
    await Promise.all(paths.map(path => mkdir(path)))
    const t = await fixture()
    const desktop = await t.enroll({ listener: 'unix' })
    const project = ((await (await desktop.addFolders({ paths: paths.slice(0, 2) })).json()) as { workspace: WorkspaceInfo }).workspace
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(done => {
      enter = done
    })
    const held = new Promise<void>(done => {
      release = done
    })
    cleanups.push(async () => {
      release()
    })
    const write = t.host.config.updateSettings.bind(t.host.config)
    vi.spyOn(t.host.config, 'updateSettings').mockImplementationOnce(async (...args) => {
      enter()
      await held
      return write(...args)
    })
    const changing =
      action === 'remove-project'
        ? desktop.request(`workspaces/${project.id}`, { method: 'DELETE' })
        : action === 'remove-folder'
          ? desktop.request(`workspaces/${project.id}/folders/${project.folders![1]!.id}`, { method: 'DELETE' })
          : desktop.addFolders({ projectId: project.id, replace: project.folders![1]!.id, paths: [paths[2]!] })
    await entered
    const creating = desktop.request('tasks', {
      method: 'POST',
      body: { prompt: 'Race', requestId: randomUUID(), workspaceId: project.id, mode: 'chat' },
    })
    await new Promise(done => setTimeout(done, 50))
    release()
    expect((await changing).status).toBe(200)
    const response = await creating
    if (action === 'remove-project') expect(response.status).toBe(400)
    else {
      expect(response.status).toBe(201)
      const { sessionId } = (await response.json()) as { sessionId: string }
      expect((await t.host.bridge.detail(sessionId)).summary.folders?.map(folder => folder.path)).toEqual(
        action === 'remove-folder' ? [paths[0]] : [paths[0], paths[2]],
      )
    }
  })

  it('reuses a created session folder after the memory TTL and after restarting the Host', async () => {
    const root = await directory()
    const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'start'), sessionFolders: true }
    const first = await fixture(options)
    const device = await first.enroll({ listener: 'unix' })
    const input = { prompt: 'Hello', requestId: randomUUID(), mode: 'agent' }
    const created = await device.json<{ sessionId: string }>('tasks', { method: 'POST', body: input })
    await settled(first, created.sessionId)
    const cwd = (await first.host.bridge.detail(created.sessionId)).summary.cwd
    const secret = device.credential
    await first.close()
    const second = await fixture(options)
    const response = await second.raw('unix', 'api/tasks', {
      method: 'POST',
      body: input,
      headers: { authorization: `Latch-Device ${secret}` },
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(created)
    expect((await second.host.bridge.detail(created.sessionId)).summary.cwd).toBe(cwd)
    const file = join(options.dataDir, 'session-folders.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toContain(input.requestId)
  })

  it("keeps another project's starts and changes from waiting for this project's slow start, and this project's removal waiting", async () => {
    const root = await directory()
    const [slowPath, otherPath] = ['slow', 'other'].map(name => join(root, name))
    await Promise.all([slowPath, otherPath].map(path => mkdir(path!)))
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(done => {
      enter = done
    })
    const held = new Promise<void>(done => {
      release = done
    })
    cleanups.push(async () => {
      release()
    })
    const plugin: HarnessPlugin = {
      ...primaryPlugin,
      activate(ctx) {
        ctx.registerHarness({
          id: 'primary-test',
          name: 'Primary only',
          version: '1',
          create(options) {
            const bridge = createRuntime(options)
            const create = bridge.createTask.bind(bridge)
            bridge.createTask = async input => {
              if (input.prompt === 'Slow') {
                enter()
                await held
              }
              return create(input)
            }
            return bridge
          },
        })
      },
    }
    const t = await fixture({ plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const add = async (path: string) =>
      ((await (await desktop.addFolders({ paths: [path] })).json()) as { workspace: WorkspaceInfo }).workspace
    const slow = await add(slowPath!)
    const other = await add(otherPath!)
    const start = (prompt: string, workspaceId: string) =>
      desktop.confirmed('tasks', {
        method: 'POST',
        body: { prompt, requestId: randomUUID(), harnessId: 'primary-test', workspaceId, mode: 'chat' },
      })
    const settledOrder: string[] = []
    const creating = start('Slow', slow.id).then(response => {
      settledOrder.push('start')
      return response
    })
    await entered
    const removing = desktop.request(`workspaces/${slow.id}`, { method: 'DELETE' }).then(response => {
      settledOrder.push('remove')
      return response
    })
    try {
      // Another project starts and changes while this one's start is held in the driver.
      expect((await start('Elsewhere', other.id)).status).toBe(201)
      expect((await desktop.request(`workspaces/${other.id}`, { method: 'PATCH', body: { name: 'Renamed' } })).status).toBe(200)
      expect(settledOrder).toEqual([])
    } finally {
      release()
    }
    expect((await creating).status).toBe(201)
    await removing
    expect(settledOrder).toEqual(['start', 'remove'])
  })

  it('does not block policy reductions behind a project edit waiting for a slow driver start', async () => {
    const root = await directory()
    const path = join(root, 'project')
    await mkdir(path)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(done => {
      enter = done
    })
    const held = new Promise<void>(done => {
      release = done
    })
    const plugin: HarnessPlugin = {
      ...primaryPlugin,
      activate(ctx) {
        ctx.registerHarness({
          id: 'primary-test',
          name: 'Primary only',
          version: '1',
          create(options) {
            const bridge = createRuntime(options)
            const create = bridge.createTask.bind(bridge)
            bridge.createTask = async input => {
              enter()
              await held
              return create(input)
            }
            return bridge
          },
        })
      },
    }
    const t = await fixture({ plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const project = ((await (await desktop.addFolders({ paths: [path] })).json()) as { workspace: WorkspaceInfo }).workspace
    const creating = desktop.confirmed('tasks', {
      method: 'POST',
      body: {
        prompt: 'Slow',
        requestId: randomUUID(),
        harnessId: 'primary-test',
        workspaceId: project.id,
        mode: 'chat',
      },
    })
    await entered
    const removing = desktop.request(`workspaces/${project.id}`, { method: 'DELETE' })
    await new Promise(done => setTimeout(done, 50))
    let reduced = false
    const lowering = desktop
      .request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: ['127.0.0.1:11434'] } } })
      .then(response => {
        reduced = true
        return response
      })
    try {
      await vi.waitFor(() => expect(reduced).toBe(true), { timeout: 1000 })
      expect((await lowering).status).toBe(200)
    } finally {
      release()
      await creating
      await removing
    }
  })
})
