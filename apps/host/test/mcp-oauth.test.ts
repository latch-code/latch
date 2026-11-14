import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpHttpServerView, McpServersResponse } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import {
  FAKE_ACP_AGENT,
  startFakeMcpHttp,
  startFakeOAuth,
  type FakeMcpHttp,
  type FakeMcpHttpOptions,
  type FakeOAuth,
  type FakeOAuthOptions,
  type TestDevice,
} from '@latch/testkit'
import { createEgressFetch } from '../src/egress.ts'
import { McpRemoteSession } from '../src/mcp-remote.ts'
import { canonicalJson, redactKnownSecrets, sha256Hex } from '@latch/core/node-kit'
import { httpSpecHash, isConfirmed, McpStore, oauthAddress, oauthToken, oauthWidens } from '../src/mcp.ts'
import { CALLBACK_TEXT, McpOAuth, metadataAddresses } from '../src/mcp-oauth.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

// Several cases start a Host for each variant they try.
vi.setConfig({ testTimeout: 60_000 })

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type AuditRecord = { action: string; stepup: string; target?: string; detail: Record<string, unknown> }
async function audit(t: TestHost): Promise<AuditRecord[]> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

function failAudit(t: TestHost, failing: (action: string) => boolean) {
  const append = t.host.security.audit.append.bind(t.host.security.audit)
  const spy = vi
    .spyOn(t.host.security.audit, 'append')
    .mockImplementation(event =>
      failing(event.action) ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
  cleanups.push(() => spy.mockRestore())
  return spy
}

interface World {
  t: TestHost
  desktop: TestDevice
  browser: TestDevice
  auth: FakeOAuth
  mcp: FakeMcpHttp
  /** What the server says about its login; a test may change it. */
  protect: NonNullable<FakeMcpHttpOptions['protect']>
  id: string
  logs: string[]
  /** Everything the Host sent the browser's event stream so far. */
  frames: () => string
}

async function world(
  options: {
    auth?: FakeOAuthOptions
    protect?: Partial<NonNullable<FakeMcpHttpOptions['protect']>>
    mcp?: FakeMcpHttpOptions
    host?: Parameters<typeof startTestHost>[0]
    headers?: Record<string, string>
  } = {},
): Promise<World> {
  const auth = await startFakeOAuth(options.auth)
  cleanups.push(() => auth.close())
  const protect = { issuer: auth.issuer, valid: (token: string) => auth.valid(token), scopes: ['mcp.read'], ...options.protect }
  const mcp = await startFakeMcpHttp({ keepHeaders: ['authorization'], ...options.mcp, protect })
  cleanups.push(() => mcp.close())
  const logs: string[] = []
  const t = await startTestHost({ demo: false, log: text => logs.push(text), ...options.host })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
  const stop = new AbortController()
  cleanups.push(() => stop.abort())
  let seen = ''
  const stream = await browser.request('events', { signal: stop.signal })
  void (async () => {
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) break
      seen += decoder.decode(next.value, { stream: true })
    }
  })()
  const { server } = await desktop.confirmedJson<{ server: McpHttpServerView }>('mcp/servers', {
    body: {
      requestId: randomUUID(),
      baseRevision: 0,
      transport: 'http',
      name: 'oauth',
      url: mcp.url,
      headers: options.headers ?? {},
      scope: { all: true, agents: [], projects: [] },
    },
  })
  return { t, desktop, browser, auth, mcp, protect, id: server.id, logs, frames: () => seen }
}

interface Started {
  authorizationUrl: string
  until: string
  server: McpHttpServerView
}
const start = (w: World, extra: Record<string, unknown> = {}) =>
  w.desktop.confirmedJson<Started>(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID(), ...extra } })
const refused = (w: World, extra: Record<string, unknown> = {}) =>
  w.desktop.confirmed(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID(), ...extra } }).then(async response => ({
    status: response.status,
    body: (await response.json()) as { error: string; message: string },
  }))

async function view(w: World, device: TestDevice = w.desktop): Promise<McpHttpServerView> {
  const list = await device.json<McpServersResponse>('mcp/servers')
  return list.servers.find(server => server.id === w.id) as McpHttpServerView
}
const settled = (w: World, state: string) => vi.waitFor(async () => expect((await view(w)).oauth?.state).toBe(state), { timeout: 5000 })

/** The person's browser: logs in at the fake authorization server and comes back to the Host's listener. */
async function comeBack(w: World, started: Started, change?: (callback: URL) => void): Promise<Response> {
  return fetch(await w.auth.authorize(started.authorizationUrl, change))
}
async function signIn(w: World, extra: Record<string, unknown> = {}): Promise<Started> {
  const started = await start(w, extra)
  const page = await comeBack(w, started)
  expect(page.status).toBe(200)
  await settled(w, 'signed-in')
  return started
}
const test = (w: World) =>
  w.desktop.json<{ status: string; reason?: string; tools?: string[] }>(`mcp/servers/${w.id}/test`, { body: { requestId: randomUUID() } })
const bearer = (w: World) => w.mcp.requests.flatMap(request => (request.headers.authorization ? [request.headers.authorization] : []))
const secretsFile = (t: TestHost) => readFile(join(t.dataDir, 'mcp', 'secrets.json'), 'utf8')

