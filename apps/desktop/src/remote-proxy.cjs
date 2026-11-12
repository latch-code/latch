'use strict'
// Another computer's Host, reached over its HTTPS entry. Each one gets its own origin `latch://h-<hostId>/` in its own
// session partition; main forwards that origin's requests to the Host and attaches only that Host's credential, picked
// by the request's origin and never by which computer is chosen.
// What binds the credential to that Host is its certificate: the system's trust store must accept it (there is no way
// to trust one anyway), and every request carrying a credential is made only after the handshake showed the exact
// certificate (SHA-256) recorded when the computer was added; any other certificate ends the connection before a byte
// of the request is written. The origin and that pin live in the encrypted credential record (credentials.cjs), never
// only in computers.json. The hostId in the public health answer guards against a different Latch at the address.
// A new certificate (a renewal) is pinned only when the person asks and the Host proves it serves it: a signature by
// the Host's identity key, whose SHA-256 is the hostId, over the certificate the Host itself serves on that connection
// (`POST /host-proof`). A server without that key cannot sign, and one that relays to the real Host gets a signature
// over the real certificate. Nothing here stops a party that holds the pinned certificate's private key, or the Host's
// identity key.
// The exported helpers are pure where they can be, so they can be tested without Electron.
const https = require('node:https')
const tls = require('node:tls')
const { createHash, createPublicKey, randomBytes, verify: verifySignature } = require('node:crypto')
const { isIP } = require('node:net')
const { exchange, readBody } = require('./host.cjs')
const { base32, generateDeviceKey, enrollSigningText, renewSigningText } = require('./credentials.cjs')
const {
  CLEARING_CODES,
  FILE_EDIT_BODY_LIMIT,
  FILE_EDIT_PATH,
  PLUGIN_DRAFT_BODY_LIMIT,
  REQUEST_BODY_LIMIT,
  UPLOAD_BODY_LIMIT,
  ProxyError,
  authFailureAction,
  bufferUpstream,
  bufferedResponse,
  classifyRoute,
  appFrameCsp,
  discardRequestBody,
  errorResponse,
  htmlErrorPage,
  HTML_CSP,
  isAppFrameUrl,
  previewFrameCsp,
  previewFrameName,
  readRequestBody,
  streamedResponse,
  upstreamTarget,
} = require('./proxy.cjs')

const HOST_ID = /^[a-z2-7]{52}$/
const INVITATION = /^lpi1-[A-Z2-7]{26}$/
/** An invitation link as another computer's 「复制链接」 or `pnpm latch device invite --code-file` writes it. */
const LINK_LIMIT = 2048
const CONTROL_TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 10_000
/** A verified hostId is trusted this long; a connection error ends it sooner. Every request still checks the pin. */
const VERIFY_TTL_MS = 60_000
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000
const RENEW_RETRY_MS = 60_000
const RENEW_RETRY_MAX_MS = 10 * 60 * 1000
const FIRST_USE_PATH = '/link/api/audit/head'
const SNAPSHOT_LIMIT = 8 * 1024 * 1024
/** Header names a page's request never carries to another computer: its cookies and credentials, and fetch metadata. */
const DROPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'origin',
  'referer',
  'forwarded',
  'content-length',
  'expect',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** Node's names for a certificate the system does not trust or that does not name the address. */
const CERTIFICATE_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|ERR_TLS_|HOSTNAME|ALTNAME/u
const REMOTE_MANAGED = '在这台电脑上由 Latch 应用处理'
const HANDSHAKE_TIMEOUT_MS = 15_000
/** The error code of a handshake that showed another certificate than the pinned one. */
const CERTIFICATE_CHANGED = 'ERR_LATCH_CERTIFICATE_CHANGED'
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u

/** What a remote request failed on, for the computer's state; `message` is for the page. */
class RemoteError extends Error {
  /** @param {'offline' | 'cert-error' | 'cert-changed' | 'wrong-host' | 'outdated' | 'revoked'} state */
  constructor(state, message) {
    super(message)
    this.state = state
  }
}

const STATE_MESSAGES = {
  offline: '无法连接到这台电脑，请确认它已开机并运行 Latch。',
  'cert-error': '这台电脑的 HTTPS 证书不受信任或与地址不符，已停止连接。',
  'cert-changed': '这台电脑的 HTTPS 证书和添加时不同，在这台 Mac 的 设置 › 电脑 里确认后再连接。',
  'wrong-host': '这个地址上的不是添加时的那台电脑，已停止连接。',
  outdated: '这台电脑上的 Latch 版本较旧，请先在那台电脑上更新。',
  revoked: '这台电脑已移除这台设备，请重新添加。',
}

/**
 * The HTTPS origin and invitation code of a link for adding a computer: exactly `https://<host>[:port]/link/#pair=<code>`,
 * nothing else around it. Returns undefined for anything else, so main never guesses at a pasted text.
 */
