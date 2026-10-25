import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import type { TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})
const questionFixtureInput = {
  prompt: '先确认方案',
  questions: [
    {
      id: 'language',
      label: '选择语言',
      multiple: false,
      options: [
        { id: 'ts', label: 'TypeScript' },
        { id: 'swift', label: 'Swift' },
      ],
    },
  ],
}
async function fixture() {
  const seen: string[] = []
  const provider: ModelProvider = {
    id: 'questions-fixture',
    name: 'Question fixture',
    model: 'fake',
    async *stream({ messages }) {
      if (messages.at(-1)?.role === 'tool') {
        seen.push(messages.at(-1)!.content)
        yield { type: 'text', text: '已按你的回答继续。' }
        yield { type: 'finish', reason: 'stop' }
      } else {
        yield { type: 'tool-call', call: { id: `question-call-${randomUUID()}`, name: 'ask_user', arguments: questionFixtureInput } }
        yield { type: 'finish', reason: 'tool-calls' }
      }
    },
  }
  const plugin: HarnessPlugin = {
    id: 'questions-provider',
    name: '',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider(provider)
    },
  }
  const host = await startTestHost({ plugins: [plugin], providerId: provider.id })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    phone = await host.enroll({ scopes: ['view', 'run'] }),
    viewer = await host.enroll({ scopes: ['view'] })
  const created = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: '开始提问', requestId: randomUUID() },
  })
  const path = `tasks/${created.sessionId}`
  const detail = () => owner.json<TaskDetail>(path)
  await expect.poll(async () => (await detail()).questions?.length).toBe(1)
  const question = (await detail()).questions![0]!
  expect(
    (await owner.json<{ tasks: Array<{ id: string; pendingQuestions?: number }> }>('snapshot')).tasks.find(
      task => task.id === created.sessionId,
    )?.pendingQuestions,
  ).toBe(1)
  const endpoint = `${path}/questions/${question.id}/answer`
  return { host, owner, phone, viewer, endpoint, detail, seen }
}
const input = () => ({ requestId: randomUUID(), answers: [{ questionId: 'language', optionIds: ['ts'] }] })

test('answers an R0 builtin question remotely, persists the result and resumes the model exactly once', async () => {
  const { owner, phone, viewer, endpoint, detail, seen } = await fixture()
  const body = input()
  expect((await viewer.request(endpoint, { method: 'POST', body })).status).toBe(403)
  expect(await phone.json(endpoint, { method: 'POST', body })).toMatchObject({ answered: true, requestId: body.requestId })
  expect(await phone.json(endpoint, { method: 'POST', body })).toMatchObject({ answered: true })
  await expect.poll(async () => (await detail()).summary.status).toBe('idle')
  expect(seen).toHaveLength(1)
  expect(JSON.parse(seen[0]!)).toMatchObject({ kind: 'latch.question-result', answers: [{ choices: ['TypeScript'] }] })
  expect((await detail()).questions).toEqual([])
  expect((await detail()).summary.pendingQuestions).toBe(0)
  expect((await owner.json<{ tasks: Array<Record<string, unknown>> }>('snapshot')).tasks.every(task => !('questions' in task))).toBe(true)
  expect((await owner.request(endpoint, { method: 'POST', body: input() })).status).toBe(409)
})

test('does not consume an answer when audit fails, and rejects a revoked run scope before execution', async () => {
  const { host, owner, phone, endpoint, detail, seen } = await fixture()
  const append = vi.spyOn(host.host.security.audit, 'append').mockRejectedValue(new Error('audit unavailable'))
  expect((await phone.request(endpoint, { method: 'POST', body: input() })).status).toBe(503)
  expect((await detail()).questions?.[0]?.state).toBe('pending')
  expect(seen).toEqual([])
  append.mockRestore()
  await owner.json(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
  expect((await phone.request(endpoint, { method: 'POST', body: input() })).status).toBe(403)
  await owner.json(endpoint, { method: 'POST', body: input() })
  await expect.poll(() => seen.length).toBe(1)
})

test('cancels a waiting question without model continuation and refuses a delayed answer', async () => {
  const { owner, endpoint, detail, seen } = await fixture()
  const path = endpoint.split('/questions/')[0]!
  await owner.json(`${path}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect.poll(async () => (await detail()).summary.status).toBe('cancelled')
  expect((await detail()).questions).toEqual([])
  expect((await owner.request(endpoint, { method: 'POST', body: input() })).status).toBe(409)
  expect(seen).toEqual([])
})
