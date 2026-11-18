import type { LookupAddress, LookupOptions } from 'node:dns'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { createServer as createTlsServer, type TLSSocket } from 'node:tls'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HOST_PROOF_SIGNING_VECTOR, makeTestTls } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const require = createRequire(import.meta.url)

interface Store {
  hostId: string
  file: string
  current(): { deviceId: string; credential: string } | undefined
  commit(input: { key: unknown; deviceId: string; credential: string; binding?: { origin: string; certificate: string } }): Promise<void>
  binding(): { origin: string; certificate: string } | undefined
  clear(): Promise<void>
}
interface Exchange {
  request: { destroy(): void }
  response: { statusCode: number; headers: Record<string, unknown> }
}
type Init = { method?: string; path: string; headers?: Record<string, string>; body?: Buffer; timeoutMs?: number }
type Send = (origin: string, init: Init) => Promise<Exchange>
interface RemoteProxy {
  acceptCertificate(options?: { compared?: boolean }): Promise<{ ok: boolean; reason?: string; certificate?: string }>
  handle(request: Request): Promise<Response>
  previewFrame(request: Request): Promise<Response>
  probe(): Promise<{ state: string; name?: string; version?: string }>
  renew(): Promise<boolean>
  revokeSelf(): Promise<boolean>
  state(): { verified: boolean; revoked: boolean }
}
interface Enrolled {
  hostId: string
  certificate?: string
  key: unknown
  deviceId: string
  credential: string
}

const remote = require('../src/remote-proxy.cjs') as {
  tlsOptions: (origin: string) => { ca: string[]; lookup?: unknown }
  httpsRequest: Send
  parseComputerLink(text: unknown): { origin: string; code: string } | undefined
  computerNameOf(name: unknown): string | undefined
  certificateProofText(hostId: string, nonce: string, certificate: string): string
  verifyCertificateProof(answer: unknown, hostId: string, nonce: string, certificate: string): boolean
  credentialFromSetCookie(headers: Record<string, unknown>, name: string): string | undefined
  createHostStateReader(onState: (state: Record<string, unknown>) => void): (chunk: Buffer | string) => void
  remoteRequestHeaders(headers: HeadersInit, cookie?: string): Record<string, string>
  enrollRemote(options: {
    link: { origin: string; code: string }
    name: string
    request?: Send
    wait?: (ms: number) => Promise<void>
    refuse?: (hostId: string) => string | undefined
    onWaiting?: (state: { fingerprint: string }) => void
  }): Promise<Enrolled>
  createRemoteProxy(options: {
    hostId: string
    origin: string
    store: Store
    request?: Send
    onStatus?: (event: { kind: string }) => void
  }): RemoteProxy
}
const computers = require('../src/computers.cjs') as {
  createSenderOf(options: Record<string, unknown>): (event: unknown) => { kind: string; hostId?: string } | undefined
  createStartHandler(options: Record<string, unknown>): (event: unknown, hostId: unknown) => unknown
  whenLoaded(contents: unknown, send: () => void): void
  parseComputers(value: unknown): { version: 1; computers: Array<Record<string, unknown>> } | undefined
  readComputers(directory: string): Promise<{ computers: Array<Record<string, unknown>>; damaged: boolean }>
  writeComputers(directory: string, list: unknown[], options?: { damaged?: boolean }): Promise<number>
  parseComputer(value: unknown): Record<string, unknown> | undefined
  createWindowOpener(options: {
    existing(hostId: string): unknown
    create(hostId: string): Promise<unknown>
    focus(window: unknown): void
  }): (hostId: string) => Promise<unknown>
  nextState(current: Record<string, unknown>, event: Record<string, unknown>, at: number): Record<string, unknown>
  probeDelay(current: Record<string, unknown>, failures: number, at: number, focused?: boolean): number | undefined
  distinctNames<T extends { name: string; hostId: string; local?: boolean }>(items: T[]): T[]
  createViewSender(
    send: (target: unknown, view: unknown) => void,
  ): ((target: unknown, view: unknown) => boolean) & { seen(target: unknown, view: unknown): unknown }
  createComputers(options: Record<string, unknown>): {
    start(): Promise<void>
    view(options?: { full?: boolean }): { computers: Array<Record<string, unknown>>; adding?: unknown }
    add(text: string): Promise<{ ok: boolean; hostId?: string; error?: string; message?: string }>
    known(hostId: string): boolean
    remove(hostId: string): Promise<{ ok: boolean; revokedThere?: boolean; error?: string }>
    proxyFor(hostId: string): RemoteProxy | undefined
    probe(hostId: string): Promise<void>
    waitingTotal(): number
    waits(hostId: string, taskId: string): boolean
    refocus(): void
    nameOf(hostId: string): string | undefined
    view(options?: { full?: boolean }): { computers: Array<Record<string, unknown>> }
    stop(): void
    settled(): Promise<void>
  }
}
const credentials = require('../src/credentials.cjs') as {
  openCredentialStore(options: { directory: string; hostId: string; safeStorage: unknown }): Promise<Store>
}
const proxyModule = require('../src/proxy.cjs') as {
  isAllowedRendererDetails(details: Record<string, unknown>, options: { packaged: boolean; home?: string }): boolean
  isAppUrl(url: string, home?: string): boolean
  isPreviewFrameUrl(url: string, home?: string): boolean
  isAppFrameUrl(url: string, home?: string): boolean
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-computers-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

function fakeSafeStorage() {
  const mask = (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0x5a))
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.concat([Buffer.from('fake1'), mask(Buffer.from(text, 'utf8'))]),
    decryptString: (data: Buffer) => mask(data.subarray(5)).toString('utf8'),
  }
}

const HOST_A = 'a'.repeat(52)
const HOST_B = 'b'.repeat(52)
const record = (hostId: string, extra: Record<string, unknown> = {}) => ({
  hostId,
  kind: 'https',
  origin: 'https://build-mini.example.ts.net',
  name: 'build-mini',
  addedAt: '2026-11-12T08:00:00.000Z',
  ...extra,
})

describe('computers.json', () => {
  it('accepts only the strict shape, at most 16 computers, each once, and no credential', () => {
    expect(
      computers.parseComputers({
        version: 1,
        computers: [record(HOST_A), { hostId: HOST_B, kind: 'local', name: 'studio', addedAt: '2026-11-12T08:00:00Z' }],
      }),
    ).toBeDefined()
    for (const bad of [
      { version: 2, computers: [] },
      { version: 1, computers: [], extra: true },
      { version: 1, computers: [{ ...record(HOST_A), credential: 'ldc1.x' }] },
      { version: 1, computers: [{ ...record(HOST_A), origin: 'http://build-mini.example.ts.net' }] },
      { version: 1, computers: [{ ...record(HOST_A), origin: 'https://build-mini.example.ts.net/link/' }] },
      { version: 1, computers: [{ ...record(HOST_A), origin: undefined }] },
      {
        version: 1,
        computers: [{ hostId: HOST_A, kind: 'local', origin: 'https://x.example', name: 'x', addedAt: '2026-11-12T08:00:00Z' }],
      },
      { version: 1, computers: [record('not-a-host-id')] },
      { version: 1, computers: [record(HOST_A, { name: 'a\nb' })] },
      { version: 1, computers: [record(HOST_A), record(HOST_A)] },
      { version: 1, computers: Array.from({ length: 17 }, (_, index) => record(String.fromCharCode(97 + (index % 26)).repeat(51) + 'a')) },
    ])
      expect(computers.parseComputers(bad), JSON.stringify(bad).slice(0, 80)).toBeUndefined()
  })

  it('writes 0600 atomically, reads it back, and moves a damaged file aside instead of guessing', async () => {
    const dir = await directory()
    expect(await computers.readComputers(dir)).toEqual({ computers: [], damaged: false })
    await computers.writeComputers(dir, [record(HOST_A)])
    expect((await stat(join(dir, 'computers.json'))).mode & 0o777).toBe(0o600)
    expect((await computers.readComputers(dir)).computers).toEqual([record(HOST_A)])
    // One bad record never costs the others: it is left out and the rest is written.
    expect(await computers.writeComputers(dir, [{ ...record(HOST_A), token: 'x' }, record(HOST_B)])).toBe(1)
    expect((await computers.readComputers(dir)).computers).toEqual([record(HOST_B)])
    await computers.writeComputers(dir, [record(HOST_A)])

    await writeFile(join(dir, 'computers.json'), '{"version":1,"computers":[{"hostId":"', { mode: 0o600 })
    expect(await computers.readComputers(dir)).toEqual({ computers: [], damaged: true })
    await computers.writeComputers(dir, [record(HOST_B)], { damaged: true })
    expect(await readFile(join(dir, 'computers.json.damaged'), 'utf8')).toContain('"hostId":"')
    expect((await computers.readComputers(dir)).computers).toEqual([record(HOST_B)])
  })
})

