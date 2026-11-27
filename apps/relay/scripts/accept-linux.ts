import { constants, createHash, createHmac, randomBytes, X509Certificate } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity, connect as tlsConnect } from 'node:tls'
import { equal, holder, issuePass, routeKey, UTC_DAY } from '@latch/link-wire'
import { connectRelayTunnel, nodeCrypto, RelayClosed, RelayControl, type RelayEndpoint, type RelayTunnel } from '@latch/link-client'

export type AcceptedRelayProfile =
  | { relayId: string; url: string; spkiHash: string; registrationKey?: string | null }
  | {
      relayId: string
      url: string
      kind: 'edge'
      relayKey: string
      extraUrls?: string[]
      shard?: number
      registrationKey?: string | null
    }

export interface LinuxAcceptanceItem {
  name: string
  result: 'pass' | 'fail'
  detail: string
}

export interface LinuxAcceptanceOptions {
  ca?: string | Buffer
  address?: string
  progress?(item: LinuxAcceptanceItem): void
}

function unhex(text: string): Buffer {
  return Buffer.from(text, 'hex')
}

function secretBytes(value: string): Buffer {
  return Buffer.from(value.slice(value.indexOf('.') + 1), 'base64url')
}

function probePinnedHealthAnchor(url: URL, expectedSpkiHash: string, options: LinuxAcceptanceOptions): Promise<string | undefined> {
  return new Promise(resolve => {
    const host = url.hostname.replace(/^\[|\]$/gu, '')
    const port = Number(url.port || 443)
    const socket = tlsConnect({
      host,
      port,
      ...(options.address
        ? {
            lookup: (_name, lookupOpts, cb) => {
              const family = isIP(options.address!)
              if (typeof lookupOpts === 'object' && lookupOpts.all) cb(null, [{ address: options.address!, family }])
              else cb(null, options.address!, family)
            },
          }
        : {}),
      ...(isIP(host) ? {} : { servername: host }),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: ['http/1.1'],
      secureOptions: constants.SSL_OP_NO_TICKET,
      rejectUnauthorized: false,
    })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(undefined)
    }, 5_000)
    timer.unref()
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      try {
        const peer = socket.getPeerCertificate(true)
        socket.destroy()
        if (!peer?.raw || peer.raw.length === 0 || peer.raw.length > 16_384) {
          resolve(undefined)
          return
        }
        const cert = new X509Certificate(peer.raw)
        const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
        if (
          !equal(createHash('sha256').update(spki).digest(), unhex(expectedSpkiHash))
          || !cert.verify(cert.publicKey)
          || checkServerIdentity(host, peer) !== undefined
        ) {
          resolve(undefined)
          return
        }
        resolve(cert.toString())
      } catch {
        socket.destroy()
        resolve(undefined)
      }
    })
  })
}

