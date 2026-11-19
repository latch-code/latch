import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename as move, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  escapeSecurityText,
  type AgentRecord,
  type AgentPresetSettings,
  type AgentSettings,
  type AppSnapshot,
  type Approval,
  type ApprovalReceipt,
  type CancelReceipt,
  type ConfirmationTicket,
  type Device,
  type EnrollmentInfo,
  type EnrollmentView,
  type InvitationView,
  type PresencePreview,
  type ProviderSettings,
  type TaskDetail,
  type TaskSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { AppError, type HarnessPlugin, type ModelProvider, type ToolDefinition } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { renewSigningText, HttpFailure, type TestDevice, makeTestTls, FAKE_ACP_AGENT, startFakeModels } from '@latch/testkit'
import { createAcpAgentPlugin, forgetCommandLookups } from '@latch/harness-acp'
import { AuditLog } from '../src/audit.ts'
import { createOfflineTicket } from '../src/auth.ts'
import { HostConfig } from '../src/config.ts'
import { hashDisplay } from '../src/crypto.ts'
import { tlsListenerClass, validateTls } from '../src/listeners.ts'
import type { TrafficSummary } from '../src/traffic.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ADMIN = ['view', 'run', 'approve:standard', 'admin'] as const

async function testHost(options: TestHostOptions = {}): Promise<TestHost> {
  const host = await startTestHost(options)
  cleanups.push(() => host.close())
  return host
}

async function temporaryDirectory(prefix = 'latch-http-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function freeTcpPort(): Promise<number> {
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

/** Raw HTTP/1.1 to one loopback address with any Host header. */
function rawHttp(
  address: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  data?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: address,
        port,
        path,
        method,
        headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}) },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', fail)
    req.end(data)
  })
}

/** Leaves an authenticated loopback request waiting for its remaining JSON bytes. */
function halfRequest(t: TestHost, path: string, cookie: string, payload: unknown, method = 'POST') {
  const data = JSON.stringify(payload)
  let resolveResponse!: (status: number) => void
  let rejectResponse!: (error: Error) => void
  const response = new Promise<number>((done, fail) => {
    resolveResponse = done
    rejectResponse = fail
  })
  const host = new URL(t.host.loopbackOrigin).host
  const request = httpRequest(
    {
      host: '127.0.0.1',
      port: t.host.loopbackPort,
      path: `/link/api/${path}`,
      method,
      headers: { host, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    },
    reply => {
      reply.resume()
      reply.once('end', () => resolveResponse(reply.statusCode ?? 0))
    },
  )
  request.once('error', rejectResponse)
  request.write(data.slice(0, 1))
  cleanups.push(async () => {
    request.destroy()
    await response.catch(() => {})
  })
  return { finish: () => request.end(data.slice(1)), response }
}

/** A local OpenAI-compatible server: streams "ok" and lists models; it records what each call carried. */
async function localModel(models = ['alpha', 'beta', 'gamma']) {
  const calls: Array<{ model: string; authorization?: string; effort?: string }> = []
  const listings: Array<{ authorization?: string }> = []
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      listings.push({ authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: models.map(id => ({ id })) }))
      return
    }
    const data: Buffer[] = []
    req.on('data', chunk => data.push(Buffer.from(chunk)))
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(data).toString('utf8')) as { model: string; reasoning_effort?: string }
      calls.push({ model: parsed.model, authorization: req.headers.authorization, effort: parsed.reasoning_effort })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener')
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, allow: `127.0.0.1:${address.port}`, calls, listings }
}

async function callProvider(t: TestHost, providerId = 'openai-compatible') {
  const lease = t.host.registry.acquire(providerId)
  try {
    for await (const _delta of lease.provider.stream({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      /* Consume the real local HTTP exchange. */
    }
  } finally {
    lease.release()
  }
}

/** A model that calls one tool with fixed arguments, then answers "done" once the result comes back. */
function scripted(name: string, args: Record<string, unknown>, extraTools: ToolDefinition[] = []): HarnessPlugin {
  const provider: ModelProvider = {
    id: 'scripted',
    name: 'Scripted',
    model: 'scripted',
    async *stream({ messages }) {
      if (messages.at(-1)?.role === 'tool') {
        yield { type: 'text', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name, arguments: args } }
      yield { type: 'finish', reason: 'tool-calls' }
    },
  }
  return {
    id: 'scripted',
    name: 'Scripted',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.registerProvider(provider)
      for (const tool of extraTools) ctx.registerTool(tool)
    },
  }
}

async function auditRecords(t: TestHost): Promise<
  Array<{
    seq: number
    action: string
    actor: { deviceId?: string; listener: string }
    target?: string
    stepup: string
    detail: Record<string, unknown>
  }>
> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

/**
 * The session's one pending approval, once the session's detail shows it too: the runtime lists an approval as soon as
 * it starts waiting, before the state commit that records it on the session has been written.
 */
async function pendingApproval(t: TestHost, sessionId: string): Promise<Approval> {
  await expect.poll(() => t.host.bridge.approvals().filter(item => item.sessionId === sessionId).length, { timeout: 10_000 }).toBe(1)
  const approval = t.host.bridge.approvals().find(item => item.sessionId === sessionId)!
  await expect
    .poll(async () => (await t.host.bridge.detail(sessionId)).approvals.map(item => item.id), { timeout: 10_000 })
    .toEqual([approval.id])
  return approval
}

/** A project created the way the desktop app does it: over host.sock, with a body its device key signed. */
async function addProject(desktop: TestDevice, paths: string[], name?: string) {
  const response = await desktop.addFolders({ paths, ...(name !== undefined ? { name } : {}) })
  const result = await body<{ workspace: WorkspaceInfo; refused: Array<{ path: string; code: string; message: string }> }>(response)
  if (response.status !== 201) throw new HttpFailure(response.status, result)
  return result
}

async function settled(t: TestHost, sessionId: string) {
  await expect.poll(async () => (await t.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
}

/** Reads an event stream in the background; `done` turns true when the Host ends it. */
async function openStream(device: TestDevice, path: string): Promise<{ text: string; done: boolean }> {
  const controller = new AbortController()
  const response = await device.request(path, { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const state = { text: '', done: false }
  const decoder = new TextDecoder()
  const reading = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        state.done = true
        return
      }
      state.text += decoder.decode(next.value, { stream: true })
    }
  })().catch(() => {})
  cleanups.push(async () => {
    controller.abort()
    await reading
  })
  return state
}

/** A full-access plugin harness that reports a launch preview and only records starts; tests change `launch` between starts. */
function launchedHarness() {
  const launch: { launchHash: string; definitionHash?: string; command: string; args: string[]; verified: boolean } = {
    launchHash: 'a'.repeat(64),
    command: '/usr/bin/true',
    args: [],
    verified: false,
  }
  const createTask = vi.fn(async (_input: unknown) => ({ sessionId: `launched-${randomUUID()}` }))
  const prompt = vi.fn(async (..._args: unknown[]) => {})
  const setConfig = vi.fn(async (..._args: unknown[]) => {})
  const plugin: HarnessPlugin = {
    id: 'launched-plugin',
    name: 'Launched',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.registerHarness({
        id: 'launched',
        name: 'Launched',
        version: '1',
        create: () => ({
          start: async () => {},
          close: async () => {},
          listTasks: async () => [],
          detail: async () => {
            throw new AppError(404, 'task-not-found', '找不到该任务')
          },
          createTask,
          prompt,
          setConfig,
          cancel: async () => {},
          approvals: () => [],
          decide: async () => false,
          subscribe: () => () => {},
          launchPreview: async ({ cwd }) => ({
            ...launch,
            args: [...launch.args],
            envNames: [],
            cwd,
            approvals: 'none',
            readback: 'none',
          }),
        }),
      })
    },
  }
  return { plugin, createTask, prompt, setConfig, launch }
}

function waitForApproval(device: TestDevice, confirmation: ConfirmationTicket) {
  return expect
    .poll(async () => (await device.json<{ confirmation: ConfirmationTicket }>(`confirmations/${confirmation.id}`)).confirmation.status)
    .toBe('approved')
}

function randomInvitationCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  return `lpi1-${Array.from({ length: 26 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`
}

async function startTask(device: TestDevice, prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await device.confirmed('tasks', { method: 'POST', body: { prompt, requestId: randomUUID(), mode: 'agent', ...extra } })
  const result = await body<{ sessionId: string; error?: string }>(response)
  if (response.status !== 201) throw new HttpFailure(response.status, result)
  return result.sessionId
}

describe('listeners and request context', () => {
  it('serves loopback on 127.0.0.1 and ::1 with one port and enforces the exact Host header', async () => {
    const t = await testHost()
    const port = t.host.loopbackPort
    const host = new URL(t.host.loopbackOrigin).host
    expect(t.host.loopbackOrigin).toBe(`http://h-${t.host.hostId}.localhost:${port}`)
    for (const address of ['127.0.0.1', '::1']) {
      const health = await rawHttp(address, port, '/link/api/health', { host })
      expect(health.status).toBe(200)
      expect(JSON.parse(health.text)).toEqual({ ok: true, hostId: t.host.hostId })
    }
    for (const loose of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      for (const path of ['/', '/link']) {
        const redirect = await rawHttp('127.0.0.1', port, path, { host: loose })
        expect(redirect.status).toBe(302)
        expect(redirect.headers.location).toBe(`${t.host.loopbackOrigin}/link/`)
      }
      expect(JSON.parse((await rawHttp('127.0.0.1', port, '/link/api/health', { host: loose })).text)).toMatchObject({
        error: 'invalid-host',
      })
    }
    expect((await rawHttp('127.0.0.1', port, '/', { host: 'attacker.example' })).status).toBe(403)
    expect((await rawHttp('127.0.0.1', port, '/link/api/health', { host: `h-${t.host.hostId}.localhost:1` })).status).toBe(403)
  })

  it('rejects cross-site origins on TCP, ignores the Host header on the socket, and never reads proxy headers', async () => {
    const t = await testHost()
    const host = new URL(t.host.loopbackOrigin).host
    for (const origin of ['https://attacker.example', 'null', `http://localhost:${t.host.loopbackPort}`]) {
      const response = await rawHttp('127.0.0.1', t.host.loopbackPort, '/link/api/health', { host, origin })
      expect(response.status).toBe(403)
      expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid-origin' })
    }
    expect((await rawHttp('127.0.0.1', t.host.loopbackPort, '/link/api/health', { host, origin: t.host.loopbackOrigin })).status).toBe(200)
    expect(
      (await rawHttp('127.0.0.1', t.host.loopbackPort, '/link/api/enrollments', { host, 'sec-fetch-site': 'cross-site' }, 'POST', '{}'))
        .status,
    ).toBe(403)
    const unix = await t.raw('unix', 'api/health', { headers: { host: 'anything.example', origin: 'https://attacker.example' } })
    expect(unix.status).toBe(200)
    expect(await unix.text()).toBe(`{"ok":true,"hostId":"${t.host.hostId}"}`)
    const forwarded = await rawHttp('127.0.0.1', t.host.loopbackPort, '/link/api/health', {
      host: 'attacker.example',
      'x-forwarded-host': host,
      forwarded: `host=${host}`,
    })
    expect(forwarded.status).toBe(403)
  })

  it('answers health with exactly ok and the public hostId, sends the common headers, and serves host-info only on the socket', async () => {
    const t = await testHost()
    const health = await t.raw('loopback-tcp', 'api/health')
    expect(await health.text()).toBe(`{"ok":true,"hostId":"${t.host.hostId}"}`)
    expect(
      Object.fromEntries(
        ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'cache-control'].map(name => [name, health.headers.get(name)]),
      ),
    ).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    })
    expect(await body(await t.raw('loopback-tcp', 'api/host-info'))).toMatchObject({ error: 'not-found' })
    const info = await body<Record<string, unknown>>(await t.raw('unix', 'api/host-info'))
    expect(info).toEqual({
      product: 'Latch',
      version: '0.1.0',
      hostId: t.host.hostId,
      instanceId: t.host.instanceId,
      pid: process.pid,
      startedAt: t.host.startedAt,
      loopbackOrigin: t.host.loopbackOrigin,
      tlsOrigin: null,
      devMode: true,
      presence: { status: 'available' },
      activeSessions: 0,
      activity: { running: 0, waiting: 0 },
      // Times and a count for the desktop app's keep-awake around scheduled runs; no IDs.
      scheduleWake: { running: 0 },
      protocol: 1,
      // The preview tabs of the desktop app may not reach it (apps/desktop/src/browser.cjs).
      modelGatewayPort: expect.any(Number),
    })
    for (const path of ['api/login', 'api/pair']) {
      const removed = await t.raw('loopback-tcp', path, { method: 'POST', body: { token: 'x' } })
      expect(removed.status).toBe(410)
      expect(await body(removed)).toMatchObject({ error: 'login-removed' })
    }
  })

  it('answers an address that is no page with a plain page back to the app, reflecting nothing, and keeps JSON for the API', async () => {
    const uiDir = await temporaryDirectory('latch-ui-')
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Latch</title>')
    const t = await testHost({ uiDir })
    expect((await t.raw('loopback-tcp', '')).status).toBe(200)
    const host = { host: new URL(t.host.loopbackOrigin).host }
    for (const path of ['/link/report.md', '/link/notes/plan.md', '/link/assets/', '/report.md']) {
      const page = await rawHttp('127.0.0.1', t.host.loopbackPort, path, host)
      expect(page.status, path).toBe(404)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      expect(page.headers['x-frame-options']).toBe('DENY')
      expect(page.text).toContain('找不到这个页面')
      expect(page.text).toContain('<a href="/link/">回到 Latch</a>')
      expect(page.text).not.toMatch(/<script|report|plan\.md/u)
    }
    const head = await rawHttp('127.0.0.1', t.host.loopbackPort, '/link/report.md', host, 'HEAD')
    expect([head.status, head.text]).toEqual([404, ''])
    const api = await t.raw('loopback-tcp', 'api/no-such-route')
    expect(api.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await body(api)).toMatchObject({ error: expect.any(String) })
  })

  it('creates host.sock 0600 in a private runtime directory, removes it on shutdown and refuses an insecure one at startup', async () => {
    const t = await testHost()
    expect((await stat(t.host.socketPath)).mode & 0o777).toBe(0o600)
    expect((await stat(t.host.runtimeDir)).mode & 0o777).toBe(0o700)
    const { dataDir, root } = t
    const runtimeParent = join(root, 'r')
    await t.host.close()
    const runtimeDir = join(await realpath(runtimeParent), `latch-${t.host.hostId8}`)
    await expect(stat(runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(runtimeDir, { mode: 0o755 })
    await chmod(runtimeDir, 0o755)
    const again = await temporaryDirectory()
    await expect(startTestHost({ dataDir, runtimeParent, workspaceRoot: join(again, 'workspace') })).rejects.toMatchObject({
      code: 'runtime-dir-insecure',
    })
  })

  it('refuses unsafe TLS material and rejects local peers on the TLS entry unless a test allows them', async () => {
    const directory = await temporaryDirectory()
    const tls = await makeTestTls(join(directory, 'tls'))
    const port = await freeTcpPort()
    const base = { host: '127.0.0.1', port, certPath: tls.certPath, keyPath: tls.keyPath, publicOrigin: `https://${tls.hostname}:${port}` }
    let attempt = 0
    const start = (input: Partial<typeof base> & { allowLocalPeers?: boolean }) =>
      startTestHost({ dataDir: join(directory, `data-${attempt++}`), tls: { ...base, ...input } })
    await expect(start({ publicOrigin: `https://other.example:${port}` })).rejects.toMatchObject({ code: 'tls-invalid' })
    await expect(start({ publicOrigin: `https://${tls.hostname}:${port}/link` })).rejects.toMatchObject({ code: 'tls-invalid' })
    await expect(start({ publicOrigin: `http://${tls.hostname}:${port}` })).rejects.toMatchObject({ code: 'tls-invalid' })
    await chmod(tls.keyPath, 0o644)
    await expect(start({})).rejects.toMatchObject({ code: 'private-file-insecure' })
    await chmod(tls.keyPath, 0o600)
    const t = await start({})
    cleanups.push(() => t.close())
    expect(t.host.tlsOrigin).toBe(base.publicOrigin)
    await expect(t.raw('tls', 'api/health')).rejects.toThrow()
    expect((await t.raw('loopback-tcp', 'api/health')).status).toBe(200)
  })

  it('binds TLS only to one named IP address and classifies IPv4-mapped tailnet addresses as tailnet', async () => {
    const directory = await temporaryDirectory()
    const tls = await makeTestTls(join(directory, 'tls'))
    const base = { port: 0, certPath: tls.certPath, keyPath: tls.keyPath, publicOrigin: `https://${tls.hostname}:4443` }
    const validate = (host: string) => validateTls({ ...base, host }, Date.now(), () => {})
    for (const host of [
      '0.0.0.0',
      '0.1.2.3',
      '::',
      '[::]',
      '0:0:0:0:0:0:0:0',
      '0::0',
      '::0.0.0.0',
      '::ffff:0:0',
      '::ffff:0.0.0.0',
      '[0:0:0:0:0:ffff:0:0]',
      'latch-test.localhost',
      '127.1',
      'fe80::1%lo0',
      '',
    ]) {
      await expect(validate(host), host).rejects.toMatchObject({ code: 'tls-invalid' })
    }
    expect(await validate('[::FFFF:100.64.0.7]')).toMatchObject({ host: '::ffff:6440:7', listener: 'tailnet-tls' })
    expect(await validate('100.100.1.2')).toMatchObject({ host: '100.100.1.2', listener: 'tailnet-tls' })
    expect(await validate('0:0::ffff:c0a8:0101')).toMatchObject({ host: '::ffff:c0a8:101', listener: 'lan-tls' })
    expect(tlsListenerClass('::ffff:100.127.255.255')).toBe('tailnet-tls')
    expect(tlsListenerClass('::ffff:100.128.0.1')).toBe('lan-tls')
    expect(tlsListenerClass('fd7a:115c:a1e0::1')).toBe('tailnet-tls')
  })

  it('refuses a plaintext non-loopback host option', async () => {
    const directory = await temporaryDirectory()
    await expect(startTestHost({ dataDir: join(directory, 'data'), host: '192.168.1.20' })).rejects.toThrow('明文局域网接入已移除')
  })
})

