import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

describe('a new context from the prompt route', () => {
  it('passes it to a harness that takes it, never with a queued or added prompt, and only with run', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const viewer = await host.enroll({ scopes: ['view'] })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'First', requestId: randomUUID() },
    })
    const path = `tasks/${sessionId}`
    await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
    expect((await owner.json<TaskDetail>(path)).clearContext).toBe(true)
    const prompt = (body: Record<string, unknown>) =>
      owner.request(`${path}/prompt`, { method: 'POST', body: { prompt: 'Again', requestId: randomUUID(), freshContext: true, ...body } })
    expect((await prompt({ queue: true })).status).toBe(400)
    expect((await prompt({ steer: true })).status).toBe(400)
    expect((await prompt({ freshContext: false })).status).toBe(400)
    const asViewer = await viewer.request(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'Again', requestId: randomUUID(), freshContext: true },
    })
    expect(asViewer.status).toBe(403)
    expect((await prompt({})).status).toBe(200)
    await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
    const users = (await owner.json<TaskDetail>(path)).messages.filter(message => message.role === 'user')
    expect(users.map(message => [message.text, message.freshContext])).toEqual([
      ['First', undefined],
      ['Again', true],
    ])
  })
})
