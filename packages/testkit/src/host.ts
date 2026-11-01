import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import type { ConfirmationTicket, Device, DeviceScope, EnrollmentView, InvitationView } from '@latch/protocol'
import { enrollSigningText, foldersBodyHash, foldersSigningText, renewSigningText, testDeviceKey, type TestDeviceKey } from './crypto.ts'
import { createTestPresence, type TestPresence } from './presence.ts'
import { makeTestTls } from './tls.ts'

export type TestListener = 'unix' | 'loopback-tcp' | 'tls'

/** An HTTPS listener as the Host's `startServer({ tls })` takes it. */
export interface TestTlsListener {
  host: string
  port: number
  certPath: string
  keyPath: string
  publicOrigin: string
  /** Lets peers on a local interface address connect, as tests on 127.0.0.1 must; the Host rejects them otherwise. */
  allowLocalPeers?: boolean
}

/** The parts of a started Host that the fixture uses. */
export interface FixtureHost {
  hostId: string
  hostId8: string
  /** http://h-<hostId>.localhost:<port> */
  loopbackOrigin: string
  tlsOrigin?: string
  socketPath: string
  close(): Promise<void>
}

export interface HostFixtureOptions {
  presenceMode?: TestPresence['mode']
  /** `true`: a self-signed `latch-test.localhost` certificate on 127.0.0.1 with local peers allowed. */
  tls?: boolean | TestTlsListener
  /** Default `<root>/data`. */
  dataDir?: string
  /** Default `<root>/workspace`. */
  workspaceRoot?: string
}

/** What the fixture prepared for the Host it is about to start, all inside its temp directory unless given. */
export interface HostFixtureSetup {
  dataDir: string
  workspaceRoot: string
  /** 0700; parent of the Host's runtime directory, so host.sock stays short and inside the temp directory. */
  runtimeParent: string
  presence: TestPresence
  tls?: TestTlsListener
}

export interface TestRequestInit {
  method?: string
  body?: unknown
  rawBody?: Uint8Array
  headers?: Record<string, string>
  /** Sent as `x-latch-confirmation`. */
  confirmation?: string
  signal?: AbortSignal
}

export interface TestDevice {
  id: string
  listener: TestListener
  credential: string
  /** 'name=value' for TCP devices. */
  cookie?: string
  key: TestDeviceKey
  device: Device
  /** Path under /link/api/. */
  request(path: string, init?: TestRequestInit): Promise<Response>
  /** Throws `{ status, body }` when the response is not ok. */
  json<T>(path: string, init?: TestRequestInit): Promise<T>
  /** Performs the request; on 403 stepup-required with a confirmation, approves via presence and retries with the header. */
  confirmed(path: string, init?: TestRequestInit): Promise<Response>
  renew(): Promise<void>
  /**
   * Adds folders the way the desktop app's main process does: a nonce from `folder-grants`, then a body signed with
   * this device's key. Without `projectId` it creates a project. `sign` may alter what is signed, to test refusals.
   */
  addFolders(input: AddFoldersInput): Promise<Response>
  /** 存为项目 the way the desktop app's main process does it: a new project from the session's own folder, signed. */
  saveSessionFolder(input: SaveSessionFolderInput): Promise<Response>
}

export interface SaveSessionFolderInput {
  sessionId: string
  /** Tests: the body that is hashed and signed, when it should differ from the one sent. */
  signedBody?: (body: Record<string, unknown>) => Record<string, unknown>
  /** Tests: a nonce to use instead of a fresh one. */
  nonce?: string
}

export interface AddFoldersInput {
  paths: string[]
  projectId?: string
  name?: string
  replace?: string
  via?: 'picker' | 'drop'
  /** Tests: the body that is hashed and signed, when it should differ from the one sent. */
  signedBody?: (body: Record<string, unknown>) => Record<string, unknown>
  /** Tests: a nonce to use instead of a fresh one. */
  nonce?: string
}