describe('the computer state machine', () => {
  const at = 1_000_000
  it('keeps revoked until removal, holds an announced stop until its retryAfter, and wakes to connecting', () => {
    const revoked = computers.nextState({ state: 'online', lastSeenAt: 1 }, { kind: 'revoked' }, at)
    expect(revoked.state).toBe('revoked')
    for (const kind of ['online', 'offline', 'connecting', 'wrong-host']) expect(computers.nextState(revoked, { kind }, at)).toBe(revoked)

    const stopping = computers.nextState(
      { state: 'online' },
      { kind: 'host-state', state: 'stopping', reason: 'update', retryAfter: 20 },
      at,
    )
    expect(stopping).toEqual({ state: 'stopping', reason: 'update', until: at + 20_000, lastSeenAt: at })
    expect(computers.nextState(stopping, { kind: 'offline' }, at + 5_000)).toBe(stopping)
    expect(computers.nextState(stopping, { kind: 'offline' }, at + 25_000)).toEqual({ state: 'offline', lastSeenAt: at })
    expect(computers.nextState(stopping, { kind: 'host-state', state: 'awake' }, at + 1)).toEqual({
      state: 'connecting',
      lastSeenAt: at + 1,
    })
    expect(computers.nextState({ state: 'offline', lastSeenAt: 5 }, { kind: 'online' }, at)).toEqual({ state: 'online', lastSeenAt: at })
    expect(computers.nextState({ state: 'online', lastSeenAt: 5 }, { kind: 'cert-error' }, at)).toEqual({
      state: 'cert-error',
      lastSeenAt: 5,
    })
  })

  it('looks again every 15 seconds in front and every minute behind while online, backs off to five minutes while not, never at a revoked computer', () => {
    expect(computers.probeDelay({ state: 'online' }, 0, at)).toBe(15_000)
    expect(computers.probeDelay({ state: 'online' }, 0, at, false)).toBe(60_000)
    expect(computers.probeDelay({ state: 'connecting' }, 0, at, true)).toBe(15_000)
    expect(computers.probeDelay({ state: 'offline' }, 20, at, true)).toBe(300_000)
    expect(computers.probeDelay({ state: 'offline' }, 1, at)).toBe(15_000)
    expect(computers.probeDelay({ state: 'offline' }, 3, at)).toBe(60_000)
    expect(computers.probeDelay({ state: 'offline' }, 20, at)).toBe(300_000)
    expect(computers.probeDelay({ state: 'sleeping', until: at + 30_000 }, 0, at)).toBe(31_000)
    expect(computers.probeDelay({ state: 'revoked' }, 0, at)).toBeUndefined()
  })

  it('tells look-alike names apart: another width or case, a variation selector or an invisible character', () => {
    for (const twin of ['build-mini\uFE0F', 'BUILD-MINI', 'ｂｕｉｌｄ-mini', 'build\u200B-mini'])
      expect(
        computers
          .distinctNames([
            { hostId: HOST_A, name: 'build-mini' },
            { hostId: HOST_B, name: twin },
          ])
          .map(item => item.name),
        twin,
      ).toEqual([`build-mini ${HOST_A.slice(0, 4)}`, `${twin} ${HOST_B.slice(0, 4)}`])
    expect(remote.computerNameOf('build\u202Emini\u2028x.local')).toBe('buildminix')
  })

  it('always marks a name that mixes Latin with a script of Latin look-alikes, not one with Han or kana', () => {
    expect(
      computers
        .distinctNames([
          { hostId: HOST_A, name: 'build-mini' },
          { hostId: HOST_B, name: 'build-m\u0456ni' },
          { hostId: 'c'.repeat(52), name: '王的 MacBook' },
          { hostId: 'd'.repeat(52), name: 'ビルド mini' },
          { hostId: 'e'.repeat(52), name: '\u03b2uild-mini' },
        ])
        .map(item => item.name),
    ).toEqual(['build-mini', `build-m\u0456ni ${HOST_B.slice(0, 4)}`, '王的 MacBook', 'ビルド mini', `\u03b2uild-mini eeee`])
  })

  it('tells two computers of one name apart by their hostId', () => {
    expect(
      computers
        .distinctNames([
          { hostId: HOST_A, name: 'mini' },
          { hostId: HOST_B, name: 'mini' },
          { hostId: 'c'.repeat(52), name: 'studio' },
          { hostId: 'd'.repeat(52), name: 'studio', local: true },
        ])
        .map(item => item.name),
    ).toEqual(['mini aaaa', 'mini bbbb', 'studio', 'studio'])
  })
})

describe('computer links and the remote request policy', () => {
  it('accepts only an HTTPS /link/ address with an invitation fragment', () => {
    const code = `lpi1-${'A'.repeat(26)}`
    expect(remote.parseComputerLink(` https://mini.example.ts.net/link/#pair=${code}\n`)).toEqual({
      origin: 'https://mini.example.ts.net',
      code,
    })
    expect(remote.parseComputerLink(`https://mini.example.ts.net:8443/link/#pair=${code}`)?.origin).toBe('https://mini.example.ts.net:8443')
    for (const bad of [
      `http://mini.example.ts.net/link/#pair=${code}`,
      `https://user@mini.example.ts.net/link/#pair=${code}`,
      `https://mini.example.ts.net/link/?x=1#pair=${code}`,
      `https://mini.example.ts.net/other/#pair=${code}`,
      `https://mini.example.ts.net/link/#pair=lpi1-short`,
      `https://mini.example.ts.net/link/#pair=${code} and more`,
      `latch://app/link/#pair=${code}`,
      undefined,
    ])
      expect(remote.parseComputerLink(bad), String(bad)).toBeUndefined()
  })

  it('drops the page cookies, credentials, origin and fetch metadata, and adds only the given cookie', () => {
    expect(
      remote.remoteRequestHeaders(
        {
          cookie: '__Host-latch_aaaaaaaa=stolen',
          authorization: 'Latch-Device x',
          origin: 'latch://h-x',
          referer: 'latch://h-x/link/',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'x-forwarded-for': '1.2.3.4',
        },
        '__Host-latch_bbbbbbbb=mine',
      ),
    ).toEqual({ 'content-type': 'application/json', cookie: '__Host-latch_bbbbbbbb=mine' })
    expect(
      remote.credentialFromSetCookie(
        { 'set-cookie': ['other=1', '__Host-latch_bbbbbbbb=ldc1.x; Secure; HttpOnly'] },
        '__Host-latch_bbbbbbbb',
      ),
    ).toBe('ldc1.x')
    expect(remote.credentialFromSetCookie({ 'set-cookie': ['__Host-latch_bbbbbbbb=; Max-Age=0'] }, '__Host-latch_bbbbbbbb')).toBeUndefined()
  })

  it('reads the Host’s own host-state frames from an event stream split anywhere', () => {
    const seen: Array<Record<string, unknown>> = []
    const read = remote.createHostStateReader(state => seen.push(state))
    const frame =
      'event: host-state\ndata: {"type":"host-state","instanceId":"i","state":"stopping","reason":"update","retryAfter":20,"at":"x"}\n\n'
    read(': heartbeat\n\nevent: refresh\ndata: {"type":"refresh"}\n\n' + frame.slice(0, 30))
    read(frame.slice(30))
    read('event: host-state\ndata: not json\n\n')
    expect(seen).toEqual([{ state: 'stopping', reason: 'update', retryAfter: 20 }])
  })

  it('keeps each window inside its own computer: requests, navigation and frames', () => {
    const home = `h-${HOST_B}`
    expect(proxyModule.isAppUrl(`latch://${home}/link/`, home)).toBe(true)
    expect(proxyModule.isAppUrl('latch://app/link/', home)).toBe(false)
    expect(proxyModule.isAppUrl(`latch://${home}/link/`)).toBe(false)
    const top = (url: string, frameUrl: string) => ({ url, resourceType: 'xhr', frame: { parent: null, url: frameUrl } })
    expect(
      proxyModule.isAllowedRendererDetails(top(`latch://${home}/link/api/snapshot`, `latch://${home}/link/`), { packaged: true, home }),
    ).toBe(true)
    expect(
      proxyModule.isAllowedRendererDetails(top('latch://app/link/api/snapshot', `latch://${home}/link/`), { packaged: true, home }),
    ).toBe(false)
    expect(
      proxyModule.isAllowedRendererDetails(top(`latch://h-${HOST_A}/link/api/snapshot`, `latch://${home}/link/`), { packaged: true, home }),
    ).toBe(false)
    expect(
      proxyModule.isAllowedRendererDetails(top(`latch://${home}/link/api/snapshot`, `latch://${home}/link/`), { packaged: true }),
    ).toBe(false)
    expect(proxyModule.isPreviewFrameUrl(`latch-frame://${home}/preview/office.html`, home)).toBe(true)
    // A script-running HTML preview stays on this Mac's own page.
    expect(proxyModule.isPreviewFrameUrl(`latch-frame://${home}/preview/html-script.html`, home)).toBe(false)
    expect(proxyModule.isPreviewFrameUrl('latch-frame://preview/office.html', home)).toBe(false)
    expect(proxyModule.isPreviewFrameUrl(`latch-frame://${home}/preview/office.html`)).toBe(false)
    expect(proxyModule.isAppFrameUrl(`latch-frame://${home}/app/runtime.html`, home)).toBe(true)
    expect(proxyModule.isAppFrameUrl('latch-frame://app/runtime.html', home)).toBe(false)
  })
})

/** `latch-test.localhost` is 127.0.0.1 for the test certificates. */
function localhostLookup(
  _hostname: string,
  options: LookupOptions,
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
) {
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
  else callback(null, '127.0.0.1', 4)
}

