import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BASE32_VECTORS,
  CANONICAL_JSON_CASES,
  CANONICAL_JSON_VECTOR,
  ENROLL_SIGNING_VECTOR,
  FOLDERS_SIGNING_VECTOR,
  P256_VECTOR,
  RENEW_SIGNING_VECTOR,
} from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const require = createRequire(import.meta.url)

interface DeviceKey {
  publicKey: string
  fingerprint: string
  sign(text: string): string
  exportPem(): string
}
interface CredentialStore {
  file: string
  current(): { deviceId: string; credential: string } | undefined
  sign(text: string): string
  signFolders(body: Record<string, unknown>): string
  commit(input: { key: DeviceKey; deviceId: string; credential: string }): Promise<void>
  setCredential(credential: string): Promise<void>
  clear(): Promise<void>
}
interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
  getSelectedStorageBackend?(): string
}
interface DialogOptions {
  type: string
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}
type InvitationResult = { ok: true; url: string } | { ok: false; status: number; error: string; message: string; retryAfter?: number }
interface ShellProxy {
  handle(request: Request, options?: { shell?: boolean }): Promise<Response>
  shellRequest(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>
  renew(): Promise<boolean>
  browserInvitation(): Promise<InvitationResult>
  startRenewalTimer(timers?: { setTimer?(callback: () => void, ms: number): unknown; clearTimer?(timer: unknown): void }): () => void
  state(): { renewAfter: number; retryAt: number; pendingEnrollments: number }
}
interface RouteInfo {
  kind: string
  enrollmentId?: string
  cancelEnrollment?: string
  selfRevoke?: boolean
  public?: boolean
  pairing?: boolean
}

const proxy = require('../src/proxy.cjs') as {
  HTML_CSP: string
  REQUEST_BODY_LIMIT: number
  RENEW_RETRY_MS: number
  RENEW_RETRY_MAX_MS: number
  EXTERNAL_URL_LIMIT: number
  ProxyError: new (...args: never[]) => Error & { status: number; code: string }
  isAllowedRendererRequest(url: string, options: { packaged: boolean }): boolean
  isAppUrl(url: string): boolean
  externalUrl(url: string): string | undefined
  externalLinkDialog(url: string): DialogOptions
  createDialogGate(): { enter(): boolean; leave(): void }
  createExternalOpener(options: {
    confirm(options: DialogOptions, parent?: unknown): Promise<{ response: number }>
    open(url: string): Promise<unknown>
    gate?: { enter(): boolean; leave(): void }
    log?(text: string): void
  }): (url: string, parent?: unknown) => Promise<boolean>
  BROWSER_INVITATION: { target: string; scopes: string[] }
  browserInvitationUrl(url: unknown, hostId: string): string | undefined
  isRendererPairing(body: Buffer | undefined): boolean
  isAppSender(event: unknown): boolean
  createBrowserOpener(options: {
    invite(): Promise<InvitationResult>
    open(url: string): Promise<unknown>
    platform: string
    log?(text: string): void
  }): () => Promise<{ ok: true } | Exclude<InvitationResult, { ok: true }>>
  debugFlagProblems(argv: string[], env: Record<string, string | undefined>): string[]
  unexpectedArguments(args: string[]): string[]
  upstreamTarget(url: string): { path: string; pathname: string } | undefined
  classifyRoute(method: string, pathname: string): RouteInfo
  forwardRequestHeaders(headers: HeadersInit, credential?: string): Record<string, string>
  forwardResponseHeaders(headers: Record<string, string | string[] | undefined> | HeadersInit): Headers
  rewriteEnrollmentBody(text: string, publicKey: string): string
  stripCredential(value: unknown): unknown
  authFailureAction(status: number, body: unknown): 'renew' | 'clear' | undefined
  createShellProxy(options: {
    hostId: string
    store: CredentialStore
    resolveSocket(): Promise<string>
    invalidateSocket?(): void
    log?(text: string): void
    now?(): number
  }): ShellProxy
}
const credentials = require('../src/credentials.cjs') as {
  NO_SECURE_STORAGE: string
  base32(bytes: Uint8Array): string
  deviceFingerprint(spki: Uint8Array): string
  enrollSigningText(hostId: string, id: string, nonce: string): string
  renewSigningText(hostId: string, deviceId: string, nonce: string): string
  foldersSigningText(hostId: string, deviceId: string, nonce: string, bodyHash: string): string
  canonicalJson(value: unknown): string
  foldersBodyHash(body: Record<string, unknown>): string
  generateDeviceKey(): DeviceKey
  deviceKeyFrom(privateKey: KeyObject): DeviceKey
  secureStorageProblem(storage: Partial<SafeStorageLike>, platform?: string): string | undefined
  openCredentialStore(options: {
    directory: string
    hostId: string
    safeStorage: SafeStorageLike
    log?(text: string): void
  }): Promise<CredentialStore>
}
const hostModule = require('../src/host.cjs') as {
  parseHostState(value: unknown): Record<string, unknown> | undefined
  readHostStateFile(path: string): Promise<Record<string, unknown> | undefined>
  inspectHostState(
    state: unknown,
    options?: { timeoutMs?: number },
  ): Promise<{ ok: true; info: Record<string, unknown> } | { ok: false; reason: string }>
}

const HOST_ID = P256_VECTOR.hostId
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-shell-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

/** Reversible stand-in for Electron's safeStorage; the output never contains the plaintext. */
function fakeSafeStorage(): SafeStorageLike & { failEncrypt: boolean } {
  const mask = (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0x5a))
  return {
    failEncrypt: false,
    isEncryptionAvailable: () => true,
    encryptString(text) {
      if (this.failEncrypt) throw new Error('Error while encrypting the text provided')
      return Buffer.concat([Buffer.from('fake1'), mask(Buffer.from(text, 'utf8'))])
    },
    decryptString: data => {
      if (data.subarray(0, 5).toString() !== 'fake1') throw new Error('not encrypted by this storage')
      return mask(data.subarray(5)).toString('utf8')
    },
  }
}

