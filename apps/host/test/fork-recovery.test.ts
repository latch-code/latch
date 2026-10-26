import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

let host: TestHost | undefined
afterEach(async () => {
  await host?.close()
  host = undefined
})

describe('forking after a frozen session folder disappears', () => {
  it('reads settled history and uses an explicit valid project without copying files or accepting an invalid target', async () => {
    host = await startTestHost({ sessionFolders: true })
    const owner = await host.enroll({ listener: 'unix' })
    const target = join(host.workspaceRoot, 'recovery-target')
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'Existing project file')
    const response = await owner.addFolders({ paths: [target] })
    expect(response.status).toBe(201)
    const { workspace } = (await response.json()) as { workspace: WorkspaceInfo }
    const original = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'History to retain', requestId: randomUUID() },
    })
    const read = () => owner.json<TaskDetail>(`tasks/${original.sessionId}`)
    await expect.poll(async () => (await read()).summary.status).toBe('idle')
    const detail = await read()
    expect(detail.summary.sessionFolder).toBe(true)
    expect(detail.summary.cwd).toBeTruthy()
    await writeFile(join(detail.summary.cwd!, 'old-only.txt'), 'This file will not be copied')
    await rm(detail.summary.cwd!, { recursive: true })
    const continuation = await owner.request(`tasks/${original.sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'Again', requestId: randomUUID() },
    })
    expect(continuation.status).toBe(409)
    expect(await continuation.json()).toMatchObject({ error: 'workspace-changed' })
    expect((await read()).messages).toEqual(detail.messages)
    const forkOf = { taskId: original.sessionId, upToMessageId: detail.messages.at(-1)!.id }
    const invalid = await owner.request('tasks', {
      method: 'POST',
      body: { forkOf, workspaceId: 'missing-project', requestId: randomUUID() },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'workspace-unavailable' })
    const requestId = randomUUID()
    const body = { forkOf, workspaceId: workspace.id, requestId, prompt: 'Retained draft' }
    const created = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body })
    const recovered = await owner.json<TaskDetail>(`tasks/${created.sessionId}`)
    expect(recovered.summary).toMatchObject({ cwd: workspace.path, workspaceId: workspace.id, forkOf })
    expect(recovered.summary).not.toHaveProperty('sessionFolder')
    const firstMessage = recovered.messages.find(message => message.role === 'user')!
    expect(firstMessage).toMatchObject({ requestId, forkContext: forkOf })
    expect(firstMessage.text).toContain('History to retain')
    expect(firstMessage.text.endsWith('Retained draft')).toBe(true)
    expect(await owner.json('tasks', { method: 'POST', body })).toEqual(created)
    const file = await owner.request(`tasks/${created.sessionId}/files/resolve`, {
      method: 'POST',
      body: { paths: ['old-only.txt'] },
    })
    expect(await file.json()).toMatchObject({ files: [{ status: 'missing' }] })
  })
})