describe('another computer’s Host over HTTPS', () => {
  let a: TestHost
  let b: TestHost
  const original = remote.tlsOptions
  // Both test certificates name latch-test.localhost, so each origin trusts its own Host's alone.
  const trustBoth = (origin: string) => ({ ca: [origin === a.host.tlsOrigin ? a.tlsCa! : b.tlsCa!], lookup: localhostLookup })
  beforeAll(async () => {
    a = await startTestHost({ tls: true })
    b = await startTestHost({ tls: true })
    remote.tlsOptions = trustBoth
    return async () => {
      remote.tlsOptions = original
      await Promise.all([a.close(), b.close()])
    }
  })

  /** What each Host received: the headers main sent, by origin. */
  function recorder() {
    const sent: Array<{ origin: string; path: string; headers: Record<string, string> }> = []
    const request: Send = (origin, init) => {
      sent.push({ origin, path: init.path, headers: { ...init.headers } })
      return remote.httpsRequest(origin, init)
    }
    return { sent, request }
  }

  it.each([
    ['presence-busy', 'presence-busy'],
    ['service-maintenance', 'add-failed'],
  ])('reports a local enrollment failure for %s', async (remoteCode, expectedCode) => {
    const link = remote.parseComputerLink((await a.invite()).url)!
    const request: Send = (origin, init) => {
      if (init.path !== '/link/api/enrollments') return remote.httpsRequest(origin, init)
      const body = JSON.stringify({ error: remoteCode, message: 'Maintenance window' })
      const response = Object.assign(Readable.from([Buffer.from(body)]), {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
      })
      return Promise.resolve({ request: { destroy() {} }, response })
    }
    await expect(remote.enrollRemote({ link, name: 'Test computer', request })).rejects.toMatchObject({
      code: expectedCode,
      message: '无法添加这台电脑，请重试。',
    })
  })

  async function addComputer(host: TestHost, request: Send) {
    const invitation = await host.invite()
    const link = remote.parseComputerLink(invitation.url)!
    let fingerprint = ''
    const enrolled = await remote.enrollRemote({
      link,
      name: 'studio 上的 Latch',
      request,
      wait: () => new Promise(done => setTimeout(done, 20)),
      onWaiting: state => {
        fingerprint = state.fingerprint
      },
    })
    const store = await credentials.openCredentialStore({
      directory: await directory(),
      hostId: enrolled.hostId,
      safeStorage: fakeSafeStorage(),
    })
    await store.commit({ ...enrolled, binding: { origin: link.origin, certificate: enrolled.certificate! } })
    return { enrolled, store, fingerprint, origin: link.origin }
  }

  const snapshotDevice = async (proxy: RemoteProxy, hostId: string) => {
    const response = await proxy.handle(new Request(`latch://h-${hostId}/link/api/snapshot`))
    expect(response.status).toBe(200)
    return ((await response.json()) as { device: { id: string } }).device.id
  }

  it('adds a computer with a fresh key, and picks each Host’s credential by the request’s origin alone', async () => {
    const { sent, request } = recorder()
    const first = await addComputer(a, request)
    const second = await addComputer(b, request)
    expect(first.enrolled.hostId).toBe(a.host.hostId)
    expect(second.enrolled.hostId).toBe(b.host.hostId)
    expect(first.fingerprint).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){4}$/)
    // Never one key for two Hosts.
    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(first.enrolled.key).not.toBe(second.enrolled.key)
    // The invitation and the credential never travel as a cookie to the other Host.
    expect(sent.filter(item => item.headers.cookie !== undefined)).toEqual([])

    const proxyA = remote.createRemoteProxy({ hostId: a.host.hostId, origin: first.origin, store: first.store, request })
    const proxyB = remote.createRemoteProxy({ hostId: b.host.hostId, origin: second.origin, store: second.store, request })
    // Interleaved and concurrent: each answer belongs to the Host the origin names.
    const ids = await Promise.all([
      snapshotDevice(proxyA, a.host.hostId),
      snapshotDevice(proxyB, b.host.hostId),
      snapshotDevice(proxyA, a.host.hostId),
      snapshotDevice(proxyB, b.host.hostId),
    ])
    expect(ids).toEqual([first.enrolled.deviceId, second.enrolled.deviceId, first.enrolled.deviceId, second.enrolled.deviceId])
    for (const item of sent.filter(entry => entry.headers.cookie)) {
      const own = item.origin === first.origin ? a.host.hostId : b.host.hostId
      expect(item.headers.cookie.startsWith(`__Host-latch_${own.slice(0, 8)}=`)).toBe(true)
      const store = item.origin === first.origin ? first.store : second.store
      expect(item.headers.cookie).toBe(`__Host-latch_${own.slice(0, 8)}=${store.current()!.credential}`)
    }
    // A handler only answers its own origin.
    expect((await proxyA.handle(new Request(`latch://h-${b.host.hostId}/link/api/snapshot`))).status).toBe(404)
    expect((await proxyA.handle(new Request('latch://app/link/api/snapshot'))).status).toBe(404)

    // The page's own cookies and credentials never reach the Host; main's credential does, and no Set-Cookie comes back.
    const forged = await proxyB.handle(
      new Request(`latch://h-${b.host.hostId}/link/api/snapshot`, {
        headers: { cookie: `__Host-latch_${b.host.hostId8}=${first.store.current()!.credential}`, authorization: 'Latch-Device nope' },
      }),
    )
    expect(((await forged.json()) as { device: { id: string } }).device.id).toBe(second.enrolled.deviceId)
    const renewedBefore = second.store.current()!.credential
    expect(await proxyB.renew()).toBe(true)
    expect(second.store.current()!.credential).not.toBe(renewedBefore)
    const after = await proxyB.handle(new Request(`latch://h-${b.host.hostId}/link/api/snapshot`))
    expect(after.headers.get('set-cookie')).toBeNull()
    expect(after.status).toBe(200)

    // What only this Mac's own Host does with the app is refused on another computer's origin.
    for (const [method, path] of [
      ['POST', 'enrollments'],
      ['POST', 'credentials/challenge'],
      ['POST', 'pairings'],
      ['POST', 'folder-grants'],
      ['POST', 'host/state'],
    ]) {
      const response = await proxyB.handle(new Request(`latch://h-${b.host.hostId}/link/api/${path}`, { method, body: '{}' }))
      expect(response.status, path).toBe(403)
    }
    // Its preview bootstraps come from its own Host and may be framed only by its own page.
    const frame = await proxyB.previewFrame(new Request(`latch-frame://h-${b.host.hostId}/preview/office.html`))
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-security-policy')).toContain(`frame-ancestors latch://h-${b.host.hostId}`)
    expect((await proxyB.previewFrame(new Request(`latch-frame://h-${b.host.hostId}/preview/html-script.html`))).status).toBe(404)

    const probed = await proxyB.probe()
    expect(probed.state).toBe('online')
    expect(probed.name).toBeTruthy()
  })

  it('sends no credential to a different Host at the address and calls it wrong-host', async () => {
    const { sent, request } = recorder()
    const added = await addComputer(b, request)
    const statuses: string[] = []
    // The record says Host A, but the address answers as Host B.
    const store = await credentials.openCredentialStore({
      directory: await directory(),
      hostId: a.host.hostId,
      safeStorage: fakeSafeStorage(),
    })
    await store.commit({ ...added.enrolled, binding: { origin: added.origin, certificate: added.enrolled.certificate! } })
    const proxy = remote.createRemoteProxy({
      hostId: a.host.hostId,
      origin: added.origin,
      store,
      request,
      onStatus: event => statuses.push(event.kind),
    })
    sent.length = 0
    const response = await proxy.handle(new Request(`latch://h-${a.host.hostId}/link/api/snapshot`))
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: string }).error).toBe('wrong-host')
    expect(statuses).toContain('wrong-host')
    expect(sent.map(item => item.path)).toEqual(['/link/api/health'])
    expect(sent.every(item => item.headers.cookie === undefined)).toBe(true)
    expect((await proxy.probe()).state).toBe('wrong-host')
    expect(await proxy.revokeSelf()).toBe(false)
    expect(sent.every(item => item.headers.cookie === undefined)).toBe(true)
  })

  it('calls an untrusted certificate cert-error and sends nothing over it', async () => {
    const { request } = recorder()
    const added = await addComputer(b, request)
    remote.tlsOptions = () => ({ ca: [a.tlsCa!], lookup: localhostLookup })
    try {
      const proxy = remote.createRemoteProxy({ hostId: b.host.hostId, origin: added.origin, store: added.store })
      expect((await proxy.probe()).state).toBe('cert-error')
      const response = await proxy.handle(new Request(`latch://h-${b.host.hostId}/link/api/snapshot`))
      expect(((await response.json()) as { error: string }).error).toBe('cert-error')
    } finally {
      remote.tlsOptions = trustBoth
    }
  })

  it('turns revoked when that Host removes this device, and forgets the credential', async () => {
    const { request } = recorder()
    const added = await addComputer(b, request)
    const statuses: string[] = []
    const proxy = remote.createRemoteProxy({
      hostId: b.host.hostId,
      origin: added.origin,
      store: added.store,
      request,
      onStatus: event => statuses.push(event.kind),
    })
    expect((await proxy.probe()).state).toBe('online')
    const revoked = await b.raw('unix', `api/devices/${added.enrolled.deviceId}`, { method: 'DELETE' })
    expect(revoked.status).toBe(200)
    const response = await proxy.handle(new Request(`latch://h-${b.host.hostId}/link/api/snapshot`))
    expect(response.status).toBe(401)
    expect(statuses).toContain('revoked')
    expect(added.store.current()).toBeUndefined()
    await expect(lstat(added.store.file)).rejects.toThrow()
    expect((await proxy.probe()).state).toBe('revoked')
    // The page then shows what to do instead of an enrollment it cannot finish.
    const page = await proxy.handle(new Request(`latch://h-${b.host.hostId}/link/`))
    expect(await page.text()).toContain('设置 › 电脑')
  })

  it('adds and removes through the registry: record, credential and partition go, and that Host revokes this device', async () => {
    const userData = await directory()
    const forgotten: string[] = []
    const changes: number[] = []
    const registry = computers.createComputers({
      directory: userData,
      localHostId: a.host.hostId,
      local: () => ({ name: 'studio', state: 'online' }),
      openStore: (hostId: string) =>
        credentials.openCredentialStore({ directory: join(userData, 'latch-devices'), hostId, safeStorage: fakeSafeStorage() }),
      makeProxy: (input: { hostId: string; origin: string; store: Store; onStatus: (event: { kind: string }) => void }) =>
        remote.createRemoteProxy(input),
      enroll: (link: { origin: string; code: string }, hooks: Record<string, never>) =>
        remote.enrollRemote({ link, name: 'studio 上的 Latch', wait: () => new Promise(done => setTimeout(done, 20)), ...hooks }),
      parseLink: (text: string) => remote.parseComputerLink(text),
      forgetPartition: (hostId: string) => {
        forgotten.push(hostId)
      },
      onChange: () => changes.push(1),
    })
    cleanups.push(async () => {
      registry.stop()
      await registry.settled()
    })
    await registry.start()
    expect(registry.view().computers).toEqual([{ hostId: a.host.hostId, name: 'studio', local: true, state: 'online' }])

    // This Mac's own Host is never added as another computer.
    const own = await registry.add((await a.invite()).url)
    expect(own).toMatchObject({ ok: false, error: 'computer-refused' })
    expect(await registry.add('not a link')).toMatchObject({ ok: false, error: 'invalid-link' })

    const added = await registry.add((await b.invite()).url)
    expect(added).toEqual({ ok: true, hostId: b.host.hostId })
    await registry.settled()
    const saved = JSON.parse(await readFile(join(userData, 'computers.json'), 'utf8')) as { computers: Array<Record<string, unknown>> }
    expect(saved.computers).toHaveLength(1)
    expect(saved.computers[0]).toMatchObject({ hostId: b.host.hostId, kind: 'https', origin: b.host.tlsOrigin })
    expect(JSON.stringify(saved)).not.toContain('ldc1.')
    const view = registry.view({ full: true })
    expect(view.computers[1]).toMatchObject({ hostId: b.host.hostId, local: false, state: 'online', origin: b.host.tlsOrigin })
    // Another computer's page gets no address.
    expect(registry.view().computers[1]).not.toHaveProperty('origin')
    expect(await registry.add((await b.invite()).url)).toMatchObject({ ok: false, error: 'computer-refused' })
    const credentialFile = join(userData, 'latch-devices', `${b.host.hostId}.json`)
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600)

    const activeHere = async () =>
      ((await (await b.raw('unix', 'api/devices')).json()) as { devices: Array<{ id: string; status: string; name: string }> }).devices
        .filter(device => device.status === 'active')
        .map(device => device.id)
    const before = await activeHere()
    const removed = await registry.remove(b.host.hostId)
    expect(removed).toEqual({ ok: true, revokedThere: true })
    await registry.settled()
    expect(forgotten).toEqual([b.host.hostId])
    await expect(lstat(credentialFile)).rejects.toThrow()
    expect(JSON.parse(await readFile(join(userData, 'computers.json'), 'utf8'))).toEqual({ version: 1, computers: [] })
    const after = await activeHere()
    expect(after).toHaveLength(before.length - 1)
    expect(before.filter(id => !after.includes(id))).toHaveLength(1)
    expect(changes.length).toBeGreaterThan(0)
  })
})

