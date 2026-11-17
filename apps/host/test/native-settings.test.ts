import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeLinkInfo } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { LookupFunction } from '../src/egress.ts'
import { startTestHost } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('audits a relay test before DNS or connection work, for the local device and anonymous CLI alike', async () => {
  const node = {
    relayId: 'a'.repeat(32),
    kind: 'self' as const,
    url: 'https://relay.example/',
    spkiHash: 'b'.repeat(64),
  }
  const lookup = vi.fn<LookupFunction>((_hostname, _options, callback) => callback(new Error('fixture refuses network'), []))
  const host = await startTestHost({ officialRelays: [node], egressLookup: lookup })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  const append = host.host.security.audit.append.bind(host.host.security.audit)
  const recorded: Parameters<typeof append>[0][] = []
  let fail = true
  vi.spyOn(host.host.security.audit, 'append').mockImplementation(async event => {
    if (event.action === 'native.relay.test') {
      recorded.push(event)
      if (fail) throw new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行')
    }
    return append(event)
  })
  const path = `native/relays/${node.relayId}/test`
  expect((await desktop.request(path, { method: 'POST', body: {} })).status).toBe(503)
  expect((await host.raw('unix', `api/${path}`, { method: 'POST' })).status).toBe(503)
  expect(recorded).toHaveLength(2)
  expect(recorded[0]!.actor).toMatchObject({ deviceId: desktop.id, listener: 'unix', via: 'http' })
  expect(recorded[1]!.actor).toEqual({ listener: 'unix', via: 'cli' })
  expect(lookup).not.toHaveBeenCalled()
  fail = false
  expect((await desktop.request(path, { method: 'POST', body: {} })).status).toBe(200)
  expect(lookup).toHaveBeenCalled()
  const entry = recorded.at(-1)!
  expect(entry).toMatchObject({
    action: 'native.relay.test',
    stepup: 'none',
    detail: { relayHash: expect.stringMatching(/^[a-f0-9]{64}$/u), profile: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  })
  expect(JSON.stringify(entry)).not.toContain(node.url)
  expect(JSON.stringify(entry)).not.toContain(node.spkiHash)
})

it('reports phone access and no settings form: the listener is the Host start option here, and config and pause are gone', async () => {
  const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  const info = await desktop.json<NativeLinkInfo>('native/info')
  expect(info).toEqual({
    version: 1,
    enabled: true,
    directManaged: true,
    listening: { host: '127.0.0.1', port: host.host.nativePort },
    directory: false,
    // The test Host runs from this checkout, where the relay setup commands exist.
    sourceCheckout: true,
    official: { deployed: false, enabled: true, ownFirst: false, nodes: [] },
    relays: [],
  })
  for (const [method, path] of [
    ['PUT', 'native/config'],
    ['POST', 'native/input/pause'],
    ['POST', 'native/input/resume'],
  ] as const)
    expect((await desktop.request(path, { method, body: {} })).status).toBe(404)
})

it('switches the official relay and the order on this Mac, audited, and reports both', async () => {
  const node = {
    relayId: 'a'.repeat(32),
    kind: 'self' as const,
    url: 'https://relay.example/',
    spkiHash: 'b'.repeat(64),
  }
  const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, officialRelays: [node] })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  const before = await desktop.json<NativeLinkInfo>('native/info')
  // Nothing is paired, so the built-in node is not even dialled.
  expect(before.official).toEqual({
    deployed: true,
    enabled: true,
    ownFirst: false,
    nodes: [{ relayId: node.relayId, region: '', status: 'connecting' }],
  })
  const off = await desktop.json<NativeLinkInfo>('native/official-relay', { method: 'PUT', body: { enabled: false } })
  expect(off.official).toMatchObject({ enabled: false, nodes: [{ status: 'off' }] })
  const order = await desktop.json<NativeLinkInfo>('native/official-relay', { method: 'PUT', body: { ownFirst: true } })
  expect(order.official).toMatchObject({ enabled: false, ownFirst: true })
  expect((await desktop.request('native/official-relay', { method: 'PUT', body: {} })).status).toBe(400)
  const records = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: { lowering?: boolean; direct?: boolean } })
    .filter(record => record.action === 'native.config.changed')
  expect(records.map(record => record.detail.lowering)).toEqual([true, false])
  const saved = JSON.parse(await readFile(join(host.dataDir, 'native', 'relays.json'), 'utf8')) as Record<string, unknown>
  expect(saved).toMatchObject({ officialOff: true, ownFirst: true })
})