function verifyP1363(spki: string, text: string, signature: string) {
  const key = createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' })
  return verify('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
}

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('base64url')}`
const newCredential = (deviceId: string) => `ldc1.${deviceId}.${randomBytes(32).toString('base64url')}`

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}
interface FakeDevice {
  publicKey: string
  credential: string
  /** Issued by a renewal and current only from its first use, like the real Host. */
  pending?: { credential: string; issuedAt: number }
  previous: Array<{ credential: string; graceUntil: number }>
}

const PENDING_LIFETIME = 10 * 60_000
const ROTATION_GRACE = 60_000

/**
 * A Host stand-in on a unix socket that implements enrollment, renewal and a few API routes. Renewal follows the
 * real Host: the new credential becomes current on first use, the replaced one is accepted for 60 s, and using it
 * after that revokes the device as a replay.
 */
async function fakeHost(now: () => number = Date.now) {
  const root = await directory()
  const runtime = join(root, 'run')
  await mkdir(runtime, { mode: 0o700 })
  const socketPath = join(runtime, 'host.sock')
  const seen: Seen[] = []
  const state = {
    fingerprintOverride: undefined as string | undefined,
    enrollments: new Map<string, { publicKey: string; nonce: string }>(),
    devices: new Map<string, FakeDevice>(),
    challenges: new Map<string, string>(),
    /** Devices whose current credential is due; cleared when a renewed credential is first used. */
    renewalRequired: new Set<string>(),
    revoked: new Set<string>(),
    replays: 0,
    failChallenge: false,
    failRenew: false,
    /** The renewal is stored but its answer never reaches the shell. */
    dropRenewAnswer: false,
    /** Runs after the Host has issued a renewed credential and before it answers. */
    onRenew: undefined as (() => void) | undefined,
    streamClosed: false,
    invitationUrl: `http://h-${HOST_ID}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}`,
  }
  const sendJson = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(value))
  }
  const authenticate = (
    req: IncomingMessage,
    renewal = false,
  ): { error: string; status?: number } | { deviceId: string; device: FakeDevice } => {
    const header = req.headers.authorization
    if (!header?.startsWith('Latch-Device ')) return { error: 'unauthorized' }
    const credential = header.slice('Latch-Device '.length)
    const deviceId = credential.split('.')[1] ?? ''
    const device = state.devices.get(deviceId)
    if (!device) return { error: 'unauthorized' }
    const time = now()
    if (device.pending && time - device.pending.issuedAt > PENDING_LIFETIME) delete device.pending
    if (device.pending?.credential === credential && !state.revoked.has(deviceId)) {
      device.previous.unshift({ credential: device.credential, graceUntil: time + ROTATION_GRACE })
      device.credential = credential
      delete device.pending
      state.renewalRequired.delete(deviceId)
    }
    const previous = device.previous.find(entry => entry.credential === credential)
    if (device.credential !== credential && !previous) return { error: 'unauthorized' }
    if (state.revoked.has(deviceId)) return { error: 'device-revoked' }
    if (previous && time > previous.graceUntil) {
      state.revoked.add(deviceId)
      state.replays++
      return { error: 'device-revoked' }
    }
    if (previous && renewal) return { error: 'credential-rotated', status: 409 }
    return { deviceId, device }
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? '/'
      seen.push({ method: req.method ?? 'GET', url, headers: req.headers, body })
      const completeMatch = /^\/link\/api\/enrollments\/([^/]+)\/complete$/.exec(url)
      if (req.method === 'POST' && url === '/link/api/enrollments') {
        const input = JSON.parse(body) as { publicKey: string }
        const enrollmentId = id('enr')
        const nonce = randomBytes(16).toString('base64url')
        state.enrollments.set(enrollmentId, { publicKey: input.publicKey, nonce })
        const fingerprint = state.fingerprintOverride ?? credentials.deviceFingerprint(Buffer.from(input.publicKey, 'base64url'))
        sendJson(res, 202, {
          enrollment: { id: enrollmentId, status: 'pending', fingerprint, nonce, expiresAt: new Date(Date.now() + 120_000).toISOString() },
        })
        return
      }
      if (req.method === 'POST' && completeMatch) {
        const enrollment = state.enrollments.get(completeMatch[1]!)
        if (!enrollment) {
          sendJson(res, 404, { error: 'enrollment-not-found', message: '找不到该登记请求' })
          return
        }
        const { signature } = JSON.parse(body) as { signature: string }
        if (!verifyP1363(enrollment.publicKey, credentials.enrollSigningText(HOST_ID, completeMatch[1]!, enrollment.nonce), signature)) {
          sendJson(res, 401, { error: 'invalid-signature', message: '签名校验失败' })
          return
        }
        const deviceId = id('dev')
        const credential = newCredential(deviceId)
        state.devices.set(deviceId, { publicKey: enrollment.publicKey, credential, previous: [] })
        sendJson(res, 200, { device: { id: deviceId, name: '测试', listener: 'unix' }, credential }, { 'set-cookie': ['leak=1; Path=/'] })
        return
      }
      if (req.method === 'DELETE' && url.startsWith('/link/api/enrollments/')) {
        sendJson(res, 200, { cancelled: true })
        return
      }
      if (req.method === 'POST' && url === '/link/api/credentials/challenge') {
        if (state.failChallenge) {
          sendJson(res, 503, { error: 'host-closing', message: '运行节点正在关闭' })
          return
        }
        const auth = authenticate(req, true)
        if ('error' in auth) {
          sendJson(res, auth.status ?? 401, { error: auth.error, message: 'x' })
          return
        }
        const nonce = randomBytes(16).toString('base64url')
        state.challenges.set(auth.deviceId, nonce)
        sendJson(res, 200, { nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() })
        return
      }
      if (req.method === 'POST' && url === '/link/api/credentials/renew') {
        const auth = authenticate(req, true)
        if ('error' in auth) {
          sendJson(res, auth.status ?? 401, { error: auth.error, message: 'x' })
          return
        }
        if (state.failRenew) {
          sendJson(res, 503, { error: 'host-closing', message: '运行节点正在关闭' })
          return
        }
        const input = JSON.parse(body) as { nonce: string; signature: string }
        if (
          state.challenges.get(auth.deviceId) !== input.nonce
          || !verifyP1363(auth.device.publicKey, credentials.renewSigningText(HOST_ID, auth.deviceId, input.nonce), input.signature)
        ) {
          sendJson(res, 401, { error: 'invalid-signature', message: '签名校验失败' })
          return
        }
        const credential = newCredential(auth.deviceId)
        auth.device.pending = { credential, issuedAt: now() }
        state.onRenew?.()
        if (state.dropRenewAnswer) {
          res.socket?.destroy()
          return
        }
        sendJson(res, 200, { device: { id: auth.deviceId, renewAfter: new Date(now() + 86_400_000).toISOString() }, credential })
        return
      }
      if (url === '/link/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write(': hello\n\n')
        const timer = setInterval(() => res.write('event: refresh\ndata: {}\n\n'), 50)
        res.on('close', () => {
          clearInterval(timer)
          state.streamClosed = true
        })
        return
      }
      if (url === '/link/' || url === '/link/index.html') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'",
          'set-cookie': 'harness_link=old',
        })
        res.end('<!doctype html><title>Latch</title>')
        return
      }
      if (url === '/link/assets/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-security-policy': "default-src 'self'" })
        res.end('console.log(1)')
        return
      }
      if (req.method === 'POST' && url === '/link/api/pairings') {
        const auth = authenticate(req)
        if ('error' in auth) {
          sendJson(res, auth.status ?? 401, { error: auth.error, message: 'x' })
          return
        }
        if (state.renewalRequired.has(auth.deviceId)) {
          sendJson(res, 401, { error: 'renewal-required', message: '设备凭据需要续期' })
          return
        }
        sendJson(res, 201, { invitation: { url: state.invitationUrl } })
        return
      }
      if (url.startsWith('/link/api/')) {
        const auth = authenticate(req)
        if ('error' in auth) {
          sendJson(res, auth.status ?? 401, { error: auth.error, message: 'x' })
          return
        }
        if (state.renewalRequired.has(auth.deviceId)) {
          sendJson(res, 401, { error: 'renewal-required', message: '设备凭据需要续期' })
          return
        }
        sendJson(res, 200, { ok: true, method: req.method, body }, { 'set-cookie': 'latch_x=leak; Path=/' })
        return
      }
      sendJson(res, 404, { error: 'not-found', message: '页面不存在' })
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { socketPath, runtime, seen, state }
}

async function shell(options: { now?: () => number; safeStorage?: SafeStorageLike } = {}) {
  const host = await fakeHost(options.now)
  const devices = join(await directory(), 'latch-devices')
  const store = await credentials.openCredentialStore({
    directory: devices,
    hostId: HOST_ID,
    safeStorage: options.safeStorage ?? fakeSafeStorage(),
  })
  let invalidated = 0
  const logs: string[] = []
  const handler = proxy.createShellProxy({
    hostId: HOST_ID,
    store,
    now: options.now,
    log: text => logs.push(text),
    resolveSocket: async () => host.socketPath,
    invalidateSocket: () => {
      invalidated++
    },
  })
  const request = (path: string, init: RequestInit = {}) => handler.handle(new Request(`latch://app${path}`, init))
  return { host, store, devices, handler, request, logs, invalidated: () => invalidated }
}

const HOUR = 60 * 60 * 1000
const NOT_ENROLLED = { error: 'unauthorized', message: '请先在本机确认这台设备' }

/** Drives the renewal timer by hand: `run` fires the last scheduled callback and waits for the next one. */
function manualTimers(handler: ShellProxy) {
  const timers: Array<{ callback: () => void; ms: number }> = []
  const stop = handler.startRenewalTimer({ setTimer: (callback, ms) => timers.push({ callback, ms }), clearTimer: () => {} })
  const run = async () => {
    const count = timers.length
    timers.at(-1)!.callback()
    await vi.waitFor(() => expect(timers.length).toBe(count + 1))
  }
  return { timers, run, stop }
}

