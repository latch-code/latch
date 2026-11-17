import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER, FAKE_PI_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const SLOW = { timeout: 15_000 }

/** A Host whose `codex` is the fake app server, with the Mac and a phone that may run, and a session asked `prompt`. */
async function codexAsked(prompt: string) {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-questions-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin'),
    command = join(bin, 'codex')
  await mkdir(bin)
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(command, 0o755)
  const host = await startTestHost({
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'default'),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const phone = await host.enroll({ scopes: ['view', 'run'] })
  const viewer = await host.enroll({ scopes: ['view'] })
  await owner.confirmedJson('agents', {
    body: {
      id: 'codex',
      presetId: 'codex',
      name: 'Codex',
      command: 'codex',
      args: [],
      env: { FAKE_CODEX_STATE: join(root, 'threads.json') },
    },
  })
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { prompt, requestId: randomUUID(), harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
  const reply = async () => {
    await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')
    return (await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
  }
  return { owner, phone, viewer, sessionId, detail, reply }
}

test("puts Codex's request_user_input on the question card, answered from a phone, the stale second answer refused", async () => {
  const { owner, phone, viewer, sessionId, detail, reply } = await codexAsked('ask-user')
  await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
  const question = (await detail()).questions![0]!
  expect(question.questions).toEqual([
    {
      id: 'q0',
      label: 'Colour：Which colour?',
      multiple: false,
      options: [
        { id: 'o0', label: 'Red', description: 'Warm' },
        { id: 'o1', label: 'Blue', description: 'Cool' },
      ],
    },
    { id: 'q1', label: 'Name：What is it called?', multiple: false, options: [] },
  ])
  // It waits on the person, on the board too, and it is still there when read again (a reload, another device).
  expect((await detail()).summary.board).toMatchObject({ group: 'attention', reason: 'question' })
  expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).questions?.[0]?.id).toBe(question.id)
  const path = `tasks/${sessionId}/questions/${question.id}/answer`
  const body = (requestId: string, name: string) => ({
    requestId,
    answers: [
      { questionId: 'q0', optionIds: ['o1'] },
      { questionId: 'q1', optionIds: [], other: name },
    ],
  })
  // A device that may only watch cannot answer.
  expect((await viewer.request(path, { method: 'POST', body: body(randomUUID(), 'Nope') })).status).toBe(403)
  const first = randomUUID()
  expect(await phone.json(path, { method: 'POST', body: body(first, 'Bob') })).toMatchObject({ answered: true, requestId: first })
  // The Mac still showed the card: its answer comes too late and is refused for certain, not taken as a second one.
  const late = await owner.request(path, { method: 'POST', body: body(randomUUID(), 'Alice') })
  expect(late.status).toBe(409)
  expect(['question-answered', 'question-closed', 'question-not-found']).toContain(((await late.json()) as { error: string }).error)
  // The phone's retry of its own answer gets its receipt again.
  expect(await phone.json(path, { method: 'POST', body: body(first, 'Bob') })).toMatchObject({ answered: true, requestId: first })
  expect(await reply()).toBe(`answers: ${JSON.stringify({ colour: { answers: ['Blue'] }, name: { answers: ['Bob'] } })}`)
})

test('never asks a Codex question marked secret through Latch: Codex gets no answers and the session says why', async () => {
  const { detail, reply } = await codexAsked('ask-user secret')
  expect(await reply()).toBe('answers: {}')
  expect((await detail()).questions ?? []).toEqual([])
  expect(JSON.stringify((await detail()).messages)).toContain('Latch 不代收这类回答')
})

test('never writes a secret question into the session, even in a request Latch cannot read', async () => {
  const { detail, reply } = await codexAsked('ask-user secret many')
  expect(await reply()).toBe('answers: {}')
  const written = JSON.stringify((await detail()).messages)
  expect(written).toContain('Latch 不代收这类回答')
  expect(written).not.toContain('SECRET-QUESTION-TEXT')
})

test("puts a pi extension's select and input on the question card, and pi gets the chosen option and the words back", async () => {
  const host = await startTestHost()
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const phone = await host.enroll({ scopes: ['view', 'run'] })
  const sessions = join(host.workspaceRoot, 'pi-sessions')
  await mkdir(sessions)
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: { id: 'pi', name: 'pi', presetId: 'pi', command: process.execPath, args: [FAKE_PI_AGENT], env: { FAKE_PI_SESSIONS: sessions } },
  })
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { prompt: 'dialog please', requestId: randomUUID(), harnessId: 'pi', mode: 'agent', workspaceId: 'default' },
  })
  const { sessionId } = (await created.json()) as { sessionId: string }
  const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
  const answer = async (answers: Array<{ questionId: string; optionIds: string[]; other?: string }>) => {
    await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
    const question = (await detail()).questions![0]!
    await phone.json(`tasks/${sessionId}/questions/${question.id}/answer`, { method: 'POST', body: { requestId: randomUUID(), answers } })
    return question
  }
  const select = await answer([{ questionId: 'q0', optionIds: ['o1'] }])
  expect(select.questions[0]).toMatchObject({ label: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] })
  await expect.poll(async () => (await detail()).questions?.[0]?.id ?? select.id, SLOW).not.toBe(select.id)
  const input = await answer([{ questionId: 'q0', optionIds: [], other: 'tidy-up' }])
  expect(input.questions[0]).toMatchObject({ label: 'Name the change', options: [] })
  await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')
  expect((await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe('dialog: dev / tidy-up')
})