describe('enrollment and credentials', () => {
  it('enrolls a loopback browser end to end with a host-bound HttpOnly cookie', async () => {
    const t = await testHost()
    const info = await body<EnrollmentInfo>(await t.raw('loopback-tcp', 'api/enrollment-info'))
    expect(info).toMatchObject({
      hostId: t.host.hostId,
      listener: 'loopback-tcp',
      invitationRequired: true,
      offlineCodeAccepted: false,
      presence: { status: 'available' },
    })
    expect(info.firstDevice).toBeUndefined()
    expect((await t.raw('loopback-tcp', 'api/snapshot')).status).toBe(401)
    // Loopback is not this computer: a browser there needs an invitation, as the desktop app's 「在这台电脑的浏览器中打开」 gives it.
    const { testDeviceKey } = await import('@latch/testkit')
    const uninvited = await t.raw('loopback-tcp', 'api/enrollments', {
      method: 'POST',
      body: { publicKey: testDeviceKey().spki, name: 'x' },
    })
    expect(uninvited.status).toBe(403)
    expect(await body(uninvited)).toMatchObject({ error: 'invitation-required' })
    expect(t.presence.requests).toHaveLength(0)
    const invitation = await t.invite([...ADMIN], 'loopback-tcp')
    expect(invitation.url).toBe(`${t.host.loopbackOrigin}/link/#pair=${invitation.code}`)
    const device = await t.enroll({ name: '我的浏览器', scopes: [...ADMIN], invitation: invitation.code })
    expect(device.device.pairedBy.method).toBe('invitation')
    expect(device.cookie).toMatch(new RegExp(`^latch_${t.host.hostId8}=ldc1\\.dev_`))
    expect(t.presence.requests.at(-1)!.preview).toMatchObject({ action: 'device.enroll', title: '允许新设备连接' })
    expect(t.presence.requests.at(-1)!.preview.lines).toContainEqual({ label: '设备指纹', value: device.device.fingerprint })
    const snapshot = await device.json<AppSnapshot>('snapshot')
    expect(snapshot.device).toMatchObject({
      id: device.id,
      current: true,
      listener: 'loopback-tcp',
      name: '我的浏览器',
      renewAfter: expect.any(String),
    })
    expect(snapshot.host).toEqual({
      native: {
        enabled: false,
        discoveryEpoch: expect.stringMatching(/^[a-f0-9]{64}$/u),
        directoryEpoch: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      hostId: t.host.hostId,
      devMode: true,
      presence: { status: 'available' },
      tls: null,
    })
    expect(JSON.stringify(snapshot)).not.toContain(device.credential)
  })

  it('sets cookie attributes exactly and binds the credential to its listener', async () => {
    const t = await testHost({ tls: true })
    const key = await t.enroll({ scopes: [...ADMIN] })
    // Re-run one enrollment by hand to read the Set-Cookie header.
    const second = await t.raw('loopback-tcp', 'api/enrollments', {
      method: 'POST',
      body: { publicKey: key.key.spki, name: 'again', invitation: (await t.invite(undefined, 'loopback-tcp')).code },
    })
    expect(second.status).toBe(202)
    const browser = await t.enroll({ name: 'Cookie check' })
    const response = await browser.request('snapshot')
    expect(response.status).toBe(200)
    const tlsDevice = await t.enroll({ listener: 'tls', name: 'Phone' })
    expect(tlsDevice.cookie).toMatch(new RegExp(`^__Host-latch_${t.host.hostId8}=`))
    const tlsSnapshot = await tlsDevice.request('snapshot')
    expect(tlsSnapshot.headers.get('strict-transport-security')).toBe('max-age=31536000')
    // The loopback credential under the TLS cookie name: right shape, wrong listener.
    const crossed = await t.raw('tls', 'api/snapshot', { headers: { cookie: `__Host-latch_${t.host.hostId8}=${browser.credential}` } })
    expect(crossed.status).toBe(401)
    expect(await body(crossed)).toMatchObject({ error: 'listener-mismatch' })
    expect(t.host.security.devices.get(browser.id)?.status).toBe('active')
    // The TCP cookie is ignored on the socket and the socket header is ignored on TCP.
    expect(await body(await t.raw('unix', 'api/snapshot', { headers: { cookie: browser.cookie! } }))).toMatchObject({
      error: 'unauthorized',
    })
    expect(
      await body(await t.raw('loopback-tcp', 'api/snapshot', { headers: { authorization: `Latch-Device ${browser.credential}` } })),
    ).toMatchObject({ error: 'unauthorized' })
    // Two cookies with the same name count as none.
    expect((await t.raw('loopback-tcp', 'api/snapshot', { headers: { cookie: `${browser.cookie}; ${browser.cookie}` } })).status).toBe(401)
  })

  it('returns the exact Set-Cookie for loopback and TLS enrollments', async () => {
    const t = await testHost({ tls: true })
    const { testDeviceKey, enrollSigningText } = await import('@latch/testkit')
    for (const listener of ['loopback-tcp', 'tls'] as const) {
      const key = testDeviceKey()
      const invitation = (await t.invite(undefined, listener)).code
      const created = await body<{ enrollment: { id: string; nonce: string } }>(
        await t.raw(listener, 'api/enrollments', { method: 'POST', body: { publicKey: key.spki, name: 'n', invitation } }),
      )
      await expect
        .poll(
          async () =>
            (await body<{ enrollment: { status: string } }>(await t.raw(listener, `api/enrollments/${created.enrollment.id}`))).enrollment
              .status,
        )
        .toBe('approved')
      const completed = await t.raw(listener, `api/enrollments/${created.enrollment.id}/complete`, {
        method: 'POST',
        body: { signature: key.sign(enrollSigningText(t.host.hostId, created.enrollment.id, created.enrollment.nonce)) },
      })
      expect(completed.status).toBe(200)
      const result = await body<{ device: Device; credential?: string }>(completed)
      expect(result.credential).toBeUndefined()
      const cookie = (completed.headers as unknown as { getSetCookie(): string[] }).getSetCookie()[0]!
      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1])
      expect(Math.abs(maxAge - 30 * 24 * 3600)).toBeLessThan(5)
      if (listener === 'tls')
        expect(cookie).toMatch(
          new RegExp(`^__Host-latch_${t.host.hostId8}=ldc1\\.[^;]+; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=\\d+$`),
        )
      else expect(cookie).toMatch(new RegExp(`^latch_${t.host.hostId8}=ldc1\\.[^;]+; HttpOnly; SameSite=Strict; Path=/; Max-Age=\\d+$`))
      expect(cookie).not.toMatch(/Domain/i)
    }
  })

  it("lists the enrollments still waiting, with the fingerprint to compare, to the desktop's admins only", async () => {
    const t = await testHost({ tls: true })
    const { testDeviceKey } = await import('@latch/testkit')
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const member = await t.enroll({ listener: 'unix', scopes: ['view', 'run'] })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const { invitation } = await desktop.json<{ invitation: InvitationView }>('pairings', {
      method: 'POST',
      body: { scopes: ['view', 'run'] },
    })
    t.presence.mode = 'manual'
    const created = await body<{ enrollment: EnrollmentView }>(
      await t.raw('tls', 'api/enrollments', {
        method: 'POST',
        body: { publicKey: testDeviceKey().spki, name: '新手机', invitation: invitation.code },
      }),
    )
    await t.presence.waitForRequest()
    const { enrollment } = created
    // A device on another computer's browser is named in the system sheet by the name it gave.
    expect(enrollment.reason).toBe('允许「新手机」连接这台 Mac')
    expect(await desktop.json('enrollments')).toEqual({
      enrollments: [
        {
          id: enrollment.id,
          name: '新手机',
          fingerprint: enrollment.fingerprint,
          listener: 'lan-tls',
          method: 'invitation',
          status: 'pending',
          expiresAt: enrollment.expiresAt,
          invitationId: invitation.id,
          reason: enrollment.reason,
          scopes: enrollment.scopes,
          dataScope: enrollment.dataScope,
        },
      ],
      blockingTasks: [],
    })
    expect(await body(await browser.request('enrollments'))).toMatchObject({ error: 'local-only' })
    expect(await body(await member.request('enrollments'))).toMatchObject({ error: 'scope-required', required: 'admin' })
    expect((await t.raw('unix', 'api/enrollments')).status).toBe(401)
    t.presence.denyNext()
    await expect.poll(async () => (await desktop.json<{ enrollments: unknown[] }>('enrollments')).enrollments).toEqual([])
  })

  it("lets the desktop's own first connection in with no confirmation, on record, and asks of every device after it", async () => {
    const t = await testHost()
    const { testDeviceKey } = await import('@latch/testkit')
    const info = () => t.raw('unix', 'api/enrollment-info').then(response => body<EnrollmentInfo>(response))
    expect((await info()).firstDevice).toBe(true)
    // The socket alone: a loopback peer may have come through a forwarded port.
    expect(
      await body(await t.raw('loopback-tcp', 'api/enrollments', { method: 'POST', body: { publicKey: testDeviceKey().spki, name: 'x' } })),
    ).toMatchObject({
      error: 'invitation-required',
    })
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    expect(t.presence.requests).toHaveLength(0)
    expect((await auditRecords(t)).find(record => record.action === 'device.enrolled')).toMatchObject({
      stepup: 'none',
      detail: { deviceId: desktop.id },
    })
    expect((await info()).firstDevice).toBe(false)
    await t.enroll({ listener: 'unix', name: 'Second' })
    expect(t.presence.requests.at(-1)!.preview).toMatchObject({ action: 'device.enroll' })
    expect(t.presence.requests.at(-1)!.preview.lines).toContainEqual({ label: '来源地址', value: '本机 host.sock' })
    // Removing every device does not reopen it.
    const asked = t.presence.requests.length
    for (const { id, status } of t.host.security.devices.list())
      if (status !== 'revoked') await t.host.security.devices.revoke(id, 'manual', { listener: 'host', via: 'startup' })
    expect((await info()).firstDevice).toBe(false)
    await t.enroll({ listener: 'unix', name: 'Third' })
    expect(t.presence.requests).toHaveLength(asked + 1)
  })

  it('enrolls over host.sock with the credential in JSON only, and admits anonymous socket callers to a few routes', async () => {
    const t = await testHost({ tls: true })
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    expect(desktop.credential).toMatch(/^ldc1\.dev_/)
    expect(desktop.device.scopes.sort()).toEqual(['admin', 'approve:elevated', 'approve:standard', 'run', 'secrets', 'view'])
    expect((await desktop.request('snapshot')).status).toBe(200)
    expect((await t.raw('unix', 'api/snapshot')).status).toBe(401)
    expect((await t.raw('unix', 'api/devices')).status).toBe(200)
    expect((await t.raw('unix', 'api/policy')).status).toBe(401)
    expect((await t.raw('unix', 'api/devices/current', { method: 'DELETE' })).status).toBe(401)
    const invitation = await t.invite(['view', 'run', 'approve:standard', 'admin'])
    expect(invitation).toMatchObject({
      code: expect.stringMatching(/^lpi1-[A-Z2-7]{26}$/),
      url: `${t.host.tlsOrigin}/link/#pair=${invitation.code}`,
      scopes: ['view', 'run', 'approve:standard', 'admin'],
    })
  })

  it('refuses TLS enrollment without an invitation and invitations from TCP listeners', async () => {
    const t = await testHost({ tls: true })
    const { testDeviceKey } = await import('@latch/testkit')
    const info = await body<EnrollmentInfo>(await t.raw('tls', 'api/enrollment-info'))
    expect(info).toMatchObject({ listener: 'lan-tls', invitationRequired: true, offlineCodeAccepted: false })
    expect(info.firstDevice).toBeUndefined()
    const refused = await t.raw('tls', 'api/enrollments', { method: 'POST', body: { publicKey: testDeviceKey().spki, name: 'Phone' } })
    expect(refused.status).toBe(403)
    expect(await body(refused)).toMatchObject({ error: 'invitation-required' })
    expect(t.presence.requests).toHaveLength(0)
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const phone = await t.enroll({ listener: 'tls', scopes: [...ADMIN] })
    for (const device of [admin, phone]) {
      const response = await device.request('pairings', { method: 'POST', body: {} })
      expect(response.status).toBe(403)
      expect(await body(response)).toMatchObject({ error: 'local-only' })
    }
    const plain = await testHost()
    const response = await plain.raw('unix', 'api/pairings', { method: 'POST', body: {} })
    expect(response.status).toBe(409)
    expect(await body(response)).toMatchObject({ error: 'tls-not-configured' })
    // A browser on this computer needs no HTTPS entry: its invitation is for loopback.
    const browser = await body<{ invitation: InvitationView }>(
      await plain.raw('unix', 'api/pairings', { method: 'POST', body: { target: 'loopback' } }),
    )
    expect(browser.invitation.url).toBe(`${plain.host.loopbackOrigin}/link/#pair=${browser.invitation.code}`)
    expect(browser.invitation.scopes).toEqual(['view', 'run', 'approve:standard', 'approve:elevated'])
  })

  it('keeps a browser enrolled over loopback without an invitation by an earlier build working, as a remote device', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    // Both Hosts take the same port: loopback credentials are bound to the origin, port included.
    const port = await freeTcpPort()
    const before = await testHost({ dataDir, port })
    const browser = await before.enroll({ name: 'Old browser', scopes: [...ADMIN] })
    await before.close()
    // What an earlier build stored for it: a local confirmation over loopback, with no invitation.
    const file = join(dataDir, 'auth', 'devices.json')
    const stored = JSON.parse(await readFile(file, 'utf8')) as { devices: Array<{ id: string; pairedBy: unknown }> }
    stored.devices.find(device => device.id === browser.id)!.pairedBy = { method: 'lpc' }
    await writeFile(file, JSON.stringify(stored), { mode: 0o600 })

    const after = await testHost({ dataDir, port })
    const request = (path: string, init: { method?: string; body?: unknown } = {}) =>
      after.raw('loopback-tcp', `api/${path}`, { ...init, headers: { cookie: browser.cookie! } })
    expect(await body(await request('snapshot'))).toMatchObject({ device: { id: browser.id, listener: 'loopback-tcp', status: 'active' } })
    expect((await request('devices')).status).toBe(200)
    // Remote rules, as before: no local confirmation and no key scope.
    expect(await body(await request('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11434'] } } }))).toMatchObject(
      {
        error: 'local-only',
      },
    )
    const desktop = await after.enroll({ listener: 'unix' })
    expect(
      await body(await desktop.request(`devices/${browser.id}`, { method: 'PATCH', body: { scopes: [...ADMIN, 'secrets'] } })),
    ).toMatchObject({ error: 'scope-not-grantable' })
    expect(after.presence.requests.filter(item => item.preview.requester.listener === 'loopback-tcp')).toHaveLength(0)
  })

  it('lets no listener but host.sock enroll uninvited, use an offline code or show a local confirmation', async () => {
    const t = await testHost({ tls: true, presenceMode: 'manual' })
    const { testDeviceKey } = await import('@latch/testkit')
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const browser = await t.enroll({ name: 'Browser', scopes: [...ADMIN] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: [...ADMIN] })
    expect([browser.device.listener, phone.device.listener]).toEqual(['loopback-tcp', 'lan-tls'])
    const { code } = await createOfflineTicket(join(t.dataDir, 'auth'))
    const shown = t.presence.requests.length
    for (const listener of ['loopback-tcp', 'tls'] as const) {
      const enroll = (extra: Record<string, string> = {}) =>
        t.raw(listener, 'api/enrollments', { method: 'POST', body: { publicKey: testDeviceKey().spki, name: 'x', ...extra } })
      expect(await body(await enroll())).toMatchObject({ error: 'invitation-required' })
      expect(await body(await enroll({ offlineCode: code }))).toMatchObject({ error: 'offline-code-invalid' })
      // An invitation opens only the listener it was issued for.
      const foreign = await t.invite(undefined, listener === 'tls' ? 'loopback-tcp' : 'tls')
      expect(await body(await enroll({ invitation: foreign.code }))).toMatchObject({ error: 'invitation-invalid' })
    }
    for (const device of [browser, phone]) {
      expect(
        await body(await device.request('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11434'] } } })),
      ).toMatchObject({
        error: 'local-only',
      })
      expect(await body(await device.request('pairings', { method: 'POST', body: { target: 'loopback' } }))).toMatchObject({
        error: 'local-only',
      })
    }
    expect(t.presence.requests).toHaveLength(shown)

    // host.sock takes the offline code that loopback and TLS refused, and its raise reaches the confirmation window.
    const offline = await t.raw('unix', 'api/enrollments', {
      method: 'POST',
      body: { publicKey: testDeviceKey().spki, name: 'Second desktop', offlineCode: code },
    })
    expect(await body(offline)).toMatchObject({ enrollment: { status: 'approved' } })
    const raised = await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11434'] } } })
    expect(await body(raised)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'policy.change' } })
    await t.presence.waitForRequest()
    expect(t.presence.requests).toHaveLength(shown + 1)
    expect(t.presence.requests.at(-1)!.preview.requester).toMatchObject({ listener: 'unix', remoteAddress: '本机 host.sock' })
    t.presence.denyNext()
  })

  it('renews over HTTP after 24 hours and revokes on replay of a rotated credential after the grace window', async () => {
    let clock = Date.now()
    const t = await testHost({ now: () => clock })
    const device = await t.enroll({ scopes: [...ADMIN] })
    const before = device.credential
    clock += 25 * 3600_000
    const due = await device.request('snapshot')
    expect(due.status).toBe(401)
    expect(await body(due)).toMatchObject({ error: 'renewal-required' })
    await device.renew()
    expect(device.credential).not.toBe(before)
    expect((await device.request('snapshot')).status).toBe(200)
    // Within the grace window the previous credential still reads.
    expect((await t.raw('loopback-tcp', 'api/snapshot', { headers: { cookie: `latch_${t.host.hostId8}=${before}` } })).status).toBe(200)
    clock += 2 * 60_000
    const replay = await t.raw('loopback-tcp', 'api/snapshot', { headers: { cookie: `latch_${t.host.hostId8}=${before}` } })
    expect(await body(replay)).toMatchObject({ error: 'device-revoked' })
    expect((await device.request('snapshot')).status).toBe(401)
    expect(t.host.security.devices.get(device.id)).toMatchObject({ status: 'revoked', revokedReason: 'replay' })
  })

  it('ends an event stream once the credential that opened it is due for renewal or rotated out', async () => {
    let clock = Date.now()
    const t = await testHost({ now: () => clock })
    const device = await t.enroll({ scopes: [...ADMIN] })
    const { sessionId } = await device.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat' },
    })
    await settled(t, sessionId)
    const rename = (title: string) => t.host.bridge.updateMeta(sessionId, { title })

    const overdue = await openStream(device, `events?sessionId=${sessionId}`)
    clock += 25 * 3600_000
    await rename('after-deadline')
    await vi.waitFor(() => expect(overdue.done).toBe(true), { timeout: 5_000 })
    expect(overdue.text).not.toContain('after-deadline')

    await device.renew()
    const rotated = await openStream(device, `events?sessionId=${sessionId}`)
    clock += 2 * 60_000
    await device.renew()
    const current = await openStream(device, `events?sessionId=${sessionId}`)
    // A rotated-out credential keeps its stream only through the grace window.
    await rename('within-grace')
    await vi.waitFor(() => expect(rotated.text).toContain('within-grace'), { timeout: 5_000 })
    clock += 2 * 60_000
    await rename('after-grace')
    await vi.waitFor(() => expect(rotated.done).toBe(true), { timeout: 5_000 })
    expect(rotated.text).not.toContain('after-grace')
    await vi.waitFor(() => expect(current.text).toContain('after-grace'), { timeout: 5_000 })
    expect(current.done).toBe(false)
  })

  it('throttles only credential-less failures per listener, so a remote flood cannot hide renewal from other devices', async () => {
    let clock = Date.now()
    const t = await testHost({ tls: true, rateLimits: 'default', now: () => clock })
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll()
    const phone = await t.enroll({ listener: 'tls' })
    clock += 25 * 3600_000
    const statuses = new Set<number>()
    for (let index = 0; index < 130; index++) statuses.add((await t.raw('tls', 'api/snapshot')).status)
    expect(statuses).toContain(429)
    for (const device of [desktop, browser, phone]) {
      const due = await device.request('snapshot')
      expect(due.status).toBe(401)
      expect(await body(due)).toMatchObject({ error: 'renewal-required' })
    }
    expect(await body(await t.raw('loopback-tcp', 'api/snapshot'))).toMatchObject({ error: 'unauthorized' })
    await phone.renew()
    expect((await phone.request('snapshot')).status).toBe(200)
  })

  it('keeps an invited phone able to enroll over TLS while uninvited peers exhaust their own budget', async () => {
    const t = await testHost({ tls: true, rateLimits: 'default' })
    const { testDeviceKey } = await import('@latch/testkit')
    const statuses: number[] = []
    for (let index = 0; index < 5; index++) {
      statuses.push(
        (await t.raw('tls', 'api/enrollments', { method: 'POST', body: { publicKey: testDeviceKey().spki, name: 'Peer' } })).status,
      )
    }
    expect(statuses).toContain(429)
    const phone = await t.enroll({ listener: 'tls' })
    expect(phone.device.listener).toBe('lan-tls')
  })

  it('throttles enrollments with invitations this Host never issued on one shared budget that issued ones do not use', async () => {
    const t = await testHost({ tls: true, rateLimits: 'default' })
    const { testDeviceKey } = await import('@latch/testkit')
    const statuses: number[] = []
    for (let index = 0; index < 8; index++) {
      statuses.push(
        (
          await t.raw('tls', 'api/enrollments', {
            method: 'POST',
            body: { publicKey: testDeviceKey().spki, name: 'Peer', invitation: randomInvitationCode() },
          })
        ).status,
      )
    }
    expect(statuses).toEqual([403, 403, 403, 429, 429, 429, 429, 429])
    const phone = await t.enroll({ listener: 'tls' })
    expect(phone.device.listener).toBe('lan-tls')
  })

  it('keeps the old credential current until the renewed one is used, so a lost renewal answer never revokes the device', async () => {
    let clock = Date.now()
    const t = await testHost({ now: () => clock })
    const device = await t.enroll({ scopes: [...ADMIN] })
    const old = device.credential
    const withOld = (path: string, init: { method?: string; body?: unknown } = {}) =>
      t.raw('loopback-tcp', `api/${path}`, { ...init, headers: { cookie: `latch_${t.host.hostId8}=${old}` } })
    clock += 25 * 3600_000
    // The Host issues a credential whose answer never reaches the client.
    const { nonce } = await device.json<{ nonce: string }>('credentials/challenge', { method: 'POST', body: {} })
    const lost = await device.request('credentials/renew', {
      method: 'POST',
      body: { nonce, signature: device.key.sign(renewSigningText(t.host.hostId, device.id, nonce)) },
    })
    expect(lost.status).toBe(200)
    expect(await body(await device.request('snapshot'))).toMatchObject({ error: 'renewal-required' })
    await device.renew()
    expect(device.credential).not.toBe(old)
    expect((await device.request('snapshot')).status).toBe(200)
    // Once replaced, the old credential still reads during the grace window but cannot renew; the new one can, at once.
    expect((await withOld('snapshot')).status).toBe(200)
    expect(await body(await withOld('credentials/challenge', { method: 'POST', body: {} }))).toMatchObject({ error: 'credential-rotated' })
    await device.renew()
    expect((await device.request('snapshot')).status).toBe(200)
    expect(t.host.security.devices.get(device.id)?.status).toBe('active')
    clock += 2 * 60_000
    expect(await body(await withOld('snapshot'))).toMatchObject({ error: 'device-revoked' })
  })

  it('expires every credential 30 days after enrollment', async () => {
    let clock = Date.now()
    const t = await testHost({ now: () => clock })
    const device = await t.enroll()
    clock += 31 * 24 * 3600_000
    expect(await body(await device.request('snapshot'))).toMatchObject({ error: 'credential-expired' })
  })

  it('shows a migrated owner only the re-confirmation, on loopback only, and retires it after re-enrollment', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    await mkdir(join(dataDir, 'auth'), { recursive: true, mode: 0o700 })
    const token = 'legacy-owner-token-value'
    const now = Date.now()
    await writeFile(
      join(dataDir, 'auth', 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: randomUUID(),
            name: 'Old desktop',
            role: 'owner',
            createdAt: new Date(now).toISOString(),
            lastSeenAt: new Date(now).toISOString(),
            revoked: false,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            expiresAt: now + 86_400_000,
          },
          {
            id: randomUUID(),
            name: 'Old phone',
            role: 'controller',
            createdAt: new Date(now).toISOString(),
            lastSeenAt: new Date(now).toISOString(),
            revoked: false,
            tokenHash: createHash('sha256').update('phone').digest('hex'),
            expiresAt: now + 86_400_000,
          },
        ],
        pairings: [],
      }),
      { mode: 0o600 },
    )
    await writeFile(join(dataDir, 'auth', 'owner-token'), 'bootstrap', { mode: 0o600 })
    const t = await testHost({ dataDir, tls: true })
    const legacy = { cookie: `harness_link=${token}` }
    const reconfirm = await t.raw('loopback-tcp', 'api/snapshot', { headers: legacy })
    expect(reconfirm.status).toBe(401)
    expect(await body(reconfirm)).toMatchObject({ error: 'legacy-reconfirm', legacyName: 'Old desktop' })
    expect(
      await body(
        await t.raw('loopback-tcp', 'api/tasks', { method: 'POST', body: { prompt: 'x', requestId: randomUUID() }, headers: legacy }),
      ),
    ).toMatchObject({ error: 'legacy-reconfirm' })
    expect(await body(await t.raw('loopback-tcp', 'api/enrollment-info', { headers: legacy }))).toMatchObject({
      legacy: { name: 'Old desktop' },
    })
    expect(await body(await t.raw('tls', 'api/snapshot', { headers: legacy }))).toMatchObject({ error: 'unauthorized' })
    expect(await body(await t.raw('unix', 'api/devices', { headers: legacy }))).toMatchObject({
      devices: expect.arrayContaining([expect.objectContaining({ name: 'Old phone', status: 'revoked' })]),
    })
    await expect(readFile(join(dataDir, 'auth', 'owner-token'))).rejects.toMatchObject({ code: 'ENOENT' })

    const { testDeviceKey, enrollSigningText } = await import('@latch/testkit')
    const key = testDeviceKey()
    // Re-confirming takes an invitation like any loopback enrollment.
    const refused = await t.raw('loopback-tcp', 'api/enrollments', {
      method: 'POST',
      body: { publicKey: key.spki, name: '' },
      headers: legacy,
    })
    expect(await body(refused)).toMatchObject({ error: 'invitation-required' })
    const invitation = (await t.invite(undefined, 'loopback-tcp')).code
    const created = await body<{ enrollment: { id: string; nonce: string } }>(
      await t.raw('loopback-tcp', 'api/enrollments', {
        method: 'POST',
        body: { publicKey: key.spki, name: '', invitation },
        headers: legacy,
      }),
    )
    await expect
      .poll(
        async () =>
          (await body<{ enrollment: { status: string } }>(await t.raw('loopback-tcp', `api/enrollments/${created.enrollment.id}`)))
            .enrollment.status,
      )
      .toBe('approved')
    const completed = await t.raw('loopback-tcp', `api/enrollments/${created.enrollment.id}/complete`, {
      method: 'POST',
      headers: legacy,
      body: { signature: key.sign(enrollSigningText(t.host.hostId, created.enrollment.id, created.enrollment.nonce)) },
    })
    expect(completed.status).toBe(200)
    expect((await body<{ device: Device }>(completed)).device.name).toBe('Old desktop')
    expect((completed.headers as unknown as { getSetCookie(): string[] }).getSetCookie()).toContain(
      'harness_link=; Path=/link; Max-Age=0; HttpOnly; SameSite=Strict',
    )
    expect(await body(await t.raw('loopback-tcp', 'api/snapshot', { headers: legacy }))).toMatchObject({ error: 'unauthorized' })
  })

  it('cancels, rate-limits and never reveals another enrollment', async () => {
    const t = await testHost({ presenceMode: 'manual', rateLimits: 'default' })
    const { testDeviceKey } = await import('@latch/testkit')
    const create = (invitation?: string) =>
      t.raw('loopback-tcp', 'api/enrollments', {
        method: 'POST',
        body: { publicKey: testDeviceKey().spki, name: 'Browser', ...(invitation ? { invitation } : {}) },
      })
    const first = await body<{ enrollment: { id: string } }>(await create((await t.invite(undefined, 'loopback-tcp')).code))
    await t.presence.waitForRequest()
    expect(await body(await t.raw('unix', `api/enrollments/${first.enrollment.id}`))).toMatchObject({ error: 'listener-mismatch' })
    expect(await body(await t.raw('loopback-tcp', `api/enrollments/${first.enrollment.id}`, { method: 'DELETE' }))).toEqual({
      cancelled: true,
    })
    expect(await body(await t.raw('loopback-tcp', `api/enrollments/${first.enrollment.id}`))).toMatchObject({
      enrollment: { status: 'cancelled' },
    })
    // Uninvited attempts are refused and share one budget; the invited one above had its own.
    const statuses = [(await create()).status, (await create()).status, (await create()).status]
    expect(statuses).toEqual([403, 403, 403])
    const limited = await create()
    expect(limited.status).toBe(429)
    expect(await body(limited)).toMatchObject({ error: 'rate-limited', retryAfter: expect.any(Number) })
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
  })
})