/** Drives the renderer side of enrollment: no key, an empty completion body. */
async function enroll(context: Awaited<ReturnType<typeof shell>>) {
  const created = await context.request('/link/api/enrollments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '我的电脑', publicKey: 'renderer-key', scopes: ['view'] }),
  })
  expect(created.status).toBe(202)
  const { enrollment } = (await created.json()) as { enrollment: { id: string } }
  const completed = await context.request(`/link/api/enrollments/${enrollment.id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature: 'forged' }),
  })
  return { enrollmentId: enrollment.id, completed }
}

describe('desktop shell policy', () => {
  it('lets the renderer reach only the latch scheme, plus devtools in development', () => {
    for (const url of ['latch://app/link/', 'latch://app/link/api/events?sessionId=x']) {
      expect(proxy.isAllowedRendererRequest(url, { packaged: true })).toBe(true)
    }
    for (const url of [
      'https://example.com/',
      'http://127.0.0.1:4317/link/',
      'ws://127.0.0.1:1/',
      'wss://example.com/',
      'file:///etc/passwd',
      'data:text/html,hi',
      'blob:latch://app/1',
      'chrome-extension://x/',
      'ftp://example.com/',
      'not a url',
    ])
      expect(proxy.isAllowedRendererRequest(url, { packaged: false }), url).toBe(false)
    expect(proxy.isAllowedRendererRequest('devtools://devtools/bundled/inspector.html', { packaged: false })).toBe(true)
    expect(proxy.isAllowedRendererRequest('devtools://devtools/bundled/inspector.html', { packaged: true })).toBe(false)
  })

  it('keeps navigation inside latch://app and opens only plain https links externally', () => {
    expect(proxy.isAppUrl('latch://app/link/')).toBe(true)
    for (const url of ['latch://other/link/', 'latch://app:1/link/', 'latch://user@app/link/', 'https://example.com/', 'about:blank']) {
      expect(proxy.isAppUrl(url), url).toBe(false)
    }
    expect(proxy.externalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    for (const url of [
      'http://example.com/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@example.com/',
      'latch://app/',
      `https://example.com/${'a'.repeat(proxy.EXTERNAL_URL_LIMIT)}`,
    ])
      expect(proxy.externalUrl(url), url).toBeUndefined()
    // What the confirmation shows is printable ASCII: no bidi overrides, controls or look-alike host names.
    for (const url of ['https://example.com/\u202egnp.exe?\u0007#\u200f', 'https://exаmple.com/']) {
      expect(proxy.externalUrl(url), url).toMatch(/^[\x21-\x7e]+$/)
    }
  })

  it('opens an external link only after the owner confirms the full URL, one confirmation at a time', async () => {
    const asked: Array<{ options: DialogOptions; parent: unknown }> = []
    const opened: string[] = []
    let answer: (value: { response: number }) => void = () => {}
    const openExternal = proxy.createExternalOpener({
      confirm: (options, parent) => {
        asked.push({ options, parent })
        return new Promise(resolve => {
          answer = resolve
        })
      },
      open: async url => {
        opened.push(url)
      },
    })
    const url = 'https://example.com/docs?q=1#part'
    const cancelled = openExternal(url, 'window')
    expect(await openExternal('https://example.com/other')).toBe(false)
    expect(asked).toEqual([
      {
        parent: 'window',
        options: {
          type: 'question',
          title: 'Latch',
          message: '在浏览器中打开以下链接？',
          detail: url,
          buttons: ['打开', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        },
      },
    ])
    answer({ response: 1 })
    expect(await cancelled).toBe(false)
    expect(opened).toEqual([])

    const confirmed = openExternal(url)
    answer({ response: 0 })
    expect(await confirmed).toBe(true)
    expect(opened).toEqual([url])

    for (const raw of [
      'http://example.com/',
      'javascript:alert(1)',
      'https://user:pw@example.com/',
      `https://example.com/${'a'.repeat(proxy.EXTERNAL_URL_LIMIT)}`,
    ]) {
      expect(await openExternal(raw), raw).toBe(false)
    }
    expect(asked).toHaveLength(2)
    expect(opened).toEqual([url])

    // Another native dialog holding the shared gate (a folder picker) drops the link without asking.
    const gate = proxy.createDialogGate()
    const shared = proxy.createExternalOpener({ confirm: async () => ({ response: 0 }), open: async item => opened.push(item), gate })
    expect(gate.enter()).toBe(true)
    expect(await shared(url)).toBe(false)
    gate.leave()
    expect(await shared(url)).toBe(true)
    expect(gate.enter()).toBe(true)
  })

  it("hands the browser only this Host's loopback page with an invitation, and listens only to the app's top frame", () => {
    const valid = `http://h-${HOST_ID}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}`
    expect(proxy.browserInvitationUrl(valid, HOST_ID)).toBe(valid)
    for (const raw of [
      `https://h-${HOST_ID}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}`,
      `http://h-${'b'.repeat(52)}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}`,
      `http://h-${HOST_ID}.localhost/link/#pair=lpi1-${'A'.repeat(26)}`,
      `http://user@h-${HOST_ID}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}`,
      `http://h-${HOST_ID}.localhost:4317/link/?pair=lpi1-${'A'.repeat(26)}`,
      `http://h-${HOST_ID}.localhost:4317/link/api/#pair=lpi1-${'A'.repeat(26)}`,
      `http://h-${HOST_ID}.localhost:4317/link/#pair=lpo1-${'A'.repeat(26)}`,
      `http://h-${HOST_ID}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}&x=1`,
      `http://127.0.0.1:4317/link/#pair=lpi1-${'A'.repeat(26)}`,
      'not a url',
      undefined,
    ]) {
      expect(proxy.browserInvitationUrl(raw, HOST_ID), String(raw)).toBeUndefined()
    }

    expect(proxy.isAppSender({ senderFrame: { url: 'latch://app/link/', parent: null } })).toBe(true)
    expect(proxy.isAppSender({ senderFrame: { url: 'latch://app/link/', parent: {} } })).toBe(false)
    expect(proxy.isAppSender({ senderFrame: { url: 'https://example.com/', parent: null } })).toBe(false)
    expect(proxy.isAppSender({ senderFrame: null })).toBe(false)
    expect(proxy.isAppSender(undefined)).toBe(false)
  })

  it('opens the browser only on macOS, one attempt at a time, and never logs the link', async () => {
    const url = `http://h-${HOST_ID}.localhost:4317/link/#pair=lpi1-${'A'.repeat(26)}`
    const opened: string[] = []
    const logs: string[] = []
    let invitations = 0
    let release: (() => void) | undefined
    const invite = async () => {
      invitations++
      await new Promise<void>(resolve => {
        release = resolve
      })
      return { ok: true as const, url }
    }
    const other = proxy.createBrowserOpener({ invite, open: async link => opened.push(link), platform: 'linux' })
    expect(await other()).toMatchObject({ ok: false, error: 'browser-open-unsupported' })
    expect(invitations).toBe(0)

    const openInBrowser = proxy.createBrowserOpener({ invite, open: async link => opened.push(link), platform: 'darwin' })
    const first = openInBrowser()
    const second = openInBrowser()
    await vi.waitFor(() => expect(invitations).toBe(1))
    release?.()
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(opened).toEqual([url])

    const refused = { ok: false as const, status: 403, error: 'scope-required', message: 'x' }
    expect(await proxy.createBrowserOpener({ invite: async () => refused, open: async () => {}, platform: 'darwin' })()).toEqual(refused)
    const failing = proxy.createBrowserOpener({
      invite: async () => ({ ok: true as const, url }),
      open: async link => {
        throw new Error(`cannot open ${link}`)
      },
      platform: 'darwin',
      log: text => logs.push(text),
    })
    expect(await failing()).toMatchObject({ ok: false, error: 'browser-open-failed' })
    expect(logs.join('\n')).not.toContain('lpi1-')
  })

  it('reports debugging switches from argv, NODE_OPTIONS and ELECTRON_RUN_AS_NODE', () => {
    expect(proxy.debugFlagProblems(['electron', 'main.cjs', '--latch-host-state=/x'], {})).toEqual([])
    expect(
      proxy.debugFlagProblems(
        ['electron', '--inspect=0', '--remote-debugging-port=0', '--inspect-brk', '--use-mock-keychain', '--inspector-not-a-flag'],
        { NODE_OPTIONS: '--max-old-space-size=100 --inspect=9229', ELECTRON_RUN_AS_NODE: '1' },
      ),
    ).toEqual([
      '--inspect',
      '--remote-debugging-port',
      '--inspect-brk',
      '--use-mock-keychain',
      'NODE_OPTIONS --inspect',
      'ELECTRON_RUN_AS_NODE',
    ])
    // Chromium also honours a single dash, and the inspector switches have several spellings.
    expect(
      proxy.debugFlagProblems(
        [
          'electron',
          '-remote-debugging-port=0',
          '--inspect-brk-node=0',
          '-inspect=0',
          '--remote-debugging-pipe',
          '--remote-debugging-address=0.0.0.0',
          '--inspect-publish-uid=http',
          '--debug-port=9229',
          '--REMOTE-DEBUGGING-PORT=1',
        ],
        { NODE_OPTIONS: '-r /tmp/x.js --import=/tmp/y.mjs --inspect-brk-node' },
      ),
    ).toEqual([
      '-remote-debugging-port',
      '--inspect-brk-node',
      '-inspect',
      '--remote-debugging-pipe',
      '--remote-debugging-address',
      '--inspect-publish-uid',
      '--debug-port',
      '--REMOTE-DEBUGGING-PORT',
      'NODE_OPTIONS -r',
      'NODE_OPTIONS --import',
      'NODE_OPTIONS --inspect-brk-node',
    ])
  })

  it('accepts only the shell arguments, once each, for packaged builds', () => {
    expect(proxy.unexpectedArguments([])).toEqual([])
    expect(proxy.unexpectedArguments(['--latch-host-state=/data/host.json', '--latch-user-data=/user'])).toEqual([])
    expect(
      proxy.unexpectedArguments([
        '--latch-host-state=/data/host.json',
        '--latch-host-state=/other/host.json',
        '--enable-logging',
        '-remote-allow-origins=*',
        'latch://app/',
        '--latch-user-data=',
      ]),
    ).toEqual(['--latch-host-state', '--enable-logging', '-remote-allow-origins', '（位置参数）', '--latch-user-data'])
  })

  it('maps latch://app/link paths to the Host and refuses everything else', () => {
    expect(proxy.upstreamTarget('latch://app/link/api/events?sessionId=a%20b')).toEqual({
      path: '/link/api/events?sessionId=a%20b',
      pathname: '/link/api/events',
    })
    expect(proxy.upstreamTarget('latch://app/link')).toEqual({ path: '/link', pathname: '/link' })
    for (const url of ['latch://app/', 'latch://app/other', 'latch://app/linker', 'latch://evil/link/', 'https://app/link/']) {
      expect(proxy.upstreamTarget(url), url).toBeUndefined()
    }
  })

  it('classifies credential, enrollment and device routes regardless of encoding, case or extra slashes', () => {
    for (const path of [
      '/link/api/credentials/renew',
      '/link/api/credentials/challenge',
      '/link/api/credentials',
      '/link/api//credentials/renew',
      '/link/api/%63redentials/renew',
      '/LINK/API/Credentials/Renew',
      '/link/api/credentials/renew/',
    ])
      expect(proxy.classifyRoute('POST', path), path).toEqual({ kind: 'credentials' })
    expect(proxy.classifyRoute('POST', '/link/api/enrollments')).toEqual({ kind: 'enroll' })
    expect(proxy.classifyRoute('POST', '/link/api/enrollments/')).toEqual({ kind: 'enroll' })
    expect(proxy.classifyRoute('GET', '/link/api/enrollments')).toEqual({ kind: 'forward' })
    expect(proxy.classifyRoute('POST', '/link/api/enrollments/enr_AbC/complete')).toEqual({ kind: 'complete', enrollmentId: 'enr_AbC' })
    expect(proxy.classifyRoute('GET', '/link/api/enrollments/enr_AbC/complete')).toEqual({ kind: 'complete', enrollmentId: 'enr_AbC' })
    expect(proxy.classifyRoute('DELETE', '/link/api/enrollments/enr_AbC')).toEqual({ kind: 'forward', cancelEnrollment: 'enr_AbC' })
    expect(proxy.classifyRoute('GET', '/link/api/enrollments/enr_AbC')).toEqual({ kind: 'forward' })
    expect(proxy.classifyRoute('DELETE', '/link/api/devices/current')).toEqual({ kind: 'forward', selfRevoke: true })
    for (const [method, path] of [
      ['GET', '/link/api/devices'],
      ['DELETE', '/link/api/devices/dev_x'],
      ['GET', '/link/api/pairings'],
    ] as const) {
      expect(proxy.classifyRoute(method, path)).toEqual({ kind: 'forward' })
    }
    for (const path of ['/link/api/pairings', '/link/api//pairings/', '/link/api/%70airings', '/LINK/API/Pairings'])
      expect(proxy.classifyRoute('POST', path), path).toEqual({ kind: 'forward', pairing: true })
    expect(proxy.classifyRoute('GET', '/link/api/snapshot')).toEqual({ kind: 'forward' })
    for (const path of [
      '/link/api/files/AAAAAAAAAAAAAAAAAAAAAA/local',
      '/link/api/files',
      '/link/api/%66iles/x/local',
      '/LINK/API/Files/x/local',
      '/link/api//files/x/local',
      '/link/api/tasks/task-1/files/resolve',
      '/link/api/tasks/task-1/files',
      '/link/api/tasks/task-1/%66iles/resolve',
      '/link/api/tasks/task-1//files/resolve',
      '/link/api/tasks/a%2Fb/files/resolve',
      '/link/api/tasks/a%2Fb%2Fc/%66iles/resolve',
    ])
      expect(proxy.classifyRoute('POST', path), path).toEqual({ kind: 'shell-files' })
    expect(proxy.classifyRoute('POST', '/link/api/tasks/task-1/prompt')).toEqual({ kind: 'forward' })
    expect(proxy.classifyRoute('GET', '/link/api/tasks/files')).toEqual({ kind: 'forward' })
  })

  it('keeps the folder-add routes for main, however the page spells them', () => {
    for (const [method, path] of [
      ['POST', '/link/api/workspaces'],
      ['POST', '/link/api/workspaces/'],
      ['POST', '/link//api/workspaces'],
      ['POST', '/link/api/Workspaces'],
      ['POST', '/LINK/API/WORKSPACES'],
      ['POST', '/link/api/%77orkspaces'],
      ['post', '/link/api/workspaces'],
      ['POST', '/link/api/folder-grants'],
      ['GET', '/link/api/folder-grants'],
      ['POST', '/link/api/Folder-Grants/'],
      ['POST', '/link/api/folder%2Dgrants'],
      ['POST', '/link/api/workspaces/shop/folders'],
      ['PUT', '/link/api/workspaces/shop/folders'],
      ['POST', '/link/api/workspaces/shop%2Ffolders'],
      ['POST', '/link/api/Workspaces/shop/Folders/'],
      ['POST', '/link/api/workspaces//shop//folders'],
    ] as const)
      expect(proxy.classifyRoute(method, path), `${method} ${path}`).toEqual({ kind: 'folders' })
    for (const [method, path] of [
      ['GET', '/link/api/workspaces'],
      ['PATCH', '/link/api/workspaces/shop'],
      ['DELETE', '/link/api/workspaces/shop'],
      ['DELETE', '/link/api/workspaces/shop/folders/api'],
    ] as const)
      expect(proxy.classifyRoute(method, path), `${method} ${path}`).toEqual({ kind: 'forward' })
  })

  it('lets only static files and enrollment routes go to the Host without a credential', () => {
    const enrollmentId = id('enr')
    for (const [method, path] of [
      ['GET', '/link'],
      ['GET', '/link/'],
      ['HEAD', '/link/assets/app.js'],
      ['GET', '/link/manifest.webmanifest'],
      ['GET', '/link/api/health'],
      ['GET', '/link/api/enrollment-info'],
      ['GET', `/link/api/enrollments/${enrollmentId}`],
    ] as const)
      expect(proxy.classifyRoute(method, path), `${method} ${path}`).toEqual({ kind: 'forward', public: true })
    expect(proxy.classifyRoute('DELETE', `/link/api/enrollments/${enrollmentId}`)).toEqual({
      kind: 'forward',
      cancelEnrollment: enrollmentId,
      public: true,
    })
    for (const [method, path] of [
      ['POST', '/link/'],
      ['GET', '/link/api'],
      ['GET', '/link/api/snapshot'],
      ['GET', '/link/api/events'],
      ['POST', '/link/api/health'],
      ['GET', '/link/api/%68ealth'],
      ['GET', '/link//api/health'],
      ['GET', '/link/API/health'],
      ['GET', '/link/%61pi/devices'],
      ['GET', '/link/api/enrollments'],
      ['GET', '/link/api/enrollments/enr_short'],
      ['GET', `/link/api/enrollments/${enrollmentId}/`],
      ['PUT', `/link/api/enrollments/${enrollmentId}`],
      ['GET', '/link/api/devices'],
      ['POST', '/link/api/pairings'],
    ] as const)
      expect(proxy.classifyRoute(method, path).public, `${method} ${path}`).toBeUndefined()
  })

  it('filters request headers and adds only the shell credential', () => {
    const forwarded = proxy.forwardRequestHeaders(
      {
        cookie: 'latch_abc=stolen',
        authorization: 'Latch-Device ldc1.renderer',
        host: 'evil',
        origin: 'https://evil',
        'content-length': '10',
        connection: 'keep-alive',
        'x-forwarded-for': '1.2.3.4',
        forwarded: 'for=1.2.3.4',
        'proxy-authorization': 'x',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-latch-confirmation': 'cfm_1',
      },
      'ldc1.dev_x.y',
    )
    expect(forwarded).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-latch-confirmation': 'cfm_1',
      authorization: 'Latch-Device ldc1.dev_x.y',
    })
    expect(proxy.forwardRequestHeaders({ authorization: 'Latch-Device x', accept: '*/*' })).toEqual({ accept: '*/*' })
  })

  it('drops cookies from responses and replaces the CSP of HTML documents only', () => {
    const html = proxy.forwardResponseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': 'default-src *',
      'set-cookie': ['a=1', 'b=2'],
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'x-frame-options': 'DENY',
    })
    expect(html.get('content-security-policy')).toBe(proxy.HTML_CSP)
    expect(html.get('set-cookie')).toBeNull()
    expect(html.get('connection')).toBeNull()
    expect(html.get('transfer-encoding')).toBeNull()
    expect(html.get('x-frame-options')).toBe('DENY')
    expect(proxy.forwardResponseHeaders({ 'content-type': 'application/xhtml+xml' }).get('content-security-policy')).toBe(proxy.HTML_CSP)
    expect(
      proxy
        .forwardResponseHeaders({ 'content-type': 'text/javascript', 'content-security-policy': "default-src 'self'" })
        .get('content-security-policy'),
    ).toBe("default-src 'self'")
    expect(proxy.forwardResponseHeaders({ 'content-type': 'application/json' }).get('content-security-policy')).toBeNull()
    expect(proxy.HTML_CSP).toContain("connect-src 'self'")
    expect(proxy.HTML_CSP).toContain("frame-ancestors 'none'")
  })

  it('rewrites the enrollment body with the shell key and strips credentials', () => {
    expect(
      JSON.parse(
        proxy.rewriteEnrollmentBody(
          JSON.stringify({ name: 'n', publicKey: 'renderer', scopes: ['view'], offlineCode: 'lpo1-X' }),
          'main-key',
        ),
      ),
    ).toEqual({ name: 'n', publicKey: 'main-key', scopes: ['view'], offlineCode: 'lpo1-X' })
    expect(JSON.parse(proxy.rewriteEnrollmentBody('{"name":"n"}', 'k'))).toEqual({ name: 'n', publicKey: 'k' })
    expect(() => proxy.rewriteEnrollmentBody('nope', 'k')).toThrow(proxy.ProxyError)
    expect(() => proxy.rewriteEnrollmentBody('[]', 'k')).toThrow(proxy.ProxyError)
    expect(proxy.stripCredential({ device: { id: 'd' }, credential: 'ldc1.x' })).toEqual({ device: { id: 'd' } })
    expect(proxy.authFailureAction(401, { error: 'renewal-required' })).toBe('renew')
    for (const code of ['device-revoked', 'credential-expired', 'listener-mismatch'])
      expect(proxy.authFailureAction(401, { error: code })).toBe('clear')
    expect(proxy.authFailureAction(401, { error: 'unauthorized' })).toBeUndefined()
    expect(proxy.authFailureAction(403, { error: 'device-revoked' })).toBeUndefined()
  })
})

