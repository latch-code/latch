import { connect } from 'node:net'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTransportCertificate,
  renewDeviceCertificate,
  NativeWorkspace,
  openNativeHttp,
  NativeHttpClient,
  verifyNativeRevocation,
  verifyAddressBook,
} from '@latch/link-client'
import { discoveryEpochInput, knock, nativeKnockSecret, nativeRevocationInput, nativeVerificationText, pairingCode } from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import type { TestDevice } from '@latch/testkit'
import type { TaskDetail } from '@latch/protocol'
import type { Bridge, HarnessPlugin } from '@latch/sdk'
import type { PresenceBackend } from '../src/presence.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { NativeReplay } from '../src/native-replay.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})
function body<T>(result: { status: number; body: unknown }, status = 200): T {
  expect(result.status).toBe(status)
  return result.body as T
}
async function pair(host: TestHost, inviter?: TestDevice) {
  const response = inviter
    ? await inviter.request('native/pairings', { method: 'POST', body: {} })
    : await host.raw('unix', 'api/native/pairings', { method: 'POST', body: {} })
  expect(response.status).toBe(201)
  const { invitation } = (await response.json()) as { invitation: { payload: string } }
  const payload = JSON.parse(Buffer.from(invitation.payload.slice('LATCHPAIR1.'.length), 'base64url').toString()) as {
    rootSpki: string
    invitation: string
  }
  const device = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const knockKey = createHash('sha256').update(payload.invitation).digest()
  const raw = connect(host.host.nativePort!, '127.0.0.1')
  raw.on('error', () => {})
  const temporary = await openNativeHttp(
    raw,
    { path: 'direct' },
    { rootSpki: Buffer.from(payload.rootSpki, 'base64url'), knockKey, pairing: true },
  )
  cleanup.push(() => temporary.close())
  const spy = vi.spyOn(host.presence as PresenceBackend, 'confirm')
  const enrollment = body<{ enrollment: { id: string; nonce: string; status: string } }>(
    await temporary.request('POST', '/link/api/enrollments', {
      name: '原生测试手机',
      publicKey: device.spki.toString('base64url'),
      invitation: payload.invitation,
      native: {
        certificate: device.cert,
        verificationKey: verification.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
    }),
    202,
  ).enrollment
  const expectedCode = await pairingCode(nodeCrypto, knockKey, device.spki, verification.publicKey.export({ format: 'der', type: 'spki' }))
  expect(spy.mock.calls.at(-1)?.[0].pairingCode).toBe(expectedCode)
  expect(spy.mock.calls.at(-1)?.[0].preview.action).toBe('device.enroll-native')
  expect(JSON.stringify(spy.mock.calls.at(-1)?.[0].preview)).not.toContain(`"pairingCode"`)
  await vi.waitFor(async () => {
    expect(
      body<{ enrollment: { status: string } }>(await temporary.request('GET', `/link/api/enrollments/${enrollment.id}`)).enrollment.status,
    ).toBe('approved')
  })
  const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
    key: createPrivateKey(device.key),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  const registered = body<{ device: { id: string } }>(
    await temporary.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature }),
  )
  temporary.close()
  const nativeRaw = connect(host.host.nativePort!, '127.0.0.1')
  nativeRaw.on('error', () => {})
  const clientOptions = {
    rootSpki: Buffer.from(payload.rootSpki, 'base64url'),
    knockKey: await nodeCrypto.hash(
      await nativeKnockSecret(nodeCrypto, knockKey, device.spki, verification.publicKey.export({ format: 'der', type: 'spki' })),
    ),
    certificate: device.cert,
    key: device.key,
  }
  const client = await openNativeHttp(nativeRaw, { path: 'direct' }, clientOptions)
  cleanup.push(() => client.close())
  return { client, deviceId: registered.device.id, verification, invitation: payload.invitation, clientOptions }
}
async function verifyDevice(
  host: TestHost,
  client: NativeHttpClient,
  deviceId: string,
  key: ReturnType<typeof generateKeyPairSync>['privateKey'],
) {
  const challenge = body<{ nonce: string; appOpenId: string; expiresAt: number }>(
    await client.request('POST', '/link/api/native/verification/challenge', { appOpenId: 'application-open-fixture' }),
  )
  const text = nativeVerificationText(host.host.hostId, deviceId, challenge.nonce, challenge.expiresAt, challenge.appOpenId)
  const signature = sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  const result = await client.request('POST', '/link/api/native/verification', { signature })
  const receipt = body<{ verifiedUntil: string; windowToken: string }>(result)
  expect((await client.request('POST', '/link/api/native/verification', { signature })).status).toBe(403)
  return { ...receipt, appOpenId: challenge.appOpenId }
}
describe('native Host entry with existing authorization', () => {
  it('keeps question bodies private before App verification and refuses an answer after its window expires', async () => {
    let time = Date.now(),
      continued = 0
    const prompt = 'Private question body',
      option = 'Private option label'
    const plugin: HarnessPlugin = {
      id: 'native-question-fixture',
      name: '',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'native-question',
          name: 'Native question',
          model: 'fake',
          async *stream({ messages }) {
            if (messages.at(-1)?.role === 'tool') {
              continued++
              yield { type: 'text', text: 'Continued' }
              yield { type: 'finish', reason: 'stop' }
            } else {
              yield {
                type: 'tool-call',
                call: {
                  id: `question-${randomUUID()}`,
                  name: 'ask_user',
                  arguments: {
                    prompt,
                    questions: [{ id: 'choice', label: 'Choose', options: [{ id: 'one', label: option }] }],
                  },
                },
              }
              yield { type: 'finish', reason: 'tool-calls' }
            }
          },
        })
      },
    }
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      now: () => time,
      demo: false,
      plugins: [plugin],
      providerId: 'native-question',
    })
    cleanup.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' }),
      registered = await pair(host)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Question session', requestId: randomUUID() },
    })
    const path = `/link/api/tasks/${sessionId}`
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).questions?.length).toBe(1)
    const question = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).questions![0]!
    const submission = { requestId: randomUUID(), answers: [{ questionId: 'choice', optionIds: ['one'] }] }
    const snapshot = body<{ tasks: Array<{ id: string; pendingQuestions?: number }> }>(
      await registered.client.request('GET', '/link/api/snapshot'),
    )
    expect(snapshot.tasks.find(task => task.id === sessionId)?.pendingQuestions).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain(prompt)
    expect(JSON.stringify(snapshot)).not.toContain(option)
    expect((await registered.client.request('GET', path)).status).toBe(403)
    expect((await registered.client.request('POST', `${path}/questions/${question.id}/answer`, submission)).status).toBe(403)
    const receipt = await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect(JSON.stringify(body(await registered.client.request('GET', path)))).toContain(prompt)
    time = Date.parse(receipt.verifiedUntil) + 1
    expect((await registered.client.request('POST', `${path}/questions/${question.id}/answer`, submission)).status).toBe(403)
    expect(continued).toBe(0)
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect(body(await registered.client.request('POST', `${path}/questions/${question.id}/answer`, submission))).toMatchObject({
      answered: true,
    })
    await expect.poll(() => continued).toBe(1)
  })
  it('parks queued input when its original App window expires and keeps queue bodies out of unverified snapshots', async () => {
    let time = Date.now(),
      calls = 0
    let release: (() => void) | undefined
    const plugin: HarnessPlugin = {
      id: 'native-queue-fixture',
      name: 'Native queue fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'native-queue',
          name: 'Native queue',
          model: 'fake',
          async *stream({ signal }) {
            calls++
            yield { type: 'text', text: 'Waiting for the fixture' }
            await new Promise<void>(done => {
              const finish = () => {
                signal.removeEventListener('abort', finish)
                done()
              }
              release = finish
              signal.addEventListener('abort', finish, { once: true })
              if (signal.aborted) finish()
            })
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      now: () => time,
      demo: false,
      plugins: [plugin],
      providerId: 'native-queue',
    })
    cleanup.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' })
    const registered = await pair(host)
    const receipt = await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    const { sessionId } = body<{ sessionId: string }>(
      await registered.client.request('POST', '/link/api/tasks', {
        prompt: 'First',
        requestId: randomUUID(),
        model: { providerId: 'native-queue', model: 'fake' },
      }),
      201,
    )
    await expect.poll(() => calls).toBe(1)
    const nextText = 'A private queued follow-up'
    const queued = body<{ queued: { id: string } }>(
      await registered.client.request('POST', `/link/api/tasks/${sessionId}/prompt`, {
        prompt: nextText,
        requestId: randomUUID(),
        queue: true,
      }),
      202,
    )
    const raw = connect(host.host.nativePort!, '127.0.0.1')
    raw.on('error', () => {})
    const unverified = await openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => unverified.close())
    expect(JSON.stringify(body(await unverified.request('GET', '/link/api/snapshot')))).not.toContain(nextText)
    expect((await unverified.request('GET', `/link/api/tasks/${sessionId}`)).status).toBe(403)
    time = Date.parse(receipt.verifiedUntil) + 1
    release!()
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).queue)
      .toMatchObject([{ id: queued.queued.id, text: nextText, state: 'parked' }])
    expect(calls).toBe(1)
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect((await registered.client.request('POST', `/link/api/tasks/${sessionId}/queue/${queued.queued.id}/send`, {})).status).toBe(200)
    expect(calls).toBe(1)
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(JSON.stringify(detail)).not.toContain('nativeWindowHash')
    expect(detail.queue).toMatchObject([{ text: nextText, state: 'parked' }])
  })

  it('notifies another verified phone after a durable discovery rotation without changing epochs when books are issued', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const a = await pair(host),
      b = await pair(host)
    await verifyDevice(host, b.client, b.deviceId, b.verification.privateKey)
    const epoch = async () =>
      body<{ host: { native: { discoveryEpoch: string } } }>(await b.client.request('GET', '/link/api/snapshot')).host.native.discoveryEpoch
    const before = await epoch()
    expect(before).toMatch(/^[a-f0-9]{64}$/u)
    const workspace = new NativeWorkspace({ ...b.clientOptions, hostId: host.host.hostId, deviceId: b.deviceId })
    cleanup.push(() => workspace.close())
    await workspace.migrate([{ id: 'epoch-lan', kind: 'direct', address: '127.0.0.1', port: host.host.nativePort! }])
    expect(workspace.checkpoint()?.discoveryEpoch).toBe(before)
    expect((await workspace.request('POST', '/link/api/native/address-book', {})).status).toBe(403)
    const book = async () => {
      const value = body<{ addressBook: string }>(await b.client.request('POST', '/link/api/native/address-book', {}))
      return verifyAddressBook(value.addressBook, b.clientOptions.rootSpki, { hostId: host.host.hostId, deviceId: b.deviceId })
    }
    const first = await book(),
      second = await book()
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(createHash('sha256').update(discoveryEpochInput(first.discoveryKey)).digest('hex')).toBe(before)
    expect(await epoch()).toBe(before)
    const stream = b.client.events('/link/api/events')
    stream.on('error', () => {})
    cleanup.push(async () => {
      stream.close()
    })
    let frames = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      frames += chunk
    })
    await vi.waitFor(() => expect(frames).toContain(before))
    await host.host.security.devices.revoke(a.deviceId, 'manual', { listener: 'host' })
    await vi.waitFor(() => {
      const hints = [...frames.matchAll(/"discoveryEpoch":"([a-f0-9]{64})"/gu)].map(match => match[1])
      expect(hints.some(value => value !== before)).toBe(true)
    })
    const after = await epoch(),
      refreshed = await book()
    expect(after).not.toBe(before)
    await workspace.refresh()
    expect(workspace.checkpoint()?.discoveryEpoch).toBe(after)
    expect(createHash('sha256').update(discoveryEpochInput(refreshed.discoveryKey)).digest('hex')).toBe(after)
    expect(refreshed.generation).toBeGreaterThan(second.generation)
    expect((await b.client.request('GET', '/link/api/snapshot')).status).toBe(200)
  })

  it('requires the same native connection verification window for proximity and keeps unknown networks remote', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const phone = await pair(host),
      scopes = host.host.security.devices.get(phone.deviceId)!.scopes
    expect((await phone.client.request('POST', '/link/api/native/proximity', { gatewayHash: '0'.repeat(64) })).status).toBe(403)
    await verifyDevice(host, phone.client, phone.deviceId, phone.verification.privateKey)
    expect(body(await phone.client.request('POST', '/link/api/native/proximity', { gatewayHash: '0'.repeat(64) }))).toEqual({
      nearby: false,
    })
    expect(host.host.security.devices.get(phone.deviceId)!.scopes).toEqual(scopes)
    expect(
      (await phone.client.request('POST', '/link/api/native/proximity', { gatewayHash: '0'.repeat(64), source: '192.168.1.9' })).status,
    ).toBe(400)
  })
  it('reports a missing native TLS component and keeps a disabled entry closed without falling back to Node TLS', async () => {
    const host = await startTestHost()
    cleanup.push(() => host.close())
    const native = await startNativeHost({
      tlsBinary: join(host.dataDir, 'missing-native-component'),
      identity: await loadOrCreateHostIdentity(host.dataDir),
      devices: host.host.security.devices,
      enrollments: host.host.security.enrollments,
      relayAvailable: () => true,
      handler(_request, response) {
        response.end()
      },
    })
    cleanup.push(() => native.close())
    await expect(native.ensureTransport()).rejects.toMatchObject({ code: 'native-component-unavailable' })
    await expect(native.prepareBind({ host: '127.0.0.1', port: 0 })).rejects.toMatchObject({ code: 'native-component-unavailable' })
    expect(native.port).toBeUndefined()
    await expect(native.invite({}, { listener: 'host' })).rejects.toMatchObject({ code: 'native-component-unavailable' })
    const disabled = await native.prepareBind(undefined)
    disabled.commit()
    expect(native.port).toBeUndefined()
  })
  it('replays real missed task projections across a new authenticated path without letting a list checkpoint skip body events', async () => {
    let notify: (id?: string) => void = () => {}
    let exists = true
    let currentTime = Date.now()
    const detail: TaskDetail = {
      summary: { id: 'replay-fixture', title: 'Replay fixture', status: 'idle', updatedAt: '2026-10-25' },
      messages: [],
      approvals: [],
      liveText: '',
      cursor: 0,
    }
    const bridge: Bridge = {
      async start() {},
      async close() {},
      async listTasks() {
        return exists ? [detail.summary] : []
      },
      async detail() {
        return structuredClone(detail)
      },
      async createTask() {
        throw new Error('Unused')
      },
      async prompt() {},
      async cancel() {},
      approvals() {
        return []
      },
      async decide() {
        return false
      },
      subscribe(listener) {
        notify = listener
        return () => {
          notify = () => {}
        }
      },
    }
    const published = vi.spyOn(NativeReplay.prototype, 'publish')
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      now: () => currentTime,
      harnessId: 'replay',
      plugins: [
        {
          id: 'replay-fixture',
          name: 'Replay fixture',
          version: '1',
          description: 'Local deterministic fixture',
          activate(ctx) {
            ctx.registerHarness({ id: 'replay', name: 'Replay', version: '1', create: () => bridge })
          },
        },
      ],
    })
    cleanup.push(() => host.close())
    const registered = await pair(host),
      workspace = new NativeWorkspace({ ...registered.clientOptions, hostId: host.host.hostId, deviceId: registered.deviceId })
    cleanup.push(() => workspace.close())
    const paths = [{ id: 'replay-lan', kind: 'direct' as const, address: '127.0.0.1', port: host.host.nativePort! }]
    await workspace.migrate(paths)
    await workspace.verify(async statement =>
      sign('sha256', Buffer.from(statement), { key: registered.verification.privateKey, dsaEncoding: 'ieee-p1363' }),
    )
    const initial = workspace.events(detail.summary.id)
    expect((await initial.next()).value).toMatchObject({ type: 'refresh', value: { resumeRequired: true } })
    const reading = initial.next().catch(() => ({ done: true }))
    await workspace.refresh()
    workspace.networkChanged()
    await workspace.migrate(paths)
    await reading
    await initial.return(undefined)
    detail.liveText = 'missed while no stream was open'
    detail.cursor++
    notify(detail.summary.id)
    await vi.waitFor(() =>
      expect(published.mock.calls.some(([event]) => event.type === 'task-state' && event.detail.liveText === detail.liveText)).toBe(true),
    )
    await workspace.refresh()
    const resumed = workspace.events(detail.summary.id)
    let found = false
    for (let count = 0; count < 4; count++) {
      const next = await resumed.next()
      expect(next.done).toBe(false)
      expect(next.value).not.toMatchObject({ value: { resumeRequired: true } })
      if (next.value?.type === 'task-state') {
        expect(next.value).toMatchObject({ value: { detail: { liveText: detail.liveText, cursor: 1 } } })
        found = true
        break
      }
    }
    expect(found).toBe(true)
    await resumed.return(undefined)
    exists = false
    notify()
    const removed = workspace.events(detail.summary.id)
    await expect(removed.next()).rejects.toThrow('event stream ended')
    exists = true
    currentTime += 10 * 60_000 + 1
    const expired = workspace.events(detail.summary.id)
    await expect(expired.next()).rejects.toThrow('event stream ended')
  })
  it('delivers only a Root-authenticated revocation and supports idempotent acknowledgement within its retention', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    await host.host.security.devices.revoke(registered.deviceId, 'manual', { listener: 'host' })
    await vi.waitFor(() => expect(registered.client.isClosed()).toBe(true))
    const socket = connect(host.host.nativePort!, '127.0.0.1')
    socket.on('error', () => {})
    const client = await openNativeHttp(socket, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => client.close())
    expect((await client.request('GET', '/link/api/snapshot')).status).toBe(401)
    expect((await client.request('POST', '/link/api/native/verification/challenge', { appOpenId: 'revoked-opening-fixture' })).status).toBe(
      401,
    )
    const response = body<{ revocation: unknown }>(await client.request('GET', '/link/api/native/revocation')),
      item = verifyNativeRevocation(response.revocation, {
        ...registered.clientOptions,
        hostId: host.host.hostId,
        deviceId: registered.deviceId,
      })
    expect(item.deviceId).toBe(registered.deviceId)
    expect(() =>
      verifyNativeRevocation(
        { ...item, revokedAt: item.revokedAt + 1 },
        { ...registered.clientOptions, hostId: host.host.hostId, deviceId: registered.deviceId },
      ),
    ).toThrow()
    expect(
      (await client.request('POST', '/link/api/native/revocation/ack', { requestId: randomUUID(), tombstoneHash: '0'.repeat(64) })).status,
    ).toBe(401)
    expect(host.host.security.devices.nativeRevocations()[0]!.acknowledged).toBe(false)
    const ack = {
      requestId: randomUUID(),
      tombstoneHash: createHash('sha256')
        .update(nativeRevocationInput(item.hostId, item.deviceId, item.revokedAt))
        .digest('hex'),
    }
    expect(body(await client.request('POST', '/link/api/native/revocation/ack', ack))).toEqual({ acknowledged: true })
    expect(body(await client.request('POST', '/link/api/native/revocation/ack', ack))).toEqual({ acknowledged: true })
    expect(host.host.security.devices.nativeRevocations()[0]!.acknowledged).toBe(true)
    expect(host.host.security.devices.nativeCandidates().some(device => device.id === registered.deviceId)).toBe(false)
    expect(host.host.security.devices.nativeTransportCandidates().some(device => device.id === registered.deviceId)).toBe(true)
    const disk = JSON.parse(await readFile(join(host.dataDir, 'auth/devices.json'), 'utf8')) as {
      devices: Array<{ id: string; native?: { revocationAcknowledgedAt?: number } }>
    }
    expect(disk.devices.find(device => device.id === registered.deviceId)?.native?.revocationAcknowledgedAt).toBeTypeOf('number')
  })
  it('stops a native workspace only after a fixed Root revocation and retains tombstone recovery beyond relay grace', async () => {
    let now = Date.now()
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => now })
    cleanup.push(() => host.close())
    const registered = await pair(host),
      workspace = new NativeWorkspace({ ...registered.clientOptions, hostId: host.host.hostId, deviceId: registered.deviceId })
    cleanup.push(() => workspace.close())
    const paths = [{ id: 'lan', kind: 'direct' as const, address: '127.0.0.1', port: host.host.nativePort! }]
    await workspace.migrate(paths)
    await host.host.security.devices.revoke(registered.deviceId, 'manual', { listener: 'host' })
    expect(host.host.security.devices.nativeTransportCandidates().some(device => device.id === registered.deviceId)).toBe(true)
    await workspace.migrate(paths)
    expect(workspace.revoked()?.deviceId).toBe(registered.deviceId)
    expect(workspace.checkpoint()).toBeUndefined()
    await expect(workspace.migrate(paths)).rejects.toThrow('revoked')
    const another = await pair(host)
    await host.host.security.devices.revoke(another.deviceId, 'manual', { listener: 'host' })
    now += 7 * 86400_000
    expect(host.host.security.devices.nativeTransportCandidates().some(device => device.id === another.deviceId)).toBe(true)
    expect(host.host.security.devices.nativeRevocations().find(device => device.id === another.deviceId)?.acknowledged).toBe(false)
  })
  it('keeps only the Root tombstone available through direct transport after seven days and an earlier acknowledgement', async () => {
    let now = Date.now()
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => now })
    cleanup.push(() => host.close())
    const phone = await pair(host)
    await host.host.security.devices.revoke(phone.deviceId, 'manual', { listener: 'host' })
    now += 8 * 86400_000
    const open = async () => {
      const raw = connect(host.host.nativePort!, '127.0.0.1')
      raw.on('error', () => {})
      const client = await openNativeHttp(raw, { path: 'direct' }, phone.clientOptions)
      cleanup.push(() => client.close())
      return client
    }
    const client = await open()
    expect((await client.request('GET', '/link/api/snapshot')).status).toBe(401)
    const value = body<{ revocation: unknown }>(await client.request('GET', '/link/api/native/revocation'))
    const revocation = verifyNativeRevocation(value.revocation, {
      ...phone.clientOptions,
      hostId: host.host.hostId,
      deviceId: phone.deviceId,
    })
    const tombstoneHash = createHash('sha256')
      .update(nativeRevocationInput(revocation.hostId, revocation.deviceId, revocation.revokedAt))
      .digest('hex')
    expect((await client.request('POST', '/link/api/native/revocation/ack', { requestId: randomUUID(), tombstoneHash })).status).toBe(200)
    client.close()
    const again = await open()
    expect((await again.request('GET', '/link/api/native/revocation')).status).toBe(200)
    expect((await again.request('GET', '/link/api/snapshot')).status).toBe(401)
    expect(host.host.security.devices.nativeCandidates().some(item => item.id === phone.deviceId)).toBe(false)
    expect(host.host.security.devices.nativeTransportCandidates().some(item => item.id === phone.deviceId)).toBe(true)
    again.close()
    now += 83 * 86400_000
    expect(host.host.security.devices.nativeTransportCandidates().some(item => item.id === phone.deviceId)).toBe(false)
    await expect(open()).rejects.toThrow()
  })
  it('bounds tombstone transports separately and closes them on an absolute deadline even while they stay active', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const a = await pair(host),
      b = await pair(host),
      c = await pair(host),
      active = await pair(host)
    for (const phone of [a, b, c]) await host.host.security.devices.revoke(phone.deviceId, 'manual', { listener: 'host' })
    const open = async (phone: typeof a) => {
      const raw = connect(host.host.nativePort!, '127.0.0.1')
      raw.on('error', () => {})
      const client = await openNativeHttp(raw, { path: 'direct' }, phone.clientOptions)
      cleanup.push(() => client.close())
      return client
    }
    const first = await open(a),
      second = await open(b)
    await expect(open(c)).rejects.toThrow()
    const normal = await open(active)
    expect((await normal.request('GET', '/link/api/snapshot')).status).toBe(200)
    let completed = 0
    const heartbeat = setInterval(() => {
      void first
        .request('GET', '/link/api/native/revocation')
        .then(() => completed++)
        .catch(() => {})
    }, 250)
    cleanup.push(async () => {
      clearInterval(heartbeat)
    })
    await vi.waitFor(
      () => {
        expect(first.isClosed()).toBe(true)
        expect(second.isClosed()).toBe(true)
      },
      { timeout: 6500 },
    )
    clearInterval(heartbeat)
    expect(completed).toBeGreaterThan(1)
    const recovered = await open(c)
    expect((await recovered.request('GET', '/link/api/native/revocation')).status).toBe(200)
    expect((await normal.request('GET', '/link/api/snapshot')).status).toBe(200)
  })
  it('keeps the old listener until commit and closes a staged replacement during shutdown', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const native = await startNativeHost({
      tlsBinary: resolve('dist/native/latch-native-tls'),
      identity: await loadOrCreateHostIdentity(host.dataDir),
      devices: host.host.security.devices,
      enrollments: host.host.security.enrollments,
      bind: { host: '127.0.0.1', port: 0 },
      handler(_request, response) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      },
    })
    cleanup.push(() => native.close())
    const actual = native.direct!
    ;(await native.prepareBind(actual)).commit()
    expect(native.direct).toEqual(actual)
    const socket = connect(native.port!, '127.0.0.1')
    socket.on('error', () => {})
    const client = await openNativeHttp(socket, { path: 'direct' }, registered.clientOptions)
    cleanup.push(async () => {
      client.close()
    })
    const discarded = await native.prepareBind(undefined)
    await discarded.cancel()
    expect((await client.request('GET', '/link/api/snapshot')).status).toBe(200)
    const disabled = await native.prepareBind(undefined)
    disabled.commit()
    await vi.waitFor(() => expect(client.isClosed()).toBe(true))
    expect(native.port).toBeUndefined()
    const staged = await native.prepareBind({ host: '127.0.0.1', port: 0 })
    await native.close()
    expect(() => staged.commit()).toThrow('Host 正在停止')
    await staged.cancel()
  })
  it('reclaims the oldest pending handshake and bounds the authenticated connection pool per device', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const pending: Array<ReturnType<typeof connect>> = []
    for (let index = 0; index < 3; index++) {
      const socket = connect(host.host.nativePort!, '127.0.0.1')
      socket.on('error', () => {})
      cleanup.push(() => {
        socket.destroy()
      })
      const reply = new Promise<void>((resolve, reject) => {
        socket.once('data', () => resolve())
        socket.once('error', reject)
      })
      socket.write(await knock(nodeCrypto, registered.clientOptions.knockKey, { path: 'direct' }, Date.now()))
      await reply
      pending.push(socket)
    }
    await vi.waitFor(() => expect(pending[0]!.destroyed).toBe(true))
    expect(pending[1]!.destroyed || pending[2]!.destroyed).toBe(false)
    for (const socket of pending) socket.destroy()
    const open = async () => {
      const raw = connect(host.host.nativePort!, '127.0.0.1')
      raw.on('error', () => {})
      return openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    }
    const clients: NativeHttpClient[] = []
    for (let index = 0; index < 3; index++) {
      const client = await open()
      cleanup.push(() => client.close())
      clients.push(client)
    }
    await expect(open()).rejects.toThrow()
    expect((await registered.client.request('GET', '/link/api/snapshot')).status).toBe(200)
    clients[0]!.close()
    await vi.waitFor(() => expect(clients[0]!.isClosed()).toBe(true))
    const replacement = await open()
    cleanup.push(() => replacement.close())
    expect((await replacement.request('GET', '/link/api/snapshot')).status).toBe(200)
  })
  it('bounds invitation issuance even when all local requests arrive before the first audit settles', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const responses = await Promise.all(
      Array.from({ length: 33 }, () => host.raw('unix', 'api/native/pairings', { method: 'POST', body: {} })),
    )
    expect(responses.filter(item => item.status === 201)).toHaveLength(32)
    expect(responses.filter(item => item.status === 429)).toHaveLength(1)
    expect(host.host.security.enrollments.nativeInvitations()).toHaveLength(32)
  })
  it('automatically reconnects one workspace after its Host restarts without sending a session write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-native-reconnect-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const options = {
      native: { host: '127.0.0.1', port: 0 },
      dataDir: join(directory, 'data'),
      workspaceRoot: join(directory, 'workspace'),
    }
    const first = await startTestHost(options)
    cleanup.push(() => first.close())
    const registered = await pair(first)
    const workspace = new NativeWorkspace({ ...registered.clientOptions, hostId: first.host.hostId, deviceId: registered.deviceId })
    let port = first.host.nativePort!
    const candidates = () => [{ id: 'automatic-lan', kind: 'direct' as const, address: '127.0.0.1', port }]
    const request = vi.spyOn(NativeHttpClient.prototype, 'request')
    const states: string[] = []
    const owner = workspace.reconnect(candidates, { baseDelayMs: 100, maxDelayMs: 200, onState: state => states.push(state) })
    cleanup.push(async () => {
      workspace.close()
      await owner.done
    })
    expect(workspace.reconnect(candidates)).toBe(owner)
    await vi.waitFor(() => expect(workspace.checkpoint()?.value).toMatchObject({ device: { id: registered.deviceId } }))
    const previous = workspace.checkpoint()!.instanceId
    await first.close()
    await vi.waitFor(() => expect(states).toContain('waiting'))
    const second = await startTestHost(options)
    cleanup.push(() => second.close())
    port = second.host.nativePort!
    workspace.networkChanged()
    await vi.waitFor(() => expect(workspace.checkpoint()!.instanceId).not.toBe(previous))
    expect(workspace.bodyVerifiedUntil()).toBe(0)
    expect(
      request.mock.calls.every(
        ([method, path]) => method === 'GET' && ['/link/api/snapshot', '/link/api/native/revocation'].includes(path),
      ),
    ).toBe(true)
    workspace.close()
    await owner.done
    expect(states.at(-1)).toBe('stopped')
  })
  it('renews an expired presentation after restart while retaining the enrolled identity and inactive view-only policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-native-renewal-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const options = {
      native: { host: '127.0.0.1', port: 0 },
      dataDir: join(directory, 'data'),
      workspaceRoot: join(directory, 'workspace'),
    }
    const first = await startTestHost(options)
    cleanup.push(() => first.close())
    const registered = await pair(first)
    const prior = await verifyDevice(first, registered.client, registered.deviceId, registered.verification.privateKey)
    registered.client.close()
    await first.close()
    const expired = renewDeviceCertificate(registered.clientOptions.key, Date.now() - 7_200_000)
    const file = join(first.dataDir, 'auth/devices.json')
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      devices: Array<{ id: string; native?: { certificate: string; lastVerifiedAt: number } }>
    }
    const enrolled = saved.devices.find(device => device.id === registered.deviceId)!.native!
    enrolled.certificate = expired.cert
    enrolled.lastVerifiedAt = Date.now() - 31 * 86_400_000
    await writeFile(file, JSON.stringify(saved), { mode: 0o600 })
    const second = await startTestHost(options)
    cleanup.push(() => second.close())
    const workspace = new NativeWorkspace({
      ...registered.clientOptions,
      certificate: expired.cert,
      hostId: second.host.hostId,
      deviceId: registered.deviceId,
    })
    cleanup.push(() => workspace.close())
    expect(await workspace.migrate([{ id: 'rejoined-lan', kind: 'direct', address: '127.0.0.1', port: second.host.nativePort! }])).toBe(
      'connected',
    )
    expect(workspace.checkpoint()?.value).toMatchObject({ device: { id: registered.deviceId, scopes: ['view'] } })
    expect(
      (
        await workspace.request('POST', '/link/api/native/verification/resume', {
          appOpenId: prior.appOpenId,
          windowToken: prior.windowToken,
        })
      ).status,
    ).toBe(403)
    expect(
      await workspace.verify(async statement =>
        sign('sha256', Buffer.from(statement), { key: registered.verification.privateKey, dsaEncoding: 'ieee-p1363' }),
      ),
    ).toBe('verified')
    const snapshot = body<{ device: { id: string; scopes: string[] } }>(await workspace.request('GET', '/link/api/snapshot'))
    expect(snapshot.device.id).toBe(registered.deviceId)
    expect(snapshot.device.scopes).toContain('run')
  })
  it('recovers a lost verification acknowledgement through the next authenticated path without signing again', async () => {
    let now = Date.now()
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => now })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const workspace = new NativeWorkspace({ ...registered.clientOptions, hostId: host.host.hostId, deviceId: registered.deviceId })
    cleanup.push(() => workspace.close())
    const paths = [{ id: 'current-lan', kind: 'direct' as const, address: '127.0.0.1', port: host.host.nativePort! }]
    expect(await workspace.migrate(paths)).toBe('connected')
    expect(workspace.checkpoint()?.value).toMatchObject({ device: { id: registered.deviceId } })
    expect((await workspace.request('GET', '/link/api/tasks/missing')).status).toBe(403)
    const request = NativeHttpClient.prototype.request
    let loseVerification = true
    vi.spyOn(NativeHttpClient.prototype, 'request').mockImplementation(async function (this: NativeHttpClient, ...input) {
      const result = await request.apply(this, input)
      if (input[1] === '/link/api/native/verification' && loseVerification) {
        loseVerification = false
        this.close()
        throw new Error('Acknowledgement lost in the fixture')
      }
      return result
    })
    const signStatement = vi.fn(async (statement: string) =>
      sign('sha256', Buffer.from(statement), { key: registered.verification.privateKey, dsaEncoding: 'ieee-p1363' }),
    )
    const verification = workspace.verify(signStatement)
    expect(workspace.verify(signStatement)).toBe(verification)
    expect(await verification).toBe('unknown')
    expect(workspace.bodyVerifiedUntil()).toBe(0)
    workspace.networkChanged()
    expect(await workspace.migrate(paths)).toBe('connected')
    const deadline = workspace.bodyVerifiedUntil()
    expect(deadline).toBe(now + 10 * 60_000)
    expect((await workspace.request('GET', '/link/api/tasks/missing')).status).toBe(404)
    expect(await workspace.verify(signStatement)).toBe('verified')
    expect(signStatement).toHaveBeenCalledOnce()
    const events = workspace.events()
    expect((await events.next()).value).toMatchObject({ type: 'refresh' })
    workspace.networkChanged()
    expect(await workspace.migrate(paths)).toBe('connected')
    expect((await events.next()).done).toBe(true)
    expect(workspace.bodyVerifiedUntil()).toBe(deadline)
    now = deadline + 1
    workspace.networkChanged()
    expect(await workspace.migrate(paths)).toBe('connected')
    expect(workspace.bodyVerifiedUntil()).toBe(0)
    expect((await workspace.request('GET', '/link/api/tasks/missing')).status).toBe(403)
    expect(signStatement).toHaveBeenCalledOnce()
  })
  it('keeps a write outcome unknown across path replacement and never resends it automatically', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const workspace = new NativeWorkspace({ ...registered.clientOptions, hostId: host.host.hostId, deviceId: registered.deviceId })
    cleanup.push(() => workspace.close())
    const path = { id: 'current-lan', kind: 'direct' as const, address: '127.0.0.1', port: host.host.nativePort! }
    expect(await workspace.migrate([path])).toBe('connected')
    const request = NativeHttpClient.prototype.request
    const observed: unknown[] = []
    let loseWrite = true
    vi.spyOn(NativeHttpClient.prototype, 'request').mockImplementation(async function (this: NativeHttpClient, ...input) {
      const result = await request.apply(this, input)
      if (input[1] === '/link/api/tasks/missing/cancel') {
        observed.push(input[2])
        if (loseWrite) {
          loseWrite = false
          this.close()
          throw new Error('Write result unknown')
        }
      }
      return result
    })
    const original = { requestId: 'native_cancel_recovery_001' }
    await expect(workspace.request('POST', '/link/api/tasks/missing/cancel', original)).rejects.toThrow('unknown')
    workspace.networkChanged()
    expect(await workspace.migrate([path])).toBe('connected')
    expect(observed).toEqual([original])
    expect((await workspace.request('POST', '/link/api/tasks/missing/cancel', original)).status).toBe(404)
    expect(observed).toEqual([original, original])
    const wrong = new NativeWorkspace({
      ...registered.clientOptions,
      rootSpki: createTransportCertificate().spki,
      hostId: host.host.hostId,
      deviceId: registered.deviceId,
    })
    cleanup.push(() => wrong.close())
    expect(await wrong.migrate([path])).toBe('unchanged')
    expect(wrong.checkpoint()).toBeUndefined()
  })
  it('discards an old connection snapshot that finishes after another authenticated path is installed', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const workspace = new NativeWorkspace({ ...registered.clientOptions, hostId: host.host.hostId, deviceId: registered.deviceId })
    cleanup.push(() => workspace.close())
    const path = { id: 'current-lan', kind: 'direct' as const, address: '127.0.0.1', port: host.host.nativePort! }
    expect(await workspace.migrate([path])).toBe('connected')
    const instanceId = workspace.checkpoint()!.instanceId
    let release!: () => void,
      observed = false,
      hold = true
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const request = NativeHttpClient.prototype.request
    vi.spyOn(NativeHttpClient.prototype, 'request').mockImplementation(async function (this: NativeHttpClient, ...input) {
      const result = await request.apply(this, input)
      if (input[1] === '/link/api/snapshot' && hold) {
        hold = false
        observed = true
        await gate
        return { ...result, body: { ...(result.body as object), instanceId: 'obsolete-fixture-epoch' } }
      }
      return result
    })
    const old = workspace.refresh()
    await vi.waitFor(() => expect(observed).toBe(true))
    workspace.networkChanged()
    expect(await workspace.migrate([path])).toBe('connected')
    release()
    expect(await old).toBe(false)
    expect(workspace.checkpoint()?.instanceId).toBe(instanceId)
  })
  it('pairs through the private Mac-code confirmation and only exposes session bodies after a signed verification', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    expect((await host.raw('loopback-tcp', 'api/native/pairings', { method: 'POST', body: {} })).status).toBe(401)
    const registered = await pair(host)
    const snapshot = body<{ device: { listener: string }; approvals: unknown[] }>(
      await registered.client.request('GET', '/link/api/snapshot'),
    )
    expect(snapshot.device.listener).toBe('native-direct')
    expect(snapshot.approvals).toEqual([])
    expect((await registered.client.request('GET', '/link/api/tasks/not-a-session')).status).toBe(403)
    expect((await registered.client.request('GET', '/link/api/files/missing')).status).toBe(403)
    expect((await registered.client.request('GET', '/link/api/files/missing/meta')).status).toBe(403)
    expect((await registered.client.request('POST', '/link/api/tasks/missing/files/resolve', { paths: ['notes.md'] })).status).toBe(403)
    expect((await registered.client.request('POST', '/link/api/tasks/missing/files/search', { q: 'notes' })).status).toBe(403)
    expect((await registered.client.request('POST', '/link/api/credentials/challenge', {})).status).toBe(403)
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect((await registered.client.request('GET', '/link/api/tasks/not-a-session')).status).toBe(404)
    expect((await registered.client.request('GET', '/link/api/files/missing')).status).toBe(400)
    expect((await registered.client.request('POST', '/link/api/tasks/missing/files/resolve', { paths: ['notes.md'] })).status).toBe(404)
    expect((await registered.client.request('GET', '/link/api/host-info')).status).toBe(404)
    expect(await readFile(join(host.dataDir, 'auth/devices.json'), 'utf8')).not.toContain(registered.invitation)
    const owner = await host.enroll({ listener: 'unix' })
    expect((await owner.request(`devices/${registered.deviceId}`, { method: 'DELETE' })).status).toBe(200)
    await expect(registered.client.request('GET', '/link/api/snapshot')).rejects.toThrow()
  })
  it('expires body access independently from TLS and keeps an inactive identity in view-only mode until fresh verification', async () => {
    let now = Date.now()
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => now })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    now += 10 * 60_000 + 1
    expect((await registered.client.request('GET', '/link/api/tasks/not-a-session')).status).toBe(403)
    now += 31 * 86_400_000
    const inactive = body<{ device: { scopes: string[] } }>(await registered.client.request('GET', '/link/api/snapshot'))
    expect(inactive.device.scopes).toEqual(['view'])
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    const renewed = body<{ device: { scopes: string[] } }>(await registered.client.request('GET', '/link/api/snapshot'))
    expect(renewed.device.scopes).toContain('run')
  })
  it('keeps relay enrollment in review even when completion changes to the direct path', async () => {
    const host = await startTestHost()
    cleanup.push(() => host.close())
    const origin = 'https://native-fixture.invalid',
      direct = { listener: 'native-direct' as const, origin, remoteAddress: '192.0.2.4' },
      relay = { ...direct, listener: 'native-relay' as const, remoteAddress: '中继路径' }
    const invitation = await host.host.security.enrollments.createInvitation({ listener: 'native-direct', origin }, { listener: 'unix' })
    const certificate = createTransportCertificate(),
      verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrollment = await host.host.security.enrollments.create(
      {
        name: '中继手机',
        publicKey: certificate.spki.toString('base64url'),
        invitation: invitation.code,
        native: {
          certificate: certificate.cert,
          verificationKey: verification.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        },
      },
      relay,
    )
    await vi.waitFor(() => expect(host.host.security.enrollments.status(enrollment.id, direct).status).toBe('approved'))
    const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
      key: createPrivateKey(certificate.key),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    const registered = await host.host.security.enrollments.complete(enrollment.id, signature, direct)
    expect(registered.device).toMatchObject({ listener: 'native-relay', status: 'review', scopes: ['view'] })
  })
  it('retains the native identity and global pause across Host restart while invalidating window receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-native-restart-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const options = {
      native: { host: '127.0.0.1', port: 0 },
      dataDir: join(directory, 'data'),
      workspaceRoot: join(directory, 'workspace'),
    }
    const first = await startTestHost(options)
    cleanup.push(() => first.close())
    const registered = await pair(first),
      receipt = await verifyDevice(first, registered.client, registered.deviceId, registered.verification.privateKey)
    body(await registered.client.request('POST', '/link/api/native/input/pause', {}))
    registered.client.close()
    await first.close()
    const second = await startTestHost(options)
    cleanup.push(() => second.close())
    expect(second.host.hostId).toBe(first.host.hostId)
    const raw = connect(second.host.nativePort!, '127.0.0.1')
    raw.on('error', () => {})
    const resumed = await openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => resumed.close())
    const snapshot = body<{ device: { id: string; scopes: string[] }; host: { native: { inputsPaused: boolean } } }>(
      await resumed.request('GET', '/link/api/snapshot'),
    )
    expect(snapshot.device.id).toBe(registered.deviceId)
    expect(snapshot.device.scopes).toEqual(['view'])
    expect(snapshot.host.native.inputsPaused).toBe(true)
    expect((await resumed.request('POST', '/link/api/native/verification/resume', receipt)).status).toBe(400)
    expect(
      (
        await resumed.request('POST', '/link/api/native/verification/resume', {
          windowToken: receipt.windowToken,
          appOpenId: receipt.appOpenId,
        })
      ).status,
    ).toBe(403)
  })
  it('revokes native descendants when their inviter is revoked', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' }),
      registered = await pair(host, owner)
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect((await host.raw('unix', `api/devices/${owner.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(host.host.security.devices.get(registered.deviceId)).toMatchObject({ status: 'revoked', revokedReason: 'cascade' })
    await expect(registered.client.request('GET', '/link/api/snapshot')).rejects.toThrow()
  })
  it('binds each connection to its app-open receipt and rejects an older opening that verifies late', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const raw = connect(host.host.nativePort!, '127.0.0.1')
    raw.on('error', () => {})
    const second = await openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => second.close())
    const proof = async (client: NativeHttpClient, appOpenId: string) => {
      const challenge = body<{ nonce: string; expiresAt: number }>(
        await client.request('POST', '/link/api/native/verification/challenge', { appOpenId }),
      )
      return sign(
        'sha256',
        Buffer.from(nativeVerificationText(host.host.hostId, registered.deviceId, challenge.nonce, challenge.expiresAt, appOpenId)),
        { key: registered.verification.privateKey, dsaEncoding: 'ieee-p1363' },
      ).toString('base64url')
    }
    const old = await proof(registered.client, 'old-application-open')
    const fresh = await proof(second, 'new-application-open')
    const receipt = body<{ windowToken: string; verifiedUntil: string }>(
      await second.request('POST', '/link/api/native/verification', { signature: fresh }),
    )
    const locked = body<{ device: { native: { bodyVerifiedUntil?: string } } }>(
      await registered.client.request('GET', '/link/api/snapshot'),
    )
    const unlocked = body<{ device: { native: { bodyVerifiedUntil?: string } } }>(await second.request('GET', '/link/api/snapshot'))
    expect(locked.device.native.bodyVerifiedUntil).toBeUndefined()
    expect(unlocked.device.native.bodyVerifiedUntil).toBe(receipt.verifiedUntil)
    expect((await registered.client.request('POST', '/link/api/native/verification', { signature: old })).status).toBe(403)
    expect((await registered.client.request('GET', '/link/api/tasks/missing')).status).toBe(403)
    expect((await second.request('GET', '/link/api/tasks/missing')).status).toBe(404)
    expect(
      (
        await registered.client.request('POST', '/link/api/native/verification/resume', {
          windowToken: receipt.windowToken,
          appOpenId: 'old-application-open',
        })
      ).status,
    ).toBe(403)
    const resumed = body<{ verifiedUntil: string }>(
      await registered.client.request('POST', '/link/api/native/verification/resume', {
        windowToken: receipt.windowToken,
        appOpenId: 'new-application-open',
      }),
    )
    expect(resumed.verifiedUntil).toBe(receipt.verifiedUntil)
    expect((await registered.client.request('GET', '/link/api/tasks/missing')).status).toBe(404)
    await proof(second, 'next-application-open')
    expect(
      (
        await registered.client.request('POST', '/link/api/native/verification/resume', {
          windowToken: receipt.windowToken,
          appOpenId: 'new-application-open',
        })
      ).status,
    ).toBe(403)
  })
  it('allows controlled cancel, plain rejection and global input pause while the body window is locked', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    expect((await registered.client.request('POST', '/link/api/tasks/missing/cancel', { requestId: 'free_cancel_001' })).status).toBe(404)
    expect(
      (
        await registered.client.request('POST', '/link/api/tasks/missing/cancel', {
          requestId: 'free_cancel_002',
          prompt: 'not an input route',
        })
      ).status,
    ).toBe(400)
    expect(
      (await registered.client.request('POST', '/link/api/approvals/missing', { decision: 'reject', requestId: 'free_reject_001' })).status,
    ).toBe(409)
    expect((await registered.client.request('POST', '/link/api/approvals/missing', { decision: 'allow' })).status).toBe(403)
    expect((await registered.client.request('POST', '/link/api/approvals/missing', { decision: 'reject', note: 'new input' })).status).toBe(
      403,
    )
    expect((await registered.client.request('DELETE', '/link/api/devices/current')).status).toBe(403)
    const append = host.host.security.audit.append.bind(host.host.security.audit)
    vi.spyOn(host.host.security.audit, 'append').mockImplementation(event =>
      event.action === 'native.inputs.paused' ? Promise.reject(new Error('audit fixture unavailable')) : append(event),
    )
    const paused = await registered.client.request('POST', '/link/api/native/input/pause', {})
    expect(paused.status).toBe(200)
    expect(paused.headers['x-latch-audit']).toBe('failed')
    const snapshot = body<{ device: { scopes: string[] }; host: { native: { inputsPaused: boolean } } }>(
      await registered.client.request('GET', '/link/api/snapshot'),
    )
    expect(snapshot.host.native.inputsPaused).toBe(true)
    expect(snapshot.device.scopes).toEqual(['view'])
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect((await registered.client.request('POST', '/link/api/native/input/resume', {})).status).toBe(403)
    const owner = await host.enroll({ listener: 'unix' })
    expect((await owner.confirmed('native/input/resume', { method: 'POST', body: {} })).status).toBe(200)
    expect(body<{ device: { scopes: string[] } }>(await registered.client.request('GET', '/link/api/snapshot')).device.scopes).toContain(
      'run',
    )
  })
})