describe('names, opening windows and a list that cannot be saved', () => {
  it('cuts a long name by code points, so the record stays valid and the list is still written', async () => {
    const long = `${'a'.repeat(79)}😀more`
    const name = remote.computerNameOf(long)!
    expect([...name]).toHaveLength(80)
    expect(name.endsWith('😀')).toBe(true)
    expect(computers.parseComputer(record(HOST_A, { name }))).toBeDefined()
    const dir = await directory()
    expect(await computers.writeComputers(dir, [record(HOST_A, { name })])).toBe(0)
    expect((await computers.readComputers(dir)).computers[0]?.name).toBe(name)
  })

  it('opens one window per computer however many opens race, and brings an open one forward', async () => {
    const windows = new Map<string, object>()
    let created = 0
    let focused = 0
    let release!: () => void
    const gate = new Promise<void>(done => (release = done))
    const open = computers.createWindowOpener({
      existing: hostId => windows.get(hostId),
      focus: () => {
        focused += 1
      },
      async create(hostId) {
        created += 1
        await gate
        const window = { hostId }
        windows.set(hostId, window)
        return window
      },
    })
    const racing = Array.from({ length: 5 }, () => open(HOST_A))
    release()
    const opened = await Promise.all(racing)
    expect(created).toBe(1)
    expect(new Set(opened).size).toBe(1)
    await open(HOST_A)
    expect(created).toBe(1)
    expect(focused).toBe(1)
  })

  it('keeps the list read-only when a computer’s credentials cannot be opened: nothing written over, nothing removed', async () => {
    const userData = await directory()
    await computers.writeComputers(userData, [record(HOST_B)])
    const before = await readFile(join(userData, 'computers.json'), 'utf8')
    const registry = computers.createComputers({
      directory: userData,
      localHostId: HOST_A,
      local: () => ({ state: 'online' }),
      openStore: () => Promise.reject(new Error('keychain locked')),
      makeProxy: () => {
        throw new Error('not reached')
      },
      enroll: () => Promise.reject(new Error('not reached')),
      parseLink: (text: string) => remote.parseComputerLink(text),
    })
    await registry.start()
    expect(registry.view({ full: true })).toMatchObject({ problem: 'credentials' })
    expect(registry.known(HOST_B)).toBe(true)
    expect(await registry.add(`https://mini.example.ts.net/link/#pair=lpi1-${'A'.repeat(26)}`)).toMatchObject({
      ok: false,
      error: 'computers-read-only',
    })
    expect(await registry.remove(HOST_B)).toMatchObject({ ok: false, error: 'computers-read-only' })
    await registry.settled()
    expect(await readFile(join(userData, 'computers.json'), 'utf8')).toBe(before)
    registry.stop()
  })
})

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(done => server.close(() => done()))
  return port
}