function parseComputerLink(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text.length === 0 || text.length > LINK_LIMIT || /\s/u.test(text)) return undefined
  let url
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/link/' || url.search) return undefined
  const match = /^#pair=(lpi1-[A-Z2-7]{26})$/u.exec(url.hash)
  if (!match || !INVITATION.test(match[1])) return undefined
  return { origin: url.origin, code: match[1] }
}

/** The certificates main trusts for another computer: Node's bundled roots and this system's own trust store. */
function systemCertificates() {
  return [...new Set([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')])]
}

/**
 * The TLS options of every remote request to `origin`. Product code uses the system's trust for every origin; the tests
 * replace this export (through the module object) to trust their own test certificates.
 * @param {string} _origin
 * @returns {{ ca: string[], lookup?: import('node:net').LookupFunction }}
 */
function tlsOptions(_origin) {
  return { ca: systemCertificates() }
}

/** Whether a request error is the certificate's rather than the network's. */
function certificateFailure(error) {
  const code = error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? '') : ''
  return CERTIFICATE_ERROR.test(code)
}

/**
 * One HTTPS request to `origin` + `path`, resolving once the response headers arrive (like `socketRequest`), with the
 * SHA-256 of the certificate the handshake showed. Main opens the TLS connection itself and hands it to the request only
 * after the handshake: with `pin`, a certificate other than that one ends the connection before the request (and any
 * credential in it) is written. No agent keeps connections, so no connection of one computer is reused for another.
 * @param {string} origin
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: Buffer, bodyStream?: ReadableStream<Uint8Array>, bodyLimit?: number, check?: () => void, signal?: AbortSignal, timeoutMs?: number, pin?: string }} init
 * @returns {Promise<{ request: import('node:http').ClientRequest, response: import('node:http').IncomingMessage, certificate?: string }>}
 */
async function httpsRequest(origin, { method = 'GET', path, headers = {}, body, pin, ...rest }) {
  const url = new URL(path, origin)
  const outgoing = { ...headers }
  if (body !== undefined) outgoing['content-length'] = String(body.length)
  const options = module.exports.tlsOptions(url.origin)
  /** @type {string | undefined} */
  let certificate
  // `URL.hostname` keeps an IPv6 address in brackets; TLS wants it bare, and never as a server name.
  const host = url.hostname.replace(/^\[(.*)\]$/u, '$1')
  /** @type {import('node:tls').TLSSocket | undefined} */
  let handshake
  let handed = false
  /** Why the request was destroyed before the hand-off, which the request then reports. */
  let ended
  /** @type {(options: object, done: (error: Error | null, socket?: import('node:net').Socket) => void) => undefined} */
  const connect = (_options, done) => {
    const socket = tls.connect({
      host,
      port: Number(url.port || 443),
      ...(isIP(host) ? {} : { servername: host }),
      ca: options.ca,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
      ...(options.lookup ? { lookup: options.lookup } : {}),
    })
    handshake = socket
    // A handshake that never ends is given up, also for a stream that has no response timeout.
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy(Object.assign(new Error('TLS 握手超时'), { code: 'ETIMEDOUT' })))
    socket.once('error', error => done(error))
    // Ended before the hand-off (the request's timeout or abort, or the server): the request learns it now.
    socket.once('close', () => {
      if (!handed) done(ended ?? Object.assign(new Error('Latch 服务连接中断'), { code: 'ECONNRESET' }))
    })
    socket.once('secureConnect', () => {
      socket.setTimeout(0)
      const seen = socket.getPeerCertificate()?.fingerprint256
      if (pin !== undefined && seen !== pin) {
        socket.destroy()
        done(Object.assign(new Error('证书变了'), { code: CERTIFICATE_CHANGED }))
        return
      }
      certificate = seen
      handed = true
      done(null, socket)
    })
    return undefined
  }
  const result = await exchange(
    () => {
      const req = https.request(url, { method, headers: outgoing, createConnection: /** @type {any} */ (connect) })
      // The request's timeout or the page's abort (both destroy the request) end a handshake still under way at once.
      const destroy = req.destroy.bind(req)
      req.destroy = error => {
        if (!handed) {
          ended = error
          handshake?.destroy()
        }
        return destroy(error)
      }
      req.once('close', () => {
        if (!handed) handshake?.destroy()
      })
      return req
    },
    { body, ...rest },
  )
  return { ...result, ...(certificate ? { certificate } : {}) }
}

/** The page's headers without its cookies, credentials, origin or fetch metadata, and with this Host's credential. */
function remoteRequestHeaders(headers, cookie) {
  const result = {}
  for (const [name, value] of new Headers(headers)) {
    const key = name.toLowerCase()
    if (DROPPED_REQUEST_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('x-forwarded-') || key.startsWith('sec-')) continue
    result[key] = value
  }
  if (cookie !== undefined) result.cookie = cookie
  return result
}

/** The value of the credential cookie `name` among a response's Set-Cookie headers; a cleared cookie is none. */
function credentialFromSetCookie(headers, name) {
  const raw = headers?.['set-cookie']
  for (const line of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
    const text = String(line)
    if (!text.startsWith(`${name}=`)) continue
    const value = text
      .slice(name.length + 1)
      .split(';')[0]
      .trim()
    return value || undefined
  }
  return undefined
}

/** The `host-state` frames of an event stream as they pass, from chunks that may split a frame anywhere. */
function createHostStateReader(onState) {
  let buffer = ''
  return chunk => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    // Frames end with a blank line; anything longer than a frame can be is dropped rather than kept.
    if (buffer.length > 256 * 1024) buffer = buffer.slice(-64 * 1024)
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (!/^event: host-state$/mu.test(frame)) continue
      const data = /^data: (.*)$/mu.exec(frame)?.[1]
      try {
        const value = JSON.parse(data ?? '')
        if (value && value.type === 'host-state' && ['stopping', 'sleeping', 'awake'].includes(value.state))
          onState({
            state: value.state,
            ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
            ...(Number.isFinite(value.retryAfter) && value.retryAfter > 0 ? { retryAfter: Math.min(value.retryAfter, 3600) } : {}),
          })
      } catch {
        /* Not a frame of the Host's: ignored. */
      }
    }
  }
}

