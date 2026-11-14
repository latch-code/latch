// A remote MCP server's login (OAuth 2.1, the MCP authorization spec): the Host is the client. It finds the
// authorization server from the server's own protected-resource metadata (at the bound origin only), reads that
// server's metadata, registers itself where that is offered or uses a client ID a person typed, and runs the
// authorization code flow with PKCE (S256), `state`, `resource` and the `iss` check. The browser comes back to a
// listener on 127.0.0.1 that exists only for that login. Every request goes through the Host's outbound fetch and
// follows no redirect; every endpoint is on the one origin a local confirmation named. Tokens and a client's secret
// are kept by `McpStore` in secrets.json and leave the Host only as `Authorization: Bearer` to the bound address, and
// as the token endpoint's own parameters. See docs/MCP.md.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { McpOAuthFailure, McpOAuthView } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { setKnownSecrets } from '@latch/core/node-kit'
import type { FetchLike } from './egress.ts'
import {
  oauthAddress,
  oauthClientId,
  oauthScope,
  oauthToken,
  oauthView,
  stripLogin,
  type McpHttpRecord,
  type McpOAuthRecord,
  type McpStore,
} from './mcp.ts'

/** How long a login waits for the browser to come back. */
export const LOGIN_TTL_MS = 5 * 60_000
/** One request to the server's metadata or the authorization server. */
const REQUEST_TIMEOUT_MS = 15_000
const MAX_DOCUMENT_BYTES = 64 * 1024
/** Logins waiting at once, every server together. */
const MAX_PENDING = 4
/** A token is renewed this long before it runs out. */
const RENEW_BEFORE_MS = 60_000
/** Refused hits on a login's callback path answered within a second; any more are dropped unanswered. */
const REFUSALS_PER_SECOND = 20
/** `replay` records written for one login: a callback shown again after it was taken. */
const MAX_REPLAY_RECORDS = 3
/** The one text the callback page ever shows, whatever came. */
export const CALLBACK_TEXT = '可以关闭这个页面，回到 Latch。'

type AuditReason = Exclude<McpOAuthFailure, 'refresh' | 'rejected' | 'delete'> | 'replay'

const TEXT: Readonly<Record<McpOAuthFailure | 'replay', string>> = {
  discovery: '这个服务器没有说明去哪里登录',
  resource: '服务器说明的资源与它的地址不符',
  metadata: '读不到授权服务器的说明，或说明与确认的不符',
  endpoint: '授权服务器的端点不在确认过的地址上，或不是 https',
  pkce: '授权服务器不支持 PKCE（S256）',
  'client-required': '这个授权服务器不提供自动注册，请填写 Client ID',
  registration: '授权服务器没有接受注册',
  state: '回调与这次登录不符',
  issuer: '回调不是来自确认过的授权服务器',
  replay: '回调已经用过',
  denied: '登录被拒绝或取消',
  expired: '登录超时',
  exchange: '授权服务器没有发出令牌',
  token: '授权服务器发出的令牌不合格式',
  scope: '授权服务器给出的范围超出确认过的',
  refused: 'Latch 没有连接这个地址',
  unreachable: '无法连接授权服务器',
  cancelled: '登录已取消',
  audit: '记录写不进，登录没有保存',
  refresh: '登录已过期，续期被拒绝',
  delete: '没能删除这台 Mac 上的登录',
  rejected: '服务器不再接受这次登录',
}

/** A login that did not go through, by class. */
export class McpOAuthError extends AppError {
  constructor(readonly reason: AuditReason) {
    super(reason === 'unreachable' ? 502 : 409, `mcp-oauth-${reason}`, TEXT[reason])
  }
}
const fail = (reason: AuditReason) => new McpOAuthError(reason)

const scopeList = z.array(z.string()).max(256)
const resourceDocument = z
  .object({
    resource: z.string().max(2048),
    authorization_servers: z.array(z.string().max(2048)).min(1).max(16),
    scopes_supported: scopeList.optional(),
  })
  .passthrough()
const serverDocument = z
  .object({
    issuer: z.string().max(2048),
    authorization_endpoint: z.string().max(2048),
    token_endpoint: z.string().max(2048),
    registration_endpoint: z.string().max(2048).optional(),
    revocation_endpoint: z.string().max(2048).optional(),
    code_challenge_methods_supported: z.array(z.string()).max(16).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string()).max(32).optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
  })
  .passthrough()
// What the authorization server issues is masked by its exact value wherever the Host writes text, so it must look
// like a credential (token68, 20 characters or more): an ordinary word chosen by a remote party is never taken. The
// answer is read first and its tokens judged after, so a token of another shape is refused in its own words.
const tokenValue = oauthToken
const tokenText = z.string().max(16 * 1024)
const tokenDocument = z
  .object({
    access_token: tokenText,
    token_type: z.string().regex(/^bearer$/iu),
    expires_in: z
      .number()
      .positive()
      .max(10 * 365 * 86_400)
      .optional(),
    refresh_token: tokenText.optional(),
    scope: z.string().max(8192).optional(),
  })
  .passthrough()
const registrationDocument = z
  .object({ client_id: oauthClientId, client_secret: tokenValue.optional(), token_endpoint_auth_method: z.string().max(64).optional() })
  .passthrough()