describe('scopes', () => {
  it('limits a view-only device to reading and keeps admin routes for admins', async () => {
    const t = await testHost()
    const viewer = await t.enroll({ scopes: ['view'] })
    expect(viewer.device.scopes).toEqual(['view'])
    expect((await viewer.request('snapshot')).status).toBe(200)
    const run = await viewer.request('tasks', { method: 'POST', body: { prompt: 'hi', requestId: randomUUID(), mode: 'chat' } })
    expect(run.status).toBe(403)
    expect(await body(run)).toMatchObject({ error: 'scope-required', required: 'run', message: '此设备没有「发起和继续会话」权限' })
    const runner = await t.enroll()
    for (const path of ['devices', 'providers', 'provider', 'plugins', 'agents', 'policy']) {
      expect(await body(await runner.request(path))).toMatchObject({ error: 'scope-required', required: 'admin' })
    }
    const admin = await t.enroll({ scopes: [...ADMIN] })
    expect((await admin.request('devices')).status).toBe(200)
    const elevated = await t.raw('loopback-tcp', 'api/enrollments', {
      method: 'POST',
      body: { publicKey: (await import('@latch/testkit')).testDeviceKey().spki, name: 'x', scopes: ['view', 'secrets'] },
    })
    expect(await body(elevated)).toMatchObject({ error: 'scope-not-grantable' })
  })

  it('lowers scopes from any admin, raises them only on the socket with local confirmation, and cascades revocation', async () => {
    const t = await testHost({ tls: true })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const { invitation } = await desktop.json<{ invitation: InvitationView }>('pairings', {
      method: 'POST',
      body: { scopes: ['view', 'run', 'approve:standard'] },
    })
    const phone = await t.enroll({ listener: 'tls', invitation: invitation.code })
    expect(phone.device.pairedBy).toEqual({ method: 'invitation', deviceId: desktop.id })
    const lowered = await admin.json<{ device: Device }>(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
    expect(lowered.device.scopes.sort()).toEqual(['run', 'view'])
    expect(
      await body(await admin.request(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view', 'run', 'approve:standard'] } })),
    ).toMatchObject({ error: 'local-only' })
    expect(
      await body(await desktop.request(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view', 'secrets'] } })),
    ).toMatchObject({ error: 'scope-not-grantable' })
    const raised = await desktop.confirmed(`devices/${phone.id}`, {
      method: 'PATCH',
      body: { scopes: ['view', 'run', 'approve:standard'] },
    })
    expect(raised.status).toBe(200)
    expect(t.presence.requests.at(-1)!.preview).toMatchObject({ action: 'device.grant', title: '为设备增加权限' })
    expect(t.presence.requests.at(-1)!.preview.lines).toContainEqual({ label: '新增权限', value: '批准普通操作' })
    expect(t.presence.requests.at(-1)!.preview.reason).toMatch(/^为「.+」增加权限：批准普通操作$/u)

    expect(await body(await admin.request(`devices/${admin.id}`, { method: 'DELETE' }))).toMatchObject({ error: 'current-device' })
    const revoked = await admin.json<{ revoked: true; cascaded: number }>(`devices/${desktop.id}`, { method: 'DELETE' })
    expect(revoked).toEqual({ revoked: true, cascaded: 1 })
    expect(t.host.security.devices.get(phone.id)).toMatchObject({ status: 'review', scopes: ['view'] })
    expect((await desktop.request('snapshot')).status).toBe(401)
    expect((await phone.request('snapshot')).status).toBe(200)
    const records = await auditRecords(t)
    expect(records.find(record => record.action === 'device.revoked')).toMatchObject({
      actor: { deviceId: admin.id, listener: 'loopback-tcp' },
      detail: { deviceId: desktop.id, cascaded: 1 },
    })
    expect(records.find(record => record.action === 'device.scopes.changed' && record.stepup === 'lpc-local')).toBeTruthy()
  })

  it('lets any device rename and revoke itself, clearing its cookie', async () => {
    const t = await testHost()
    const device = await t.enroll()
    expect(await device.json('devices/current', { method: 'PATCH', body: { name: '书房电脑' } })).toMatchObject({
      device: { id: device.id, name: '书房电脑' },
    })
    expect((await device.json<AppSnapshot>('snapshot')).device.name).toBe('书房电脑')
    expect((await device.request('devices/current', { method: 'PATCH', body: { name: '  ' } })).status).toBe(400)
    const revoked = await device.request('devices/current', { method: 'DELETE' })
    expect(revoked.status).toBe(200)
    expect((revoked.headers as unknown as { getSetCookie(): string[] }).getSetCookie()).toEqual([
      `latch_${t.host.hostId8}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    ])
    expect(await body(await device.request('snapshot'))).toMatchObject({ error: 'device-revoked' })
  })

  it("closes a revoked device's event stream and refuses its delayed requests", async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const phone = await t.enroll()
    const stream = await phone.request('events')
    const reader = stream.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: refresh')
    const pending = halfRequest(t, 'preferences', admin.cookie!, { defaults: { mode: 'chat' } }, 'PUT')
    const revokePhone = halfRequest(t, 'tasks', phone.cookie!, { prompt: 'x', requestId: randomUUID(), mode: 'chat' })
    await new Promise(done => setTimeout(done, 50))
    await admin.json(`devices/${phone.id}`, { method: 'DELETE' })
    await vi.waitFor(async () => expect((await reader.read()).done).toBe(true))
    revokePhone.finish()
    expect(await revokePhone.response).toBe(401)
    pending.finish()
    expect(await pending.response).toBe(200)
  })
})

describe('approvals and risk', () => {
  async function gitWrite() {
    const t = await testHost({
      tls: true,
      demo: false,
      providerId: 'scripted',
      plugins: [scripted('write_file', { path: '.git/config', content: '[core]\n' })],
    })
    await mkdir(join(t.workspaceRoot, '.git'), { recursive: true })
    return t
  }

  it('lets any device with the scope allow an R2 write, with no prompt and on record', async () => {
    const t = await gitWrite()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const trusted = await t.enroll({ scopes: [...ADMIN, 'approve:elevated'] })
    const first = await startTask(browser, 'write the git config')
    const approval =
      (await browser.json<AppSnapshot>('snapshot')).approvals.find(item => item.sessionId === first)
      ?? (await pendingApproval(t, first), (await browser.json<AppSnapshot>('snapshot')).approvals.find(item => item.sessionId === first))!
    expect(approval).toMatchObject({ risk: 'R2', toolName: 'write_file' })
    expect(approval.advisory).toBeUndefined()
    expect(approval.options?.map(option => option.kind)).not.toContain('allow_always')
    expect(await body(await browser.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow' } }))).toMatchObject({
      error: 'scope-required',
      required: 'approve:elevated',
    })
    expect(
      await body(
        await trusted.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', optionId: 'allow_always' } }),
      ),
    ).toMatchObject({ error: 'invalid-option' })
    const rejected = await browser.json<{ accepted: true; receipt: { decision: string } }>(`approvals/${approval.id}`, {
      method: 'POST',
      body: { decision: 'reject' },
    })
    expect(rejected).toMatchObject({ accepted: true, receipt: { approvalId: approval.id, decision: 'reject', at: expect.any(String) } })
    await settled(t, first)

    const second = await startTask(browser, 'write it again')
    const next = await pendingApproval(t, second)
    const confirmations = t.presence.requests.length
    const allowed = await trusted.request(`approvals/${next.id}`, { method: 'POST', body: { decision: 'allow' } })
    expect(allowed.status).toBe(200)
    expect(t.presence.requests).toHaveLength(confirmations)
    await settled(t, second)
    expect(await readFile(join(t.workspaceRoot, '.git', 'config'), 'utf8')).toBe('[core]\n')
    const decided = (await auditRecords(t)).filter(record => record.action === 'approval.decided')
    expect(decided.map(record => [record.detail.decision, record.stepup, record.detail.risk])).toEqual([
      ['reject', 'none', 'R2'],
      ['allow', 'none', 'R2'],
    ])
    expect(decided[1]!.actor).toMatchObject({ deviceId: trusted.id, listener: 'loopback-tcp' })

    const third = await startTask(browser, 'and cancel this one')
    await pendingApproval(t, third)
    expect(await browser.json(`tasks/${third}/cancel`, { method: 'POST', body: {} })).toEqual({
      accepted: true,
      receipt: { sessionId: third, outcome: 'stopped', status: 'cancelled', at: expect.any(String) },
    })
    expect((await auditRecords(t)).some(record => record.action === 'task.cancelled' && record.detail.sessionId === third)).toBe(true)
  })

  it('answers two concurrent copies of one decision with a single decide and one replayed receipt', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const sessionId = await startTask(browser, '生成需要审批的报告')
    const approval = await pendingApproval(t, sessionId)
    const decide = vi.spyOn(t.host.bridge, 'decide')
    const send = () =>
      browser.json<{ receipt: { replay?: true } }>(`approvals/${approval.id}`, {
        method: 'POST',
        body: { decision: 'allow', optionId: 'allow_once', requestId: 'decision-race' },
      })
    const answers = await Promise.all([send(), send()])
    expect(answers.map(answer => Boolean(answer.receipt.replay)).sort()).toEqual([false, true])
    expect(decide).toHaveBeenCalledOnce()
    await settled(t, sessionId)
  })

  it('lets a phone with approve:standard allow an R1 call and replays a retried decision without deciding twice', async () => {
    const t = await testHost({ tls: true })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const phone = await t.enroll({ listener: 'tls' })
    const other = await t.enroll({ name: 'Other browser' })
    const sessionId = await startTask(browser, '生成需要审批的报告')
    const approval = await pendingApproval(t, sessionId)
    const decorated = (await phone.json<TaskDetail>(`tasks/${sessionId}`)).approvals[0]!
    expect(decorated).toMatchObject({ id: approval.id, risk: 'R1' })
    const decide = vi.spyOn(t.host.bridge, 'decide')
    const requestId = 'decision-0001'
    const first = await phone.json<{ receipt: { at: string } }>(`approvals/${approval.id}`, {
      method: 'POST',
      body: { decision: 'allow', optionId: 'allow_once', requestId },
    })
    expect(first).toEqual({
      accepted: true,
      receipt: { approvalId: approval.id, decision: 'allow', optionId: 'allow_once', at: expect.any(String) },
    })
    const replay = await phone.json(`approvals/${approval.id}`, {
      method: 'POST',
      body: { decision: 'allow', optionId: 'allow_once', requestId },
    })
    expect(replay).toEqual({
      accepted: true,
      receipt: { approvalId: approval.id, decision: 'allow', optionId: 'allow_once', at: first.receipt.at, replay: true },
    })
    expect(decide).toHaveBeenCalledOnce()
    expect((await auditRecords(t)).filter(record => record.action === 'approval.decided')).toHaveLength(1)
    const elsewhere = await other.request(`approvals/${approval.id}`, {
      method: 'POST',
      body: { decision: 'reject', requestId: 'decision-0002' },
    })
    expect(elsewhere.status).toBe(409)
    expect(await body(elsewhere)).toMatchObject({
      error: 'approval-settled',
      decidedBy: { kind: 'device', self: false, deviceName: phone.device.name, decision: 'allow', at: first.receipt.at },
    })
    expect(
      await body(
        await phone.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: 'decision-0003' } }),
      ),
    ).toMatchObject({ decidedBy: { kind: 'device', self: true } })
    await settled(t, sessionId)

    const cancelled = await startTask(browser, '再生成一份需要审批的报告')
    const stale = await pendingApproval(t, cancelled)
    await browser.json(`tasks/${cancelled}/cancel`, { method: 'POST', body: {} })
    const system = await phone.request(`approvals/${stale.id}`, { method: 'POST', body: { decision: 'allow', requestId: 'decision-0004' } })
    expect(await body(system)).toMatchObject({ error: 'approval-settled', decidedBy: { kind: 'system' } })
  })

  it('checks the approving scope against the current device record, not the one from when the request arrived', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const phone = await t.enroll()
    const sessionId = await startTask(admin, '生成需要审批的报告')
    const approval = await pendingApproval(t, sessionId)
    const held = halfRequest(t, `approvals/${approval.id}`, phone.cookie!, { decision: 'allow', optionId: 'allow_always' })
    await new Promise(done => setTimeout(done, 50))
    await admin.json(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
    held.finish()
    expect(await held.response).toBe(403)
    expect(t.host.bridge.approvals().some(item => item.id === approval.id)).toBe(true)
    await admin.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
  })

  it('names the option chosen when another device finds the approval already decided', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const other = await t.enroll({ scopes: [...ADMIN], name: 'Other browser' })
    const sessionId = await startTask(browser, '生成需要审批的报告')
    const approval = await pendingApproval(t, sessionId)
    await browser.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', optionId: 'allow_always' } })
    const late = await other.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
    expect(await body(late)).toMatchObject({
      error: 'approval-settled',
      decidedBy: { kind: 'device', self: false, decision: 'allow', optionKind: 'allow_always' },
    })
    await settled(t, sessionId)
  })

  function shellTool(execute: ToolDefinition['execute']): ToolDefinition {
    return {
      name: 'run_shell',
      description: 'fixture',
      parameters: {},
      requiresApproval: true,
      execute,
      preview: async args => ({ title: 'run', diffs: [{ path: 'notes.txt', oldText: 'before', newText: String(args.content) }] }),
    }
  }

  it('asks for a third-party tool even when it declares no approval, and treats it as R2', async () => {
    const execute = vi.fn(async () => ({ text: 'ran' }))
    const tool: ToolDefinition = { name: 'quiet_tool', description: 'fixture', parameters: {}, requiresApproval: false, execute }
    const t = await testHost({ demo: false, providerId: 'scripted', plugins: [scripted('quiet_tool', {}, [tool])] })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const sessionId = await startTask(browser, 'run the quiet tool')
    const approval = await pendingApproval(t, sessionId)
    expect(approval.risk).toBe('R2')
    expect(execute).not.toHaveBeenCalled()
    await browser.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
  })
})

describe('agent settings', () => {
  it('offers a preset found on this computer to the desktop only, until its definition is saved', async () => {
    const t = await testHost({
      detectPreset: preset =>
        preset.id === 'codex'
          ? { found: true, path: '/fake/codex' }
          : preset.id === 'claude-agent'
            ? { found: false, agent: { command: 'claude', found: true } }
            : { found: false },
    })
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ listener: 'loopback-tcp' })
    const harnesses = async (client: typeof desktop) => (await client.json<AppSnapshot>('snapshot')).catalog!.harnesses
    const offered = (await harnesses(desktop)).filter(harness => harness.offer)
    // A program without the adapter that connects it runs nothing, so it is not offered.
    expect(offered).toMatchObject([
      {
        id: 'codex',
        status: 'ready',
        level: 'L3',
        modes: ['agent'],
        catalogueRead: { when: 'select', modes: false },
        offer: { presetId: 'codex' },
      },
    ])
    expect(offered[0]!.permission).toMatchObject({
      approvals: 'prompts',
      readback: 'mode',
      modeTiers: { 'read-only': { tier: 'ask' }, agent: { tier: 'model' }, 'agent-full-access': { tier: 'never' } },
    })
    const facts = offered[0]!.capabilities
    expect(facts).toMatchObject({
      permission: { enforcement: 'harness', rejectionNote: false },
      display: { label: 'Codex', mark: 'codex' },
    })
    expect((await harnesses(browser)).some(harness => harness.offer)).toBe(false)
    // Offering saved nothing, and only saving makes it a Harness like any other.
    expect((await desktop.json<{ agents: unknown[] }>('agents')).agents).toEqual([])
    const saved = await desktop.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {}, enabled: true },
    })
    expect(saved.status).toBe(201)
    const after = await harnesses(desktop)
    expect(after.filter(harness => harness.id === 'codex')).toHaveLength(1)
    expect(after.find(harness => harness.id === 'codex')?.offer).toBeUndefined()
    // What the draft said before anything was saved is what the saved Harness says.
    expect(after.find(harness => harness.id === 'codex')?.capabilities).toEqual(facts)
    // The second save of the same offer, from another window, says it exists instead of making codex-2.
    const again = await desktop.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {}, enabled: true },
    })
    expect(again.status).toBe(409)
    expect((await body<{ error: string }>(again)).error).toBe('agent-exists')
  })

  it('offers nothing unless the start script asks it to look', async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    expect((await desktop.json<AppSnapshot>('snapshot')).catalog!.harnesses.some(harness => harness.offer)).toBe(false)
  })

  it('finds no command by name unless the start script names where to look', async () => {
    // `node` is on this computer's PATH for certain; a test Host must still not find it, or any agent installed here.
    const t = await testHost({ agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent) })
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmed('agents', {
      method: 'POST',
      body: { id: 'by-name', name: 'By name', command: 'node', args: [], env: {} },
    })
    const listed = await desktop.json<{ agents: AgentSettings[]; presets: AgentPresetSettings[] }>('agents')
    expect(listed.agents[0]!.detected).toEqual({ found: false })
    expect(listed.presets.filter(preset => preset.detected?.found || preset.detected?.agent?.found)).toEqual([])
    const harness = (await desktop.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'by-name')!
    expect(harness).toMatchObject({ status: 'unavailable', statusMessage: '未找到命令 node' })
  })

  it('tells only the desktop app the name of this computer', async () => {
    const t = await testHost({ hostName: 'my-mac.local' })
    expect((await body<EnrollmentInfo>(await t.raw('unix', 'api/enrollment-info'))).hostName).toBe('my-mac')
    expect((await body<EnrollmentInfo>(await t.raw('loopback-tcp', 'api/enrollment-info'))).hostName).toBeUndefined()
  })

  it('reports an adapter and the program it drives separately, and looks again on every read', async () => {
    const bin = await temporaryDirectory('latch-agent-bin-')
    const install = async (command: string) => {
      await writeFile(join(bin, command), '#!/bin/sh\n')
      await chmod(join(bin, command), 0o755)
    }
    // Only this directory: whatever is installed on the computer running the test is never found.
    const t = await testHost({ agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent), commandDirectories: () => [bin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const created = await desktop.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    expect(created.status).toBe(201)
    const detected = async () => (await desktop.json<{ agents: AgentSettings[] }>('agents')).agents[0].detected
    const harness = async () => (await desktop.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'codex')!
    // Each preset carries what this computer has of it too, before any agent is added from it.
    const preset = async (id: string) =>
      (await desktop.json<{ presets: AgentPresetSettings[] }>('agents')).presets.find(item => item.id === id)!.detected
    expect(await preset('goose')).toEqual({ found: false })
    // pi runs as itself, with no adapter to look for.
    expect(await preset('pi')).toEqual({ found: false })
    // A definition saved on the adapter keeps saying what the adapter drives; the preset itself is Codex alone.
    expect(await detected()).toEqual({ found: false, agent: { command: 'codex', found: false } })
    expect(await preset('codex')).toEqual({ found: false })
    expect((await harness()).statusMessage).toBe('未找到命令 codex-acp。安装：npm i -g @agentclientprotocol/codex-acp')
    await install('codex')
    expect(await detected()).toEqual({ found: false, agent: { command: 'codex', found: true } })
    expect((await harness()).statusMessage).toBe(
      '已安装 codex，还差让 Latch 连接它的适配器 codex-acp。安装：npm i -g @agentclientprotocol/codex-acp',
    )
    // Codex alone is enough for the preset: it is reached directly. Not confirmed, it is not run for its version yet.
    expect(await preset('codex')).toEqual({ found: true, path: join(bin, 'codex'), versionUnread: true })
    await install('codex-acp')
    // Reading the settings is the re-check: the catalog that follows does not show the earlier lookup.
    expect(await detected()).toEqual({ found: true, path: join(bin, 'codex-acp'), agent: { command: 'codex', found: true } })
    expect((await harness()).status).toBe('ready')
  })
})

/** Data and workspace that outlive one Host, so a second Host can start on them. */
async function restartable() {
  const root = await temporaryDirectory()
  const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
  await mkdir(options.workspaceRoot, { recursive: true })
  return options
}

/**
 * The same device on a Host started later on the same data and port: a loopback credential is bound to the listener's
 * origin, which includes the port.
 */
function again(t: TestHost, device: TestDevice, path: string, payload: unknown): Promise<Response> {
  return t.raw('loopback-tcp', `api/${path}`, { method: 'POST', body: payload, headers: { cookie: device.cookie! } })
}

async function runningSession(device: TestDevice, t: TestHost): Promise<{ sessionId: string; runId: string }> {
  const sessionId = await startTask(device, '运行 30 秒长任务')
  await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, { timeout: 10_000 }).toBe('running')
  const { runId } = await t.host.bridge.summary(sessionId)
  expect(runId).toEqual(expect.any(String))
  return { sessionId, runId: runId! }
}

describe('receipts and cancels', () => {
  it('keeps an approval decision across a restart: the same request replays it, and another device learns who decided', async () => {
    const options = await restartable()
    const first = await testHost(options)
    const phone = await first.enroll({ name: '测试手机', scopes: [...ADMIN] })
    const other = await first.enroll({ name: '另一台电脑' })
    const sessionId = await startTask(phone, '生成需要审批的报告')
    const approval = await pendingApproval(first, sessionId)
    const request = { decision: 'allow', optionId: 'allow_once', requestId: 'decision-restart' }
    const decided = await phone.json<{ receipt: ApprovalReceipt }>(`approvals/${approval.id}`, { method: 'POST', body: request })
    await settled(first, sessionId)
    await first.close()

    const second = await testHost({ ...options, port: first.host.loopbackPort })
    const decide = vi.spyOn(second.host.bridge, 'decide')
    const retry = await again(second, phone, `approvals/${approval.id}`, request)
    expect(retry.status).toBe(200)
    expect(await body(retry)).toEqual({ accepted: true, receipt: { ...decided.receipt, replay: true } })
    const elsewhere = await again(second, other, `approvals/${approval.id}`, { decision: 'reject', requestId: 'decision-other' })
    expect(elsewhere.status).toBe(409)
    expect(await body(elsewhere)).toMatchObject({
      error: 'approval-settled',
      decidedBy: {
        kind: 'device',
        self: false,
        deviceName: '测试手机',
        decision: 'allow',
        optionKind: 'allow_once',
        at: decided.receipt.at,
      },
    })
    expect(decide).not.toHaveBeenCalled()
    expect((await auditRecords(second)).filter(record => record.action === 'approval.decided')).toHaveLength(1)
  })

  it('answers a cancel retried after a restart with its first receipt, and refuses its request ID for another run', async () => {
    const options = await restartable()
    const first = await testHost(options)
    const browser = await first.enroll({ scopes: [...ADMIN] })
    const { sessionId, runId } = await runningSession(browser, first)
    const request = { requestId: 'cancel-restart', runId }
    const stopped = await browser.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, { method: 'POST', body: request })
    expect(stopped).toEqual({
      accepted: true,
      receipt: { sessionId, requestId: 'cancel-restart', runId, outcome: 'stopped', status: 'cancelled', at: expect.any(String) },
    })
    await first.close()

    const second = await testHost({ ...options, port: first.host.loopbackPort })
    const cancel = vi.spyOn(second.host.bridge, 'cancel')
    const retry = await again(second, browser, `tasks/${sessionId}/cancel`, request)
    expect(retry.status).toBe(200)
    expect(await body(retry)).toEqual({ accepted: true, receipt: { ...stopped.receipt, replay: true } })
    const conflict = await again(second, browser, `tasks/${sessionId}/cancel`, { requestId: 'cancel-restart', runId: 'another-run' })
    expect(conflict.status).toBe(409)
    expect(await body(conflict)).toMatchObject({ error: 'request-conflict' })
    expect(cancel).not.toHaveBeenCalled()
    expect((await auditRecords(second)).filter(record => record.action === 'task.cancelled')).toEqual([
      expect.objectContaining({ detail: { sessionId, runId } }),
    ])
  })

  it('answers a cancel retried after a restart from its receipt even when the driver of the session is no longer mounted', async () => {
    const options = await restartable()
    const { plugin } = launchedHarness()
    const first = await testHost({ ...options, plugins: [plugin] })
    const desktop = await first.enroll({ listener: 'unix' })
    const browser = await first.enroll({ scopes: [...ADMIN] })
    const sessionId = await startTask(desktop, 'start', { harnessId: 'launched' })
    const request = { requestId: 'cancel-unmounted', runId: 'run-1' }
    const stopped = await browser.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, { method: 'POST', body: request })
    await first.close()

    const second = await testHost({ ...options, port: first.host.loopbackPort })
    await expect(second.host.bridge.harnessOf(sessionId)).rejects.toMatchObject({ status: 404 })
    const retry = await again(second, browser, `tasks/${sessionId}/cancel`, request)
    expect(retry.status).toBe(200)
    expect(await body(retry)).toEqual({ accepted: true, receipt: { ...stopped.receipt, replay: true } })
    // A request the Host has no receipt for still needs the session to route.
    const fresh = await again(second, browser, `tasks/${sessionId}/cancel`, { requestId: 'cancel-unmounted-2', runId: 'run-1' })
    expect(fresh.status).toBe(404)
  })

  it('answers two concurrent copies of one cancel with a single stop and one replayed receipt', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const { sessionId, runId } = await runningSession(browser, t)
    // The first copy is held in the driver until the second has found it in flight, then both settle.
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const original = t.host.bridge.cancel.bind(t.host.bridge)
    const cancel = vi.spyOn(t.host.bridge, 'cancel').mockImplementation(async (...args) => {
      await held
      return original(...args)
    })
    const lookups = vi.spyOn(t.host.bridge.receipts, 'cancel')
    const send = () =>
      browser.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: 'cancel-race', runId },
      })
    const firstCopy = send()
    await expect.poll(() => cancel.mock.calls.length).toBe(1)
    const looked = lookups.mock.calls.length
    const secondCopy = send()
    // One look before routing and one after; the second finds the first copy's flight and waits on it.
    await expect.poll(() => lookups.mock.calls.length).toBeGreaterThanOrEqual(looked + 2)
    release()
    const answers = await Promise.all([firstCopy, secondCopy])
    expect(answers[0].receipt).toMatchObject({ requestId: 'cancel-race', runId, outcome: 'stopped', status: 'cancelled' })
    expect(answers[0].receipt.replay).toBeUndefined()
    expect(answers[1].receipt).toEqual({ ...answers[0].receipt, replay: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect((await auditRecords(t)).filter(record => record.action === 'task.cancelled')).toHaveLength(1)
    cancel.mockRestore()

    // Two devices stopping the same run at once each get their own answer; the run stops once.
    const { sessionId: next, runId: nextRun } = await runningSession(browser, t)
    const other = await t.enroll({ name: 'Other browser' })
    const both = await Promise.all(
      [browser, other].map(device =>
        device.json<{ receipt: CancelReceipt }>(`tasks/${next}/cancel`, {
          method: 'POST',
          body: { requestId: randomUUID(), runId: nextRun },
        }),
      ),
    )
    expect(both.map(answer => answer.receipt.replay)).toEqual([undefined, undefined])
    expect(both.map(answer => answer.receipt.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('lets a copy that waited on a failed first copy run the cancel itself and keep its receipt', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const { sessionId, runId } = await runningSession(browser, t)
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const cancel = vi.spyOn(t.host.bridge, 'cancel').mockImplementationOnce(async () => {
      await held
      throw new AppError(503, 'storage-unavailable', '执行已停止，但取消状态未能持久化')
    })
    const lookups = vi.spyOn(t.host.bridge.receipts, 'cancel')
    const send = () => browser.request(`tasks/${sessionId}/cancel`, { method: 'POST', body: { requestId: 'cancel-failed', runId } })
    const firstCopy = send()
    await expect.poll(() => cancel.mock.calls.length).toBe(1)
    const looked = lookups.mock.calls.length
    const secondCopy = send()
    await expect.poll(() => lookups.mock.calls.length).toBeGreaterThanOrEqual(looked + 2)
    release()
    const failed = await firstCopy
    expect(failed.status).toBe(503)
    expect(await body(failed)).toMatchObject({ error: 'storage-unavailable' })
    const answer = await secondCopy
    expect(answer.status).toBe(200)
    const { receipt } = await body<{ receipt: CancelReceipt }>(answer)
    expect(receipt).toMatchObject({ requestId: 'cancel-failed', runId, outcome: 'stopped', status: 'cancelled' })
    expect(receipt.replay).toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(t.host.bridge.receipts.cancel(sessionId, browser.id, 'cancel-failed')).toMatchObject({ runId, outcome: 'stopped' })
  })

  it('answers a cancel for a run that already ended with how it ended, and never stops the run that began after it', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const sessionId = await startTask(browser, '你好')
    await settled(t, sessionId)
    const firstRun = (await t.host.bridge.summary(sessionId)).runId!
    const cancel = vi.spyOn(t.host.bridge, 'cancel')
    const late = await browser.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: 'cancel-late', runId: firstRun },
    })
    expect(late.receipt).toEqual({
      sessionId,
      requestId: 'cancel-late',
      runId: firstRun,
      outcome: 'ended',
      status: 'idle',
      at: expect.any(String),
    })

    await browser.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '运行 30 秒长任务', requestId: randomUUID() } })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, { timeout: 10_000 }).toBe('running')
    const secondRun = (await t.host.bridge.summary(sessionId)).runId!
    expect(secondRun).not.toBe(firstRun)
    const stale = await browser.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: 'cancel-stale', runId: firstRun },
    })
    expect(stale.receipt).toEqual({ sessionId, requestId: 'cancel-stale', runId: firstRun, outcome: 'ended', at: expect.any(String) })
    expect((await t.host.bridge.summary(sessionId)).status).toBe('running')
    expect(cancel).not.toHaveBeenCalled()
    expect((await auditRecords(t)).some(record => record.action === 'task.cancelled')).toBe(false)

    const now = await browser.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: 'cancel-now', runId: secondRun },
    })
    expect(now.receipt).toMatchObject({ runId: secondRun, outcome: 'stopped', status: 'cancelled' })
    expect(cancel).toHaveBeenCalledWith(sessionId, { runId: secondRun })
    // A page loaded before cancels named their run still stops whatever runs, and is told when nothing did.
    expect(await browser.json(`tasks/${sessionId}/cancel`, { method: 'POST' })).toEqual({
      accepted: true,
      receipt: { sessionId, outcome: 'ended', status: 'cancelled', at: expect.any(String) },
    })
    expect(await body(await browser.request(`tasks/${sessionId}/cancel`, { method: 'POST', body: { runId: 'bad run' } }))).toMatchObject({
      error: 'invalid-input',
    })
  })

  it('still stops a run when its driver cannot list the session, leaving the run check to the driver', async () => {
    const { plugin } = launchedHarness()
    const t = await testHost({ plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const sessionId = await startTask(desktop, 'start', { harnessId: 'launched' })
    const cancel = vi.spyOn(t.host.bridge, 'cancel')
    const answer = await desktop.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: 'cancel-unlisted', runId: 'run-1' },
    })
    expect(answer.receipt).toEqual({ sessionId, requestId: 'cancel-unlisted', runId: 'run-1', outcome: 'stopped', at: expect.any(String) })
    expect(cancel).toHaveBeenCalledExactlyOnceWith(sessionId, { runId: 'run-1' })
    expect((await auditRecords(t)).filter(record => record.action === 'task.cancelled')).toHaveLength(1)
  })
})

describe('traffic counters', () => {
  it('counts the bytes sent per session and per stream, as numbers only, for admin devices and the command line', async () => {
    const t = await testHost()
    const admin = await t.enroll({ name: '管理设备', scopes: [...ADMIN] })
    const viewer = await t.enroll({ scopes: ['view'] })
    const prompt = '你好，请记住这句话'
    const sessionId = await startTask(admin, prompt)
    await settled(t, sessionId)
    await openStream(admin, `events?sessionId=${encodeURIComponent(sessionId)}`)
    await admin.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title: '秘密标题' } })
    await admin.json('snapshot')
    await admin.json(`tasks/${sessionId}`)
    await expect
      .poll(
        async () => (await admin.json<TrafficSummary>('traffic')).sessions.find(session => session.sessionId === sessionId)?.frames ?? 0,
      )
      .toBeGreaterThan(0)
    const summary = await admin.json<TrafficSummary>('traffic')
    expect(summary.sessions.find(session => session.sessionId === sessionId)).toMatchObject({ details: 1, detailBytes: expect.any(Number) })
    expect(summary.kinds['task-state'].count).toBeGreaterThan(0)
    expect(summary.kinds.refresh.count).toBeGreaterThan(0)
    expect(summary.kinds.snapshot.count).toBeGreaterThan(0)
    expect(summary.kinds.detail).toMatchObject({ count: 1 })
    expect(summary.connections).toEqual([
      expect.objectContaining({ listener: 'loopback-tcp', frames: expect.any(Number), bytes: expect.any(Number), heartbeats: 0 }),
    ])
    expect(summary.connections[0]?.closedAt).toBeUndefined()
    const text = JSON.stringify(summary)
    for (const secret of [prompt, '秘密标题', '管理设备', admin.id, viewer.id, t.host.hostId]) expect(text).not.toContain(secret)

    expect(await body(await viewer.request('traffic'))).toMatchObject({ error: 'scope-required', required: 'admin' })
    const anonymous = await t.raw('unix', 'api/traffic')
    expect(anonymous.status).toBe(200)
    expect(await body<TrafficSummary>(anonymous)).toMatchObject({ buckets: summary.buckets })
    expect((await t.raw('loopback-tcp', 'api/traffic')).status).toBe(401)
  })
})

describe('full-access (L3) sessions', () => {
  async function acpHost() {
    const t = await testHost({ agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }) })
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const definition = {
      id: 'fake',
      name: 'Fake agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_STATE: join(t.root, 'acp-state.json'), FAKE_ACP_MODES: 'read-only,auto', FAKE_ACP_CONFIG: 'options' },
    }
    // A new Harness is a new program: only this Mac's desktop app saves it, with a local confirmation.
    expect(await body(await browser.request('agents', { method: 'POST', body: definition }))).toMatchObject({ error: 'local-only' })
    const created = await desktop.confirmed('agents', { method: 'POST', body: definition })
    expect(created.status).toBe(201)
    expect(t.presence.requests.at(-1)?.preview).toMatchObject({
      action: 'harness.command.apply',
      subject: { form: 'harness.command.apply' },
    })
    expect((await auditRecords(t)).find(record => record.action === 'agent.defined')).toMatchObject({ stepup: 'lpc-local' })
    const enrolled = t.presence.requests.length
    return { t, desktop, browser, enrolled }
  }

  it('lists what the last session offered before the next starts, and starts on what a device chose from it', async () => {
    const { t, browser, enrolled } = await acpHost()
    const harness = async () => (await browser.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'fake')!
    expect((await harness()).catalogue).toBeUndefined()
    await settled(t, await startTask(browser, 'hello', { harnessId: 'fake' }))
    const catalogue = (await harness()).catalogue!
    expect(catalogue.options.find(option => option.category === 'model')?.options.map(item => item.value)).toEqual(['small', 'large'])
    expect(catalogue.perModel.map(entry => entry.model)).toEqual(['small'])

    const config = [
      { configId: 'model', value: 'large' },
      { configId: 'mode', value: 'auto' },
    ]
    const sessionId = await startTask(browser, 'again', { harnessId: 'fake', config })
    await settled(t, sessionId)
    const detail = await browser.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.config?.find(option => option.id === 'model')?.currentValue).toBe('large')
    expect(detail.config?.find(option => option.id === 'mode')?.currentValue).toBe('auto')
    // A wider mode chosen before the start asks nothing either, and what was chosen is on record with the start.
    expect(t.presence.requests).toHaveLength(enrolled)
    const records = (await auditRecords(t)).filter(
      record => record.detail.sessionId === sessionId || record.action === 'task.l3.start-requested',
    )
    const configHash = sha256Hex(canonicalJson(config))
    expect(records.find(record => record.action === 'task.l3.started')).toMatchObject({ detail: { configHash } })
    expect(records.findLast(record => record.action === 'task.l3.start-requested')).toMatchObject({ detail: { configHash } })

    // The built-in Harness takes a model service instead, so a choice for it is refused rather than dropped.
    expect(
      await body(
        await browser.request('tasks', {
          method: 'POST',
          body: { prompt: 'x', requestId: randomUUID(), harnessId: 'standard', config: [{ configId: 'model', value: 'large' }] },
        }),
      ),
    ).toMatchObject({ error: 'config-unsupported' })
  })

  it('records each call run unasked while the model decides, by hash and enum, with no prompt to enter that mode', async () => {
    const t = await testHost({ agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }) })
    const desktop = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ scopes: [...ADMIN] })
    const definition = {
      id: 'qwen',
      name: 'Qwen',
      presetId: 'qwen',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: {
        FAKE_ACP_STATE: join(t.root, 'acp-state.json'),
        FAKE_ACP_MODES: 'plan,default,auto-edit,auto,yolo',
        FAKE_ACP_INITIAL_MODE: 'default',
        FAKE_ACP_CONFIG: 'options',
      },
    }
    expect((await desktop.confirmed('agents', { method: 'POST', body: definition })).status).toBe(201)
    const enrolled = t.presence.requests.length
    const sessionId = await startTask(phone, 'hello', { harnessId: 'qwen' })
    await settled(t, sessionId)
    expect(
      await body(await phone.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value: 'auto' } })),
    ).toEqual({
      accepted: true,
    })
    await phone.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'review', requestId: randomUUID() } })
    await vi.waitFor(
      async () => {
        expect((await auditRecords(t)).filter(record => record.action === 'task.tool.judged')).toHaveLength(3)
      },
      { timeout: 8_000, interval: 20 },
    )
    const judged = (await auditRecords(t)).filter(record => record.action === 'task.tool.judged')
    expect(judged.map(record => [record.actor, record.target, record.detail])).toEqual(
      ['think', 'think', 'execute'].map(kind => [
        { listener: 'host' },
        sessionId,
        { sessionId, callHash: expect.any(String), modeHash: sha256Hex('auto'), kind, outcome: 'ran-unasked', source: 'no-ask-seen' },
      ]),
    )
    expect(t.presence.requests).toHaveLength(enrolled)
    const detail = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.filter(message => message.tool?.judged?.outcome === 'unasked')).toHaveLength(3)
  })

  it('widens a mode from any device that may run it, with no prompt, on record', async () => {
    const { t, browser, enrolled } = await acpHost()
    const sessionId = await startTask(browser, 'hello', { harnessId: 'fake' })
    await settled(t, sessionId)
    expect(
      await body(await browser.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value: 'auto' } })),
    ).toEqual({
      accepted: true,
    })
    expect(t.presence.requests).toHaveLength(enrolled)
    expect((await auditRecords(t)).find(record => record.action === 'task.mode.widened')).toMatchObject({
      stepup: 'none',
      actor: { deviceId: browser.id },
      detail: { sessionId },
    })
    const viewer = await t.enroll({ scopes: ['view'] })
    expect(
      await body(await viewer.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value: 'read-only' } })),
    ).toMatchObject({
      error: 'scope-required',
      required: 'run',
    })
  })

  it('lets any device stop one subagent alone, on record, and never confirms anything while a subagent waits', async () => {
    const { t, desktop, browser } = await acpHost()
    // This Host looks up no command by name, so no agent installed on this computer can be found or started.
    const { presets } = await desktop.json<{ presets: Array<{ detected?: { found: boolean } }> }>('agents')
    expect(presets.every(preset => preset.detected?.found === false)).toBe(true)
    const blockedWhile = async (sessionId: string) => {
      const blocked = await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11434'] } } })
      expect(blocked.status).toBe(409)
      expect(await body(blocked)).toMatchObject({ error: 'presence-blocked', blockingTasks: [{ id: sessionId }] })
    }
    // Enrolled first: a new device is a local confirmation too.
    const viewer = await t.enroll({ scopes: ['view'] })
    const sessionId = await startTask(browser, 'delegate stop', { harnessId: 'fake' })
    const approval = await pendingApproval(t, sessionId)
    expect(approval).toMatchObject({ subagent: 'Test runner', advisory: true })
    // A subagent asking is the session's agent asking: every local confirmation waits until it is answered.
    const confirmations = t.presence.requests.length
    await blockedWhile(sessionId)

    const row = (await viewer.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(message => message.subagent)!
    expect(row.subagent).toMatchObject({ status: 'waiting', stoppable: true })
    const stop = (subagentId: string) => viewer.request(`tasks/${sessionId}/stop-subagent`, { method: 'POST', body: { subagentId } })
    expect((await stop('not an id')).status).toBe(400)
    expect(await body(await stop(row.id))).toEqual({ accepted: true })
    expect((await auditRecords(t)).filter(record => record.action === 'task.subagent.stopped')).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ deviceId: viewer.id }), detail: { sessionId, subagentId: row.id } }),
    ])
    await settled(t, sessionId)
    const after = await viewer.json<TaskDetail>(`tasks/${sessionId}`)
    expect(after.messages.find(message => message.id === row.id)?.subagent).toMatchObject({ status: 'cancelled' })
    expect(after.summary.runOutcome).toBe('completed')
    expect(await body(await stop(row.id))).toMatchObject({ error: 'subagent-not-stoppable' })
    // The refused stop's record is marked failed.
    const refusedStop = (await auditRecords(t)).findLast(record => record.action === 'task.subagent.stopped')!
    await expect
      .poll(async () =>
        (await auditRecords(t)).some(record => record.action === 'action.failed' && record.detail.refSeq === refusedStop.seq),
      )
      .toBe(true)

    // A stop narrows, so it is still sent when its record cannot be written, and the answer says so.
    const audit = t.host.security.audit
    const append = audit.append.bind(audit)
    const failing = vi
      .spyOn(audit, 'append')
      .mockImplementation(event =>
        event.action === 'task.subagent.stopped'
          ? Promise.reject(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行'))
          : append(event),
      )
    const unrecordedId = await startTask(browser, 'delegate stop', { harnessId: 'fake' })
    await pendingApproval(t, unrecordedId)
    const unrecordedRow = (await viewer.json<TaskDetail>(`tasks/${unrecordedId}`)).messages.find(message => message.subagent)!
    const unrecorded = await viewer.request(`tasks/${unrecordedId}/stop-subagent`, {
      method: 'POST',
      body: { subagentId: unrecordedRow.id },
    })
    expect(unrecorded.headers.get('x-latch-audit')).toBe('failed')
    expect(await body(unrecorded)).toEqual({ accepted: true })
    await settled(t, unrecordedId)
    expect(
      (await viewer.json<TaskDetail>(`tasks/${unrecordedId}`)).messages.find(message => message.id === unrecordedRow.id)?.subagent,
    ).toMatchObject({ status: 'cancelled' })
    failing.mockRestore()

    // The same holds for a subagent that asks after its turn ended.
    const late = await startTask(browser, 'delegate late', { harnessId: 'fake' })
    expect(await pendingApproval(t, late)).toMatchObject({ subagent: 'Test runner' })
    await expect.poll(async () => (await t.host.bridge.detail(late)).summary.runOutcome, { timeout: 10_000 }).toBe('completed')
    await blockedWhile(late)
    expect(t.presence.requests).toHaveLength(confirmations)
  })

  it('starts and continues a Harness session the same from a browser as from the desktop, every start on record', async () => {
    const { t, desktop, browser, enrolled } = await acpHost()
    const prompt = 'permission'
    const sessionId = await startTask(browser, prompt, { harnessId: 'fake' })
    expect(t.presence.requests).toHaveLength(enrolled)
    const records = await auditRecords(t)
    const started = records.find(record => record.action === 'task.l3.started')
    expect(started).toMatchObject({
      stepup: 'none',
      actor: { deviceId: browser.id, listener: 'loopback-tcp' },
      detail: { sessionId, harnessId: 'fake', promptHash: sha256Hex(prompt) },
    })
    expect(records.find(record => record.action === 'task.l3.start-requested')).toMatchObject({ detail: { promptHash: sha256Hex(prompt) } })

    const approval = await pendingApproval(t, sessionId)
    const snapshot = await browser.json<AppSnapshot>('snapshot')
    expect(snapshot.approvals.find(item => item.id === approval.id)).toMatchObject({ advisory: true, risk: 'R2' })
    expect(snapshot.tasks.find(task => task.id === sessionId)).toMatchObject({ level: 'L3', firstStart: true })
    expect((await browser.json<TaskDetail>(`tasks/${sessionId}`)).permission).toMatchObject({ level: 'L3', enforcer: 'NONE' })
    // While the unsandboxed turn waits, what would outlive it is refused, naming the session to the desktop; an
    // anonymous enrollment learns nothing about it. Another agent session still starts.
    const blocked = await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11434'] } } })
    expect(blocked.status).toBe(409)
    expect(await body(blocked)).toEqual({
      error: 'presence-blocked',
      message: '有完全访问会话正在运行或等你处理。为防止 Agent 冒用你的确认，这项确认要等它结束。',
      action: 'policy.change',
      blockingTasks: [{ id: sessionId, title: expect.any(String), harnessId: 'fake' }],
    })
    const { testDeviceKey } = await import('@latch/testkit')
    const enrolling = await t.raw('unix', 'api/enrollments', { method: 'POST', body: { publicKey: testDeviceKey().spki, name: '新设备' } })
    expect(enrolling.status).toBe(409)
    const refusal = await body<Record<string, unknown>>(enrolling)
    expect(refusal).toMatchObject({ error: 'presence-blocked', action: 'device.enroll' })
    expect(refusal).not.toHaveProperty('blockingTasks')
    const second = await startTask(browser, 'hang', { harnessId: 'fake' })
    expect(await browser.json(`tasks/${second}/cancel`, { method: 'POST', body: {} })).toMatchObject({
      accepted: true,
      receipt: { sessionId: second, outcome: 'stopped', status: 'cancelled' },
    })
    await expect.poll(async () => (await t.host.bridge.detail(second)).summary.status, { timeout: 10_000 }).toBe('cancelled')
    expect((await browser.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow' } })).status).toBe(200)
    await expect.poll(async () => (await t.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
    // A later start of the same launch says nothing again.
    const third = await startTask(browser, 'second', { harnessId: 'fake' })
    await settled(t, third)
    expect((await browser.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === third)!.firstStart).toBeUndefined()

    expect(
      (await browser.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo hi', requestId: randomUUID() } })).status,
    ).toBe(200)
    await settled(t, sessionId)
    expect((await browser.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value: 'auto' } })).status).toBe(
      200,
    )
    expect((await browser.request(`tasks/${sessionId}`, { method: 'PATCH', body: { title: 'renamed' } })).status).toBe(200)
    await settled(t, sessionId)
    expect(t.presence.requests).toHaveLength(enrolled)
    expect((await browser.request(`tasks/${sessionId}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('records the intent to start a full-access session before the driver can spawn anything', async () => {
    const { plugin, createTask } = launchedHarness()
    const t = await testHost({ plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const audit = t.host.security.audit
    const append = audit.append.bind(audit)
    const failing = new Set<string>(['task.l3.start-requested'])
    vi.spyOn(audit, 'append').mockImplementation(event =>
      failing.has(event.action) ? Promise.reject(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行')) : append(event),
    )
    const start = () =>
      desktop.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'start', requestId: randomUUID(), mode: 'agent', harnessId: 'launched' },
      })
    const refused = await start()
    expect(refused.status).toBe(503)
    expect(await body(refused)).toMatchObject({ error: 'audit-unavailable' })
    expect(createTask).not.toHaveBeenCalled()

    // A driver that refuses the start leaves its intent marked failed.
    failing.clear()
    createTask.mockRejectedValueOnce(new AppError(409, 'agent-definition-changed', 'Agent 定义已变化'))
    expect((await start()).status).toBe(409)
    const intent = (await auditRecords(t)).findLast(record => record.action === 'task.l3.start-requested')!
    await expect
      .poll(async () => (await auditRecords(t)).some(record => record.action === 'action.failed' && record.detail.refSeq === intent.seq))
      .toBe(true)

    // When only the record naming the session fails, the session its intent covers keeps going and the answer says so.
    failing.add('task.l3.started')
    const unrecorded = await start()
    expect(unrecorded.status).toBe(201)
    expect(unrecorded.headers.get('x-latch-audit')).toBe('failed')
    expect(createTask).toHaveBeenCalledTimes(2)

    failing.clear()
    const { sessionId } = await body<{ sessionId: string }>(await start())
    const records = await auditRecords(t)
    const started = records.find(record => record.action === 'task.l3.started')!
    expect(started).toMatchObject({ stepup: 'none', detail: { sessionId, harnessId: 'launched', launchHash: 'a'.repeat(64) } })
    expect(records.filter(record => record.action === 'task.l3.start-requested').map(record => record.seq < started.seq)).toEqual([
      true,
      true,
      true,
    ])
  })

  it("passes a driver's refusal over a changed definition or project configuration through starts, input and option changes unchanged", async () => {
    const { plugin, createTask, prompt, setConfig } = launchedHarness()
    const t = await testHost({ plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const sessionId = await startTask(desktop, 'start', { harnessId: 'launched' })
    for (const [code, message] of [
      ['agent-definition-changed', 'Agent 定义已变化'],
      ['project-config-changed', '项目配置已变化'],
    ] as const) {
      const refuse = () => Promise.reject(new AppError(409, code, message))
      createTask.mockImplementationOnce(refuse)
      prompt.mockImplementationOnce(refuse)
      setConfig.mockImplementationOnce(refuse)
      const answers = [
        await desktop.confirmed('tasks', {
          method: 'POST',
          body: { prompt: 'start', requestId: randomUUID(), mode: 'agent', harnessId: 'launched' },
        }),
        await desktop.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } }),
        await desktop.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value: 'auto' } }),
      ]
      for (const answer of answers) {
        expect(answer.status).toBe(409)
        expect(await body(answer)).toEqual({ error: code, message })
      }
    }
    expect([createTask, prompt, setConfig].map(mock => mock.mock.calls.length)).toEqual([3, 2, 2])
  })

  it('passes an agent the other folders and audits how many, and starts nothing past its limit', async () => {
    const t = await testHost({ agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }) })
    const desktop = await t.enroll({ listener: 'unix' })
    const agentLog = join(t.root, 'agent.log')
    const define = async (id: string, presetId: string, env: Record<string, string>) => {
      const variables = { FAKE_ACP_STATE: join(t.root, `${id}-state.json`), FAKE_ACP_LOG: agentLog, ...env }
      const created = await desktop.confirmed('agents', {
        method: 'POST',
        body: { id, name: id, presetId, command: process.execPath, args: [FAKE_ACP_AGENT], env: variables },
      })
      expect(created.status).toBe(201)
    }
    await define('codex-fake', 'codex', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'read-only,workspace-write',
      FAKE_ACP_INITIAL_MODE: 'read-only',
      FAKE_ACP_CAPS: 'dirs',
    })
    await define('qwen-fake', 'qwen', {
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'plan,default,auto-edit,auto,yolo',
      FAKE_ACP_INITIAL_MODE: 'default',
    })
    await define('dsh-fake', 'dsh', { FAKE_ACP_PROCESS_MODE: '1' })
    const { harnesses } = (await desktop.json<AppSnapshot>('snapshot')).catalog!
    expect(
      Object.fromEntries(['codex-fake', 'qwen-fake', 'dsh-fake'].map(id => [id, harnesses.find(item => item.id === id)?.projectFolders])),
    ).toEqual({
      'codex-fake': { access: 'all' },
      'qwen-fake': { access: 'all', max: 5 },
      'dsh-fake': { access: 'primary' },
    })

    const paths = await Promise.all(['api', 'web'].map(async name => realpath(await temporaryDirectory(`latch-${name}-`))))
    const { workspace } = await addProject(desktop, paths, 'proj')
    const sessionId = await startTask(desktop, 'echo hi', { harnessId: 'codex-fake', workspaceId: workspace.id })
    await settled(t, sessionId)
    const records = await auditRecords(t)
    expect(records.find(record => record.action === 'task.l3.start-requested')!.detail).toMatchObject({ folderCount: 2 })
    expect(records.find(record => record.action === 'task.l3.started')!.detail).toMatchObject({ sessionId, folderCount: 2 })
    expect((await t.host.bridge.detail(sessionId)).summary).toMatchObject({
      workspaceId: workspace.id,
      folders: workspace.folders!.map(({ id, path }) => ({ id, path })),
      folderAccess: 'all',
    })
    const log = (await readFile(agentLog, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; method?: string; params?: Record<string, unknown> })
    expect(log.find(entry => entry.event === 'recv' && entry.method === 'session/new')!.params).toMatchObject({
      cwd: paths[0],
      additionalDirectories: [paths[1]],
    })

    // A harness that keeps to the primary folder starts there with nothing else.
    const primaryOnly = await startTask(desktop, 'echo dsh', { harnessId: 'dsh-fake', workspaceId: workspace.id })
    await settled(t, primaryOnly)
    expect((await t.host.bridge.detail(primaryOnly)).summary).toMatchObject({ cwd: paths[0], workspaceId: workspace.id })
    expect((await t.host.bridge.detail(primaryOnly)).summary.folders).toBeUndefined()
    expect((await auditRecords(t)).findLast(record => record.action === 'task.l3.started')!.detail.folderCount).toBeUndefined()

    // Beyond what the harness takes nothing is started.
    const many = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(async name => realpath(await temporaryDirectory(`latch-${name}-`))))
    const big = (await addProject(desktop, many, 'big')).workspace
    const refused = await desktop.request('tasks', {
      method: 'POST',
      body: { prompt: 'echo', requestId: randomUUID(), mode: 'agent', harnessId: 'qwen-fake', workspaceId: big.id },
    })
    expect(refused.status).toBe(409)
    expect(await body(refused)).toMatchObject({ error: 'harness-folder-limit' })
  })

  it('confirms the program of a definition on this Mac and nothing else about it, on record, values never returned', async () => {
    const { t, desktop, browser, enrolled } = await acpHost()
    const settings = async () => (await desktop.json<{ agents: AgentSettings[] }>('agents')).agents.find(agent => agent.id === 'fake')!
    expect(await settings()).toMatchObject({ started: false })
    expect((await auditRecords(t)).find(record => record.action === 'agent.defined')).toMatchObject({
      stepup: 'lpc-local',
      actor: { deviceId: desktop.id, listener: 'unix' },
      detail: { agentId: 'fake', created: true },
    })
    const sessionId = await startTask(desktop, 'echo one', { harnessId: 'fake' })
    await settled(t, sessionId)
    expect(await settings()).toMatchObject({ started: true })
    // A name changes nothing that runs: any admin device, no confirmation.
    const renamed = await browser.json<{ agent: AgentSettings }>('agents/fake', { method: 'PUT', body: { name: 'Renamed' } })
    expect(renamed.agent).toMatchObject({ started: true, name: 'Renamed', verified: false })
    expect(t.presence.requests).toHaveLength(enrolled)
    // Arguments and variables do: refused off this Mac, and on it without the confirmation nothing changes.
    expect(await body(await browser.request('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--x'] } }))).toMatchObject({
      error: 'local-only',
    })
    expect(await body(await browser.request('agents/fake', { method: 'PUT', body: { env: { FAKE_ACP_VERSION: '9.9.9' } } }))).toMatchObject(
      {
        error: 'local-only',
      },
    )
    const unconfirmed = await desktop.request('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--x'] } })
    expect(unconfirmed.status).toBe(403)
    expect(await body(unconfirmed)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    expect((await settings()).args).toEqual([FAKE_ACP_AGENT])
    // A new definition counts as not started again, and its variables' values do not come back.
    const changed = await desktop.confirmedJson<{ agent: AgentSettings }>('agents/fake', {
      method: 'PUT',
      body: { env: { FAKE_ACP_VERSION: '9.9.9' } },
    })
    expect(changed.agent).toMatchObject({ started: false })
    expect(JSON.stringify(changed)).not.toContain('9.9.9')
    expect(JSON.stringify(t.presence.requests.at(-1))).not.toContain('9.9.9')
    expect(await body(await desktop.confirmed('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--x'] } }))).toMatchObject({
      agent: { started: false },
    })
    const confirmed = t.presence.requests.length
    // Taking a variable away changes what runs too (a `CODEX_PATH`, a `DISABLE_*` flag): asked as well.
    const removing = await desktop.request('agents/fake', { method: 'PUT', body: { env: { FAKE_ACP_VERSION: null } } })
    expect(await body(removing)).toMatchObject({ error: 'stepup-required' })
    await desktop.confirmedJson('agents/fake', { method: 'PUT', body: { env: { FAKE_ACP_VERSION: null } } })
    expect(t.presence.requests).toHaveLength(confirmed + 2)
    // The name is bound to the confirmation, with the path the command resolved to.
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: 'Harness', value: 'Renamed（fake）' })
    const defined = (await auditRecords(t)).filter(record => record.action === 'agent.defined')
    expect(defined.map(record => [record.detail.created, record.stepup])).toEqual([
      [true, 'lpc-local'],
      [false, 'lpc-local'],
      [false, 'lpc-local'],
      [false, 'lpc-local'],
    ])
    // Every write of the record is on record as a settings change.
    expect((await auditRecords(t)).filter(record => record.action === 'settings.changed').length).toBeGreaterThanOrEqual(4)
    expect(
      await body(
        await desktop.confirmed('agents', {
          method: 'POST',
          body: { name: 'Bad', command: process.execPath, env: { NODE_OPTIONS: '--inspect' } },
        }),
      ),
    ).toMatchObject({ error: 'agent-env-reserved' })
    const viewer = await t.enroll({ scopes: ['view', 'run'] })
    expect(await body(await viewer.request('agents/fake', { method: 'PUT', body: { args: [] } }))).toMatchObject({
      error: 'scope-required',
      required: 'admin',
    })
    expect((await browser.request('plugins/agent-fake', { method: 'POST', body: { enabled: false } })).status).toBe(200)
    expect((await browser.request('agents/fake', { method: 'DELETE' })).status).toBe(200)
    expect((await auditRecords(t)).some(record => record.action === 'agent.deleted')).toBe(true)
  })

  it('starts a confirmed Harness only while its command resolves to the program confirmed', async () => {
    const first = await mkdtemp(join(tmpdir(), 'latch-bin-a-'))
    const second = await mkdtemp(join(tmpdir(), 'latch-bin-b-'))
    for (const bin of [first, second]) {
      await writeFile(join(bin, 'fakeacp'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`)
      await chmod(join(bin, 'fakeacp'), 0o755)
    }
    const t = await testHost({
      agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
      commandDirectories: () => [first, second],
    })
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'moving', name: 'Moving', command: 'fakeacp', args: [], env: { FAKE_ACP_STATE: join(t.root, 'state.json') } },
    })
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '命令', value: join(first, 'fakeacp') })
    // The program confirmed goes away, and the same name now finds another: nothing starts until this Mac confirms it.
    await rm(join(first, 'fakeacp'))
    forgetCommandLookups()
    const refused = await desktop.request('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'moving' } })
    expect(refused.status).toBe(409)
    const again = await desktop.request('agents/moving', { method: 'PUT', body: { command: 'fakeacp' } })
    expect(await body(again)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    await desktop.confirmedJson('agents/moving', { method: 'PUT', body: { command: 'fakeacp' } })
    expect(t.presence.requests.at(-1)?.preview.lines).toContainEqual({ label: '命令', value: join(second, 'fakeacp') })
    const sessionId = await startTask(desktop, 'echo hi', { harnessId: 'moving' })
    await settled(t, sessionId)
  })

  it('confirms a definition from before confirmations at its first start on this Mac, refuses it elsewhere until then, and reads no unconfirmed version', async () => {
    const root = await temporaryDirectory('latch-legacy-')
    const bin = join(root, 'bin')
    await mkdir(bin)
    const marker = join(root, 'versions.txt')
    // A preset with a version rule: reading its version runs it.
    await writeFile(
      join(bin, 'dsh'),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo ran >> '${marker}'; echo 0.2.2-rc.1; exit 0; fi\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
    )
    await chmod(join(bin, 'dsh'), 0o755)
    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'workspace')
    const at = (name: string) => join(bin, name)
    const options = { dataDir, workspaceRoot, commandDirectories: () => [bin], loginPrograms: at }
    const first = await startTestHost(options)
    const owner = await first.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: {
        id: 'dsh',
        name: 'DeepSeek Harness',
        presetId: 'dsh',
        command: 'dsh',
        args: ['--profile', 'acp'],
        env: { FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_PROCESS_MODE: '1' },
      },
    })
    await first.close()
    // As saved before this Host bound definitions to the program confirmed.
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8'))
    for (const agent of settings.agents) delete agent.confirmedCommand
    await writeFile(file, JSON.stringify(settings))
    await rm(marker, { force: true })
    const t = await testHost(options)
    const desktop = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ scopes: [...ADMIN] })
    await desktop.json('agents')
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    // Elsewhere: refused with the reason. On this Mac: one confirmation, bound to the program it names, then it runs.
    const remote = await phone.request('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'dsh' } })
    expect(await body(remote)).toMatchObject({ error: 'harness-unconfirmed' })
    const local = await desktop.request('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'dsh' } })
    expect(await body(local)).toMatchObject({ error: 'stepup-required', confirmation: { action: 'harness.command.apply' } })
    const requestId = randomUUID()
    const started = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'echo hi', requestId, harnessId: 'dsh' },
    })
    await settled(t, started.sessionId)
    expect(JSON.parse(await readFile(file, 'utf8')).agents[0].confirmedCommand).toBe(join(bin, 'dsh'))
    expect((await auditRecords(t)).filter(record => record.action === 'agent.defined').at(-1)).toMatchObject({ stepup: 'lpc-local' })
    // Confirmed and bound: now its version may be read.
    await desktop.json('agents')
    expect(await readFile(marker, 'utf8')).toContain('ran')
    expect(
      await body(await phone.request('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'dsh' } })),
    ).toMatchObject({
      sessionId: expect.any(String),
    })
  })

  it('refuses a Harness command change while a full-access session waits, and goes through once it ends', async () => {
    const { t, desktop } = await acpHost()
    const sessionId = await startTask(desktop, 'delegate stop', { harnessId: 'fake' })
    await pendingApproval(t, sessionId)
    expect(await body(await desktop.request('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--y'] } }))).toMatchObject({
      error: 'presence-blocked',
      blockingTasks: [{ id: sessionId }],
    })
    await desktop.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} })
    await expect
      .poll(async () => (await t.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 })
      .not.toMatch(/running|waiting/u)
    expect((await desktop.confirmed('agents/fake', { method: 'PUT', body: { args: [FAKE_ACP_AGENT, '--y'] } })).status).toBe(200)
  })
})

describe('providers', () => {
  it('binds an existing service key entry to the reviewed target across an administrator move', async () => {
    const first = await localModel()
    const second = await localModel()
    const t = await testHost({ demo: false, egressAllow: [first.allow, second.allow] })
    const desktop = await t.enroll({ listener: 'unix' })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const kind = 'openai-compatible'
    const { provider } = await desktop.json<{ provider: ProviderSettings }>('providers', {
      body: { name: 'Fixture service', kind, baseURL: first.baseURL, defaultModel: 'alpha' },
    })
    const path = `providers/${provider.id}`
    const expectedTarget = { kind, baseURL: provider.baseURL }
    await admin.json(path, { method: 'PUT', body: { expectedTarget, baseURL: second.baseURL } })
    const opaqueValue = randomUUID()
    const checks = [
      [{ apiKey: opaqueValue }, 'provider-target-required'],
      [{ apiKey: opaqueValue, expectedTarget }, 'provider-target-changed'],
      [{ apiKey: opaqueValue, expectedTarget: { kind: 'anthropic', baseURL: second.baseURL } }, 'provider-target-changed'],
    ] as const
    const firstAudit = (await auditRecords(t)).filter(item => item.action === 'provider.secret.set').length
    for (const [input, error] of checks) {
      const refused = await desktop.request(path, { method: 'PUT', body: input })
      expect.soft(refused.status).toBe(409)
      expect.soft(await body(refused)).toMatchObject({ error })
    }
    await desktop.json(`${path}/models`, { method: 'POST' })
    expect.soft(second.listings.some(({ authorization }) => authorization === `Bearer ${opaqueValue}`)).toBe(false)
    expect.soft(first.listings.length).toBe(0)
    expect.soft((await auditRecords(t)).filter(item => item.action === 'provider.secret.set').length).toBe(firstAudit)

    const { providers } = await desktop.json<{ providers: ProviderSettings[] }>('providers')
    const live = providers.find(item => item.id === provider.id)!
    expect(live.baseURL).toBe(second.baseURL)
    const current = { kind: live.kind, baseURL: `${live.baseURL}/` }
    const saved = await desktop.request(path, { method: 'PUT', body: { apiKey: opaqueValue, expectedTarget: current } })
    expect(saved.status).toBe(200)
    await desktop.json(`${path}/models`, { method: 'POST' })
    expect(second.listings.at(-1)?.authorization === `Bearer ${opaqueValue}`).toBe(true)
  })

  it('rechecks a service target inside the write lock after destination planning has waited', async () => {
    const first = await localModel()
    const second = await localModel()
    const source = new URL(first.baseURL)
    source.hostname = 'fixture-provider.test'
    let release!: () => void
    const pending = new Promise<void>(done => {
      release = done
    })
    let inspecting = false
    const t = await testHost({
      demo: false,
      egressAllow: [source.host, second.allow],
      egressLookup(host, _options, done) {
        if (host !== source.hostname) return done(new Error('Unexpected fixture hostname'), [])
        inspecting = true
        void pending.then(() => done(null, [{ address: '127.0.0.1', family: 4 }]))
      },
    })
    const desktop = await t.enroll({ listener: 'unix' })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const kind = 'openai-compatible'
    const { provider } = await desktop.json<{ provider: ProviderSettings }>('providers', {
      body: { name: 'Awaited fixture service', kind, baseURL: source.href, defaultModel: 'alpha' },
    })
    const path = `providers/${provider.id}`
    const expectedTarget = { kind, baseURL: provider.baseURL }
    const writing = desktop.request(path, {
      method: 'PUT',
      body: { apiKey: randomUUID(), confirmOrigin: true, expectedTarget },
    })
    try {
      await vi.waitFor(() => expect(inspecting).toBe(true))
      await admin.json(path, { method: 'PUT', body: { baseURL: second.baseURL, expectedTarget } })
    } finally {
      release()
    }
    const refused = await writing
    expect(refused.status).toBe(409)
    expect(await body(refused)).toMatchObject({ error: 'provider-target-changed' })
    const current = (await desktop.json<{ providers: ProviderSettings[] }>('providers')).providers.find(item => item.id === provider.id)
    expect(current).toMatchObject({ baseURL: second.baseURL, hasKey: false })
    expect((await auditRecords(t)).some(item => item.action === 'provider.secret.set')).toBe(false)
    expect(first.listings.length + second.listings.length).toBe(0)
  })

  it('sets a key only from the desktop with secrets, confirming a new address once with the key and its allowance', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const origin = new URL(model.baseURL).origin
    // Any admin device may save a keyless service anywhere; an unconfirmed address is kept but never used.
    const created = await browser.json<{ provider: ProviderSettings }>('providers', {
      method: 'POST',
      body: { name: 'Local Lab', kind: 'openai-compatible', baseURL: model.baseURL, models: ['alpha'], defaultModel: 'alpha' },
    })
    expect(created.provider).toMatchObject({ id: 'local-lab', hasKey: false, destination: 'unconfirmed' })
    const expectedTarget = { baseURL: model.baseURL, kind: 'openai-compatible' }
    expect(await body(await browser.request('providers/local-lab', { method: 'PUT', body: { apiKey: 'secret-1' } }))).toMatchObject({
      error: 'scope-required',
      required: 'secrets',
    })
    expect(
      await body(await browser.request('providers/local-lab', { method: 'PUT', body: { confirmOrigin: true, expectedTarget } })),
    ).toMatchObject({
      error: 'local-only',
    })
    const before = t.presence.requests.length
    const keyed = await desktop.confirmed('providers/local-lab', {
      method: 'PUT',
      body: { apiKey: 'secret-1', confirmOrigin: true, expectedTarget },
    })
    expect(keyed.status).toBe(200)
    expect(t.presence.requests.length).toBe(before + 1)
    const settings = (await body<{ provider: ProviderSettings }>(keyed)).provider
    expect(settings).toMatchObject({ hasKey: true, keyOrigin: origin, keyPath: '/v1', destination: 'confirmed' })
    expect(JSON.stringify(settings)).not.toContain('secret-1')
    const preview = t.presence.requests.at(-1)!.preview
    expect(preview).toMatchObject({ action: 'provider.confirm-origin', title: `确认模型服务地址 ${model.allow}`, warnings: [] })
    expect(preview.lines).toEqual([
      { label: '地址', value: model.baseURL },
      { label: '出站许可', value: `允许 Host 访问 ${model.allow}（这台电脑上的地址）` },
      { label: '模型服务', value: 'Local Lab（local-lab）' },
      { label: '密钥', value: `已填写（不显示），只发往 ${origin}/v1` },
    ])
    expect(preview.reason).toBe(`允许 Latch 连接 ${model.baseURL}`)
    expect(JSON.stringify(preview)).not.toContain('secret-1')
    expect(t.host.security.policy.get()).toMatchObject({ confirmedAddresses: [`${origin}/v1`], hostEgressAllow: [model.allow] })
    await callProvider(t, 'local-lab')
    expect(model.calls.at(-1)).toEqual({ model: 'alpha', authorization: 'Bearer secret-1' })
    // The key's record, then the policy change, both with the one confirmation.
    const records = await auditRecords(t)
    const keyRecord = records.findIndex(record => record.action === 'provider.secret.set')
    expect(records[keyRecord]).toMatchObject({ stepup: 'lpc-local', detail: { providerId: 'local-lab' } })
    expect(records[keyRecord + 1]).toMatchObject({
      action: 'policy.changed',
      stepup: 'lpc-local',
      detail: { fields: ['confirmedAddresses', 'hostEgressAllow'], lowering: false },
    })
    // A confirmed address is confirmed once: a new key, or another service there, needs no confirmation.
    expect((await desktop.request('providers/local-lab', { method: 'PUT', body: { apiKey: 'secret-1', expectedTarget } })).status).toBe(200)
    expect(
      (
        await desktop.request('providers', {
          method: 'POST',
          body: {
            id: 'twin',
            name: 'Twin',
            kind: 'openai-compatible',
            baseURL: model.baseURL,
            apiKey: 'twin-key',
            models: ['beta'],
            defaultModel: 'beta',
          },
        })
      ).status,
    ).toBe(201)
    expect(t.presence.requests.length).toBe(before + 1)
    for (const path of ['providers', 'provider', 'snapshot']) expect(await (await browser.request(path)).text()).not.toContain('secret-1')

    // A saved key never follows the base URL to another origin.
    const mismatch = await browser.request('provider-checks', {
      method: 'POST',
      body: { kind: 'openai-compatible', baseURL: 'http://127.0.0.2:9/v1', providerId: 'local-lab' },
    })
    expect(mismatch.status).toBe(409)
    expect(await body(mismatch)).toMatchObject({ error: 'key-origin-mismatch' })
    expect(
      await browser.json('provider-checks', {
        method: 'POST',
        body: { kind: 'openai-compatible', baseURL: model.baseURL, providerId: 'local-lab' },
      }),
    ).toEqual({ ok: true, models: ['alpha', 'beta', 'gamma'], latencyMs: expect.any(Number) })
    expect(model.listings.at(-1)).toEqual({ authorization: 'Bearer secret-1' })
    const moved = await browser.json<{ provider: ProviderSettings }>('providers/local-lab', {
      method: 'PUT',
      body: { baseURL: 'http://127.0.0.1:9/v1', expectedTarget },
    })
    expect(moved.provider.hasKey).toBe(false)
    expect((await HostConfig.open(t.dataDir)).provider('local-lab')).toMatchObject({ apiKey: '' })
    expect((await auditRecords(t)).find(record => record.action === 'provider.secret.cleared')).toMatchObject({
      detail: { reason: 'origin-changed' },
    })
    expect((await browser.request('providers/local-lab', { method: 'DELETE' })).status).toBe(200)
  })

  it('keeps the thinking levels declared for a model and sends the one a session chose', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false })
    const desktop = await t.enroll({ listener: 'unix' })
    const service = {
      name: 'Local Lab',
      kind: 'openai-compatible',
      baseURL: model.baseURL,
      models: ['alpha', 'beta'],
      defaultModel: 'alpha',
    }
    for (const thinking of [['low', 'low'], ['High'], []]) {
      const refused = await desktop.request('providers', {
        method: 'POST',
        body: { ...service, modelCapabilities: { alpha: { thinking } } },
      })
      expect(refused.status).toBe(400)
    }
    const created = await desktop.confirmed('providers', {
      method: 'POST',
      body: { ...service, confirmOrigin: true, modelCapabilities: { alpha: { vision: true, thinking: ['low', 'medium', 'high'] } } },
    })
    expect(created.status).toBe(201)
    expect((await body<{ provider: ProviderSettings }>(created)).provider.modelCapabilities).toEqual({
      alpha: { vision: true, thinking: ['low', 'medium', 'high'] },
    })
    const catalog = (await desktop.json<AppSnapshot>('snapshot')).catalog
    expect(catalog?.providers.find(provider => provider.id === 'local-lab')?.modelCapabilities?.alpha?.thinking).toEqual([
      'low',
      'medium',
      'high',
    ])
    const refused = await desktop.request('tasks', {
      body: {
        prompt: 'x',
        requestId: randomUUID(),
        harnessId: 'standard',
        model: { providerId: 'local-lab', model: 'beta', effort: 'high' },
      },
    })
    expect(refused.status).toBe(400)
    expect(await body(refused)).toMatchObject({ error: 'effort-unavailable' })
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      body: {
        prompt: 'x',
        requestId: randomUUID(),
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: 'local-lab', model: 'alpha', effort: 'high' },
      },
    })
    await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary).toMatchObject({ model: 'alpha', effort: 'high' })
    expect(model.calls.at(-1)).toMatchObject({ model: 'alpha', effort: 'high' })
  })

  it("changes a saved service's protocol, drops the thinking levels it declared, and sends the next turn on the new one", async () => {
    const models = await startFakeModels()
    cleanups.push(() => models.close())
    const t = await testHost({ demo: false })
    const desktop = await t.enroll({ listener: 'unix' })
    const created = await desktop.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Fake',
        kind: 'openai-compatible',
        baseURL: `${models.origin}/v1`,
        apiKey: 'secret-protocol',
        models: ['fake-model', 'fake-model-large'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
        modelCapabilities: { 'fake-model': { vision: true, thinking: ['low', 'high'] }, 'fake-model-large': { thinking: ['low'] } },
      },
    })
    expect(created.status).toBe(201)
    const { provider } = await body<{ provider: ProviderSettings }>(created)
    const run = async (effort?: string) => {
      const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
        body: {
          prompt: 'x',
          requestId: randomUUID(),
          harnessId: 'standard',
          mode: 'chat',
          model: { providerId: provider.id, model: 'fake-model', ...(effort ? { effort } : {}) },
        },
      })
      await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).not.toBe('running'))
      const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
      expect(detail.summary, JSON.stringify(detail.messages.at(-1))).toMatchObject({ status: 'idle' })
      return detail
    }
    await run('high')
    const changed = await desktop.json<{ provider: ProviderSettings }>(`providers/${provider.id}`, {
      method: 'PUT',
      body: { kind: 'openai-responses', expectedTarget: { kind: provider.kind, baseURL: provider.baseURL } },
    })
    expect(changed.provider).toMatchObject({
      kind: 'openai-responses',
      hasKey: true,
      modelCapabilities: { 'fake-model': { vision: true } },
    })
    expect(changed.provider.modelCapabilities).toEqual({ 'fake-model': { vision: true } })
    const refused = await desktop.request('tasks', {
      body: {
        prompt: 'x',
        requestId: randomUUID(),
        harnessId: 'standard',
        model: { providerId: provider.id, model: 'fake-model', effort: 'high' },
      },
    })
    expect(await body(refused)).toMatchObject({ error: 'effort-unavailable' })
    expect((await run()).messages.at(-1)).toMatchObject({ role: 'assistant', text: 'ok' })
    const listed = await desktop.json<{ models: string[] }>(`providers/${provider.id}/models`, { method: 'POST' })
    expect(listed.models).toEqual(['fake-model', 'fake-model-large'])
    // Levels sent with the new protocol are that protocol's, and stay.
    const back = await desktop.json<{ provider: ProviderSettings }>(`providers/${provider.id}`, {
      method: 'PUT',
      body: {
        kind: 'openai-compatible',
        modelCapabilities: { 'fake-model': { thinking: ['low', 'high'] } },
        expectedTarget: { kind: changed.provider.kind, baseURL: changed.provider.baseURL },
      },
    })
    expect(back.provider.modelCapabilities).toEqual({ 'fake-model': { thinking: ['low', 'high'] } })
    expect((await run('high')).messages.at(-1)).toMatchObject({ role: 'assistant', text: 'ok' })
    expect(models.requests.map(request => request.wire)).toEqual(['chat-completions', 'responses', 'chat-completions'])
    expect(models.requests[2]?.body).toMatchObject({ reasoning_effort: 'high' })
    expect(models.requests[0]?.body).toMatchObject({ reasoning_effort: 'high' })
    expect((await desktop.request(`providers/${provider.id}`, { method: 'PUT', body: { kind: 'grpc' } })).status).toBe(400)
    // A protocol Latch no longer speaks is as unknown as any other: a device can neither switch a service to it nor save one.
    expect((await desktop.request(`providers/${provider.id}`, { method: 'PUT', body: { kind: 'gemini' } })).status).toBe(400)
    const retired = await desktop.request('providers', {
      method: 'POST',
      body: { name: 'G', kind: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', models: ['g'], defaultModel: 'g' },
    })
    expect(retired.status).toBe(400)
    expect((await desktop.json<{ providers: ProviderSettings[] }>('providers')).providers.map(item => item.kind)).not.toContain('gemini')
  })

  it.each([
    ['anthropic', '', 'fake-signature-'],
    ['openai-responses', '/v1', 'fake-encrypted-'],
  ] as const)('carries %s reasoning back through one tool loop, never into the next turn or what clients see', async (kind, path, mark) => {
    const models = await startFakeModels({
      replies: [
        { reasoning: 'Look first.', tool: { name: /^read/u, input: { path: 'a.txt' } } },
        { reasoning: 'Once more.', tool: { name: /^read/u, input: { path: 'a.txt' } } },
        { text: 'Done.' },
      ],
    })
    cleanups.push(() => models.close())
    const logs: string[] = []
    const t = await testHost({ demo: false, log: text => logs.push(text) })
    const desktop = await t.enroll({ listener: 'unix' })
    const created = await desktop.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Fake',
        kind,
        baseURL: `${models.origin}${path}`,
        apiKey: 'secret-reasoning',
        models: ['fake-model'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
        modelCapabilities: { 'fake-model': { thinking: ['high'] } },
      },
    })
    expect(created.status).toBe(201)
    const { provider } = await body<{ provider: ProviderSettings }>(created)
    const model = { providerId: provider.id, model: 'fake-model', effort: 'high' }
    const sessionId = await startTask(desktop, 'read it', { harnessId: 'standard', model })
    const idle = async () => {
      await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).not.toBe('running'), {
        timeout: 8_000,
      })
      const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
      expect(detail.summary, JSON.stringify(detail.messages.at(-1))).toMatchObject({ status: 'idle' })
      return detail
    }
    const detail = await idle()
    expect(detail.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Done.' })
    expect(detail.messages.filter(item => item.role === 'tool')).toHaveLength(2)
    const sent = models.requests.map(request => JSON.stringify(request.body))
    expect(sent).toHaveLength(3)
    // Each step of the loop carries the reasoning of every step before it, and nothing it has not seen.
    expect(sent[0]).not.toContain(mark)
    expect(sent[1]).toContain(`${mark}1`)
    expect(sent[1]).not.toContain(`${mark}2`)
    expect(sent[2]).toContain(`${mark}1`)
    expect(sent[2]).toContain(`${mark}2`)
    if (kind === 'openai-responses') expect(models.requests[0]?.body).toMatchObject({ include: ['reasoning.encrypted_content'] })
    // Clients see the reasoning text, never the signed copy.
    expect(detail.messages.map(item => item.reasoning).filter(Boolean)).toEqual(['Look first.', 'Once more.'])
    expect(JSON.stringify(detail)).not.toContain(mark)
    expect(JSON.stringify(await desktop.json('snapshot'))).not.toContain(mark)
    expect(JSON.stringify(await auditRecords(t))).not.toContain(mark)
    const stored = () => readFile(join(t.dataDir, 'sessions', 'runtime.json'), 'utf8')
    expect(await stored()).toContain(`${mark}2`)
    await desktop.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID(), model } })
    await idle()
    expect(models.requests).toHaveLength(4)
    expect(JSON.stringify(models.requests[3]?.body)).not.toContain(mark)
    // Nothing sends it back after its turn, so the session's saved history no longer holds it.
    expect(await stored()).not.toContain(mark)
    expect(logs.filter(line => line.includes(mark) || line.includes('Look first.'))).toEqual([])
  })

  it('never uses a service at an unconfirmed address until it is confirmed, and stops at once when it is removed', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const origin = new URL(model.baseURL).origin
    const address = `${origin}/v1`
    const catalog = async () => (await browser.json<AppSnapshot>('snapshot')).catalog?.providers.map(provider => provider.id) ?? []
    await browser.json('providers', {
      method: 'POST',
      body: {
        id: 'ollama',
        name: 'Ollama',
        kind: 'openai-compatible',
        presetId: 'ollama',
        baseURL: model.baseURL,
        models: ['alpha'],
        defaultModel: 'alpha',
      },
    })
    expect(await catalog()).not.toContain('ollama')
    // Left out of the catalog with its reason, and choosing it says why instead of 「当前不可用」.
    expect((await browser.json<AppSnapshot>('snapshot')).catalog?.unusableProviders).toEqual([
      { id: 'ollama', name: 'Ollama', reason: 'origin-unconfirmed' },
    ])
    const chosen = await browser.request('preferences', {
      method: 'PUT',
      body: { defaults: { model: { providerId: 'ollama', model: 'alpha' } } },
    })
    expect(chosen.status).toBe(403)
    expect(await body(chosen)).toMatchObject({ error: 'origin-unconfirmed' })
    expect(await body(await browser.request('providers/ollama/models', { method: 'POST', body: {} }))).toMatchObject({
      error: 'origin-unconfirmed',
    })
    // Even a lease taken directly is refused before anything is sent.
    await expect(callProvider(t, 'ollama')).rejects.toMatchObject({ code: 'origin-unconfirmed' })
    // A typed address is checked through the egress policy, which names what it would allow.
    const probe = await desktop.request('provider-checks', { method: 'POST', body: { kind: 'openai-compatible', baseURL: model.baseURL } })
    expect(probe.status).toBe(403)
    expect(await body(probe)).toMatchObject({ error: 'egress-denied', target: model.allow })
    expect(model.calls).toEqual([])
    expect(model.listings).toEqual([])

    // Confirming the address before saving, so its models can be listed: one confirmation, nothing saved.
    const before = t.presence.requests.length
    const confirmed = await desktop.confirmed('provider-origins', { method: 'POST', body: { baseURL: model.baseURL } })
    expect(await body(confirmed)).toEqual({ origin, address, destination: 'confirmed', egress: model.allow })
    expect(t.presence.requests.length).toBe(before + 1)
    expect(t.presence.requests.at(-1)!.preview.lines).toEqual([
      { label: '地址', value: model.baseURL },
      { label: '出站许可', value: `允许 Host 访问 ${model.allow}（这台电脑上的地址）` },
    ])
    expect(
      await desktop.json('provider-checks', { method: 'POST', body: { kind: 'openai-compatible', baseURL: model.baseURL } }),
    ).toMatchObject({
      ok: true,
      models: ['alpha', 'beta', 'gamma'],
    })
    expect(await catalog()).toContain('ollama')
    await callProvider(t, 'ollama')
    expect(model.calls).toEqual([{ model: 'alpha', authorization: undefined }])
    // Asking again changes nothing and needs nothing.
    expect(await desktop.json('provider-origins', { method: 'POST', body: { baseURL: model.baseURL } })).toEqual({
      origin,
      address,
      destination: 'confirmed',
    })
    expect(t.presence.requests.length).toBe(before + 1)

    // Removing the address is a tightening: any admin device, no confirmation, and the service stops at once.
    const removed = await browser.request('policy', { method: 'PATCH', body: { confirmedAddresses: { remove: [address] } } })
    expect(removed.status).toBe(200)
    expect(t.host.security.policy.get().confirmedAddresses).toEqual([])
    expect(await catalog()).not.toContain('ollama')
    await expect(callProvider(t, 'ollama')).rejects.toMatchObject({ code: 'origin-unconfirmed' })
    expect((await browser.json<{ providers: ProviderSettings[] }>('providers')).providers[0]).toMatchObject({ destination: 'unconfirmed' })
    // Adding an address through the policy is not offered at all.
    expect((await desktop.request('policy', { method: 'PATCH', body: { confirmedAddresses: { add: [address] } } })).status).toBe(400)
  })

  it('confirms an address with its path, so another path on the same origin (a gateway tenant) stays unconfirmed', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const origin = new URL(model.baseURL).origin
    expect((await desktop.confirmed('provider-origins', { method: 'POST', body: { baseURL: model.baseURL } })).status).toBe(200)
    expect(t.host.security.policy.get().confirmedAddresses).toEqual([`${origin}/v1`])
    const save = (id: string, baseURL: string) =>
      browser.json<{ provider: ProviderSettings }>('providers', {
        method: 'POST',
        body: { id, name: id, kind: 'openai-compatible', baseURL, models: ['alpha'], defaultModel: 'alpha' },
      })
    // The same address, however it is written, is confirmed; another path, a path below it or a dot-segment way out is not.
    expect((await save('same', `${origin}/v1/`)).provider.destination).toBe('confirmed')
    for (const [id, baseURL] of [
      ['tenant', `${origin}/other/v1`],
      ['below', `${origin}/v1/tenant-b`],
      ['dots', `${origin}/v1/../other/v1`],
      ['root', origin],
    ] as const)
      expect((await save(id, baseURL)).provider.destination, id).toBe('unconfirmed')
    const catalog = (await browser.json<AppSnapshot>('snapshot')).catalog?.providers.map(provider => provider.id) ?? []
    expect(catalog).toContain('same')
    expect(catalog).not.toContain('tenant')
    await expect(callProvider(t, 'tenant')).rejects.toMatchObject({ code: 'origin-unconfirmed' })
    expect(
      await body(
        await browser.request('preferences', { method: 'PUT', body: { defaults: { model: { providerId: 'tenant', model: 'alpha' } } } }),
      ),
    ).toMatchObject({ error: 'origin-unconfirmed' })
    await callProvider(t, 'same')
    expect(model.calls).toEqual([{ model: 'alpha', authorization: undefined }])
  })

  it('never offers a keyless service at a preset address, and names it until the key is saved on the desktop', async () => {
    const t = await testHost({ demo: false })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const created = await browser.json<{ provider: ProviderSettings }>('providers', {
      method: 'POST',
      body: {
        name: 'DeepSeek',
        kind: 'openai-compatible',
        presetId: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
      },
    })
    expect(created.provider).toMatchObject({ id: 'deepseek', hasKey: false, destination: 'preset' })
    const catalog = async () => (await browser.json<AppSnapshot>('snapshot')).catalog
    expect((await catalog())?.providers.map(provider => provider.id)).not.toContain('deepseek')
    expect((await catalog())?.unusableProviders).toEqual([{ id: 'deepseek', name: 'DeepSeek', reason: 'key-missing' }])
    const chosen = await browser.request('preferences', {
      method: 'PUT',
      body: { defaults: { model: { providerId: 'deepseek', model: 'deepseek-chat' } } },
    })
    expect(chosen.status).toBe(409)
    expect(await body(chosen)).toMatchObject({
      error: 'provider-key-missing',
      message: '「DeepSeek」还没有填写密钥。请在运行 Latch 的电脑上，打开 设置 › 模型服务 › DeepSeek 填写密钥。',
    })
    // A disabled service is the owner's choice, not something to explain.
    expect((await browser.request('providers/deepseek', { method: 'PUT', body: { enabled: false } })).status).toBe(200)
    expect((await catalog())?.unusableProviders).toEqual([])
    expect((await browser.request('providers/deepseek', { method: 'PUT', body: { enabled: true } })).status).toBe(200)
    expect(
      (
        await desktop.request('providers/deepseek', {
          method: 'PUT',
          body: { apiKey: 'sk-preset', expectedTarget: { kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1' } },
        })
      ).status,
    ).toBe(200)
    expect((await catalog())?.providers.map(provider => provider.id)).toContain('deepseek')
    expect((await catalog())?.unusableProviders).toEqual([])
  })

  it('takes the address back when the save it was confirmed for fails, even while the audit log fails', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false })
    const desktop = await t.enroll({ listener: 'unix' })
    await mkdir(join(t.dataDir, 'providers.json'))
    const audit = t.host.security.audit
    const append = audit.append.bind(audit)
    vi.spyOn(audit, 'append').mockImplementation(async event => {
      if (event.action === 'policy.changed' && (event.detail as { lowering?: boolean }).lowering)
        throw new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行')
      return append(event)
    })
    const response = await desktop.confirmed('providers', {
      method: 'POST',
      body: {
        id: 'local',
        name: 'Local',
        kind: 'openai-compatible',
        baseURL: model.baseURL,
        apiKey: 'never-saved',
        models: ['alpha'],
        defaultModel: 'alpha',
        confirmOrigin: true,
      },
    })
    expect(response.status).toBe(500)
    expect(response.headers.get('x-latch-audit')).toBe('failed')
    expect(t.host.security.policy.get()).toMatchObject({ confirmedAddresses: [], hostEgressAllow: [] })
    const records = await auditRecords(t)
    const key = records.find(record => record.action === 'provider.secret.set')!
    expect(records.filter(record => record.action === 'policy.changed').map(record => record.detail.lowering)).toEqual([false])
    expect(records.find(record => record.action === 'action.failed')).toMatchObject({ detail: { refSeq: key.seq } })
  })

  it('never offers an allowance for a metadata address and warns about plain HTTP to another computer', async () => {
    const t = await testHost({
      demo: false,
      egressLookup: (host, _options, done) =>
        done(null, [{ address: host === 'lan.test' ? '192.168.1.20' : '169.254.169.254', family: 4 }]),
    })
    const desktop = await t.enroll({ listener: 'unix' })
    const metadata = await desktop.request('provider-origins', { method: 'POST', body: { baseURL: 'http://metadata.test/v1' } })
    expect(metadata.status).toBe(403)
    expect(await body(metadata)).toMatchObject({ error: 'egress-denied', target: 'metadata.test:80' })
    expect(
      await body(await desktop.confirmed('provider-origins', { method: 'POST', body: { baseURL: 'http://lan.test:8000/v1' } })),
    ).toEqual({
      origin: 'http://lan.test:8000',
      address: 'http://lan.test:8000/v1',
      destination: 'confirmed',
      egress: 'lan.test:8000',
    })
    expect(t.presence.requests.at(-1)!.preview).toMatchObject({
      title: '确认模型服务地址 lan.test:8000',
      warnings: ['这个地址不使用 HTTPS，发给它的内容会以明文经过网络。'],
      lines: [
        { label: '地址', value: 'http://lan.test:8000/v1' },
        { label: '出站许可', value: '允许 Host 访问 lan.test:8000（局域网或私网地址）' },
      ],
    })
    // A preset's HTTPS origin needs no confirmation at all.
    expect(await desktop.json('provider-origins', { method: 'POST', body: { baseURL: 'https://api.openai.com/v1' } })).toEqual({
      origin: 'https://api.openai.com:443',
      address: 'https://api.openai.com:443/v1',
      destination: 'preset',
    })
  })

  it('keeps addresses confirmed before the upgrade usable and leaves keyless custom ones to be confirmed', async () => {
    const model = await localModel()
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const service = (id: string, baseURL: string, apiKey = '') => ({
      id,
      name: id,
      kind: 'openai-compatible',
      baseURL,
      apiKey,
      ...(apiKey ? { keyOrigin: new URL(baseURL).origin.replace(/^https:\/\/([^:/]+)$/u, 'https://$1:443') } : {}),
      enabled: true,
      models: ['alpha'],
      defaultModel: 'alpha',
    })
    await writeFile(
      join(dataDir, 'providers.json'),
      JSON.stringify({
        version: 1,
        providers: [
          service('keyed', 'https://gateway.example/v1', 'keyed-secret'),
          service('allowed', model.baseURL),
          service('keyless', 'https://elsewhere.example/v1'),
        ],
      }),
      { mode: 0o600 },
    )
    // The previous build's policy: no confirmedAddresses, and the local address on the allow list.
    const first = await testHost({ dataDir, demo: false })
    await first.close()
    const previous = JSON.parse(await readFile(join(dataDir, 'policy.json'), 'utf8')) as Record<string, unknown>
    delete previous.confirmedAddresses
    previous.hostEgressAllow = [model.allow]
    await writeFile(join(dataDir, 'policy.json'), JSON.stringify(previous), { mode: 0o600 })
    const t = await testHost({ dataDir, demo: false })
    expect(t.host.security.policy.get().confirmedAddresses).toEqual(['https://gateway.example:443/v1', model.baseURL])
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const { providers } = await admin.json<{ providers: ProviderSettings[] }>('providers')
    expect(providers.map(provider => [provider.id, provider.destination])).toEqual([
      ['keyed', 'confirmed'],
      ['allowed', 'confirmed'],
      ['keyless', 'unconfirmed'],
    ])
    expect((await auditRecords(t)).some(record => record.action === 'policy.changed-outside')).toBe(true)
  })

  it('saves a key for a preset HTTPS origin from the desktop without a local confirmation, audited as stepup none', async () => {
    const t = await testHost({ demo: false })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const deepseek = {
      name: 'DeepSeek',
      kind: 'openai-compatible',
      presetId: 'deepseek',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    }
    // Other devices still never hold `secrets`.
    const refused = await browser.request('providers', {
      method: 'POST',
      body: { ...deepseek, baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-preset' },
    })
    expect(await body(refused)).toMatchObject({ error: 'scope-required', required: 'secrets' })
    const before = t.presence.requests.length
    const created = await desktop.request('providers', {
      method: 'POST',
      body: { ...deepseek, baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-preset' },
    })
    expect(created.status).toBe(201)
    expect(await body(created)).toMatchObject({
      provider: { id: 'deepseek', hasKey: true, keyOrigin: 'https://api.deepseek.com:443', keyPath: '/v1' },
    })
    // Replacing it and saving another preset's key: still no confirmation.
    expect(
      (
        await desktop.request('providers/deepseek', {
          method: 'PUT',
          body: { apiKey: 'sk-preset-2', expectedTarget: { kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1' } },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await desktop.request('providers', {
          method: 'POST',
          body: {
            name: 'Claude',
            kind: 'anthropic',
            baseURL: 'https://api.anthropic.com',
            apiKey: 'sk-ant',
            models: ['m'],
            defaultModel: 'm',
          },
        })
      ).status,
    ).toBe(201)
    expect(t.presence.requests.length).toBe(before)
    const sets = (await auditRecords(t)).filter(record => record.action === 'provider.secret.set')
    expect(sets.map(record => record.stepup)).toEqual(['none', 'none', 'none'])
    expect((await HostConfig.open(t.dataDir)).provider('deepseek')).toMatchObject({ apiKey: 'sk-preset-2' })

    // Only the exact preset origin: plain HTTP, another port or another host of the same brand is not a preset.
    for (const baseURL of ['http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1', 'https://deepseek.example/v1']) {
      const response = await desktop.request('providers/deepseek', {
        method: 'PUT',
        body: { baseURL, apiKey: 'sk-other', expectedTarget: { kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1' } },
      })
      expect(response.status).toBe(403)
      expect(await body(response)).toMatchObject({ error: 'stepup-required' })
    }
  })

  it('records a key removed through the single-service form, which any admin device may now save without a key', async () => {
    const t = await testHost({ demo: false })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const preset = { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
    expect((await desktop.request('provider', { method: 'PUT', body: { ...preset, apiKey: 'sk-legacy' } })).status).toBe(200)
    expect((await HostConfig.open(t.dataDir)).provider('openai-compatible')).toMatchObject({ apiKey: 'sk-legacy', keyPath: '/v1' })
    expect((await browser.request('provider', { method: 'PUT', body: { ...preset, apiKey: '' } })).status).toBe(200)
    expect((await HostConfig.open(t.dataDir)).provider('openai-compatible')).toMatchObject({ apiKey: '' })
    expect((await auditRecords(t)).filter(record => record.action.startsWith('provider.secret'))).toMatchObject([
      { action: 'provider.secret.set', stepup: 'none' },
      { action: 'provider.secret.cleared', detail: { providerId: 'openai-compatible', reason: 'manual' } },
    ])
  })

  it('never lets a saved key follow a new path on the same origin, as a gateway separating tenants by path needs', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false, egressAllow: [model.allow] })
    const desktop = await t.enroll({ listener: 'unix' })
    const tenantA = model.baseURL.replace(/\/v1$/u, '/tenant-a/v1')
    const created = await desktop.confirmed('providers', {
      method: 'POST',
      body: {
        id: 'gateway',
        name: 'Gateway',
        kind: 'openai-compatible',
        baseURL: tenantA,
        apiKey: 'tenant-a-key',
        models: ['m'],
        defaultModel: 'm',
      },
    })
    expect(await body(created)).toMatchObject({ provider: { hasKey: true, keyPath: '/tenant-a/v1' } })
    // A saved key is checked only against its own path; another path must bring its own key.
    const elsewhere = await desktop.request('provider-checks', {
      method: 'POST',
      body: { kind: 'openai-compatible', baseURL: model.baseURL.replace(/\/v1$/u, '/tenant-b/v1'), providerId: 'gateway' },
    })
    expect(elsewhere.status).toBe(409)
    expect(await body(elsewhere)).toMatchObject({ error: 'key-origin-mismatch' })
    // The same path spelled with a trailing slash keeps the key.
    expect(
      await desktop.json('providers/gateway', {
        method: 'PUT',
        body: { baseURL: `${tenantA}/`, expectedTarget: { kind: 'openai-compatible', baseURL: tenantA } },
      }),
    ).toMatchObject({
      provider: { hasKey: true },
    })
    const moved = await desktop.json<{ provider: ProviderSettings }>('providers/gateway', {
      method: 'PUT',
      body: { baseURL: model.baseURL.replace(/\/v1$/u, '/tenant-b/v1'), expectedTarget: { kind: 'openai-compatible', baseURL: tenantA } },
    })
    expect(moved.provider.hasKey).toBe(false)
    expect((await HostConfig.open(t.dataDir)).provider('gateway')).toMatchObject({ apiKey: '' })
    expect((await HostConfig.open(t.dataDir)).provider('gateway')).not.toHaveProperty('keyPath')
    expect((await auditRecords(t)).filter(record => record.action === 'provider.secret.cleared').at(-1)).toMatchObject({
      detail: { providerId: 'gateway', reason: 'path-changed' },
    })
  })

  it('refuses checks against metadata, private and loopback addresses outside the egress allowlist', async () => {
    const t = await testHost({ demo: false })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    for (const [baseURL, target] of [
      ['http://169.254.169.254/v1', '169.254.169.254:80'],
      ['http://127.0.0.1:65000/v1', '127.0.0.1:65000'],
      ['http://10.1.2.3:8080/v1', '10.1.2.3:8080'],
    ]) {
      const response = await admin.request('provider-checks', {
        method: 'POST',
        body: { kind: 'openai-compatible', baseURL, apiKey: 'never-shown' },
      })
      expect(response.status).toBe(403)
      const result = await body<{ error: string; target: string; message: string }>(response)
      expect(result).toMatchObject({ error: 'egress-denied', target })
      expect(JSON.stringify(result)).not.toContain('never-shown')
    }
  })

  it('keeps the previous live provider when the durable replacement cannot commit', async () => {
    const model = await localModel()
    const previous = { baseURL: model.baseURL, model: 'previous', apiKey: 'previous-key' }
    const t = await testHost({ provider: previous, egressAllow: [model.allow] })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    await mkdir(join(t.dataDir, 'providers.json'))
    const response = await admin.request('providers/openai-compatible', {
      method: 'PUT',
      body: { defaultModel: 'uncommitted', models: ['uncommitted', 'previous'] },
    })
    expect(response.status).toBe(500)
    expect(await admin.json('provider')).toMatchObject({ model: 'previous' })
    await callProvider(t)
    expect(model.calls).toEqual([{ model: 'previous', authorization: 'Bearer previous-key' }])
    expect((await readdir(t.dataDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('serializes concurrent provider saves and keeps disk, listing and live plugin together', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false, egressAllow: [model.allow] })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    await admin.json('providers', {
      method: 'POST',
      body: { id: 'lab', name: 'Lab', kind: 'openai-compatible', baseURL: model.baseURL, models: ['m-0'], defaultModel: 'm-0' },
    })
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        admin.request('providers/lab', { method: 'PUT', body: { defaultModel: `m-${index}`, models: [`m-${index}`] } }),
      ),
    )
    expect(responses.map(response => response.status)).toEqual(responses.map(() => 200))
    const stored = (await HostConfig.open(t.dataDir)).provider('lab')!
    expect((await admin.json<{ providers: ProviderSettings[] }>('providers')).providers[0]!.defaultModel).toBe(stored.defaultModel)
    await callProvider(t, 'lab')
    expect(model.calls).toEqual([{ model: stored.defaultModel, authorization: undefined }])
  })

  it('never writes the LATCH_MODEL key and keeps it usable for its own origin only', async () => {
    const model = await localModel()
    const env = { baseURL: model.baseURL, model: 'alpha', apiKey: 'ENV-SECRET-KEY' }
    const t = await testHost({ provider: env, demo: false, egressAllow: [model.allow] })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    expect((await admin.request('plugins/openai-compatible', { method: 'POST', body: { enabled: false } })).status).toBe(200)
    expect(await readFile(join(t.dataDir, 'providers.json'), 'utf8')).not.toContain('ENV-SECRET-KEY')
    expect((await admin.request('plugins/openai-compatible', { method: 'POST', body: { enabled: true } })).status).toBe(200)
    expect(await admin.json('providers/openai-compatible', { method: 'PUT', body: { name: 'Renamed' } })).toMatchObject({
      provider: { name: 'Renamed', hasKey: true },
    })
    await callProvider(t)
    expect(model.calls.at(-1)).toEqual({ model: 'alpha', authorization: 'Bearer ENV-SECRET-KEY' })
    expect(await readFile(join(t.dataDir, 'providers.json'), 'utf8')).not.toContain('ENV-SECRET-KEY')
  })

  it('refuses to start with credentials, a query or a fragment in LATCH_BASE_URL and never repeats them', async () => {
    for (const baseURL of [
      'https://alice:hunter2@proxy.example/v1',
      'https://proxy.example/v1?api-key=SECRET-QUERY',
      'https://proxy.example/v1#SECRET-FRAGMENT',
    ]) {
      const failure = await testHost({ provider: { baseURL, apiKey: '', model: 'alpha' } }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toMatchObject({ code: 'invalid-url' })
      expect((failure as Error).message).not.toMatch(/hunter2|SECRET/u)
    }
  })

  it('migrates a legacy provider file once and keeps serving the legacy alias', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const legacy = JSON.stringify({ baseURL: 'https://legacy.example/v1', apiKey: 'legacy-secret', model: 'legacy-model' }) + '\n'
    await writeFile(join(dataDir, 'provider.json'), legacy, { mode: 0o600 })
    const t = await testHost({ dataDir, demo: false })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    expect(await admin.json('provider')).toEqual({
      configured: true,
      baseURL: 'https://legacy.example/v1',
      model: 'legacy-model',
      hasKey: true,
      demo: false,
    })
    const listing = await (await admin.request('providers')).text()
    expect(listing).not.toContain('legacy-secret')
    expect(JSON.parse(listing)).toMatchObject({
      providers: [{ id: 'openai-compatible', hasKey: true, keyOrigin: 'https://legacy.example:443' }],
    })
    expect(await readFile(join(dataDir, 'provider.json'), 'utf8')).toBe(legacy)
  })

  it('answers 400 for provider input the plugins cannot use and never generates a reserved agent- ID', async () => {
    const t = await testHost({ demo: false })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    for (const payload of [
      { kind: 'openai-compatible', baseURL: 'https://example.invalid/v1?x=1' },
      { kind: 'anthropic', baseURL: 'https://example.invalid?x=1' },
      { kind: 'openai-compatible', baseURL: 'https://example.invalid/v1', apiKey: 'a\nb' },
    ])
      expect((await admin.request('provider-checks', { method: 'POST', body: payload })).status).toBe(400)
    const base = { kind: 'openai-compatible', baseURL: 'https://example.invalid/v1', models: ['alpha'], defaultModel: 'alpha' }
    expect(await admin.json('providers', { method: 'POST', body: { ...base, name: 'Agent Router' } })).toMatchObject({
      provider: { id: 'provider-agent-router' },
    })
    expect(
      await body(await admin.request('providers', { method: 'POST', body: { ...base, name: 'Chosen', id: 'agent-chosen' } })),
    ).toMatchObject({ error: 'provider-exists' })
  })
})

describe('workspaces, policy and audit', () => {
  it("adds projects outside Latch's own directories only, from the desktop, audited", async () => {
    const codeRoot = await realpath(await temporaryDirectory('latch-code-'))
    const t = await testHost({ codeRoot })
    const desktop = await t.enroll({ listener: 'unix' })
    const viewer = await t.enroll({ listener: 'unix', scopes: ['view', 'run'] })
    const project = await realpath(await temporaryDirectory('latch-project-'))
    const created = await addProject(desktop, [project], 'Demo project')
    expect(created).toEqual({
      workspace: {
        id: 'demo-project',
        name: 'Demo project',
        path: project,
        folders: [{ id: expect.stringMatching(/^latch-project-/u), path: project }],
      },
      refused: [],
    })
    const refusal = async (path: string) => body(await desktop.addFolders({ paths: [path] }))
    expect(await refusal(project)).toMatchObject({
      error: 'workspace-folders-refused',
      refused: [{ path: project, code: 'workspace-exists' }],
    })
    expect(await refusal(join(t.dataDir, 'auth'))).toMatchObject({ refused: [{ code: 'workspace-overlap' }] })
    expect(await refusal(t.root)).toMatchObject({ refused: [{ code: 'workspace-overlap' }] })
    expect(await refusal(codeRoot)).toMatchObject({ refused: [{ code: 'workspace-code-root' }] })
    expect(await refusal('relative/path')).toMatchObject({ refused: [{ code: 'workspace-invalid' }] })
    for (const path of ['folder-grants', 'workspaces'])
      expect(await body(await viewer.request(path, { method: 'POST', body: {} }))).toMatchObject({ error: 'scope-required' })
    expect((await auditRecords(t)).find(record => record.action === 'workspace.added')).toMatchObject({
      detail: {
        workspaceId: 'demo-project',
        pathHash: createHash('sha256').update(project).digest('hex'),
        folderCount: 1,
        foldersHash: sha256Hex(canonicalJson([project])),
        via: 'picker',
      },
    })

    const task = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat', workspaceId: 'demo-project' },
    })
    await settled(t, task.sessionId)
    expect((await t.host.bridge.detail(task.sessionId)).summary).toMatchObject({ cwd: project, workspaceId: 'demo-project' })
    expect((await desktop.request('workspaces/default', { method: 'DELETE' })).status).toBe(409)
    expect((await desktop.request('workspaces/demo-project', { method: 'DELETE' })).status).toBe(200)
  })

  it('lets any admin device set where new sessions start, pinned or not', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const defaults = async () => (await desktop.json<AppSnapshot>('snapshot')).catalog!.defaults
    const put = (device: typeof browser, value: Record<string, unknown>) =>
      device.request('preferences', { method: 'PUT', body: { defaults: value } })
    expect((await put(browser, { harnessId: 'standard' })).status).toBe(200)
    expect((await defaults()).pinned).toBeUndefined()
    expect((await put(desktop, { harnessId: 'standard', pinned: true })).status).toBe(200)
    expect(await defaults()).toMatchObject({ harnessId: 'standard', pinned: true })
    expect((await desktop.json<AppSnapshot>('snapshot')).catalog!.features?.pinnedDefaults).toBe(true)
    expect((await put(browser, { harnessId: 'standard' })).status).toBe(200)
    expect((await put(browser, { pinned: false })).status).toBe(200)
    expect((await defaults()).pinned).toBeUndefined()
  })

  it('stops calling a model a pin once that model cannot start, and again when it can', async () => {
    const model = await localModel()
    const t = await testHost({ demo: false })
    const desktop = await t.enroll({ listener: 'unix' })
    const address = `${new URL(model.baseURL).origin}/v1`
    await desktop.confirmed('providers', {
      method: 'POST',
      body: {
        id: 'ollama',
        name: 'Ollama',
        kind: 'openai-compatible',
        presetId: 'ollama',
        baseURL: model.baseURL,
        models: ['alpha'],
        defaultModel: 'alpha',
        confirmOrigin: true,
      },
    })
    const defaults = async () => (await desktop.json<AppSnapshot>('snapshot')).catalog!.defaults
    const pin = { harnessId: 'standard', model: { providerId: 'ollama', model: 'alpha' }, pinned: true }
    expect((await desktop.request('preferences', { method: 'PUT', body: { defaults: pin } })).status).toBe(200)
    expect(await defaults()).toMatchObject({ model: pin.model, pinned: true })

    const removed = await desktop.request('policy', { method: 'PATCH', body: { confirmedAddresses: { remove: [address] } } })
    expect(removed.status).toBe(200)
    expect((await defaults()).pinned).toBeUndefined()

    await desktop.confirmed('provider-origins', { method: 'POST', body: { baseURL: model.baseURL } })
    expect(await defaults()).toMatchObject({ model: pin.model, pinned: true })
  })

  it('disables saved workspaces that no longer pass the registration rules, keeps them listed and refuses their sessions', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const first = await testHost({ dataDir })
    const admin = await first.enroll({ scopes: [...ADMIN] })
    await addProject(await first.enroll({ listener: 'unix' }), [await realpath(project)], 'project')
    const { sessionId } = await admin.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat', workspaceId: 'project' },
    })
    await settled(first, sessionId)
    await first.close()
    const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as {
      workspaces: Array<{ id: string; name: string; path: string }>
    }
    settings.workspaces.push({ id: 'home', name: 'Home', path: homedir() })
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })

    // The second start treats the project as part of the Latch code, which projects may not overlap.
    const t = await testHost({ dataDir, codeRoot: await realpath(root) })
    const device = await t.enroll({ scopes: [...ADMIN] })
    const snapshot = await device.json<AppSnapshot>('snapshot')
    const reasons = (list: WorkspaceInfo[]) => list.map(item => [item.id, item.unavailable])
    const expected = [
      ['default', undefined],
      ['project', '文件夹「project」：该目录与 Latch 程序目录重叠，不能作为项目'],
      ['home', expect.stringMatching(/^文件夹「[^」]+」：/u)],
    ]
    expect(reasons(snapshot.catalog!.workspaces)).toEqual(expected)
    expect(snapshot.catalog!.defaults.workspaceId).toBe('default')
    expect(reasons((await device.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces)).toEqual(expected)
    expect(
      await body(await device.request('preferences', { method: 'PUT', body: { defaults: { workspaceId: 'project' } } })),
    ).toMatchObject({ error: 'workspace-unavailable' })
    for (const workspaceId of ['home', 'project']) {
      expect(
        await body(
          await device.request('tasks', { method: 'POST', body: { prompt: 'x', requestId: randomUUID(), mode: 'chat', workspaceId } }),
        ),
      ).toMatchObject({ error: 'workspace-disabled' })
    }
    expect(
      await body(await device.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })),
    ).toMatchObject({ error: 'workspace-disabled' })
    const disabled = (await auditRecords(t)).filter(record => record.action === 'workspace.disabled').map(record => record.detail)
    expect(disabled).toEqual([
      { workspaceId: 'project', reason: 'code-root', folderIndex: 0 },
      { workspaceId: 'home', reason: 'overlap', folderIndex: 0 },
    ])
    expect(snapshot.catalog!.workspaces.find(item => item.id === 'project')).toMatchObject({ codeRoot: true })
    expect((await device.request('workspaces/home', { method: 'DELETE' })).status).toBe(200)
  })

  it("audits settings changed outside Latch, but not the Host's own changes, at the next start", async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const outside = async (t: TestHost) => (await auditRecords(t)).filter(record => record.action === 'settings.changed-outside')
    const first = await testHost({ dataDir })
    const admin = await first.enroll({ scopes: [...ADMIN] })
    await addProject(await first.enroll({ listener: 'unix' }), [await realpath(await temporaryDirectory('latch-project-'))], 'project')
    expect((await admin.request('plugins/safe-tools', { method: 'POST', body: { enabled: false } })).status).toBe(200)
    const written = (await auditRecords(first)).filter(record => record.action === 'settings.changed')
    expect(written).toHaveLength(2)
    await first.close()
    const second = await testHost({ dataDir })
    expect(await outside(second)).toEqual([])
    await second.close()

    const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as { agents: unknown[] }
    settings.agents.push({ id: 'evil', name: 'Evil', command: '/bin/sh', args: ['-c', 'id'], env: {}, enabled: false })
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
    const third = await testHost({ dataDir })
    const started = (await auditRecords(third)).filter(record => record.action === 'host.started')
    expect((await outside(third)).map(record => record.detail)).toEqual([
      { expected: started.at(-2)!.detail.settingsHash, actual: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    ])
    await third.close()
    const fourth = await testHost({ dataDir })
    expect(await outside(fourth)).toHaveLength(1)
  })

  it('does not report an outside change after a Host settings write that failed to commit', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const first = await testHost({ dataDir })
    const desktop = await first.enroll({ listener: 'unix' })
    const config = first.host.config
    const update = config.updateSettings.bind(config)
    vi.spyOn(config, 'updateSettings').mockImplementationOnce((mutate, beforePublish) =>
      update(mutate, async next =>
        beforePublish!(next, async () => {
          throw new Error('disk full')
        }),
      ),
    )
    const added = await desktop.addFolders({ paths: [await realpath(await temporaryDirectory('latch-project-'))], name: 'project' })
    expect(added.status).toBe(500)
    const records = await auditRecords(first)
    const write = records.find(record => record.action === 'settings.changed')!
    await expect
      .poll(async () => (await auditRecords(first)).some(record => record.action === 'action.failed' && record.detail.refSeq === write.seq))
      .toBe(true)
    await first.close()
    const second = await testHost({ dataDir })
    expect((await auditRecords(second)).filter(record => record.action === 'settings.changed-outside')).toEqual([])
  })

  it('refuses to start with a default workspace that is the home directory', async () => {
    await expect(testHost({ workspaceRoot: homedir() })).rejects.toMatchObject({ code: 'workspace-overlap' })
  })

  it('classifies writes by the canonical code root and session root, whatever their spelling', async () => {
    const root = await realpath(await temporaryDirectory())
    const workspace = join(root, 'repo')
    await mkdir(workspace)
    const spelled = workspace.toUpperCase()
    if ((await stat(spelled).catch(() => undefined)) === undefined) return // Case-sensitive volume: no second spelling exists.
    const t = await testHost({
      workspaceRoot: workspace,
      codeRoot: spelled,
      demo: false,
      providerId: 'scripted',
      plugins: [scripted('write_file', { path: 'notes.txt', content: 'x' })],
    })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const approval = await pendingApproval(t, await startTask(browser, 'write notes'))
    expect(approval.risk).toBe('R2')
    expect(await body(await browser.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow' } }))).toMatchObject({
      error: 'scope-required',
      required: 'approve:elevated',
    })
    await browser.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
  })

  it('names why a request is high risk, as a code and never a path, and a tool’s own title never lowers it', async () => {
    const titled: ToolDefinition = {
      name: 'lookup',
      title: '读取文件',
      kind: 'read',
      description: 'fixture',
      parameters: { type: 'object' },
      requiresApproval: false,
      execute: async () => ({ text: 'ok' }),
    }
    const cases: Array<[string, HarnessPlugin, Partial<TestHostOptions>, Approval['riskReason']]> = [
      ['code-root', scripted('write_file', { path: 'notes.txt', content: 'x' }), { codeRoot: '<root>' }, 'code-root'],
      ['protected-path', scripted('write_file', { path: '.git/config', content: 'x' }), {}, 'protected-path'],
      ['outside-workspace', scripted('write_file', { path: '../elsewhere.txt', content: 'x' }), {}, 'outside-workspace'],
      ['unresolved-path', scripted('write_file', { path: '/tmp/notes.txt', content: 'x' }), {}, 'unresolved-path'],
      ['unlisted-tool', scripted('lookup', { path: 'notes.txt' }, [titled]), {}, 'unlisted-tool'],
      ['ordinary write', scripted('write_file', { path: 'notes.txt', content: 'x' }), {}, undefined],
    ]
    for (const [name, plugin, extra, reason] of cases) {
      const root = await realpath(await temporaryDirectory())
      const workspaceRoot = join(root, 'repo')
      await mkdir(workspaceRoot)
      const t = await testHost({
        workspaceRoot,
        demo: false,
        providerId: 'scripted',
        plugins: [plugin],
        ...extra,
        ...(extra.codeRoot ? { codeRoot: root } : {}),
      })
      const browser = await t.enroll({ scopes: [...ADMIN] })
      // The start directory says it lies in Latch's program directory, so pages can warn before the first write.
      const start = (await browser.json<AppSnapshot>('snapshot')).catalog?.workspaces.find(item => item.id === 'default')
      expect(start?.codeRoot, name).toBe(name === 'code-root' ? true : undefined)
      const sessionId = await startTask(browser, name)
      const pending = await pendingApproval(t, sessionId)
      const shown = (await browser.json<AppSnapshot>('snapshot')).approvals.find(item => item.id === pending.id)!
      const detail = await browser.json<TaskDetail>(`tasks/${sessionId}`)
      expect([shown.risk, shown.riskReason], name).toEqual(reason ? ['R2', reason] : ['R1', undefined])
      expect(detail.approvals[0]?.riskReason, name).toBe(reason)
      expect(shown.tool?.toolTitle, name).toBe(name === 'unlisted-tool' ? '读取文件' : '写入文件')
      await browser.json(`approvals/${pending.id}`, { method: 'POST', body: { decision: 'reject' } })
    }
  })

  it('records how each approval ended and where, and hands a rejection’s note to the built-in harness', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const decision = async (sessionId: string) =>
      (await browser.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(message => message.role === 'tool')?.tool?.decision
    // Pages ask for a note only for a Harness that hands one on.
    const harnesses = (await browser.json<AppSnapshot>('snapshot')).catalog!.harnesses
    expect(harnesses.find(item => item.id === 'standard')?.capabilities.permission.rejectionNote).toBe(true)

    const allowed = await startTask(desktop, '生成需要审批的报告')
    await desktop.json(`approvals/${(await pendingApproval(t, allowed)).id}`, { method: 'POST', body: { decision: 'allow' } })
    await settled(t, allowed)
    expect(await decision(allowed)).toEqual({ outcome: 'allowed', at: expect.any(String), via: 'this-mac' })

    const rejected = await startTask(browser, '生成需要审批的报告')
    const approval = await pendingApproval(t, rejected)
    for (const [payload, message] of [
      [{ decision: 'allow', note: '改写到 docs/' }, '只有拒绝时可以附上说明'],
      [{ decision: 'reject', note: 'x'.repeat(501) }, '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符'],
      [{ decision: 'reject', note: '改写‮到 docs/' }, '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符'],
    ] as const) {
      expect(await body(await browser.request(`approvals/${approval.id}`, { method: 'POST', body: payload }))).toEqual({
        error: 'invalid-note',
        message,
      })
    }
    // A note is input to the model: a device that may only view can reject, but not steer the model.
    const viewer = await t.enroll({ scopes: ['view'] })
    expect(
      await body(await viewer.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject', note: '删掉所有文件' } })),
    ).toMatchObject({ error: 'scope-required', required: 'run' })
    expect(t.host.bridge.approvals().map(item => item.id)).toEqual([approval.id])
    const before = (await auditRecords(t)).length
    await browser.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject', note: '先把计划发给我看' } })
    await settled(t, rejected)
    expect(await decision(rejected)).toEqual({ outcome: 'rejected', at: expect.any(String), via: 'other-device' })
    const detail = await browser.json<TaskDetail>(`tasks/${rejected}`)
    expect(detail.messages.find(message => message.role === 'tool')?.tool?.output).toBe(
      '用户拒绝了本次工具调用，未执行该操作。用户的说明：先把计划发给我看',
    )
    expect(detail.messages.find(message => message.role === 'tool')?.tool).not.toHaveProperty('outputWithoutFiles')
    expect((await t.host.bridge.detail(rejected)).messages.find(message => message.role === 'tool')?.tool?.outputWithoutFiles).toBe(
      '用户拒绝了本次工具调用，未执行该操作。用户的说明：先把计划发给我看',
    )
    // The demo answers in its own words: no internal code, no doubled full stop.
    const reply = detail.messages.findLast(message => message.role === 'assistant')!.text
    expect(reply).toBe('你拒绝了这次操作，报告没有写入。\n\n收到你的说明：「先把计划发给我看」。这是演示模型，不会据此改做别的事。')
    expect(reply).not.toMatch(/APPROVAL_REJECTED|。。/u)
    // The person's words go to the model, not into the audit log.
    const records = (await auditRecords(t)).slice(before)
    expect(records.map(record => record.action)).toContain('approval.decided')
    expect(JSON.stringify(records)).not.toContain('先把计划')

    const viewerRejected = await startTask(browser, '生成需要审批的报告')
    const viewerApproval = await pendingApproval(t, viewerRejected)
    const request = { decision: 'reject', requestId: randomUUID() } as const
    const accepted = await viewer.json<{ receipt: ApprovalReceipt }>(`approvals/${viewerApproval.id}`, { method: 'POST', body: request })
    await settled(t, viewerRejected)
    expect(await decision(viewerRejected)).toEqual({ outcome: 'rejected', at: expect.any(String), via: 'other-device' })
    expect(await viewer.json(`approvals/${viewerApproval.id}`, { method: 'POST', body: request })).toEqual({
      accepted: true,
      receipt: { ...accepted.receipt, replay: true },
    })
  })

  it.each(['turns private during the decision', 'is missing from the listing'])(
    'refuses a narrower device’s note when its session %s, and never blocks a plain rejection',
    async change => {
      const t = await testHost()
      const browser = await t.enroll({ scopes: [...ADMIN] })
      const narrow = await t.enroll({ scopes: ['view', 'run'], dataScope: 'work' })
      const sessionId = await startTask(browser, '生成需要审批的报告')
      const approval = await pendingApproval(t, sessionId)
      const bridge = t.host.bridge
      const listTasks = bridge.listTasks.bind(bridge),
        agentPrivate = bridge.agentPrivate.bind(bridge)
      let listed = false
      const listing = vi.spyOn(bridge, 'listTasks').mockImplementation(async () => {
        const tasks = await listTasks()
        listed = true
        return change === 'is missing from the listing' ? tasks.filter(task => task.id !== sessionId) : tasks
      })
      // The listing read before the decision still says ordinary; the session is private from then on.
      const turning = vi
        .spyOn(bridge, 'agentPrivate')
        .mockImplementation(id => (change === 'turns private during the decision' && listed && id === sessionId) || agentPrivate(id))
      const noted = await narrow.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject', note: '删掉所有文件' } })
      expect(noted.status).toBe(403)
      expect(t.host.bridge.approvals().map(item => item.id)).toEqual([approval.id])
      await narrow.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
      listing.mockRestore()
      turning.mockRestore()
      await settled(t, sessionId)
      const tool = (await t.host.bridge.detail(sessionId)).messages.find(message => message.role === 'tool')?.tool
      expect(tool?.decision?.outcome).toBe('rejected')
      expect(JSON.stringify(tool)).not.toContain('删掉所有文件')
    },
  )

  it('treats every write as protected when the session root itself lies inside .git', async () => {
    const root = await realpath(await temporaryDirectory())
    const workspace = join(root, 'repo', '.git')
    await mkdir(workspace, { recursive: true })
    const t = await testHost({
      workspaceRoot: workspace,
      demo: false,
      providerId: 'scripted',
      plugins: [scripted('write_file', { path: 'hooks/pre-commit', content: '#!/bin/sh\n' })],
    })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const approval = await pendingApproval(t, await startTask(browser, 'add a hook'))
    expect(approval.risk).toBe('R2')
    await browser.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
  })

  it('lets any admin take an outbound address away and adds one only on the desktop with confirmation', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const address = '127.0.0.1:11434'
    expect(await body(await admin.request('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [address] } } }))).toMatchObject({
      error: 'local-only',
    })
    expect((await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [address] } } })).status).toBe(200)
    expect(t.presence.requests.at(-1)!.preview).toMatchObject({
      action: 'policy.change',
      title: `允许 Host 访问 ${address}`,
      reason: `允许 Latch 连接 ${address}`,
    })
    expect(await admin.json('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: [address] } } })).toMatchObject({
      policy: { hostEgressAllow: [] },
    })
    const changes = (await auditRecords(t)).filter(record => record.action === 'policy.changed')
    expect(changes.map(record => [record.detail.lowering, record.stepup])).toEqual([
      [false, 'lpc-local'],
      [true, 'none'],
    ])
    // A setting that no longer exists is refused, not ignored.
    expect((await admin.request('policy', { method: 'PATCH', body: { remote: { maxLevel: 'L2' } } })).status).toBe(400)
  })

  it("hands the page the sheet's sentence and its form, the details, and a Touch ID lockout", async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const raise = { hostEgressAllow: { add: ['127.0.0.1:11434'] } }
    const ticket = async (response: Response) => (await body<{ confirmation: ConfirmationTicket }>(response)).confirmation
    const asked = await ticket(await desktop.request('policy', { method: 'PATCH', body: raise }))
    expect(asked).toMatchObject({
      reason: '允许 Latch 连接 127.0.0.1:11434',
      form: 'origin.confirm',
      lines: [expect.objectContaining({ label: expect.any(String), value: expect.any(String) })],
      warnings: [],
    })
    expect(asked).not.toHaveProperty('failure')
    await expect.poll(async () => (await ticket(await desktop.request(`confirmations/${asked.id}`))).status).toBe('approved')
    vi.spyOn(t.presence, 'confirm').mockResolvedValueOnce({
      result: 'error',
      message: 'Touch ID 已锁定，下次确认改用登录密码',
      failure: 'biometry-lockout',
    })
    const locked = await ticket(await desktop.request('policy', { method: 'PATCH', body: raise }))
    await expect
      .poll(async () => await ticket(await desktop.request(`confirmations/${locked.id}`)))
      .toMatchObject({ status: 'error', failure: 'biometry-lockout' })
  })

  it('never lets a confirmed policy raise undo a lowering that committed after the confirmation was computed', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const raise = { hostEgressAllow: { add: ['127.0.0.1:11434'] } }
    await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11435'] } } })
    const first = await desktop.request('policy', { method: 'PATCH', body: raise })
    const { confirmation } = await body<{ confirmation: ConfirmationTicket }>(first)
    await expect
      .poll(async () => (await desktop.json<{ confirmation: ConfirmationTicket }>(`confirmations/${confirmation.id}`)).confirmation.status)
      .toBe('approved')
    const store = t.host.security.policy
    const update = store.update.bind(store)
    let release!: () => void
    const held = new Promise<void>(done => {
      release = done
    })
    vi.spyOn(store, 'update').mockImplementationOnce(async (...args) => {
      await held
      return update(...args)
    })
    const lowering = admin.request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: ['127.0.0.1:11435'] } } })
    await vi.waitFor(() => expect(store.update).toHaveBeenCalledOnce())
    const confirmed = desktop.request('policy', { method: 'PATCH', body: raise, confirmation: confirmation.id })
    await new Promise(done => setTimeout(done, 50))
    release()
    expect((await lowering).status).toBe(200)
    const answer = await confirmed
    expect(answer.status).toBe(409)
    expect(await body(answer)).toMatchObject({ error: 'policy-changed' })
    expect(store.get().hostEgressAllow).toEqual([])
  })

  it('binds a permission grant to the device state it was previewed against and shows Host-derived facts first', async () => {
    const t = await testHost({ tls: true })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: [...ADMIN], dataScope: 'work' })
    const request = { scopes: ['view', 'run', 'approve:standard', 'admin'], dataScope: 'all' }
    const first = await desktop.request(`devices/${browser.id}`, { method: 'PATCH', body: request })
    const { confirmation } = await body<{ confirmation: ConfirmationTicket }>(first)
    await expect
      .poll(async () => (await desktop.json<{ confirmation: ConfirmationTicket }>(`confirmations/${confirmation.id}`)).confirmation.status)
      .toBe('approved')
    expect(await admin.json(`devices/${browser.id}`, { method: 'PATCH', body: { scopes: ['view'] } })).toMatchObject({
      device: { scopes: ['view'] },
    })
    const resent = await desktop.request(`devices/${browser.id}`, { method: 'PATCH', body: request, confirmation: confirmation.id })
    expect(resent.status).toBe(409)
    expect(await body(resent)).toMatchObject({ error: 'confirmation-mismatch' })
    expect(t.host.security.devices.get(browser.id)).toMatchObject({ scopes: ['view'], dataScope: 'work' })

    // A reduction still queued when the confirmed request reads the device is not undone either.
    const other = await t.enroll({ scopes: [...ADMIN], dataScope: 'work' })
    const widen = { scopes: [...ADMIN], dataScope: 'all' }
    const asked = await body<{ confirmation: ConfirmationTicket }>(
      await desktop.request(`devices/${other.id}`, { method: 'PATCH', body: widen }),
    )
    await expect
      .poll(
        async () =>
          (await desktop.json<{ confirmation: ConfirmationTicket }>(`confirmations/${asked.confirmation.id}`)).confirmation.status,
      )
      .toBe('approved')
    const store = t.host.security.devices
    const changeScopes = store.changeScopes.bind(store)
    let release!: () => void
    const held = new Promise<void>(done => {
      release = done
    })
    vi.spyOn(store, 'changeScopes').mockImplementationOnce(async (...args) => {
      await held
      return changeScopes(...args)
    })
    const lowering = admin.request(`devices/${other.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
    await vi.waitFor(() => expect(store.changeScopes).toHaveBeenCalledOnce())
    const confirmed = desktop.request(`devices/${other.id}`, { method: 'PATCH', body: widen, confirmation: asked.confirmation.id })
    await new Promise(done => setTimeout(done, 50))
    release()
    expect((await lowering).status).toBe(200)
    expect(await body(await confirmed)).toMatchObject({ error: 'device-changed' })
    expect([...store.get(other.id)!.scopes].sort()).toEqual(['run', 'view'])
    expect(store.get(other.id)!.dataScope).toBe('work')

    const { invitation } = await desktop.json<{ invitation: InvitationView }>('pairings', {
      method: 'POST',
      body: { scopes: ['view', 'run'] },
    })
    const phone = await t.enroll({ listener: 'tls', invitation: invitation.code, name: 'Owner Mac' })
    await admin.json(`devices/${desktop.id}`, { method: 'DELETE' })
    const owner = await t.enroll({ listener: 'unix' })
    expect((await owner.confirmed(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view', 'run', 'admin'] } })).status).toBe(200)
    const preview = t.presence.requests.at(-1)!.preview
    expect(preview.lines.slice(0, 4)).toEqual([
      { label: '连接方式', value: `局域网 HTTPS · ${t.host.tlsOrigin}` },
      { label: '配对方式', value: '配对邀请（邀请设备：Test device (2)）' },
      { label: '当前状态', value: '待复核（邀请设备已被撤销）' },
      { label: '设备名称', value: 'Owner Mac' },
    ])
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        '该设备通过网络连接，不在这台电脑上。',
        '该设备的邀请设备已被撤销；确认后它将恢复正常使用。',
        '确认后该设备可以管理此 Host：模型服务、插件、项目和其他设备。',
      ]),
    )
  })

  it('refuses a confirmed grant once a revocation cascade puts the device under review first', async () => {
    const t = await testHost({ tls: true })
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const inviter = await t.enroll({ listener: 'unix', name: 'Inviter' })
    const owner = await t.enroll({ listener: 'unix', name: 'Owner' })
    const { invitation } = await inviter.json<{ invitation: InvitationView }>('pairings', {
      method: 'POST',
      body: { scopes: ['view', 'run'] },
    })
    const phone = await t.enroll({ listener: 'tls', invitation: invitation.code })
    const grant = { scopes: ['view', 'run', 'admin'] }
    const { confirmation } = await body<{ confirmation: ConfirmationTicket }>(
      await owner.request(`devices/${phone.id}`, { method: 'PATCH', body: grant }),
    )
    await waitForApproval(owner, confirmation)
    const store = t.host.security.devices
    const internals = store as unknown as { appendRevocation(...args: unknown[]): Promise<void> }
    const appendRevocation = internals.appendRevocation.bind(store)
    let release!: () => void
    const held = new Promise<void>(done => {
      release = done
    })
    vi.spyOn(internals, 'appendRevocation').mockImplementationOnce(async (...args: unknown[]) => {
      await held
      return appendRevocation(...args)
    })
    const changeScopes = vi.spyOn(store, 'changeScopes')
    // The cascade lands inside the store's queue, after the grant has read the device as still active.
    const revoking = admin.request(`devices/${inviter.id}`, { method: 'DELETE' })
    await vi.waitFor(() => expect(store.get(inviter.id)?.status).toBe('revoked'))
    const confirmed = owner.request(`devices/${phone.id}`, { method: 'PATCH', body: grant, confirmation: confirmation.id })
    await vi.waitFor(() => expect(changeScopes).toHaveBeenCalled())
    release()
    expect((await revoking).status).toBe(200)
    const answer = await confirmed
    expect(answer.status).toBe(409)
    expect(await body(answer)).toMatchObject({ error: 'device-changed' })
    expect(store.get(phone.id)).toMatchObject({ status: 'review', scopes: ['view'] })
  })

  it('never lets a policy change overwrite a helper pin that lands first: a confirmed raise is refused and a lowering is reapplied', async () => {
    const cdhash = 'ab'.repeat(20)
    async function heldPin(t: TestHost) {
      const audit = t.host.security.audit
      const append = audit.append.bind(audit)
      let release!: () => void
      const held = new Promise<void>(done => {
        release = done
      })
      vi.spyOn(audit, 'append').mockImplementation(async event => {
        if (event.action === 'presence.helper.pinned') await held
        return append(event)
      })
      const update = vi.spyOn(t.host.security.policy, 'update')
      const pinned = t.host.security.policy.pinHelperCdhash(cdhash)
      return {
        update,
        finish: async () => {
          release()
          await pinned
        },
      }
    }

    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const raise = { hostEgressAllow: { add: ['127.0.0.1:11434'] } }
    const { confirmation } = await body<{ confirmation: ConfirmationTicket }>(
      await desktop.request('policy', { method: 'PATCH', body: raise }),
    )
    await waitForApproval(desktop, confirmation)
    const pin = await heldPin(t)
    const confirmed = desktop.request('policy', { method: 'PATCH', body: raise, confirmation: confirmation.id })
    await vi.waitFor(() => expect(pin.update).toHaveBeenCalledOnce())
    await pin.finish()
    expect(await body(await confirmed)).toMatchObject({ error: 'policy-changed' })
    expect(t.host.security.policy.get()).toMatchObject({ hostEgressAllow: [], presence: { helperCdhash: cdhash } })

    vi.restoreAllMocks()
    const other = await testHost()
    const admin = await other.enroll({ scopes: [...ADMIN] })
    const desktopOther = await other.enroll({ listener: 'unix' })
    await desktopOther.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: ['127.0.0.1:11435'] } } })
    const otherPin = await heldPin(other)
    const lowering = admin.request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: ['127.0.0.1:11435'] } } })
    await vi.waitFor(() => expect(otherPin.update).toHaveBeenCalledOnce())
    await otherPin.finish()
    expect((await lowering).status).toBe(200)
    expect(other.host.security.policy.get()).toMatchObject({ hostEgressAllow: [], presence: { helperCdhash: cdhash } })
  })

  it('refuses privilege-granting actions when the audit log fails and still applies revocations', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll()
    vi.spyOn(t.host.security.audit, 'append').mockRejectedValue(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行'))
    const { testDeviceKey } = await import('@latch/testkit')
    const enrollment = await t.raw('unix', 'api/enrollments', {
      method: 'POST',
      body: { publicKey: testDeviceKey().spki, name: 'Another' },
    })
    expect(enrollment.status).toBe(503)
    expect(await body(enrollment)).toMatchObject({ error: 'audit-unavailable' })
    expect(await body(await desktop.addFolders({ paths: [await temporaryDirectory('latch-project-')] }))).toMatchObject({
      error: 'audit-unavailable',
    })
    expect(t.host.config.settings().workspaces).toEqual([])
    const revoked = await admin.request(`devices/${phone.id}`, { method: 'DELETE' })
    expect(revoked.status).toBe(200)
    expect(revoked.headers.get('x-latch-audit')).toBe('failed')
    expect(t.host.security.devices.get(phone.id)?.status).toBe('revoked')
  })

  it('exposes the audit head and earlier hashes to any device', async () => {
    const t = await testHost()
    const device = await t.enroll()
    const head = await device.json<{ seq: number; hash: string }>('audit/head')
    expect(head.seq).toBeGreaterThan(1)
    expect(await device.json(`audit/hash?seq=${head.seq}`)).toEqual(head)
    expect((await device.request('audit/hash?seq=999999')).status).toBe(404)
    const first = (await auditRecords(t))[0]!
    expect(first).toMatchObject({ action: 'policy.created' })
    expect((await auditRecords(t)).some(record => record.action === 'host.started')).toBe(true)
  })
})

