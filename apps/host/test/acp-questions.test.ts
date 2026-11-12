import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const roots: string[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const SLOW = { timeout: 15_000 }

/** A Host with the fake ACP agent, a phone that may run, and a session asked `prompt`. */
async function asked(prompt: string, dirs?: { dataDir: string; workspaceRoot: string }) {
  const host = await startTestHost(dirs ?? {})
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const phone = await host.enroll({ scopes: ['view', 'run'] })
  expect(
    (
      await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
    ).status,
  ).toBe(201)
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { prompt, requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
  return { host, owner, phone, sessionId, detail }
}

const reply = async (detail: () => Promise<TaskDetail>) => {
  await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')
  return (await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
}

test('puts an ACP elicitation to the person on a question card, and answers the agent in ACP form', async () => {
  const { phone, sessionId, detail } = await asked('elicit')
  await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
  const current = await detail()
  const question = current.questions![0]!
  expect(question).toMatchObject({
    prompt: 'How should I approach this?',
    questions: [
      { id: 'q0', label: 'Strategy', options: [{ label: 'careful' }, { label: 'fast' }] },
      { id: 'q1', label: 'Run the tests?', options: [{ label: '是' }, { label: '否' }] },
      { id: 'q2', label: 'Anything else?', options: [] },
    ],
  })
  // Its row is the question's, so every client shows it as one; the session waits for the person.
  expect(current.messages.find(message => message.id === `tool:${question.toolCallId}`)).toMatchObject({
    toolName: 'ask_user',
    state: 'running',
  })
  expect(current.summary.status).toBe('waiting-approval')
  const answer = {
    requestId: randomUUID(),
    answers: [
      { questionId: 'q0', optionIds: ['o1'] },
      { questionId: 'q1', optionIds: ['o0'] },
      { questionId: 'q2', optionIds: [], other: 'keep it small' },
    ],
  }
  expect(await phone.json(`tasks/${sessionId}/questions/${question.id}/answer`, { method: 'POST', body: answer })).toMatchObject({
    answered: true,
    requestId: answer.requestId,
  })
  expect(await reply(detail)).toBe(
    `elicit=${JSON.stringify({ action: 'accept', content: { strategy: 'fast', tests: true, note: 'keep it small' } })}`,
  )
  const row = (await detail()).messages.find(message => message.id === `tool:${question.toolCallId}`)!
  expect(row.state).toBe('completed')
  expect(JSON.parse(row.tool!.output!)).toMatchObject({ kind: 'latch.question-result', requestId: answer.requestId })
  // The same answer again is the same receipt, never a second one.
  expect(await phone.json(`tasks/${sessionId}/questions/${question.id}/answer`, { method: 'POST', body: answer })).toMatchObject({
    answered: true,
  })
})

test('answers a Cursor question from a harness that is not Cursor, by its option IDs', async () => {
  const { phone, sessionId, detail } = await asked('cursor-ask')
  await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
  const question = (await detail()).questions![0]!
  expect(question).toMatchObject({
    prompt: 'Which one?',
    questions: [{ label: 'Pick a colour', options: [{ label: 'Red' }, { label: 'Blue' }] }],
  })
  await phone.json(`tasks/${sessionId}/questions/${question.id}/answer`, {
    method: 'POST',
    body: { requestId: randomUUID(), answers: [{ questionId: 'q0', optionIds: ['o1'] }] },
  })
  expect(await reply(detail)).toBe(`ask=answered ${JSON.stringify([{ questionId: 'q1', selectedOptionIds: ['b'] }])}`)
})

test('withdraws a question when the turn is stopped, and refuses URL mode with the method named', async () => {
  const { owner, sessionId, detail } = await asked('elicit')
  await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
  await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('cancelled')
  expect((await detail()).questions ?? []).toEqual([])

  const url = await asked('elicit url')
  expect(await reply(url.detail)).toBe('elicit=error -32602')
  const note = (await url.detail()).messages.find(message => message.role === 'system')?.text ?? ''
  expect(note).toContain('elicitation/create')
  expect(note).toContain('Latch 还不能显示')
  // The link a URL-mode request carries never enters the session.
  expect(JSON.stringify(await url.detail())).not.toContain('example.invalid')

  // Longer than a card holds: refused at once and said so, never a silent cancel that looks like the person's.
  const long = await asked('elicit long')
  expect(await reply(long.detail)).toBe('elicit=error -32602')
  expect((await long.detail()).messages.some(message => message.role === 'system' && message.text.includes('elicitation/create'))).toBe(
    true,
  )
})

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'latch-acp-questions-'))
  roots.push(root)
  return { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
}

test('gives a question its own row beside the call it names, which a stop still reads as running and unknown', async () => {
  const where = await dirs()
  const first = await asked('ask-on long', where)
  await expect.poll(async () => (await first.detail()).questions?.length, SLOW).toBe(1)
  const before = await first.detail()
  const question = before.questions![0]!
  // The agent's call ID is 256 characters; the question's own row and record are not.
  expect(question.toolCallId.length).toBeLessThanOrEqual(256)
  expect(question.toolCallId).toMatch(/:ask-/u)
  const command = before.messages.find(message => message.role === 'tool' && message.toolName !== 'ask_user')!
  expect(command).toMatchObject({ state: 'running', tool: { kind: 'execute' } })
  await first.host.close()
  hosts.splice(hosts.indexOf(first.host), 1)
  // The Host starts again on the same record, and the call that was running reads as interrupted with its result unknown.
  const second = await startTestHost(where)
  hosts.push(second)
  const after = await second.host.bridge.detail(first.sessionId)
  expect(after.messages.find(message => message.id === command.id)).toMatchObject({ state: 'failed', interrupted: true })
  expect(after.messages.find(message => message.id === command.id)?.tool?.output).toContain('TOOL_OUTCOME_UNKNOWN')
  // The question the stop cut off keeps that record; nobody answered it.
  expect(after.messages.find(message => message.id === `tool:${question.toolCallId}`)).toMatchObject({
    toolName: 'ask_user',
    interrupted: true,
  })
})

test('answers two questions that name the same call, each on its own', async () => {
  const { phone, sessionId, detail } = await asked('ask-twice')
  const answer = async (optionId: string) => {
    await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
    const question = (await detail()).questions![0]!
    await phone.json(`tasks/${sessionId}/questions/${question.id}/answer`, {
      method: 'POST',
      body: { requestId: randomUUID(), answers: [{ questionId: 'q0', optionIds: [optionId] }] },
    })
    return question.id
  }
  const first = await answer('o0')
  await expect.poll(async () => (await detail()).questions?.[0]?.id ?? first, SLOW).not.toBe(first)
  await answer('o1')
  expect(await reply(detail)).toBe(
    `twice=${JSON.stringify([
      { action: 'accept', content: { pick: 'a' } },
      { action: 'accept', content: { pick: 'b' } },
    ])}`,
  )
  expect((await detail()).messages.filter(message => message.toolName === 'ask_user')).toHaveLength(2)
})
