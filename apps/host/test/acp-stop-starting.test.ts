// A stop over the Host's route while an ACP session's next turn is still starting (its process loading the session).
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CancelReceipt, TaskDetail, TaskSummary } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it(
  'stops a resumed session’s turn while it starts, by the run ID the session shows, and records it as stopped',
  { timeout: 30_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-stop-starting-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    const env = { FAKE_ACP_CAPS: 'load', FAKE_ACP_SLOW_SETUP: '1500', FAKE_ACP_STATE: join(root, 'state.json') }
    let t: TestHost = await startTestHost({ dataDir, workspaceRoot })
    let owner = await t.enroll({ listener: 'unix' })
    cleanups.push(() => t.close())
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env },
        })
      ).status,
    ).toBe(201)
    const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'echo one', requestId: randomUUID(), harnessId: 'fake' },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 10_000 }).toBe('idle')
    const before = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.runId

    // A new Host: the next turn loads the session first, slowly.
    await t.close()
    t = await startTestHost({ dataDir, workspaceRoot })
    owner = await t.enroll({ listener: 'unix' })
    const promptRequestId = randomUUID()
    const prompted = owner.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'echo two', requestId: promptRequestId },
    })
    let starting: TaskSummary | undefined
    await expect
      .poll(
        async () => {
          starting = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary
          return starting.status
        },
        { timeout: 5_000, interval: 20 },
      )
      .toBe('running')
    expect(starting!.runId).toEqual(expect.any(String))
    expect(starting!.runId).not.toBe(before)
    expect(starting!.runOutcome).toBeUndefined()

    // What the page sends: the run it shows.
    const cancelRequestId = randomUUID()
    const stopped = await owner.json<{ accepted: boolean; receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: cancelRequestId, runId: starting!.runId },
    })
    expect(stopped.accepted).toBe(true)
    expect((await prompted).status).toBe(200)
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.summary).toMatchObject({ status: 'cancelled', runId: starting!.runId })
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['echo one', 'echo two'])
    expect(detail.messages.some(message => message.text === 'echo: echo two')).toBe(false)

    // A lost answer must remain the same stopped turn after a restart, without sending the prompt or stopping again.
    const headers = { authorization: `Latch-Device ${owner.credential}` }
    await t.close()
    t = await startTestHost({ dataDir, workspaceRoot })
    const retried = await t.raw('unix', `api/tasks/${sessionId}/cancel`, {
      method: 'POST',
      headers,
      body: { requestId: cancelRequestId, runId: starting!.runId },
    })
    expect(retried.status).toBe(200)
    const replay: { accepted: boolean; receipt: CancelReceipt } = await retried.json()
    expect(replay).toEqual({ accepted: true, receipt: { ...stopped.receipt, replay: true } })
    expect(
      (
        await t.raw('unix', `api/tasks/${sessionId}/prompt`, {
          method: 'POST',
          headers,
          body: { prompt: 'echo two', requestId: promptRequestId },
        })
      ).status,
    ).toBe(200)
    const read = await t.raw('unix', `api/tasks/${sessionId}`, { headers })
    expect(read.status).toBe(200)
    const recovered: TaskDetail = await read.json()
    expect(recovered.summary).toMatchObject({ status: 'cancelled', runId: starting!.runId })
    expect(recovered.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['echo one', 'echo two'])
    expect(recovered.messages.some(message => message.text === 'echo: echo two')).toBe(false)
  },
)
