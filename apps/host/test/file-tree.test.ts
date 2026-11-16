import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  isFileDirectoryListing,
  isFileMetadata,
  type Device,
  type FileDirectoryListing,
  type FileMetadata,
  type WorkspaceInfo,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { HarnessPlugin } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { buildFilesHelper } from '../scripts/build-files.ts'
import { createFileRoutes } from '../src/files/index.ts'
import { FileDirectoryReader, validDirectory } from '../src/files/directory.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const clean of cleanups.splice(0).reverse()) await clean()
})
beforeAll(async () => {
  await buildFilesHelper()
}, 130000)
async function temporary() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'latch-tree-')))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe.skipIf(process.platform !== 'darwin')('authorized lazy directory listing', () => {
  it('uses only the selected harness roots for listing, search, resolution and handles', async () => {
    const plugin: HarnessPlugin = {
      id: 'primary-fixture',
      name: 'primary',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerHarness({ id: 'primary-fixture', name: 'primary', version: '1', create: options => createRuntime(options) })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    cleanups.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' }),
      root = await temporary(),
      first = join(root, 'first'),
      second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    await writeFile(join(first, 'first.txt'), 'first')
    await writeFile(join(second, 'second.txt'), 'second')
    const project = ((await (await owner.addFolders({ paths: [first, second] })).json()) as { workspace: WorkspaceInfo }).workspace
    const base = `workspaces/${project.id}/files`
    expect((await owner.json<FileDirectoryListing>(`${base}/list?harnessId=primary-fixture`)).roots.map(root => root.id)).toEqual([
      'default',
    ])
    expect((await owner.request(`${base}/list?harnessId=primary-fixture&rootId=${project.folders![1]!.id}`)).status).toBe(403)
    expect(await owner.json(`${base}/search`, { body: { harnessId: 'primary-fixture', q: '' } })).toMatchObject({
      files: [{ path: 'first.txt', root: 'default' }],
    })
    const resolved = await owner.json<{ files: Array<{ status: string }> }>(`${base}/resolve`, {
      body: { harnessId: 'primary-fixture', paths: [join(second, 'second.txt')] },
    })
    expect(resolved.files[0]!.status).toBe('outside')
  })

  it('lists exactly one level, keeps directories first, and hides generated entries until requested', async () => {
    const host = await startTestHost()
    cleanups.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' })
    await Promise.all(['child', 'dist', '.hidden'].map(name => mkdir(join(host.workspaceRoot, name))))
    await writeFile(join(host.workspaceRoot, 'z.txt'), 'z')
    await writeFile(join(host.workspaceRoot, 'child', 'deep.txt'), 'deep')
    await symlink('child', join(host.workspaceRoot, 'link'))
    const task = await host.host.bridge.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
    const route = `tasks/${task.sessionId}/files/list`
    const roots = await owner.json<FileDirectoryListing>(route)
    expect(isFileDirectoryListing(roots)).toBe(true)
    expect(roots).toMatchObject({
      context: { kind: 'session', sessionId: task.sessionId },
      roots: [{ id: 'default' }],
      entries: [],
      truncated: false,
    })
    expect(JSON.stringify(roots)).not.toContain(host.workspaceRoot)
    const listed = await owner.json<FileDirectoryListing>(`${route}?rootId=default`)
    expect(listed.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['child', 'directory'],
      ['link', 'symlink'],
      ['z.txt', 'file'],
    ])
    expect(listed.entries.find(entry => entry.name === 'z.txt')).toMatchObject({ size: 1 })
    expect(Number.isSafeInteger(listed.entries[0]!.mtime)).toBe(true)
    expect((await owner.json<FileDirectoryListing>(`${route}?rootId=default&dir=child`)).entries.map(entry => entry.name)).toEqual([
      'deep.txt',
    ])
    expect((await owner.json<FileDirectoryListing>(`${route}?rootId=default&showHidden=true`)).entries.map(entry => entry.name)).toContain(
      'dist',
    )
    expect((await owner.request(`${route}?rootId=default&dir=link`)).status).toBe(403)
    for (const suffix of [
      'dir=../outside&rootId=default',
      'rootId=default&dir=/absolute',
      'rootId=missing',
      'dir=child',
      'rootId=default&dir=child&dir=child',
      'rootId=default&showHidden=1',
    ])
      expect((await owner.request(`${route}?${suffix}`)).status).toBeGreaterThanOrEqual(400)
    const work = await host.enroll({ listener: 'loopback-tcp', dataScope: 'work' })
    expect((await work.request(`${route}?rootId=default`)).status).toBe(403)
    expect((await work.request(`tasks/${task.sessionId}/files/search`, { body: { q: 'z' } })).status).toBe(403)
  })

  it('resolves new-project files without sessions, freezes harness roots, and invalidates old handles after a root reorder', async () => {
    const host = await startTestHost()
    cleanups.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' }),
      root = await temporary()
    const first = join(root, 'first'),
      second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    await writeFile(join(first, 'report.txt'), 'first')
    await writeFile(join(second, 'report.txt'), 'second')
    const project = ((await (await owner.addFolders({ paths: [first, second] })).json()) as { workspace: WorkspaceInfo }).workspace
    const base = `workspaces/${project.id}/files`
    const roots = await owner.json<FileDirectoryListing>(`${base}/list?harnessId=standard`)
    expect(roots.context).toEqual({ kind: 'workspace', workspaceId: project.id, harnessId: 'standard' })
    expect(roots.roots.map(root => root.id)).toEqual(project.folders!.map(root => root.id))
    const response = await owner.json<{ files: Array<{ status: string; file: FileMetadata }> }>(`${base}/resolve`, {
      body: { harnessId: 'standard', rootId: project.folders![1]!.id, paths: ['report.txt'] },
    })
    const file = response.files[0]!.file
    expect(isFileMetadata(file)).toBe(true)
    expect(await (await owner.request(`files/${file.handle}`)).text()).toBe('second')
    expect((await owner.request(`files/${file.handle}/meta`)).status).toBe(200)
    expect(
      (await owner.request(`files/${file.handle}/local`, { body: { workspaceId: project.id, harnessId: 'standard', action: 'reveal' } }))
        .status,
    ).toBe(200)
    expect((await owner.request(`files/${file.handle}/local`, { body: { sessionId: 'fake', action: 'reveal' } })).status).toBe(403)
    expect((await owner.request(`${base}/list`)).status).toBe(400)
    expect((await owner.request(`${base}/list?harnessId=unknown`)).status).toBe(409)
    const peer = await host.enroll({ listener: 'unix' })
    expect((await peer.request(`files/${file.handle}`)).status).toBe(403)
    expect((await owner.request(`devices/${owner.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    expect((await owner.request(`files/${file.handle}`)).status).toBe(403)
    expect((await owner.request(`files/${file.handle}/meta`)).status).toBe(403)
    expect((await owner.confirmed(`devices/${owner.id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    expect(
      (
        await owner.request(`workspaces/${project.id}`, {
          method: 'PATCH',
          body: { order: project.folders!.map(folder => folder.id).reverse() },
        })
      ).status,
    ).toBe(200)
    expect((await owner.request(`files/${file.handle}`)).status).toBe(409)
    expect((await owner.request(`files/${file.handle}/meta`)).status).toBe(409)
    expect(
      (await owner.request(`files/${file.handle}/local`, { body: { workspaceId: project.id, harnessId: 'standard', action: 'reveal' } }))
        .status,
    ).toBe(409)
    expect(await host.host.bridge.listTasks()).toHaveLength(0)
  })

  it('audits remote enumeration only with hashes and refuses a failed audit or lost permissions after the child returns', async () => {
    const directory = await temporary(),
      root = join(directory, 'work'),
      privatePath = join(root, 'private')
    await mkdir(root)
    await mkdir(privatePath)
    await writeFile(join(root, 'hello.txt'), 'hello')
    await writeFile(join(privatePath, 'key.txt'), 'private')
    let now = Date.now(),
      revision = 'one',
      revoked = false,
      failAudit = false,
      privateAccess = true,
      invalidatePrivate = false
    const audit = vi.fn(async () => {
      if (failAudit) throw new AppError(503, 'audit-failed', 'failed')
      return { seq: 1, hash: 'a'.repeat(64) }
    })
    const reader = await FileDirectoryReader.open()
    const device: Device = {
      id: 'dev_' + 'a'.repeat(22),
      name: 'test',
      listener: 'loopback-tcp',
      dataScope: 'all',
      scopes: ['view'],
      status: 'active',
      fingerprint: '',
      createdAt: '',
      lastSeenAt: '',
      credentialExpiresAt: '',
      pairedBy: { method: 'lpc' },
    }
    const routes = createFileRoutes({
      protectedPaths: [privatePath],
      home: directory,
      now: () => now,
      audit: { append: audit },
      limiter: { take: () => {} },
      directoryReader: reader,
      sessionRoots: async () => {
        if (invalidatePrivate) privateAccess = false
        return [{ id: 'root', path: root }]
      },
      sessionAccess: () => {
        if (!privateAccess) throw new AppError(403, 'agent-scope-required', 'private')
      },
      contextRevision: () => revision,
      recheck: () => {
        if (revoked) throw new AppError(403, 'device-revoked', 'revoked')
      },
      actorOf: () => ({ deviceId: device.id, listener: device.listener }),
    })
    const server = createServer((req, res) => {
      void routes
        .handle(req, res, { device, connection: { listener: device.listener } }, new URL(req.url!, 'http://test').pathname, req.method!)
        .catch((error: unknown) => {
          res.writeHead(error instanceof AppError ? error.status : 500)
          res.end(JSON.stringify({ error: error instanceof AppError ? error.code : 'failed' }))
        })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('address')
    const list = () => fetch(`http://127.0.0.1:${address.port}/link/api/tasks/task/files/list?rootId=root&showHidden=true`)
    const value = (await (await list()).json()) as FileDirectoryListing
    expect(value.entries.map(entry => entry.name)).toEqual(['hello.txt'])
    expect(audit).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(audit.mock.calls)).not.toContain('hello')
    expect(JSON.stringify(audit.mock.calls)).not.toContain(root)
    await list()
    expect(audit).toHaveBeenCalledTimes(1)
    now += 15 * 60 * 1000
    failAudit = true
    expect((await list()).status).toBe(503)
    failAudit = false
    const original = reader.list.bind(reader),
      entered = deferred(),
      release = deferred()
    vi.spyOn(reader, 'list').mockImplementationOnce(async input => {
      const result = await original(input)
      entered.resolve()
      await release.promise
      return result
    })
    const pending = list()
    await entered.promise
    revoked = true
    release.resolve()
    expect((await pending).status).toBe(403)
    revoked = false
    const entered2 = deferred(),
      release2 = deferred()
    vi.spyOn(reader, 'list').mockImplementationOnce(async input => {
      const result = await original(input)
      entered2.resolve()
      await release2.promise
      return result
    })
    const changed = list()
    await entered2.promise
    revision = 'two'
    release2.resolve()
    expect((await changed).status).toBe(409)

    const held = deferred()
    let running = 0
    vi.spyOn(reader, 'list').mockImplementation(async input => {
      const result = await original(input)
      running++
      await held.promise
      return result
    })
    const auditCount = audit.mock.calls.length
    const first = list(),
      second = list()
    await vi.waitFor(() => expect(running).toBe(2))
    expect((await list()).status).toBe(429)
    held.resolve()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(audit).toHaveBeenCalledTimes(auditCount + 1)

    const waiting = deferred(),
      cancelled = deferred(),
      abort = new AbortController()
    vi.spyOn(reader, 'list').mockImplementationOnce(async input => {
      waiting.resolve()
      await new Promise<void>(done => input.signal.addEventListener('abort', () => done(), { once: true }))
      cancelled.resolve()
      throw new AppError(408, 'file-list-cancelled', 'cancelled')
    })
    const disconnected = fetch(`http://127.0.0.1:${address.port}/link/api/tasks/task/files/list?rootId=root`, {
      signal: abort.signal,
    }).catch(() => undefined)
    await waiting.promise
    abort.abort()
    await disconnected
    await cancelled.promise
    vi.spyOn(reader, 'list').mockImplementation(original)
    expect((await list()).status).toBe(200)
    invalidatePrivate = true
    const hidden = await list()
    expect(hidden.status).toBe(403)
    expect(await hidden.text()).not.toContain('hello.txt')
  })

  it('never retargets a workspace handle when its root directory is replaced at the same path', async () => {
    const host = await startTestHost()
    cleanups.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' }),
      directory = await temporary(),
      root = join(directory, 'project')
    await mkdir(root)
    await writeFile(join(root, 'file.txt'), 'original')
    const project = ((await (await owner.addFolders({ paths: [root] })).json()) as { workspace: WorkspaceInfo }).workspace
    const { files } = await owner.json<{ files: Array<{ file: FileMetadata }> }>(`workspaces/${project.id}/files/resolve`, {
      body: { harnessId: 'standard', paths: ['file.txt'] },
    })
    await rename(root, join(directory, 'old'))
    await mkdir(root)
    await writeFile(join(root, 'file.txt'), 'replacement')
    expect((await owner.request(`files/${files[0]!.file.handle}`)).status).toBe(409)
  })
})

describe('directory protocol boundaries', () => {
  it.skipIf(process.platform !== 'darwin')(
    'bounds active children without a queue and returns cancelled slots only after actual close',
    async () => {
      const root = await temporary(),
        binary = join(root, 'slow-reader')
      await writeFile(binary, '#!/bin/sh\nexec /bin/sleep 20\n', { mode: 0o700 })
      const reader = await FileDirectoryReader.open(binary)
      const controllers = Array.from({ length: 5 }, () => new AbortController())
      const launch = (index: number, deviceId: string) =>
        reader.list({ deviceId, root, dir: '', protectedPaths: [], showHidden: false, check: () => {}, signal: controllers[index]!.signal })
      const first = launch(0, 'one'),
        second = launch(1, 'one')
      // Attach rejection handlers before cancellation; a failed request must still await its real child.
      const firstResult = first.catch((error: unknown) => error),
        secondResult = second.catch((error: unknown) => error)
      await expect(launch(2, 'one')).rejects.toMatchObject({ code: 'file-list-busy' })
      const third = launch(2, 'two').catch((error: unknown) => error),
        fourth = launch(3, 'two').catch((error: unknown) => error)
      await expect(launch(4, 'three')).rejects.toMatchObject({ code: 'file-list-busy' })
      controllers[0]!.abort()
      expect(await firstResult).toMatchObject({ code: 'file-list-cancelled' })
      const replacement = launch(4, 'three').catch((error: unknown) => error)
      for (const controller of controllers) controller.abort()
      for (const result of await Promise.all([secondResult, third, fourth, replacement]))
        expect(result).toMatchObject({ code: 'file-list-cancelled' })
      expect(
        await reader
          .list({ deviceId: 'empty', root, dir: '', protectedPaths: [], showHidden: false, check: () => {}, signal: AbortSignal.abort() })
          .catch((error: unknown) => error),
      ).toMatchObject({ code: 'file-list-cancelled' })
    },
  )
  it('validates bounded finite responses and rejects path traversal', async () => {
    for (const value of ['../x', '/x', 'a//b', 'a/./b', 'a\\b', 'a\u0000b']) expect(validDirectory(value)).toBe(false)
    expect(validDirectory('')).toBe(true)
    expect(validDirectory('src/components')).toBe(true)
    expect(
      isFileDirectoryListing({
        context: { kind: 'workspace', workspaceId: 'p', harnessId: 'standard' },
        roots: [{ id: 'root', name: 'project' }],
        rootId: 'root',
        dir: '',
        entries: [{ name: 'src', kind: 'directory', size: 0, mtime: 1 }],
        truncated: false,
      }),
    ).toBe(true)
    expect(
      isFileDirectoryListing({
        context: { kind: 'session', sessionId: 'task' },
        roots: [],
        entries: [{ name: '../bad', kind: 'file', size: 1, mtime: 1 }],
        truncated: false,
      }),
    ).toBe(false)
    const unavailable = await FileDirectoryReader.open('/no/latch/files-helper')
    await expect(
      unavailable.list({
        deviceId: 'test',
        root: '/',
        dir: '',
        protectedPaths: [],
        showHidden: false,
        check: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'file-list-unavailable' })
  })
})