/** What a server's own metadata says about its login: all read from the bound origin. */
export interface McpOAuthDiscovery {
  /** The authorization server's issuer. Nothing has been sent to it yet. */
  issuer: string
  /** The server's name for itself (RFC 8707): its bound address, or that address's origin. */
  resource: string
  scopes: string[]
}

interface ServerMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  authMethods?: string[]
  /** The server says it sends `iss` with every answer (RFC 9207): a callback without it is refused. */
  issRequired: boolean
}

interface Client {
  id: string
  secret?: string
  registered: boolean
  authMethod: 'none' | 'client_secret_basic' | 'client_secret_post'
}

interface Pending {
  serverId: string
  deviceId: string
  /** The initiating device as the audit log names it. */
  actor: unknown
  /** The server's generation when the login began: 退出登录 or a removal since then ends it. */
  generation: number
  /** Refused hits in the current second, and `replay` records written. */
  refused: { since: number; count: number; replays: number }
  requestId: string
  specHash: string
  issuer: string
  resource: string
  scopes: string[]
  state: string
  verifier: string
  path: string
  redirectUri: string
  client: Client
  metadata: ServerMetadata
  listener: Server
  port: number
  until: number
  timer: NodeJS.Timeout
  /** A callback with the right state came: no other is taken. */
  consumed: boolean
  authorizationUrl: string
}

