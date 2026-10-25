import { connect } from 'node:net'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportCertificate, renewDeviceCertificate, NativeWorkspace, openNativeHttp, NativeHttpClient } from '@latch/link-client'
import { knock, nativeKnockSecret, nativeVerificationText, pairingCode } from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import type { TestDevice } from '@latch/testkit'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import type { PresenceBackend } from '../src/presence.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'

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
  it('keeps the old listener until commit and closes a staged replacement during shutdown', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    const native = await startNativeHost({
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
    expect(request.mock.calls.every(([method, path]) => method === 'GET' && path === '/link/api/snapshot')).toBe(true)
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