describe('a computer bound to its certificate', () => {
  it('writes nothing to another server, refuses an impostor and a relay, and trusts a renewal its Host proves', async () => {
    const root = await directory()
    const first = await makeTestTls(join(root, 'first'))
    const second = await makeTestTls(join(root, 'second'))
    const stranger = await makeTestTls(join(root, 'stranger'))
    const port = await freePort()
    const listener = (tls: { certPath: string; keyPath: string; hostname: string }, at = port) => ({
      host: '127.0.0.1',
      port: at,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      publicOrigin: `https://${tls.hostname}:${at}`,
      allowLocalPeers: true,
    })
    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    const original = remote.tlsOptions
    const trust = (ca: string) => {
      remote.tlsOptions = () => ({ ca: [ca], lookup: localhostLookup })
    }
    let host: TestHost | undefined = await startTestHost({ tls: listener(first), dataDir, workspaceRoot })
    const servers: Array<{ close(done: () => void): void; closeAllConnections?(): void }> = []
    const stop = (server: (typeof servers)[number]) =>
      new Promise<void>(done => {
        server.closeAllConnections?.()
        server.close(() => done())
      })
    cleanups.push(async () => {
      remote.tlsOptions = original
      for (const server of servers) await stop(server).catch(() => {})
      await host?.close()
    })
    trust(first.ca)
    const invitation = await host.invite()
    const link = remote.parseComputerLink(invitation.url)!
    const enrolled = await remote.enrollRemote({ link, name: 'studio 上的 Latch', wait: () => new Promise(done => setTimeout(done, 20)) })
    expect(enrolled.certificate).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u)
    const store = await credentials.openCredentialStore({
      directory: await directory(),
      hostId: enrolled.hostId,
      safeStorage: fakeSafeStorage(),
    })
    await store.commit({ ...enrolled, binding: { origin: link.origin, certificate: enrolled.certificate! } })
    const statuses: string[] = []
    const proxy = remote.createRemoteProxy({
      hostId: enrolled.hostId,
      origin: link.origin,
      store,
      onStatus: event => statuses.push(event.kind),
    })
    expect((await proxy.probe()).state).toBe('online')

    // Within the minute the hostId check is trusted, another server takes the address (a DNS or port swap) with a
    // certificate this Mac also trusts: the handshake ends before the request, so the credential never reaches it.
    await host.close()
    host = undefined
    const received: Buffer[] = []
    const raw = createTlsServer({ cert: await readFile(stranger.certPath), key: await readFile(stranger.keyPath) }, socket => {
      socket.on('data', chunk => {
        received.push(chunk)
        socket.destroy()
      })
      socket.on('error', () => {})
    })
    await new Promise<void>(done => raw.listen(port, '127.0.0.1', done))
    trust(stranger.ca)
    const response = await proxy.handle(new Request(`latch://h-${enrolled.hostId}/link/api/snapshot`))
    expect(response.status).toBe(502)
    const sent = Buffer.concat(received).toString('latin1')
    expect(sent).not.toContain('__Host-latch_')
    expect(sent).not.toContain(store.current()!.credential)
    await stop(raw)

    // An impostor with a certificate this Mac trusts answers with the public hostId: 证书变了, and its proof fails.
    const impostor = createHttpsServer({ cert: await readFile(stranger.certPath), key: await readFile(stranger.keyPath) }, (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/link/api/health') res.end(JSON.stringify({ ok: true, hostId: enrolled.hostId }))
      else if (req.url === '/link/api/host-proof') {
        // A key of its own: it signs, but its key does not hash to the hostId it claims.
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        let body = ''
        req.on('data', chunk => (body += String(chunk)))
        req.on('end', () => {
          const { nonce } = JSON.parse(body) as { nonce: string }
          const text = `latch-cert-proof-v1\n${enrolled.hostId}\n${nonce}\n${req.socket && (req.socket as TLSSocket).getCertificate() ? ((req.socket as TLSSocket).getCertificate() as { fingerprint256: string }).fingerprint256 : ''}`
          res.end(
            JSON.stringify({
              publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
              signature: sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
            }),
          )
        })
        return
      } else res.writeHead(404).end('{}')
    })
    servers.push(impostor)
    await new Promise<void>(done => impostor.listen(port, '127.0.0.1', done))
    expect((await proxy.probe()).state).toBe('cert-changed')
    expect(await proxy.acceptCertificate()).toMatchObject({ ok: false, reason: 'refused' })
    expect(store.binding()?.certificate).toBe(enrolled.certificate)
    await stop(impostor)

    // An impostor that answers the proof with 404 does not downgrade it: refused as outdated, nothing pinned.
    const silent = createHttpsServer({ cert: await readFile(stranger.certPath), key: await readFile(stranger.keyPath) }, (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/link/api/health') res.end(JSON.stringify({ ok: true, hostId: enrolled.hostId }))
      else res.writeHead(404).end(JSON.stringify({ error: 'not-found' }))
    })
    servers.push(silent)
    await new Promise<void>(done => silent.listen(port, '127.0.0.1', done))
    expect((await proxy.probe()).state).toBe('cert-changed')
    expect(await proxy.acceptCertificate()).toMatchObject({ ok: false, reason: 'outdated' })
    expect(store.binding()?.certificate).toBe(enrolled.certificate)
    await stop(silent)

    // A relay with a trusted certificate of its own in front of the real Host: the Host proves the certificate it serves
    // itself, so the answer does not match the one the relay shows.
    const realPort = await freePort()
    host = await startTestHost({ tls: listener(first, realPort), dataDir, workspaceRoot })
    const relay = createHttpsServer({ cert: await readFile(stranger.certPath), key: await readFile(stranger.keyPath) }, (req, res) => {
      const upstream = httpsRequest(
        {
          host: '127.0.0.1',
          port: realPort,
          servername: 'latch-test.localhost',
          ca: first.ca,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `latch-test.localhost:${realPort}` },
        },
        answer => {
          res.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(res)
        },
      )
      upstream.on('error', () => res.writeHead(502).end())
      req.pipe(upstream)
    })
    servers.push(relay)
    await new Promise<void>(done => relay.listen(port, '127.0.0.1', done))
    expect((await proxy.probe()).state).toBe('cert-changed')
    expect(await proxy.acceptCertificate()).toMatchObject({ ok: false, reason: 'refused' })
    expect(store.binding()?.certificate).toBe(enrolled.certificate)
    await stop(relay)
    await host.close()
    host = undefined

    // The same Host comes back with a renewed certificate: 证书变了, no credential, until it proves the new one.
    host = await startTestHost({ tls: listener(second), dataDir, workspaceRoot })
    expect(host.host.hostId).toBe(enrolled.hostId)
    trust(second.ca)
    expect((await proxy.probe()).state).toBe('cert-changed')
    expect(statuses).toContain('cert-changed')
    const refused = await proxy.handle(new Request(`latch://h-${enrolled.hostId}/link/api/snapshot`))
    expect(((await refused.json()) as { error: string }).error).toBe('cert-changed')
    expect(await proxy.acceptCertificate()).toEqual({ ok: true })
    expect(store.binding()).toEqual({ origin: link.origin, certificate: expect.not.stringMatching(enrolled.certificate!) as unknown })
    expect((await proxy.probe()).state).toBe('online')
    // Accepting is spent: nothing more to accept.
    expect(await proxy.acceptCertificate()).toMatchObject({ ok: false, reason: 'nothing' })
  })

  it('never trusts a certificate on first sight, and takes the address from the encrypted record, not computers.json', async () => {
    const userData = await directory()
    const store = await credentials.openCredentialStore({
      directory: join(userData, 'latch-devices'),
      hostId: HOST_B,
      safeStorage: fakeSafeStorage(),
    })
    const key = (require('../src/credentials.cjs') as { generateDeviceKey(): unknown }).generateDeviceKey()
    const deviceId = `dev_${'A'.repeat(22)}`
    const credential = `ldc1.${deviceId}.${'c'.repeat(43)}`
    const pin = Array.from({ length: 32 }, () => 'AB').join(':')
    await store.commit({ key, deviceId, credential, binding: { origin: 'https://mini.example.ts.net', certificate: pin } })
    // Another process of this user rewrites the list to send the credential elsewhere.
    await computers.writeComputers(userData, [record(HOST_B, { origin: 'https://attacker.example' })])
    const made: Array<{ origin: string }> = []
    const registry = computers.createComputers({
      directory: userData,
      localHostId: HOST_A,
      local: () => ({ state: 'online' }),
      openStore: (hostId: string) =>
        credentials.openCredentialStore({ directory: join(userData, 'latch-devices'), hostId, safeStorage: fakeSafeStorage() }),
      makeProxy: (input: { origin: string }) => {
        made.push(input)
        return { probe: async () => ({ state: 'offline' }), startRenewalTimer: () => () => {} }
      },
      enroll: () => Promise.reject(new Error('not reached')),
      parseLink: (text: string) => remote.parseComputerLink(text),
    })
    await registry.start()
    expect(made.map(item => item.origin)).toEqual(['https://mini.example.ts.net'])
    await registry.settled()
    expect((await computers.readComputers(userData)).computers[0]?.origin).toBe('https://mini.example.ts.net')
    registry.stop()

    // A ciphertext changed on disk is not read as another address: the binding is checked against the device key.
    const file = JSON.parse(await readFile(store.file, 'utf8')) as Record<string, string>
    const forged = fakeSafeStorage().encryptString(JSON.stringify({ origin: 'https://attacker.example', certificate: pin, mac: 'x' }))
    await writeFile(store.file, JSON.stringify({ ...file, binding: forged.toString('base64') }), { mode: 0o600 })
    const reread = await credentials.openCredentialStore({
      directory: join(userData, 'latch-devices'),
      hostId: HOST_B,
      safeStorage: fakeSafeStorage(),
    })
    expect(reread.binding()).toBeUndefined()

    // Without a pin the proxy sends nothing: the computer is 证书变了 until its Host proves a certificate.
    const sent: Array<Record<string, string>> = []
    const proxy = remote.createRemoteProxy({
      hostId: HOST_B,
      origin: 'https://mini.example.ts.net',
      store: reread,
      request: async (_origin, init) => {
        sent.push({ ...init.headers })
        const body = JSON.stringify({ ok: true, hostId: HOST_B })
        const response = Object.assign(Readable.from([Buffer.from(body)]), {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
        })
        return { request: { destroy() {} }, response, certificate: pin } as unknown as Exchange
      },
    })
    expect((await proxy.probe()).state).toBe('cert-changed')
    expect(sent.every(headers => headers.cookie === undefined)).toBe(true)
  })

  it('connects to an IPv6 address without the brackets of its URL', async () => {
    const root = await directory()
    const tls = await makeTestTls(join(root, 'tls'))
    let connected = 0
    const server = createTlsServer({ cert: await readFile(tls.certPath), key: await readFile(tls.keyPath) }, socket => socket.destroy())
    server.on('connection', () => {
      connected += 1
    })
    await new Promise<void>(done => server.listen(0, '::1', done))
    cleanups.push(() => new Promise<void>(done => server.close(() => done())))
    const { port } = server.address() as AddressInfo
    const original = remote.tlsOptions
    remote.tlsOptions = () => ({ ca: [tls.ca] })
    cleanups.push(async () => {
      remote.tlsOptions = original
    })
    // The test certificate names latch-test.localhost, not ::1: the address is reached and the name check refuses it.
    const failure = await remote
      .httpsRequest(`https://[::1]:${port}`, { path: '/link/api/health', timeoutMs: 5_000 })
      .catch((error: unknown) => error)
    expect(connected).toBe(1)
    expect(String((failure as { code?: string }).code)).toMatch(/CERT|ALTNAME|IP/u)
  })
})

