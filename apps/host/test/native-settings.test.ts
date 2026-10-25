import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeLinkInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('confirms observers through OS presence, hides keys, reuses a committed request, and removes nodes despite audit failure', async () => {
  const host = await startTestHost({
    native: { host: '127.0.0.1', port: 0 },
    egressLookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
  })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' }),
    browser = await host.enroll({ listener: 'loopback-tcp' })
  const before = await desktop.json<NativeLinkInfo>('native/info')
  const registrationKey = `lrt1.${randomBytes(32).toString('base64url')}`
  const request = {
    requestId: randomUUID(),
    configHash: before.configHash,
    direct: before.direct,
    relays: [
      {
        relayId: randomBytes(16).toString('hex'),
        url: 'https://relay.example/',
        spkiHash: randomBytes(32).toString('hex'),
        registrationKey,
      },
    ],
  }
  expect((await browser.request('native/config', { method: 'PUT', body: request })).status).toBe(403)
  const added = await desktop.confirmed('native/config', { method: 'PUT', body: request })
  expect(added.status).toBe(200)
  const preview = host.presence.requests.at(-1)!.preview
  expect(preview.subject?.form).toBe('policy.native-link')
  expect(JSON.stringify(preview).includes(registrationKey)).toBe(false)
  const info = (await added.json()) as NativeLinkInfo
  expect(info.relays).toHaveLength(1)
  expect(info.relays[0]!.hasRegistrationKey).toBe(true)
  expect(JSON.stringify(info).includes(registrationKey)).toBe(false)
  const count = host.presence.requests.length
  expect((await desktop.request('native/config', { method: 'PUT', body: request })).status).toBe(200)
  expect(host.presence.requests.length).toBe(count)
  expect((await desktop.request('native/config', { method: 'PUT', body: { ...request, relays: [] } })).status).toBe(409)
  expect((await desktop.request('native/config', { method: 'PUT', body: { ...request, requestId: randomUUID() } })).status).toBe(409)
  const append = host.host.security.audit.append.bind(host.host.security.audit)
  vi.spyOn(host.host.security.audit, 'append').mockImplementation(event =>
    event.action === 'native.config.changed' ? Promise.reject(new Error('fixture audit unavailable')) : append(event),
  )
  const removed = await desktop.request('native/config', {
    method: 'PUT',
    body: { requestId: randomUUID(), configHash: info.configHash, direct: info.direct, relays: [] },
  })
  expect(removed.status).toBe(200)
  expect(removed.headers.get('x-latch-audit')).toBe('failed')
  expect(((await removed.json()) as NativeLinkInfo).relays).toHaveLength(0)
  expect(host.presence.requests.length).toBe(count)
})
