import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { connect as connectHttp2, type ClientHttp2Session } from 'node:http2'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startRelay } from '@latch/relay'
import type { NativeLinkInfo } from '@latch/protocol'
import {
  connectRelayTunnel,
  connectNative,
  createTransportCertificate,
  nodeCrypto,
  openNativeHttp,
  verifyAddressBook,
  verifyNativeRevocation,
  RelayClosed,
  RelayControl,
  PaddedStream,
  type NativeHttpClient,
} from '@latch/link-client'
import { connect as connectTcp } from 'node:net'
import {
  decodePass,
  invitationCode,
  nativeKnockSecret,
  nativeRevocationInput,
  nativeVerificationText,
  parsePairingPayload,
  routeId,
} from '@latch/link-wire'
import { startTestHost } from './helpers/host.ts'
import { connectPluginTransport, createRelayTransportDriver } from '@latch/host/transports'

const observedTls = vi.hoisted(() => ({ inner: 0, outer: 0, tickets: 0, resumed: 0, protocols: new Set<string>() }))
vi.mock('node:tls', async importOriginal => {
  const original = await importOriginal<typeof import('node:tls')>()
  return {
    ...original,
    connect(options: import('node:tls').ConnectionOptions, callback?: () => void) {
      const socket = original.connect(options, callback)
      socket.on('session', () => {
        observedTls.tickets++
      })
      socket.once('secureConnect', () => {
        if (options.servername === 'transport.latch.invalid') observedTls.inner++
        else observedTls.outer++
        observedTls.protocols.add(socket.getProtocol() ?? 'unknown')
        if (socket.isSessionReused()) observedTls.resumed++
      })
      return socket
    },
  }
})
vi.mock('node:https', async importOriginal => {
  const original = await importOriginal<typeof import('node:https')>()
  return {
    ...original,
    request(url: URL, options: import('node:https').RequestOptions) {
      const req = original.request(url, options)
      req.once('socket', socket => {
        const tls = socket as import('node:tls').TLSSocket
        tls.on('session', () => {
          observedTls.tickets++
        })
        tls.once('secureConnect', () => {
          observedTls.outer++
          observedTls.protocols.add(tls.getProtocol() ?? 'unknown')
          if (tls.isSessionReused()) observedTls.resumed++
        })
      })
      return req
    },
  }
})
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
  observedTls.inner = 0
  observedTls.outer = 0
  observedTls.tickets = 0
  observedTls.resumed = 0
  observedTls.protocols.clear()
})
function ok<T>(result: { status: number; body: unknown }, status = 200): T {
  expect(result.status).toBe(status)
  return result.body as T
}

async function rawRequest(session: ClientHttp2Session, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; bytes: number; timedOut: boolean }>((resolve, reject) => {
    const stream = session.request({
      ':method': method,
      ':path': path,
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    })
    let status = 0,
      bytes = 0,
      timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stream.close()
    }, 15_000)
    timer.unref()
    stream.on('error', () => {})
    stream.once('response', values => {
      status = Number(values[':status'])
    })
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 2_097_152) stream.destroy(new Error('Fixture response exceeded its content bound'))
    })
    stream.once('close', () => {
      clearTimeout(timer)
      resolve({ status, bytes, timedOut })
    })
    try {
      stream.end(body === undefined ? undefined : JSON.stringify(body))
    } catch (cause) {
      clearTimeout(timer)
      stream.destroy()
      reject(cause)
    }
  })
}

