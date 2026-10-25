import { afterEach, describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import type { ServerOptions } from '@latch/host'
type HarnessPlugin = NonNullable<ServerOptions['plugins']>[number]
import { startTestHost, type TestHost } from './helpers/host.ts'
const require = createRequire(import.meta.url)
const { createShellProxy } = require('../src/proxy.cjs') as {
  createShellProxy: (options: Record<string, unknown>) => { handle: (request: Request) => Promise<Response> }
}
const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})
describe('desktop attachment upload stream', () => {
  it('streams a body larger than the JSON limit over the verified socket and preserves the JSON limit on other routes', async () => {
    const plugin: HarnessPlugin = {
      id: 'upload-vision',
      name: 'fixture',
      version: '1',
      description: 'fixture',
      activate: ctx =>
        ctx.registerProvider({
          id: 'upload-model',
          name: 'fixture',
          model: 'visual',
          modelCapabilities: { visual: { vision: true } },
          async *stream() {
            yield { type: 'finish', reason: 'stop' }
          },
        }),
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const device = await host.enroll({ listener: 'unix' })
    let credential: string | undefined = device.credential
    const store = {
      current: () => (credential ? { deviceId: device.id, credential } : undefined),
      sign: (text: string) => device.key.sign(text),
      setCredential: async (value: string) => {
        credential = value
      },
      clear: async () => {
        credential = undefined
      },
    }
    const proxy = createShellProxy({ hostId: host.host.hostId, store, resolveSocket: async () => host.host.socketPath, log: () => {} })
    const png = Buffer.concat([
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      Buffer.alloc(2 * 1024 * 1024),
    ])
    const metadata = {
      requestId: randomUUID(),
      name: 'image.png',
      size: png.length,
      selection: { harnessId: 'standard', model: { providerId: 'upload-model', model: 'visual' } },
    }
    const response = await proxy.handle(
      new Request('latch://app/link/api/attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(JSON.stringify(metadata)).toString('base64url'),
        },
        body: new Uint8Array(png),
      }),
    )
    expect(response.status).toBe(201)
    expect((await response.json()) as unknown).toMatchObject({
      attachment: { size: png.length, sha256: createHash('sha256').update(png).digest('hex') },
    })
    const oversized = await proxy.handle(
      new Request('latch://app/link/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(2 * 1024 * 1024),
      }),
    )
    expect(oversized.status).toBe(413)
    const frame = await proxy.handle(
      new Request('latch://app/link/api/attachments', { method: 'POST', headers: { origin: 'null' }, body: 'no' }),
    )
    expect(frame.status).toBe(403)
  })
})
