/**
 * An in-process OAuth 2.1 authorization server, on 127.0.0.1 only, for a protected `startFakeMcpHttp` (its `protect`
 * option): RFC 8414 metadata, dynamic registration, the authorization code flow with PKCE (S256, checked), refresh,
 * and revocation. `/authorize` stands in for the person's browser: it answers with the redirect a real server would
 * send after the login, which a test follows by hand (`authorize`). Scripted bad cases: a wrong or missing `iss`,
 * metadata that points to another origin or to plain http elsewhere, no PKCE, no registration, a refresh that is
 * refused, tokens that run out at once. It keeps what it issued and what it was sent, so a test can prove where a
 * token went; it never logs one.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeOAuthOptions {
  /** A path after the origin in the issuer (`/tenant`); metadata is then served where RFC 8414 puts it. */
  issuerPath?: string
  /** Changes the metadata document before it is served (endpoints elsewhere, no `S256`, another issuer). */
  metadata?: (document: Record<string, unknown>) => Record<string, unknown>
  /** No registration endpoint: a client ID must be typed (`clients`). */
  registration?: false
  /** Client IDs that exist without registration, with the secret each must show (or none). */
  clients?: Record<string, string | undefined>
  /** The `iss` the redirect carries: the issuer (default), another one, or none. */
  iss?: 'wrong' | 'omit'
  /** Says in the metadata that `iss` always comes (RFC 9207). */
  issAdvertised?: boolean
  /** Seconds an access token lasts, as `expires_in`; default 3600. */
  expiresIn?: number
  /** No refresh token is issued. */
  noRefresh?: boolean
  /** Every refresh is refused with `invalid_grant`. */
  refreshFails?: boolean
  /** The token endpoint waits this long before it answers. */
  tokenDelayMs?: number
  /** A renewal is carried out at once (the old refresh token ends, new tokens exist) and answered this much later. */
  refreshDelayMs?: number
  /** The `scope` the token answer names, instead of what was asked. */
  grantScope?: string
  /** The `scope` a renewal's answer names, instead of what the login was given. */
  refreshScope?: string
  /** The access token every answer carries, instead of a random one (a word that is no credential, say). */
  accessToken?: string
  /** A `client_secret` the registration answer carries. */
  registrationSecret?: string
  /** The registration endpoint waits this long before it answers. */
  registrationDelayMs?: number
  /** No revocation endpoint; or one that answers 503. */
  revocation?: false | 'fails'
}

export interface FakeOAuthRequest {
  path: string
  method: string
  /** Parameter names of a form or query, sorted. */
  params: string[]
  /** Chosen values that are no secret: `grant_type`, `resource`, `scope`, `redirect_uri`, `client_id`. */
  values: Record<string, string>
  /** Whether the client showed its secret, and how. */
  clientAuth: 'none' | 'basic' | 'post'
}

export interface FakeOAuth {
  origin: string
  issuer: string
  requests: FakeOAuthRequest[]
  /** Clients registered dynamically, with the redirect URIs each gave. */
  registered: Array<{ clientId: string; redirectUris: string[] }>
  /** Every access and refresh token issued, in order. */
  issued: string[]
  revoked: string[]
  /** Whether an access token is one this server issued and still stands. */
  valid(token: string): boolean
  /** Ends every access token now, as time would: the next use is refused, a refresh gets a new one. */
  expireAccess(): void
  /**
   * The person's browser: asks `/authorize` and returns the redirect back to the client (the callback's address),
   * without following it.
   */
  authorize(authorizationUrl: string, change?: (callback: URL) => void): Promise<string>
  close(): Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      text += chunk
      if (text.length > 256 * 1024) request.destroy(new Error('request too large'))
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}

const PLAIN = ['grant_type', 'resource', 'scope', 'redirect_uri', 'client_id', 'token_type_hint', 'code_challenge_method', 'response_type']