/**
 * Reads the Host's public health answer (without a credential and without a pin) and returns its hostId and the
 * certificate the handshake showed, or throws a RemoteError: `wrong-host` for another Host's, `outdated` for a Host that
 * does not say.
 * @returns {Promise<{ hostId: string, certificate: string | undefined }>}
 */
async function readHealth(origin, request = httpsRequest) {
  let result
  let certificate
  try {
    const answer = await request(origin, {
      path: '/link/api/health',
      headers: { accept: 'application/json' },
      timeoutMs: HEALTH_TIMEOUT_MS,
    })
    certificate = typeof answer.certificate === 'string' && FINGERPRINT.test(answer.certificate) ? answer.certificate : undefined
    result = await bufferUpstream(answer)
  } catch (error) {
    throw certificateFailure(error)
      ? new RemoteError('cert-error', STATE_MESSAGES['cert-error'])
      : new RemoteError('offline', STATE_MESSAGES.offline)
  }
  if (result.status !== 200 || !result.json || result.json.ok !== true) throw new RemoteError('offline', STATE_MESSAGES.offline)
  const hostId = result.json.hostId
  if (hostId === undefined) throw new RemoteError('outdated', STATE_MESSAGES.outdated)
  if (typeof hostId !== 'string' || !HOST_ID.test(hostId)) throw new RemoteError('wrong-host', STATE_MESSAGES['wrong-host'])
  return { hostId, certificate }
}

/** The name of a computer as its Host gives it: without `.local`, one line, at most 80 characters (code points). */
function computerNameOf(hostName) {
  if (typeof hostName !== 'string') return undefined
  const name = [
    ...hostName
      .replace(/\.local$/u, '')
      .replace(/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, '')
      .trim(),
  ]
    .slice(0, 80)
    .join('')
    .trim()
  return name || undefined
}

/**
 * What the Host signs with its identity key for `POST /host-proof`: the certificate (Node's `fingerprint256`) it serves
 * on the connection that asked, for the asker's nonce. The same as `certificateProofText` in apps/host/src/identity.ts.
 */
function certificateProofText(hostId, nonce, certificate) {
  return `latch-cert-proof-v1
${hostId}
${nonce}
${certificate}`
}

/**
 * Whether the Host's answer to `POST /host-proof` proves `certificate` for `hostId`: its public key hashes to the hostId
 * (base32 of SHA-256, as apps/host/src/identity.ts derives it) and signs the proof text (ECDSA P-256, IEEE P1363).
 */
