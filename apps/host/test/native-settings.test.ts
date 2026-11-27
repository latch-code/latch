import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RELAY_FILE_BYTES, type NativeLinkInfo, type NativeRelayFile } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { LookupFunction } from '../src/egress.ts'
import { RelayProfiles } from '../src/relay/profiles.ts'
import { listRelayFiles, loadRelayFile } from '../src/relay/relay-files.ts'
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
    edgeRelayAvailable: true,
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

it('lists private relay files without their tokens and binds named imports to the selected node', async () => {
  const home = await mkdtemp(join(tmpdir(), 'latch-relay-files-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const relays = join(home, '.latch', 'relays')
  await mkdir(join(home, '.latch'), { mode: 0o700 })
  await mkdir(relays, { mode: 0o700 })
  const token = `lrt1.${'A'.repeat(43)}`
  const edge = {
    relayId: 'c'.repeat(32),
    url: 'https://latch-relay-home.example.workers.dev/',
    kind: 'edge',
    relayKey: 'd'.repeat(64),
    extraUrls: ['https://second.example/', 'https://third.example/'],
  }
  const legacy = { ...edge, relayId: 'e'.repeat(32), url: 'https://latch-relay-legacy.example.workers.dev/' }
  const standardFile = join(relays, 'home.json')
  const legacyFile = join(home, 'latch-relay-home.json')
  const edgeFile = (profile: typeof edge, registrationKey = token) =>
    JSON.stringify({ version: 2, profile: { ...profile, registrationKey } })
  await writeFile(standardFile, edgeFile(edge), { mode: 0o600 })
  await writeFile(legacyFile, edgeFile(legacy), { mode: 0o600 })
  await writeFile(join(home, 'latch-relay-copy.json'), edgeFile(edge), { mode: 0o600 })
  await writeFile(join(home, 'elsewhere.json'), edgeFile(legacy), { mode: 0o600 })
  const openRelay = { relayId: 'b'.repeat(32), url: 'https://relay.example/', spkiHash: 'a'.repeat(64), registrationKey: null }
  await writeFile(join(relays, 'open.json'), JSON.stringify({ version: 1, profile: openRelay }), { mode: 0o600 })
  await writeFile(join(relays, 'broken.json'), '{"version":2,"profile":{"kind":"edge"}}', { mode: 0o600 })
  await writeFile(join(relays, 'home.json.admin-header'), 'Authorization: Bearer x\n', { mode: 0o600 })
  const lookup = vi.fn<LookupFunction>((_hostname, _options, callback) => callback(new Error('fixture refuses network'), []))
  const host = await startTestHost({ relayFilesHome: home, egressLookup: lookup })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  const listed = await desktop.request('native/relay-files')
  expect(listed.status).toBe(200)
  const text = await listed.text()
  expect(text.includes('lrt1.')).toBe(false)
  expect(text.includes(edge.relayKey)).toBe(false)
  const listing = JSON.parse(text) as { files: NativeRelayFile[] }
  const identity = expect.stringMatching(/^[a-f0-9]{64}$/u)
  expect(listing).toEqual({
    files: [
      {
        name: 'home',
        relayId: edge.relayId,
        fileIdentity: identity,
        kind: 'edge',
        urls: [edge.url, ...edge.extraUrls],
        keyHash: expect.stringMatching(/^[a-f0-9]{8}$/u),
        hasRegistrationKey: true,
      },
      {
        name: 'open',
        relayId: openRelay.relayId,
        fileIdentity: identity,
        kind: 'self',
        urls: [openRelay.url],
        keyHash: openRelay.spkiHash.slice(0, 8),
        hasRegistrationKey: false,
      },
      {
        name: 'home',
        relayId: legacy.relayId,
        fileIdentity: identity,
        source: 'legacy',
        kind: 'edge',
        urls: [legacy.url, ...legacy.extraUrls],
        keyHash: expect.stringMatching(/^[a-f0-9]{8}$/u),
        hasRegistrationKey: true,
      },
    ],
  })
  expect((await desktop.json<NativeLinkInfo>('native/info')).relays).toEqual([])
  expect(lookup).not.toHaveBeenCalled()
  const add = (body: Record<string, unknown>) =>
    desktop.request('native/relays', { method: 'POST', body: { requestId: randomUUID(), ...body } })
  for (const file of ['../home', 'home.json', '/etc/hosts', 'broken', 'absent']) expect(await add({ file })).toMatchObject({ status: 400 })
  expect(await add({ file: 'home', profile: edge })).toMatchObject({ status: 400 })
  expect(await add({ file: 'home', fileSource: 'legacy' })).toMatchObject({ status: 400 })
  expect(await add({ fileRelayId: edge.relayId })).toMatchObject({ status: 400 })
  expect(await add({ fileIdentity: listing.files[0]!.fileIdentity })).toMatchObject({ status: 400 })
  expect(await add({ file: 'home', saveFile: true })).toMatchObject({ status: 400 })
  expect(await add({ saveFile: true })).toMatchObject({ status: 400 })
  const wrongSource = await add({ file: 'home', fileRelayId: legacy.relayId })
  expect(wrongSource.status).toBe(409)
  expect(await wrongSource.json()).toMatchObject({ error: 'native-relay-file-changed' })
  const named = await add({ file: 'home' })
  const sent = await add({ profile: { ...edge, relayId: 'f'.repeat(32) } })
  expect(named.status).toBe(sent.status)
  expect(named.status).not.toBe(400)
  expect((await add({ file: 'home', fileSource: 'legacy', fileRelayId: legacy.relayId })).status).toBe(sent.status)

  const [standard, open, old] = listing.files
  const select = (file: NativeRelayFile) =>
    add({
      file: file.name,
      fileRelayId: file.relayId,
      fileIdentity: file.fileIdentity,
      ...(file.source ? { fileSource: file.source } : {}),
    })
  expect((await select(standard!)).status).toBe(named.status)
  expect((await select(old!)).status).toBe(named.status)

  await writeFile(standardFile, edgeFile(edge, `lrt1.${'B'.repeat(43)}`))
  expect(await desktop.json('native/relay-files')).toEqual(listing)
  expect((await select(standard!)).status).toBe(named.status)

  const confirmations = host.presence.requests.length
  await writeFile(standardFile, edgeFile({ ...edge, extraUrls: edge.extraUrls.toReversed() }))
  await writeFile(legacyFile, edgeFile({ ...legacy, relayKey: 'f'.repeat(64) }))
  await writeFile(
    join(relays, 'open.json'),
    JSON.stringify({ version: 1, profile: { ...openRelay, spkiHash: `${openRelay.spkiHash.slice(0, 8)}${'f'.repeat(56)}` } }),
  )
  for (const file of [standard!, old!, open!]) {
    const replaced = await select(file)
    expect(replaced.status).toBe(409)
    expect(await replaced.json()).toMatchObject({ error: 'native-relay-file-changed' })
  }
  await writeFile(legacyFile, edgeFile({ ...legacy, relayId: '7'.repeat(32) }))
  const replacedId = await add({ file: 'home', fileSource: 'legacy', fileRelayId: legacy.relayId })
  expect(replacedId.status).toBe(409)
  expect(await replacedId.json()).toMatchObject({ error: 'native-relay-file-changed' })
  expect(host.presence.requests).toHaveLength(confirmations)
  expect(lookup).not.toHaveBeenCalled()
})

it('excludes symlinks, shared files, oversized files, non-files and management files from relay discovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'latch-relay-file-modes-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const relays = join(home, '.latch', 'relays')
  await mkdir(join(home, '.latch'), { mode: 0o700 })
  await mkdir(relays, { mode: 0o700 })
  const profile = { relayId: 'a'.repeat(32), url: 'https://relay.example/', spkiHash: 'b'.repeat(64) }
  const content = JSON.stringify({ version: 1, profile })
  const explicit = join(home, 'explicit.json')
  await writeFile(explicit, content, { mode: 0o600 })
  for (const [directory, prefix] of [
    [relays, ''],
    [home, 'latch-relay-'],
  ] as const) {
    const pathFor = (name: string) => join(directory, `${prefix}${name}.json`)
    await symlink(explicit, pathFor('link'))
    await writeFile(pathFor('wide'), content, { mode: 0o600 })
    await chmod(pathFor('wide'), 0o640)
    await writeFile(pathFor('large'), content.padEnd(RELAY_FILE_BYTES + 1), { mode: 0o600 })
    await mkdir(pathFor('folder'), { mode: 0o700 })
    await writeFile(`${pathFor('admin')}.admin-header`, content, { mode: 0o600 })
  }
  expect(await listRelayFiles(new Set(), home)).toEqual([])
  const owner = process.getuid?.()
  if (owner !== undefined) expect(await loadRelayFile(explicit, owner + 1)).toEqual({ failure: 'unreadable' })
  expect('profile' in (await loadRelayFile(join(relays, 'link.json')))).toBe(true)
})

it('reorders configured relays only from the local Mac admin and audits the change', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-relay-order-'))
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
  const first = { relayId: '1'.repeat(32), url: 'https://first.relay.example/', spkiHash: 'a'.repeat(64) }
  const second = { relayId: '2'.repeat(32), url: 'https://second.relay.example/', spkiHash: 'b'.repeat(64) }
  const seeded = await RelayProfiles.open(dataDir)
  await seeded.replace([first, second])

  const lookup = vi.fn<LookupFunction>((_hostname, _options, callback) => callback(new Error('fixture refuses network'), []))
  const host = await startTestHost({ dataDir, egressLookup: lookup })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  const remote = await host.enroll({ listener: 'loopback-tcp' })

  expect((await remote.request('native/relays/order', { method: 'PUT', body: { order: [second.relayId, first.relayId] } })).status).toBe(
    403,
  )
  expect((await desktop.request('native/relays/order', { method: 'PUT', body: { order: [first.relayId] } })).status).toBe(409)

  const reordered = await desktop.json<NativeLinkInfo>('native/relays/order', {
    method: 'PUT',
    body: { order: [second.relayId, first.relayId] },
  })
  expect(reordered.relays.map(item => item.relayId)).toEqual([second.relayId, first.relayId])

  const records = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: { lowering?: boolean; relayCount?: number } })
    .filter(record => record.action === 'native.config.changed')
  expect(records).toMatchObject([{ action: 'native.config.changed', detail: { lowering: false, direct: false, relayCount: 2 } }])
})
