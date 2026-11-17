import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { NativeLinkInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
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
    kind: 'edge' as const,
    urls: ['https://latch-relay-ne.example.workers.dev/'],
    relayKey: 'b'.repeat(64),
    region: 'apac-ne',
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
    nodes: [{ relayId: node.relayId, region: 'apac-ne', status: 'connecting' }],
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
