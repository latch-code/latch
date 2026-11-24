import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { expect } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { startTestHost } from './host.ts'

const first = '等下一轮的截图'
const caption = 'Check the screenshot before changing the layout.'

/** A real native device queues through its UI. Only the test provider holds the first turn and observes delivered images. */
export async function verifyIosQueuedScreenshots(output: string, address: string, pair: (owner: TestDevice) => Promise<void>) {
  let release!: () => void
  const running = new Promise<void>(done => {
    release = done
  })
  const turns: Array<{ text: string; images: string[] }> = []
  const provider: HarnessPlugin = {
    id: 'ios-queued-images',
    name: '截图验收',
    description: '',
    version: '1',
    activate(ctx) {
      ctx.registerProvider({
        id: 'ios-queued-images',
        name: '本地图片验收',
        model: 'fixture',
        modelCapabilities: { fixture: { vision: true } },
        async *stream({ messages, signal }) {
          const latest = messages.at(-1)!
          turns.push({
            text: latest.content,
            images: (latest.attachments ?? []).flatMap(item =>
              item.type === 'image' ? [createHash('sha256').update(Buffer.from(item.data, 'base64')).digest('hex')] : [],
            ),
          })
          if (latest.content === first) {
            const stop = () => release()
            signal.addEventListener('abort', stop, { once: true })
            try {
              await running
            } finally {
              signal.removeEventListener('abort', stop)
            }
          }
          yield { type: 'text', text: '已收到' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Choose an empty directory for this simulator UI run.')
  const deadline = Date.now() + 40 * 60_000
  async function wait(file: string) {
    const path = join(output, file)
    while (!existsSync(path) && Date.now() < deadline) await pause(350)
    if (!existsSync(path)) throw new Error('Timed out waiting for simulator UI: ' + file)
    await rm(path)
  }
  const host = await startTestHost({ demo: false, providerId: provider.id, plugins: [provider], native: { host: address, port: 0 } })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: first, mode: 'chat', model: { providerId: provider.id, model: 'fixture' }, requestId: randomUUID() },
    })
    const detail = () => owner.json<TaskDetail>('tasks/' + sessionId)
    await owner.json('tasks/' + sessionId, { method: 'PATCH', body: { title: '截图排队验收' } })
    await expect.poll(async () => (await detail()).summary.status).toBe('running')
    await writeFile(join(output, 'host-ready'), '截图排队验收\n')
    while (host.host.security.devices.nativeCandidates().length === 0) {
      await wait('pair')
      await pair(owner)
      const until = Math.min(deadline, Date.now() + 100_000)
      while (!host.host.security.devices.nativeCandidates().length && Date.now() < until && !existsSync(join(output, 'pair')))
        await pause(350)
    }
    await writeFile(join(output, 'paired'), 'paired via native entry\n')
    let last = ''
    while (!existsSync(join(output, 'drain')) && Date.now() < deadline) {
      const state = await detail()
      const rows = state.queue?.map(item => ({ text: item.text, attachments: item.attachmentCount ?? 0, state: item.state })) ?? []
      const snapshot = JSON.stringify({ status: state.summary.status, rows, providerTurns: turns.length }, null, 2)
      if (snapshot !== last) {
        await writeFile(join(output, 'queue-state.next'), snapshot)
        await rename(join(output, 'queue-state.next'), join(output, 'queue-state.json'))
        last = snapshot
      }
      await pause(400)
    }
    await wait('drain')
    const queue = (await detail()).queue ?? []
    expect(queue.map(item => item.attachmentCount)).toEqual([1, 1])
    expect(queue.map(item => item.text)).toEqual(['', caption])
    expect(turns).toHaveLength(1)
    release()
    await expect.poll(() => turns.length, { timeout: 20_000 }).toBe(3)
    await expect
      .poll(
        async () => {
          const state = await detail()
          return {
            status: state.summary.status,
            remaining: state.queue?.length ?? 0,
            delivered: state.messages.filter(message => message.queuedAt).length,
          }
        },
        { timeout: 20_000 },
      )
      .toEqual({ status: 'idle', remaining: 0, delivered: 2 })
    const final = await detail()
    expect(final.queue ?? []).toHaveLength(0)
    const delivered = final.messages.filter(message => message.role === 'user' && message.queuedAt)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]?.text).toBe(caption)
    expect(delivered.map(message => message.attachments?.length)).toEqual([1, 1])
    expect(turns.slice(1).map(turn => turn.images.length)).toEqual([1, 1])
    expect(turns[2]?.text).toBe(caption)
    const sent = delivered.map((message, index) => {
      const image = message.attachments?.[0]
      if (!image) throw new Error('Queued message lost its image')
      expect(image.kind).toBe('image')
      expect(image.width).toBeGreaterThan(400)
      expect(image.height).toBeGreaterThan(400)
      const providerImageHash = turns[index + 1]?.images[0]
      expect(providerImageHash).toBe(image.sha256)
      return {
        text: message.text,
        queuedAt: message.queuedAt,
        name: image.name,
        mime: image.mime,
        width: image.width,
        height: image.height,
        storedImageHash: image.sha256,
        providerImageHash,
      }
    })
    await writeFile(
      join(output, 'host-receipt.json'),
      JSON.stringify(
        {
          source: 'native device → Host queue → test vision provider',
          queue: queue.map(item => ({ text: item.text, count: item.attachmentCount })),
          sent,
          providerTurns: turns.length,
          remaining: final.queue?.length ?? 0,
        },
        null,
        2,
      ),
    )
  } finally {
    release()
    await host.close()
  }
}