describe('desktop credential storage', () => {
  it('matches the shared base32, fingerprint and signing-text vectors', () => {
    for (const vector of BASE32_VECTORS) expect(credentials.base32(Buffer.from(vector.utf8, 'utf8'))).toBe(vector.base32)
    expect(credentials.deviceFingerprint(Buffer.from(P256_VECTOR.spki, 'base64url'))).toBe(P256_VECTOR.fingerprint)
    const vectorKey = credentials.deviceKeyFrom(createPrivateKey({ key: P256_VECTOR.privateJwk, format: 'jwk' }))
    expect(vectorKey.publicKey).toBe(P256_VECTOR.spki)
    expect(vectorKey.fingerprint).toBe(P256_VECTOR.fingerprint)

    const enroll = ENROLL_SIGNING_VECTOR.example
    expect(credentials.enrollSigningText(enroll.hostId, enroll.enrollmentId, enroll.nonce)).toBe(enroll.text)
    const renew = RENEW_SIGNING_VECTOR.example
    expect(credentials.renewSigningText(renew.hostId, renew.deviceId, renew.nonce)).toBe(renew.text)
    // ECDSA signatures are randomized: the shell's own signature must verify like the vector's does.
    expect(verifyP1363(P256_VECTOR.spki, enroll.text, enroll.signature)).toBe(true)
    const signature = vectorKey.sign(enroll.text)
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64)
    expect(verifyP1363(P256_VECTOR.spki, enroll.text, signature)).toBe(true)
    expect(verifyP1363(P256_VECTOR.spki, renew.text, vectorKey.sign(renew.text))).toBe(true)
    const fresh = credentials.generateDeviceKey()
    expect(fresh.publicKey).not.toBe(credentials.generateDeviceKey().publicKey)
    expect(verifyP1363(fresh.publicKey, enroll.text, fresh.sign(enroll.text))).toBe(true)
  })

  it('hashes and signs a folder add exactly as the shared canonical JSON and folder signing vectors say', () => {
    for (const vector of [CANONICAL_JSON_VECTOR, ...CANONICAL_JSON_CASES]) {
      expect(credentials.canonicalJson(vector.input)).toBe(vector.output)
      expect(createHash('sha256').update(credentials.canonicalJson(vector.input), 'utf8').digest('hex')).toBe(vector.sha256)
    }
    const folders = FOLDERS_SIGNING_VECTOR.example
    expect(credentials.canonicalJson(folders.body)).toBe(folders.canonicalBody)
    expect(credentials.foldersBodyHash(folders.body)).toBe(folders.bodyHash)
    expect(credentials.foldersSigningText(folders.hostId, folders.deviceId, folders.nonce, folders.bodyHash)).toBe(folders.text)
    expect(verifyP1363(P256_VECTOR.spki, folders.text, folders.signature)).toBe(true)
    const vectorKey = credentials.deviceKeyFrom(createPrivateKey({ key: P256_VECTOR.privateJwk, format: 'jwk' }))
    expect(verifyP1363(P256_VECTOR.spki, folders.text, vectorKey.sign(folders.text))).toBe(true)
    // What main cannot encode as the Host does is refused, never hashed some other way.
    for (const value of [{ a: Number.NaN }, { a: () => {} }, [undefined], { a: new Date(0) }, { a: 1n }])
      expect(() => credentials.canonicalJson(value)).toThrow()
    expect(credentials.canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it('signs a folder add body with the stored device, and refuses without a credential', async () => {
    const store = await credentials.openCredentialStore({
      directory: join(await directory(), 'latch-devices'),
      hostId: HOST_ID,
      safeStorage: fakeSafeStorage(),
    })
    const body = { nonce: 'BAUGBwgJCgsMDQ4PEBESEw', via: 'picker', paths: ['/Users/me/site'] }
    expect(() => store.signFolders(body)).toThrow()
    const key = credentials.generateDeviceKey()
    const deviceId = id('dev')
    await store.commit({ key, deviceId, credential: newCredential(deviceId) })
    const text = credentials.foldersSigningText(HOST_ID, deviceId, body.nonce, credentials.foldersBodyHash(body))
    expect(verifyP1363(key.publicKey, text, store.signFolders(body))).toBe(true)
    expect(verifyP1363(key.publicKey, text, store.signFolders({ ...body, paths: ['/Users/me/other'] }))).toBe(false)
  })

  it('refuses to store credentials without secure storage', () => {
    const { NO_SECURE_STORAGE } = credentials
    expect(credentials.secureStorageProblem({ isEncryptionAvailable: () => false }, 'darwin')).toBe(NO_SECURE_STORAGE)
    expect(
      credentials.secureStorageProblem({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, 'linux'),
    ).toBe(NO_SECURE_STORAGE)
    expect(
      credentials.secureStorageProblem({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux'),
    ).toBeUndefined()
    expect(credentials.secureStorageProblem({ isEncryptionAvailable: () => true }, 'darwin')).toBeUndefined()
    expect(
      credentials.secureStorageProblem(
        {
          isEncryptionAvailable: () => {
            throw new Error('x')
          },
        },
        'darwin',
      ),
    ).toBe(NO_SECURE_STORAGE)
  })

  it('keeps the key and credential encrypted in a 0600 file and forgets both on clear', async () => {
    const root = await directory()
    const devices = join(root, 'latch-devices')
    const safeStorage = fakeSafeStorage()
    const store = await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage })
    expect(store.current()).toBeUndefined()
    const key = credentials.generateDeviceKey()
    const deviceId = id('dev')
    const credential = newCredential(deviceId)
    await expect(store.commit({ key, deviceId, credential: 'ldc1.wrong' })).rejects.toThrow()
    await store.commit({ key, deviceId, credential })
    expect((await stat(devices)).mode & 0o777).toBe(0o700)
    expect((await stat(store.file)).mode & 0o777).toBe(0o600)
    const raw = await readFile(store.file, 'utf8')
    expect(raw).not.toContain('ldc1.')
    expect(raw).not.toContain('PRIVATE KEY')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['credential', 'deviceId', 'hostId', 'privateKey', 'v'])

    const reopened = await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage })
    expect(reopened.current()).toEqual({ deviceId, credential })
    expect(verifyP1363(key.publicKey, 'x', reopened.sign('x'))).toBe(true)
    const rotated = newCredential(deviceId)
    await reopened.setCredential(rotated)
    await expect(reopened.setCredential(newCredential(id('dev')))).rejects.toThrow()
    expect((await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage })).current()?.credential).toBe(
      rotated,
    )

    await reopened.clear()
    await expect(stat(store.file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reopened.current()).toBeUndefined()
  })

  it('ignores records that cannot be decrypted or belong to another Host', async () => {
    const devices = join(await directory(), 'latch-devices')
    const store = await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })
    const deviceId = id('dev')
    await store.commit({ key: credentials.generateDeviceKey(), deviceId, credential: newCredential(deviceId) })
    const otherStorage = {
      ...fakeSafeStorage(),
      decryptString: () => {
        throw new Error('other keychain')
      },
    }
    expect(
      (await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage: otherStorage })).current(),
    ).toBeUndefined()
    const value = JSON.parse(await readFile(store.file, 'utf8')) as Record<string, unknown>
    await writeFile(store.file, JSON.stringify({ ...value, hostId: 'a'.repeat(52) }))
    await chmod(store.file, 0o644)
    expect(
      (await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })).current(),
    ).toBeUndefined()
    expect((await stat(store.file)).mode & 0o777).toBe(0o600)
    await expect(
      credentials.openCredentialStore({ directory: devices, hostId: '../escape', safeStorage: fakeSafeStorage() }),
    ).rejects.toThrow()
  })

  it('keeps using a credential whose file still carries a rotation mark from an older shell', async () => {
    const devices = join(await directory(), 'latch-devices')
    const store = await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })
    const deviceId = id('dev')
    const credential = newCredential(deviceId)
    await store.commit({ key: credentials.generateDeviceKey(), deviceId, credential })
    const value = JSON.parse(await readFile(store.file, 'utf8')) as Record<string, unknown>
    await writeFile(store.file, JSON.stringify({ ...value, rotating: true }))
    const logs: string[] = []
    const reopened = await credentials.openCredentialStore({
      directory: devices,
      hostId: HOST_ID,
      safeStorage: fakeSafeStorage(),
      log: text => logs.push(text),
    })
    expect(reopened.current()).toEqual({ deviceId, credential })
    expect(logs).toEqual([])
    // The next write drops the mark.
    const renewed = newCredential(deviceId)
    await reopened.setCredential(renewed)
    expect(Object.keys(JSON.parse(await readFile(store.file, 'utf8'))).sort()).toEqual([
      'credential',
      'deviceId',
      'hostId',
      'privateKey',
      'v',
    ])
  })

  it('removes its temporary file and keeps the stored record when a write fails', async () => {
    const devices = join(await directory(), 'latch-devices')
    const store = await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })
    const deviceId = id('dev')
    const credential = newCredential(deviceId)
    await store.commit({ key: credentials.generateDeviceKey(), deviceId, credential })
    const probe = await open(store.file, 'r')
    const fileHandle = Object.getPrototypeOf(probe) as { writeFile(...args: unknown[]): Promise<void>; sync(): Promise<void> }
    await probe.close()
    const noSpace = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    try {
      for (const method of ['writeFile', 'sync'] as const) {
        const spy = vi.spyOn(fileHandle, method).mockRejectedValueOnce(noSpace())
        await expect(store.setCredential(newCredential(deviceId)), method).rejects.toMatchObject({ code: 'ENOSPC' })
        expect(spy).toHaveBeenCalledTimes(1)
        spy.mockRestore()
        expect(await readdir(devices), method).toEqual([`${HOST_ID}.json`])
        expect(store.current(), method).toEqual({ deviceId, credential })
        expect(
          (await credentials.openCredentialStore({ directory: devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })).current(),
          method,
        ).toEqual({ deviceId, credential })
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('desktop shell proxy', () => {
  it('enrolls with the shell key, signs completion in main and returns only the device', async () => {
    const context = await shell()
    const { enrollmentId, completed } = await enroll(context)
    const created = context.host.seen.find(item => item.url === '/link/api/enrollments')!
    const sent = JSON.parse(created.body) as { publicKey: string; name: string; scopes: string[] }
    expect(sent.publicKey).not.toBe('renderer-key')
    expect(sent).toMatchObject({ name: '我的电脑', scopes: ['view'] })
    expect(created.headers.host).toBe('latch.unix')
    expect(created.headers.authorization).toBeUndefined()

    const completion = context.host.seen.find(item => item.url === `/link/api/enrollments/${enrollmentId}/complete`)!
    const signature = (JSON.parse(completion.body) as { signature: string }).signature
    expect(signature).not.toBe('forged')
    expect(completed.status).toBe(200)
    expect(completed.headers.get('set-cookie')).toBeNull()
    const body = (await completed.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['device'])
    expect(JSON.stringify(body)).not.toContain('ldc1.')
    expect(context.store.current()?.deviceId).toBe((body.device as { id: string }).id)
    expect(context.handler.state().pendingEnrollments).toBe(0)

    // A second completion of the same enrollment has no pending key and never reaches the Host.
    const before = context.host.seen.length
    const again = await context.request(`/link/api/enrollments/${enrollmentId}/complete`, { method: 'POST', body: '{}' })
    expect(again.status).toBe(404)
    expect(context.host.seen).toHaveLength(before)
  })

  it('stops an enrollment whose fingerprint does not match the shell key', async () => {
    const context = await shell()
    context.host.state.fingerprintOverride = 'AAAA BBBB CCCC DDDD EEEE'
    const response = await context.request('/link/api/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"x"}',
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'fingerprint-mismatch' })
    expect(context.host.seen.some(item => item.method === 'DELETE' && item.url.startsWith('/link/api/enrollments/enr_'))).toBe(true)
    expect(context.handler.state().pendingEnrollments).toBe(0)
  })

  it('adds the credential, ignores renderer cookies and authorization, and strips Set-Cookie', async () => {
    const context = await shell()
    await enroll(context)
    const { credential } = context.store.current()!
    const response = await context.request('/link/api/snapshot', {
      headers: { cookie: 'latch_x=1', authorization: 'Latch-Device ldc1.other', origin: 'https://evil' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    const seen = context.host.seen.at(-1)!
    expect(seen.headers.authorization).toBe(`Latch-Device ${credential}`)
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers.origin).toBeUndefined()
    expect(seen.headers.host).toBe('latch.unix')

    const posted = await context.request('/link/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt":"hi"}',
    })
    expect(await posted.json()).toMatchObject({ method: 'POST', body: '{"prompt":"hi"}' })

    const page = await context.request('/link/')
    expect(page.headers.get('content-security-policy')).toBe(proxy.HTML_CSP)
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(await page.text()).toContain('<title>Latch</title>')
    const script = await context.request('/link/assets/app.js')
    expect(script.headers.get('content-security-policy')).toBe("default-src 'self'")

    const before = context.host.seen.length
    const tooLarge = await context.request('/link/api/tasks', { method: 'POST', body: 'x'.repeat(proxy.REQUEST_BODY_LIMIT + 1) })
    expect(tooLarge.status).toBe(413)
    expect(context.host.seen).toHaveLength(before)
  })

  it('answers renderer credential calls itself and keeps anonymous device routes closed', async () => {
    const context = await shell()
    for (const path of [
      '/link/api/credentials/challenge',
      '/link/api/credentials/renew',
      '/link/api//credentials/renew',
      '/link/api/%63redentials/renew',
    ]) {
      const response = await context.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(response.status, path).toBe(403)
      expect(await response.json()).toEqual({ error: 'shell-managed', message: '设备凭据由 Latch 桌面端管理' })
    }
    // Sleep, wake and stop reasons come from main itself; the page cannot report them on its behalf.
    const seen = context.host.seen.length
    for (const path of ['/link/api/host/state', '/link/api//host/state', '/link/api/HOST/%73tate', '/link/api/host/state/']) {
      const response = await context.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'sleeping' }),
      })
      expect(response.status, path).toBe(403)
      expect(await response.json()).toEqual({ error: 'shell-managed', message: '电脑的运行状态由 Latch 桌面端报告' })
    }
    expect(context.host.seen).toHaveLength(seen)
    for (const [method, path] of [
      ['GET', '/link/api/devices'],
      ['DELETE', '/link/api/devices/dev_x'],
      ['POST', '/link/api/pairings'],
    ] as const) {
      const response = await context.request(path, {
        method,
        ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
      })
      expect(response.status, path).toBe(401)
      expect(await response.json()).toEqual(NOT_ENROLLED)
    }
    expect(context.host.seen).toHaveLength(0)
    expect((await context.request('/other')).status).toBe(404)
    expect(context.host.seen).toHaveLength(0)
  })

  it('answers renderer folder adds itself and lets only main’s own request reach the Host', async () => {
    const context = await shell()
    await enroll(context)
    const before = context.host.seen.length
    for (const path of [
      '/link/api/workspaces',
      '/link/api/Workspaces/',
      '/link/api/folder-grants',
      '/link/api/workspaces/shop%2Ffolders',
    ]) {
      const response = await context.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"paths":["/"]}',
      })
      expect(response.status, path).toBe(403)
      expect(await response.json()).toEqual({ error: 'shell-managed', message: '添加文件夹由 Latch 桌面端处理' })
    }
    expect(context.host.seen).toHaveLength(before)
    expect((await context.request('/link/api/workspaces')).status).toBe(200)

    const { credential } = context.store.current()!
    expect(await context.handler.shellRequest('POST', '/link/api/folder-grants', {})).toEqual({
      status: 200,
      json: { ok: true, method: 'POST', body: '{}' },
    })
    const seen = context.host.seen.at(-1)!
    expect(seen).toMatchObject({ method: 'POST', url: '/link/api/folder-grants' })
    expect(seen.headers.authorization).toBe(`Latch-Device ${credential}`)
    expect(seen.headers['content-type']).toBe('application/json')
  })

  it('refuses the file routes to the renderer and forwards them, with the credential, only for main', async () => {
    const context = await shell()
    await enroll(context)
    const { credential } = context.store.current()!
    const before = context.host.seen.length
    for (const path of [
      '/link/api/tasks/task-1/files/resolve',
      '/link/api/files/AAAAAAAAAAAAAAAAAAAAAA/local',
      '/link/api/%66iles/x/local',
    ]) {
      const response = await context.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(response.status, path).toBe(403)
      expect(await response.json()).toEqual({ error: 'shell-managed', message: '文件操作由 Latch 桌面端管理' })
    }
    expect(context.host.seen).toHaveLength(before)
    const own = await context.handler.handle(
      new Request('latch://app/link/api/tasks/task-1/files/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"paths":["a.md"]}',
      }),
      { shell: true },
    )
    expect(own.status).toBe(200)
    expect(context.host.seen.at(-1)).toMatchObject({ method: 'POST', url: '/link/api/tasks/task-1/files/resolve' })
    expect(context.host.seen.at(-1)!.headers.authorization).toBe(`Latch-Device ${credential}`)
  })

  it('forwards only public routes while the shell holds no credential', async () => {
    const context = await shell()
    const enrollmentId = id('enr')
    for (const [method, path] of [
      ['GET', '/link/'],
      ['GET', '/link/assets/app.js'],
      ['GET', '/link/api/health'],
      ['GET', '/link/api/enrollment-info'],
      ['GET', `/link/api/enrollments/${enrollmentId}`],
      ['DELETE', `/link/api/enrollments/${enrollmentId}`],
    ] as const) {
      await context.request(path, { method })
      expect(context.host.seen.at(-1), `${method} ${path}`).toMatchObject({ method, url: path })
      expect(context.host.seen.at(-1)!.headers.authorization).toBeUndefined()
    }
    const forwarded = context.host.seen.length
    for (const [method, path] of [
      ['GET', '/link/api/snapshot'],
      ['GET', '/link/api/events'],
      ['POST', '/link/api/tasks'],
      ['GET', '/link/api/devices'],
      ['DELETE', '/link/api/devices/dev_x'],
      ['POST', '/link/api/pairings'],
      ['GET', '/link/api/%68ealth'],
      ['GET', '/link//api/devices'],
      ['GET', '/link/%61pi/devices'],
      ['POST', '/link/'],
      ['GET', '/link/api/enrollments/enr_short'],
    ] as const) {
      const response = await context.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(await response.json()).toEqual(NOT_ENROLLED)
    }
    expect(context.host.seen).toHaveLength(forwarded)
  })

  it('never sends a request without authorization after renewal finds the device revoked', async () => {
    let time = Date.now()
    const context = await shell({ now: () => time })
    await enroll(context)
    context.host.state.revoked.add(context.store.current()!.deviceId)
    time += 25 * HOUR
    const before = context.host.seen.length
    const response = await context.request('/link/api/pairings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"scopes":["admin"]}',
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(NOT_ENROLLED)
    expect(context.store.current()).toBeUndefined()
    // Only the renewal challenge reached the Host, and it carried the old credential.
    expect(context.host.seen.slice(before).map(item => item.url)).toEqual(['/link/api/credentials/challenge'])
    expect(context.host.seen.at(-1)!.headers.authorization).toBeDefined()
  })

  it('refuses a request whose credential disappears while its body is still arriving', async () => {
    const context = await shell()
    await enroll(context)
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const pending = context.request('/link/api/devices/dev_other', { method: 'DELETE', body, duplex: 'half' } as RequestInit)
    await new Promise(done => setTimeout(done, 20))
    expect((await context.request('/link/api/devices/current', { method: 'DELETE' })).status).toBe(200)
    expect(context.store.current()).toBeUndefined()
    controller!.enqueue(new TextEncoder().encode('{}'))
    controller!.close()
    const response = await pending
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(NOT_ENROLLED)
    expect(context.host.seen.some(item => item.url === '/link/api/devices/dev_other')).toBe(false)
  })

  it('keeps presenting the stored credential when a renewal answer is lost, and renews again later', async () => {
    let time = Date.now()
    const context = await shell({ now: () => time })
    await enroll(context)
    const before = context.store.current()!
    const device = context.host.state.devices.get(before.deviceId)!
    time += 25 * HOUR
    context.host.state.dropRenewAnswer = true
    expect(await context.handler.renew()).toBe(false)
    expect(device.pending).toBeDefined()
    expect(context.store.current()).toEqual(before)
    // A restarted shell finds the same credential and may use it.
    expect(
      (await credentials.openCredentialStore({ directory: context.devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })).current(),
    ).toEqual(before)

    // Well past the 60 s a replaced credential is honoured, the stored one still works: the Host never switched.
    time += 5 * 60_000
    expect((await context.request('/link/api/snapshot')).status).toBe(200)
    expect(context.host.seen.at(-1)!.headers.authorization).toBe(`Latch-Device ${before.credential}`)

    context.host.state.dropRenewAnswer = false
    time = context.handler.state().retryAt
    expect(await context.handler.renew()).toBe(true)
    const renewed = context.store.current()!
    expect(renewed.credential).not.toBe(before.credential)
    // The shell presents the new credential once right away, which makes it current on the Host.
    expect(context.host.seen.at(-1)).toMatchObject({
      method: 'GET',
      url: '/link/api/audit/head',
      headers: { authorization: `Latch-Device ${renewed.credential}` },
    })
    expect(device.credential).toBe(renewed.credential)
    expect(device.pending).toBeUndefined()
    expect(
      (await credentials.openCredentialStore({ directory: context.devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })).current(),
    ).toEqual(renewed)

    time += 5 * 60_000
    expect((await context.request('/link/api/snapshot')).status).toBe(200)
    expect(context.host.seen.at(-1)!.headers.authorization).toBe(`Latch-Device ${renewed.credential}`)
    expect(context.host.state.revoked.size).toBe(0)
    expect(context.host.state.replays).toBe(0)
  })

  it('keeps the stored credential when the renewed one cannot be saved', async () => {
    let time = Date.now()
    const storage = fakeSafeStorage()
    const context = await shell({ now: () => time, safeStorage: storage })
    await enroll(context)
    const before = context.store.current()!
    const device = context.host.state.devices.get(before.deviceId)!
    time += 25 * HOUR
    // The write fails only after the Host has issued the new credential.
    context.host.state.onRenew = () => {
      storage.failEncrypt = true
    }
    expect(await context.handler.renew()).toBe(false)
    context.host.state.onRenew = undefined
    storage.failEncrypt = false
    expect(context.logs.some(text => text.startsWith('设备凭据已续期，但保存失败，继续使用原凭据'))).toBe(true)
    // The unsaved credential is never presented, so the Host keeps the stored one current.
    expect(context.store.current()).toEqual(before)
    expect(device.credential).toBe(before.credential)
    expect(context.host.seen.some(item => item.headers.authorization === `Latch-Device ${device.pending!.credential}`)).toBe(false)

    time += 30_000
    expect((await context.request('/link/api/snapshot')).status).toBe(200)
    expect(context.host.seen.at(-1)!.headers.authorization).toBe(`Latch-Device ${before.credential}`)
    const restarted = await credentials.openCredentialStore({ directory: context.devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })
    expect(restarted.current()).toEqual(before)

    // Once the wait has passed, the next request renews first and goes out with a fresh, stored credential.
    time = context.handler.state().retryAt
    expect((await context.request('/link/api/snapshot')).status).toBe(200)
    const renewed = context.store.current()!
    expect(renewed.credential).not.toBe(before.credential)
    expect(context.host.seen.at(-1)!.headers.authorization).toBe(`Latch-Device ${renewed.credential}`)
    expect(device.credential).toBe(renewed.credential)
    expect(
      (await credentials.openCredentialStore({ directory: context.devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })).current(),
    ).toEqual(renewed)
    expect(context.host.state.revoked.size).toBe(0)
  })

  it('keeps the stored credential usable when the Host refuses a renewal', async () => {
    let time = Date.now()
    const context = await shell({ now: () => time })
    await enroll(context)
    const before = context.store.current()!
    time += 25 * HOUR
    context.host.state.failRenew = true
    expect(await context.handler.renew()).toBe(false)
    expect(context.store.current()).toEqual(before)
    expect(
      (await credentials.openCredentialStore({ directory: context.devices, hostId: HOST_ID, safeStorage: fakeSafeStorage() })).current(),
    ).toEqual(before)
  })

  it('renews once on renewal-required and replays the request with the new credential', async () => {
    const context = await shell()
    await enroll(context)
    const before = context.store.current()!
    context.host.state.renewalRequired.add(before.deviceId)
    const response = await context.request('/link/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt":"again"}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ body: '{"prompt":"again"}' })
    const after = context.store.current()!
    expect(after.deviceId).toBe(before.deviceId)
    expect(after.credential).not.toBe(before.credential)
    expect(context.host.seen.map(item => item.url)).toEqual(
      expect.arrayContaining(['/link/api/credentials/challenge', '/link/api/credentials/renew']),
    )
    expect(context.host.seen.at(-1)!.headers.authorization).toBe(`Latch-Device ${after.credential}`)
    expect(context.handler.state().renewAfter).toBeGreaterThan(Date.now() + 86_000_000)
  })

  it('renews before forwarding once renewAfter has passed', async () => {
    let time = Date.now()
    const context = await shell({ now: () => time })
    await enroll(context)
    const before = context.store.current()!.credential
    time += 25 * 60 * 60 * 1000
    expect((await context.request('/link/api/snapshot')).status).toBe(200)
    expect(context.store.current()!.credential).not.toBe(before)
    expect(context.host.seen.filter(item => item.url === '/link/api/credentials/renew')).toHaveLength(1)
  })

  it('waits out a failed renewal instead of renewing on every renewal-required answer', async () => {
    let time = Date.now()
    const context = await shell({ now: () => time })
    await enroll(context)
    const { deviceId } = context.store.current()!
    context.host.state.renewalRequired.add(deviceId)
    context.host.state.failChallenge = true
    const challenges = () => context.host.seen.filter(item => item.url === '/link/api/credentials/challenge').length
    const snapshot = async () => {
      const response = await context.request('/link/api/snapshot')
      return { status: response.status, error: ((await response.json()) as { error?: string }).error }
    }

    expect(await snapshot()).toEqual({ status: 401, error: 'renewal-required' })
    expect(challenges()).toBe(1)
    for (let index = 0; index < 5; index++) expect(await snapshot()).toEqual({ status: 401, error: 'renewal-required' })
    expect(challenges()).toBe(1)

    // Each further failure doubles the wait, up to the cap.
    const waits: number[] = []
    for (let attempt = 2; attempt <= 6; attempt++) {
      waits.push(context.handler.state().retryAt - time)
      time = context.handler.state().retryAt - 1
      await snapshot()
      expect(challenges()).toBe(attempt - 1)
      time += 1
      await snapshot()
      expect(challenges()).toBe(attempt)
    }
    waits.push(context.handler.state().retryAt - time)
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
    expect(proxy.RENEW_RETRY_MAX_MS).toBe(600_000)

    context.host.state.failChallenge = false
    time = context.handler.state().retryAt
    expect(await snapshot()).toEqual({ status: 200, error: undefined })
    expect(context.handler.state().retryAt).toBe(0)
    expect(context.host.state.renewalRequired.has(deviceId)).toBe(false)
  })

  it('renews on schedule and retries a failed renewal a minute later', async () => {
    let time = Date.now()
    const context = await shell({ now: () => time })
    await enroll(context)
    const { timers, run, stop } = manualTimers(context.handler)
    expect(timers.at(-1)!.ms).toBe(12 * HOUR)

    time += 12 * HOUR
    await run()
    expect(context.host.seen.some(item => item.url === '/link/api/credentials/challenge')).toBe(false)
    expect(timers.at(-1)!.ms).toBe(12 * HOUR)

    time += 13 * HOUR
    context.host.state.failChallenge = true
    const before = context.store.current()!.credential
    await run()
    expect(context.store.current()!.credential).toBe(before)
    expect(timers.at(-1)!.ms).toBe(60_000)
    // While the retry back-off runs, ordinary requests are not delayed by repeated renewal attempts.
    const attempts = context.host.seen.filter(item => item.url === '/link/api/credentials/challenge').length
    expect((await context.request('/link/api/snapshot')).status).toBe(200)
    expect(context.host.seen.filter(item => item.url === '/link/api/credentials/challenge')).toHaveLength(attempts)

    context.host.state.failChallenge = false
    time += 60_000
    await run()
    expect(context.store.current()!.credential).not.toBe(before)
    expect(timers.at(-1)!.ms).toBe(12 * HOUR)
    stop()
  })

  it("makes a browser invitation with the shell's credential, renews once when asked, and refuses a link that is not this Host's page", async () => {
    const context = await shell()
    expect(await context.handler.browserInvitation()).toMatchObject({ ok: false, status: 401, error: 'unauthorized' })
    await enroll(context)
    const before = context.store.current()!
    context.host.state.renewalRequired.add(before.deviceId)
    expect(await context.handler.browserInvitation()).toEqual({ ok: true, url: context.host.state.invitationUrl })
    const after = context.store.current()!
    expect(after.credential).not.toBe(before.credential)
    const pairing = context.host.seen.filter(item => item.url === '/link/api/pairings').at(-1)!
    expect(pairing.headers.authorization).toBe(`Latch-Device ${after.credential}`)
    expect(JSON.parse(pairing.body)).toEqual(proxy.BROWSER_INVITATION)

    context.host.state.invitationUrl = 'https://example.com/#pair=lpi1-AAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect(await context.handler.browserInvitation()).toMatchObject({ ok: false, error: 'browser-open-failed' })
    context.host.state.revoked.add(after.deviceId)
    expect(await context.handler.browserInvitation()).toMatchObject({ ok: false, status: 401, error: 'device-revoked' })
    expect(context.store.current()).toBeUndefined()
  })

  it("forwards the page's request for a phone invitation, never one for this computer's browser", async () => {
    const context = await shell()
    await enroll(context)
    const post = (path: string, body?: string) =>
      context.request(path, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }) })
    const before = context.host.seen.length
    for (const [path, body] of [
      ['/link/api/pairings', '{"target":"loopback"}'],
      ['/link/api/pairings', '{"target":"loopback","scopes":["view"]}'],
      // JSON.parse keeps the last duplicate, as the Host's parser does.
      ['/link/api/pairings', '{"target":"tls","target":"loopback"}'],
      ['/link/api//pairings/', '{"target":"loopback"}'],
      ['/link/api/%70airings', '{"target":"loopback"}'],
      ['/link/api/pairings', '{"target":"Loopback"}'],
      ['/link/api/pairings', '{"target":null}'],
      ['/link/api/pairings', '[]'],
      ['/link/api/pairings', 'not json'],
    ] as const) {
      const response = await post(path, body)
      expect(response.status, `${path} ${body}`).toBe(403)
      expect(await response.json()).toEqual({ error: 'shell-managed', message: '这台电脑上浏览器的登记链接由 Latch 桌面端直接交给浏览器' })
    }
    expect(context.host.seen).toHaveLength(before)
    for (const body of [undefined, '{}', '{"target":"tls","scopes":["view","run"]}'])
      expect((await post('/link/api/pairings', body)).status).toBe(201)
    expect(context.host.seen.slice(before).map(item => item.body)).toEqual(['', '{}', '{"target":"tls","scopes":["view","run"]}'])
    expect(proxy.isRendererPairing(undefined)).toBe(true)
    expect(proxy.isRendererPairing(Buffer.from('{"target":"loopback"}'))).toBe(false)
  })

  it('forgets the device when the Host reports it revoked, then passes the 401 through', async () => {
    const context = await shell()
    await enroll(context)
    const { deviceId } = context.store.current()!
    context.host.state.revoked.add(deviceId)
    const response = await context.request('/link/api/snapshot')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'device-revoked' })
    expect(context.store.current()).toBeUndefined()
    await expect(stat(context.store.file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(context.host.seen.at(-1)!.headers.authorization).toBeDefined()
    // Later requests are answered by the shell; none reaches host.sock without authorization.
    const before = context.host.seen.length
    const later = await context.request('/link/api/snapshot')
    expect(later.status).toBe(401)
    expect(await later.json()).toEqual(NOT_ENROLLED)
    expect(context.host.seen).toHaveLength(before)
  })

  it('streams event bodies as they arrive and closes the Host connection on cancel', async () => {
    const context = await shell()
    await enroll(context)
    const response = await context.request('/link/api/events', { headers: { accept: 'text/event-stream' } })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('event: refresh')) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      text += decoder.decode(value, { stream: true })
    }
    expect(context.host.state.streamClosed).toBe(false)
    await reader.cancel()
    await vi.waitFor(() => expect(context.host.state.streamClosed).toBe(true))
  })

  it('reports an unreachable Host without hanging and asks for re-verification', async () => {
    const store = await credentials.openCredentialStore({
      directory: join(await directory(), 'd'),
      hostId: HOST_ID,
      safeStorage: fakeSafeStorage(),
    })
    let invalidated = 0
    const missing = join(await directory(), 'missing.sock')
    const handler = proxy.createShellProxy({
      hostId: HOST_ID,
      store,
      log: () => {},
      resolveSocket: async () => missing,
      invalidateSocket: () => {
        invalidated++
      },
    })
    const api = await handler.handle(new Request('latch://app/link/api/enrollment-info'))
    expect(api.status).toBe(502)
    expect(await api.json()).toMatchObject({ error: 'host-unavailable' })
    const page = await handler.handle(new Request('latch://app/link/'))
    expect(page.status).toBe(502)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toBe(proxy.HTML_CSP)
    expect(invalidated).toBe(2)
  })
})