it('pairs on the LAN only, then uses a private relay, and preserves recovery and revocation across lost acknowledgements and policy reconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-native-relay-e2e-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const tls = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
    relayId = randomBytes(16),
    token = randomBytes(32)
  const relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    cert: tls.cert,
    key: tls.key,
    relayId,
    registrationToken: token,
    maxConnections: 32,
    gateway: {
      binary: resolve('dist/relay/latch-relay-tls'),
      maxHandshakes: 8,
      handshakesPerSecond: 100,
      handshakeBurst: 8,
      prefixFraction: 1,
    },
  })
  cleanup.push(() => relay.close())
  const profile = {
    relayId: relayId.toString('hex'),
    url: `https://localhost:${relay.port}/`,
    spkiHash: createHash('sha256').update(tls.spki).digest('hex'),
    registrationKey: `lrt1.${token.toString('base64url')}`,
  }
  const pieces = Array.from({ length: 3 }, () => {
    let release!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    return { promise, release }
  })
  const activity = vi.spyOn(PaddedStream.prototype, 'activity')
  const host = await startTestHost({
    dataDir: join(directory, 'data'),
    workspaceRoot: join(directory, 'workspace'),
    native: { host: '127.0.0.1', port: 0 },
    nativeRelayCa: tls.cert,
    egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    plugins: [
      {
        id: 'padded-delta-fixture',
        name: 'Padded stream fixture',
        version: '1',
        description: '',
        activate(context) {
          context.registerProvider({
            id: 'padded-delta-fixture',
            name: 'Padded stream fixture',
            model: 'fixture',
            async *stream() {
              await pieces[0]!.promise
              yield { type: 'text', text: 'First' }
              await pieces[1]!.promise
              yield { type: 'text', text: ' suffix' }
              await pieces[2]!.promise
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      },
    ],
  })
  cleanup.push(() => host.close())
  cleanup.push(() => {
    for (const piece of pieces) piece.release()
  })
  const desktop = await host.enroll({ listener: 'unix' })
  expect(
    (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  const add = { requestId: randomUUID(), profile }
  const wrong = { requestId: randomUUID(), profile: { ...profile, registrationKey: `lrt1.${randomBytes(32).toString('base64url')}` } }
  expect((await desktop.confirmed('native/relays', { method: 'POST', body: wrong })).status).toBe(503)
  const pending = await desktop.json<NativeLinkInfo>('native/info')
  expect(pending.relays).toEqual([])
  expect(pending.pendingRelay).toEqual({ requestId: wrong.requestId, url: profile.url, canRetry: true })
  expect(JSON.stringify(pending).includes(wrong.profile.registrationKey)).toBe(false)
  expect(relay.status().routes).toBe(0)
  expect((await desktop.request('native/relays', { method: 'POST', body: { ...wrong, profile } })).status).toBe(409)
  expect((await desktop.request(`native/relay-requests/${wrong.requestId}`, { method: 'DELETE' })).status).toBe(200)
  const installed = await desktop.confirmed('native/relays', { method: 'POST', body: add })
  expect(installed.status).toBe(201)
  const installedInfo = (await installed.json()) as NativeLinkInfo
  expect(installedInfo.pendingRelay).toBeUndefined()
  expect(installedInfo.relays[0]).toMatchObject({ relayId: profile.relayId, url: profile.url })
  expect(JSON.stringify(installedInfo).includes(profile.registrationKey)).toBe(false)
  expect((await desktop.request('native/relays', { method: 'POST', body: add })).status).toBe(200)
  host.presence.mode = 'manual'
  await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 3000 })
  expect(relay.status().connections).toBe(1)
  const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
  expect(invited.status).toBe(201)
  const { invitation } = (await invited.json()) as { invitation: { payload: string } }
  const payload = parsePairingPayload(invitation.payload),
    code = invitationCode(payload.secret)
  // The QR names the LAN endpoint and nothing else: no relay, no pass.
  expect(payload.lan).toEqual([{ address: '127.0.0.1', port: host.host.nativePort }])
  const endpoint = {
    url: new URL(profile.url),
    profile: 'outer-pad-v2' as const,
    relayId,
    spki: Buffer.from(profile.spkiHash, 'hex'),
    ca: tls.cert,
    resolveAddress: async () => '127.0.0.1',
  }
  const binding = { path: 'relay' as const, profile: endpoint.profile, relayId }
  const knockKey = createHash('sha256').update(code).digest(),
    rootSpki = payload.rootSpki
  const temporary = async (): Promise<NativeHttpClient> => {
    const socket = connectTcp(host.host.nativePort!, '127.0.0.1')
    socket.on('error', () => {})
    const client = await openNativeHttp(socket, { path: 'direct' }, { rootSpki, knockKey, pairing: true })
    cleanup.push(() => client.close())
    return client
  }
  const first = await temporary(),
    device = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const create = host.host.security.enrollments.create.bind(host.host.security.enrollments)
  const createFault = vi.spyOn(host.host.security.enrollments, 'create').mockImplementationOnce(async (...args) => {
    const result = await create(...args)
    first.close()
    return result
  })
  const enrollmentBody = {
    name: 'Relay phone fixture',
    publicKey: device.spki.toString('base64url'),
    invitation: code,
    gatewayHash: '0'.repeat(64),
    native: {
      certificate: device.cert,
      verificationKey: verification.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    },
  }
  await expect(first.request('POST', '/link/api/enrollments', enrollmentBody)).rejects.toThrow()
  createFault.mockRestore()
  // The answer was lost. The same keys get their own enrollment back, with no second confirmation.
  const recovered = await temporary()
  expect(ok<{ enrollment: null }>(await recovered.request('GET', '/link/api/native/pairing')).enrollment).toBeNull()
  const shown = host.presence.requests.length
  const enrollment = ok<{ enrollment: { id: string; nonce: string; status: string } }>(
    await recovered.request('POST', '/link/api/enrollments', enrollmentBody),
    202,
  ).enrollment
  expect(host.presence.requests).toHaveLength(shown)
  const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
    key: createPrivateKey(device.key),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  expect((await recovered.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature })).status).toBe(409)
  expect(host.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '数据范围', value: '全部' })
  host.presence.approveNext()
  await vi.waitFor(async () =>
    expect(
      ok<{ enrollment: { status: string } }>(await recovered.request('GET', `/link/api/enrollments/${enrollment.id}`)).enrollment.status,
    ).toBe('approved'),
  )
  expect((await recovered.request('GET', '/link/api/enrollments/enr_other')).status).toBe(401)
  expect(
    (await recovered.request('POST', '/link/api/enrollments', { name: 'Duplicate', publicKey: device.spki.toString('base64url') })).status,
  ).toBe(401)
  expect((await recovered.request('GET', '/link/api/snapshot')).status).toBe(401)
  expect((await recovered.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature: 'invalid' })).status).toBe(401)
  const prepared = ok<{ deviceId: string; addressBook: string }>(
    await recovered.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature }),
  )
  expect(host.host.security.devices.get(prepared.deviceId)).toBeUndefined()
  const book = verifyAddressBook(prepared.addressBook, rootSpki, { hostId: host.host.hostId, deviceId: prepared.deviceId })
  expect(book.relays[0]!.passes).toHaveLength(62)
  expect(book.relays[0]!.profile).toBe(endpoint.profile)
  const complete = host.host.security.enrollments.complete.bind(host.host.security.enrollments)
  vi.spyOn(host.host.security.enrollments, 'complete').mockImplementationOnce(async (...args) => {
    const result = await complete(...args)
    recovered.close()
    return result
  })
  await expect(recovered.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature })).rejects.toThrow()
  const selected = book.relays[0]!.passes[0]!,
    regular = decodePass(selected.pass)
  expect(regular.pairing).toBe(false)
  // That QR is still good on the LAN, and opens nothing over the relay.
  const refusedTunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
  refusedTunnel.on('error', () => {})
  await expect(
    openNativeHttp(
      refusedTunnel,
      { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) },
      { rootSpki, knockKey, pairing: true },
    ),
  ).rejects.toThrow()
  const registeredTunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
  registeredTunnel.on('error', () => {})
  const regularOptions = {
    rootSpki,
    certificate: device.cert,
    key: device.key,
    knockKey: await nodeCrypto.hash(
      await nativeKnockSecret(nodeCrypto, knockKey, device.spki, verification.publicKey.export({ type: 'spki', format: 'der' })),
    ),
  }
  const descriptor = {
      version: 1 as const,
      driverId: 'official-relay-fixture',
      channelId: 'regular-device',
      endpoint: endpoint.url.origin + '/',
    },
    relayDriver = createRelayTransportDriver({
      descriptor,
      endpoint,
      credentials: async () => ({ pass: selected.pass, holderKey: selected.holderSeed }),
    })
  host.host.registry.register({
    id: 'official-transport-fixture',
    name: 'Official transport fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerTransport(relayDriver)
    },
  })
  await host.host.registry.enable('official-transport-fixture')
  const viaPlugin = await connectPluginTransport(host.host.registry, descriptor, regularOptions, {
    relayBinding: { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) },
  })
  cleanup.push(() => viaPlugin.close())
  expect(ok<{ device: { id: string } }>(await viaPlugin.client.request('GET', '/link/api/snapshot')).device.id).toBe(prepared.deviceId)
  await viaPlugin.close()
  const registered = await openNativeHttp(
    registeredTunnel,
    { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) },
    regularOptions,
  )
  cleanup.push(() => registered.close())
  const snapshot = ok<{ device: { id: string; status: string; scopes: string[]; dataScope: string } }>(
    await registered.request('GET', '/link/api/snapshot'),
  )
  expect(snapshot.device.id).toBe(prepared.deviceId)
  expect(snapshot.device.status).toBe('active')
  expect(snapshot.device.scopes).toEqual(['view', 'run', 'approve:standard', 'approve:elevated'])
  expect(snapshot.device.dataScope).toBe('all')
  expect((await registered.request('POST', '/link/api/native/address-book', {})).status).toBe(403)
  const challenge = ok<{ nonce: string; appOpenId: string; expiresAt: number }>(
    await registered.request('POST', '/link/api/native/verification/challenge', { appOpenId: 'native-relay-fixture-open' }),
  )
  const verificationSignature = sign(
    'sha256',
    Buffer.from(nativeVerificationText(host.host.hostId, prepared.deviceId, challenge.nonce, challenge.expiresAt, challenge.appOpenId)),
    { key: verification.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url')
  const window = ok<{ windowToken: string }>(
    await registered.request('POST', '/link/api/native/verification', { signature: verificationSignature }),
  )
  expect((await registered.request('POST', '/link/api/native/address-book', {})).status).toBe(200)
  expect((await registered.request('POST', '/link/api/native/pairings', {})).status).toBe(403)
  const streaming = ok<{ sessionId: string }>(
    await registered.request('POST', '/link/api/tasks', {
      prompt: 'Padded stream',
      requestId: randomUUID(),
      harnessId: 'standard',
      mode: 'chat',
      model: { providerId: 'padded-delta-fixture', model: 'fixture' },
    }),
    201,
  )
  const deltaSession = Reflect.get(registered, 'session') as ClientHttp2Session
  const deltaResponse = deltaSession.request({
    ':method': 'GET',
    ':path': `/link/api/events?sessionId=${streaming.sessionId}`,
    'x-latch-state': 'delta-v1',
  })
  cleanup.push(() => deltaResponse.close())
  const deltaFrames: Array<{ type: string; detail?: { liveText: string }; text?: { offset: number; append: string } }> = []
  let deltaPending = ''
  deltaResponse.setEncoding('utf8')
  deltaResponse.on('data', (chunk: string) => {
    deltaPending += chunk
    let end: number
    while ((end = deltaPending.indexOf('\n\n')) >= 0) {
      const frame = deltaPending.slice(0, end)
      deltaPending = deltaPending.slice(end + 2)
      const data = frame
        .split('\n')
        .find(line => line.startsWith('data: '))
        ?.slice(6)
      if (data) deltaFrames.push(JSON.parse(data) as (typeof deltaFrames)[number])
    }
  })
  const deltaOpened = new Promise<number>(resolve => deltaResponse.once('response', headers => resolve(Number(headers[':status']))))
  const activityStart = activity.mock.calls.length
  deltaResponse.end()
  expect(await deltaOpened).toBe(200)
  pieces[0]!.release()
  await expect.poll(() => deltaFrames.find(frame => frame.type === 'task-state')?.detail?.liveText).toBe('First')
  const activeKey = activity.mock.calls.slice(activityStart).find(([, active]) => active)?.[0]
  expect(activeKey).toBeDefined()
  const activeCalls = () => activity.mock.calls.filter(([key, active]) => key === activeKey && active).length
  const beforeAppend = activeCalls()
  pieces[1]!.release()
  await expect.poll(() => deltaFrames.find(frame => frame.type === 'task-delta')?.text).toEqual({ offset: 5, append: ' suffix' })
  expect(activeCalls()).toBeGreaterThan(beforeAppend)
  const deltaClosed = new Promise<void>(resolve => deltaResponse.once('close', resolve))
  deltaResponse.close()
  await deltaClosed
  await expect.poll(() => activity.mock.calls.filter(([key]) => key === activeKey).at(-1)?.[1]).toBe(false)
  pieces[2]!.release()
  host.presence.mode = 'approve'
  await writeFile(join(host.workspaceRoot, 'bulk.txt'), Buffer.alloc(2_097_152, 120))
  const task = await host.host.bridge.createTask({ prompt: 'bulk fixture', requestId: randomUUID(), mode: 'chat' })
  const metadata = ok<{ files: Array<{ file: { handle: string; etag: string } }> }>(
    await registered.request('POST', `/link/api/tasks/${task.sessionId}/files/resolve`, { paths: ['bulk.txt'] }),
  ).files[0]!.file
  const openRegistered = async () => {
    const tunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
    tunnel.on('error', () => {})
    const client = await openNativeHttp(tunnel, { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) }, regularOptions)
    cleanup.push(() => client.close())
    expect(
      (
        await client.request('POST', '/link/api/native/verification/resume', {
          appOpenId: challenge.appOpenId,
          windowToken: window.windowToken,
        })
      ).status,
    ).toBe(200)
    return client
  }
  const activation = () => ({ handle: metadata.handle, etag: metadata.etag, requestId: randomUUID() })
  const bulk = await openRegistered()
  expect(ok<{ size: number }>(await bulk.request('POST', '/link/api/native/bulk', activation())).size).toBe(2_097_152)
  const competing = await openRegistered()
  await expect(competing.request('POST', '/link/api/native/bulk', activation())).rejects.toThrow()
  await expect(bulk.request('GET', '/link/api/snapshot')).rejects.toThrow()
  await vi.waitFor(() => expect(bulk.isClosed()).toBe(true))
  const stale = await openRegistered()
  await expect(stale.request('POST', '/link/api/native/bulk', { ...activation(), etag: `"${'0'.repeat(32)}"` })).rejects.toThrow()
  const notFresh = await openRegistered()
  expect((await notFresh.request('GET', '/link/api/snapshot')).status).toBe(200)
  await expect(notFresh.request('POST', '/link/api/native/bulk', activation())).rejects.toThrow()
  const resumedBulk = await openRegistered()
  expect((await resumedBulk.request('POST', '/link/api/native/bulk', activation())).status).toBe(200)
  await expect(resumedBulk.request('POST', '/link/api/native/address-book', {})).rejects.toThrow()
  await vi.waitFor(() => expect(resumedBulk.isClosed()).toBe(true))
  // Exercise headers unavailable in the convenience SDK through a real authenticated HTTP/2 session.
  const rangeTunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
  rangeTunnel.on('error', () => {})
  const rangeSocket = await connectNative(rangeTunnel, { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) }, regularOptions)
  const rangeSession = connectHttp2('https://native.latch.invalid', {
    createConnection: () => rangeSocket,
    settings: { headerTableSize: 0, enablePush: false },
  })
  rangeSession.on('error', () => {})
  cleanup.push(() => {
    rangeSession.destroy()
    rangeSocket.destroy()
  })
  expect(
    (
      await rawRequest(
        rangeSession,
        'POST',
        '/link/api/native/verification/resume',
        {},
        {
          appOpenId: challenge.appOpenId,
          windowToken: window.windowToken,
        },
      )
    ).status,
  ).toBe(200)
  expect((await rawRequest(rangeSession, 'POST', '/link/api/native/bulk', {}, activation())).status).toBe(200)
  expect(
    await rawRequest(rangeSession, 'GET', `/link/api/files/${metadata.handle}`, {
      range: 'bytes=0-1048575',
      'if-match': metadata.etag,
      'if-range': '"obsolete-version"',
    }),
  ).toEqual({ status: 0, bytes: 0, timedOut: false })
  await vi.waitFor(() => expect(rangeSocket.destroyed).toBe(true))
  host.presence.mode = 'manual'
  const retry = await temporary()
  ok(await retry.request('POST', '/link/api/enrollments', enrollmentBody), 202)
  const repeated = ok<{ device: { id: string } }>(
    await retry.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature }),
  )
  expect(repeated.device.id).toBe(prepared.deviceId)
  expect(host.host.security.devices.list().filter(item => item.id === prepared.deviceId)).toHaveLength(1)
  const confirmations = host.presence.requests.length
  expect(
    (await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  expect(host.presence.requests.length).toBe(confirmations)
  await vi.waitFor(() => expect(registered.isClosed()).toBe(true), { timeout: 3000 })
  await vi.waitFor(() => expect(relay.status().connections).toBe(0), { timeout: 3000 })
  expect(host.host.security.devices.get(prepared.deviceId)?.status).toBe('active')
  host.presence.mode = 'approve'
  expect(
    (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  await vi.waitFor(
    async () => {
      const info = await desktop.json<{ relays: Array<{ status: string }> }>('native/info')
      expect(info.relays[0]?.status).toBe('connected')
    },
    { timeout: 3000 },
  )
  await host.host.security.devices.revoke(prepared.deviceId, 'manual', { listener: 'host' })
  const tombstoneTunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
  tombstoneTunnel.on('error', () => {})
  const tombstoneClient = await openNativeHttp(
    tombstoneTunnel,
    { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) },
    regularOptions,
  )
  cleanup.push(() => tombstoneClient.close())
  expect((await tombstoneClient.request('GET', '/link/api/snapshot')).status).toBe(401)
  const envelope = ok<{ revocation: unknown }>(await tombstoneClient.request('GET', '/link/api/native/revocation')),
    revocation = verifyNativeRevocation(envelope.revocation, { rootSpki, hostId: host.host.hostId, deviceId: prepared.deviceId })
  const acknowledge = host.host.security.devices.acknowledgeNativeRevocation.bind(host.host.security.devices),
    deny = vi.spyOn(RelayControl.prototype, 'deny')
  const lostAck = vi.spyOn(host.host.security.devices, 'acknowledgeNativeRevocation').mockImplementationOnce(async (...args) => {
    await acknowledge(...args)
    tombstoneClient.close()
  })
  await expect(
    tombstoneClient.request('POST', '/link/api/native/revocation/ack', {
      requestId: randomUUID(),
      tombstoneHash: createHash('sha256')
        .update(nativeRevocationInput(revocation.hostId, revocation.deviceId, revocation.revokedAt))
        .digest('hex'),
    }),
  ).rejects.toThrow()
  lostAck.mockRestore()
  const denied = async () => {
    try {
      const tunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
      tunnel.destroy()
      return false
    } catch (error) {
      return error instanceof RelayClosed && error.closeCode === 4100
    }
  }
  await vi.waitFor(async () => expect(await denied()).toBe(true), { timeout: 5000 })
  expect(host.host.security.devices.nativeRevocations().find(item => item.id === prepared.deviceId)?.acknowledged).toBe(true)
  // One denial for each route whose passes are still good: today's and tomorrow's, and yesterday's for the first fifteen
  // minutes of the day. The node refuses one for a route past that and closes the Host's connection.
  const live = (Date.now() / 1000) % 86_400 <= 900 ? 3 : 2
  await vi.waitFor(() => expect(deny.mock.calls.length).toBeGreaterThanOrEqual(live), { timeout: 3000 })
  expect(
    (await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  await vi.waitFor(() => expect(relay.status().connections).toBe(0), { timeout: 3000 })
  deny.mockClear()
  expect(
    (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  await vi.waitFor(() => expect(deny.mock.calls.length).toBeGreaterThanOrEqual(live), { timeout: 5000 })
  expect(await denied()).toBe(true)
  expect(observedTls.inner).toBeGreaterThan(0)
  expect(observedTls.outer).toBeGreaterThan(0)
  expect([...observedTls.protocols]).toEqual(['TLSv1.3'])
  expect(observedTls.resumed).toBe(0)
  expect(observedTls.tickets).toBe(0)
})

it('registers a built-in relay from the first phone until the last one has read its removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-official-relay-e2e-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const tls = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
    relayId = randomBytes(16)
  const relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    cert: tls.cert,
    key: tls.key,
    relayId,
    openRegistration: true,
    registrationWork: { softRoutesPerPrefix: 1, minBits: 0, maxBits: 0, maxConcurrent: 2 },
    maxConnections: 32,
    gateway: {
      binary: resolve('dist/relay/latch-relay-tls'),
      maxHandshakes: 8,
      handshakesPerSecond: 100,
      handshakeBurst: 8,
      prefixFraction: 1,
    },
  })
  cleanup.push(() => relay.close())
  const official = {
    relayId: relayId.toString('hex'),
    url: `https://localhost:${relay.port}/`,
    spkiHash: createHash('sha256').update(tls.spki).digest('hex'),
  }
  const host = await startTestHost({
    native: { host: '127.0.0.1', port: 0 },
    officialRelays: [official],
    nativeRelayCa: tls.cert,
    egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
  })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  expect(
    (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  // Nothing to reach yet: a Mac with no phone stays off the relay, and the settings do not list it as a custom one.
  await new Promise(done => setTimeout(done, 1500))
  expect(relay.status().connections).toBe(0)
  expect((await desktop.json<{ relays: unknown[] }>('native/info')).relays).toEqual([])

  const { invitation } = (await (await desktop.request('native/pairings', { method: 'POST', body: {} })).json()) as {
    invitation: { payload: string }
  }
  const payload = parsePairingPayload(invitation.payload),
    code = invitationCode(payload.secret),
    knockKey = createHash('sha256').update(code).digest()
  const open = async (options: Parameters<typeof openNativeHttp>[2]) => {
    const socket = connectTcp(host.host.nativePort!, '127.0.0.1')
    socket.on('error', () => {})
    const client = await openNativeHttp(socket, { path: 'direct' }, options)
    cleanup.push(() => client.close())
    return client
  }
  const pairing = await open({ rootSpki: payload.rootSpki, knockKey, pairing: true }),
    device = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    verificationSpki = verification.publicKey.export({ type: 'spki', format: 'der' })
  const enrollment = ok<{ enrollment: { id: string; nonce: string } }>(
    await pairing.request('POST', '/link/api/enrollments', {
      name: 'Official relay fixture',
      publicKey: device.spki.toString('base64url'),
      invitation: code,
      gatewayHash: '0'.repeat(64),
      native: { certificate: device.cert, verificationKey: verificationSpki.toString('base64url') },
    }),
    202,
  ).enrollment
  await vi.waitFor(async () =>
    expect(
      ok<{ enrollment: { status: string } }>(await pairing.request('GET', `/link/api/enrollments/${enrollment.id}`)).enrollment.status,
    ).toBe('approved'),
  )
  const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
    key: createPrivateKey(device.key),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  const prepared = ok<{ deviceId: string; addressBook: string }>(
    await pairing.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature }),
  )
  // The book a phone leaves with already names the relay, before any phone exists to use it.
  expect(
    verifyAddressBook(prepared.addressBook, payload.rootSpki, { hostId: host.host.hostId, deviceId: prepared.deviceId }).relays,
  ).toHaveLength(1)
  ok(await pairing.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature }))
  await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 5000 })

  // Removing the last phone keeps the relay until that phone has read its removal, so it learns away from home too.
  await host.host.security.devices.revoke(prepared.deviceId, 'manual', { listener: 'host' })
  await new Promise(done => setTimeout(done, 1500))
  expect(relay.status().connections).toBe(1)
  const client = await open({
    rootSpki: payload.rootSpki,
    knockKey: await nodeCrypto.hash(await nativeKnockSecret(nodeCrypto, knockKey, device.spki, verificationSpki)),
    certificate: device.cert,
    key: device.key,
  })
  const revoked = ok<{ revocation: { revokedAt: number } }>(await client.request('GET', '/link/api/native/revocation')).revocation
  ok(
    await client.request('POST', '/link/api/native/revocation/ack', {
      requestId: randomUUID(),
      tombstoneHash: createHash('sha256')
        .update(nativeRevocationInput(host.host.hostId, prepared.deviceId, revoked.revokedAt))
        .digest('hex'),
    }),
  )
  await vi.waitFor(() => expect(relay.status().connections).toBe(0), { timeout: 5000 })
})