describe('sessions, plugins and the change stream', () => {
  it('renames, pins, archives and deletes sessions, refusing to delete a running one', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const { sessionId } = await admin.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat' },
    })
    await settled(t, sessionId)
    const patched = await admin.json<{ summary: TaskSummary }>(`tasks/${sessionId}`, {
      method: 'PATCH',
      body: { title: '新的标题', pinned: true },
    })
    expect(patched.summary).toMatchObject({ id: sessionId, title: '新的标题', pinned: true, harnessId: 'standard', level: 'L1' })
    expect((await admin.request(`tasks/${sessionId}`, { method: 'PATCH', body: {} })).status).toBe(400)
    expect(
      await body(await admin.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'model', value: 'x' } })),
    ).toMatchObject({ error: 'config-not-found', configOutcome: 'not-sent' })
    const running = await t.host.bridge.createTask({ prompt: '生成需要审批的报告', requestId: randomUUID() })
    await pendingApproval(t, running.sessionId)
    expect(await body(await admin.request(`tasks/${running.sessionId}`, { method: 'DELETE' }))).toMatchObject({ error: 'task-running' })
    await t.host.bridge.cancel(running.sessionId)
    expect(await admin.json(`tasks/${sessionId}`, { method: 'DELETE' })).toEqual({ deleted: true })
    expect((await admin.request(`tasks/${sessionId}`)).status).toBe(404)
    for (const path of ['tasks/%E0%A4%A', 'approvals/%E0%A4%A']) {
      const response = await admin.request(path, {
        method: path.startsWith('approvals') ? 'POST' : 'GET',
        ...(path.startsWith('approvals') ? { body: { decision: 'allow' } } : {}),
      })
      expect(await body(response)).toMatchObject({ error: 'invalid-path' })
    }
  })

  it('accepts a full 16,000-character CJK prompt and rejects a longer one', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const accepted = await admin.request('tasks', {
      method: 'POST',
      body: { prompt: '汉'.repeat(16_000), requestId: randomUUID(), mode: 'chat' },
    })
    expect(accepted.status).toBe(201)
    const { sessionId } = await body<{ sessionId: string }>(accepted)
    await settled(t, sessionId)
    expect(
      (await admin.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '字'.repeat(16_000), requestId: randomUUID() } }))
        .status,
    ).toBe(200)
    expect(
      (await admin.request('tasks', { method: 'POST', body: { prompt: '汉'.repeat(16_001), requestId: randomUUID(), mode: 'chat' } }))
        .status,
    ).toBe(400)
  })

  it('persists a plugin switch across restarts and refuses to disable the built-in harness', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const first = await testHost({ dataDir })
    const admin = await first.enroll({ scopes: [...ADMIN] })
    expect((await admin.request('plugins/safe-tools', { method: 'POST', body: { enabled: false } })).status).toBe(200)
    expect(await body(await admin.request('plugins/standard-harness', { method: 'POST', body: { enabled: false } }))).toMatchObject({
      error: 'plugin-locked',
    })
    await first.close()
    const second = await testHost({ dataDir })
    const again = await second.enroll({ scopes: [...ADMIN] })
    const plugins = (await again.json<{ plugins: Array<{ id: string; enabled: boolean }> }>('plugins')).plugins
    expect(plugins.find(plugin => plugin.id === 'safe-tools')).toMatchObject({ enabled: false })
  })

  it('lists a plugin as in use only while sessions run on it, never for a loaded harness alone', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const inUse = async () =>
      Object.fromEntries(
        (await admin.json<{ plugins: Array<{ id: string; activeRuns: number }> }>('plugins')).plugins.map(plugin => [
          plugin.id,
          plugin.activeRuns,
        ]),
      )
    expect(await inUse()).toMatchObject({ 'standard-harness': 0, demo: 0, 'safe-tools': 0, 'workspace-files': 0 })
    // The demo report waits for approval: the session runs on the built-in harness, the demo model and the tools.
    const sessionId = await startTask(admin, '生成需要审批的报告')
    await pendingApproval(t, sessionId)
    expect(await inUse()).toMatchObject({ 'standard-harness': 1, demo: 1, 'safe-tools': 1, 'workspace-files': 1 })
    await admin.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} })
    expect(await inUse()).toMatchObject({ 'standard-harness': 0, demo: 0, 'safe-tools': 0, 'workspace-files': 0 })
  })

  it('denies workspace tools the Host data directory and runtime directory', async () => {
    const root = await realpath(await temporaryDirectory('latch-root-'))
    const dataDir = join(root, '.runtime')
    await writeFile(join(root, 'notes.txt'), 'project notes')
    const t = await testHost({ dataDir, workspaceRoot: root })
    const lease = t.host.registry.acquire('demo')
    try {
      const read = lease.tools.find(tool => tool.name === 'read_file')!
      const context = { sessionId: 's', callId: 'c', workspaceRoot: root, signal: new AbortController().signal }
      expect(await read.execute({ path: 'notes.txt' }, context)).toEqual({ text: 'project notes' })
      for (const path of [
        '.runtime/auth/devices.json',
        '.runtime/providers.json',
        '.runtime/identity/host-key.pem',
        '.runtime/audit/audit.jsonl',
      ]) {
        await expect(read.execute({ path }, context)).rejects.toThrow('私有数据目录')
      }
    } finally {
      lease.release()
    }
  })

  it("denies workspace tools the data-directory lock and the Host's temporary files when the workspace is the data directory", async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const t = await testHost({ dataDir, workspaceRoot: dataDir })
    const lease = t.host.registry.acquire('demo')
    try {
      const write = lease.tools.find(tool => tool.name === 'write_file')!
      const read = lease.tools.find(tool => tool.name === 'read_file')!
      const context = { sessionId: 's', callId: 'c', workspaceRoot: dataDir, signal: new AbortController().signal }
      await write.execute({ path: 'notes.txt', content: 'ok' }, context)
      for (const path of [
        'host.lock',
        'Host.Lock',
        `.host-lock-${randomUUID()}.stale`,
        `.providers.json-${randomUUID()}.tmp`,
        `.settings.json-${randomUUID()}.tmp`,
      ]) {
        await expect(write.execute({ path, content: '{}' }, context), path).rejects.toThrow('私有数据目录')
      }
      await writeFile(join(dataDir, 'host.lock'), '{}', { mode: 0o600 })
      await expect(read.execute({ path: 'host.lock' }, context)).rejects.toThrow('私有数据目录')
      for (const path of ['personal/personal.json', 'Personal/personal.json'])
        await expect(read.execute({ path }, context)).rejects.toThrow('私有数据目录')
    } finally {
      lease.release()
    }
  })

  it('keeps the private entries no store has written yet out of reach when the workspace is the data directory', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const t = await testHost({ dataDir, workspaceRoot: dataDir })
    const lease = t.host.registry.acquire('demo')
    try {
      const write = lease.tools.find(tool => tool.name === 'write_file')!
      const context = { sessionId: 's', callId: 'c', workspaceRoot: dataDir, signal: new AbortController().signal }
      for (const path of ['snapshots/turn.json', 'Automations/x.json', 'automations.json', `.automations.json-${randomUUID()}.tmp`])
        await expect(write.execute({ path, content: '{}' }, context), path).rejects.toThrow('私有数据目录')
      await write.execute({ path: 'snapshot-notes.txt', content: 'ok' }, context)
    } finally {
      lease.release()
    }
  })

  it('closes the audit log when the Host stops and when it fails to start', async () => {
    const t = await testHost()
    const audit = t.host.security.audit
    await t.host.close()
    await expect(audit.append({ action: 'action.failed', actor: { listener: 'host' }, detail: { refSeq: 1 } })).rejects.toMatchObject({
      code: 'audit-unavailable',
    })
    const close = vi.spyOn(AuditLog.prototype, 'close')
    await expect(testHost({ workspaceRoot: homedir() })).rejects.toMatchObject({ code: 'workspace-overlap' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the legacy workspace inside the data directory usable for Standard but not for full-access sessions', async () => {
    const root = await temporaryDirectory()
    const dataDir = join(root, 'data')
    const t = await testHost({ dataDir, workspaceRoot: join(dataDir, 'workspace') })
    const workspace = join(dataDir, 'workspace')
    await writeFile(join(workspace, 'inside.txt'), 'inside')
    const lease = t.host.registry.acquire('demo')
    try {
      const read = lease.tools.find(tool => tool.name === 'read_file')!
      expect(
        await read.execute(
          { path: 'inside.txt' },
          { sessionId: 's', callId: 'c', workspaceRoot: workspace, signal: new AbortController().signal },
        ),
      ).toEqual({ text: 'inside' })
      await expect(
        read.execute(
          { path: 'auth/devices.json' },
          { sessionId: 's', callId: 'c', workspaceRoot: dataDir, signal: new AbortController().signal },
        ),
      ).rejects.toThrow('私有数据目录')
    } finally {
      lease.release()
    }
    const outside = {
      id: 'outside-plugin',
      name: 'Outside',
      version: '1',
      description: 'fixture',
      activate(ctx: Parameters<HarnessPlugin['activate']>[0]) {
        ctx.registerHarness({
          id: 'outside',
          name: 'Outside',
          version: '1',
          create: () => ({
            start: async () => {},
            close: async () => {},
            listTasks: async () => [],
            detail: async () => {
              throw new Error('none')
            },
            createTask: async () => ({ sessionId: 'x' }),
            prompt: async () => {},
            cancel: async () => {},
            approvals: () => [],
            decide: async () => false,
            subscribe: () => () => {},
          }),
        })
      },
    }
    await t.close()
    const again = await testHost({ dataDir, workspaceRoot: workspace, plugins: [outside] })
    const desktop = await again.enroll({ listener: 'unix' })
    expect(
      await body(await desktop.request('tasks', { method: 'POST', body: { prompt: 'x', requestId: randomUUID(), harnessId: 'outside' } })),
    ).toMatchObject({ error: 'workspace-inside-data' })
  })

  it('pushes a Host-level rename to the selected session and invalidates other subscribers', async () => {
    const t = await testHost()
    const admin = await t.enroll({ scopes: [...ADMIN] })
    const { sessionId } = await admin.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat' },
    })
    await settled(t, sessionId)
    const controller = new AbortController()
    cleanups.push(async () => controller.abort())
    const response = await admin.request(`events?sessionId=${sessionId}`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    let text = ''
    await admin.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title: '推送标题' } })
    await vi.waitFor(async () => {
      const next = await reader.read()
      text += new TextDecoder().decode(next.value)
      expect(text).toContain('推送标题')
    })
    const states = text
      .split('\n\n')
      .filter(block => block.includes('event: task-state'))
      .map(block => JSON.parse(block.split('data: ')[1]!) as { detail: TaskDetail })
    expect(states.at(-1)!.detail.summary).toMatchObject({ title: '推送标题', harnessId: 'standard' })
    expect(states.at(-1)!.detail.permission).toEqual({ level: 'L1', enforcer: 'LATCH', notes: [] })
  })
})