export async function startFakeOAuth(options: FakeOAuthOptions = {}): Promise<FakeOAuth> {
  const requests: FakeOAuthRequest[] = []
  const registered: Array<{ clientId: string; redirectUris: string[] }> = []
  const issued: string[] = []
  const revoked: string[] = []
  const access = new Set<string>()
  const refresh = new Map<string, { clientId: string; scope: string }>()
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; scope: string; resource: string }>()
  const clients = new Map<string, { secret?: string; redirectUris?: string[] }>(
    Object.entries(options.clients ?? {}).map(([id, secret]) => [id, secret === undefined ? {} : { secret }]),
  )
  const mint = (kind: string) => `fake-${kind}-${randomBytes(18).toString('base64url')}`
  let origin = ''
  let issuer = ''

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      const text = req.method === 'POST' ? await readBody(req) : ''
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const form = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
        ? new URLSearchParams(text)
        : url.searchParams
      const basic = /^Basic (.+)$/u.exec(req.headers.authorization ?? '')?.[1]
      const [basicId, basicSecret] = basic
        ? Buffer.from(basic, 'base64')
            .toString('utf8')
            .split(':')
            // Each half is form-encoded (RFC 6749 §2.3.1): `+` is a space.
            .map(part => decodeURIComponent(part.replaceAll('+', ' ')))
        : []
      requests.push({
        path: url.pathname,
        method: req.method ?? '',
        params: [...new Set(form.keys())].toSorted(),
        values: Object.fromEntries(PLAIN.flatMap(name => (form.has(name) ? [[name, form.get(name)!]] : []))),
        clientAuth: basic ? 'basic' : form.has('client_secret') ? 'post' : 'none',
      })
      const path = options.issuerPath ?? ''
      if (
        req.method === 'GET'
        && (url.pathname === `/.well-known/oauth-authorization-server${path}`
          || url.pathname === `${path}/.well-known/openid-configuration`)
      ) {
        const document: Record<string, unknown> = {
          issuer,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.registration === false ? {} : { registration_endpoint: `${origin}/register` }),
          ...(options.revocation === false ? {} : { revocation_endpoint: `${origin}/revoke` }),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
          ...(options.issAdvertised ? { authorization_response_iss_parameter_supported: true } : {}),
        }
        json(200, options.metadata ? options.metadata(document) : document)
        return
      }
      if (req.method === 'POST' && url.pathname === '/register' && options.registration !== false) {
        const body = JSON.parse(text) as { redirect_uris?: string[] }
        const clientId = `fake-client-${registered.length + 1}`
        registered.push({ clientId, redirectUris: body.redirect_uris ?? [] })
        clients.set(clientId, {
          redirectUris: body.redirect_uris ?? [],
          ...(options.registrationSecret !== undefined ? { secret: options.registrationSecret } : {}),
        })
        if (options.registrationDelayMs) await new Promise(resolve => setTimeout(resolve, options.registrationDelayMs))
        json(201, {
          client_id: clientId,
          redirect_uris: body.redirect_uris ?? [],
          ...(options.registrationSecret !== undefined
            ? { client_secret: options.registrationSecret, token_endpoint_auth_method: 'client_secret_basic' }
            : { token_endpoint_auth_method: 'none' }),
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const clientId = url.searchParams.get('client_id') ?? ''
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const client = clients.get(clientId)
        const back = (() => {
          try {
            return new URL(redirectUri)
          } catch {
            return undefined
          }
        })()
        // A registered client's redirect must be the one it registered; a typed one's, this Mac's loopback `/callback`.
        const allowed =
          client
          && back
          && (client.redirectUris
            ? client.redirectUris.includes(redirectUri)
            : back.hostname === '127.0.0.1' && back.pathname === '/callback')
        if (
          !allowed
          || url.searchParams.get('response_type') !== 'code'
          || url.searchParams.get('code_challenge_method') !== 'S256'
          || !url.searchParams.get('code_challenge')
          || !url.searchParams.get('state')
        ) {
          json(400, { error: 'invalid_request' })
          return
        }
        const code = mint('code')
        codes.set(code, {
          clientId,
          redirectUri,
          challenge: url.searchParams.get('code_challenge')!,
          scope: url.searchParams.get('scope') ?? '',
          resource: url.searchParams.get('resource') ?? '',
        })
        back.searchParams.set('code', code)
        back.searchParams.set('state', url.searchParams.get('state')!)
        if (options.iss === 'wrong') back.searchParams.set('iss', 'https://another-issuer.example')
        else if (options.iss !== 'omit') back.searchParams.set('iss', issuer)
        res.writeHead(302, { location: back.href, 'cache-control': 'no-store' })
        res.end()
        return
      }
      const clientId = basicId ?? form.get('client_id') ?? ''
      const known = clients.get(clientId)
      const shown = basicSecret ?? form.get('client_secret') ?? undefined
      const authentic = known !== undefined && known.secret === shown
      if (req.method === 'POST' && url.pathname === '/token') {
        if (options.tokenDelayMs) await new Promise(resolve => setTimeout(resolve, options.tokenDelayMs))
        if (!authentic) {
          json(401, { error: 'invalid_client' })
          return
        }
        const answer = (scope: string, renewable: boolean, delayMs = 0) => {
          const accessToken = options.accessToken ?? mint('access')
          access.add(accessToken)
          issued.push(accessToken)
          let refreshToken: string | undefined
          if (renewable && !options.noRefresh) {
            refreshToken = mint('refresh')
            refresh.set(refreshToken, { clientId, scope })
            issued.push(refreshToken)
          }
          const send = () =>
            json(200, {
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: options.expiresIn ?? 3600,
              ...(refreshToken ? { refresh_token: refreshToken } : {}),
              ...((options.grantScope ?? scope) ? { scope: options.grantScope ?? scope } : {}),
            })
          if (delayMs) setTimeout(send, delayMs)
          else send()
        }
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code') ?? ''
          const grant = codes.get(code)
          // One use: a code shown twice is refused the second time.
          codes.delete(code)
          const challenge = createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url')
          if (!grant || grant.clientId !== clientId || grant.redirectUri !== form.get('redirect_uri') || grant.challenge !== challenge) {
            json(400, { error: 'invalid_grant' })
            return
          }
          answer(grant.scope, true)
          return
        }
        if (form.get('grant_type') === 'refresh_token') {
          const token = form.get('refresh_token') ?? ''
          const grant = refresh.get(token)
          if (options.refreshFails || !grant || grant.clientId !== clientId) {
            json(400, { error: 'invalid_grant' })
            return
          }
          // Rotated: the old refresh token ends with its use.
          refresh.delete(token)
          answer(options.refreshScope ?? grant.scope, true, options.refreshDelayMs)
          return
        }
        json(400, { error: 'unsupported_grant_type' })
        return
      }
      if (req.method === 'POST' && url.pathname === '/revoke' && options.revocation !== false) {
        if (options.revocation === 'fails') {
          json(503, { error: 'temporarily_unavailable' })
          return
        }
        const token = form.get('token') ?? ''
        revoked.push(token)
        access.delete(token)
        refresh.delete(token)
        res.writeHead(200)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  issuer = `${origin}${options.issuerPath ?? ''}`
  return {
    origin,
    issuer,
    requests,
    registered,
    issued,
    revoked,
    valid: token => access.has(token),
    expireAccess: () => access.clear(),
    async authorize(authorizationUrl, change) {
      const response = await fetch(authorizationUrl, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status !== 302 || !location) throw new Error(`the fake authorization server refused the request (${response.status})`)
      const callback = new URL(location)
      change?.(callback)
      return callback.href
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
