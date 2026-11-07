import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { FAKE_PI_AGENT } from '@latch/testkit'
import type { HarnessInfo, TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).toReversed()) await host.close()
})

test("a fork of a pi session into pi forks pi's own record, and falls back to the text record where it cannot", async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const sessions = join(host.workspaceRoot, 'pi-sessions')
  await mkdir(sessions)
  const log = join(host.workspaceRoot, 'pi.log')
  // The fake pi under two definitions; no lookup of a program named pi is involved.
  for (const id of ['pi', 'pi-two'])
    await owner.json('agents', {
      method: 'POST',
      body: {
        id,
        name: id,
        presetId: 'pi',
        command: process.execPath,
        args: [FAKE_PI_AGENT],
        env: { FAKE_PI_SESSIONS: sessions, FAKE_PI_LOG: log },
      },
    })
  const harnesses = (await owner.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses
  expect(harnesses.find(item => item.id === 'pi')?.capabilities.fork).toBe('native')
  const builtin = harnesses.find(item => item.capabilities.models.owner === 'latch')
  expect(builtin).toBeDefined()
  expect(builtin?.capabilities.fork).toBeUndefined()

  const detail = (sessionId: string) => owner.json<TaskDetail>(`tasks/${sessionId}`)
  const settled = (sessionId: string) => expect.poll(async () => (await detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
  const start = async (body: Record<string, unknown>) => {
    const created = await owner.confirmed('tasks', { method: 'POST', body: { requestId: randomUUID(), ...body } })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await settled(sessionId)
    return sessionId
  }
  const send = async (sessionId: string, prompt: string) => {
    const sent = await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt } })
    expect(sent.status).toBe(200)
    await settled(sessionId)
  }
  const replies = async (sessionId: string) =>
    (await detail(sessionId)).messages.flatMap(item => (item.role === 'assistant' ? [item.text] : []))
  const notes = async (sessionId: string) => (await detail(sessionId)).messages.flatMap(item => (item.role === 'system' ? [item.text] : []))
  /** The reply that ends turn `turn` (from 1). */
  const turnEnd = async (sessionId: string, turn: number) => {
    const messages = (await detail(sessionId)).messages
    const starts = messages.flatMap((item, index) => (item.role === 'user' && !item.steered ? [index] : []))
    return messages[(starts[turn] ?? messages.length) - 1]!.id
  }
  const fork = (sessionId: string, upToMessageId: string, harnessId: string) =>
    start({ harnessId, prompt: 'recall', forkOf: { taskId: sessionId, upToMessageId } })

  const source = await start({ harnessId: 'pi', prompt: 'alpha' })
  await send(source, 'beta')
  await send(source, 'gamma')
  const before = await sessionFiles(sessions)
  expect(before.size).toBe(1)

  // From the first turn: pi forks before the second turn's message, and the fork remembers only what came before.
  const first = await fork(source, await turnEnd(source, 1), 'pi')
  expect((await detail(first)).messages.find(item => item.role === 'user')).toMatchObject({ nativeFork: true })
  expect(await replies(first)).toEqual(['remembers: alpha'])
  expect(await notes(first)).toEqual([])
  // From the latest turn: the whole of pi's record.
  const latest = await fork(source, await turnEnd(source, 3), 'pi')
  expect(await replies(latest)).toEqual(['remembers: alpha | beta | gamma'])
  // The source's own record is as it was, and it goes on where it left off.
  for (const [name, content] of before) expect(await readFile(join(sessions, name), 'utf8')).toBe(content)
  await send(source, 'recall')
  expect((await replies(source)).at(-1)).toBe('remembers: alpha | beta | gamma')
  // A fork of a fork is pi's too.
  await send(first, 'delta')
  const again = await fork(first, await turnEnd(first, 2), 'pi')
  expect(await replies(again)).toEqual(['remembers: alpha | recall | delta'])

  // Another Harness gets the text record: pi there starts its own session with it.
  const other = await fork(source, await turnEnd(source, 1), 'pi-two')
  expect((await detail(other)).messages.find(item => item.role === 'user')?.nativeFork).toBeUndefined()
  expect(await replies(other)).toEqual(['remembers: nothing'])

  // An extension that cancels forks, and a session file that is gone: the text record, and the session says why.
  const guarded = await start({ harnessId: 'pi', prompt: 'no-fork please' })
  const cancelled = await fork(guarded, await turnEnd(guarded, 1), 'pi')
  expect(await notes(cancelled)).toEqual(['pi 没有用它自己的记录分叉：它的扩展取消了分叉。这次以文字带上来源会话到这一轮为止的记录。'])
  expect(await replies(cancelled)).toEqual(['remembers: nothing'])
  const gone = await start({ harnessId: 'pi', prompt: 'short-lived' })
  for (const name of (await sessionFiles(sessions)).keys())
    if ((await readFile(join(sessions, name), 'utf8')).includes('short-lived')) await rm(join(sessions, name))
  const missing = await fork(gone, await turnEnd(gone, 1), 'pi')
  expect(await notes(missing)).toEqual([
    'pi 没有用它自己的记录分叉：找不到来源会话在这一轮之前的记录。这次以文字带上来源会话到这一轮为止的记录。',
  ])
  // Every process was the fake pi, started the way the wire starts pi.
  const started = (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; argv?: string[] })
    .filter(item => item.event === 'start')
  expect(started.length).toBeGreaterThan(1)
  expect(started.every(item => item.argv?.join(' ') === '--mode rpc')).toBe(true)
})

async function sessionFiles(directory: string): Promise<Map<string, string>> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort()
  return new Map(await Promise.all(names.map(async name => [name, await readFile(join(directory, name), 'utf8')] as const)))
}