describe('projects of several folders', () => {
  /** Real directories under one temp root, by name. */
  async function folders(...names: string[]): Promise<{ root: string; paths: Record<string, string> }> {
    const root = await realpath(await temporaryDirectory('latch-folders-'))
    const paths: Record<string, string> = {}
    for (const name of names) {
      paths[name] = join(root, name)
      await mkdir(paths[name], { recursive: true })
    }
    return { root, paths }
  }

  async function projectOf(device: TestDevice, id: string): Promise<WorkspaceInfo> {
    const { workspaces } = await device.json<{ workspaces: WorkspaceInfo[] }>('workspaces')
    return workspaces.find(item => item.id === id)!
  }

  it('adds folders only from the desktop app over host.sock, with a fresh nonce signed over the exact body', async () => {
    let clock = Date.now()
    const t = await testHost({ tls: true, now: () => clock })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const phone = await t.enroll({ listener: 'tls', scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const other = await t.enroll({ listener: 'unix', name: 'Other desktop' })
    const { paths } = await folders('api', 'web', 'docs')
    const localOnly = { error: 'local-only' }
    for (const device of [browser, phone]) {
      expect(await body(await device.request('folder-grants', { method: 'POST', body: {} }))).toMatchObject(localOnly)
      // The older page's form posts a typed path; it cannot add anything any more.
      expect(await body(await device.request('workspaces', { method: 'POST', body: { path: paths.api } }))).toMatchObject(localOnly)
      expect(await body(await device.request('workspaces/x/folders', { method: 'POST', body: { paths: [paths.api] } }))).toMatchObject(
        localOnly,
      )
    }
    const invalid = { error: 'folder-grant-invalid' }
    // Unsigned, as a renderer request forwarded by an older desktop proxy would be.
    expect(await body(await desktop.request('workspaces', { method: 'POST', body: { path: paths.api } }))).toMatchObject(invalid)
    expect(await body(await desktop.addFolders({ paths: [paths.api], nonce: 'never-granted' }))).toMatchObject(invalid)
    // A nonce granted to another device.
    const foreign = await other.json<{ nonce: string; expiresAt: string }>('folder-grants', { method: 'POST', body: {} })
    expect(new Date(foreign.expiresAt).getTime()).toBe(clock + 60_000)
    expect(await body(await desktop.addFolders({ paths: [paths.api], nonce: foreign.nonce }))).toMatchObject(invalid)
    // A signature over a different body: the paths that would be added are not the ones the main process signed.
    expect(
      await body(await desktop.addFolders({ paths: [paths.api], signedBody: signed => ({ ...signed, paths: [paths.web] }) })),
    ).toMatchObject(invalid)
    // Expired.
    const late = await desktop.json<{ nonce: string }>('folder-grants', { method: 'POST', body: {} })
    clock += 61_000
    expect(await body(await desktop.addFolders({ paths: [paths.api], nonce: late.nonce }))).toMatchObject(invalid)
    expect(t.host.config.settings().workspaces).toEqual([])
    expect((await auditRecords(t)).some(record => record.action === 'workspace.added')).toBe(false)

    // At most four outstanding nonces per device: a fifth drops the oldest.
    const grants = []
    for (let index = 0; index < 5; index++)
      grants.push((await desktop.json<{ nonce: string }>('folder-grants', { method: 'POST', body: {} })).nonce)
    expect(await body(await desktop.addFolders({ paths: [paths.api], nonce: grants[0] }))).toMatchObject(invalid)
    const created = await desktop.addFolders({ paths: [paths.api, paths.web], name: '商城', via: 'drop', nonce: grants[4] })
    expect(created.status).toBe(201)
    expect(await body(created)).toMatchObject({
      workspace: {
        id: expect.any(String),
        name: '商城',
        path: paths.api,
        folders: [
          { id: 'api', path: paths.api },
          { id: 'web', path: paths.web },
        ],
      },
      refused: [],
    })
    // Single use.
    expect(await body(await desktop.addFolders({ paths: [paths.docs], nonce: grants[4] }))).toMatchObject(invalid)
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.added').map(record => record.detail)).toEqual([
      expect.objectContaining({ folderCount: 2, via: 'drop' }),
    ])
  })

  it('reports each path that did not join, adds to a project in order and never to the start directory', async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const { root, paths } = await folders('api/lib', 'web', 'docs', 'more/m1', 'more/m2', 'more/m3', 'more/m4', 'more/m5', 'more/m6')
    const created = await addProject(desktop, [join(root, 'api'), paths['api/lib'], paths.web, join(root, 'missing')], 'Shop')
    expect(created.workspace.folders).toEqual([
      { id: 'api', path: join(root, 'api') },
      { id: 'web', path: paths.web },
    ])
    expect(created.refused).toEqual([
      { path: paths['api/lib'], code: 'workspace-folder-overlap', message: '同一项目中的文件夹不能相同，也不能相互包含' },
      { path: join(root, 'missing'), code: 'workspace-invalid', message: '找不到这个文件夹' },
    ])
    const id = created.workspace.id
    const added = await desktop.addFolders({ projectId: id, paths: [paths.docs, paths.web] })
    expect(added.status).toBe(200)
    expect(await body(added)).toMatchObject({
      workspace: { folders: [{ id: 'api' }, { id: 'web' }, { id: 'docs', path: paths.docs }] },
      refused: [{ path: paths.web, code: 'workspace-folder-overlap' }],
    })
    const many = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(name => paths[`more/${name}`]!)
    expect(await body(await desktop.addFolders({ projectId: id, paths: many }))).toMatchObject({
      workspace: { folders: expect.toSatisfy((list: unknown[]) => list.length === 8) },
      refused: [{ path: many[5], code: 'workspace-folder-limit' }],
    })
    expect(await body(await desktop.addFolders({ projectId: id, paths: [join(root, 'more')] }))).toMatchObject({
      error: 'workspace-folders-refused',
      refused: [{ code: 'workspace-folder-limit' }],
    })
    expect(await body(await desktop.addFolders({ projectId: 'default', paths: [paths.docs] }))).toMatchObject({
      error: 'workspace-default',
    })
    expect(await body(await desktop.addFolders({ projectId: 'nope', paths: [paths.docs] }))).toMatchObject({ error: 'workspace-not-found' })
    const records = (await auditRecords(t)).filter(record => record.action === 'workspace.folder-added').map(record => record.detail)
    expect(records[0]).toEqual({
      workspaceId: id,
      folderId: 'docs',
      pathHash: sha256Hex(paths.docs),
      via: 'picker',
      replacesFolder: false,
    })
    expect(records).toHaveLength(6)

    const snapshot = await desktop.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog!.projectFolders).toEqual({ max: 8 })
    expect(snapshot.catalog!.workspaces[0]).toEqual({
      id: 'default',
      name: '默认文件夹',
      path: t.workspaceRoot,
      folders: [{ id: 'default', path: t.workspaceRoot }],
    })
  })

  it('audits folder grants first and saves nothing when that fails, while removals proceed and say the record is missing', async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const { paths } = await folders('api', 'web', 'docs')
    const { workspace } = await addProject(desktop, [paths.api, paths.web])
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const failing = vi.spyOn(t.host.security.audit, 'append').mockImplementation(async event => {
      if (event.action.startsWith('workspace.')) throw new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行')
      return append(event)
    })
    expect(await body(await desktop.addFolders({ projectId: workspace.id, paths: [paths.docs] }))).toMatchObject({
      error: 'audit-unavailable',
    })
    expect(await body(await browser.request(`workspaces/${workspace.id}`, { method: 'PATCH', body: { name: 'x' } }))).toMatchObject({
      error: 'audit-unavailable',
    })
    expect(t.host.config.settings().workspaces[0]!.folders).toHaveLength(2)
    const removed = await browser.request(`workspaces/${workspace.id}/folders/web`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(removed.headers.get('x-latch-audit')).toBe('failed')
    expect(t.host.config.settings().workspaces[0]!.folders.map(folder => folder.id)).toEqual(['api'])
    const dropped = await browser.request(`workspaces/${workspace.id}`, { method: 'DELETE' })
    expect(dropped.status).toBe(200)
    expect(dropped.headers.get('x-latch-audit')).toBe('failed')
    expect(t.host.config.settings().workspaces).toEqual([])
    failing.mockRestore()
  })

  it('renames, sets a glyph and reorders from any admin device, within the project rules', async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const { paths } = await folders('api', 'web', 'docs', 'other')
    const shop = (await addProject(desktop, [paths.api, paths.web, paths.docs], 'Shop')).workspace
    await addProject(desktop, [paths.other, paths.docs], 'Other')
    const patch = (input: unknown, id = shop.id) => browser.request(`workspaces/${id}`, { method: 'PATCH', body: input })
    expect(await body(await patch({ name: '商城', glyph: 'globe', order: ['web', 'api', 'docs'] }))).toMatchObject({
      workspace: { name: '商城', glyph: 'globe', path: paths.web, folders: [{ id: 'web' }, { id: 'api' }, { id: 'docs' }] },
    })
    expect(t.host.config.settings().workspaces[0]).toMatchObject({
      path: paths.web,
      folders: [{ id: 'web' }, { id: 'api' }, { id: 'docs' }],
    })
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.changed').map(record => record.detail)).toEqual([
      { workspaceId: shop.id, renamed: true, glyphChanged: true, primaryChanged: true, reordered: true },
    ])
    expect((await body(await patch({ glyph: null }))).workspace).not.toHaveProperty('glyph')
    expect(await body(await patch({ name: 'a\u202Eb' }))).toMatchObject({ error: 'workspace-folder-unprintable' })
    expect(await body(await patch({ order: ['web', 'api'] }))).toMatchObject({ error: 'workspace-order-invalid' })
    // docs is Other's other folder (allowed), not its primary folder; Other's primary may not become Shop's.
    expect(await body(await patch({ order: ['docs', 'web', 'api'] }))).toMatchObject({ workspace: { path: paths.docs } })
    expect(await body(await patch({ order: ['docs', 'other'] }, 'other'))).toMatchObject({ error: 'workspace-exists' })
    expect(await body(await patch({ name: 'x' }, 'default'))).toMatchObject({ error: 'workspace-default' })
    expect(await body(await patch({}))).toMatchObject({ error: 'invalid-input' })
  })

  it('keeps a primary folder saved before commas were refused out of the other positions', async () => {
    const root = await realpath(await temporaryDirectory())
    const dataDir = join(root, 'data')
    const comma = join(root, 'a,b')
    const plain = join(root, 'plain')
    await mkdir(comma)
    await mkdir(plain)
    await mkdir(dataDir, { mode: 0o700 })
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ version: 1, workspaces: [{ id: 'old', name: 'Old', path: comma }] }), {
      mode: 0o600,
    })
    const t = await testHost({ dataDir })
    const desktop = await t.enroll({ listener: 'unix' })
    expect((await projectOf(desktop, 'old')).unavailable).toBeUndefined()
    expect(await body(await desktop.addFolders({ projectId: 'old', paths: [plain] }))).toMatchObject({ workspace: { path: comma } })
    expect(await body(await desktop.request('workspaces/old', { method: 'PATCH', body: { order: ['plain', 'a-b'] } }))).toMatchObject({
      error: 'workspace-folder-chars',
    })
  })

  it('records the project on its sessions, replaces a folder in place and stops the sessions that used it', async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const { paths } = await folders('api', 'web', 'api-new')
    const { workspace } = await addProject(desktop, [paths.api, paths.web])
    const start = (workspaceId: string) =>
      desktop.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat', workspaceId },
      })
    const { sessionId } = await start(workspace.id)
    await settled(t, sessionId)
    expect((await t.host.bridge.detail(sessionId)).summary).toMatchObject({ cwd: paths.api, workspaceId: workspace.id })
    const meta = JSON.parse(await readFile(join(t.dataDir, 'sessions-meta.json'), 'utf8')) as { sessions: unknown[] }
    // Other features add their own fields to a session's record; this case is about the project it records.
    expect(meta.sessions).toContainEqual(expect.objectContaining({ id: sessionId, workspaceId: workspace.id }))
    const inDefault = await start('default')
    await settled(t, inDefault.sessionId)
    expect((await t.host.bridge.detail(inDefault.sessionId)).summary.workspaceId).toBe('default')

    const replaced = await desktop.addFolders({ projectId: workspace.id, paths: [paths['api-new']], replace: 'api' })
    expect(await body(replaced)).toMatchObject({
      workspace: { path: paths['api-new'], folders: [{ id: 'api', path: paths['api-new'] }, { id: 'web' }] },
      refused: [],
    })
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.folder-added').map(record => record.detail)).toEqual([
      { workspaceId: workspace.id, folderId: 'api', pathHash: sha256Hex(paths['api-new']), via: 'picker', replacesFolder: true },
    ])
    const prompt = (id: string) =>
      desktop.request(`tasks/${id}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    expect(await body(await prompt(sessionId))).toMatchObject({ error: 'workspace-changed' })
    expect((await prompt(inDefault.sessionId)).status).toBe(200)
    await settled(t, inDefault.sessionId)
    const fresh = await start(workspace.id)
    await settled(t, fresh.sessionId)
    expect((await t.host.bridge.detail(fresh.sessionId)).summary.cwd).toBe(paths['api-new'])
  })

  it('refuses removing a folder or project that a waiting session uses, and the last folder', async () => {
    const t = await testHost({ demo: false, providerId: 'scripted', plugins: [scripted('write_file', { path: 'a.txt', content: 'x' })] })
    const desktop = await t.enroll({ listener: 'unix' })
    const { paths } = await folders('api', 'web')
    const { workspace } = await addProject(desktop, [paths.api, paths.web])
    const sessionId = await startTask(desktop, 'write a file', { workspaceId: workspace.id })
    const approval = await pendingApproval(t, sessionId)
    const remove = (path: string) => desktop.request(path, { method: 'DELETE' })
    expect(await body(await remove(`workspaces/${workspace.id}/folders/api`))).toMatchObject({ error: 'workspace-in-use' })
    expect(await body(await remove(`workspaces/${workspace.id}`))).toMatchObject({ error: 'workspace-in-use' })
    // A Standard session records every folder of its project, so none of them may go while it waits.
    expect(await body(await remove(`workspaces/${workspace.id}/folders/web`))).toMatchObject({ error: 'workspace-in-use' })
    await desktop.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject' } })
    await settled(t, sessionId)
    expect((await remove(`workspaces/${workspace.id}/folders/web`)).status).toBe(200)
    expect(await body(await remove(`workspaces/${workspace.id}/folders/api`))).toMatchObject({ error: 'workspace-last-folder' })
    expect(await body(await remove(`workspaces/${workspace.id}/folders/nope`))).toMatchObject({ error: 'workspace-folder-not-found' })
    expect((await remove(`workspaces/${workspace.id}`)).status).toBe(200)
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.folder-removed').map(record => record.detail)).toEqual([
      { workspaceId: workspace.id, folderId: 'web', pathHash: sha256Hex(paths.web) },
    ])
  })

  /** A model that calls the given tools one after another, then answers "done". */
  function steps(calls: Array<{ name: string; arguments: Record<string, unknown> }>): HarnessPlugin {
    const provider: ModelProvider = {
      id: 'scripted',
      name: 'Scripted',
      model: 'scripted',
      async *stream({ messages }) {
        const next = calls[messages.filter(message => message.role === 'tool').length]
        if (next) yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...next } }
        else yield { type: 'text', text: 'done' }
        yield { type: 'finish', reason: next ? 'tool-calls' : 'stop' }
      },
    }
    return { id: 'scripted', name: 'Scripted', version: '1', description: 'fixture', activate: ctx => ctx.registerProvider(provider) }
  }

  it('gives a Latch 内置 session every folder of its project: it lists them by name and writes in the second at R1', async () => {
    const t = await testHost({
      demo: false,
      providerId: 'scripted',
      plugins: [
        steps([
          { name: 'list_folders', arguments: {} },
          { name: 'write_file', arguments: { path: 'index.html', content: '<p>shop</p>', folder: 'web' } },
        ]),
      ],
    })
    const desktop = await t.enroll({ listener: 'unix' })
    const { root, paths } = await folders('api', 'web')
    const { workspace } = await addProject(desktop, [paths.api, paths.web], 'Shop')
    const snapshot = await desktop.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog!.harnesses.find(item => item.id === 'standard')!.projectFolders).toEqual({ access: 'all' })
    const sessionId = await startTask(desktop, 'build the page', { workspaceId: workspace.id })
    const approval = await pendingApproval(t, sessionId)
    expect(approval).toMatchObject({ risk: 'R1', toolName: 'write_file', tool: { title: '写入「web」中的 index.html' } })
    const detail = await t.host.bridge.detail(sessionId)
    expect(detail.summary).toMatchObject({
      cwd: paths.api,
      workspaceId: workspace.id,
      folders: [
        { id: 'api', path: paths.api },
        { id: 'web', path: paths.web },
      ],
    })
    const listing = detail.messages.find(message => message.toolName === 'list_folders')!
    expect(JSON.parse(listing.text)).toEqual([
      { folder: 'api', name: 'api', primary: true },
      { folder: 'web', name: 'web', primary: false },
    ])
    expect(listing.text).not.toContain(root)
    await desktop.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', optionId: 'allow_once' } })
    await settled(t, sessionId)
    expect(await readFile(join(paths.web, 'index.html'), 'utf8')).toBe('<p>shop</p>')
    await expect(stat(join(paths.api, 'index.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to allow a waiting call once a folder of the session is missing, and still lets it be rejected', async () => {
    const t = await testHost({
      demo: false,
      providerId: 'scripted',
      plugins: [steps([{ name: 'write_file', arguments: { path: 'a.txt', content: 'x', folder: 'web' } }])],
    })
    const desktop = await t.enroll({ listener: 'unix' })
    const { root, paths } = await folders('api', 'web')
    const { workspace } = await addProject(desktop, [paths.api, paths.web])
    const sessionId = await startTask(desktop, 'write', { workspaceId: workspace.id })
    const approval = await pendingApproval(t, sessionId)
    await move(paths.web, join(root, 'moved'))
    const decide = (decision: string) => desktop.request(`approvals/${approval.id}`, { method: 'POST', body: { decision } })
    expect(await body(await decide('allow'))).toMatchObject({ error: 'workspace-changed' })
    expect((await decide('reject')).status).toBe(200)
    await settled(t, sessionId)
    await expect(stat(join(root, 'moved', 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('notices a missing folder within the cache window, refuses new sessions at once, and recovers', async () => {
    let clock = Date.now()
    const t = await testHost({ now: () => clock })
    const desktop = await t.enroll({ listener: 'unix' })
    const { root, paths } = await folders('api', 'web')
    const { workspace } = await addProject(desktop, [paths.api, paths.web])
    const start = () =>
      desktop.request('tasks', { method: 'POST', body: { prompt: 'x', requestId: randomUUID(), mode: 'chat', workspaceId: workspace.id } })
    await move(paths.web, join(root, 'moved'))
    // Listings reuse the last check for up to 5 s; a session start always checks again.
    expect((await projectOf(desktop, workspace.id)).unavailable).toBeUndefined()
    expect(await body(await start())).toMatchObject({ error: 'workspace-disabled' })
    clock += 6_000
    expect(await projectOf(desktop, workspace.id)).toMatchObject({
      unavailable: '文件夹「web」：找不到这个文件夹',
      folders: [{ id: 'api' }, { id: 'web', unavailable: '找不到这个文件夹' }],
    })
    const snapshot = await desktop.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog!.workspaces.find(item => item.id === workspace.id)?.unavailable).toBe('文件夹「web」：找不到这个文件夹')
    await move(join(root, 'moved'), paths.web)
    clock += 6_000
    expect((await projectOf(desktop, workspace.id)).unavailable).toBeUndefined()
    expect((await start()).status).toBe(201)
    // Audited once per change to unusable.
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.disabled').map(record => record.detail)).toEqual([
      { workspaceId: workspace.id, reason: 'missing', folderIndex: 1 },
    ])
  })

  it('disables a project whose path no longer mirrors its primary folder after a hand edit, and keeps it listed', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    const { paths } = await folders('api', 'web')
    const first = await testHost({ dataDir })
    const { workspace } = await addProject(await first.enroll({ listener: 'unix' }), [paths.api, paths.web])
    await first.close()
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8')) as { workspaces: Array<{ id: string; path: string }> }
    settings.workspaces.find(item => item.id === workspace.id)!.path = paths.web
    await writeFile(file, JSON.stringify(settings), { mode: 0o600 })

    // Only a hand edit produces this; the Host fails closed for the run rather than guess which folder is primary.
    const t = await testHost({ dataDir })
    const desktop = await t.enroll({ listener: 'unix' })
    const reason = '这个项目的主文件夹配置不一致，请在这台 Mac 上重新选择主文件夹'
    expect(await projectOf(desktop, workspace.id)).toMatchObject({ path: paths.web, unavailable: reason })
    expect(
      await body(
        await desktop.request('tasks', {
          method: 'POST',
          body: { prompt: 'x', requestId: randomUUID(), mode: 'chat', workspaceId: workspace.id },
        }),
      ),
    ).toMatchObject({ error: 'workspace-disabled', message: expect.stringContaining(reason) })
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.disabled').map(record => record.detail)).toEqual([
      { workspaceId: workspace.id, reason: 'invalid' },
    ])
    expect((await desktop.request(`workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it.skipIf(process.getuid?.() === 0)('refuses a folder the Host cannot open, at add and at session start', async () => {
    const t = await testHost()
    const desktop = await t.enroll({ listener: 'unix' })
    const { paths } = await folders('api', 'locked', 'later')
    cleanups.push(async () => {
      await chmod(paths.locked, 0o700)
      await chmod(paths.later, 0o700)
    })
    await chmod(paths.locked, 0o000)
    const created = await addProject(desktop, [paths.api, paths.locked, paths.later])
    expect(created.refused).toEqual([{ path: paths.locked, code: 'workspace-permission', message: expect.any(String) }])
    await chmod(paths.later, 0o000)
    // Listings never open folders (no privacy prompt while nobody is at the computer); a session start does.
    expect((await projectOf(desktop, created.workspace.id)).unavailable).toBeUndefined()
    expect(
      await body(
        await desktop.request('tasks', {
          method: 'POST',
          body: { prompt: 'x', requestId: randomUUID(), mode: 'chat', workspaceId: created.workspace.id },
        }),
      ),
    ).toMatchObject({ error: 'workspace-disabled', message: expect.stringContaining('文件夹「later」：') })
  })

  it("flags a start directory inside Latch's program directory, which the Host never picks on its own", async () => {
    const root = await realpath(await temporaryDirectory())
    await mkdir(join(root, 'repo'))
    const t = await testHost({ workspaceRoot: join(root, 'repo'), codeRoot: root })
    const desktop = await t.enroll({ listener: 'unix' })
    expect(await projectOf(desktop, 'default')).toEqual({
      id: 'default',
      name: '默认文件夹',
      path: join(root, 'repo'),
      folders: [{ id: 'default', path: join(root, 'repo') }],
      codeRoot: true,
    })
  })

  it('refuses to start while the TLS key lies inside any folder of a project', async () => {
    const root = await realpath(await temporaryDirectory())
    const dataDir = join(root, 'data')
    const { paths } = await folders('api', 'secrets')
    const tls = await makeTestTls(join(paths.secrets, 'tls'))
    const first = await testHost({ dataDir })
    await addProject(await first.enroll({ listener: 'unix' }), [paths.api, paths.secrets])
    await first.close()
    const port = await freeTcpPort()
    await expect(
      startTestHost({
        dataDir,
        tls: { host: '127.0.0.1', port, certPath: tls.certPath, keyPath: tls.keyPath, publicOrigin: `https://${tls.hostname}:${port}` },
      }),
    ).rejects.toMatchObject({ code: 'private-file-insecure' })
  })
})