async function checkHealth(url: URL, options: LinuxAcceptanceOptions, expectedSpkiHash?: string): Promise<{ ok: boolean; detail: string }> {
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const requestOnce = (ca?: string | Buffer): Promise<{ ok: boolean; status: number; detail: string; code?: string }> =>
    new Promise(resolve => {
      const req = httpsRequest(
        new URL('/healthz', url),
        {
          method: 'GET',
          agent: false,
          ...(ca ? { ca } : {}),
          ...(options.address
            ? {
                lookup: (_name, lookupOpts, cb) => {
                  const family = options.address!.includes(':') ? 6 : 4
                  if (typeof lookupOpts === 'object' && lookupOpts.all) cb(null, [{ address: options.address!, family }])
                  else cb(null, options.address!, family)
                },
              }
            : {}),
          servername: isIP(host) ? undefined : host,
          minVersion: 'TLSv1.3',
          ...{ ALPNProtocols: ['http/1.1'] },
        },
        res => {
          let body = ''
          res.on('data', (chunk: Buffer) => {
            if (body.length < 64) body += chunk.toString('utf8')
          })
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status === 200 && body === 'ok\n') {
              resolve({ ok: true, status: 200, detail: 'HTTP 200' })
            } else if (status === 200) {
              resolve({ ok: false, status: 200, detail: 'HTTP 200（响应正文不是中继健康检查）' })
            } else {
              resolve({ ok: false, status, detail: status ? `HTTP ${status}` : '连不上' })
            }
          })
        },
      )
      const timer = setTimeout(() => {
        req.destroy()
        resolve({ ok: false, status: 0, detail: '连不上' })
      }, 10_000)
      timer.unref()
      req.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve({ ok: false, status: 0, detail: '连不上', code: err.code })
      })
      req.on('close', () => clearTimeout(timer))
      req.end()
    })

  const first = await requestOnce(options.ca)
  if (first.status !== 0 || options.ca || !expectedSpkiHash) return { ok: first.ok, detail: first.detail }
  if (first.code !== 'DEPTH_ZERO_SELF_SIGNED_CERT' && first.code !== 'SELF_SIGNED_CERT_IN_CHAIN') return { ok: false, detail: '连不上' }
  const pinnedPem = await probePinnedHealthAnchor(url, expectedSpkiHash, options)
  if (!pinnedPem) return { ok: false, detail: '连不上' }
  const second = await requestOnce(pinnedPem)
  return { ok: second.ok, detail: second.detail }
}

function endpointOf(profile: AcceptedRelayProfile, options: LinuxAcceptanceOptions, overrideKey?: Uint8Array): RelayEndpoint {
  const url = new URL(profile.url)
  const relayId = unhex(profile.relayId)
  return {
    url,
    relayId,
    ...('relayKey' in profile
      ? { edge: { relayKey: overrideKey ?? unhex(profile.relayKey), shard: profile.shard ?? 0 } }
      : { spki: overrideKey ?? unhex(profile.spkiHash) }),
    profile: 'outer-pad-v2',
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.address ? { resolveAddress: async () => options.address! } : {}),
  }
}

/**
 * Verifies a deployed Linux relay from this Mac without leaking secrets or addresses in failure details:
 * 1. `healthz`: `/healthz` answers HTTP 200 `ok`.
 * 2. `wrong-credentials`: wrong node key and wrong registration token are rejected before route allocation.
 * 3. `register-and-splice`: registers a deterministic acceptance route, issues a short-lived pass, opens a client
 *    tunnel and splices bidirectional DATA payloads end to end.
 */