/**
 * Passes host.sock traffic through unchanged, except that while `dropRenewAnswer` is set the answer to a renewal is
 * thrown away after the Host has sent it, as when the connection breaks at the wrong moment.
 */
async function renewalRelay(target: string) {
  const runtime = join(await directory(), 'run')
  await mkdir(runtime, { mode: 0o700 })
  const socketPath = join(runtime, 'relay.sock')
  const control = { dropRenewAnswer: false }
  const server = createServer((req, res) => {
    const upstream = httpRequest({ socketPath: target, method: req.method, path: req.url, headers: req.headers }, answer => {
      if (control.dropRenewAnswer && req.url === '/link/api/credentials/renew') {
        answer.resume()
        res.socket?.destroy()
        return
      }
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => res.socket?.destroy())
    req.pipe(upstream)
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { socketPath, control }
}

describe('desktop shell against the Host', () => {
  it('gets a one-time loopback invitation over host.sock that enrolls only a browser on loopback', async () => {
    const testHost = await startTestHost()
    cleanups.push(() => testHost.close())
    const { host } = testHost
    const store = await credentials.openCredentialStore({
      directory: join(await directory(), 'latch-devices'),
      hostId: host.hostId,
      safeStorage: fakeSafeStorage(),
    })
    const handler = proxy.createShellProxy({ hostId: host.hostId, store, log: () => {}, resolveSocket: async () => host.socketPath })
    const request = (path: string, init: RequestInit = {}) => handler.handle(new Request(`latch://app${path}`, init))
    const created = await request('/link/api/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '桌面端' }),
    })
    const { enrollment } = (await created.json()) as { enrollment: { id: string } }
    await vi.waitFor(async () => {
      const status = await request(`/link/api/enrollments/${enrollment.id}`)
      expect(((await status.json()) as { enrollment: { status: string } }).enrollment.status).toBe('approved')
    })
    expect((await request(`/link/api/enrollments/${enrollment.id}/complete`, { method: 'POST', body: '{}' })).status).toBe(200)
    const desktop = store.current()!

    const result = await handler.browserInvitation()
    if (!result.ok) throw new Error(result.error)
    expect(result.url).toMatch(new RegExp(`^${host.loopbackOrigin}/link/#pair=lpi1-[A-Z2-7]{26}$`))
    expect(host.security.audit.lastOf('pairing.invited')).toMatchObject({
      actor: { deviceId: desktop.deviceId, listener: 'unix' },
      detail: { scopes: ['view', 'run', 'approve:standard', 'admin'], listener: 'loopback-tcp' },
    })
    const browser = await testHost.enroll({ invitation: new URL(result.url).hash.slice('#pair='.length), scopes: ['view', 'admin'] })
    expect(browser.device).toMatchObject({ listener: 'loopback-tcp', pairedBy: { method: 'invitation', deviceId: desktop.deviceId } })
    expect(testHost.presence.requests.at(-1)!.preview.lines.at(-1)).toEqual({ label: '邀请来源', value: '桌面端' })
  })
})

describe('desktop shell renewal against the Host', () => {
  it('survives a lost renewal answer: the stored credential keeps working and the next renewal takes over', async () => {
    let time = Date.now()
    const now = () => time
    const testHost = await startTestHost({ now })
    cleanups.push(() => testHost.close())
    const { host } = testHost
    const relay = await renewalRelay(host.socketPath)
    const devices = join(await directory(), 'latch-devices')
    const store = await credentials.openCredentialStore({ directory: devices, hostId: host.hostId, safeStorage: fakeSafeStorage() })
    const handler = proxy.createShellProxy({ hostId: host.hostId, store, now, log: () => {}, resolveSocket: async () => relay.socketPath })
    const request = (path: string, init: RequestInit = {}) => handler.handle(new Request(`latch://app${path}`, init))

    const created = await request('/link/api/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '桌面端' }),
    })
    expect(created.status).toBe(202)
    const { enrollment } = (await created.json()) as { enrollment: { id: string } }
    await vi.waitFor(async () => {
      const status = await request(`/link/api/enrollments/${enrollment.id}`)
      expect(((await status.json()) as { enrollment: { status: string } }).enrollment.status).toBe('approved')
    })
    expect((await request(`/link/api/enrollments/${enrollment.id}/complete`, { method: 'POST', body: '{}' })).status).toBe(200)
    const before = store.current()!
    const reopen = async () =>
      (await credentials.openCredentialStore({ directory: devices, hostId: host.hostId, safeStorage: fakeSafeStorage() })).current()

    // The renewal reaches the Host, which issues a new credential, but its answer is lost.
    time += 23 * HOUR
    relay.control.dropRenewAnswer = true
    expect(await handler.renew()).toBe(false)
    expect(host.security.audit.lastOf('device.credential.issued')?.target).toBe(before.deviceId)
    expect(store.current()).toEqual(before)
    expect(await reopen()).toEqual(before)

    // Long after a replaced credential would have run out of grace, the stored one still works.
    time += 5 * 60_000
    expect((await request('/link/api/snapshot')).status).toBe(200)
    expect(host.security.devices.get(before.deviceId)?.status).toBe('active')

    relay.control.dropRenewAnswer = false
    time = handler.state().retryAt
    expect(await handler.renew()).toBe(true)
    const renewed = store.current()!
    expect(renewed.credential).not.toBe(before.credential)
    // The shell used the new credential once, so it is current on the Host now.
    expect(host.security.audit.lastOf('device.credential.rotated')?.target).toBe(before.deviceId)
    expect(await reopen()).toEqual(renewed)

    time += 5 * 60_000
    expect((await request('/link/api/snapshot')).status).toBe(200)
    expect(host.security.devices.get(before.deviceId)?.status).toBe('active')
    expect(host.security.audit.lastOf('device.revoked')).toBeUndefined()
  })
})

/** A minimal Host on a unix socket that answers host-info like the real one. */
async function hostInfoServer(info: { pid: number; hostId: string; instanceId: string }, extra: Record<string, unknown> = {}) {
  const root = await directory()
  const runtime = join(root, 'latch-run')
  await mkdir(runtime, { mode: 0o700 })
  const socketPath = join(runtime, 'host.sock')
  const server = createServer((req, res) => {
    if (req.url !== '/link/api/host-info') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        product: 'Latch',
        version: '0.1.0',
        ...info,
        startedAt: new Date().toISOString(),
        loopbackOrigin: 'http://h.localhost:1',
        tlsOrigin: null,
        devMode: true,
        presence: { status: 'unavailable' },
        activeSessions: 0,
        ...extra,
      }),
    )
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const state = {
    version: 2,
    pid: info.pid,
    hostId: info.hostId,
    instanceId: info.instanceId,
    socketPath,
    loopbackOrigin: 'http://h.localhost:1',
    tlsOrigin: null,
    startedAt: new Date().toISOString(),
    dataDir: root,
  }
  return { root, runtime, socketPath, state }
}