describe('a stalled handshake', () => {
  it('ends at once when the request times out, not at the handshake limit', async () => {
    let closedAt = 0
    const sockets = new Set<import('node:net').Socket>()
    const server = createNetServer(socket => {
      sockets.add(socket)
      // Accepts the connection and reads the TLS hello but never answers it.
      socket.resume()
      socket.on('close', () => {
        closedAt = Date.now()
      })
      socket.on('error', () => {})
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanups.push(
      () =>
        new Promise<void>(done => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
    )
    const { port } = server.address() as AddressInfo
    const started = Date.now()
    const failure = await remote
      .httpsRequest(`https://127.0.0.1:${port}`, { path: '/link/api/health', timeoutMs: 300 })
      .catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toBe('ETIMEDOUT')
    await new Promise(done => setTimeout(done, 200))
    expect(closedAt).toBeGreaterThan(0)
    expect(closedAt - started).toBeLessThan(2_000)
  })
})

describe('the certificate proof (security vector)', () => {
  it('builds the shared text and accepts only the vector’s signature by the key the hostId names', () => {
    const vector = HOST_PROOF_SIGNING_VECTOR.example
    expect(remote.certificateProofText(vector.hostId, vector.nonce, vector.certificate)).toBe(vector.text)
    const answer = { publicKey: vector.publicKey, signature: vector.signature }
    expect(remote.verifyCertificateProof(answer, vector.hostId, vector.nonce, vector.certificate)).toBe(true)
    // Another certificate, nonce or hostId, or a key that the hostId does not name, is refused.
    const other = vector.certificate.replace(/^00/u, 'FF')
    expect(remote.verifyCertificateProof(answer, vector.hostId, vector.nonce, other)).toBe(false)
    expect(remote.verifyCertificateProof(answer, vector.hostId, `${vector.nonce}x`, vector.certificate)).toBe(false)
    expect(remote.verifyCertificateProof(answer, HOST_A, vector.nonce, vector.certificate)).toBe(false)
    const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const forged = {
      publicKey: stranger.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      signature: sign('sha256', Buffer.from(vector.text), { key: stranger.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    }
    expect(remote.verifyCertificateProof(forged, vector.hostId, vector.nonce, vector.certificate)).toBe(false)
  })
})

describe('what waits on other computers', () => {
  type Answer = { state: string; snapshot?: unknown; name?: string; version?: string }
  const HOST_C = 'c'.repeat(52)
  const snapshotOf = (approvals: number, running = 0) => ({
    hostName: 'build-mini.local',
    version: '0.9.1',
    tasks: [
      ...Array.from({ length: approvals }, (_, index) => ({
        id: `wait-${index}`,
        title: `会话 ${index}`,
        status: 'waiting-approval',
        updatedAt: new Date(1_000 + index).toISOString(),
      })),
      ...Array.from({ length: running }, (_, index) => ({
        id: `run-${index}`,
        title: '跑着',
        status: 'running',
        updatedAt: '2026-11-12T08:00:00Z',
      })),
    ],
    approvals: Array.from({ length: approvals }, (_, index) => ({
      id: `approval-${index}`,
      sessionId: `wait-${index}`,
      toolName: 'write',
      reason: '写入 /secret/path',
      arguments: '{"path":"/secret/path"}',
      requestedAt: new Date(2_000 + index).toISOString(),
    })),
  })

  async function registry(
    answers: Map<string, () => { state: string; snapshot?: unknown; name?: string; version?: string }>,
    focus = { value: true },
  ) {
    const userData = await directory()
    await computers.writeComputers(userData, [record(HOST_B), record(HOST_C, { origin: 'https://other.example.ts.net', name: 'other' })])
    const timers: Array<{ at: number; run: () => void; cleared: boolean; ms: number; hostId?: string }> = []
    const snapshots: Array<[string, unknown]> = []
    let changes = 0
    let time = 1_000_000
    const hooks: { change?: (kind: string) => void } = {}
    const reg = computers.createComputers({
      directory: userData,
      localHostId: HOST_A,
      local: () => ({ state: 'online' }),
      openStore: async (hostId: string) => ({
        hostId,
        current: () => ({ deviceId: 'device', credential: 'ldc1.test' }),
        binding: () => undefined,
        clear: async () => {},
      }),
      makeProxy: ({ hostId }: { hostId: string }) => ({
        probe: async () => answers.get(hostId)!(),
        revokeSelf: async () => true,
      }),
      enroll: () => Promise.reject(new Error('not reached')),
      parseLink: () => undefined,
      focused: () => focus.value,
      onSnapshot: (hostId: string, snapshot: unknown) => snapshots.push([hostId, snapshot]),
      onChange: (kind: string) => {
        changes += 1
        hooks.change?.(kind)
      },
      now: () => time,
      setTimer: (run: () => void, ms: number) => {
        const timer = { at: time + ms, run, cleared: false, ms }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer: { cleared: boolean }) => {
        timer.cleared = true
      },
    })
    cleanups.push(async () => {
      reg.stop()
      // Stopping probes does not finish the last atomic metadata write; keep its directory until it settles.
      await reg.settled()
    })
    return {
      reg,
      snapshots,
      timers,
      changes: () => changes,
      hooks,
      advance: (ms: number) => {
        time += ms
      },
    }
  }

  it('lists the newest 50 titles and kinds of each computer to this Mac’s page alone, and counts only computers that answer', async () => {
    const answers = new Map<string, () => Answer>([
      [HOST_B, () => ({ state: 'online', name: 'build-mini', version: '0.9.1', snapshot: snapshotOf(60, 2) })],
      [HOST_C, () => ({ state: 'online', name: 'other', snapshot: snapshotOf(1) })],
    ])
    const { reg, snapshots } = await registry(answers)
    await reg.start()
    await vi.waitFor(() => expect(reg.waitingTotal()).toBe(61))
    const full = reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!
    const waiting = full.waiting as Array<Record<string, unknown>>
    expect(waiting).toHaveLength(50)
    expect(full.running).toBe(2)
    expect(waiting[0]).toEqual({
      hostId: HOST_B,
      taskId: 'wait-59',
      title: '会话 59',
      kind: 'approval',
      since: new Date(2_059).toISOString(),
    })
    // Nothing of the request itself crosses: no reason, argument or path.
    expect(JSON.stringify(reg.view({ full: true }))).not.toContain('/secret/path')
    // Another computer's page gets names and states only, never what waits elsewhere.
    for (const item of reg.view().computers) {
      expect(item.waiting).toBeUndefined()
      expect(item.running).toBeUndefined()
    }
    expect(reg.waits(HOST_B, 'wait-59')).toBe(true)
    expect(reg.waits(HOST_B, 'wait-0')).toBe(false)
    expect(reg.waits(HOST_C, 'wait-59')).toBe(false)
    expect(snapshots.map(([hostId]) => hostId).sort()).toEqual([HOST_B, HOST_C].sort())
    expect(reg.nameOf(HOST_B)).toBe('build-mini')

    // B stops answering: what waited stays as 离线前, and the Dock no longer counts it.
    answers.set(HOST_B, () => ({ state: 'offline' }))
    await reg.probe(HOST_B)
    const away = reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!
    expect(away.state).toBe('offline')
    expect(away.waiting).toHaveLength(50)
    expect(reg.waitingTotal()).toBe(1)

    // B removed this device: nothing it said before stands.
    answers.set(HOST_B, () => ({ state: 'revoked' }))
    await reg.probe(HOST_B)
    expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.waiting).toBeUndefined()
  })

  it('keeps each computer’s Code sessions for this Mac’s page alone: ID, title, status, time and project, nothing else', async () => {
    const snapshot = {
      catalog: {
        workspaces: [
          { id: 'web', name: '官网', path: '/secret/path/web' },
          { id: 'default', name: '默认' },
        ],
      },
      tasks: [
        { id: 'a', title: '首页改版', status: 'running', workspaceId: 'web', cwd: '/secret/path/web', updatedAt: '2026-11-12T08:00:03Z' },
        { id: 'b', title: '修登录\u202e', status: 'waiting-approval', updatedAt: '2026-11-12T08:00:02Z', model: { model: 'secret-model' } },
        { id: 'c', title: '归档的', status: 'idle', archived: true, updatedAt: '2026-11-12T08:00:04Z' },
        { id: 'd', title: '我的 Agent', status: 'idle', agent: { customAgentId: 'agt' }, updatedAt: '2026-11-12T08:00:05Z' },
        { id: 'has space', title: 'x', status: 'idle', updatedAt: '2026-11-12T08:00:06Z' },
        { id: 'e', title: '失败的', status: 'failed', workspaceId: 'gone', updatedAt: '2026-11-12T08:00:01Z' },
      ],
      approvals: [],
    }
    const answers = new Map<string, () => Answer>([
      [HOST_B, () => ({ state: 'online', name: 'build-mini', snapshot })],
      [HOST_C, () => ({ state: 'online', name: 'other', snapshot: snapshotOf(0) })],
    ])
    const { reg } = await registry(answers)
    await reg.start()
    await vi.waitFor(() => expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.sessions).toBeDefined())
    const sessions = reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.sessions
    expect(sessions).toEqual([
      { taskId: 'a', title: '首页改版', status: 'running', updatedAt: '2026-11-12T08:00:03.000Z', project: { id: 'web', name: '官网' } },
      { taskId: 'b', title: '修登录', status: 'waiting', updatedAt: '2026-11-12T08:00:02.000Z' },
      { taskId: 'e', title: '失败的', status: 'failed', updatedAt: '2026-11-12T08:00:01.000Z' },
    ])
    expect(JSON.stringify(reg.view({ full: true }))).not.toContain('/secret/path')
    expect(JSON.stringify(reg.view({ full: true }))).not.toContain('secret-model')
    for (const item of reg.view().computers) expect(item.sessions).toBeUndefined()
    // Each computer's rows are its own; a session is opened on the computer main saw it on, never another.
    expect(reg.waits(HOST_B, 'a')).toBe(true)
    expect(reg.waits(HOST_C, 'a')).toBe(false)
    expect(reg.waits(HOST_B, 'c')).toBe(false)
    // Away, the rows stay as main last read them; removed, they go.
    answers.set(HOST_B, () => ({ state: 'offline' }))
    await reg.probe(HOST_B)
    expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.sessions).toHaveLength(3)
    answers.set(HOST_B, () => ({ state: 'revoked' }))
    await reg.probe(HOST_B)
    expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.sessions).toBeUndefined()
    expect(reg.waits(HOST_B, 'a')).toBe(false)
  })

  it('keeps looking at a computer whose snapshot is malformed or whose look fails, and applies its looks in order', async () => {
    let answer: () => Promise<Answer> | Answer = () => ({
      state: 'online',
      snapshot: { tasks: [null, 'x', { id: 'has space' }], approvals: [null] },
    })
    const answers = new Map<string, () => Answer>([
      [HOST_B, () => answer() as Answer],
      [HOST_C, () => ({ state: 'online', snapshot: snapshotOf(0) })],
    ])
    const { reg, timers } = await registry(answers)
    await reg.start()
    const forB = () => timers.filter(timer => !timer.cleared).length
    await vi.waitFor(() => expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.state).toBe('online'))
    expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.waiting).toEqual([])
    expect(forB()).toBe(2)
    // A look that throws or rejects: the computer is looked at again all the same.
    answer = () => {
      throw new Error('broken')
    }
    await reg.probe(HOST_B)
    expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.state).toBe('offline')
    expect(forB()).toBe(2)
    // Two looks at once apply in the order they were asked for: the later snapshot is the one that stands.
    let release: () => void = () => {}
    const gate = new Promise<void>(done => {
      release = done
    })
    const sequence = [
      async () => {
        await gate
        return { state: 'online', snapshot: snapshotOf(1) }
      },
      async () => ({ state: 'online', snapshot: snapshotOf(2) }),
    ]
    answer = () => sequence.shift()!() as unknown as Answer
    const first = reg.probe(HOST_B)
    const second = reg.probe(HOST_B)
    release()
    await Promise.all([first, second])
    expect(reg.view({ full: true }).computers.find(item => item.hostId === HOST_B)!.waiting).toHaveLength(2)
  })

  it('sends another computer’s window nothing while what waits elsewhere comes and goes, as probes move time on', async () => {
    let waiting = 0
    const answers = new Map<string, () => Answer>([
      [HOST_B, () => ({ state: 'online', name: 'build-mini', snapshot: snapshotOf(waiting) })],
      [HOST_C, () => ({ state: 'online', name: 'other', snapshot: snapshotOf(0) })],
    ])
    const { reg, hooks, advance } = await registry(answers)
    // As main.cjs broadcasts: this Mac's page always, other computers' windows never for `attention`.
    const pushes: Array<[unknown, unknown]> = []
    const send = computers.createViewSender((target, view) => pushes.push([target, view]))
    const windowOfC = {}
    const freshC = {}
    await reg.start()
    await vi.waitFor(() => expect(reg.view({ full: true }).computers.every(item => item.local || item.state === 'online')).toBe(true))
    // C's window has read the list (list() records what it answered); a window opened just now has too.
    send.seen(windowOfC, reg.view())
    hooks.change = kind => {
      if (kind === 'attention') return
      send(windowOfC, reg.view())
      send(freshC, reg.view())
    }
    send.seen(freshC, reg.view())
    for (const count of [1, 3, 0, 2, 0]) {
      waiting = count
      advance(15_000)
      await reg.probe(HOST_B)
      await reg.probe(HOST_C)
      expect(reg.waitingTotal()).toBe(count)
    }
    expect(pushes).toEqual([])
    // A change C can see (B goes away) still reaches it, with when B was last seen to the minute.
    answers.set(HOST_B, () => ({ state: 'offline' }))
    advance(15_000)
    await reg.probe(HOST_B)
    expect(pushes).toHaveLength(2)
    const seen = (pushes[0]![1] as { computers: Array<Record<string, unknown>> }).computers.find(item => item.hostId === HOST_B)!
    expect(Date.parse(String(seen.lastSeenAt)) % 60_000).toBe(0)
    expect(reg.view().computers.find(item => item.hostId === HOST_C)!.lastSeenAt).toBeUndefined()
  })

  it('looks every 15 seconds in front, every minute behind, sooner again when a window comes forward, and backs off while away', async () => {
    const focus = { value: false }
    const answers = new Map<string, () => Answer>([
      [HOST_B, () => ({ state: 'online', snapshot: snapshotOf(1) })],
      [HOST_C, () => ({ state: 'offline' })],
    ])
    const { reg, timers, advance } = await registry(answers, focus)
    await reg.start()
    await vi.waitFor(() => expect(reg.waitingTotal()).toBe(1))
    const live = () => timers.filter(timer => !timer.cleared)
    // B answers and no window is in front: a minute. C is away: 15 seconds, then longer.
    expect(
      live()
        .map(timer => timer.ms)
        .sort((a, b) => a - b),
    ).toEqual([15_000, 60_000])
    focus.value = true
    advance(1_000)
    reg.refocus()
    expect(
      live()
        .map(timer => timer.ms)
        .sort((a, b) => a - b),
    ).toEqual([15_000, 15_000])
    // A second refocus does not push the next look further away.
    const before = live().map(timer => timer.at)
    advance(1_000)
    reg.refocus()
    expect(live().map(timer => timer.at)).toEqual(before)
    // C keeps not answering: 15 s, 30 s, 60 s … five minutes.
    const delays: number[] = []
    for (let index = 0; index < 8; index++) {
      await reg.probe(HOST_C)
      delays.push(live().at(-1)!.ms)
    }
    expect(delays.slice(0, 3)).toEqual([30_000, 60_000, 120_000])
    expect(delays.at(-1)).toBe(300_000)
  })
})