export interface McpOAuthDeps {
  store: McpStore
  /** The Host's outbound fetch (its egress rules). */
  fetch: FetchLike
  now: () => number
  /**
   * Writes one audit record; rejects when it cannot be written. `actor` is the device that began the login, as the
   * route named it; absent for what the Host does by itself (a renewal, a login given up).
   */
  audit: (
    action: 'mcp.oauth.started' | 'mcp.oauth.authorized' | 'mcp.oauth.failed' | 'mcp.oauth.refresh-failed',
    detail: Record<string, unknown>,
    actor?: unknown,
  ) => Promise<void>
  /**
   * Whether the device that began a login may still manage this Host: a login whose device was removed or lost that
   * right meanwhile is not finished.
   */
  initiatorHolds: (deviceId: string) => boolean
  /** A login changed: clients read the list again. */
  changed: () => void
  /** The Host's log, every line of which is masked by `redactKnownSecrets`. */
  log?: (text: string) => void
  ttlMs?: number
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')

/** `application/x-www-form-urlencoded`, as RFC 6749 asks of a client's ID and secret in HTTP Basic. */
function formEncode(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1)
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Why a request did not get there: the outbound rules (or a redirect, never followed), or the network. */
function unreached(error: unknown): AuditReason {
  const codes = [error, (error as { cause?: unknown } | undefined)?.cause].map(item =>
    item && typeof item === 'object' && 'code' in item ? (item as { code?: unknown }).code : undefined,
  )
  if (codes.includes('egress-denied')) return 'refused'
  const text = [error, (error as { cause?: unknown } | undefined)?.cause].map(item => (item instanceof Error ? item.message : '')).join(' ')
  return /redirect/iu.test(text) ? 'refused' : 'unreachable'
}

async function readText(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(next.value)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    return undefined
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await readText(response)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** A quoted parameter of a `WWW-Authenticate: Bearer` challenge. */
function challengeParam(header: string, name: string): string | undefined {
  return new RegExp(`(?:^|[\\s,])${name}="([^"]{0,2048})"`, 'iu').exec(header)?.[1]
}

/** Scope tokens as kept: each a token of RFC 6749, no more than 64, sorted, once each. Undefined when any is not. */
function scopesOf(values: readonly string[]): string[] | undefined {
  const scopes = [...new Set(values.filter(Boolean))].toSorted()
  return scopes.length <= 64 && scopes.every(scope => oauthScope.safeParse(scope).success) ? scopes : undefined
}

/**
 * The RFC 8414 and OpenID Connect places an issuer's metadata may be, in the order the MCP spec gives: with a path,
 * the well-known part goes before it, then (OpenID Connect) after it.
 */
export function metadataAddresses(issuer: string): string[] {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/+$/u, '')
  return path
    ? [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`]
}

/** Every login of this Host's remote MCP servers. */
export class McpOAuth {
  private readonly pending = new Map<string, Pending>()
  /** Logins being set up, with the listener each has opened so far: ended at once when the server's login ends. */
  private readonly starting = new Map<string, { listener?: Server }>()
  /** Counts each end of a server's login (退出登录, removal, another address): work begun before it keeps nothing. */
  private readonly generations = new Map<string, number>()
  /**
   * Servers whose login was ended while neither the deletion of its tokens nor the mark of that end could be written:
   * the end holds in memory only. With the store's own mark (`isEnded`), no bearer is sent for them.
   */
  private readonly unmarked = new Set<string>()
  /** A code being exchanged and what came back for it, by server: masked in anything logged meanwhile. */
  private readonly inflight = new Map<string, string[]>()

  /** A login that was ended, with its tokens possibly still on this Mac's disk: nothing uses them. */
  private undeleted(serverId: string): boolean {
    return this.unmarked.has(serverId) || this.deps.store.isEnded(serverId)
  }

  /** A login of this server by this device and request that still waits for its browser. */
  waiting(serverId: string, deviceId: string, requestId: string): { authorizationUrl: string; until: string } | undefined {
    const pending = this.pending.get(serverId)
    return pending && pending.deviceId === deviceId && pending.requestId === requestId && !pending.consumed
      ? { authorizationUrl: pending.authorizationUrl, until: new Date(pending.until).toISOString() }
      : undefined
  }
  /** The last attempt that failed, by server, until the next one: 登录失败 and why. In memory only. */
  private readonly failures = new Map<string, McpOAuthFailure>()
  private readonly renewing = new Map<string, Promise<string | undefined>>()
  private readonly ttlMs: number
  private closed = false

  constructor(private readonly deps: McpOAuthDeps) {
    this.ttlMs = Math.min(deps.ttlMs ?? LOGIN_TTL_MS, 10 * 60_000)
  }

  /** A server's login as devices see it, with what only this process knows: a login in progress, the last failure. */
  view(record: McpHttpRecord): McpOAuthView | undefined {
    const saved = oauthView(record)
    // The tokens are still on disk though the person ended the login: said as it is, with a retry.
    if (this.undeleted(record.id)) return { ...saved, state: 'failed', reason: 'delete' }
    const waiting = this.pending.get(record.id)
    if (waiting || this.starting.has(record.id))
      return { ...saved, state: 'signing-in', ...(waiting ? { until: new Date(waiting.until).toISOString() } : {}) }
    const failure = this.failures.get(record.id)
    // A failed attempt shows until the next one, unless a login holds meanwhile.
    if (failure && saved?.state !== 'signed-in') return { ...saved, state: 'failed', reason: failure }
    return saved
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      // Never followed: a redirect is a failure, so nothing of ours goes to an address nobody confirmed.
      return await this.deps.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      throw fail(unreached(error))
    }
  }

  private async document(url: string): Promise<unknown> {
    const response = await this.request(url, { method: 'GET', headers: { accept: 'application/json' } })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    return readJson(response)
  }

  /**
   * What the server says about its login. Every request here goes to the bound origin: the server's own address (to
   * hear its challenge, with the headers that are bound to it) and its protected-resource metadata, which must be on
   * that origin too. The authorization server it names is only named: nothing is sent to it before it is confirmed.
   */
  async discover(record: McpHttpRecord): Promise<McpOAuthDiscovery> {
    const bound = new URL(record.url)
    let challenge = ''
    const probe = await this.request(record.url, {
      method: 'POST',
      headers: {
        ...this.deps.store.headersOf(record.id),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'latch', version: '1' } },
      }),
    })
    await probe.body?.cancel().catch(() => {})
    if (probe.status === 401) challenge = probe.headers.get('www-authenticate') ?? ''
    const named = challengeParam(challenge, 'resource_metadata')
    const path = bound.pathname.replace(/\/+$/u, '')
    let candidates: string[]
    if (named !== undefined) {
      // The server's own pointer, and only on its own origin: metadata elsewhere is another party's word.
      const address = oauthAddress(named)
      if (address === undefined || new URL(address).origin !== bound.origin) throw fail('resource')
      candidates = [address]
    } else {
      candidates = [
        ...(path ? [`${bound.origin}/.well-known/oauth-protected-resource${path}`] : []),
        `${bound.origin}/.well-known/oauth-protected-resource`,
      ]
    }
    let found: z.infer<typeof resourceDocument> | undefined
    for (const candidate of candidates) {
      const parsed = resourceDocument.safeParse(await this.document(candidate))
      if (parsed.success) {
        found = parsed.data
        break
      }
    }
    if (!found) throw fail('discovery')
    // The resource is this server, as the spec's canonical form has it: its own address, or that address's origin.
    // Any other folder of the origin would make the tokens good for more than the server that was confirmed.
    const resource = oauthAddress(found.resource)
    if (resource === undefined) throw fail('resource')
    const plain = (address: string) => address.replace(/\/+$/u, '')
    if (plain(resource) !== plain(record.url) && plain(resource) !== bound.origin) throw fail('resource')
    const issuer = oauthAddress(found.authorization_servers[0]!)
    if (issuer === undefined) throw fail('endpoint')
    const asked = challengeParam(challenge, 'scope')
    const scopes = scopesOf(asked !== undefined ? asked.split(/ +/u) : (found.scopes_supported ?? []))
    if (!scopes) throw fail('discovery')
    return { issuer, resource, scopes }
  }

  /**
   * The authorization server's metadata, read from the confirmed issuer. It must name that issuer exactly, support
   * S256, and keep every endpoint on the issuer's own origin: a document that points anywhere else is refused, so a
   * code, a verifier or a token never goes to an address nobody confirmed.
   */
  private async metadata(issuer: string): Promise<ServerMetadata> {
    const origin = new URL(issuer).origin
    let found: z.infer<typeof serverDocument> | undefined
    for (const address of metadataAddresses(issuer)) {
      const parsed = serverDocument.safeParse(await this.document(address))
      if (parsed.success) {
        found = parsed.data
        break
      }
    }
    if (!found || found.issuer !== issuer) throw fail('metadata')
    const endpoint = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined
      const address = oauthAddress(value, true)
      if (address === undefined || new URL(address).origin !== origin) throw fail('endpoint')
      return address
    }
    const authorizationEndpoint = endpoint(found.authorization_endpoint)!
    const tokenEndpoint = endpoint(found.token_endpoint)!
    const registrationEndpoint = endpoint(found.registration_endpoint)
    const revocationEndpoint = endpoint(found.revocation_endpoint)
    if (!found.code_challenge_methods_supported?.includes('S256')) throw fail('pkce')
    return {
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
      ...(found.token_endpoint_auth_methods_supported ? { authMethods: found.token_endpoint_auth_methods_supported } : {}),
      issRequired: found.authorization_response_iss_parameter_supported === true,
    }
  }

  private async register(metadata: ServerMetadata, redirectUri: string): Promise<Client> {
    const response = await this.request(metadata.registrationEndpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Latch',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    const parsed = response.ok ? registrationDocument.safeParse(await readJson(response)) : undefined
    if (!response.ok) await response.body?.cancel().catch(() => {})
    if (!parsed?.success) throw fail('registration')
    const secret = parsed.data.client_secret
    return {
      id: parsed.data.client_id,
      registered: true,
      ...(secret ? { secret } : {}),
      authMethod: !secret
        ? 'none'
        : parsed.data.token_endpoint_auth_method === 'client_secret_post'
          ? 'client_secret_post'
          : 'client_secret_basic',
    }
  }

  private secretsShown(): void {
    // A verifier, or the secret of a client registered for a login, never belongs in a log line. The state cannot be
    // masked: it is part of the address handed to the browser.
    setKnownSecrets('mcp-oauth', [
      ...[...this.pending.values()].flatMap(item => [item.verifier, ...(item.client.secret ? [item.client.secret] : [])]),
      ...[...this.inflight.values()].flat(),
    ])
  }

  private generation(serverId: string): number {
    return this.generations.get(serverId) ?? 0
  }

  private async failed(serverId: string, reason: AuditReason, actor?: unknown): Promise<void> {
    if (reason !== 'replay') this.failures.set(serverId, reason)
    await this.deps.audit('mcp.oauth.failed', { serverId, reason }, actor).catch(() => {})
    this.deps.changed()
  }

  private drop(pending: Pending): void {
    if (this.pending.get(pending.serverId) === pending) this.pending.delete(pending.serverId)
    clearTimeout(pending.timer)
    pending.listener.close()
    pending.listener.closeAllConnections()
    this.secretsShown()
  }

  /**
   * Starts a login of a server whose authorization server and scopes are confirmed (`record.oauth`): reads the
   * authorization server's metadata, settles the client, writes the record, opens the listener, and answers with the
   * address for the person's browser. The same request again (an answer that never arrived) gets the same address.
   */
  async begin(
    record: McpHttpRecord,
    initiator: { deviceId: string; actor: unknown },
    requestId: string,
  ): Promise<{ authorizationUrl: string; until: string }> {
    const { deviceId, actor } = initiator
    if (this.closed) throw new AppError(503, 'host-closing', 'Host 正在停止')
    const oauth = record.oauth
    if (!oauth) throw new AppError(409, 'mcp-unconfirmed', '这个 MCP 服务器的登录没有经过确认')
    const waiting = this.pending.get(record.id)
    if (waiting && waiting.deviceId === deviceId && waiting.requestId === requestId && !waiting.consumed)
      return { authorizationUrl: waiting.authorizationUrl, until: new Date(waiting.until).toISOString() }
    if (this.starting.has(record.id)) throw new AppError(409, 'mcp-oauth-busy', '正在开始登录')
    // A login whose callback is being exchanged finishes first.
    if (waiting?.consumed) throw new AppError(409, 'mcp-oauth-busy', '正在完成上一次登录')
    if (waiting) await this.cancel(record.id)
    // Logins being set up count as those that wait: each of them opens a listener too.
    if (this.pending.size + this.starting.size >= MAX_PENDING)
      throw new AppError(409, 'mcp-oauth-busy', '同时进行的登录太多，请先完成或取消一个')
    if (this.undeleted(record.id)) throw new AppError(409, 'mcp-oauth-delete', '上一次登录还没能从这台 Mac 上删除，请先重试')
    const setup: { listener?: Server } = {}
    this.starting.set(record.id, setup)
    this.failures.delete(record.id)
    this.deps.changed()
    const generation = this.generation(record.id)
    // 退出登录 or a removal while this is set up: nothing more is started, and what was opened is already closed.
    const stillWanted = () => {
      if (this.generation(record.id) !== generation) throw fail('cancelled')
    }
    let listener: Server | undefined
    try {
      const metadata = await this.metadata(oauth.issuer)
      const typed = oauth.clientId
      if (!typed && !metadata.registrationEndpoint) throw fail('client-required')
      stillWanted()
      // On record before anything listens or anything is handed to a browser: no record, no login.
      try {
        await this.deps.audit('mcp.oauth.started', { serverId: record.id }, actor)
      } catch {
        throw fail('audit')
      }
      stillWanted()
      // A client Latch registers gets a path of its own each time; a typed one registered `/callback` beforehand.
      const path = typed ? '/callback' : `/${base64url(randomBytes(16))}/callback`
      const pending = {} as Pending
      listener = createServer((req, res) => this.callback(pending, req, res))
      listener.on('clientError', (_error, socket) => socket.destroy())
      const server = listener
      setup.listener = listener
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      stillWanted()
      const port = (listener.address() as AddressInfo).port
      const redirectUri = `http://127.0.0.1:${port}${path}`
      const secret = this.deps.store.oauthOf(record.id).clientSecret
      const client: Client = typed
        ? {
            id: typed,
            registered: false,
            ...(secret ? { secret } : {}),
            authMethod: !secret
              ? 'none'
              : metadata.authMethods
                  && !metadata.authMethods.includes('client_secret_basic')
                  && metadata.authMethods.includes('client_secret_post')
                ? 'client_secret_post'
                : 'client_secret_basic',
          }
        : await this.register(metadata, redirectUri)
      stillWanted()
      const latest = this.deps.store.get(record.id)
      if (!latest || latest.transport !== 'http' || latest.specHash !== record.specHash || !latest.enabled)
        throw new AppError(409, 'mcp-changed', 'MCP 服务器已被修改，请刷新后重试')
      const state = base64url(randomBytes(32))
      const verifier = base64url(randomBytes(32))
      const url = new URL(metadata.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', client.id)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('resource', oauth.resource)
      if (oauth.scopes.length) url.searchParams.set('scope', oauth.scopes.join(' '))
      const until = this.deps.now() + this.ttlMs
      Object.assign(pending, {
        serverId: record.id,
        deviceId,
        actor,
        generation,
        refused: { since: 0, count: 0, replays: 0 },
        requestId,
        specHash: record.specHash,
        issuer: oauth.issuer,
        resource: oauth.resource,
        scopes: [...oauth.scopes],
        state,
        verifier,
        path,
        redirectUri,
        client,
        metadata,
        listener,
        port,
        until,
        consumed: false,
        authorizationUrl: url.href,
        timer: setTimeout(() => {
          if (this.pending.get(record.id) !== pending || pending.consumed) return
          this.drop(pending)
          void this.failed(record.id, 'expired', actor)
        }, this.ttlMs),
      } satisfies Pending)
      pending.timer.unref()
      this.pending.set(record.id, pending)
      this.secretsShown()
      listener = undefined
      return { authorizationUrl: pending.authorizationUrl, until: new Date(until).toISOString() }
    } catch (error) {
      listener?.close()
      listener?.closeAllConnections()
      if (error instanceof McpOAuthError) {
        await this.failed(record.id, error.reason, actor)
        // Given up because the login was ended: that is no failure to show.
        if (error.reason === 'cancelled') this.failures.delete(record.id)
      }
      throw error
    } finally {
      if (this.starting.get(record.id) === setup) this.starting.delete(record.id)
      this.deps.changed()
    }
  }

  /** Ends a login in progress; nothing it started is kept. */
  async cancel(serverId: string): Promise<boolean> {
    const pending = this.pending.get(serverId)
    if (!pending || pending.consumed) return false
    this.drop(pending)
    await this.failed(serverId, 'cancelled', pending.actor)
    this.failures.delete(serverId)
    return true
  }

  /**
   * The browser's return. Only a GET of this login's own path, to this listener by its address, counts. A request
   * without this login's state is anyone's (another process, a page scanning loopback): it is answered 400 and
   * changes nothing, a bounded number of times a second and with no record, so it can neither end the login nor fill
   * the audit log. A request with the state is the browser's: it must carry the issuer when the server says it sends
   * one or sends one anyway, and the first such request is the only one taken. The page says the same fixed words
   * whatever happened.
   */
  private callback(pending: Pending, req: IncomingMessage, res: ServerResponse): void {
    const answer = (status: number) => {
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        connection: 'close',
      })
      res.end(status === 404 ? 'Not found' : CALLBACK_TEXT)
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${pending.port}`)
    } catch {
      return answer(404)
    }
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${pending.port}` || url.pathname !== pending.path || !pending.serverId)
      return answer(404)
    const refuse = (reason: AuditReason) => {
      answer(400)
      this.drop(pending)
      void this.failed(pending.serverId, reason, pending.actor)
    }
    const one = (name: string) => {
      const values = url.searchParams.getAll(name)
      return values.length === 1 ? values[0]! : undefined
    }
    const state = one('state')
    const known = state !== undefined && sameText(state, pending.state)
    const taken = pending.consumed || this.pending.get(pending.serverId) !== pending
    if (!known || taken || this.deps.now() >= pending.until) {
      const now = Date.now()
      if (now - pending.refused.since >= 1000) pending.refused = { ...pending.refused, since: now, count: 0 }
      if (++pending.refused.count > REFUSALS_PER_SECOND) {
        req.socket.destroy()
        return
      }
      answer(400)
      // This login's own callback shown again after it was taken: on record, a few times at most.
      if (known && taken && pending.refused.replays++ < MAX_REPLAY_RECORDS) void this.failed(pending.serverId, 'replay', pending.actor)
      return
    }
    const iss = one('iss')
    // RFC 9207: an answer from another issuer is not handled, and nothing of it is shown.
    if (iss !== undefined ? iss !== pending.issuer : pending.metadata.issRequired || url.searchParams.has('iss')) return refuse('issuer')
    if (url.searchParams.has('error')) return refuse('denied')
    const code = one('code')
    if (code === undefined || code.length === 0 || code.length > 4096) return refuse('exchange')
    pending.consumed = true
    clearTimeout(pending.timer)
    answer(200)
    void this.finish(pending, code).finally(() => this.drop(pending))
  }

  private async tokens(
    endpoint: string,
    client: Pick<Client, 'id' | 'secret' | 'authMethod'>,
    params: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    const form = new URLSearchParams(params)
    if (client.authMethod === 'client_secret_basic' && client.secret !== undefined)
      // RFC 6749 §2.3.1: each half is form-encoded before the two are joined.
      headers.authorization = `Basic ${Buffer.from(`${formEncode(client.id)}:${formEncode(client.secret)}`).toString('base64')}`
    else {
      form.set('client_id', client.id)
      if (client.authMethod === 'client_secret_post' && client.secret !== undefined) form.set('client_secret', client.secret)
    }
    const response = await this.request(endpoint, { method: 'POST', headers, body: form.toString() })
    return { status: response.status, body: await readJson(response) }
  }

  /** The code for tokens, kept only when the record of it is written and the server is still the one that began. */
  private async finish(pending: Pending, code: string): Promise<void> {
    const id = pending.serverId
    /** Tokens the authorization server issued that are not kept after all: revoked where it can be asked. */
    let unkept: string[] = []
    // The code is this login's alone until it is exchanged: masked in anything written meanwhile.
    this.inflight.set(id, [code])
    this.secretsShown()
    try {
      const { status, body } = await this.tokens(pending.metadata.tokenEndpoint, pending.client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        resource: pending.resource,
      })
      const parsed = status === 200 ? tokenDocument.safeParse(body) : undefined
      if (!parsed?.success) throw fail('exchange')
      if (!tokenValue.safeParse(parsed.data.access_token).success) throw fail('token')
      if (parsed.data.refresh_token !== undefined && !tokenValue.safeParse(parsed.data.refresh_token).success) throw fail('token')
      this.inflight.set(id, [code, parsed.data.access_token, ...(parsed.data.refresh_token ? [parsed.data.refresh_token] : [])])
      this.secretsShown()
      unkept = [...(parsed.data.refresh_token ? [parsed.data.refresh_token] : []), parsed.data.access_token]
      const granted = parsed.data.scope === undefined ? undefined : scopesOf(parsed.data.scope.split(/ +/u))
      // Asked for named scopes and given others: more than was confirmed is never kept.
      if (
        parsed.data.scope !== undefined
        && pending.scopes.length > 0
        && (!granted || granted.some(scope => !pending.scopes.includes(scope)))
      )
        throw fail('scope')
      const record = this.deps.store.get(id)
      if (
        !record
        || record.transport !== 'http'
        || !record.enabled
        || record.specHash !== pending.specHash
        || record.oauth?.issuer !== pending.issuer
        || this.generation(id) !== pending.generation
        || !this.deps.initiatorHolds(pending.deviceId)
      )
        throw fail('cancelled')
      try {
        await this.deps.audit(
          'mcp.oauth.authorized',
          { serverId: id, registered: pending.client.registered, renewable: parsed.data.refresh_token !== undefined },
          pending.actor,
        )
      } catch {
        throw fail('audit')
      }
      const expiresAt =
        parsed.data.expires_in === undefined ? undefined : new Date(this.deps.now() + parsed.data.expires_in * 1000).toISOString()
      // A login this one replaces: its tokens are handed back once the new ones are kept.
      const before = { login: record.oauth?.login, held: this.deps.store.oauthOf(id) }
      await this.deps.store.change(undefined, ({ servers, secrets, stamp }) => {
        const current = servers.servers.find(item => item.id === id)
        // 退出登录 or a removal while the code was exchanged: what came back is not kept.
        if (
          !current
          || current.transport !== 'http'
          || current.specHash !== pending.specHash
          || !current.oauth
          || this.generation(id) !== pending.generation
        )
          throw fail('cancelled')
        current.oauth.login = {
          state: 'signed-in',
          clientId: pending.client.id,
          registered: pending.client.registered,
          authMethod: pending.client.authMethod,
          tokenEndpoint: pending.metadata.tokenEndpoint,
          ...(pending.metadata.revocationEndpoint ? { revocationEndpoint: pending.metadata.revocationEndpoint } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          at: stamp,
        }
        // What it said while it had no login no longer holds.
        if (current.report?.reason === 'auth-required') delete current.report
        const entry = (secrets.servers[id] ??= { env: {} })
        entry.oauth = {
          accessToken: parsed.data.access_token,
          ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
          ...(pending.client.secret ? { clientSecret: pending.client.secret } : {}),
        }
        return id
      })
      unkept = []
      this.failures.delete(id)
      this.deps.changed()
      const old = before.login?.revocationEndpoint
      if (before.login && old && new URL(old).origin === new URL(pending.issuer).origin)
        for (const token of [before.held.refreshToken, before.held.accessToken])
          if (token)
            await this.tokens(
              old,
              {
                id: before.login.clientId,
                authMethod: before.login.authMethod,
                ...(before.held.clientSecret ? { secret: before.held.clientSecret } : {}),
              },
              { token },
            ).catch(() => {})
    } catch (error) {
      const reason = error instanceof McpOAuthError ? error.reason : 'exchange'
      // Something of the Host's own went wrong (a file that could not be written): said in the log, masked there.
      if (!(error instanceof McpOAuthError))
        this.deps.log?.(`MCP 服务器的登录没有保存：${error instanceof Error ? error.message : String(error)}`)
      await this.failed(id, reason, pending.actor)
      // Ended by the person meanwhile: nothing failed.
      if (reason === 'cancelled' && this.generation(id) !== pending.generation) this.failures.delete(id)
    }
    const revocation = pending.metadata.revocationEndpoint
    if (revocation) for (const token of unkept) await this.tokens(revocation, pending.client, { token }).catch(() => {})
    this.inflight.delete(id)
    this.secretsShown()
  }

  /**
   * The access token for a server's requests, for `McpRemoteSession`: renewed first when it is about to run out, or
   * (`renew`) because the server refused it. Undefined when there is no login that holds.
   */
  authorization(serverId: string): (renew: boolean) => Promise<string | undefined> {
    return async renew => {
      const record = this.deps.store.get(serverId)
      const login = record?.transport === 'http' ? record.oauth?.login : undefined
      if (!login || login.state !== 'signed-in' || this.undeleted(serverId)) return undefined
      const token = this.deps.store.oauthOf(serverId).accessToken
      const due = login.expiresAt !== undefined && Date.parse(login.expiresAt) - RENEW_BEFORE_MS <= this.deps.now()
      if (!renew && !due) return token
      const renewed = await this.renew(serverId)
      // Not yet run out and the authorization server could not be reached: what is held may still do.
      return (
        renewed ?? (renew ? undefined : login.expiresAt !== undefined && Date.parse(login.expiresAt) <= this.deps.now() ? undefined : token)
      )
    }
  }

  private renew(serverId: string): Promise<string | undefined> {
    let running = this.renewing.get(serverId)
    if (!running) {
      running = this.renewOnce(serverId).finally(() => this.renewing.delete(serverId))
      this.renewing.set(serverId, running)
    }
    return running
  }

  private async renewOnce(serverId: string): Promise<string | undefined> {
    const record = this.deps.store.get(serverId)
    const oauth = record?.transport === 'http' ? record.oauth : undefined
    const login = oauth?.login
    if (!oauth || !login || login.state !== 'signed-in' || this.undeleted(serverId)) return undefined
    const generation = this.generation(serverId)
    const held = this.deps.store.oauthOf(serverId)
    if (!held.refreshToken) {
      await this.relogin(serverId, 'expired')
      return undefined
    }
    // The endpoint kept with the login is on the confirmed issuer's origin, or it is not used.
    if (new URL(login.tokenEndpoint).origin !== new URL(oauth.issuer).origin) {
      await this.relogin(serverId, 'refresh')
      return undefined
    }
    let answer: { status: number; body: unknown }
    try {
      answer = await this.tokens(
        login.tokenEndpoint,
        { id: login.clientId, authMethod: login.authMethod, ...(held.clientSecret ? { secret: held.clientSecret } : {}) },
        { grant_type: 'refresh_token', refresh_token: held.refreshToken, resource: oauth.resource },
      )
    } catch {
      return undefined
    }
    const read = answer.status === 200 ? tokenDocument.safeParse(answer.body) : undefined
    const shaped =
      read?.success
      && tokenValue.safeParse(read.data.access_token).success
      && (read.data.refresh_token === undefined || tokenValue.safeParse(read.data.refresh_token).success)
    const parsed = shaped ? read : undefined
    if (!parsed?.success) {
      // Refused (400, 401), not a token answer, or tokens that are not shaped like one: the login is over. A server error is tried again next time.
      if (answer.status >= 500) return undefined
      await this.deps.audit('mcp.oauth.refresh-failed', { serverId }).catch(() => {})
      await this.relogin(serverId, 'refresh')
      return undefined
    }
    const client = { id: login.clientId, authMethod: login.authMethod, ...(held.clientSecret ? { secret: held.clientSecret } : {}) }
    /** What a renewal brought that is not kept: handed back where the authorization server takes it. */
    const handBack = async () => {
      const revocation = login.revocationEndpoint
      if (!revocation || new URL(revocation).origin !== new URL(oauth.issuer).origin) return
      for (const token of [...(parsed.data.refresh_token ? [parsed.data.refresh_token] : []), parsed.data.access_token])
        await this.tokens(revocation, client, { token }).catch(() => {})
    }
    // As at the login: more than the confirmed scopes is never kept, and never widened without the person.
    const granted = parsed.data.scope === undefined ? undefined : scopesOf(parsed.data.scope.split(/ +/u))
    if (parsed.data.scope !== undefined && oauth.scopes.length > 0 && (!granted || granted.some(scope => !oauth.scopes.includes(scope)))) {
      await this.deps.audit('mcp.oauth.refresh-failed', { serverId }).catch(() => {})
      await this.relogin(serverId, 'scope', true)
      await handBack()
      return undefined
    }
    const expiresAt =
      parsed.data.expires_in === undefined ? undefined : new Date(this.deps.now() + parsed.data.expires_in * 1000).toISOString()
    let kept = false
    await this.deps.store
      .change(undefined, ({ servers, secrets }) => {
        const current = servers.servers.find(item => item.id === serverId)
        const entry = secrets.servers[serverId]
        // Ended, or logged in anew, while the renewal was on its way: what came back is not kept.
        if (
          current?.transport !== 'http'
          || this.generation(serverId) !== generation
          || current.oauth?.login?.at !== login.at
          || current.oauth.login.state !== 'signed-in'
          || !entry?.oauth
        )
          return serverId
        if (expiresAt) current.oauth.login.expiresAt = expiresAt
        else delete current.oauth.login.expiresAt
        entry.oauth.accessToken = parsed.data.access_token
        // A rotated refresh token replaces the old one; none in the answer keeps it.
        if (parsed.data.refresh_token) entry.oauth.refreshToken = parsed.data.refresh_token
        kept = true
        return serverId
      })
      .catch(() => {})
    this.deps.changed()
    if (!kept) await handBack()
    return kept ? parsed.data.access_token : undefined
  }

  /** The login no longer holds: 需要重新登录. The access token goes; a refresh token stays only to be revoked. */
  async relogin(
    serverId: string,
    reason: NonNullable<NonNullable<McpOAuthRecord['login']>['reason']>,
    dropRefresh = reason === 'refresh',
  ): Promise<void> {
    await this.deps.store
      .change(undefined, ({ servers, secrets }) => {
        const current = servers.servers.find(item => item.id === serverId)
        if (current?.transport !== 'http' || !current.oauth?.login || current.oauth.login.state === 'relogin') return serverId
        current.oauth.login.state = 'relogin'
        current.oauth.login.reason = reason
        delete current.oauth.login.expiresAt
        const held = secrets.servers[serverId]?.oauth
        if (held) {
          delete held.accessToken
          if (dropRefresh) delete held.refreshToken
        }
        return serverId
      })
      .catch(() => {})
    this.deps.changed()
  }

  /**
   * What ending a server's login will ask of its authorization server, read now and sent later: `revoke` asks it to
   * revoke the tokens held at this moment (RFC 7009), bounded and best effort, only at the confirmed issuer's origin.
   * It changes nothing here; the caller runs it outside any lock, after the tokens are gone from this Mac.
   */
  snapshot(serverId: string): () => Promise<'revoked' | 'failed' | 'unsupported' | 'none'> {
    const record = this.deps.store.get(serverId)
    const oauth = record?.transport === 'http' ? record.oauth : undefined
    const login = oauth?.login
    const held = this.deps.store.oauthOf(serverId)
    const tokens = [
      ...(held.refreshToken ? [{ token: held.refreshToken, hint: 'refresh_token' }] : []),
      ...(held.accessToken ? [{ token: held.accessToken, hint: 'access_token' }] : []),
    ]
    return async () => {
      if (!oauth || !login || tokens.length === 0) return 'none'
      if (!login.revocationEndpoint) return 'unsupported'
      // The endpoint kept with the login is on the confirmed issuer's origin, or nothing is sent to it.
      if (new URL(login.revocationEndpoint).origin !== new URL(oauth.issuer).origin) return 'failed'
      let result: 'revoked' | 'failed' = 'revoked'
      for (const { token, hint } of tokens) {
        const ok = await this.tokens(
          login.revocationEndpoint,
          { id: login.clientId, authMethod: login.authMethod, ...(held.clientSecret ? { secret: held.clientSecret } : {}) },
          { token, token_type_hint: hint },
        ).then(
          answer => answer.status === 200,
          () => false,
        )
        if (!ok) result = 'failed'
      }
      return result
    }
  }

  /**
   * A server's login is over, as far as work in progress goes: a login being set up or waiting is given up and its
   * listener closed at once, and a code being exchanged or a renewal on its way will keep nothing of what it brings.
   */
  async ended(serverId: string): Promise<void> {
    this.generations.set(serverId, this.generation(serverId) + 1)
    const setup = this.starting.get(serverId)
    if (setup?.listener) {
      setup.listener.close()
      setup.listener.closeAllConnections()
    }
    await this.cancel(serverId).catch(() => false)
    this.failures.delete(serverId)
  }

  /**
   * Ends a server's login on this Mac, at once: work in progress keeps nothing (`ended`), no bearer is sent again, and
   * the tokens are deleted here. `deleted` is false when that deletion could not be written: the end is then marked
   * apart from the two files so that it outlives a restart (`McpStore.markEnded`), and the login shows 「没能删除这台
   * Mac 上的登录」 until a retry succeeds. `revoke` is `snapshot`'s, for the caller to run outside any lock. Never throws.
   */
  async forget(serverId: string): Promise<{ deleted: boolean; revoke: () => Promise<'revoked' | 'failed' | 'unsupported' | 'none'> }> {
    const revoke = this.snapshot(serverId)
    await this.ended(serverId)
    // From here no request carries the token, whether or not anything can be written.
    this.unmarked.add(serverId)
    const deleted = await this.deps.store
      .change(undefined, ({ servers, secrets }) => {
        stripLogin(servers, secrets, serverId)
        return serverId
      })
      .then(
        () => true,
        () => false,
      )
    if (deleted) {
      this.unmarked.delete(serverId)
      await this.deps.store.clearEnded(serverId)
    } else {
      // The end itself goes on disk, so a restart does not bring the login back.
      await this.deps.store.markEnded(serverId).then(
        () => this.unmarked.delete(serverId),
        () => {},
      )
    }
    this.deps.changed()
    return { deleted, revoke }
  }

  /** The server itself is gone from this Mac, its tokens with it: nothing is left to say about it. */
  removed(serverId: string): void {
    this.unmarked.delete(serverId)
    this.failures.delete(serverId)
    void this.deps.store.clearEnded(serverId)
  }

  /** The Host is stopping: every listener closes; logins in progress are simply gone. */
  close(): void {
    this.closed = true
    for (const pending of [...this.pending.values()]) this.drop(pending)
  }
}