describe('sessions in folders of their own', () => {
  const OWN = /^\d{8}-[0-9a-f]{4}$/u

  /** The session folders the Host made in the start directory. */
  async function ownFolders(t: TestHost): Promise<string[]> {
    return (await readdir(t.workspaceRoot)).filter(name => OWN.test(name)).toSorted()
  }

  async function summaryOf(t: TestHost, sessionId: string): Promise<TaskSummary> {
    return (await t.host.bridge.detail(sessionId)).summary
  }

  async function prompt(device: TestDevice, t: TestHost, sessionId: string): Promise<string> {
    const response = await device.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'again', requestId: randomUUID() },
    })
    if (response.ok) await settled(t, sessionId)
    return response.ok ? 'ok' : ((await body(response)) as { error: string }).error
  }

  it('gives each Agent session outside a project a new 0700 folder in the default start directory, and never a 只对话 session', async () => {
    const t = await testHost({ sessionFolders: true })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    expect((await browser.json<AppSnapshot>('snapshot')).catalog).toMatchObject({ sessionFolders: true })

    // Two report sessions no longer write into one shared folder.
    const sessions = [
      await startTask(browser, '生成需要审批的报告'),
      await startTask(browser, '生成需要审批的报告', { workspaceId: 'default' }),
    ]
    for (const sessionId of sessions) {
      const approval = await pendingApproval(t, sessionId)
      expect((await browser.request(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow' } })).status).toBe(200)
      await settled(t, sessionId)
    }
    const names = await ownFolders(t)
    expect(names).toHaveLength(2)
    for (const [index, sessionId] of sessions.entries()) {
      const summary = await summaryOf(t, sessionId)
      expect(summary).toMatchObject({ workspaceId: 'default', sessionFolder: true })
      expect(summary.folders).toBeUndefined()
      expect(names).toContain(summary.cwd!.slice(t.workspaceRoot.length + 1))
      expect(summary.cwd).toBe(join(t.workspaceRoot, summary.cwd!.slice(t.workspaceRoot.length + 1)))
      expect((await stat(summary.cwd!)).mode & 0o777).toBe(0o700)
      expect(await readdir(join(summary.cwd!, 'artifacts'))).toEqual([`report-${sessionId}.txt`])
      const snapshot = await browser.json<AppSnapshot>('snapshot')
      expect(snapshot.tasks.find(task => task.id === sessionId)).toMatchObject({ sessionFolder: true, cwd: summary.cwd })
      expect(index === 0 || summary.cwd !== (await summaryOf(t, sessions[0]!)).cwd).toBe(true)
    }
    expect(await readdir(t.workspaceRoot)).toEqual(expect.not.arrayContaining(['artifacts']))

    // 只对话 reads and writes no files: it works where it did before and gets no folder.
    const chat = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hi', requestId: randomUUID(), mode: 'chat' },
    })
    await settled(t, chat.sessionId)
    expect(await summaryOf(t, chat.sessionId)).not.toHaveProperty('sessionFolder')
    // A saved project's sessions start in its primary folder, as before.
    const project = await realpath(await temporaryDirectory('latch-project-'))
    const { workspace } = await addProject(desktop, [project], 'Shop')
    const inProject = await startTask(desktop, 'hello', { workspaceId: workspace.id })
    await settled(t, inProject)
    expect(await summaryOf(t, inProject)).toMatchObject({ cwd: project, workspaceId: workspace.id })
    expect(await summaryOf(t, inProject)).not.toHaveProperty('sessionFolder')
    expect(await ownFolders(t)).toEqual(names)
    // A session continues in its folder.
    expect(await prompt(browser, t, sessions[0]!)).toBe('ok')
  })

  it('keeps a start directory the owner named, as before', async () => {
    const t = await testHost()
    const browser = await t.enroll({ scopes: [...ADMIN] })
    expect((await browser.json<AppSnapshot>('snapshot')).catalog).not.toHaveProperty('sessionFolders')
    const sessionId = await startTask(browser, 'hello')
    await settled(t, sessionId)
    const explicit = await startTask(browser, 'hello', { workspaceId: 'default' })
    await settled(t, explicit)
    for (const id of [sessionId, explicit]) {
      expect((await summaryOf(t, id)).cwd).toBe(t.workspaceRoot)
      expect(await summaryOf(t, id)).not.toHaveProperty('sessionFolder')
    }
    expect(await ownFolders(t)).toEqual([])
  })

  it('never reuses an existing entry and gives a retried request its folder again', async () => {
    const suffixes = ['abcd', 'abcd', 'beef', 'cafe']
    const t = await testHost({
      sessionFolders: true,
      clock: () => new Date(2026, 9, 25, 12).getTime(),
      sessionFolderSuffix: () => suffixes.shift() ?? 'ffff',
    })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    await mkdir(join(t.workspaceRoot, '20261025-abcd'))
    await writeFile(join(t.workspaceRoot, '20261025-abcd', 'mine.txt'), 'the owner made this')
    const request = { prompt: 'hello', requestId: randomUUID(), mode: 'agent' }
    const first = await browser.json<{ sessionId: string }>('tasks', { method: 'POST', body: request })
    await settled(t, first.sessionId)
    expect((await summaryOf(t, first.sessionId)).cwd).toBe(join(t.workspaceRoot, '20261025-beef'))
    expect(await readdir(join(t.workspaceRoot, '20261025-abcd'))).toEqual(['mine.txt'])
    // The same request again: the same session, and no new folder.
    expect(await browser.json('tasks', { method: 'POST', body: request })).toEqual(first)
    expect(await ownFolders(t)).toEqual(['20261025-abcd', '20261025-beef'])
    // The driver refuses the start (a different prompt under a used request ID): the session's folder stays.
    expect(await body(await browser.request('tasks', { method: 'POST', body: { ...request, prompt: 'other' } }))).toMatchObject({
      error: 'request-conflict',
    })
    expect(await ownFolders(t)).toEqual(['20261025-abcd', '20261025-beef'])
    // Another device naming the same request ID never gets that session's folder; its own goes when the driver refuses.
    const other = await t.enroll({ scopes: [...ADMIN] })
    expect(await body(await other.request('tasks', { method: 'POST', body: request }))).toMatchObject({ error: 'request-conflict' })
    expect(await ownFolders(t)).toEqual(['20261025-abcd', '20261025-beef'])
    // A refused start makes no folder at all.
    expect(
      await body(
        await browser.request('tasks', {
          method: 'POST',
          body: { prompt: 'hello', requestId: randomUUID(), mode: 'agent', model: { providerId: 'missing', model: 'x' } },
        }),
      ),
    ).toMatchObject({ error: expect.any(String) })
    expect(await ownFolders(t)).toEqual(['20261025-abcd', '20261025-beef'])
  })

  it('removes the empty folder of a start that created no session, at once when the driver refuses', async () => {
    const { plugin, createTask } = launchedHarness()
    const t = await testHost({ sessionFolders: true, plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const start = (requestId = randomUUID()) =>
      desktop.request('tasks', { method: 'POST', body: { prompt: 'start', requestId, mode: 'agent', harnessId: 'launched' } })
    createTask.mockRejectedValueOnce(new AppError(409, 'agent-definition-changed', 'Agent 定义已变化'))
    expect(
      (
        await desktop.confirmed('tasks', {
          method: 'POST',
          body: { prompt: 'x', requestId: randomUUID(), mode: 'agent', harnessId: 'launched' },
        })
      ).status,
    ).toBe(409)
    expect(createTask).toHaveBeenCalledTimes(1)
    expect(createTask.mock.calls[0]![0]).toMatchObject({ cwd: expect.stringMatching(/\/\d{8}-[0-9a-f]{4}$/u) })
    expect(await ownFolders(t)).toEqual([])
  })

  it('keeps a session in its folder across restarts and stops it once the folder is gone or replaced by a link', async () => {
    const root = await realpath(await temporaryDirectory())
    const dirs = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    const first = await testHost({ ...dirs, sessionFolders: true })
    const sessionId = await startTask(await first.enroll({ scopes: [...ADMIN] }), 'hello')
    await settled(first, sessionId)
    const cwd = (await summaryOf(first, sessionId)).cwd!
    await first.close()
    // A restart with a start directory the owner names keeps the sessions already in their folders inside it.
    const second = await testHost({ ...dirs })
    const browser = await second.enroll({ scopes: [...ADMIN] })
    expect(await summaryOf(second, sessionId)).toMatchObject({ cwd, workspaceId: 'default', sessionFolder: true })
    expect(await prompt(browser, second, sessionId)).toBe('ok')
    await move(cwd, join(root, 'moved'))
    await symlink(join(root, 'moved'), cwd)
    expect(await prompt(browser, second, sessionId)).toBe('workspace-changed')
    await rm(cwd)
    expect(await prompt(browser, second, sessionId)).toBe('workspace-changed')
    await move(join(root, 'moved'), cwd)
    expect(await prompt(browser, second, sessionId)).toBe('ok')
  })

  it('starts a full-access agent in a folder of its own', async () => {
    const t = await testHost({
      sessionFolders: true,
      agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
    })
    const desktop = await t.enroll({ listener: 'unix' })
    const state = join(t.root, 'acp-state.json')
    const created = await desktop.confirmed('agents', {
      method: 'POST',
      body: { id: 'fake', name: 'Fake agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_STATE: state } },
    })
    expect(created.status).toBe(201)
    const sessionId = await startTask(desktop, 'hello', { harnessId: 'fake' })
    await settled(t, sessionId)
    const [name] = await ownFolders(t)
    expect(await ownFolders(t)).toEqual([name])
    expect(await summaryOf(t, sessionId)).toMatchObject({ workspaceId: 'default', sessionFolder: true })
    const recorded = Object.values(JSON.parse(await readFile(state, 'utf8')) as Record<string, { cwd: string }>).map(item => item.cwd)
    expect(recorded.map(path => basename(path))).toEqual([name])
    expect(await prompt(desktop, t, sessionId)).toBe('ok')
  })

  it('saves a session folder as a project only from the desktop, signed, audited first, and once', async () => {
    const t = await testHost({ sessionFolders: true, tls: true })
    const browser = await t.enroll({ scopes: [...ADMIN] })
    const phone = await t.enroll({ listener: 'tls', scopes: [...ADMIN] })
    const desktop = await t.enroll({ listener: 'unix' })
    const sessionId = await startTask(browser, 'Landing page 改版')
    await settled(t, sessionId)
    const cwd = (await summaryOf(t, sessionId)).cwd!
    const name = basename(cwd)
    const save = { nonce: 'x', via: 'session', sessionId }
    for (const device of [browser, phone])
      expect(await body(await device.request('workspaces', { method: 'POST', body: save }))).toMatchObject({ error: 'local-only' })
    const invalid = { error: 'folder-grant-invalid' }
    expect(await body(await desktop.request('workspaces', { method: 'POST', body: save }))).toMatchObject(invalid)
    const other = await startTask(browser, 'hello')
    await settled(t, other)
    // The main process signed another session than the one the request names.
    expect(
      await body(await desktop.saveSessionFolder({ sessionId, signedBody: signed => ({ ...signed, sessionId: other }) })),
    ).toMatchObject(invalid)
    // A path in place of the session is not part of this request.
    expect(await body(await desktop.saveSessionFolder({ sessionId, signedBody: signed => ({ ...signed, paths: [cwd] }) }))).toMatchObject(
      invalid,
    )
    expect(t.host.config.settings().workspaces).toEqual([])

    const audit = t.host.security.audit
    const append = audit.append.bind(audit)
    const failing = vi
      .spyOn(audit, 'append')
      .mockImplementation(event =>
        event.action === 'workspace.added'
          ? Promise.reject(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行'))
          : append(event),
      )
    expect(await body(await desktop.saveSessionFolder({ sessionId }))).toMatchObject({ error: 'audit-unavailable' })
    expect(t.host.config.settings().workspaces).toEqual([])
    failing.mockRestore()

    const saved = await desktop.saveSessionFolder({ sessionId })
    expect(saved.status).toBe(201)
    const real = await realpath(cwd)
    expect(await body(saved)).toMatchObject({
      workspace: { id: name, name: 'Landing page 改版', path: real, folders: [{ id: name, path: real }] },
      refused: [],
    })
    expect((await auditRecords(t)).filter(record => record.action === 'workspace.added').map(record => record.detail)).toEqual([
      { workspaceId: name, pathHash: sha256Hex(real), folderCount: 1, foldersHash: sha256Hex(canonicalJson([real])), via: 'session' },
    ])
    // The session keeps the project it started in, and new sessions in the project start in its folder.
    expect(await summaryOf(t, sessionId)).toMatchObject({ workspaceId: 'default', sessionFolder: true, cwd })
    expect(await prompt(browser, t, sessionId)).toBe('ok')
    const inProject = await startTask(browser, 'hello', { workspaceId: name })
    await settled(t, inProject)
    expect(await summaryOf(t, inProject)).toMatchObject({ workspaceId: name, cwd: real })
    expect(await summaryOf(t, inProject)).not.toHaveProperty('sessionFolder')

    // Once: the folder is a project's primary folder now.
    expect(await body(await desktop.saveSessionFolder({ sessionId }))).toMatchObject({
      error: 'workspace-folders-refused',
      refused: [{ path: cwd, code: 'workspace-exists' }],
    })
    // Sessions without a folder of their own, and sessions that do not exist.
    const chat = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hi', requestId: randomUUID(), mode: 'chat' },
    })
    await settled(t, chat.sessionId)
    for (const id of [chat.sessionId, inProject])
      expect(await body(await desktop.saveSessionFolder({ sessionId: id }))).toMatchObject({ error: 'session-folder-none' })
    expect(await body(await desktop.saveSessionFolder({ sessionId: 'task-missing' }))).toMatchObject({ error: 'task-not-found' })
    expect(t.host.config.settings().workspaces.map(record => record.id)).toEqual([name])
  })
})
