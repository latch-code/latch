import { connect } from 'node:net'
import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportCertificate, openNativeHttp, type NativeHttpClient } from '@latch/link-client'
import { nodeCrypto } from '@latch/link-client/crypto'
import { invitationCode, nativeKnockSecret, nativeVerificationText, parsePairingPayload } from '@latch/link-wire'
import { testDeviceKey, type TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ADMIN = ['view', 'run', 'approve:standard', 'admin'] as const
const UNKNOWN_DEVICE = `dev_${'Z'.repeat(22)}`
const UNKNOWN_ENROLLMENT = `enr_${'Z'.repeat(22)}`

type Outcome = [status: number, error?: string]
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
/** A route as each caller sends it, with the status and error code that caller gets. */
type Row<Caller extends string> = [method: Method, path: string, body: unknown, expected: Partial<Record<Caller, Outcome>>]

function outcomeOf(status: number, body: unknown): Outcome {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  return typeof error === 'string' ? [status, error] : [status]
}

async function responseOutcome(response: Response): Promise<Outcome> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return outcomeOf(response.status, parsed)
}

/** A phone paired through the native entry the way the App pairs, with its pairing opening still open. */
async function pairPhone(t: TestHost) {
  const created = await (await t.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
  expect(created.status).toBe(201)
  const { invitation } = (await created.json()) as { invitation: { payload: string } }
  const payload = parsePairingPayload(invitation.payload),
    code = invitationCode(payload.secret)
  const rootSpki = payload.rootSpki
  const knockKey = createHash('sha256').update(code).digest()
  const device = createTransportCertificate()
  const verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const verificationSpki = verification.publicKey.export({ format: 'der', type: 'spki' })
  const open = async (options: Parameters<typeof openNativeHttp>[2]): Promise<NativeHttpClient> => {
    const socket = connect(t.host.nativePort!, '127.0.0.1')
    socket.on('error', () => {})
    const client = await openNativeHttp(socket, { path: 'direct' }, options)
    cleanups.push(() => client.close())
    return client
  }
  const pairing = await open({ rootSpki, knockKey, pairing: true })
  return {
    pairing,
    async enroll() {
      const answer = await pairing.request('POST', '/link/api/enrollments', {
        name: '守卫测试手机',
        publicKey: device.spki.toString('base64url'),
        invitation: code,
        gatewayHash: '0'.repeat(64),
        native: { certificate: device.cert, verificationKey: verificationSpki.toString('base64url') },
      })
      expect(answer.status).toBe(202)
      const { enrollment } = answer.body as { enrollment: { id: string; nonce: string } }
      await vi.waitFor(async () => {
        const status = await pairing.request('GET', `/link/api/enrollments/${enrollment.id}`)
        expect((status.body as { enrollment: { status: string } }).enrollment.status).toBe('approved')
      })
      const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${t.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
        key: createPrivateKey(device.key),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
      const completed = await pairing.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature })
      expect(completed.status).toBe(200)
      const deviceId = (completed.body as { device: { id: string } }).device.id
      const phone = await open({
        rootSpki,
        knockKey: await nodeCrypto.hash(await nativeKnockSecret(nodeCrypto, knockKey, device.spki, verificationSpki)),
        certificate: device.cert,
        key: device.key,
      })
      return { phone, deviceId, verificationKey: verification.privateKey }
    },
  }
}

async function verifyPhone(t: TestHost, phone: NativeHttpClient, deviceId: string, key: KeyObject): Promise<void> {
  const challenge = (await phone.request('POST', '/link/api/native/verification/challenge', { appOpenId: 'route-guard-open-0001' }))
    .body as { nonce: string; appOpenId: string; expiresAt: number }
  const text = nativeVerificationText(t.host.hostId, deviceId, challenge.nonce, challenge.expiresAt, challenge.appOpenId)
  const signature = sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  expect((await phone.request('POST', '/link/api/native/verification', { signature })).status).toBe(200)
}