describe('the computers preload', () => {
  type Shell = {
    remote?: true
    computers: {
      list(): Promise<{ computers: Array<Record<string, unknown>> } | undefined>
      open(hostId: string, taskId?: string): Promise<unknown>
      subscribeSession?(callback: (id: string) => void): () => void
    }
  }
  async function load(href: string) {
    const listeners = new Map<string, (event: unknown, value: unknown) => void>()
    const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }))
    let shell: Shell | undefined
    runInNewContext(await readFile('apps/desktop/src/preload.cjs', 'utf8'), {
      process: { platform: 'darwin' },
      location: { href },
      URL,
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name: string, value: Shell) => {
            shell = value
          },
        },
        ipcRenderer: {
          invoke,
          on: (name: string, listener: (event: unknown, value: unknown) => void) => listeners.set(name, listener),
          removeListener: (name: string) => listeners.delete(name),
        },
        webUtils: { getPathForFile: () => '' },
      }),
    })
    return { shell: shell!, invoke, listeners }
  }
  const item = { hostId: HOST_B, taskId: 'wait-1', title: '添加币种筛选', kind: 'approval', since: '2026-11-12T08:00:00.000Z' }
  const view = {
    computers: [
      { hostId: HOST_A, name: 'studio', local: true, state: 'online' },
      { hostId: HOST_B, name: 'build-mini', local: false, state: 'online', waiting: [item], running: 2 },
    ],
  }

  it('gives this Mac’s page what waits elsewhere, checked field by field, and opens a session only from it', async () => {
    const { shell, invoke } = await load('latch://app/link/')
    invoke.mockResolvedValueOnce(view)
    expect((await shell.computers.list())!.computers[1]).toMatchObject({ waiting: [item], running: 2 })
    for (const bad of [
      { ...item, hostId: HOST_A },
      { ...item, kind: 'message' },
      { ...item, title: 'a\u0000b' },
      { ...item, title: 'x'.repeat(81) },
      { ...item, taskId: '../x' },
      { ...item, body: undefined, since: 'yesterday' },
    ]) {
      invoke.mockResolvedValueOnce({ computers: [view.computers[0], { ...view.computers[1], waiting: [bad] }] })
      expect((await shell.computers.list())!.computers[1]!.waiting, JSON.stringify(bad)).toBeUndefined()
    }
    // One malformed item or count drops what waits on that computer alone; the list stays.
    for (const bad of [{ waiting: [{ ...item, taskId: 'has space' }] }, { running: 1e12 }, { waiting: 'x' }]) {
      invoke.mockResolvedValueOnce({ computers: [view.computers[0], { ...view.computers[1], ...bad }] })
      const listed = await shell.computers.list()
      expect(listed!.computers, JSON.stringify(bad)).toHaveLength(2)
      expect(listed!.computers[1]).toEqual({ hostId: HOST_B, name: 'build-mini', local: false, state: 'online' })
    }
    invoke.mockResolvedValueOnce({ computers: [{ ...view.computers[0], waiting: [item] }] })
    expect((await shell.computers.list())!.computers[0]!.waiting).toBeUndefined()
    await shell.computers.open(HOST_B, 'wait-1')
    expect(invoke).toHaveBeenLastCalledWith('latch:computers:open', HOST_B, 'wait-1')
    await shell.computers.open(HOST_B, '../x')
    expect(invoke).toHaveBeenLastCalledWith('latch:computers:open', HOST_B)
    expect(shell.computers.subscribeSession).toBeUndefined()
  })

  it('gives this Mac’s page each computer’s sessions checked field by field, and another computer’s page none', async () => {
    const session = {
      taskId: 'a',
      title: '首页改版',
      status: 'running',
      updatedAt: '2026-11-12T08:00:00.000Z',
      project: { id: 'web', name: '官网' },
    }
    const withSessions = { computers: [view.computers[0], { ...view.computers[1], sessions: [session] }] }
    const local = await load('latch://app/link/')
    local.invoke.mockResolvedValueOnce(withSessions)
    expect((await local.shell.computers.list())!.computers[1]!.sessions).toEqual([session])
    for (const bad of [
      { ...session, status: 'thinking' },
      { ...session, title: 'a\u0000b' },
      { ...session, taskId: '../x' },
      { ...session, project: { id: 'a/b', name: 'x' } },
      { ...session, project: { id: 'web', name: '' } },
      { ...session, updatedAt: 'soon' },
    ]) {
      local.invoke.mockResolvedValueOnce({ computers: [view.computers[0], { ...view.computers[1], sessions: [bad] }] })
      const listed = await local.shell.computers.list()
      expect(listed!.computers[1]!.sessions, JSON.stringify(bad)).toBeUndefined()
      expect(listed!.computers[1]!.waiting).toEqual([item])
    }
    local.invoke.mockResolvedValueOnce({ computers: [{ ...view.computers[0], sessions: [session] }] })
    expect((await local.shell.computers.list())!.computers[0]!.sessions).toBeUndefined()
    const remote = await load(`latch://h-${HOST_B}/link/`)
    remote.invoke.mockResolvedValueOnce(withSessions)
    expect((await remote.shell.computers.list())!.computers.every(computer => computer.sessions === undefined)).toBe(true)
  })

  it('starts a new session on a computer from any window, and holds a start asked before the page listens', async () => {
    const { shell, invoke, listeners } = await load(`latch://h-${HOST_B}/link/`)
    const computers = shell.computers as Shell['computers'] & {
      start(hostId: string): Promise<unknown>
      subscribeStart(callback: () => void): () => void
    }
    await computers.start(HOST_A)
    expect(invoke).toHaveBeenLastCalledWith('latch:computers:start', HOST_A)
    invoke.mockClear()
    await computers.start('not a host')
    expect(invoke).not.toHaveBeenCalled()
    listeners.get('latch:computers:start-here')!({}, undefined)
    const started = vi.fn()
    const stop = computers.subscribeStart(started)
    expect(started).toHaveBeenCalledTimes(1)
    listeners.get('latch:computers:start-here')!({}, undefined)
    expect(started).toHaveBeenCalledTimes(2)
    stop()
    expect(listeners.has('latch:computers:start-here')).toBe(false)
  })

  it('never gives another computer’s page what waits elsewhere, and opens there only sessions main sends', async () => {
    const { shell, invoke, listeners } = await load(`latch://h-${HOST_B}/link/`)
    expect(shell.remote).toBe(true)
    invoke.mockResolvedValueOnce(view)
    const listed = await shell.computers.list()
    expect(listed!.computers.every(computer => computer.waiting === undefined && computer.running === undefined)).toBe(true)
    await shell.computers.open(HOST_A, 'wait-1')
    expect(invoke).toHaveBeenLastCalledWith('latch:computers:open', HOST_A)
    // A session main asks it to open before the page subscribes waits for the first subscriber, once.
    listeners.get('latch:computers:session')!({}, 'not a session id!')
    listeners.get('latch:computers:session')!({}, 'wait-1')
    const opened = vi.fn()
    const stop = shell.computers.subscribeSession!(opened)
    expect(opened.mock.calls).toEqual([['wait-1']])
    listeners.get('latch:computers:session')!({}, 'wait-2')
    expect(opened.mock.calls).toEqual([['wait-1'], ['wait-2']])
    stop()
    expect(listeners.has('latch:computers:session')).toBe(false)
  })
})