function verifyCertificateProof(answer, hostId, nonce, certificate) {
  if (!answer || typeof answer.publicKey !== 'string' || typeof answer.signature !== 'string') return false
  try {
    const spki = Buffer.from(answer.publicKey, 'base64url')
    if (base32(createHash('sha256').update(spki).digest()) !== hostId) return false
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    return verifySignature(
      'sha256',
      Buffer.from(certificateProofText(hostId, nonce, certificate), 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(answer.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

/** A version as the Host reports it, or undefined. */
function versionOf(value) {
  return typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/u.test(value) ? value : undefined
}

/**
 * Enrolls this Mac with another computer's Host through an invitation link, with a fresh device key that no other Host
 * has seen. The Host asks for its owner's confirmation on that computer; `onWaiting` gets the key's fingerprint to
 * compare meanwhile. Every call after the health answer is pinned to the certificate that answer showed. Resolves the
 * hostId, the certificate, the key, the device ID and the credential; nothing here is logged.
 * @param {object} options
 * @param {{ origin: string, code: string }} options.link
 * @param {string} options.name  this device's name on that Host
 * @param {typeof httpsRequest} [options.request]
 * @param {(state: { fingerprint: string, hostId: string }) => void} [options.onWaiting]
 * @param {AbortSignal} [options.signal]
 * @param {(hostId: string) => string | undefined} [options.refuse]  a refusal message for a hostId main will not add
 * @param {() => ReturnType<typeof generateDeviceKey>} [options.generateKey]
 * @param {(ms: number) => Promise<void>} [options.wait]
 */
async function enrollRemote({ link, name, request = httpsRequest, onWaiting, signal, refuse, generateKey = generateDeviceKey, wait }) {
  const pause = wait ?? (ms => new Promise(done => setTimeout(done, ms)))
  const { hostId, certificate } = await readHealth(link.origin, request)
  if (certificate === undefined) throw new RemoteError('cert-error', STATE_MESSAGES['cert-error'])
  const refused = refuse?.(hostId)
  if (refused) throw new ProxyError(409, 'computer-refused', refused)
  const call = async (method, path, value) => {
    if (signal?.aborted) throw new ProxyError(499, 'add-cancelled', '已取消添加')
    try {
      return await bufferUpstream(
        await request(link.origin, {
          method,
          path,
          headers:
            value === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
          ...(value === undefined ? {} : { body: Buffer.from(JSON.stringify(value)) }),
          timeoutMs: CONTROL_TIMEOUT_MS,
          pin: certificate,
        }),
      )
    } catch (error) {
      if (error instanceof ProxyError) throw error
      throw certificateFailure(error)
        ? new RemoteError('cert-error', STATE_MESSAGES['cert-error'])
        : new RemoteError('offline', STATE_MESSAGES.offline)
    }
  }
  const failed = result =>
    new ProxyError(
      result.status || 502,
      typeof result.json?.error === 'string' ? result.json.error : 'add-failed',
      typeof result.json?.message === 'string' ? result.json.message : '无法添加这台电脑，请重试。',
    )
  // Every enrollment has a key of its own: a key is never shared between two Hosts.
  const key = generateKey()
  const created = await call('POST', '/link/api/enrollments', { publicKey: key.publicKey, name, invitation: link.code })
  const enrollment = created.json?.enrollment
  if (created.status !== 202 || typeof enrollment?.id !== 'string' || !/^enr_[A-Za-z0-9_-]{22}$/u.test(enrollment.id)) throw failed(created)
  const cancel = () => call('DELETE', `/link/api/enrollments/${enrollment.id}`).catch(() => undefined)
  if (enrollment.fingerprint !== key.fingerprint || typeof enrollment.nonce !== 'string') {
    await cancel()
    throw new ProxyError(502, 'fingerprint-mismatch', '这台设备的密钥和那台电脑读到的不一致，已停止添加。')
  }
  onWaiting?.({ fingerprint: key.fingerprint, hostId })
  let status = enrollment.status
  const until = Math.max(Date.parse(enrollment.expiresAt ?? '') || 0, Date.now() + 120_000) + 5_000
  while (status === 'pending') {
    if (signal?.aborted) {
      await cancel()
      throw new ProxyError(499, 'add-cancelled', '已取消添加')
    }
    if (Date.now() > until) {
      await cancel()
      throw new ProxyError(408, 'add-expired', '等待确认超时，请在那台电脑上重新复制链接。')
    }
    await pause(1_000)
    const polled = await call('GET', `/link/api/enrollments/${enrollment.id}`)
    if (polled.status === 429) continue
    if (polled.status !== 200) throw failed(polled)
    status = polled.json?.enrollment?.status
  }
  if (status !== 'approved')
    throw new ProxyError(403, 'add-denied', status === 'denied' ? '那台电脑拒绝了这台设备。' : '那台电脑没有确认这台设备。')
  const completed = await call('POST', `/link/api/enrollments/${enrollment.id}/complete`, {
    signature: key.sign(enrollSigningText(hostId, enrollment.id, enrollment.nonce)),
  })
  const deviceId = completed.json?.device?.id
  const credential = credentialFromSetCookie(completed.headers, `__Host-latch_${hostId.slice(0, 8)}`)
  if (completed.status !== 200 || typeof deviceId !== 'string' || credential === undefined) throw failed(completed)
  return { hostId, certificate, key, deviceId, credential }
}

/**
 * The scheme handlers of one remote computer: its page, its API, its event streams and its preview bootstraps.
 * @param {object} options
 * @param {string} options.hostId
 * @param {string} options.origin  the Host's HTTPS origin as computers.json lists it; the encrypted record's wins
 * @param {Awaited<ReturnType<typeof import('./credentials.cjs').openCredentialStore>>} options.store  this Host's alone
 * @param {(event: { kind: string, [key: string]: unknown }) => void} [options.onStatus]  what main learned about the computer
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof httpsRequest} [options.request]
 */
function createRemoteProxy(options) {
  const { hostId, store, onStatus = () => {}, log = () => {}, now = Date.now, request = httpsRequest } = options
  const bound = store.binding?.()
  /** Where the credential goes: the encrypted record's origin, never only what computers.json says. */
  const origin = bound?.origin ?? options.origin
  /**
   * The certificate every credentialed request must see, from the encrypted record. Without one nothing is trusted on
   * first sight: the computer is `cert-changed` until its Host proves the certificate (`acceptCertificate`).
   */
  let pin = bound?.certificate
  /** A changed certificate the health answer showed for the right hostId, waiting for the person. */
  let offered
  if (!HOST_ID.test(hostId)) throw new Error('hostId 格式不正确')
  if (store.hostId !== hostId) throw new Error('设备凭据不属于这台电脑')
  const home = `h-${hostId}`
  const cookieName = `__Host-latch_${hostId.slice(0, 8)}`
  let verifiedAt = 0
  let verifying
  let renewing
  let renewAfter = 0
  let retryAt = 0
  let failures = 0
  /** Set when the Host refused this device for good; nothing more is sent with it. */
  let revoked = false

  function report(event) {
    try {
      onStatus(event)
    } catch {
      /* The state machine's trouble is not the request's. */
    }
  }

  /**
   * The Host's identity, read at most once per VERIFY_TTL_MS and again after any connection error: its hostId, and the
   * certificate, which must be the pinned one (a computer without a pin yet takes this one).
   */
  function verify({ force = false } = {}) {
    if (!force && verifiedAt !== 0 && now() - verifiedAt < VERIFY_TTL_MS) return Promise.resolve()
    verifying ??= (async () => {
      try {
        const seen = await readHealth(origin, request)
        if (seen.hostId !== hostId) throw new RemoteError('wrong-host', STATE_MESSAGES['wrong-host'])
        if (seen.certificate === undefined) throw new RemoteError('cert-error', STATE_MESSAGES['cert-error'])
        if (seen.certificate !== pin) {
          offered = seen.certificate
          throw new RemoteError('cert-changed', STATE_MESSAGES['cert-changed'])
        }
        verifiedAt = now()
      } catch (error) {
        verifiedAt = 0
        if (error instanceof RemoteError) report({ kind: error.state })
        throw error
      }
    })().finally(() => {
      verifying = undefined
    })
    return verifying
  }

  /** A request to the verified Host; a connection error ends the verification and reports the computer unreachable. */
  async function upstream(method, path, headers, body, extra = {}) {
    await verify()
    try {
      return await request(origin, { method, path, headers, body, ...extra, pin })
    } catch (error) {
      verifiedAt = 0
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
      if (code === 'body-too-large') throw error
      if (code === CERTIFICATE_CHANGED) {
        // Another certificate at the address since the last check: nothing was sent; the health answer says what it is.
        await verify({ force: true })
        report({ kind: 'offline' })
        throw new RemoteError('offline', STATE_MESSAGES.offline)
      }
      const state = certificateFailure(error) ? 'cert-error' : 'offline'
      report({ kind: state })
      throw new RemoteError(state, STATE_MESSAGES[state])
    }
  }

  function credentialCookie() {
    if (revoked) return undefined
    const current = store.current()
    return current ? `${cookieName}=${current.credential}` : undefined
  }

  async function forget(credential) {
    revoked = true
    report({ kind: 'revoked' })
    if (store.current()?.credential !== credential) return
    await store.clear()
    log('另一台电脑已移除这台设备，已删除它的凭据与密钥')
  }

  /** The Host's answer about a credential: online when it took it, revoked when it refused it for good. */
  async function judge(status, json, credential) {
    const action = authFailureAction(status, json)
    if (action === 'clear' && credential !== undefined) await forget(credential)
    else if (status !== 401 && status < 500) report({ kind: 'online' })
    return action
  }

  function renewDue() {
    return store.current() !== undefined && !revoked && now() >= retryAt && (renewAfter === 0 || now() >= renewAfter)
  }

  /** Challenge, sign, renew; the new credential arrives as a cookie, which main keeps and the page never sees. */
  function renew() {
    renewing ??= (async () => {
      const current = store.current()
      if (!current || revoked) return false
      let renewed = false
      try {
        renewed = await renewCredential(current)
      } catch (error) {
        log(`另一台电脑的设备凭据续期失败：${error instanceof Error ? error.message : '未知错误'}`)
      }
      failures = renewed ? 0 : failures + 1
      retryAt = renewed ? 0 : now() + Math.min(RENEW_RETRY_MAX_MS, RENEW_RETRY_MS * 2 ** Math.min(failures - 1, 10))
      return renewed
    })().finally(() => {
      renewing = undefined
    })
    return renewing
  }

  async function control(path, credential, value) {
    const headers = { accept: 'application/json', 'content-type': 'application/json', cookie: `${cookieName}=${credential}` }
    return bufferUpstream(await upstream('POST', path, headers, Buffer.from(JSON.stringify(value)), { timeoutMs: CONTROL_TIMEOUT_MS }))
  }

  async function renewCredential(current) {
    const challenge = await control('/link/api/credentials/challenge', current.credential, {})
    if (challenge.status !== 200 || typeof challenge.json?.nonce !== 'string') {
      await judge(challenge.status, challenge.json, current.credential)
      return false
    }
    const signature = store.sign(renewSigningText(hostId, current.deviceId, challenge.json.nonce))
    const result = await control('/link/api/credentials/renew', current.credential, { nonce: challenge.json.nonce, signature })
    const next = credentialFromSetCookie(result.headers, cookieName)
    if (result.status !== 200 || next === undefined) {
      await judge(result.status, result.json, current.credential)
      return false
    }
    try {
      await store.setCredential(next)
    } catch (error) {
      log(`另一台电脑的设备凭据已续期，但保存失败，继续使用原凭据：${error instanceof Error ? error.message : '未知错误'}`)
      return false
    }
    const due = Date.parse(result.json?.device?.renewAfter ?? '')
    renewAfter = Number.isFinite(due) ? due : now() + RENEW_INTERVAL_MS
    // The Host drops a renewed credential that stays unused for 10 minutes; present it once now.
    try {
      const used = await bufferUpstream(
        await upstream('GET', FIRST_USE_PATH, { accept: 'application/json', cookie: `${cookieName}=${next}` }, undefined, {
          timeoutMs: CONTROL_TIMEOUT_MS,
        }),
      )
      await judge(used.status, used.json, next)
    } catch {
      /* The next request presents it instead. */
    }
    return store.current() !== undefined
  }

  /** Forwards one page request with this Host's credential; renews once on renewal-required (the Host did nothing). */
  async function forward(request, target, route) {
    const api = target.pathname.startsWith('/link/api/')
    // Without a credential the page could only reach an enrollment it cannot finish here: say what to do instead.
    if (!api && !credentialCookie() && request.method === 'GET' && (target.pathname === '/link/' || target.pathname === '/link')) {
      await discardRequestBody(request)
      return new Response(htmlErrorPage(`${STATE_MESSAGES.revoked}在这台 Mac 的 设置 › 电脑 里移除后重新添加。`), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP, 'cache-control': 'no-store' },
      })
    }
    if (api && !route.public && !credentialCookie()) {
      await discardRequestBody(request)
      return errorResponse(401, revoked ? 'device-revoked' : 'unauthorized', STATE_MESSAGES.revoked)
    }
    const pluginDraft =
      (request.method === 'POST' && target.pathname === '/link/api/plugin-packages')
      || (request.method === 'PUT' && /^\/link\/api\/plugin-packages\/[A-Za-z0-9_-]{1,64}$/u.test(target.pathname))
    const fileEdit = request.method === 'PUT' && FILE_EDIT_PATH.test(target.pathname)
    const body = await readRequestBody(
      request,
      pluginDraft ? PLUGIN_DRAFT_BODY_LIMIT : fileEdit ? FILE_EDIT_BODY_LIMIT : REQUEST_BODY_LIMIT,
    )
    if (api && renewAfter !== 0 && renewDue()) await renew()
    // Static files are public: they go without a credential.
    let cookie = api ? credentialCookie() : undefined
    const send = () => upstream(request.method, target.path, remoteRequestHeaders(request.headers, cookie), body)
    let result = await send()
    if (api && result.response.statusCode === 401) {
      let failure = await bufferUpstream(result)
      let action = authFailureAction(401, failure.json)
      if (action === 'renew' && cookie !== undefined) {
        // Another request may already have renewed the credential this one was sent with.
        const latest = credentialCookie()
        const renewed = latest !== undefined && latest !== cookie ? true : renewing || now() >= retryAt ? await renew() : false
        if (renewed && credentialCookie()) {
          cookie = credentialCookie()
          result = await send()
          if (result.response.statusCode !== 401) return finish(result, request.method, route, target)
          failure = await bufferUpstream(result)
          action = authFailureAction(401, failure.json)
        }
      }
      if (cookie !== undefined) await judge(401, failure.json, cookie.slice(cookieName.length + 1))
      return bufferedResponse(failure, request.method)
    }
    return finish(result, request.method, route, target)
  }

  async function finish(result, method, route, target) {
    const status = result.response.statusCode
    if (target.pathname.startsWith('/link/api/') && status < 500 && status !== 401) report({ kind: 'online' })
    if (route.selfRevoke && status >= 200 && status < 300) {
      const current = store.current()
      if (current) await forget(current.credential)
    }
    const observe =
      target.pathname === '/link/api/events' ? createHostStateReader(state => report({ kind: 'host-state', ...state })) : undefined
    return streamedResponse(result, method, observe)
  }

  async function forwardUpload(request, target) {
    const cookie = credentialCookie()
    if (!cookie) {
      await discardRequestBody(request)
      return errorResponse(401, revoked ? 'device-revoked' : 'unauthorized', STATE_MESSAGES.revoked)
    }
    let result
    try {
      result = await upstream('POST', target.path, remoteRequestHeaders(request.headers, cookie), undefined, {
        bodyStream: request.body,
        bodyLimit: UPLOAD_BODY_LIMIT,
        timeoutMs: 60_000,
        signal: request.signal,
      })
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'body-too-large')
        throw new ProxyError(413, 'body-too-large', '请求内容过长')
      throw error
    }
    if (result.response.statusCode !== 401) return finish(result, 'POST', { kind: 'forward' }, target)
    const failure = await bufferUpstream(result)
    const action = await judge(401, failure.json, cookie.slice(cookieName.length + 1))
    if (action === 'renew' && (await renew())) return errorResponse(409, 'upload-retry', '连接凭据已更新，请重试上传。')
    return bufferedResponse(failure, 'POST')
  }

  function refused(pathname, error) {
    const message = error instanceof RemoteError ? error.message : '无法连接到这台电脑。'
    const code = error instanceof RemoteError ? (error.state === 'offline' ? 'host-unavailable' : error.state) : 'host-unavailable'
    if (pathname.startsWith('/link/api/')) return errorResponse(502, code, message)
    return new Response(htmlErrorPage(message), {
      status: 502,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP, 'cache-control': 'no-store' },
    })
  }

  /** The `latch:` scheme handler of this computer's partition: only `latch://h-<hostId>/link/…`. */
  async function handle(request) {
    if (request.headers.get('origin') === 'null') {
      await discardRequestBody(request)
      return errorResponse(403, 'untrusted-frame', '文档预览不能访问工作台接口')
    }
    const target = upstreamTarget(request.url, home)
    if (!target) {
      await discardRequestBody(request)
      return errorResponse(404, 'not-found', '页面不存在')
    }
    try {
      const route = classifyRoute(request.method, target.pathname)
      // What only this Mac's own Host does with the desktop app: credentials, enrollment, links for other devices,
      // reporting sleep and stops, updates, files and folders. Another computer's page has none of them.
      if (
        ['credentials', 'host-state', 'host-update', 'shell-files', 'folders', 'enroll', 'complete'].includes(route.kind)
        || route.pairing
      ) {
        await discardRequestBody(request)
        return errorResponse(403, 'shell-managed', REMOTE_MANAGED)
      }
      if (route.kind === 'attachment-upload') return await forwardUpload(request, target)
      return await forward(request, target, route)
    } catch (error) {
      if (error instanceof ProxyError) return errorResponse(error.status, error.code, error.message)
      if (!(error instanceof RemoteError)) log(`转发到另一台电脑的请求失败：${error instanceof Error ? error.message : '未知错误'}`)
      return refused(target.pathname, error)
    }
  }

  /** The `latch-frame:` handler of this computer's partition: its fixed preview and plugin page bootstraps. */
  async function previewFrame(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return errorResponse(404, 'not-found', '页面不存在')
    const app = isAppFrameUrl(request.url, home)
    const name = app ? undefined : previewFrameName(request.url, home)
    if (!app && name === undefined) return errorResponse(404, 'not-found', '页面不存在')
    try {
      // The Host serves a bootstrap off host.sock only to a frame; main fetches it as one, without a credential.
      const result = await upstream('GET', app ? '/link/app-frame/runtime.html' : `/link/preview-frame/${name}.html`, {
        'sec-fetch-dest': 'iframe',
      })
      const bytes = await readBody(result.response, app ? 16 * 1024 * 1024 : 32 * 1024 * 1024)
      const hash = result.response.headers['x-latch-frame-hash']
      const scripts = [...bytes.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/gu)]
      if (
        result.response.statusCode !== 200
        || typeof hash !== 'string'
        || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(hash)
        || scripts.length !== 1
        || `sha256-${createHash('sha256').update(scripts[0][1]).digest('base64')}` !== hash
      )
        return errorResponse(404, 'preview-unavailable', '文档预览器不可用')
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': app ? appFrameCsp(hash, home) : previewFrameCsp(name, hash, home),
        },
      })
    } catch {
      return errorResponse(404, 'preview-unavailable', '文档预览器不可用')
    }
  }

  /**
   * Main's own look at the computer: its identity (always read again), then its snapshot with this device's credential.
   * Resolves the state and, when online, its name, version and snapshot. Never retries a write; there is none here.
   */
  async function probe() {
    try {
      await verify({ force: true })
    } catch (error) {
      return { state: error instanceof RemoteError ? error.state : 'offline' }
    }
    if (revoked || !store.current()) return { state: 'revoked' }
    if (renewDue()) await renew()
    const cookie = credentialCookie()
    if (!cookie) return { state: 'revoked' }
    try {
      const result = await upstream('GET', '/link/api/snapshot', { accept: 'application/json', cookie }, undefined, {
        timeoutMs: CONTROL_TIMEOUT_MS,
      })
      const body = await readBody(result.response, SNAPSHOT_LIMIT)
      let json
      try {
        json = JSON.parse(body.toString('utf8'))
      } catch {
        json = undefined
      }
      const status = result.response.statusCode
      if (status === 401) {
        const action = await judge(401, json, cookie.slice(cookieName.length + 1))
        if (action === 'renew' && (await renew())) return probe()
        return { state: revoked ? 'revoked' : 'offline' }
      }
      if (status !== 200) return { state: 'offline' }
      return {
        state: 'online',
        name: computerNameOf(json?.hostName),
        version: versionOf(json?.version),
        // For main alone (computers.cjs keeps only what waits there; notifications compare it): never given to a page.
        ...(json && typeof json === 'object' ? { snapshot: json } : {}),
      }
    } catch (error) {
      return { state: error instanceof RemoteError ? error.state : 'offline' }
    }
  }

  /**
   * Revokes this device on that Host (`DELETE /devices/current`) when it can still be reached as itself. Resolves
   * whether the Host confirmed it; the caller deletes the local credential either way.
   */
  async function revokeSelf() {
    const cookie = credentialCookie()
    if (!cookie) return false
    try {
      const result = await bufferUpstream(
        await upstream('DELETE', '/link/api/devices/current', { accept: 'application/json', cookie }, undefined, {
          timeoutMs: CONTROL_TIMEOUT_MS,
        }),
      )
      if (result.status >= 200 && result.status < 300) return true
      // Already gone there: nothing is left to revoke.
      return result.status === 401 && CLEARING_CODES.has(result.json?.error)
    } catch {
      return false
    }
  }

  /** Renews when due: checks at least every 12 hours, and again once a failed attempt's wait has passed. */
  function startRenewalTimer({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer
    let stopped = false
    const tick = async () => {
      if (renewDue()) await renew()
      if (stopped) return
      const due = Math.max(renewAfter, retryAt)
      timer = setTimer(tick, Math.min(12 * 60 * 60 * 1000, Math.max(RENEW_RETRY_MS, due - now())))
      timer?.unref?.()
    }
    timer = setTimer(tick, RENEW_RETRY_MS)
    timer?.unref?.()
    return () => {
      stopped = true
      clearTimer(timer)
    }
  }

  /**
   * Pins the certificate the last check offered, after the person asked to: only when the Host at the address, reached
   * over a connection that shows exactly that certificate, signs it with the identity key whose hash is this hostId.
   * A Host without the route is refused: a real one that reports its hostId has it, so a 404 is no reason to trust.
   * @returns {Promise<{ ok: true } | { ok: false, reason: 'nothing' | 'offline' | 'refused' | 'outdated' }>}
   */
  async function acceptCertificate() {
    const candidate = offered
    const current = store.current()
    if (candidate === undefined || !current || revoked) return { ok: false, reason: 'nothing' }
    let seen
    try {
      seen = await readHealth(origin, request)
    } catch {
      return { ok: false, reason: 'offline' }
    }
    if (seen.hostId !== hostId || seen.certificate !== candidate) return { ok: false, reason: 'refused' }
    const nonce = randomBytes(24).toString('base64url')
    let answer
    try {
      answer = await bufferUpstream(
        await request(origin, {
          method: 'POST',
          path: '/link/api/host-proof',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ nonce })),
          timeoutMs: CONTROL_TIMEOUT_MS,
          pin: candidate,
        }),
      )
    } catch {
      return { ok: false, reason: 'offline' }
    }
    if (answer.status === 404) return { ok: false, reason: 'outdated' }
    if (answer.status !== 200 || !verifyCertificateProof(answer.json, hostId, nonce, candidate)) return { ok: false, reason: 'refused' }
    try {
      await store.setBinding({ origin, certificate: candidate })
    } catch {
      return { ok: false, reason: 'offline' }
    }
    pin = candidate
    if (offered === candidate) offered = undefined
    verifiedAt = now()
    report({ kind: 'connecting' })
    return { ok: true }
  }

  return {
    hostId,
    home,
    origin,
    acceptCertificate,
    handle,
    previewFrame,
    probe,
    renew,
    revokeSelf,
    startRenewalTimer,
    /** Test and diagnostics view; never contains keys or credentials. */
    state() {
      return { verified: verifiedAt !== 0, revoked, renewAfter, retryAt, pinned: pin !== undefined }
    },
  }
}

module.exports = {
  HOST_ID,
  VERIFY_TTL_MS,
  STATE_MESSAGES,
  RemoteError,
  parseComputerLink,
  systemCertificates,
  tlsOptions,
  certificateFailure,
  httpsRequest,
  remoteRequestHeaders,
  credentialFromSetCookie,
  createHostStateReader,
  readHealth,
  CERTIFICATE_CHANGED,
  certificateProofText,
  verifyCertificateProof,
  computerNameOf,
  versionOf,
  enrollRemote,
  createRemoteProxy,
}
