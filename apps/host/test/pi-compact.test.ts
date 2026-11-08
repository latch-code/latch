import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { FAKE_PI_AGENT } from '@latch/testkit'
import type { TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).toReversed()) await host.close()
})

test("pi's /compact runs between turns, and is refused queued or added to a running turn", async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const sessions = join(host.workspaceRoot, 'pi-sessions')
  await mkdir(sessions)
  await owner.json('agents', {
    method: 'POST',
    body: {
      id: 'pi',
      name: 'pi',
      presetId: 'pi',
      command: process.execPath,
      args: [FAKE_PI_AGENT],
      env: { FAKE_PI_SESSIONS: sessions },
    },
  })
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { harnessId: 'pi', prompt: 'say hello', requestId: randomUUID() },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  const path = `tasks/${sessionId}`
  const detail = () => owner.json<TaskDetail>(path)
  const prompt = (body: Record<string, unknown>) =>
    owner.request(`${path}/prompt`, { method: 'POST', body: { requestId: randomUUID(), ...body } })
  await expect.poll(async () => (await detail()).summary.status).toBe('idle')
  expect((await detail()).commands).toEqual([expect.objectContaining({ name: 'compact', idleOnly: true })])

  expect((await prompt({ prompt: 'build it slowly' })).status).toBe(200)
  await expect
    .poll(async () => (await detail()).messages.some(message => message.role === 'tool' && message.state === 'running'))
    .toBe(true)
  for (const body of [
    { prompt: '/compact', queue: true },
    { prompt: '/compact keep the plan', steer: true },
  ]) {
    const refused = await prompt(body)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'command-queued', message: '/compact 不能排队或追加，请等本轮结束后发送。' })
  }
  expect((await detail()).queue ?? []).toEqual([])
  // Nor does a queued message become one by an edit.
  expect((await prompt({ prompt: 'hello', queue: true })).status).toBe(202)
  const [queued] = (await detail()).queue ?? []
  const edited = await owner.request(`${path}/queue/${queued!.id}`, { method: 'PATCH', body: { text: '/compact' } })
  expect(edited.status).toBe(409)
  expect(await edited.json()).toEqual({ error: 'command-queued', message: '/compact 不能排队或追加，请等本轮结束后发送。' })
  expect((await detail()).queue?.map(item => item.text)).toEqual(['hello'])
  expect((await owner.request(`${path}/queue/${queued!.id}`, { method: 'DELETE' })).status).toBe(200)
  await expect.poll(async () => (await detail()).summary.status, { timeout: 10_000 }).toBe('idle')

  expect((await prompt({ prompt: '/compact keep the plan' })).status).toBe(200)
  await expect.poll(async () => (await detail()).summary.status).toBe('idle')
  expect((await detail()).messages.slice(-2).map(message => `${message.role}:${message.text}`)).toEqual([
    'user:/compact keep the plan',
    'system:pi 已压缩上下文\nSummary of the conversation so far, keeping: keep the plan.',
  ])
})