describe('main’s 新会话 on a computer (latch:computers:start)', () => {
  const { isAppUrl } = require('../src/proxy.cjs') as { isAppUrl(url: string, home?: string): boolean }
  const mainContents = { id: 'main' }
  const bContents = { id: 'b' }
  const homes = new Map<unknown, string>([
    [mainContents, 'app'],
    [bContents, `h-${HOST_B}`],
  ])
  const senderOf = computers.createSenderOf({
    homeOf: (contents: unknown) => homes.get(contents) ?? 'app',
    isAppUrl,
    localHome: 'app',
    mainContents: () => mainContents,
    remoteContents: (hostId: string) => (hostId === HOST_B ? bContents : undefined),
    has: (hostId: string) => hostId === HOST_A || hostId === HOST_B || hostId === HOST_C,
  })
  const HOST_C = 'c'.repeat(52)
  const event = (sender: unknown, url: string, parent: unknown = null) => ({ sender, senderFrame: { url, parent } })
  function handler(gesture = true) {
    const started: string[] = []
    const start = computers.createStartHandler({
      senderOf,
      gestureOf: () => gesture,
      has: (hostId: string) => hostId === HOST_A || hostId === HOST_B || hostId === HOST_C,
      localHostId: HOST_A,
      startOn: (hostId: string) => {
        started.push(hostId)
        return { ok: true }
      },
    })
    return { start, started }
  }

  it('starts on a listed computer from this Mac’s page after a real gesture', () => {
    const { start, started } = handler()
    expect(start(event(mainContents, 'latch://app/link/'), HOST_B)).toEqual({ ok: true })
    expect(start(event(bContents, `latch://h-${HOST_B}/link/`), HOST_A)).toEqual({ ok: true })
    expect(start(event(bContents, `latch://h-${HOST_B}/link/`), HOST_B)).toEqual({ ok: true })
    expect(started).toEqual([HOST_B, HOST_A, HOST_B])
  })

  it('refuses an unknown frame, a child frame, a null origin, no gesture, an unknown computer and another’s computer', () => {
    const { start, started } = handler()
    const refused = { ok: false, error: 'forbidden' }
    expect(start(event({ id: 'stranger' }, 'latch://app/link/'), HOST_B)).toMatchObject(refused)
    expect(start(event(mainContents, 'latch://app/link/', { url: 'latch://app/link/' }), HOST_B)).toMatchObject(refused)
    expect(start(event(mainContents, 'null'), HOST_B)).toMatchObject(refused)
    expect(start(event(mainContents, 'about:blank'), HOST_B)).toMatchObject(refused)
    expect(start(event(mainContents, `latch://h-${HOST_B}/link/`), HOST_B)).toMatchObject(refused)
    expect(start({ sender: mainContents }, HOST_B)).toMatchObject(refused)
    expect(start(event(mainContents, 'latch://app/link/'), 'z'.repeat(52))).toMatchObject({ error: 'computer-not-found' })
    expect(start(event(mainContents, 'latch://app/link/'), 42)).toMatchObject({ error: 'computer-not-found' })
    // A remote computer's page starts only on itself or this Mac, never on a third computer.
    expect(start(event(bContents, `latch://h-${HOST_B}/link/`), HOST_C)).toMatchObject(refused)
    expect(handler(false).start(event(mainContents, 'latch://app/link/'), HOST_B)).toMatchObject({ error: 'gesture-required' })
    expect(started).toEqual([])
  })

  it('checks the computer before it uses up the gesture', () => {
    let gestures = 1
    const start = computers.createStartHandler({
      senderOf,
      gestureOf: () => gestures-- > 0,
      has: (hostId: string) => hostId === HOST_A || hostId === HOST_B,
      localHostId: HOST_A,
      startOn: () => ({ ok: true }),
    })
    expect(start(event(mainContents, 'latch://app/link/'), 'z'.repeat(52))).toMatchObject({ error: 'computer-not-found' })
    expect(start(event(bContents, `latch://h-${HOST_B}/link/`), 'c'.repeat(52))).toMatchObject({ error: 'computer-not-found' })
    expect(start(event(mainContents, 'latch://app/link/'), HOST_B)).toEqual({ ok: true })
  })

  it('sends once a page loads, and leaves no handler behind when the load fails or the window goes', async () => {
    const { EventEmitter } = await import('node:events')
    const make = (loading: boolean) => Object.assign(new EventEmitter(), { isLoading: () => loading })
    const sent: string[] = []
    const now = make(false)
    computers.whenLoaded(now, () => sent.push('now'))
    const later = make(true)
    computers.whenLoaded(later, () => sent.push('later'))
    expect(sent).toEqual(['now'])
    later.emit('did-finish-load')
    expect(sent).toEqual(['now', 'later'])
    for (const ending of ['did-fail-load', 'destroyed']) {
      const failing = make(true)
      computers.whenLoaded(failing, () => sent.push(ending))
      failing.emit(ending)
      expect(failing.eventNames()).toEqual([])
    }
    expect(later.eventNames()).toEqual([])
    expect(sent).toEqual(['now', 'later'])
  })
})