export interface HostFixture<H extends FixtureHost = FixtureHost> {
  host: H
  presence: TestPresence
  dataDir: string
  workspaceRoot: string
  /** Temp directory holding data, workspace, runtime parent and TLS material; removed by `close`. */
  root: string
  /** Present with `tls`. */
  tlsCa?: string
  /**
   * Enrolls a device through the real API. Off host.sock it first gets an invitation for that listener unless given an
   * invitation or an offline code, as every listener but host.sock requires one.
   */
  enroll(options?: {
    listener?: TestListener
    name?: string
    scopes?: DeviceScope[]
    invitation?: string
    offlineCode?: string
  }): Promise<TestDevice>
  /** Anonymous unix invitation for the TLS entry (needs TLS), or with `'loopback-tcp'` for a browser on loopback. */
  invite(scopes?: DeviceScope[], listener?: Exclude<TestListener, 'unix'>): Promise<InvitationView>
  /** Path under /link/. */
  raw(listener: TestListener, path: string, init?: TestRequestInit): Promise<Response>
  close(): Promise<void>
}

export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`)
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** `*.localhost` resolves to 127.0.0.1 in tests, as browsers do. */
function localhostLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
    else callback(null, '127.0.0.1', 4)
    return
  }
  dnsLookup(hostname, options as never, callback as never)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

function setCookieOf(response: Response, prefix: string): string | undefined {
  const values = (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
  return values.map(value => value.split(';')[0]!).find(value => value.startsWith(prefix) && !value.endsWith('='))
}

/**
 * Starts a Host on fresh temp directories with test presence and clients for all three transports. `start` gets what
 * the fixture prepared and starts the Host with it; the Host's own options and defaults stay with the caller, so this
 * package never imports the Host (apps/host/test/helpers/host.ts, apps/desktop/test/helpers/host.ts and
 * e2e/helpers/host.ts bind it to `startServer` as `startTestHost`). The temp directory is removed when `start` fails or
 * on `close`.
 */
export async function startHostFixture<H extends FixtureHost>(
  start: (setup: HostFixtureSetup) => Promise<H>,
  options: HostFixtureOptions = {},
): Promise<HostFixture<H>> {
  const root = await mkdtemp(join(tmpdir(), 'lt-'))
  const runtimeParent = join(root, 'r')
  await mkdir(runtimeParent, { mode: 0o700 })
  const presence = createTestPresence({ mode: options.presenceMode ?? 'approve' })
  let tls: TestTlsListener | undefined
  let tlsCa: string | undefined
  if (options.tls === true) {
    const material = await makeTestTls(join(root, 'tls'))
    const port = await freePort()
    tls = {
      host: '127.0.0.1',
      port,
      certPath: material.certPath,
      keyPath: material.keyPath,
      publicOrigin: `https://${material.hostname}:${port}`,
      allowLocalPeers: true,
    }
    tlsCa = material.ca
  } else if (options.tls) {
    tls = options.tls
    tlsCa = await readFile(options.tls.certPath, 'utf8')
  }
  const dataDir = options.dataDir ?? join(root, 'data')
  const workspaceRoot = options.workspaceRoot ?? join(root, 'workspace')
  let host: H
  try {
    host = await start({ dataDir, workspaceRoot, runtimeParent, presence, ...(tls ? { tls } : {}) })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const agents: Record<TestListener, Agent | undefined> = {
    unix: new Agent({ connect: { socketPath: host.socketPath } }),
    'loopback-tcp': new Agent({ connect: { lookup: localhostLookup as never } }),
    tls: tlsCa ? new Agent({ connect: { ca: tlsCa, lookup: localhostLookup as never } }) : undefined,
  }

  function raw(listener: TestListener, path: string, init: TestRequestInit = {}): Promise<Response> {
    const dispatcher = agents[listener]
    if (!dispatcher) throw new Error(`listener ${listener} is not configured`)
    const base = listener === 'unix' ? 'http://latch.unix' : listener === 'tls' ? host.tlsOrigin! : host.loopbackOrigin
    const headers: Record<string, string> = {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.confirmation ? { 'x-latch-confirmation': init.confirmation } : {}),
      ...init.headers,
    }
    return undiciFetch(`${base}/link/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      dispatcher,
      redirect: 'manual',
      ...(init.rawBody !== undefined
        ? { body: init.rawBody }
        : init.body !== undefined
          ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }
          : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    }) as unknown as Promise<Response>
  }

  async function invite(scopes?: DeviceScope[], listener: Exclude<TestListener, 'unix'> = 'tls'): Promise<InvitationView> {
    const request = { ...(scopes ? { scopes } : {}), ...(listener === 'loopback-tcp' ? { target: 'loopback' } : {}) }
    const response = await raw('unix', 'api/pairings', { method: 'POST', body: request })
    const body = (await response.json()) as { invitation: InvitationView }
    if (response.status !== 201) throw new HttpFailure(response.status, body)
    return body.invitation
  }

  async function settleConfirmation(id: string, poll: (path: string) => Promise<Response>): Promise<ConfirmationTicket['status']> {
    if (presence.mode === 'manual') {
      await presence.waitForRequest()
      presence.approveNext()
    }
    for (let attempt = 0; attempt < 250; attempt++) {
      const response = await poll(id)
      const body = (await response.json()) as { enrollment?: EnrollmentView; confirmation?: ConfirmationTicket }
      const status = body.enrollment?.status ?? body.confirmation?.status
      if (!status) throw new HttpFailure(response.status, body)
      if (status !== 'pending') return status as ConfirmationTicket['status']
      await delay(20)
    }
    throw new Error('confirmation did not settle')
  }

  function makeDevice(listener: TestListener, key: TestDeviceKey, device: Device, credential: string, cookieName?: string): TestDevice {
    const state = { credential, device }
    const authHeaders = (): Record<string, string> =>
      listener === 'unix' ? { authorization: `Latch-Device ${state.credential}` } : { cookie: `${cookieName}=${state.credential}` }
    const testDevice: TestDevice = {
      id: device.id,
      listener,
      key,
      get credential() {
        return state.credential
      },
      get cookie() {
        return listener === 'unix' ? undefined : `${cookieName}=${state.credential}`
      },
      get device() {
        return state.device
      },
      request(path, init = {}) {
        return raw(listener, `api/${path}`, { ...init, headers: { ...authHeaders(), ...init.headers } })
      },
      async json<T>(path: string, init?: TestRequestInit): Promise<T> {
        const response = await testDevice.request(path, init)
        const text = await response.text()
        const body = text ? JSON.parse(text) : undefined
        if (!response.ok) throw new HttpFailure(response.status, body)
        return body as T
      },
      async confirmed(path, init = {}) {
        const first = await testDevice.request(path, init)
        if (first.status !== 403) return first
        const body = (await first.clone().json()) as { error?: string; confirmation?: ConfirmationTicket }
        if (body.error !== 'stepup-required' || !body.confirmation) return first
        const status = await settleConfirmation(body.confirmation.id, id => testDevice.request(`confirmations/${id}`))
        if (status !== 'approved') throw new Error(`confirmation ${status}`)
        return testDevice.request(path, { ...init, confirmation: body.confirmation.id })
      },
      async addFolders(input) {
        const nonce = input.nonce ?? (await testDevice.json<{ nonce: string }>('folder-grants', { method: 'POST', body: {} })).nonce
        const body: Record<string, unknown> = {
          nonce,
          via: input.via ?? 'picker',
          paths: input.paths,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.replace !== undefined ? { replace: input.replace } : {}),
        }
        const signed = input.signedBody ? input.signedBody(body) : body
        const signature = key.sign(foldersSigningText(host.hostId, state.device.id, nonce, foldersBodyHash(signed)))
        const path = input.projectId ? `workspaces/${encodeURIComponent(input.projectId)}/folders` : 'workspaces'
        return testDevice.request(path, { method: 'POST', body: { ...body, signature } })
      },
      async saveSessionFolder(input) {
        const nonce = input.nonce ?? (await testDevice.json<{ nonce: string }>('folder-grants', { method: 'POST', body: {} })).nonce
        const body: Record<string, unknown> = { nonce, via: 'session', sessionId: input.sessionId }
        const signed = input.signedBody ? input.signedBody(body) : body
        const signature = key.sign(foldersSigningText(host.hostId, state.device.id, nonce, foldersBodyHash(signed)))
        return testDevice.request('workspaces', { method: 'POST', body: { ...body, signature } })
      },
      async renew() {
        const { nonce } = await testDevice.json<{ nonce: string }>('credentials/challenge', { method: 'POST', body: {} })
        const response = await testDevice.request('credentials/renew', {
          method: 'POST',
          body: { nonce, signature: key.sign(renewSigningText(host.hostId, device.id, nonce)) },
        })
        const body = (await response.json()) as { device: Device; credential?: string }
        if (!response.ok) throw new HttpFailure(response.status, body)
        state.device = body.device
        state.credential = listener === 'unix' ? body.credential! : setCookieOf(response, `${cookieName}=`)!.slice(cookieName!.length + 1)
      },
    }
    return testDevice
  }

  async function enroll(
    input: { listener?: TestListener; name?: string; scopes?: DeviceScope[]; invitation?: string; offlineCode?: string } = {},
  ): Promise<TestDevice> {
    const listener = input.listener ?? 'loopback-tcp'
    const key = testDeviceKey()
    let invitation = input.invitation
    if (listener !== 'unix' && !invitation && !input.offlineCode) {
      invitation = (
        await invite(
          input.scopes?.filter(scope => scope !== 'secrets'),
          listener,
        )
      ).code
    }
    const created = await raw(listener, 'api/enrollments', {
      method: 'POST',
      body: {
        publicKey: key.spki,
        name: input.name ?? 'Test device',
        ...(input.scopes ? { scopes: input.scopes } : {}),
        ...(invitation ? { invitation } : {}),
        ...(input.offlineCode ? { offlineCode: input.offlineCode } : {}),
      },
    })
    const createdBody = (await created.json()) as { enrollment: EnrollmentView }
    if (created.status !== 202) throw new HttpFailure(created.status, createdBody)
    const { enrollment } = createdBody
    const status =
      enrollment.status === 'pending'
        ? await settleConfirmation(enrollment.id, id => raw(listener, `api/enrollments/${id}`))
        : enrollment.status
    if (status !== 'approved') throw new Error(`enrollment ${status}`)
    const completed = await raw(listener, `api/enrollments/${enrollment.id}/complete`, {
      method: 'POST',
      body: { signature: key.sign(enrollSigningText(host.hostId, enrollment.id, enrollment.nonce!)) },
    })
    const result = (await completed.json()) as { device: Device; credential?: string }
    if (!completed.ok) throw new HttpFailure(completed.status, result)
    if (listener === 'unix') return makeDevice(listener, key, result.device, result.credential!)
    const cookieName = listener === 'tls' ? `__Host-latch_${host.hostId8}` : `latch_${host.hostId8}`
    const cookie = setCookieOf(completed, `${cookieName}=`)
    if (!cookie) throw new Error('enrollment returned no credential cookie')
    return makeDevice(listener, key, result.device, cookie.slice(cookieName.length + 1), cookieName)
  }

  let closed: Promise<void> | undefined
  return {
    host,
    presence,
    dataDir,
    workspaceRoot,
    root,
    ...(tlsCa ? { tlsCa } : {}),
    enroll,
    invite,
    raw,
    close() {
      return (closed ??= (async () => {
        try {
          await host.close()
        } finally {
          await Promise.allSettled(Object.values(agents).map(agent => agent?.destroy()))
          await rm(root, { recursive: true, force: true })
        }
      })())
    },
  }
}
