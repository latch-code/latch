import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { iosLiveMetrics, seedIosStream } from './helpers/iosLiveMetrics.ts'

it('reads native acceptance counters without adding detail requests or exposing fixture message contents', async () => {
  const host = await startTestHost()
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const response = await owner.confirmedJson<{ agent: { id: string } }>('agents', {
      method: 'POST',
      body: { name: 'Live metrics fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    const id = await seedIosStream(host, owner, response.agent.id, 2, 2048)
    const before = await iosLiveMetrics(host, owner)
    const after = await iosLiveMetrics(host, owner)
    expect(after.kinds.detail).toEqual(before.kinds.detail)
    const task = after.tasks.find(task => task.id === id)!
    expect(task.users).toBe(2)
    expect(task.lastAssistant?.bytes).toBe(2048)
    expect(task.lastAssistant?.id).toBeTruthy()
    expect(JSON.stringify(after)).not.toContain('x'.repeat(100))
    expect(JSON.stringify(after)).not.toContain(owner.credential)
    await owner.json(`tasks/${id}`)
    const read = await iosLiveMetrics(host, owner)
    expect(read.kinds.detail!.count).toBe(after.kinds.detail!.count + 1)
    expect(read.kinds.detail!.bytes).toBeGreaterThan(after.kinds.detail!.bytes)
    expect(read.tasks.find(task => task.id === id)?.lastAssistant).toEqual(task.lastAssistant)
    await owner.json(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'count 100', requestId: randomUUID() } })
    let liveId: string | undefined
    await expect
      .poll(async () => {
        const live = (await iosLiveMetrics(host, owner)).tasks.find(task => task.id === id)?.live
        liveId = live?.id
        return live?.bytes ?? 0
      })
      .toBeGreaterThan(0)
    await expect
      .poll(async () => (await iosLiveMetrics(host, owner)).tasks.find(task => task.id === id)?.status, { timeout: 10_000 })
      .toBe('idle')
    const settled = (await iosLiveMetrics(host, owner)).tasks.find(task => task.id === id)!
    expect(settled.lastAssistant?.id).toBe(liveId)
    expect(settled.lastAssistant?.bytes).toBeGreaterThan(0)
    expect(settled.live).toBeUndefined()
  } finally {
    await host.close()
  }
})
