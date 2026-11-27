import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { checkedFileMentions, searchProjectFiles } from '../src/file-mentions.ts'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
describe('explicit file choices', () => {
  it('searches real project roots and validates new task references, preserving raw text and fixed roots', async () => {
    const seen: ModelMessage[][] = []
    const plugin: HarnessPlugin = {
      id: 'mention-test',
      name: 'test',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'mention-model',
          name: 'model',
          model: 'fixture',
          async *stream({ messages }) {
            seen.push(structuredClone(messages))
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host: TestHost = await startTestHost({ plugins: [plugin] })
    cleanups.push(() => host.close())
    const root = await mkdtemp(join(tmpdir(), 'latch-mentions-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const paths = ['api', 'web'].map(name => join(root, name))
    await Promise.all(paths.map(path => mkdir(path)))
    await writeFile(join(paths[1]!, 'report.txt'), 'content')
    await writeFile(join(paths[1]!, '.env'), 'MODEL_API_KEY=fixture')
    const owner = await host.enroll({ listener: 'unix' }),
      limited = await host.enroll({ listener: 'unix' })
    expect((await owner.request(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    const project = ((await (await owner.addFolders({ paths })).json()) as { workspace: WorkspaceInfo }).workspace
    const body = { q: 'rpt', harnessId: 'standard' }
    const result = await owner.json<{ files: Array<{ root: string; path: string }> }>(`workspaces/${project.id}/files/search`, { body })
    expect(result.files).toEqual([{ name: 'report.txt', path: 'report.txt', root: project.folders![1]!.id }])
    expect(await owner.json(`workspaces/${project.id}/files/search`, { body: { ...body, page: true, limit: 12 } })).toEqual(result)
    expect((await limited.request(`workspaces/${project.id}/files/search`, { body })).status).toBe(403)
    const fileRefs = [{ root: project.folders![1]!.id, path: 'report.txt' }],
      requestId = randomUUID()
    const input = {
      prompt: 'contact user@example.com and @web:report.txt',
      requestId,
      workspaceId: project.id,
      harnessId: 'standard',
      mode: 'agent',
      model: { providerId: 'mention-model', model: 'fixture' },
      fileRefs,
    }
    const created = await owner.json<{ sessionId: string }>('tasks', { body: input })
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle'))
    const detail = await owner.json<TaskDetail>(`tasks/${created.sessionId}`)
    expect(detail.messages[0]).toMatchObject({ text: input.prompt, fileRefs })
    const limitedPreview = await limited.json<{ files: Array<{ status: string }> }>(`tasks/${created.sessionId}/files/resolve`, {
      body: { paths: ['report.txt'], rootId: fileRefs[0]!.root },
    })
    expect(limitedPreview.files[0]!.status).toBe('ok')

    expect(seen[0]![1]!.content).toContain(join(paths[1]!, 'report.txt'))
    expect(await owner.json('tasks', { body: input })).toEqual(created)
    expect(
      (await owner.request('tasks', { body: { ...input, fileRefs: [{ root: fileRefs[0]!.root, path: '.env' }], requestId: randomUUID() } }))
        .status,
    ).toBe(403)
    expect(
      (await owner.request('tasks', { body: { ...input, fileRefs: [{ root: 'default', path: '../outside' }], requestId: randomUUID() } }))
        .status,
    ).toBe(400)
    expect(
      JSON.parse(await readFile(join(host.dataDir, 'sessions', 'runtime.json'), 'utf8')).tasks[created.sessionId].messages[0].fileRefs,
    ).toEqual(fileRefs)
    // A turn that names the file, taken before the file went away.
    const turn = { prompt: 'again', requestId: randomUUID(), fileRefs }
    expect((await owner.request(`tasks/${created.sessionId}/prompt`, { body: turn })).status).toBe(200)
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle'))
    await rm(join(paths[1]!, 'report.txt'))
    expect(
      (await owner.request(`tasks/${created.sessionId}/prompt`, { body: { prompt: 'again', requestId: randomUUID(), fileRefs } })).status,
    ).toBe(403)
    // Its retry is answered as taken, not refused by the check that now fails: the client would send it twice.
    const retried = await owner.request(`tasks/${created.sessionId}/prompt`, { body: turn })
    expect(retried.status).toBe(200)
    expect(
      (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).messages.filter(message => message.requestId === turn.requestId),
    ).toHaveLength(1)
    // Another body under the same ID is still a conflict.
    const changed = await owner.request(`tasks/${created.sessionId}/prompt`, { body: { ...turn, prompt: 'something else' } })
    expect(changed.status).toBe(409)
    expect(((await changed.json()) as { error: string }).error).toBe('request-conflict')
    // Another device that saw the ID in the session gets no shortcut: the ordinary checks answer it.
    const other = await host.enroll({ listener: 'unix' })
    expect((await other.request(`tasks/${created.sessionId}/prompt`, { body: turn })).status).toBe(403)
  })
  it('does not traverse symlinks or private directories and refuses forged roots and duplicate choices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mentions-bounds-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const workspace = join(root, 'work'),
      secret = join(root, 'private')
    await mkdir(workspace)
    await mkdir(secret)
    await writeFile(join(secret, 'data.txt'), 'private')
    await symlink(secret, join(workspace, 'escape'))
    await writeFile(join(workspace, 'ok.txt'), 'ok')
    const roots = [{ id: 'root', path: workspace }]
    expect((await searchProjectFiles(roots, [secret], '', 30, () => false)).files.map(file => file.path)).toEqual(['ok.txt'])
    await expect(checkedFileMentions([{ root: 'root', path: 'escape/data.txt' }], roots, [secret], '')).rejects.toMatchObject({
      code: 'file-reference-refused',
    })
    await expect(checkedFileMentions([{ root: 'forged', path: 'ok.txt' }], roots, [], '')).rejects.toMatchObject({
      code: 'file-reference-refused',
    })
    await expect(
      checkedFileMentions(
        [
          { root: 'root', path: 'ok.txt' },
          { root: 'root', path: 'ok.txt' },
        ],
        roots,
        [],
        '',
      ),
    ).rejects.toMatchObject({ code: 'file-reference-invalid' })
  })
})