describe('desktop Host verification (CommonJS)', () => {
  it('parses host.json v2 strictly', async () => {
    const { state, root } = await hostInfoServer({ pid: process.pid, hostId: HOST_ID, instanceId: randomUUID() })
    expect(hostModule.parseHostState(state)).toEqual(state)
    expect(hostModule.parseHostState({ ...state, extra: 1 })).toBeUndefined()
    expect(hostModule.parseHostState({ ...state, version: 1 })).toBeUndefined()
    expect(hostModule.parseHostState({ ...state, hostId: 'ABC' })).toBeUndefined()
    expect(hostModule.parseHostState({ ...state, instanceId: 'x' })).toBeUndefined()
    expect(hostModule.parseHostState({ ...state, socketPath: 'relative.sock' })).toBeUndefined()
    expect(hostModule.parseHostState({ ...state, loopbackOrigin: 'nope' })).toBeUndefined()
    const path = join(root, 'host.json')
    await writeFile(path, JSON.stringify(state))
    expect(await hostModule.readHostStateFile(path)).toEqual(state)
    await writeFile(path, '{')
    expect(await hostModule.readHostStateFile(path)).toBeUndefined()
    expect(await hostModule.readHostStateFile(join(root, 'missing.json'))).toBeUndefined()
  })

  it('accepts only a live Host whose socket, directory and identity match', async () => {
    const instanceId = randomUUID()
    const { state, runtime } = await hostInfoServer({ pid: process.pid, hostId: HOST_ID, instanceId })
    const ok = await hostModule.inspectHostState(state)
    expect(ok).toMatchObject({ ok: true, info: { pid: process.pid, hostId: HOST_ID, instanceId } })
    expect(await hostModule.inspectHostState({ ...state, instanceId: randomUUID() })).toMatchObject({ ok: false })
    expect(await hostModule.inspectHostState({ ...state, hostId: 'a'.repeat(52) })).toMatchObject({ ok: false })
    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(await hostModule.inspectHostState({ ...state, pid: exited.pid })).toMatchObject({ ok: false, reason: 'Host 进程已退出' })
    await chmod(runtime, 0o755)
    expect(await hostModule.inspectHostState(state)).toMatchObject({ ok: false, reason: '运行目录权限不是 0700' })
    await chmod(runtime, 0o700)
    expect(await hostModule.inspectHostState({ ...state, socketPath: join(runtime, 'other.sock') })).toMatchObject({ ok: false })
  })

  it('reads the running and waiting counts from host-info, and refuses a malformed one as host-state.ts does', async () => {
    const instanceId = randomUUID()
    const counted = await hostInfoServer(
      { pid: process.pid, hostId: HOST_ID, instanceId },
      { activeSessions: 3, activity: { running: 1, waiting: 2 } },
    )
    expect(await hostModule.inspectHostState(counted.state)).toMatchObject({ ok: true, info: { activity: { running: 1, waiting: 2 } } })
    for (const activity of [{ running: 'many' }, { running: -1, waiting: 0 }, { running: 0, waiting: -2 }, [0, 0]]) {
      const malformed = await hostInfoServer({ pid: process.pid, hostId: HOST_ID, instanceId }, { activity })
      expect(await hostModule.inspectHostState(malformed.state), JSON.stringify(activity)).toMatchObject({
        ok: false,
        reason: '无法通过 host.sock 读取 Host 信息',
      })
    }
  })
})
