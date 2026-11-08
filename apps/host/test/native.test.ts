import { connect } from 'node:net'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import {
  discoveryEpochInput,
  invitationCode,
  knock,
  nativeKnockSecret,
  nativeRevocationInput,
  nativeVerificationText,
  parsePairingPayload,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import type { TestDevice } from '@latch/testkit'
import type { TaskDetail } from '@latch/protocol'
import type { Bridge, HarnessPlugin } from '@latch/sdk'
import type { PresenceBackend } from '../src/presence.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { NativeReplay } from '../src/native-replay.ts'
import { FileDirectoryReader } from '../src/files/directory.ts'
import { buildFilesHelper } from '../scripts/build-files.ts'
import { messageCarrierFixture } from './helpers/message-carrier.ts'
import { connectPluginTransport } from '../src/native-transports.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})
function body<T>(result: { status: number; body: unknown }, status = 200): T {
  expect(result.status).toBe(status)
  return result.body as T
}
const desktops = new WeakMap<TestHost, TestDevice>()
async function desktopOf(host: TestHost): Promise<TestDevice> {
  const known = desktops.get(host)
  if (known) return known
  const desktop = await host.enroll({ listener: 'unix' })
  desktops.set(host, desktop)
  return desktop
}
async function pair(
  host: TestHost,
  inviter?: TestDevice,
  open?: (options: Parameters<typeof openNativeHttp>[2]) => Promise<NativeHttpClient>,
) {
  const sheet = inviter ?? (await desktopOf(host))
  const response = await sheet.request('native/pairings', { method: 'POST', body: {} })
  expect(response.status).toBe(201)
  const { invitation } = (await response.json()) as { invitation: { id: string; payload: string } }
  const payload = parsePairingPayload(invitation.payload),
    code = invitationCode(payload.secret)
  const device = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const knockKey = createHash('sha256').update(code).digest()
  const raw = connect(host.host.nativePort!, '127.0.0.1')
  raw.on('error', () => {})
  const temporary = await openNativeHttp(raw, { path: 'direct' }, { rootSpki: payload.rootSpki, knockKey, pairing: true })
  cleanup.push(() => temporary.close())
  const spy = vi.spyOn(host.presence as PresenceBackend, 'confirm')
  const enrollment = body<{ enrollment: { id: string; nonce: string; status: string } }>(
    await temporary.request('POST', '/link/api/enrollments', {
      name: '原生测试手机',
      publicKey: device.spki.toString('base64url'),
      invitation: code,
      gatewayHash: '0'.repeat(64),
      native: {
        certificate: device.cert,
        verificationKey: verification.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
    }),
    202,
  ).enrollment
  // The Mac's sheet names the phone and asks for no code.
  expect(spy.mock.calls.at(-1)?.[0]).not.toHaveProperty('pairingCode')
  expect(spy.mock.calls.at(-1)?.[0].preview).toMatchObject({
    action: 'device.enroll-native',
    reason: expect.stringMatching(/^允许「原生测试手机(?: \(\d\))?」连接这台 Mac$/u),
  })
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
  // The sheet closes, so the next phone is a new pairing rather than contention.
  const closed = await sheet.request(`native/pairings/${invitation.id}`, { method: 'DELETE' })
  expect(closed.status).toBe(200)
  const nativeRaw = open ? undefined : connect(host.host.nativePort!, '127.0.0.1')
  nativeRaw?.on('error', () => {})
  const clientOptions = {
    rootSpki: payload.rootSpki,
    knockKey: await nodeCrypto.hash(
      await nativeKnockSecret(nodeCrypto, knockKey, device.spki, verification.publicKey.export({ format: 'der', type: 'spki' })),
    ),
    certificate: device.cert,
    key: device.key,
  }
  const client = open ? await open(clientOptions) : await openNativeHttp(nativeRaw!, { path: 'direct' }, clientOptions)
  cleanup.push(() => client.close())
  return { client, deviceId: registered.device.id, verification, invitation: code, invitationInfo: invitation, clientOptions }
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
  it('grants the fixed phone scopes and all data through exactly one confirmation', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' }),
      shown = host.presence.requests.length
    const registered = await pair(host, owner)
    expect(host.presence.requests.slice(shown).map(request => request.preview.action)).toEqual(['device.enroll-native'])
    expect(host.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '数据范围', value: '全部' })
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    const snapshot = body<{
      device: { dataScope: string; status: string; scopes: string[] }
      catalog: { features: { pairingV3?: boolean } }
    }>(await registered.client.request('GET', '/link/api/snapshot'))
    expect(snapshot.device).toMatchObject({
      dataScope: 'all',
      status: 'active',
      scopes: ['view', 'run', 'approve:standard', 'approve:elevated'],
    })
    expect(snapshot.catalog.features.pairingV3).toBe(true)
    const task = body<{ sessionId: string }>(
      await registered.client.request('POST', '/link/api/tasks', {
        mode: 'chat',
        prompt: 'Plan the day',
        requestId: randomUUID(),
      }),
      201,
    )
    await expect
      .poll(async () => body<TaskDetail>(await registered.client.request('GET', '/link/api/tasks/' + task.sessionId)).summary.status)
      .toBe('idle')
    expect(host.presence.requests).toHaveLength(shown + 1)
    expect((await registered.client.request('POST', '/link/api/native/pairings', {})).status).toBe(403)
  })

  it('binds a pending configuration to its original native opening and never replays it after a new window', async () => {
    let time = Date.now(),
      value = 'low',
      entered = false,
      changes = 0,
      release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => time })
    cleanup.push(() => host.close())
    cleanup.push(() => release())
    const owner = await host.enroll({ listener: 'unix' }),
      registered = await pair(host),
      id = 'task-native-config-window'
    const summary: TaskDetail['summary'] = {
      harnessId: 'standard',
      id,
      title: 'Native config fixture',
      status: 'idle',
      updatedAt: new Date(time).toISOString(),
      cwd: host.workspaceRoot,
      mode: 'agent',
    }
    const bridge: Bridge = {
      async start() {},
      async close() {},
      async listTasks() {
        return [summary]
      },
      async detail() {
        return {
          summary,
          messages: [],
          approvals: [],
          liveText: '',
          cursor: 0,
          config: [
            {
              id: 'effort',
              name: 'Effort',
              type: 'select',
              currentValue: value,
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        }
      },
      async createTask() {
        return { sessionId: id }
      },
      async prompt() {},
      async cancel() {},
      approvals() {
        return []
      },
      async decide() {
        return false
      },
      subscribe() {
        return () => {}
      },
      async classifyConfigChange() {
        return 'neutral'
      },
      async setConfig(_id, _config, next, options) {
        entered = true
        await gate
        options?.authorize?.()
        value = next
        changes++
      },
    }
    // A private test-only built-in mounting seam supplies an L1 config implementation; actual ACPs remain L3.
    await host.host.bridge.detach('standard')
    await host.host.bridge.attach(
      { id: 'standard', name: 'fixture', version: '1', capabilities: { permission: { enforcement: 'latch' } }, create: () => bridge },
      { kind: 'builtin', create: () => bridge, release() {} },
    )
    const path = `/link/api/tasks/${id}`,
      request = { requestId: randomUUID(), configId: 'effort', value: 'high' }
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    const pending = registered.client.request('POST', path + '/config', request)
    await expect.poll(() => entered).toBe(true)
    const renewed = await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    release()
    expect((await pending).status).toBe(503)
    expect(changes).toBe(0)
    expect(body(await registered.client.request('GET', path + '/config-requests/' + request.requestId))).toEqual({ state: 'unknown' })
    expect((await registered.client.request('POST', path + '/config', request)).status).toBe(503)
    expect(changes).toBe(0)
    time = Date.parse(renewed.verifiedUntil) + 1
    expect((await registered.client.request('GET', path + '/config-requests/' + request.requestId)).status).toBe(403)
    expect(await owner.json(path.slice('/link/api/'.length) + '/config-requests/' + request.requestId)).toEqual({ state: 'unknown' })
  })

  it('runs the shipped local MessagePort example through the shared native consumer', async () => {
    const module = (await import(pathToFileURL(resolve('examples/message-port/host.mjs')).href)) as {
        default: HarnessPlugin
        descriptor: import('@latch/sdk').TransportDescriptor
      },
      host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, plugins: [module.default] })
    cleanup.push(() => host.close())
    const managed: Array<Awaited<ReturnType<typeof connectPluginTransport>>> = []
    cleanup.push(async () => {
      for (const connection of managed) await connection.close()
    })
    const registered = await pair(host, undefined, async identity => {
      const connection = await connectPluginTransport(host.host.registry, module.descriptor, identity)
      managed.push(connection)
      return connection.client
    })
    expect(body<{ device: { status: string } }>(await registered.client.request('GET', '/link/api/snapshot')).device.status).toBe('active')
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect((await registered.client.request('POST', '/link/api/native/address-book', {})).status).toBe(200)
    await host.host.registry.disable(module.default.id)
    await Promise.all(managed.map(connection => connection.closed))
    expect(registered.client.isClosed()).toBe(true)
  })
  it('keeps plugin listeners closed until native is configured', async () => {
    const fixture = messageCarrierFixture(),
      host = await startTestHost({
        plugins: [
          {
            id: 'custom-message',
            name: 'Custom message',
            version: '1',
            description: 'Fixture',
            activate(context) {
              context.registerTransport(fixture.driver)
            },
          },
        ],
      })
    cleanup.push(() => host.close())
    expect(fixture.listen).not.toHaveBeenCalled()
    expect(host.host.registry.list().find(plugin => plugin.id === 'custom-message')?.capabilities).toEqual([
      'transport:interactive-fixture',
    ])
  })
  it('consumes a custom reliable message plugin through real TLS and the body window, then closes it on retirement', async () => {
    let started = 0
    const fixture = messageCarrierFixture(),
      host = await startTestHost({
        native: { host: '127.0.0.1', port: 0 },
        plugins: [
          {
            id: 'custom-message',
            name: 'Custom message',
            version: '1',
            description: 'Fixture',
            activate(context) {
              context.registerTransport(fixture.driver)
              context.registerProvider({
                id: 'carrier-wait',
                name: 'Carrier wait fixture',
                model: 'wait',
                async *stream({ signal }) {
                  started++
                  yield { type: 'text', text: 'Carrier running' }
                  await new Promise<void>(resolve => {
                    if (signal.aborted) resolve()
                    else signal.addEventListener('abort', () => resolve(), { once: true })
                  })
                },
              })
            },
          },
        ],
      })
    cleanup.push(() => host.close())
    await vi.waitFor(() => expect(fixture.listen).toHaveBeenCalledTimes(1))
    const managed: Array<Awaited<ReturnType<typeof connectPluginTransport>>> = []
    cleanup.push(async () => {
      for (const connection of managed) await connection.close()
    })
    const registered = await pair(host, undefined, async identity => {
      const connection = await connectPluginTransport(host.host.registry, fixture.descriptor, identity)
      managed.push(connection)
      return connection.client
    })
    const snapshot = body<{ device: { status: string; scopes: string[] } }>(await registered.client.request('GET', '/link/api/snapshot'))
    expect(snapshot.device).toMatchObject({ status: 'active', scopes: ['view', 'run', 'approve:standard', 'approve:elevated'] })
    const task = await host.host.bridge.createTask({ prompt: 'carrier body fixture', mode: 'chat', requestId: randomUUID() })
    expect((await registered.client.request('GET', `/link/api/tasks/${task.sessionId}`)).status).toBe(403)
    await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
    expect((await registered.client.request('GET', `/link/api/tasks/${task.sessionId}`)).status).toBe(200)
    const input = {
        prompt: 'one carrier run',
        mode: 'chat',
        requestId: randomUUID(),
        model: { providerId: 'carrier-wait', model: 'wait' },
      },
      created = body<{ sessionId: string }>(await registered.client.request('POST', '/link/api/tasks', input), 201),
      replay = await registered.client.request('POST', '/link/api/tasks', input)
    expect(replay.status).toBe(201)
    expect((replay.body as { sessionId: string }).sessionId).toBe(created.sessionId)
    await vi.waitFor(() => expect(started).toBe(1))
    const cancellation = { requestId: randomUUID() },
      cancelled = await registered.client.request('POST', `/link/api/tasks/${created.sessionId}/cancel`, cancellation)
    expect(cancelled.status).toBe(200)
    const cancellationReplay = body<{ accepted: boolean; receipt: object }>(
      await registered.client.request('POST', `/link/api/tasks/${created.sessionId}/cancel`, cancellation),
    )
    expect(cancellationReplay).toEqual({ accepted: true, receipt: { ...(cancelled.body as { receipt: object }).receipt, replay: true } })
    expect(body<TaskDetail>(await registered.client.request('GET', `/link/api/tasks/${created.sessionId}`)).summary.runOutcome).toBe(
      'cancelled',
    )
    host.host.registry.retire('custom-message')
    expect(() => host.host.registry.acquireTransport(fixture.descriptor.driverId)).toThrow('请先安装')
    await vi.waitFor(() => expect(registered.client.isClosed()).toBe(true))
    await Promise.all(managed.map(connection => connection.closed))
  })
  it('consumes empty GET request streams and closes a GET payload without deleting the enrolled identity', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const registered = await pair(host)
    await expect(registered.client.request('GET', '/link/api/snapshot', { unexpected: true })).rejects.toThrow()
    const raw = connect(host.host.nativePort!, '127.0.0.1')
    raw.on('error', () => {})
    const fresh = await openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => fresh.close())
    expect(body<{ device: { id: string } }>(await fresh.request('GET', '/link/api/snapshot')).device.id).toBe(registered.deviceId)
  })
  it.skipIf(process.platform !== 'darwin')(
    'keeps directory names behind the body window and discards a listing when its original window expires',
    async () => {
      await buildFilesHelper()
      let time = Date.now()
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => time })
      cleanup.push(() => host.close())
      const owner = await host.enroll({ listener: 'unix' }),
        registered = await pair(host)
      expect((await owner.confirmed(`devices/${registered.deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await writeFile(join(host.workspaceRoot, 'never-unverified.txt'), 'private body')
      const task = await host.host.bridge.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
      const path = `/link/api/tasks/${task.sessionId}/files`
      expect((await registered.client.request('GET', `${path}/list?rootId=default`)).status).toBe(403)
      expect((await registered.client.request('POST', `${path}/resolve`, { paths: ['never-unverified.txt'] })).status).toBe(403)
      const receipt = await verifyDevice(host, registered.client, registered.deviceId, registered.verification.privateKey)
      expect(JSON.stringify(body(await registered.client.request('GET', `${path}/list?rootId=default`)))).toContain('never-unverified.txt')
      let entered!: () => void, release!: () => void
      const arrived = new Promise<void>(done => {
          entered = done
        }),
        barrier = new Promise<void>(done => {
          release = done
        })
      const original = FileDirectoryReader.prototype.list
      vi.spyOn(FileDirectoryReader.prototype, 'list').mockImplementationOnce(async function (this: FileDirectoryReader, input) {
        const result = await original.call(this, input)
        entered()
        await barrier
        return result
      })
      const pending = registered.client.request('GET', `${path}/list?rootId=default`).catch(() => undefined)
      await arrived
      time = Date.parse(receipt.verifiedUntil) + 1
      release()
      const result = await pending
      if (result) {
        expect(result.status).toBe(403)
        expect(JSON.stringify(result.body)).not.toContain('never-unverified')
      }
    },
  )
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
  it('parks original App window queues and hides bodies from unverified snapshots', async () => {
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
    await expect(native.invite({}, { listener: 'host' })).rejects.toMatchObject({ code: 'native-no-lan' })
    const disabled = await native.prepareBind(undefined)
    disabled.commit()
    expect(native.port).toBeUndefined()
  })
  it('replays real missed task projections across a new authenticated path without letting a list checkpoint skip body events', async () => {
    let notify: (id?: string) => void = () => {}
    let exists = true
    let currentTime = Date.now()
    const detail: TaskDetail = {
      summary: { harnessId: 'standard', id: 'replay-fixture', title: 'Replay fixture', status: 'idle', updatedAt: '2026-10-25' },
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
  it('keeps at most two pairing QRs live even when local requests arrive before the first audit settles', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanup.push(() => host.close())
    const desktop = await desktopOf(host)
    const responses = await Promise.all(Array.from({ length: 5 }, () => desktop.request('native/pairings', { method: 'POST', body: {} })))
    expect(responses.filter(item => item.status === 201)).toHaveLength(5)
    expect(host.host.security.enrollments.nativeInvitations()).toHaveLength(2)
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
  it('pairs through one confirmation on the Mac and only exposes session bodies after a signed verification', async () => {
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
  it('retains the native identity across Host restart while invalidating window receipts', async () => {
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
    registered.client.close()
    await first.close()
    const second = await startTestHost(options)
    cleanup.push(() => second.close())
    expect(second.host.hostId).toBe(first.host.hostId)
    const raw = connect(second.host.nativePort!, '127.0.0.1')
    raw.on('error', () => {})
    const resumed = await openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => resumed.close())
    const snapshot = body<{ device: { id: string; scopes: string[] } }>(await resumed.request('GET', '/link/api/snapshot'))
    expect(snapshot.device.id).toBe(registered.deviceId)
    expect(snapshot.device.scopes).toContain('run')
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
  it('allows controlled cancel, plain rejection and removing itself while the body window is locked', async () => {
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
    // Removing itself needs no window. The connection closes with the revocation; the next one reads the tombstone.
    await registered.client.request('DELETE', '/link/api/devices/current').catch(() => {})
    expect(host.host.security.devices.get(registered.deviceId)?.status).toBe('revoked')
    const raw = connect(host.host.nativePort!, '127.0.0.1')
    raw.on('error', () => {})
    const again = await openNativeHttp(raw, { path: 'direct' }, registered.clientOptions)
    cleanup.push(() => again.close())
    expect(body<{ revocation: { deviceId: string } }>(await again.request('GET', '/link/api/native/revocation')).revocation.deviceId).toBe(
      registered.deviceId,
    )
  })
})