describe('route guards', () => {
  it('keeps every terminal route from a verified phone on the native entry', async () => {
    const t = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanups.push(() => t.close())
    const { phone, deviceId, verificationKey } = await (await pairPhone(t)).enroll()
    await verifyPhone(t, phone, deviceId, verificationKey)
    const base = '/link/api/tasks/session/terminals'
    const routes: Array<[Method, string, unknown?]> = [
      ['GET', base],
      ['POST', base, { cols: 80, rows: 24 }],
      ['GET', `${base}/term/stream`],
      ['POST', `${base}/term/input`, { data: 'bHM=' }],
      ['POST', `${base}/term/resize`, { cols: 80, rows: 24 }],
      ['POST', `${base}/term/attach`, {}],
      ['POST', `${base}/term/close`, {}],
    ]
    for (const [method, path, body] of routes) {
      const answer = await phone.request(method, path, body)
      expect([path, outcomeOf(answer.status, answer.body)]).toEqual([path, [403, 'local-only']])
    }
    const snapshot = await phone.request('GET', '/link/api/snapshot')
    expect((snapshot.body as { catalog: { features: { terminal?: boolean } } }).catalog.features.terminal).toBeUndefined()
  })

  it('keeps every device, enrollment, pairing and native route to its listeners and scopes', async () => {
    const t = await startTestHost({ tls: true, native: { host: '127.0.0.1', port: 0 } })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const member = await t.enroll({ listener: 'unix', name: 'Member', scopes: ['view', 'run'] })
    const viewer = await t.enroll({ name: 'Viewer', scopes: ['view'] })
    const browser = await t.enroll({ name: 'Browser', scopes: [...ADMIN] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: [...ADMIN] })
    const devices: Record<string, TestDevice> = { desktop, member, viewer, browser, phone }
    type Caller = 'anonymous' | 'loopback' | 'tls' | 'desktop' | 'member' | 'viewer' | 'browser' | 'phone'
    const call = (caller: Caller, method: Method, path: string, body: unknown): Promise<Response> => {
      const init = { method, ...(body === undefined ? {} : { body }) }
      if (caller === 'anonymous') return t.raw('unix', `api/${path}`, init)
      if (caller === 'loopback') return t.raw('loopback-tcp', `api/${path}`, init)
      if (caller === 'tls') return t.raw('tls', `api/${path}`, init)
      return devices[caller]!.request(path, init)
    }
    const raise = { scopes: ['view', 'run'] }
    const rows: Array<Row<Caller>> = [
      ['POST', 'login', {}, { loopback: [410, 'login-removed'], browser: [410, 'login-removed'] }],
      ['POST', 'pair', {}, { tls: [410, 'login-removed'] }],
      ['GET', 'enrollment-info', undefined, { anonymous: [200], loopback: [200], tls: [200] }],
      [
        'POST',
        'host-proof',
        { nonce: 'n'.repeat(22) },
        { anonymous: [404, 'not-found'], loopback: [404, 'not-found'], tls: [200], browser: [404, 'not-found'] },
      ],
      ['POST', 'host-proof', { nonce: 'short' }, { tls: [400, 'invalid-input'] }],
      [
        'POST',
        'enrollment-invitation',
        { invitation: 'lpi1-AAAAAAAAAAAAAAAAAAAAAAAAAA' },
        { anonymous: [403, 'invitation-invalid'], loopback: [403, 'invitation-invalid'], tls: [403, 'invitation-invalid'] },
      ],
      [
        'POST',
        'enrollments',
        { publicKey: testDeviceKey().spki, name: 'x' },
        { loopback: [403, 'invitation-required'], tls: [403, 'invitation-required'], browser: [403, 'invitation-required'] },
      ],
      [
        'GET',
        `enrollments/${UNKNOWN_ENROLLMENT}`,
        undefined,
        { loopback: [404, 'enrollment-not-found'], anonymous: [404, 'enrollment-not-found'] },
      ],
      ['GET', `enrollments/${'e'.repeat(65)}`, undefined, { loopback: [404, 'enrollment-not-found'] }],
      ['DELETE', `enrollments/${UNKNOWN_ENROLLMENT}`, undefined, { tls: [404, 'enrollment-not-found'] }],
      [
        'POST',
        `enrollments/${UNKNOWN_ENROLLMENT}/prepare`,
        { signature: 'x' },
        { anonymous: [401, 'unauthorized'], tls: [401, 'unauthorized'] },
      ],
      ['POST', `enrollments/${UNKNOWN_ENROLLMENT}/complete`, { signature: 'x' }, { loopback: [404, 'enrollment-not-found'] }],
      ['GET', 'credentials/challenge', undefined, { browser: [404, 'not-found'] }],
      ['POST', 'credentials/challenge', {}, { anonymous: [401, 'unauthorized'], loopback: [401, 'unauthorized'] }],
      ['POST', 'credentials/renew', { nonce: 'x', signature: 'x' }, { anonymous: [401, 'unauthorized'], tls: [401, 'unauthorized'] }],
      ['GET', 'devices/current', undefined, { anonymous: [401, 'unauthorized'], viewer: [404, 'not-found'] }],
      ['PATCH', 'devices/current', { name: 'x' }, { anonymous: [401, 'unauthorized'], loopback: [401, 'unauthorized'] }],
      ['DELETE', 'devices/current', undefined, { anonymous: [401, 'unauthorized'] }],
      [
        'GET',
        'devices',
        undefined,
        {
          anonymous: [200],
          loopback: [401, 'unauthorized'],
          viewer: [403, 'scope-required'],
          member: [403, 'scope-required'],
          browser: [200],
        },
      ],
      [
        'DELETE',
        `devices/${UNKNOWN_DEVICE}`,
        undefined,
        {
          anonymous: [404, 'device-not-found'],
          loopback: [401, 'unauthorized'],
          viewer: [403, 'scope-required'],
          member: [403, 'scope-required'],
          browser: [404, 'device-not-found'],
        },
      ],
      ['DELETE', `devices/${browser.id}`, undefined, { browser: [409, 'current-device'] }],
      [
        'PATCH',
        `devices/${viewer.id}`,
        raise,
        {
          anonymous: [401, 'unauthorized'],
          viewer: [403, 'scope-required'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
        },
      ],
      ['PATCH', `devices/${viewer.id}`, { scopes: ['view', 'secrets'] }, { desktop: [400, 'scope-not-grantable'] }],
      [
        'GET',
        'enrollments',
        undefined,
        {
          anonymous: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          desktop: [200],
        },
      ],
      [
        'POST',
        'pairings',
        {},
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [201],
        },
      ],
      [
        'GET',
        'native/info',
        undefined,
        { member: [403, 'scope-required'], browser: [403, 'local-only'], phone: [403, 'local-only'], anonymous: [200] },
      ],
      [
        'POST',
        'native/pairings',
        {},
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      [
        'GET',
        `native/pairings/inv_${'A'.repeat(22)}`,
        undefined,
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      [
        'DELETE',
        `native/pairings/inv_${'A'.repeat(22)}`,
        undefined,
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      [
        'DELETE',
        `native/pairings/inv_${'A'.repeat(22)}/device`,
        undefined,
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      [
        'DELETE',
        'native/directory',
        undefined,
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      [
        'DELETE',
        `native/relays/${'a'.repeat(32)}`,
        undefined,
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      [
        'PATCH',
        `devices/${UNKNOWN_DEVICE}/name`,
        { name: '新名字' },
        {
          loopback: [401, 'unauthorized'],
          member: [403, 'scope-required'],
          browser: [403, 'local-only'],
          phone: [403, 'local-only'],
          anonymous: [401, 'unauthorized'],
        },
      ],
      ['GET', 'native/pairing', undefined, { anonymous: [401, 'unauthorized'], browser: [401, 'unauthorized'] }],
      ['GET', 'native/revocation', undefined, { anonymous: [401, 'unauthorized'], browser: [404, 'not-found'] }],
      ['POST', 'native/revocation/ack', {}, { browser: [404, 'not-found'] }],
      ['POST', 'native/bulk', {}, { anonymous: [401, 'unauthorized'], browser: [401, 'unauthorized'] }],
      ['POST', 'native/address-book', {}, { anonymous: [401, 'unauthorized'], phone: [401, 'unauthorized'] }],
      ['POST', 'native/proximity', { gatewayHash: '0'.repeat(64) }, { anonymous: [401, 'unauthorized'], browser: [404, 'not-found'] }],
      ['POST', 'native/verification/challenge', { appOpenId: 'route-guard-open-0001' }, { browser: [404, 'not-found'] }],
      ['POST', 'native/verification', { signature: 'x' }, { phone: [404, 'not-found'] }],
      ['POST', 'native/verification/recover', {}, { browser: [404, 'not-found'] }],
      ['POST', 'native/verification/resume', {}, { browser: [404, 'not-found'] }],
    ]
    const results: Record<string, Outcome> = {}
    const expected: Record<string, Outcome> = {}
    for (const [method, path, body, outcomes] of rows)
      for (const [caller, outcome] of Object.entries(outcomes) as Array<[Caller, Outcome]>) {
        const key = `${caller} ${method} /link/api/${path}`
        expected[key] = outcome
        results[key] = await responseOutcome(await call(caller, method, path, body))
      }
    expect(results).toEqual(expected)
  })

  it('keeps every handoff route to its scopes: reading takes view, every change run', async () => {
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const viewer = await t.enroll({ name: 'Viewer', scopes: ['view'] })
    const member = await t.enroll({ listener: 'unix', name: 'Member', scopes: ['view', 'run'] })
    const devices: Record<string, TestDevice> = { viewer, member }
    type Caller = 'anonymous' | 'viewer' | 'member'
    const call = (caller: Caller, method: Method, path: string, body: unknown): Promise<Response> => {
      const init = { method, ...(body === undefined ? {} : { body }) }
      return caller === 'anonymous' ? t.raw('unix', `api/${path}`, init) : devices[caller]!.request(path, init)
    }
    const unknown = `handoffs/hof_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`
    const rows: Array<Row<Caller>> = [
      [
        'GET',
        'handoffs?sessionId=none',
        undefined,
        { anonymous: [401, 'unauthorized'], viewer: [404, 'task-not-found'], member: [404, 'task-not-found'] },
      ],
      ['GET', 'handoffs', undefined, { viewer: [400, 'invalid-input'] }],
      ['POST', 'handoffs', {}, { anonymous: [401, 'unauthorized'], viewer: [403, 'scope-required'], member: [400, 'invalid-input'] }],
      ['PUT', 'handoffs', {}, { member: [404, 'not-found'] }],
      ['GET', unknown, undefined, { anonymous: [401, 'unauthorized'], viewer: [404, 'handoff-not-found'] }],
      ['GET', 'handoffs/hof_bad', undefined, { viewer: [404, 'not-found'] }],
      [
        'POST',
        `${unknown}/return`,
        { requestId: 'return-request-01', summary: 'x', evidence: [] },
        { anonymous: [401, 'unauthorized'], viewer: [403, 'scope-required'], member: [404, 'handoff-not-found'] },
      ],
      [
        'POST',
        `${unknown}/withdraw`,
        { requestId: 'withdraw-request' },
        { anonymous: [401, 'unauthorized'], viewer: [403, 'scope-required'], member: [404, 'handoff-not-found'] },
      ],
    ]
    const results: Record<string, Outcome> = {}
    const expected: Record<string, Outcome> = {}
    for (const [method, path, body, outcomes] of rows)
      for (const [caller, outcome] of Object.entries(outcomes) as Array<[Caller, Outcome]>) {
        const key = `${caller} ${method} /link/api/${path}`
        expected[key] = outcome
        results[key] = await responseOutcome(await call(caller, method, path, body))
      }
    expect(results).toEqual(expected)
  })

  it('keeps every history route to run and data scope all, before reading anything', async () => {
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const viewer = await t.enroll({ name: 'Viewer', scopes: ['view'] })
    const member = await t.enroll({ listener: 'unix', name: 'Member', scopes: ['view', 'run'] })
    const work = await t.enroll({ listener: 'loopback-tcp', name: 'Work', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(work.id, { dataScope: 'work' }, { listener: 'unix' }, 'lpc-local')
    const devices: Record<string, TestDevice> = { viewer, member, work }
    type Caller = 'anonymous' | 'viewer' | 'member' | 'work'
    const call = (caller: Caller, method: Method, path: string, body: unknown): Promise<Response> => {
      const init = { method, ...(body === undefined ? {} : { body }) }
      return caller === 'anonymous' ? t.raw('unix', `api/${path}`, init) : devices[caller]!.request(path, init)
    }
    const denied: Partial<Record<Caller, Outcome>> = {
      anonymous: [401, 'unauthorized'],
      viewer: [403, 'scope-required'],
      work: [403, 'history-scope'],
    }
    const rows: Array<Row<Caller>> = [
      ['GET', 'history/sources', undefined, { ...denied, member: [200] }],
      ['GET', 'history/sources?projectId=missing', undefined, { member: [409, 'workspace-unavailable'] }],
      ['POST', 'history/list', {}, { ...denied, member: [400, 'invalid-input'] }],
      ['POST', 'history/list', { projectId: 'missing', harnessId: 'codex' }, { member: [409, 'workspace-unavailable'] }],
      ['POST', 'history/previews', {}, { ...denied, member: [400, 'invalid-input'] }],
      ['POST', 'history/previews', { handle: `hh_${'0'.repeat(32)}` }, { member: [410, 'history-handle-expired'] }],
      ['POST', 'history/imports', { requestId: 'import-request-01' }, { ...denied, member: [400, 'invalid-input'] }],
      ['GET', 'history/imports/import-request-01', undefined, { ...denied, member: [404, 'history-import-not-found'] }],
      [
        'DELETE',
        `history/previews/hp_${'0'.repeat(32)}`,
        undefined,
        { anonymous: [401, 'unauthorized'], viewer: [403, 'scope-required'], member: [204] },
      ],
      ['PUT', 'history/list', {}, { member: [404, 'not-found'] }],
    ]
    const results: Record<string, Outcome> = {}
    const expected: Record<string, Outcome> = {}
    for (const [method, path, body, outcomes] of rows)
      for (const [caller, outcome] of Object.entries(outcomes) as Array<[Caller, Outcome]>) {
        const key = `${caller} ${method} /link/api/${path}`
        expected[key] = outcome
        results[key] = await responseOutcome(await call(caller, method, path, body))
      }
    expect(results).toEqual(expected)
  })

  it('keeps every plugin page route to its scopes: reading takes view, every change run, before any page check', async () => {
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const viewer = await t.enroll({ name: 'Viewer', scopes: ['view'] })
    const member = await t.enroll({ listener: 'unix', name: 'Member', scopes: ['view', 'run'] })
    const devices: Record<string, TestDevice> = { viewer, member }
    type Caller = 'anonymous' | 'viewer' | 'member'
    const call = (caller: Caller, method: Method, path: string, body: unknown): Promise<Response> => {
      const init = { method, ...(body === undefined ? {} : { body }) }
      return caller === 'anonymous' ? t.raw('unix', `api/${path}`, init) : devices[caller]!.request(path, init)
    }
    const revision = 'a'.repeat(64)
    const via = { app: 'p/main', revision }
    const page = `app=p%2Fmain&revision=${revision}`
    const requestId = '00000000-0000-4000-8000-000000000000'
    const rows: Array<Row<Caller>> = [
      ['GET', `apps/p/data?scope=plugin&${page}`, undefined, { anonymous: [401, 'unauthorized'], viewer: [404, 'app-not-found'] }],
      ['GET', `apps/p/data/status?${page}`, undefined, { viewer: [404, 'app-not-found'] }],
      ['GET', `apps/p/data/plugin/k?${page}`, undefined, { viewer: [404, 'app-not-found'] }],
      [
        'PUT',
        'apps/p/data/plugin/k',
        { via, requestId, ifVersion: 0, value: 1 },
        { anonymous: [401, 'unauthorized'], viewer: [403, 'scope-required'], member: [404, 'app-not-found'] },
      ],
      [
        'DELETE',
        'apps/p/data/plugin/k',
        { via, requestId, ifVersion: 1 },
        { viewer: [403, 'scope-required'], member: [404, 'app-not-found'] },
      ],
      ['POST', 'apps/p/data/migrate/lease', { via }, { viewer: [403, 'scope-required'], member: [404, 'app-not-found'] }],
      [
        'POST',
        'apps/p/data/migrate',
        { via, requestId, lease: 'A'.repeat(22), fromGeneration: 1, toVersion: 2, documents: [] },
        { viewer: [403, 'scope-required'], member: [404, 'app-not-found'] },
      ],
      ['GET', `apps/p/diagnostics?${page}`, undefined, { anonymous: [401, 'unauthorized'], viewer: [404, 'app-not-found'] }],
      ['POST', 'apps/p/diagnostics', { via, source: 'runtime', message: 'x' }, { viewer: [404, 'app-not-found'] }],
      ['GET', `apps/p/pages/main/lookup/${requestId}?revision=${revision}`, undefined, { viewer: [404, 'app-not-found'] }],
      ['GET', `apps/p/pages/main/sessions/s/last-reply?revision=${revision}`, undefined, { viewer: [404, 'app-not-found'] }],
      ['GET', 'apps/p/elsewhere', undefined, { viewer: [404, 'not-found'] }],
      [
        'POST',
        'tasks',
        { via, requestId, prompt: 'x' },
        { anonymous: [401, 'unauthorized'], viewer: [403, 'scope-required'], member: [404, 'app-not-found'] },
      ],
      ['POST', 'tasks/s/prompt', { via, requestId, prompt: 'x' }, { viewer: [403, 'scope-required'], member: [404, 'app-not-found'] }],
    ]
    const results: Record<string, Outcome> = {}
    const expected: Record<string, Outcome> = {}
    for (const [method, path, body, outcomes] of rows)
      for (const [caller, outcome] of Object.entries(outcomes) as Array<[Caller, Outcome]>) {
        const key = `${caller} ${method} /link/api/${path}`
        expected[key] = outcome
        results[key] = await responseOutcome(await call(caller, method, path, body))
      }
    expect(results).toEqual(expected)
  })

  it('keeps native openings to pairing, their verification window and the routes a phone may use', async () => {
    const t = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    cleanups.push(() => t.close())
    const viewer = await t.enroll({ name: 'Viewer', scopes: ['view'] })
    const paired = await pairPhone(t)
    const results: Record<string, Outcome> = {}
    const expected: Record<string, Outcome> = {}
    const check = async (stage: string, client: NativeHttpClient, rows: Array<Row<'phone'>>) => {
      for (const [method, path, body, outcomes] of rows) {
        const key = `${stage} ${method} /link/api/${path}`
        expected[key] = outcomes.phone!
        const answer = await client.request(method, `/link/api/${path}`, body)
        results[key] = outcomeOf(answer.status, answer.body)
      }
    }
    await check('pairing', paired.pairing, [
      ['GET', 'native/pairing', undefined, { phone: [200] }],
      ['GET', 'health', undefined, { phone: [401, 'unauthorized'] }],
      ['GET', 'devices', undefined, { phone: [401, 'unauthorized'] }],
      ['POST', 'credentials/challenge', {}, { phone: [401, 'unauthorized'] }],
      ['GET', `enrollments/${UNKNOWN_ENROLLMENT}`, undefined, { phone: [401, 'unauthorized'] }],
    ])
    const { phone, deviceId, verificationKey } = await paired.enroll()
    await check('unverified', phone, [
      ['GET', 'native/pairing', undefined, { phone: [401, 'unauthorized'] }],
      ['GET', 'native/revocation', undefined, { phone: [200] }],
      ['GET', 'enrollment-info', undefined, { phone: [200] }],
      ['POST', 'enrollments', { publicKey: testDeviceKey().spki, name: 'x' }, { phone: [401, 'unauthorized'] }],
      ['POST', 'enrollment-invitation', { invitation: 'lpi1-AAAAAAAAAAAAAAAAAAAAAAAAAA' }, { phone: [401, 'unauthorized'] }],
      ['POST', 'credentials/challenge', {}, { phone: [403, 'native-credential-route'] }],
      ['POST', 'native/address-book', {}, { phone: [403, 'native-verification-required'] }],
      ['POST', 'native/proximity', { gatewayHash: '0'.repeat(64) }, { phone: [403, 'native-verification-required'] }],
      ['GET', 'devices', undefined, { phone: [403, 'native-verification-required'] }],
      ['GET', 'native/info', undefined, { phone: [403, 'native-verification-required'] }],
      ['POST', 'native/relays', {}, { phone: [403, 'native-verification-required'] }],
      ['POST', 'pairings', {}, { phone: [403, 'native-verification-required'] }],
      ['GET', 'custom-agents', undefined, { phone: [403, 'native-verification-required'] }],
      ['GET', 'automations', undefined, { phone: [403, 'native-verification-required'] }],
      ['GET', 'handoffs?sessionId=s', undefined, { phone: [403, 'native-verification-required'] }],
      ['POST', 'handoffs', {}, { phone: [403, 'native-verification-required'] }],
      ['POST', 'history/list', {}, { phone: [403, 'native-verification-required'] }],
      ['GET', `apps/p/data/status?app=p%2Fmain&revision=${'a'.repeat(64)}`, undefined, { phone: [403, 'native-verification-required'] }],
    ])
    const locked = await phone.request('GET', '/link/api/snapshot')
    expect(locked.status).toBe(200)
    expect(locked.body).not.toHaveProperty('customAgents')
    expect(locked.body).not.toHaveProperty('automations')
    await verifyPhone(t, phone, deviceId, verificationKey)
    await check('verified', phone, [
      ['POST', 'credentials/renew', { nonce: 'x', signature: 'x' }, { phone: [403, 'native-credential-route'] }],
      ['GET', 'devices', undefined, { phone: [403, 'scope-required'] }],
      ['PATCH', `devices/${viewer.id}`, { scopes: ['view', 'run'] }, { phone: [403, 'scope-required'] }],
      ['DELETE', `devices/${UNKNOWN_DEVICE}`, undefined, { phone: [403, 'scope-required'] }],
      ['GET', 'enrollments', undefined, { phone: [403, 'local-only'] }],
      ['POST', 'pairings', {}, { phone: [403, 'local-only'] }],
      ['GET', 'native/info', undefined, { phone: [403, 'local-only'] }],
      ['POST', 'native/relays', {}, { phone: [403, 'local-only'] }],
      ['POST', 'native/pairings', {}, { phone: [403, 'local-only'] }],
      ['POST', 'native/proximity', { gatewayHash: '0'.repeat(64) }, { phone: [200] }],
    ])
    expect(results).toEqual(expected)
  })
})