describe('a login’s definition', () => {
  it('hashes a server without a login as before, and treats another authorization server or a new scope as wider', () => {
    const plain = { url: 'https://a.b/mcp', headerNames: ['X-Key'] }
    expect(httpSpecHash(plain)).toBe(httpSpecHash({ ...plain, oauth: undefined }))
    const oauth = { issuer: 'https://auth.b', scopes: ['read', 'write'], resource: 'https://a.b/mcp' }
    // A definition from before logins hashes exactly as it did (the value below is of the old shape alone).
    expect(httpSpecHash(plain)).toBe(sha256Hex(canonicalJson({ transport: 'http', url: plain.url, headerNames: plain.headerNames })))
    expect(httpSpecHash({ ...plain, oauth })).not.toBe(httpSpecHash({ ...plain, oauth: { ...oauth, resource: 'https://a.b' } }))
    expect(oauthWidens(oauth, { ...oauth, resource: 'https://a.b' })).toBe(true)
    expect(httpSpecHash({ ...plain, oauth })).not.toBe(httpSpecHash(plain))
    expect(httpSpecHash({ ...plain, oauth })).toBe(httpSpecHash({ ...plain, oauth: { ...oauth, scopes: ['write', 'read'] } }))
    const confirmed = { hash: httpSpecHash({ ...plain, oauth }), secretNames: ['X-Key'] }
    expect(isConfirmed({ transport: 'http', ...plain, oauth, confirmed })).toBe(true)
    expect(isConfirmed({ transport: 'http', ...plain, oauth: { ...oauth, issuer: 'https://evil.b' }, confirmed })).toBe(false)
    expect(isConfirmed({ transport: 'http', ...plain, oauth: { ...oauth, scopes: ['read', 'write', 'admin'] }, confirmed })).toBe(false)
    expect(oauthWidens(undefined, oauth)).toBe(true)
    expect(oauthWidens(oauth, { ...oauth, scopes: ['read'] })).toBe(false)
    expect(oauthWidens(oauth, { ...oauth, scopes: ['read', 'admin'] })).toBe(true)
    expect(oauthWidens(oauth, { ...oauth, issuer: 'https://other.b', scopes: [] })).toBe(true)
    // What an authorization server may hand out as a token: token68, 20 characters or more; never an ordinary word.
    for (const token of ['fake-access-0123456789abcdef', 'abcDEF0123456789._~+/-==', 'x'.repeat(20)])
      expect(oauthToken.safeParse(token).success, token).toBe(true)
    for (const token of [
      'requiresApproval',
      'x'.repeat(19),
      'has space in it 0123456789',
      'tab\there0123456789012345',
      '中文令牌0123456789012345678',
      '',
    ])
      expect(oauthToken.safeParse(token).success, token).toBe(false)
    expect(oauthWidens(oauth, undefined)).toBe(false)
  })

  it('takes an authorization server’s addresses only as https or this Mac’s loopback, and looks for metadata where the specs say', () => {
    expect(oauthAddress('https://auth.example.com/tenant')).toBe('https://auth.example.com/tenant')
    expect(oauthAddress('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
    for (const bad of [
      'http://auth.example.com',
      'http://10.0.0.5:9000',
      'https://u:p@auth.example.com',
      'https://a.b/#x',
      'ftp://a.b',
      'javascript:1',
    ])
      expect(oauthAddress(bad), bad).toBeUndefined()
    expect(oauthAddress('https://a.b/token?x=1')).toBeUndefined()
    expect(oauthAddress('https://a.b/token?x=1', true)).toBe('https://a.b/token?x=1')
    expect(metadataAddresses('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ])
    expect(metadataAddresses('https://auth.example.com/tenant')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
      'https://auth.example.com/.well-known/openid-configuration/tenant',
      'https://auth.example.com/tenant/.well-known/openid-configuration',
    ])
  })
})

describe('登录 of a remote MCP server', () => {
  it('confirms the authorization server and scopes before anything goes to it, logs in with PKCE and resource, and keeps tokens on this Mac only', async () => {
    const w = await world({ host: { tls: true } })
    expect((await test(w)).reason).toBe('auth-required')
    expect((await view(w, w.browser)).oauth).toEqual({ state: 'signed-out' })
    // A phone (the TLS listener) or a browser on this Mac's loopback may look, never log in or out.
    const phone = await w.t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    for (const device of [phone, w.browser])
      for (const path of ['login', 'logout']) {
        const far = await device.request(`mcp/servers/${w.id}/oauth/${path}`, { body: { requestId: randomUUID() } })
        expect(far.status).toBe(403)
        expect(((await far.json()) as { error: string }).error).toBe('local-only')
      }
    expect(w.mcp.requests.filter(request => request.method === 'GET')).toEqual([])
    const body = { requestId: randomUUID() }
    const asked = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body })
    expect(asked.status).toBe(403)
    const ticket = ((await asked.json()) as { confirmation: any }).confirmation
    const target = new URL(w.auth.origin).host
    expect(ticket).toMatchObject({ action: 'mcp.server.apply', form: 'mcp.server.apply-remote' })
    expect(ticket.reason).toBe(`让 Latch 连接 ${target}（MCP 服务器「oauth」）`)
    expect(ticket.lines).toEqual(
      expect.arrayContaining([
        { label: '授权服务器', value: w.auth.origin },
        { label: '范围', value: '1 个：mcp.read' },
        { label: '出站许可', value: `允许 Host 访问 ${target}（这台电脑上的地址）` },
      ]),
    )
    // Until the confirmation passes, the authorization server has heard nothing.
    expect(w.auth.requests).toEqual([])
    const started = await w.desktop.confirmedJson<Started>(`mcp/servers/${w.id}/oauth/login`, { body })
    expect(started.server.oauth).toMatchObject({ state: 'signing-in', issuer: w.auth.origin, scopes: ['mcp.read'] })
    const url = new URL(started.authorizationUrl)
    expect(url.origin).toBe(w.auth.origin)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      code_challenge_method: 'S256',
      resource: w.mcp.url,
      scope: 'mcp.read',
    })
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const redirect = new URL(url.searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toMatch(/^\/[A-Za-z0-9_-]{22}\/callback$/u)
    // The same request again (an answer that never arrived) is the same login, not a second one.
    expect((await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body })).authorizationUrl).toBe(started.authorizationUrl)
    expect(w.auth.registered).toHaveLength(1)
    const page = await comeBack(w, started)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(await page.text()).toBe(CALLBACK_TEXT)
    await settled(w, 'signed-in')
    const signedIn = await view(w, w.browser)
    expect(signedIn.oauth).toMatchObject({ state: 'signed-in', issuer: w.auth.origin, scopes: ['mcp.read'] })
    expect(Date.parse(signedIn.oauth!.expiresAt!)).toBeGreaterThan(Date.now())
    // The listener took its one callback and is gone.
    await expect(fetch(redirect.href)).rejects.toThrow()
    const token = w.auth.requests.find(request => request.path === '/token')!
    expect(token.values).toMatchObject({ grant_type: 'authorization_code', resource: w.mcp.url, redirect_uri: redirect.href })
    expect(token.params).toContain('code_verifier')
    // The token works, and goes to the bound address as a bearer header.
    expect(await test(w)).toMatchObject({ status: 'ok', tools: ['echo', 'slow', 'big'] })
    const [access, renewal] = w.auth.issued
    expect(bearer(w).at(-1)).toBe(`Bearer ${access}`)
    // On this Mac's disk, 0600, and nowhere a device, a log or the audit can read.
    const kept = await secretsFile(w.t)
    expect(kept).toContain(access!)
    expect(kept).toContain(renewal!)
    expect((await stat(join(w.t.dataDir, 'mcp', 'secrets.json'))).mode & 0o777).toBe(0o600)
    const records = await audit(w.t)
    const outside = [
      JSON.stringify(started),
      JSON.stringify(await w.browser.json('mcp/servers')),
      JSON.stringify(await w.desktop.json('mcp/servers')),
      JSON.stringify(await w.browser.json('snapshot')),
      JSON.stringify(await w.desktop.json('snapshot')),
      await readFile(join(w.t.dataDir, 'mcp', 'servers.json'), 'utf8'),
      JSON.stringify(records),
      w.logs.join('\n'),
      w.frames(),
      JSON.stringify(await phone.json('mcp/servers')),
    ]
    // The event stream did carry frames for the scan to read.
    expect(w.frames().length).toBeGreaterThan(0)
    const verifierless = url.searchParams.get('code_challenge')!
    for (const text of outside) {
      for (const secret of w.auth.issued) expect(text).not.toContain(secret)
      expect(text).not.toMatch(/fake-(?:access|refresh|code)-/u)
    }
    // Only the login's own answer, to this Mac, carries the address with its state; no list, event or record does.
    for (const text of outside.slice(1)) {
      expect(text).not.toContain(url.searchParams.get('state')!)
      expect(text).not.toContain(verifierless)
    }
    const actions = records.filter(record => record.action.startsWith('mcp.oauth.') || record.action === 'mcp.server.changed')
    expect(actions.map(record => record.action)).toEqual(['mcp.server.changed', 'mcp.oauth.started', 'mcp.oauth.authorized'])
    expect(actions[0]).toMatchObject({ stepup: 'lpc-local', detail: { kinds: ['spec'] } })
    expect(actions[1]!.detail).toEqual({ serverId: w.id })
    expect(actions[2]!.detail).toEqual({ serverId: w.id, registered: true, renewable: true })
    // The device that began the login is on both records.
    for (const record of actions.slice(1)) expect((record as unknown as { actor: unknown }).actor).toMatchObject({ deviceId: w.desktop.id })
    // The scopes are listed whole, with their number, for the person to read before confirming.
    expect(ticket.lines).toEqual(expect.arrayContaining([{ label: '范围', value: '1 个：mcp.read' }]))
    // A login again, with the same authorization server and scopes, asks nothing.
    const confirmations = w.t.presence.requests.length
    const again = await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(again.authorizationUrl).not.toBe(started.authorizationUrl)
    expect(w.t.presence.requests).toHaveLength(confirmations)
  })

  it('refuses a callback with another issuer or without a promised one; a wrong state or Host changes nothing; a second one is on record', async () => {
    const wrong = await world({ auth: { iss: 'wrong' } })
    const first = await start(wrong)
    expect((await comeBack(wrong, first)).status).toBe(400)
    await settled(wrong, 'failed')
    expect((await view(wrong)).oauth).toMatchObject({ state: 'failed', reason: 'issuer' })
    // Not handled: the code never went to the token endpoint.
    expect(wrong.auth.requests.some(request => request.path === '/token')).toBe(false)

    const promised = await world({ auth: { iss: 'omit', issAdvertised: true } })
    expect((await comeBack(promised, await start(promised))).status).toBe(400)
    await settled(promised, 'failed')
    expect((await view(promised)).oauth?.reason).toBe('issuer')

    // No `iss` and none promised: the older servers still log in.
    const silent = await world({ auth: { iss: 'omit' } })
    await signIn(silent)

    const w = await world({ auth: { tokenDelayMs: 300 } })
    // A hit without this login's state is anyone's (another process, a page scanning loopback): refused, and the login
    // waits on for the real callback. Nothing is put on record for it.
    const good = await start(w)
    const callback = await w.auth.authorize(good.authorizationUrl)
    const forged = new URL(callback)
    forged.searchParams.set('state', 'A'.repeat(43))
    const refusedPage = await fetch(forged)
    expect(refusedPage.status).toBe(400)
    // The same fixed words, whatever happened.
    expect(await refusedPage.text()).toBe(CALLBACK_TEXT)
    const stateless = new URL(callback)
    stateless.searchParams.delete('state')
    expect((await fetch(stateless)).status).toBe(400)
    expect((await view(w)).oauth?.state).toBe('signing-in')
    expect(w.auth.requests.some(request => request.path === '/token')).toBe(false)
    // Another Host header (a page that resolved its own name to this address) is nobody's callback.
    const rebound = new URL(callback)
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: rebound.port, path: `${rebound.pathname}${rebound.search}`, headers: { host: 'attacker.example' } },
        response => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(404)
    expect((await view(w)).oauth?.state).toBe('signing-in')
    // A flood of such hits is answered a bounded number of times a second and then dropped, with no record of any.
    const flood = await Promise.all(
      Array.from({ length: 60 }, () =>
        fetch(forged).then(
          response => response.status,
          () => 0,
        ),
      ),
    )
    expect(flood.filter(code => code === 400).length).toBeLessThanOrEqual(20)
    expect(flood).toContain(0)
    expect((await audit(w.t)).filter(record => record.action === 'mcp.oauth.failed')).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 1100))

    // A second return while the first is being exchanged is refused; the first still finishes.
    const [one, two] = await Promise.all([fetch(callback), new Promise(resolve => setTimeout(resolve, 50)).then(() => fetch(callback))])
    expect(one.status).toBe(200)
    expect(two.status).toBe(400)
    await settled(w, 'signed-in')
    expect(w.auth.requests.filter(request => request.path === '/token')).toHaveLength(1)
    await expect(fetch(callback)).rejects.toThrow()
    // Another path, another method or another Host header is nobody's callback.
    const pending = await start(w)
    const real = new URL(await w.auth.authorize(pending.authorizationUrl))
    expect((await fetch(`${real.origin}/callback${real.search}`)).status).toBe(404)
    expect((await fetch(real.href, { method: 'POST' })).status).toBe(404)
    expect((await view(w)).oauth?.state).toBe('signing-in')

    const reasons = async (x: World) =>
      (await audit(x.t)).filter(record => record.action === 'mcp.oauth.failed').map(record => record.detail.reason)
    expect(await reasons(wrong)).toEqual(['issuer'])
    expect(await reasons(promised)).toEqual(['issuer'])
    expect(await reasons(w)).toEqual(['replay'])
    for (const record of (await audit(w.t)).filter(item => item.action.startsWith('mcp.oauth.')))
      expect(Object.keys(record.detail).toSorted()).toEqual(
        record.action === 'mcp.oauth.authorized'
          ? ['registered', 'renewable', 'serverId']
          : record.action === 'mcp.oauth.failed'
            ? ['reason', 'serverId']
            : ['serverId'],
      )
  })

  it('gives up a login nobody finished in time, and ends one on demand', async () => {
    const w = await world({ host: { mcpLoginTtlMs: 150 } })
    const started = await start(w)
    const callback = await w.auth.authorize(started.authorizationUrl)
    await settled(w, 'failed')
    expect((await view(w)).oauth?.reason).toBe('expired')
    await expect(fetch(callback)).rejects.toThrow()
    expect(w.auth.requests.some(request => request.path === '/token')).toBe(false)
    expect((await audit(w.t)).filter(record => record.action === 'mcp.oauth.failed').map(record => record.detail.reason)).toEqual([
      'expired',
    ])

    // The device that began it is removed before the browser returns: the login is not finished for it.
    const orphan = await world()
    const second = await orphan.t.enroll({ listener: 'unix', name: 'Second' })
    const begun = await start(orphan)
    await orphan.t.host.security.devices.revoke(orphan.desktop.id, 'manual', { listener: 'host', via: 'startup' })
    await comeBack(orphan, begun)
    await vi.waitFor(async () => expect((await view(orphan, second)).oauth).toMatchObject({ state: 'failed', reason: 'cancelled' }))
    expect(await secretsFile(orphan.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    expect(orphan.auth.revoked.toSorted()).toEqual(orphan.auth.issued.toSorted())

    const patient = await world()
    const waiting = await start(patient)
    const done = await patient.desktop.json<{ oauth: string; server: McpHttpServerView }>(`mcp/servers/${patient.id}/oauth/logout`, {
      body: { requestId: randomUUID() },
    })
    expect(done.server.oauth?.state).toBe('signed-out')
    await expect(comeBack(patient, waiting)).rejects.toThrow()
  })

  it('refuses metadata that points elsewhere, plain http, another issuer, no PKCE, or a resource that is not this server', async () => {
    const elsewhere = await startFakeMcpHttp()
    cleanups.push(() => elsewhere.close())
    const cases: Array<[string, Parameters<typeof world>[0], string]> = [
      [
        'a token endpoint on another origin',
        { auth: { metadata: doc => ({ ...doc, token_endpoint: `${elsewhere.origin}/token` }) } },
        'endpoint',
      ],
      [
        'an authorization endpoint on another origin',
        { auth: { metadata: doc => ({ ...doc, authorization_endpoint: 'https://login.example.com/authorize' }) } },
        'endpoint',
      ],
      [
        'a registration endpoint on another origin',
        { auth: { metadata: doc => ({ ...doc, registration_endpoint: `${elsewhere.origin}/register` }) } },
        'endpoint',
      ],
      [
        'a revocation endpoint over plain http',
        { auth: { metadata: doc => ({ ...doc, revocation_endpoint: 'http://auth.example.com/revoke' }) } },
        'endpoint',
      ],
      ['metadata of another issuer', { auth: { metadata: doc => ({ ...doc, issuer: 'https://another-issuer.example' }) } }, 'metadata'],
      ['no S256', { auth: { metadata: doc => ({ ...doc, code_challenge_methods_supported: ['plain'] }) } }, 'pkce'],
      ['no PKCE methods at all', { auth: { metadata: ({ code_challenge_methods_supported: _, ...doc }) => doc } }, 'pkce'],
    ]
    for (const [name, options, reason] of cases) {
      const w = await world(options)
      const answer = await refused(w)
      expect(answer.body.error, name).toBe(`mcp-oauth-${reason}`)
      expect((await view(w)).oauth, name).toMatchObject({ state: 'failed', reason })
      // Nothing but the metadata was asked of the authorization server, and nothing of anyone else.
      expect(
        w.auth.requests.every(request => request.method === 'GET'),
        name,
      ).toBe(true)
      expect(
        (await audit(w.t)).filter(record => record.action === 'mcp.oauth.started'),
        name,
      ).toEqual([])
    }
    expect(elsewhere.requests).toEqual([])
    // The server's own metadata: on its own origin, and about itself. Refused before any confirmation is asked.
    for (const protect of [
      { metadataUrl: `${elsewhere.origin}/.well-known/oauth-protected-resource` },
      { resource: `${elsewhere.origin}/mcp` },
      { resource: 'http://127.0.0.1:1/other' },
    ]) {
      const w = await world({ protect })
      const before = w.t.presence.requests.length
      expect((await refused(w)).body.error, JSON.stringify(protect)).toBe('mcp-oauth-resource')
      expect(w.t.presence.requests).toHaveLength(before)
      expect(w.auth.requests).toEqual([])
    }
    expect(elsewhere.requests).toEqual([])
    // An authorization server that is neither https nor this Mac's loopback is never asked anything.
    const plain = await world({ protect: { issuer: 'http://auth.example.com' } })
    expect((await refused(plain)).body.error).toBe('mcp-oauth-endpoint')
    // No pointer in the challenge: the well-known address on the server's own origin is read instead.
    const bare = await world({ protect: { bareChallenge: true } })
    await signIn(bare)
  })

  it('asks for a client ID where the server registers none, and keeps its secret on this Mac', async () => {
    const w = await world({ auth: { registration: false, clients: { 'typed-client': 'typed-client-secret-123' } } })
    const first = await refused(w)
    expect(first.body.error).toBe('mcp-oauth-client-required')
    expect((await view(w)).oauth).toMatchObject({ state: 'failed', reason: 'client-required' })
    // The authorization server was confirmed with the first attempt: typing the client asks nothing again.
    const confirmations = w.t.presence.requests.length
    const started = await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, {
      body: { requestId: randomUUID(), clientId: 'typed-client', clientSecret: 'typed-client-secret-123' },
    })
    expect(w.t.presence.requests).toHaveLength(confirmations)
    const url = new URL(started.authorizationUrl)
    expect(url.searchParams.get('client_id')).toBe('typed-client')
    // A client registered beforehand has one fixed redirect path; the port is this login's own.
    expect(new URL(url.searchParams.get('redirect_uri')!).pathname).toBe('/callback')
    expect((await comeBack(w, started)).status).toBe(200)
    await settled(w, 'signed-in')
    expect(w.auth.requests.find(request => request.path === '/token')).toMatchObject({ clientAuth: 'basic' })
    expect((await view(w, w.browser)).oauth).toMatchObject({ state: 'signed-in', clientId: true })
    for (const text of [
      JSON.stringify(await w.browser.json('mcp/servers')),
      JSON.stringify(started),
      JSON.stringify(await audit(w.t)),
      await readFile(join(w.t.dataDir, 'mcp', 'servers.json'), 'utf8'),
      w.logs.join('\n'),
      w.frames(),
    ])
      expect(text).not.toContain('typed-client-secret-123')
    expect(await secretsFile(w.t)).toContain('typed-client-secret-123')
    // Logging out keeps the typed client for the next login; its secret stays, the tokens go.
    await w.desktop.json(`mcp/servers/${w.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    const kept = await secretsFile(w.t)
    expect(kept).toContain('typed-client-secret-123')
    for (const token of w.auth.issued) expect(kept).not.toContain(token)
    await signIn(w)
  })

  it('keeps nothing when more scopes come back than were confirmed, or when the record cannot be written', async () => {
    const wide = await world({ auth: { grantScope: 'mcp.read admin' } })
    await comeBack(wide, await start(wide))
    await settled(wide, 'failed')
    expect((await view(wide)).oauth?.reason).toBe('scope')
    expect(await secretsFile(wide.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    // What was issued and not kept is handed back.
    expect(wide.auth.revoked.toSorted()).toEqual(wide.auth.issued.toSorted())

    const w = await world()
    await refused(w).then(() => undefined) // The confirmation and the binding, with a working audit log.
    await w.desktop.json(`mcp/servers/${w.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    const spy = failAudit(w.t, action => action === 'mcp.oauth.started')
    const unwritten = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(((await unwritten.json()) as { error: string }).error).toBe('mcp-oauth-audit')
    expect((await view(w)).oauth?.state).toBe('failed')
    spy.mockRestore()
    failAudit(w.t, action => action === 'mcp.oauth.authorized')
    await comeBack(w, await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } }))
    await settled(w, 'failed')
    expect((await view(w)).oauth?.reason).toBe('audit')
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    expect((await test(w)).reason).toBe('auth-required')
  })
})