export async function runLinuxAcceptance(
  profile: AcceptedRelayProfile,
  options: LinuxAcceptanceOptions = {},
): Promise<LinuxAcceptanceItem[]> {
  const items: LinuxAcceptanceItem[] = []
  const record = (name: string, result: 'pass' | 'fail', detail: string) => {
    const item = { name, result, detail }
    items.push(item)
    options.progress?.(item)
  }

  const url = new URL(profile.url)
  const health = await checkHealth(url, options, 'spkiHash' in profile ? profile.spkiHash : undefined)
  record('healthz', health.ok ? 'pass' : 'fail', health.detail)
  if (!health.ok) return items

  const token = profile.registrationKey ? secretBytes(profile.registrationKey) : undefined
  let wrongKeyRejected = false
  try {
    const badKey = randomBytes(32)
    const control = await RelayControl.connect({ ...endpointOf(profile, options, badKey), registrationToken: token })
    control.close()
    await control.closed
  } catch {
    wrongKeyRejected = true
  }

  let wrongTokenRejected = token === undefined
  if (token !== undefined) {
    let control: RelayControl | undefined
    try {
      const relayId = unhex(profile.relayId)
      const day = Math.floor(Date.now() / 1000 / UTC_DAY)
      const key = await routeKey(nodeCrypto, randomBytes(32), relayId, day)
      control = await RelayControl.connect({ ...endpointOf(profile, options), registrationToken: randomBytes(32) })
      await control.register({ routeKey: key, day, alternate: false })
    } catch (error) {
      wrongTokenRejected = error instanceof RelayClosed ? error.closeCode === 4100 : true
    } finally {
      control?.close()
      await control?.closed.catch(() => {})
    }
  }
  record(
    'wrong-credentials',
    wrongKeyRejected && wrongTokenRejected ? 'pass' : 'fail',
    `错误密钥${wrongKeyRejected ? '已拒' : '未拒'}，错误令牌${wrongTokenRejected ? '已拒' : '未拒'}`,
  )

  let control: RelayControl | undefined
  try {
    const relayId = unhex(profile.relayId)
    const nowSec = Math.floor(Date.now() / 1000)
    const day = Math.floor(nowSec / UTC_DAY)
    const seedBase = token ?? relayId
    const routeSeed = createHmac('sha256', seedBase).update(`latch-linux-accept-v1:${day}`).digest()
    const rKey = await routeKey(nodeCrypto, routeSeed, relayId, day)
    const rPub = await nodeCrypto.publicKey(rKey)
    const device = await holder(nodeCrypto, routeSeed, relayId, Buffer.from('accept'), day)
    const pass = await issuePass(nodeCrypto, rKey, {
      pairing: false,
      relayId,
      day,
      notBefore: Math.max(day * UTC_DAY, nowSec - 60),
      notAfter: Math.min((day + 1) * UTC_DAY, nowSec + 300),
      routePub: rPub,
      holderPub: await nodeCrypto.publicKey(device.seed),
      tag: device.tag,
    })

    const ep = endpointOf(profile, options)
    control = await RelayControl.connect({ ...ep, registrationToken: token })
    await control.register({ routeKey: rKey, day, alternate: false })

    const pingPayload = randomBytes(64)
    const pongPayload = randomBytes(64)
    const pendingAccept = control.accept()
    let serverStream: RelayTunnel | undefined
    const serverSide = (async () => {
      const setup = await Promise.race([
        pendingAccept,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('accept timeout')), 10_000)
          timer.unref()
        }),
      ])
      serverStream = setup.stream
      setup.finishSetup()
      const received = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let len = 0
        const timer = setTimeout(() => reject(new Error('timeout')), 8_000)
        setup.stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          len += chunk.length
          if (len >= pingPayload.length) {
            clearTimeout(timer)
            resolve(Buffer.concat(chunks, len))
          }
        })
        setup.stream.once('error', err => {
          clearTimeout(timer)
          reject(err)
        })
      })
      if (!received.subarray(0, pingPayload.length).equals(pingPayload)) throw new Error('payload mismatch')
      await new Promise<void>((resolve, reject) => setup.stream.write(pongPayload, err => (err ? reject(err) : resolve())))
    })()
    // Prevent an unhandled rejection if `connectRelayTunnel` fails before `serverSide` is awaited.
    serverSide.catch(() => {})

    let clientStream: RelayTunnel | undefined
    try {
      clientStream = await connectRelayTunnel({ ...ep, pass, holderKey: device.seed })
      await new Promise<void>((resolve, reject) => clientStream!.write(pingPayload, err => (err ? reject(err) : resolve())))
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let len = 0
        const timer = setTimeout(() => reject(new Error('timeout')), 8_000)
        clientStream!.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          len += chunk.length
          if (len >= pongPayload.length) {
            clearTimeout(timer)
            resolve(Buffer.concat(chunks, len))
          }
        })
        clientStream!.once('error', err => {
          clearTimeout(timer)
          reject(err)
        })
      })
      await serverSide
      record(
        'register-and-splice',
        echoed.subarray(0, pongPayload.length).equals(pongPayload) ? 'pass' : 'fail',
        '登记与双向端到端字节拼接正常',
      )
    } finally {
      clientStream?.destroy()
      serverStream?.destroy()
      await serverSide.catch(() => {})
    }
  } catch (error) {
    record('register-and-splice', 'fail', error instanceof RelayClosed ? `连接关闭（${error.closeCode}）` : '登记或双向拼接失败')
  } finally {
    await control?.depart(1).catch(() => {})
    control?.close()
    await control?.closed.catch(() => {})
  }

  return items
}