describe('a login and the rest of a definition', () => {
  it('leaves a server confirmed when it logs in after a header was taken away', async () => {
    const w = await world({ headers: { 'X-Team': 'team-value-0123456789' } })
    const before = await view(w)
    await w.desktop.json(`mcp/servers/${w.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: before.revision, headers: { 'X-Team': null } },
    })
    await signIn(w)
    expect(await test(w)).toMatchObject({ status: 'ok' })
    const record = JSON.parse(await readFile(join(w.t.dataDir, 'mcp', 'servers.json'), 'utf8')).servers[0]
    expect(isConfirmed(record)).toBe(true)
    expect(record.confirmed.secretNames).toEqual(['X-Team'])
    expect(record.oauth).toMatchObject({ issuer: w.auth.issuer, scopes: ['mcp.read'], resource: w.mcp.url })
  })
})

describe('a login in use', () => {
  it('renews a token before it runs out and when the server refuses it, and sends it to the bound address alone', async () => {
    // Runs out within the minute: every use renews first.
    const short = await world({ auth: { expiresIn: 30 } })
    await signIn(short)
    expect(await test(short)).toMatchObject({ status: 'ok' })
    const renewals = short.auth.requests.filter(request => request.values.grant_type === 'refresh_token')
    expect(renewals.length).toBeGreaterThan(0)
    expect(renewals[0]!.values.resource).toBe(short.mcp.url)
    expect(bearer(short)).not.toContain(`Bearer ${short.auth.issued[0]}`)
    // The rotated refresh token replaced the first on disk.
    const kept = await secretsFile(short.t)
    expect(kept).not.toContain(short.auth.issued[1]!)
    expect(kept).toContain(short.auth.issued.at(-1)!)

    const w = await world()
    await signIn(w)
    expect(await test(w)).toMatchObject({ status: 'ok' })
    expect(w.auth.requests.some(request => request.values.grant_type === 'refresh_token')).toBe(false)
    // The server stops taking the token mid-way (401): renewed once, sent once more.
    w.auth.expireAccess()
    expect(await test(w)).toMatchObject({ status: 'ok' })
    expect(w.auth.requests.filter(request => request.values.grant_type === 'refresh_token')).toHaveLength(1)
    expect((await view(w)).oauth?.state).toBe('signed-in')
    // Every token the authorization server ever got came to its token endpoint; the MCP server saw only access tokens.
    for (const request of w.auth.requests.filter(item => item.params.includes('refresh_token') || item.params.includes('code')))
      expect(request.path).toBe('/token')
    const refreshTokens = w.auth.issued.filter(token => token.startsWith('fake-refresh-'))
    for (const header of bearer(w)) for (const token of refreshTokens) expect(header).not.toContain(token)
    for (const text of [
      w.logs.join('\n'),
      w.frames(),
      JSON.stringify(await audit(w.t)),
      JSON.stringify(await w.browser.json('mcp/servers')),
    ])
      for (const token of w.auth.issued) expect(text).not.toContain(token)
  })

  it('never follows the server elsewhere with the token', async () => {
    const elsewhere = await startFakeMcpHttp({ keepHeaders: ['authorization'] })
    cleanups.push(() => elsewhere.close())
    const w = await world()
    await signIn(w)
    // The same protected server now redirects every POST to another origin the outbound rules would allow.
    const policyFile = join(w.t.dataDir, 'policy.json')
    expect(JSON.parse(await readFile(policyFile, 'utf8')).hostEgressAllow).toContain(new URL(w.mcp.origin).host)
    const redirecting = await startFakeMcpHttp({
      keepHeaders: ['authorization'],
      redirect: `${elsewhere.url}`,
      protect: { issuer: w.auth.issuer, valid: token => w.auth.valid(token), scopes: ['mcp.read'] },
    })
    cleanups.push(() => redirecting.close())
    const { server } = await w.desktop.confirmedJson<{ server: McpHttpServerView }>('mcp/servers', {
      body: {
        requestId: randomUUID(),
        baseRevision: (await w.desktop.json<McpServersResponse>('mcp/servers')).revision,
        transport: 'http',
        name: 'redirecting',
        url: redirecting.url,
        headers: {},
        scope: { all: true, agents: [], projects: [] },
      },
    })
    const second = { ...w, id: server.id, mcp: redirecting }
    await signIn(second)
    // With a token it would accept, the server answers 307: refused, and the token goes nowhere else.
    expect(await test(second)).toMatchObject({ status: 'failed', reason: 'refused' })
    expect(bearer(second).length).toBeGreaterThan(0)
    expect(elsewhere.requests).toEqual([])
  })

  it('says 需要重新登录 when a renewal is refused, when there is nothing to renew with, and when the scopes do not reach', async () => {
    const w = await world({ auth: { refreshFails: true } })
    await signIn(w)
    w.auth.expireAccess()
    expect(await test(w)).toMatchObject({ status: 'failed', reason: 'auth-required' })
    expect((await view(w, w.browser)).oauth).toMatchObject({ state: 'relogin', reason: 'refresh' })
    expect((await audit(w.t)).filter(record => record.action === 'mcp.oauth.refresh-failed').map(record => record.detail)).toEqual([
      { serverId: w.id },
    ])
    // The dead tokens are gone from the disk.
    expect(await secretsFile(w.t)).not.toMatch(/fake-(?:access|refresh)-/u)
    // Logging in again mends it, with no confirmation.
    const confirmations = w.t.presence.requests.length
    const again = await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    await comeBack(w, again)
    await settled(w, 'signed-in')
    expect(w.t.presence.requests).toHaveLength(confirmations)

    const once = await world({ auth: { noRefresh: true } })
    await signIn(once)
    once.auth.expireAccess()
    expect(await test(once)).toMatchObject({ status: 'failed', reason: 'auth-required' })
    expect((await view(once)).oauth).toMatchObject({ state: 'relogin', reason: 'expired' })

    // A call the token's scopes do not reach (403 insufficient_scope): not renewed, not widened; a new login is asked.
    const narrow = await startFakeMcpHttp({ protect: { issuer: 'https://auth.example.com', valid: () => true, insufficient: true } })
    cleanups.push(() => narrow.close())
    const rejected: string[] = []
    const renewals: boolean[] = []
    const session = new McpRemoteSession({
      url: narrow.url,
      headers: {},
      fetch: createEgressFetch({ allow: () => [new URL(narrow.origin).host] }),
      authorization: async renew => {
        renewals.push(renew)
        return 'a-token-the-server-takes'
      },
      onRejected: why => rejected.push(why),
    })
    expect((await session.listTools()).length).toBe(3)
    await expect(session.callTool('echo', {})).rejects.toMatchObject({ reason: 'auth-required' })
    expect(rejected).toEqual(['scope'])
    expect(renewals).not.toContain(true)
  })

  it('revokes and deletes the tokens when the server is removed or on 退出登录, also when revoking fails or cannot be recorded', async () => {
    const w = await world()
    await signIn(w)
    const issued = [...w.auth.issued]
    const out = await w.desktop.json<{ oauth: string; server: McpHttpServerView }>(`mcp/servers/${w.id}/oauth/logout`, {
      body: { requestId: randomUUID() },
    })
    expect(out.oauth).toBe('revoked')
    expect(out.server.oauth).toMatchObject({ state: 'signed-out', issuer: w.auth.origin })
    expect(w.auth.revoked.toSorted()).toEqual(issued.toSorted())
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    expect((await test(w)).reason).toBe('auth-required')
    // Removing a logged-in server revokes first, then deletes.
    await signIn(w)
    const removed = await w.desktop.json<{ deleted: boolean; oauth?: string }>(`mcp/servers/${w.id}`, { method: 'DELETE' })
    expect(removed).toMatchObject({ deleted: true, oauth: 'revoked' })
    expect(w.auth.revoked.toSorted()).toEqual(w.auth.issued.toSorted())
    expect(await secretsFile(w.t)).not.toContain(w.id)
    const results = (await audit(w.t)).filter(record => record.action === 'mcp.oauth.revoked').map(record => record.detail)
    expect(results).toEqual([
      { serverId: w.id, result: 'revoked' },
      { serverId: w.id, result: 'revoked' },
    ])

    // A revocation the authorization server does not take, and a record that cannot be written: still deleted.
    const failing = await world({ auth: { revocation: 'fails' } })
    await signIn(failing)
    failAudit(failing.t, action => action === 'mcp.oauth.revoked' || action === 'mcp.server.removed')
    const gone = await failing.desktop.request(`mcp/servers/${failing.id}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(gone.headers.get('x-latch-audit')).toBe('failed')
    expect(await gone.json()).toMatchObject({ deleted: true, oauth: 'failed' })
    expect(await secretsFile(failing.t)).not.toMatch(/fake-(?:access|refresh)-/u)

    const none = await world({ auth: { revocation: false } })
    await signIn(none)
    expect(
      (await none.desktop.json<{ oauth: string }>(`mcp/servers/${none.id}/oauth/logout`, { body: { requestId: randomUUID() } })).oauth,
    ).toBe('unsupported')
    expect(await secretsFile(none.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
  })

  it('keeps the login across a restart, keeps it through a header change, and ends it with another address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-oauth-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const dirs = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    const w = await world({ host: dirs })
    await signIn(w)
    await w.t.close()
    const t = await startTestHost({ demo: false, ...dirs })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const again: World = { ...w, t, desktop, browser: desktop }
    expect((await view(again)).oauth).toMatchObject({ state: 'signed-in', issuer: w.auth.origin })
    const tokens = w.auth.requests.filter(request => request.path === '/token').length
    expect(await test(again)).toMatchObject({ status: 'ok' })
    expect(w.auth.requests.filter(request => request.path === '/token')).toHaveLength(tokens)
    expect(bearer(w).at(-1)).toBe(`Bearer ${w.auth.issued[0]}`)
    // A request header added (confirmed for its name) leaves the login as it is.
    const current = await view(again)
    const patched = await desktop.confirmedJson<{ server: McpHttpServerView }>(`mcp/servers/${w.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: current.revision, headers: { 'X-Team': 'team-value-0123456789' } },
    })
    expect(patched.server.oauth?.state).toBe('signed-in')
    expect(await test(again)).toMatchObject({ status: 'ok' })
    // Another address is another server: the login ends, its tokens revoked.
    const moved = await desktop.confirmedJson<{ server: McpHttpServerView }>(`mcp/servers/${w.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: patched.server.revision, url: `${w.mcp.origin}/other` },
    })
    expect(moved.server.oauth).toBeUndefined()
    expect(w.auth.revoked.toSorted()).toEqual(w.auth.issued.toSorted())
    expect(await secretsFile(t)).not.toMatch(/fake-(?:access|refresh)-/u)
  })
})

describe('what a remote party may not choose', () => {
  it('takes no token or registered secret that is not shaped like a credential, so no ordinary word is ever masked', async () => {
    const word = await world({ auth: { accessToken: 'requiresApproval' } })
    await comeBack(word, await start(word))
    await settled(word, 'failed')
    // Said in its own words, which hold nothing of the token.
    expect((await view(word)).oauth?.reason).toBe('token')
    expect((await audit(word.t)).filter(record => record.action === 'mcp.oauth.failed').map(record => record.detail)).toEqual([
      { serverId: word.id, reason: 'token' },
    ])
    expect(await secretsFile(word.t).catch(() => '')).not.toContain('requiresApproval')
    expect(redactKnownSecrets('requiresApproval: true')).toBe('requiresApproval: true')

    const secret = await world({ auth: { registrationSecret: 'approval' } })
    expect((await refused(secret)).body.error).toBe('mcp-oauth-registration')
    expect(redactKnownSecrets('waiting-approval')).toBe('waiting-approval')
    // A secret shaped like one is taken, used with the token endpoint and kept on this Mac only.
    const shaped = await world({ auth: { registrationSecret: 'registered-secret-0123456789' } })
    await signIn(shaped)
    expect(shaped.auth.requests.find(request => request.path === '/token')).toMatchObject({ clientAuth: 'basic' })
    expect(await secretsFile(shaped.t)).toContain('registered-secret-0123456789')
    expect(JSON.stringify(await shaped.browser.json('mcp/servers'))).not.toContain('registered-secret-0123456789')
  })

  it('shows every scope with their number before the person confirms, however many the server names', async () => {
    const many = Array.from({ length: 64 }, (_, index) => `scope.number-${String(index).padStart(2, '0')}.${'x'.repeat(100)}`)
    const w = await world({ protect: { scopes: many } })
    const asked = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    const ticket = ((await asked.json()) as { confirmation: { lines: Array<{ label: string; value: string }> } }).confirmation
    const line = ticket.lines.find(item => item.label === '范围')!
    expect(line.value.startsWith('64 个：')).toBe(true)
    for (const scope of many) expect(line.value).toContain(scope)
    expect(line.value).not.toContain('…')
    // More than a login may ask for is refused before anything is confirmed.
    const tooMany = await world({ protect: { scopes: [...many, 'one.more'] } })
    expect((await refused(tooMany)).body.error).toBe('mcp-oauth-discovery')
  })
})

describe('confirming a login again', () => {
  it('asks again when the server wants a new scope or names another authorization server, and not otherwise', async () => {
    const w = await world()
    await signIn(w)
    const confirmations = w.t.presence.requests.length
    // Fewer scopes than confirmed: nothing to ask.
    w.protect.scopes = []
    await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(w.t.presence.requests).toHaveLength(confirmations)
    // A scope nobody confirmed.
    w.protect.scopes = ['mcp.read', 'mcp.write']
    const wider = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(wider.status).toBe(403)
    expect(((await wider.json()) as { confirmation: { lines: unknown[] } }).confirmation.lines).toEqual(
      expect.arrayContaining([{ label: '范围', value: '2 个：mcp.read mcp.write' }]),
    )
    await comeBack(w, await start(w))
    await settled(w, 'signed-in')
    expect((await view(w)).oauth?.scopes).toEqual(['mcp.read', 'mcp.write'])
    // Asked twice here (the request above, then the one that was approved); the narrower login asked nothing.
    expect(w.t.presence.requests).toHaveLength(confirmations + 2)
    // Another authorization server: confirmed by its own origin, and what the first one issued is revoked.
    const other = await startFakeOAuth()
    cleanups.push(() => other.close())
    const issued = [...w.auth.issued]
    w.protect.issuer = other.issuer
    w.protect.valid = token => other.valid(token)
    const moved = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(moved.status).toBe(403)
    const ticket = ((await moved.json()) as { confirmation: { reason: string; lines: unknown[] } }).confirmation
    expect(ticket.reason).toBe(`让 Latch 连接 ${new URL(other.origin).host}（MCP 服务器「oauth」）`)
    expect(ticket.lines).toEqual(expect.arrayContaining([{ label: '授权服务器', value: other.origin }]))
    // Until it is confirmed the new server has heard nothing, and the old login still stands.
    expect(other.requests).toEqual([])
    expect((await view(w)).oauth).toMatchObject({ state: 'signed-in', issuer: w.auth.origin })
    const started = await start(w)
    expect(new URL(started.authorizationUrl).origin).toBe(other.origin)
    for (const token of issued.filter(item => w.auth.revoked.includes(item) === false)) expect(w.auth.valid(token)).toBe(false)
    expect(w.auth.revoked.length).toBeGreaterThan(0)
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    await fetch(await other.authorize(started.authorizationUrl))
    await settled(w, 'signed-in')
    expect((await view(w)).oauth?.issuer).toBe(other.origin)
    expect(await test(w)).toMatchObject({ status: 'ok' })
  })

  it('holds a login that needs a confirmation back while a full-access session runs or waits', async () => {
    const w = await world()
    await w.desktop.confirmedJson('agents', {
      body: {
        id: 'fake',
        name: 'Fake',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_STATE: join(w.t.root, 'state.json') },
      },
    })
    const created = await w.desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'delegate stop', requestId: randomUUID(), harnessId: 'fake' },
    })
    let blocked: { error?: string; blockingTasks?: Array<{ id: string }> } = {}
    await vi.waitFor(
      async () => {
        blocked = (await (
          await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
        ).json()) as typeof blocked
        expect(blocked.error).toBe('presence-blocked')
      },
      { timeout: 10_000 },
    )
    expect(blocked.blockingTasks).toMatchObject([{ id: created.sessionId }])
    // Nothing was bound, nothing was sent to the authorization server.
    expect(JSON.parse(await readFile(join(w.t.dataDir, 'mcp', 'servers.json'), 'utf8')).servers[0].oauth).toBeUndefined()
    expect(w.auth.requests).toEqual([])
  })

  it('answers a login or 退出登录 sent again from its receipt, and refuses the same ID with another body', async () => {
    const w = await world()
    const body = { requestId: randomUUID() }
    const first = await w.desktop.confirmedJson<Started>(`mcp/servers/${w.id}/oauth/login`, { body })
    await comeBack(w, first)
    await settled(w, 'signed-in')
    // The login is done; the same request again starts nothing (no registration, no listener, no confirmation) and
    // does not hand back the address of a login that is over.
    const again = await w.desktop.json<Partial<Started>>(`mcp/servers/${w.id}/oauth/login`, { body })
    expect(again.authorizationUrl).toBeUndefined()
    expect(again.server?.oauth?.state).toBe('signed-in')
    expect(w.auth.registered).toHaveLength(1)
    // The same after a login that was given up, or that ran out of time.
    const given = { requestId: randomUUID() }
    const waiting = await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body: given })
    expect((await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, { body: given })).authorizationUrl).toBe(
      waiting.authorizationUrl,
    )
    await w.desktop.json(`mcp/servers/${w.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    const after = await w.desktop.json<Partial<Started>>(`mcp/servers/${w.id}/oauth/login`, { body: given })
    expect(after.authorizationUrl).toBeUndefined()
    expect(after.server?.oauth?.state).toBe('signed-out')
    expect(w.auth.registered).toHaveLength(2)
    await signIn(w)
    const conflict = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { ...body, clientId: 'another' } })
    expect(((await conflict.json()) as { error: string }).error).toBe('request-conflict')
    const out = { requestId: randomUUID() }
    expect((await w.desktop.json<{ oauth: string }>(`mcp/servers/${w.id}/oauth/logout`, { body: out })).oauth).toBe('revoked')
    const revocations = w.auth.requests.filter(request => request.path === '/revoke').length
    expect((await w.desktop.json<{ oauth: string }>(`mcp/servers/${w.id}/oauth/logout`, { body: out })).oauth).toBe('revoked')
    expect(w.auth.requests.filter(request => request.path === '/revoke')).toHaveLength(revocations)
  })
})

describe('退出登录 and work in flight', () => {
  it('keeps nothing of a login whose code was being exchanged, and revokes what came back', async () => {
    const w = await world({ auth: { tokenDelayMs: 400 } })
    const started = await start(w)
    expect((await comeBack(w, started)).status).toBe(200)
    const out = await w.desktop.json<{ oauth: string; server: McpHttpServerView }>(`mcp/servers/${w.id}/oauth/logout`, {
      body: { requestId: randomUUID() },
    })
    expect(out.server.oauth?.state).not.toBe('signed-in')
    await vi.waitFor(() => expect(w.auth.issued.length).toBe(2), { timeout: 5000 })
    await vi.waitFor(() => expect(w.auth.revoked.toSorted()).toEqual(w.auth.issued.toSorted()), { timeout: 5000 })
    expect((await view(w)).oauth?.state).toBe('signed-out')
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    expect((await audit(w.t)).some(record => record.action === 'mcp.oauth.authorized')).toBe(false)
  })

  it('keeps nothing of a renewal that was on its way, and revokes what it brought', async () => {
    const w = await world({ auth: { refreshDelayMs: 400 } })
    await signIn(w)
    w.auth.expireAccess()
    const testing = test(w)
    // The authorization server has already rotated the tokens; its answer is still on its way.
    await vi.waitFor(() => expect(w.auth.issued).toHaveLength(4))
    await w.desktop.json(`mcp/servers/${w.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    expect(await testing).toMatchObject({ status: 'failed', reason: 'auth-required' })
    await vi.waitFor(() => expect(w.auth.revoked).toEqual(expect.arrayContaining(w.auth.issued.slice(2))), { timeout: 5000 })
    expect(w.auth.issued.every(token => !w.auth.valid(token))).toBe(true)
    expect((await view(w)).oauth?.state).toBe('signed-out')
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
  })

  it('closes the listener of a login still being set up when the server is removed', async () => {
    const w = await world({ auth: { registrationDelayMs: 500 } })
    // The authorization server and scopes are confirmed first, with a login that is then ended.
    await start(w)
    await w.desktop.json(`mcp/servers/${w.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    const registrations = w.auth.registered.length
    const beginning = w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    await vi.waitFor(() => expect(w.auth.registered.length).toBe(registrations + 1))
    const redirect = w.auth.registered.at(-1)!.redirectUris[0]!
    const removed = await w.desktop.json<{ deleted: boolean }>(`mcp/servers/${w.id}`, { method: 'DELETE' })
    expect(removed.deleted).toBe(true)
    // At once, not when the registration answers: nobody listens there any more.
    await expect(fetch(redirect)).rejects.toThrow()
    const answer = await beginning
    expect(answer.ok).toBe(false)
    await expect(fetch(redirect)).rejects.toThrow()
    expect(await secretsFile(w.t).catch(() => '')).not.toContain(w.id)
  })

  it('says so when the tokens cannot be deleted from this Mac, sends no bearer meanwhile, and deletes them on a retry', async () => {
    const w = await world()
    await signIn(w)
    const directory = join(w.t.dataDir, 'mcp')
    await chmod(directory, 0o500)
    cleanups.push(() => chmod(directory, 0o700).catch(() => {}))
    const stuck = await w.desktop.json<{ oauth: string; server: McpHttpServerView }>(`mcp/servers/${w.id}/oauth/logout`, {
      body: { requestId: randomUUID() },
    })
    expect(stuck.oauth).toBe('undeleted')
    expect(stuck.server.oauth).toMatchObject({ state: 'failed', reason: 'delete' })
    expect((await view(w, w.browser)).oauth).toMatchObject({ state: 'failed', reason: 'delete' })
    // Still on disk, but never sent again; the authorization server was asked to revoke them all the same.
    expect(await secretsFile(w.t)).toMatch(/fake-access-/u)
    const sent = bearer(w).length
    await chmod(directory, 0o700)
    expect(await test(w)).toMatchObject({ status: 'failed', reason: 'auth-required' })
    expect(bearer(w)).toHaveLength(sent)
    expect(w.auth.revoked.toSorted()).toEqual(w.auth.issued.toSorted())
    expect((await audit(w.t)).filter(record => record.action === 'mcp.oauth.revoked').map(record => record.detail.result)).toEqual([
      'undeleted',
    ])
    const done = await w.desktop.json<{ oauth: string; server: McpHttpServerView }>(`mcp/servers/${w.id}/oauth/logout`, {
      body: { requestId: randomUUID() },
    })
    expect(done.server.oauth?.state).toBe('signed-out')
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
  })
})

describe('a renewal', () => {
  it('keeps nothing when it comes back with more scopes than were confirmed', async () => {
    const w = await world({ auth: { refreshScope: 'mcp.read admin' } })
    await signIn(w)
    w.auth.expireAccess()
    expect(await test(w)).toMatchObject({ status: 'failed', reason: 'auth-required' })
    expect((await view(w)).oauth).toMatchObject({ state: 'relogin', reason: 'scope' })
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    // What the renewal brought was handed back.
    expect(w.auth.issued.every(token => !w.auth.valid(token))).toBe(true)
    expect(w.auth.revoked).toEqual(expect.arrayContaining(w.auth.issued.slice(2)))
    expect((await audit(w.t)).filter(record => record.action === 'mcp.oauth.refresh-failed')).toHaveLength(1)
  })

  it('goes only to the confirmed issuer’s origin, as a revocation does, whatever the saved endpoints say', async () => {
    const elsewhere = await startFakeOAuth()
    cleanups.push(() => elsewhere.close())
    /** A logged-in server whose definition on disk was changed behind the Host's back, on a Host started again. */
    const tampered = async (change: (login: Record<string, string>) => void): Promise<World> => {
      const root = await mkdtemp(join(tmpdir(), 'latch-mcp-oauth-origin-'))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const dirs = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
      const w = await world({ host: dirs })
      await signIn(w)
      await w.t.close()
      const file = join(dirs.dataDir, 'mcp', 'servers.json')
      const saved = JSON.parse(await readFile(file, 'utf8'))
      change(saved.servers[0].oauth.login)
      await writeFile(file, JSON.stringify(saved))
      // The other origin is one the outbound rules would let the Host reach: only the login's own rule keeps it away.
      const t = await startTestHost({ demo: false, ...dirs, egressAllow: [new URL(elsewhere.origin).host] })
      cleanups.push(() => t.close())
      const desktop = await t.enroll({ listener: 'unix' })
      return { ...w, t, desktop, browser: desktop }
    }
    const renewing = await tampered(login => {
      login.tokenEndpoint = `${elsewhere.origin}/token`
    })
    renewing.auth.expireAccess()
    expect(await test(renewing)).toMatchObject({ status: 'failed', reason: 'auth-required' })
    expect((await view(renewing)).oauth).toMatchObject({ state: 'relogin', reason: 'refresh' })
    const revoking = await tampered(login => {
      login.revocationEndpoint = `${elsewhere.origin}/revoke`
    })
    const out = await revoking.desktop.json<{ oauth: string }>(`mcp/servers/${revoking.id}/oauth/logout`, {
      body: { requestId: randomUUID() },
    })
    expect(out.oauth).toBe('failed')
    expect(await secretsFile(revoking.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    // Neither a refresh token nor a revocation went to the other origin.
    expect(elsewhere.requests).toEqual([])
  })

  it('runs once for requests that need it at the same moment', async () => {
    const auth = await startFakeOAuth({ tokenDelayMs: 150 })
    cleanups.push(() => auth.close())
    const mcp = await startFakeMcpHttp({ protect: { issuer: auth.issuer, valid: token => auth.valid(token) } })
    cleanups.push(() => mcp.close())
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-mcp-oauth-unit-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const id = `mcp_${'U'.repeat(22)}`
    const oauth = { issuer: auth.issuer, scopes: [], resource: mcp.url }
    const hash = httpSpecHash({ url: mcp.url, headerNames: [], oauth })
    const now = new Date().toISOString()
    await mkdir(join(dataDir, 'mcp'), { recursive: true })
    await writeFile(
      join(dataDir, 'mcp', 'servers.json'),
      JSON.stringify({
        v: 1,
        revision: 1,
        receipts: [],
        servers: [
          {
            id,
            name: 'unit',
            transport: 'http',
            url: mcp.url,
            headerNames: [],
            oauth,
            scope: { all: true, agents: [], projects: [] },
            enabled: true,
            disabledTools: [],
            revision: 1,
            specHash: hash,
            confirmed: { hash, secretNames: [] },
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    )
    const store = await McpStore.open(dataDir)
    const logins = new McpOAuth({
      store,
      fetch: createEgressFetch({ allow: () => [new URL(auth.origin).host, new URL(mcp.origin).host] }),
      now: Date.now,
      audit: async () => {},
      initiatorHolds: () => true,
      changed: () => {},
    })
    cleanups.push(() => logins.close())
    const record = store.get(id)
    if (record?.transport !== 'http') throw new Error('no record')
    const started = await logins.begin(record, { deviceId: 'device', actor: { listener: 'unix' } }, randomUUID())
    await fetch(await auth.authorize(started.authorizationUrl))
    await vi.waitFor(() => expect(store.oauthOf(id).accessToken).toBeDefined(), { timeout: 5000 })
    const first = store.oauthOf(id).accessToken
    const authorization = logins.authorization(id)
    const tokens = await Promise.all(Array.from({ length: 6 }, () => authorization(true)))
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).toBeDefined()
    expect(tokens[0]).not.toBe(first)
    expect(auth.requests.filter(request => request.values.grant_type === 'refresh_token')).toHaveLength(1)
    expect(store.oauthOf(id).accessToken).toBe(tokens[0])
    // Neither the deletion nor the mark of the end can be written: the end holds in memory, and says what it is.
    vi.spyOn(store, 'change').mockRejectedValueOnce(new Error('read-only'))
    vi.spyOn(store, 'markEnded').mockRejectedValueOnce(new Error('read-only'))
    const ending = await logins.forget(id)
    expect(ending.deleted).toBe(false)
    const current = store.get(id)
    if (current?.transport !== 'http') throw new Error('no record')
    expect(logins.view(current)).toMatchObject({ state: 'failed', reason: 'delete' })
    expect(await authorization(false)).toBeUndefined()
    expect(await authorization(true)).toBeUndefined()
    // A retry that can write deletes them.
    expect((await logins.forget(id)).deleted).toBe(true)
    expect(store.oauthOf(id).accessToken).toBeUndefined()
    expect(logins.view(store.get(id) as typeof current)).toMatchObject({ state: 'signed-out' })
  })
})

/** Another protected server on the same Host and authorization server, added and confirmed. */
async function another(w: World, name: string): Promise<World> {
  const mcp = await startFakeMcpHttp({
    keepHeaders: ['authorization'],
    protect: { issuer: w.auth.issuer, valid: token => w.auth.valid(token), scopes: ['mcp.read'] },
  })
  cleanups.push(() => mcp.close())
  const { server } = await w.desktop.confirmedJson<{ server: McpHttpServerView }>('mcp/servers', {
    body: {
      requestId: randomUUID(),
      baseRevision: (await w.desktop.json<McpServersResponse>('mcp/servers')).revision,
      transport: 'http',
      name,
      url: mcp.url,
      headers: {},
      scope: { all: true, agents: [], projects: [] },
    },
  })
  return { ...w, mcp, id: server.id }
}
const allowed = async (t: TestHost): Promise<string[]> => JSON.parse(await readFile(join(t.dataDir, 'policy.json'), 'utf8')).hostEgressAllow

describe('an ended login and a restart', () => {
  it('does not come back when its tokens could not be deleted: the end is on disk apart from them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-oauth-ended-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const dirs = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    const w = await world({ host: dirs })
    await signIn(w)
    expect(await test(w)).toMatchObject({ status: 'ok' })
    const directory = join(dirs.dataDir, 'mcp')
    await chmod(directory, 0o500)
    cleanups.push(() => chmod(directory, 0o700).catch(() => {}))
    const out = await w.desktop.json<{ oauth: string }>(`mcp/servers/${w.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    expect(out.oauth).toBe('undeleted')
    // The tokens are still in the file; the end is written beside the directory, naming the server and nothing else.
    expect(await secretsFile(w.t)).toMatch(/fake-access-/u)
    const mark = await readFile(join(dirs.dataDir, 'mcp-ended.json'), 'utf8')
    expect(JSON.parse(mark)).toEqual({ v: 1, servers: [w.id] })
    // A new login is not begun over tokens that are still there.
    const begun = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(((await begun.json()) as { error: string }).error).toBe('mcp-oauth-delete')
    const sent = bearer(w).length
    await w.t.close()
    const t = await startTestHost({ demo: false, ...dirs })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const again: World = { ...w, t, desktop, browser: desktop }
    // Deleted at the start, before anything could use them: not signed in, no bearer, nothing left on disk.
    expect((await view(again)).oauth?.state).toBe('signed-out')
    expect(await test(again)).toMatchObject({ status: 'failed', reason: 'auth-required' })
    expect(bearer(w)).toHaveLength(sent)
    expect(await secretsFile(t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    await expect(stat(join(dirs.dataDir, 'mcp-ended.json'))).rejects.toThrow()
    await signIn(again)
  })
})

describe('what the confirmation of a login shows', () => {
  it('names the issuer whole, so two tenants of one origin read differently, and the resource when it is not the address', async () => {
    const w = await world({ auth: { issuerPath: '/tenant-a' } })
    const first = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    const lines = async (response: Response) =>
      ((await response.json()) as { confirmation: { lines: Array<{ label: string; value: string }> } }).confirmation.lines
    const shown = await lines(first)
    expect(shown).toEqual(expect.arrayContaining([{ label: '授权服务器', value: `${w.auth.origin}/tenant-a` }]))
    // The tokens are for the server's own address: nothing more to say.
    expect(shown.map(line => line.label)).not.toContain('资源')
    await signIn(w)
    expect((await view(w, w.browser)).oauth?.issuer).toBe(`${w.auth.origin}/tenant-a`)
    // Another tenant of the same origin is another authorization server: asked again, and the card says which.
    w.protect.issuer = `${w.auth.origin}/tenant-b`
    const second = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(second.status).toBe(403)
    expect(await lines(second)).toEqual(expect.arrayContaining([{ label: '授权服务器', value: `${w.auth.origin}/tenant-b` }]))

    // Tokens for the whole origin instead of the one address: allowed by the spec's canonical form, and shown.
    const wide = await world({ protect: {} })
    wide.protect.resource = wide.mcp.origin
    const asked = await lines(await wide.desktop.request(`mcp/servers/${wide.id}/oauth/login`, { body: { requestId: randomUUID() } }))
    expect(asked).toEqual(expect.arrayContaining([{ label: '资源', value: wide.mcp.origin }]))
    const started = await start(wide)
    expect(new URL(started.authorizationUrl).searchParams.get('resource')).toBe(wide.mcp.origin)
    // Confirmed for the origin; the server now saying its own address is another resource, and is asked again.
    await wide.desktop.json(`mcp/servers/${wide.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    delete wide.protect.resource
    expect((await wide.desktop.request(`mcp/servers/${wide.id}/oauth/login`, { body: { requestId: randomUUID() } })).status).toBe(403)
    // Any other folder of the origin is refused before anything is asked.
    for (const resource of [`${wide.mcp.origin}/mc`, `${wide.mcp.origin}/mcp/deeper`, `${wide.mcp.origin}/other`]) {
      wide.protect.resource = resource
      expect((await refused(wide)).body.error, resource).toBe('mcp-oauth-resource')
    }
  })

  it('asks for the outbound allowance of an authorization server on a private address, in the same confirmation', async () => {
    const w = await world({ protect: { issuer: 'https://10.1.2.3:8443/realm' } })
    const asked = await w.desktop.request(`mcp/servers/${w.id}/oauth/login`, { body: { requestId: randomUUID() } })
    expect(asked.status).toBe(403)
    const ticket = ((await asked.json()) as { confirmation: { reason: string; lines: unknown[] } }).confirmation
    expect(ticket.reason).toBe('让 Latch 连接 10.1.2.3:8443（MCP 服务器「oauth」）')
    expect(ticket.lines).toEqual(
      expect.arrayContaining([
        { label: '授权服务器', value: 'https://10.1.2.3:8443/realm' },
        { label: '出站许可', value: '允许 Host 访问 10.1.2.3:8443（局域网或私网地址）' },
      ]),
    )
    // Asked, not granted: the policy has no such allowance.
    expect(await allowed(w.t)).not.toContain('10.1.2.3:8443')
  })
})

describe('a login and edits that fail or overlap', () => {
  it('keeps the login when the edit that would end it cannot be written', async () => {
    const w = await world()
    await signIn(w)
    const current = await view(w)
    const change = vi.spyOn(McpStore.prototype, 'change')
    cleanups.push(() => change.mockRestore())
    const body = { requestId: randomUUID(), baseRevision: current.revision, url: `${w.mcp.origin}/other` }
    const asked = await w.desktop.request(`mcp/servers/${w.id}`, { method: 'PATCH', body })
    expect(asked.status).toBe(403)
    change.mockRejectedValueOnce(new Error('disk full'))
    const failed = await w.desktop.confirmed(`mcp/servers/${w.id}`, { method: 'PATCH', body })
    expect(failed.ok).toBe(false)
    change.mockRestore()
    // Nothing was ended: still logged in, nothing revoked, and the token still works.
    expect((await view(w)).oauth?.state).toBe('signed-in')
    expect(w.auth.revoked).toEqual([])
    expect(await test(w)).toMatchObject({ status: 'ok' })
  })

  it('ends a login made as another client when a Client ID is typed, and uses the new one with its secret form-encoded', async () => {
    const id = 'typed client+id'
    const secret = 'sec ret/+:&=%-0123456789'
    const w = await world({ auth: { clients: { [id]: secret } } })
    await signIn(w)
    const issued = [...w.auth.issued]
    const started = await w.desktop.json<Started>(`mcp/servers/${w.id}/oauth/login`, {
      body: { requestId: randomUUID(), clientId: id, clientSecret: secret },
    })
    // The login made as the registered client is over and revoked; nothing of it is on disk.
    expect(w.auth.revoked.toSorted()).toEqual(issued.toSorted())
    const kept = await secretsFile(w.t)
    for (const token of issued) expect(kept).not.toContain(token)
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe(id)
    await comeBack(w, started)
    await settled(w, 'signed-in')
    // The authorization server took the Basic header: both halves decoded to what was typed.
    expect(w.auth.requests.filter(request => request.path === '/token').at(-1)).toMatchObject({ clientAuth: 'basic' })
    expect(await test(w)).toMatchObject({ status: 'ok' })
  })

  it('counts logins being set up among those that wait, and keeps an allowance another server still uses', async () => {
    const w = await world({ auth: { registrationDelayMs: 400 } })
    const servers = [w]
    for (const name of ['two', 'three', 'four', 'five']) servers.push(await another(w, name))
    // Each is confirmed for the authorization server first, with a login that is then given up.
    for (const server of servers) {
      await start(server)
      await server.desktop.json(`mcp/servers/${server.id}/oauth/logout`, { body: { requestId: randomUUID() } })
    }
    const answers = await Promise.all(
      servers.map(server =>
        server.desktop
          .request(`mcp/servers/${server.id}/oauth/login`, { body: { requestId: randomUUID() } })
          .then(async response => ({ ok: response.ok, body: (await response.json()) as { error?: string } })),
      ),
    )
    expect(answers.filter(answer => answer.ok)).toHaveLength(4)
    expect(answers.filter(answer => !answer.ok).map(answer => answer.body.error)).toEqual(['mcp-oauth-busy'])
    // Removing one of them leaves the authorization server's allowance: four others log in there.
    const issuer = new URL(w.auth.origin).host
    await w.desktop.json(`mcp/servers/${servers[4]!.id}`, { method: 'DELETE' })
    expect(await allowed(w.t)).toContain(issuer)
  })

  it('takes back a loopback authorization server’s allowance with its last server, also when that cannot be recorded', async () => {
    const w = await world()
    await signIn(w)
    const issuer = new URL(w.auth.origin).host
    const address = new URL(w.mcp.origin).host
    expect(await allowed(w.t)).toEqual(expect.arrayContaining([issuer, address]))
    failAudit(w.t, action => action === 'policy.changed')
    const gone = await w.desktop.request(`mcp/servers/${w.id}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(gone.headers.get('x-latch-audit')).toBe('failed')
    // The server's own address stays for the person to decide (「同时移除出站许可」); the authorization server's goes.
    const left = await allowed(w.t)
    expect(left).not.toContain(issuer)
    expect(left).toContain(address)
  })
})

describe('what a login writes to the log', () => {
  it('masks the code and the tokens in flight when saving them fails', async () => {
    const w = await world()
    const started = await start(w)
    const callback = await w.auth.authorize(started.authorizationUrl)
    const code = new URL(callback).searchParams.get('code')!
    const saved = JSON.parse(await readFile(join(w.t.dataDir, 'mcp', 'servers.json'), 'utf8'))
    const change = vi.spyOn(McpStore.prototype, 'change')
    cleanups.push(() => change.mockRestore())
    // The write fails with an error that says everything it was about to write, as a careless one might.
    change.mockImplementationOnce(async (_receipt, edit) => {
      const draft = { servers: structuredClone(saved), secrets: { v: 1 as const, servers: {} }, stamp: new Date().toISOString() }
      edit(draft as Parameters<typeof edit>[0])
      throw new Error(`cannot write ${JSON.stringify(draft.secrets)} after code ${code}`)
    })
    await fetch(callback)
    await settled(w, 'failed')
    change.mockRestore()
    const line = w.logs.find(text => text.includes('登录没有保存'))
    expect(line).toBeDefined()
    expect(line).toContain('[redacted]')
    expect(w.auth.issued).toHaveLength(2)
    for (const secret of [code, ...w.auth.issued]) {
      expect(line).not.toContain(secret)
      expect(w.logs.join('\n')).not.toContain(secret)
      expect(w.frames()).not.toContain(secret)
    }
    expect(w.logs.join('\n')).not.toMatch(/fake-(?:access|refresh|code)-/u)
    // Once the login is over they are no longer held anywhere, and nothing was kept.
    expect(await secretsFile(w.t).catch(() => '')).not.toMatch(/fake-(?:access|refresh)-/u)
    await vi.waitFor(() => expect(w.auth.revoked.toSorted()).toEqual(w.auth.issued.toSorted()))
  })
})
